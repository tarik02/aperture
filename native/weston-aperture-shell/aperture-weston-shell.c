#include <linux/input-event-codes.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <time.h>
#include <unistd.h>

#include <libweston/desktop.h>
#include <libweston/backend-pipewire.h>
#include <libweston/libweston.h>
#include <libweston/shell-utils.h>
#include <wayland-server-core.h>
#include <wayland-server-protocol.h>
#include <weston/weston.h>

#include "cursor-shape-v1-server-protocol.h"
#include "fractional-scale-v1-server-protocol.h"
#include "text-input-unstable-v3-server-protocol.h"
#include "viewporter-server-protocol.h"

struct xkb_keymap;

void weston_seat_init(struct weston_seat *seat, struct weston_compositor *ec,
		      const char *seat_name);
int weston_seat_init_pointer(struct weston_seat *seat);
int weston_seat_init_keyboard(struct weston_seat *seat, struct xkb_keymap *keymap);
void weston_seat_repick(struct weston_seat *seat);
void weston_seat_release_pointer(struct weston_seat *seat);
void weston_seat_release_keyboard(struct weston_seat *seat);
void weston_seat_release(struct weston_seat *seat);

void notify_motion_absolute(struct weston_seat *seat, const struct timespec *time,
			    struct weston_coord_global pos);
void notify_button(struct weston_seat *seat, const struct timespec *time,
		   int32_t button, enum wl_pointer_button_state state);
void notify_axis(struct weston_seat *seat, const struct timespec *time,
		 struct weston_pointer_axis_event *event);
void notify_axis_source(struct weston_seat *seat, uint32_t source);
void notify_pointer_frame(struct weston_seat *seat);
void notify_key(struct weston_seat *seat, const struct timespec *time, uint32_t key,
		enum wl_keyboard_key_state state, enum weston_key_state_update update_state);

enum {
	aperture_max_text_bytes = 4096,
	aperture_control_buffer_size = aperture_max_text_bytes * 2 + 7,
};

struct aperture_shell {
	struct weston_compositor *compositor;
	struct weston_desktop *desktop;
	struct weston_layer background_layer;
	struct weston_layer normal_layer;
	struct weston_seat input_seat;
	struct weston_curtain *background;
	struct wl_list surfaces;
	struct wl_list outputs;
	struct wl_list control_clients;
	struct wl_list fractional_scales;
	struct wl_list text_inputs;
	struct wl_event_source *control_source;
	struct wl_listener destroy_listener;
	struct wl_listener text_input_focus_listener;
	struct wl_global *cursor_shape_global;
	struct wl_global *fractional_scale_global;
	struct wl_global *text_input_global;
	struct wl_global *viewporter_global;
	struct aperture_text_input *active_text_input;
	char *control_socket_path;
	char *pending_surface_nonce;
	int control_fd;
	uint32_t width;
	uint32_t height;
	uint32_t scale_numerator;
	uint64_t next_surface_id;
	bool input_seat_initialized;
	bool input_pointer_initialized;
	bool input_keyboard_initialized;
	bool pointer_frame_pending;
};

struct aperture_shell_surface {
	struct wl_list link;
	struct weston_desktop_surface *desktop_surface;
	struct weston_view *view;
	struct weston_transform fit_transform;
	struct aperture_shell_surface *parent;
	struct aperture_output *capture_output;
	char *binding_nonce;
	uint64_t id;
	uint32_t width;
	uint32_t height;
	uint32_t scale_numerator;
	bool fit_transform_added;
};

struct aperture_output {
	struct wl_list link;
	struct weston_output *output;
	struct weston_curtain *background;
	char *capture_id;
	char *name;
	uint32_t width;
	uint32_t height;
};

struct aperture_fractional_scale {
	struct wl_list link;
	struct aperture_shell *shell;
	struct weston_surface *surface;
	struct wl_resource *resource;
	struct wl_listener surface_destroy_listener;
};

struct aperture_viewport {
	struct weston_surface *surface;
	struct wl_resource *resource;
	struct wl_listener surface_destroy_listener;
};

struct aperture_control_client {
	struct wl_list link;
	struct aperture_shell *shell;
	struct wl_event_source *source;
	int fd;
	char buffer[aperture_control_buffer_size];
	size_t length;
};

struct aperture_text_input {
	struct wl_list link;
	struct aperture_shell *shell;
	struct wl_resource *resource;
	struct weston_surface *entered_surface;
	uint32_t commit_count;
	bool enabled;
	bool pending_enabled_valid;
	bool pending_enabled;
};

static const uint32_t aperture_min_dimension = 1;
static const uint32_t aperture_min_configure_width = 500;
static const uint32_t aperture_max_dimension = 16384;
static const uint32_t aperture_scale_denominator = 120;
static const uint32_t aperture_min_scale_numerator = 30;
static const uint32_t aperture_max_scale_numerator = 480;
static const uint32_t aperture_media_canvas_bucket = 64;

static int
create_background(struct aperture_shell *shell);

static void
bind_surface_tree(struct aperture_shell *shell, struct aperture_shell_surface *root,
		  struct aperture_output *capture, uint32_t width, uint32_t height,
		  uint32_t scale_numerator);

static void
unbind_surface_tree(struct aperture_shell *shell, struct aperture_shell_surface *root);

static struct weston_output *
default_output(struct aperture_shell *shell)
{
	struct weston_output *output;

	wl_list_for_each(output, &shell->compositor->output_list, link) {
		if (output->enabled)
			return output;
	}

	return NULL;
}

static struct aperture_shell_surface *
find_shell_surface(struct aperture_shell *shell, uint64_t id)
{
	struct aperture_shell_surface *surface;

	wl_list_for_each(surface, &shell->surfaces, link) {
		if (surface->id == id)
			return surface;
	}

	return NULL;
}

static struct aperture_shell_surface *
find_exact_shell_surface(struct aperture_shell *shell,
			 struct weston_surface *weston_surface)
{
	struct aperture_shell_surface *surface;

	wl_list_for_each(surface, &shell->surfaces, link) {
		if (weston_desktop_surface_get_surface(surface->desktop_surface) == weston_surface)
			return surface;
	}

	return NULL;
}

static struct aperture_shell_surface *
find_shell_surface_for_weston_surface(struct aperture_shell *shell,
				      struct weston_surface *weston_surface)
{
	struct weston_surface *main_surface = weston_surface_get_main_surface(weston_surface);

	while (main_surface) {
		struct aperture_shell_surface *surface =
			find_exact_shell_surface(shell, main_surface);
		struct weston_desktop_surface *desktop_surface;
		struct weston_desktop_surface *parent;

		if (surface)
			return surface;
		if (!weston_surface_is_desktop_surface(main_surface))
			return NULL;
		desktop_surface = weston_surface_get_desktop_surface(main_surface);
		parent = weston_desktop_surface_get_parent(desktop_surface);
		main_surface = parent ? weston_desktop_surface_get_surface(parent) : NULL;
	}

	return NULL;
}

static struct aperture_shell_surface *
root_shell_surface(struct aperture_shell *shell, struct aperture_shell_surface *surface)
{
	while (surface && surface->parent)
		surface = surface->parent;

	return surface;
}

static struct aperture_output *
find_capture_output(struct aperture_shell *shell, const char *capture_id)
{
	struct aperture_output *output;

	wl_list_for_each(output, &shell->outputs, link) {
		if (strcmp(output->capture_id, capture_id) == 0)
			return output;
	}

	return NULL;
}

static bool
valid_control_id(const char *value)
{
	const unsigned char *cursor = (const unsigned char *)value;

	if (!cursor[0] || strlen(value) > 128)
		return false;
	for (; *cursor; cursor++) {
		if ((*cursor >= 'a' && *cursor <= 'z') ||
		    (*cursor >= 'A' && *cursor <= 'Z') ||
		    (*cursor >= '0' && *cursor <= '9') || *cursor == '-' || *cursor == '_')
			continue;
		return false;
	}
	return true;
}

static uint32_t
parse_positive_env(const char *name, uint32_t fallback)
{
	const char *raw = getenv(name);
	char *end = NULL;
	unsigned long value;

	if (!raw || !raw[0])
		return fallback;

	errno = 0;
	value = strtoul(raw, &end, 10);
	if (errno || !end || *end || value == 0 || value > UINT32_MAX)
		return fallback;

	return (uint32_t)value;
}

static uint32_t
scaled_dimension(uint32_t value, uint32_t scale_numerator)
{
	return (uint32_t)(((uint64_t)value * scale_numerator +
			   aperture_scale_denominator / 2) /
			  aperture_scale_denominator);
}

static void
send_fractional_scale(struct aperture_fractional_scale *scale)
{
	struct aperture_shell_surface *surface =
		find_shell_surface_for_weston_surface(scale->shell, scale->surface);
	uint32_t scale_numerator = scale->shell->scale_numerator;

	if (surface && surface->scale_numerator)
		scale_numerator = surface->scale_numerator;
	wp_fractional_scale_v1_send_preferred_scale(scale->resource, scale_numerator);
}

static void
send_fractional_scale_surface(struct aperture_shell *shell,
			      struct aperture_shell_surface *surface)
{
	struct aperture_fractional_scale *scale;
	struct aperture_shell_surface *root = root_shell_surface(shell, surface);

	wl_list_for_each(scale, &shell->fractional_scales, link) {
		struct aperture_shell_surface *owner =
			find_shell_surface_for_weston_surface(shell, scale->surface);

		if (owner && root_shell_surface(shell, owner) == root)
			send_fractional_scale(scale);
	}
}

static void
unset_viewport_source(struct weston_buffer_viewport *viewport)
{
	viewport->buffer.src_x = wl_fixed_from_int(0);
	viewport->buffer.src_y = wl_fixed_from_int(0);
	viewport->buffer.src_width = wl_fixed_from_int(-1);
	viewport->buffer.src_height = wl_fixed_from_int(-1);
}

static void
unset_viewport_destination(struct weston_buffer_viewport *viewport)
{
	viewport->surface.width = -1;
	viewport->surface.height = -1;
}

static int
set_nonblock_cloexec(int fd)
{
	int flags = fcntl(fd, F_GETFL);

	if (flags < 0)
		return -1;
	if (fcntl(fd, F_SETFL, flags | O_NONBLOCK) < 0)
		return -1;

	flags = fcntl(fd, F_GETFD);
	if (flags < 0)
		return -1;
	if (fcntl(fd, F_SETFD, flags | FD_CLOEXEC) < 0)
		return -1;

	return 0;
}

static struct weston_seat *
first_seat(struct aperture_shell *shell)
{
	struct weston_seat *seat;

	wl_list_for_each(seat, &shell->compositor->seat_list, link)
		return seat;

	return NULL;
}

static void
activate_surface_for_seat(struct aperture_shell_surface *surface, struct weston_seat *seat,
			  uint32_t flags)
{
	if (!seat || !surface || !surface->view)
		return;

	weston_desktop_surface_set_activated(surface->desktop_surface, true);
	weston_view_activate_input(surface->view, seat, flags);
}

static void
activate_surface(struct aperture_shell *shell, struct aperture_shell_surface *surface,
		 uint32_t flags)
{
	activate_surface_for_seat(surface, first_seat(shell), flags);
}

static void
layout_surface(struct aperture_shell *shell, struct aperture_shell_surface *surface,
	       uint32_t width, uint32_t height)
{
	struct aperture_shell_surface *root;
	struct weston_output *output;
	struct weston_geometry geometry;
	struct weston_size min_size;
	uint32_t configure_width = width;
	uint32_t configure_height = height;
	float scale;
	struct weston_coord_global origin = {
		.c = weston_coord(0, 0),
	};

	if (!surface || !surface->capture_output || !surface->view)
		return;
	output = surface->capture_output->output;
	root = root_shell_surface(shell, surface);
	if (root != surface) {
		weston_view_set_output(surface->view, output);
		weston_view_schedule_repaint(surface->view);
		return;
	}
	if (surface->width)
		width = surface->width;
	if (surface->height)
		height = surface->height;

	geometry = weston_desktop_surface_get_geometry(surface->desktop_surface);
	min_size = weston_desktop_surface_get_min_size(surface->desktop_surface);
	if (configure_width < aperture_min_configure_width)
		configure_width = aperture_min_configure_width;
	if (min_size.width > 0 && (uint32_t)min_size.width > configure_width)
		configure_width = (uint32_t)min_size.width;
	if (min_size.height > 0 && (uint32_t)min_size.height > configure_height)
		configure_height = (uint32_t)min_size.height;
	weston_desktop_surface_set_fullscreen(surface->desktop_surface, true);
	weston_desktop_surface_set_maximized(surface->desktop_surface, false);
	weston_desktop_surface_set_resizing(surface->desktop_surface, true);
	weston_desktop_surface_set_size(surface->desktop_surface, (int32_t)configure_width,
					(int32_t)configure_height);
	weston_desktop_surface_set_orientation(surface->desktop_surface,
					       WESTON_TOP_LEVEL_TILED_ORIENTATION_NONE);
	weston_desktop_surface_set_resizing(surface->desktop_surface, false);
	weston_desktop_surface_set_activated(surface->desktop_surface, true);

	scale = (float)surface->scale_numerator / (float)aperture_scale_denominator;
	weston_matrix_init(&surface->fit_transform.matrix);
	weston_matrix_scale(&surface->fit_transform.matrix, scale, scale, 1.0f);
	if (!surface->fit_transform_added) {
		weston_view_add_transform(surface->view,
					  &surface->view->geometry.transformation_list,
					  &surface->fit_transform);
		surface->fit_transform_added = true;
	} else {
		weston_view_geometry_dirty(surface->view);
	}

	weston_view_set_output(surface->view, output);
	weston_view_set_mask_infinite(surface->view);
	origin.c = output->pos.c;
	weston_view_set_position_with_offset(surface->view, origin,
					     weston_coord_surface_invert(
						     weston_coord_surface(geometry.x, geometry.y,
									   surface->view->surface)));
	weston_view_move_to_layer(surface->view, &shell->normal_layer.view_list);
	weston_view_schedule_repaint(surface->view);
}

static void
now(struct timespec *time)
{
	clock_gettime(CLOCK_MONOTONIC, time);
}

static void
viewport_to_global(struct aperture_shell_surface *surface, double x, double y,
		   struct weston_coord_global *pos)
{
	struct weston_output *output = surface->capture_output->output;
	float scale = (float)surface->scale_numerator /
		      (float)aperture_scale_denominator;

	pos->c = weston_coord(output->pos.c.x + x * scale,
			      output->pos.c.y + y * scale);
}

static const char *
inject_pointer_motion(struct aperture_shell *shell, struct aperture_shell_surface *surface,
		      double x, double y)
{
	struct weston_coord_global pos;
	struct timespec time;

	if (!surface || !surface->capture_output)
		return "surface is unavailable";
	if (x < 0.0 || y < 0.0 || x > surface->width || y > surface->height)
		return "invalid motion coordinates";

	viewport_to_global(surface, x, y, &pos);
	now(&time);
	notify_motion_absolute(&shell->input_seat, &time, pos);
	weston_seat_repick(&shell->input_seat);
	shell->pointer_frame_pending = true;
	return NULL;
}

static const char *
inject_button(struct aperture_shell *shell, struct aperture_shell_surface *surface,
	      uint32_t button, bool press)
{
	struct weston_pointer *pointer = weston_seat_get_pointer(&shell->input_seat);
	struct weston_pointer_button_event event;
	struct timespec time;
	enum wl_pointer_button_state state =
		press ? WL_POINTER_BUTTON_STATE_PRESSED : WL_POINTER_BUTTON_STATE_RELEASED;

	if (!button)
		return "invalid button";
	if (!surface || !surface->capture_output)
		return "surface is unavailable";
	if (!pointer || !pointer->grab || !pointer->grab->interface)
		return "pointer is not ready";
	if (!press && pointer->button_count == 0)
		return NULL;

	now(&time);
	weston_seat_repick(&shell->input_seat);
	if (press) {
		activate_surface_for_seat(surface, &shell->input_seat,
					  WESTON_ACTIVATE_FLAG_CLICKED);
		if (pointer->button_count == 0) {
			pointer->grab_button = button;
			pointer->grab_time = time;
			pointer->grab_pos = pointer->pos;
		}
		pointer->button_count++;
	} else {
		pointer->button_count--;
	}
	weston_pointer_button_event_init(&event, &time, &shell->input_seat, button, state);
	pointer->grab->interface->button(pointer->grab, &event);
	if (pointer->button_count == 1)
		pointer->grab_serial = wl_display_get_serial(shell->compositor->wl_display);
	shell->pointer_frame_pending = true;
	return NULL;
}

static const char *
inject_axis(struct aperture_shell *shell, struct aperture_shell_surface *surface,
	    double dx, double dy)
{
	struct timespec time;

	if (!surface || !surface->capture_output)
		return "surface is unavailable";
	now(&time);
	notify_axis_source(&shell->input_seat, WL_POINTER_AXIS_SOURCE_WHEEL);
	if (dx != 0.0) {
		struct weston_pointer_axis_event event = {
			.axis = WL_POINTER_AXIS_HORIZONTAL_SCROLL,
			.value = dx,
		};
		notify_axis(&shell->input_seat, &time, &event);
		shell->pointer_frame_pending = true;
	}
	if (dy != 0.0) {
		struct weston_pointer_axis_event event = {
			.axis = WL_POINTER_AXIS_VERTICAL_SCROLL,
			.value = dy,
		};
		notify_axis(&shell->input_seat, &time, &event);
		shell->pointer_frame_pending = true;
	}
	return NULL;
}

static const char *
inject_key(struct aperture_shell *shell, struct aperture_shell_surface *surface,
	   uint32_t key, bool press)
{
	struct timespec time;

	if (!key)
		return "invalid key";
	if (!surface || !surface->capture_output)
		return "surface is unavailable";

	activate_surface_for_seat(surface, &shell->input_seat, WESTON_ACTIVATE_FLAG_NONE);
	now(&time);
	notify_key(&shell->input_seat, &time, key,
		   press ? WL_KEYBOARD_KEY_STATE_PRESSED : WL_KEYBOARD_KEY_STATE_RELEASED,
		   STATE_UPDATE_AUTOMATIC);
	return NULL;
}

static const char *
inject_text(struct aperture_shell *shell, struct aperture_shell_surface *surface,
	    const char *encoded)
{
	struct aperture_text_input *input;
	struct weston_keyboard *keyboard;
	size_t encoded_length = strlen(encoded);
	size_t text_length;
	char text[aperture_max_text_bytes + 1];
	size_t i;

	if (!surface || !surface->capture_output)
		return "surface is unavailable";
	activate_surface_for_seat(surface, &shell->input_seat, WESTON_ACTIVATE_FLAG_NONE);
	input = shell->active_text_input;
	keyboard = weston_seat_get_keyboard(&shell->input_seat);
	if (!input || !input->enabled || !input->entered_surface || !keyboard ||
	    keyboard->focus != input->entered_surface)
		return NULL;
	if (!encoded_length || encoded_length % 2 != 0 ||
	    encoded_length > aperture_max_text_bytes * 2)
		return "invalid text";

	text_length = encoded_length / 2;
	for (i = 0; i < text_length; i++) {
		int high;
		int low;
		char high_char = encoded[i * 2];
		char low_char = encoded[i * 2 + 1];

		if (high_char >= '0' && high_char <= '9')
			high = high_char - '0';
		else if (high_char >= 'a' && high_char <= 'f')
			high = high_char - 'a' + 10;
		else
			return "invalid text";

		if (low_char >= '0' && low_char <= '9')
			low = low_char - '0';
		else if (low_char >= 'a' && low_char <= 'f')
			low = low_char - 'a' + 10;
		else
			return "invalid text";

		text[i] = (char)((high << 4) | low);
		if (!text[i])
			return "invalid text";
	}
	text[text_length] = '\0';

	zwp_text_input_v3_send_commit_string(input->resource, text);
	zwp_text_input_v3_send_done(input->resource, input->commit_count);
	return NULL;
}

static void
destroy_text_input_resource(struct wl_resource *resource)
{
	struct aperture_text_input *input = wl_resource_get_user_data(resource);

	if (input->shell->active_text_input == input)
		input->shell->active_text_input = NULL;
	wl_list_remove(&input->link);
	free(input);
}

static void
text_input_destroy(struct wl_client *client, struct wl_resource *resource)
{
	wl_resource_destroy(resource);
}

static void
text_input_enable(struct wl_client *client, struct wl_resource *resource)
{
	struct aperture_text_input *input = wl_resource_get_user_data(resource);

	if (!input->entered_surface)
		return;
	input->pending_enabled_valid = true;
	input->pending_enabled = true;
}

static void
text_input_disable(struct wl_client *client, struct wl_resource *resource)
{
	struct aperture_text_input *input = wl_resource_get_user_data(resource);

	if (!input->entered_surface)
		return;
	input->pending_enabled_valid = true;
	input->pending_enabled = false;
}

static void
text_input_set_surrounding_text(struct wl_client *client, struct wl_resource *resource,
				const char *text, int32_t cursor, int32_t anchor)
{
}

static void
text_input_set_text_change_cause(struct wl_client *client, struct wl_resource *resource,
				 uint32_t cause)
{
}

static void
text_input_set_content_type(struct wl_client *client, struct wl_resource *resource,
			    uint32_t hint, uint32_t purpose)
{
}

static void
text_input_set_cursor_rectangle(struct wl_client *client, struct wl_resource *resource,
				int32_t x, int32_t y, int32_t width, int32_t height)
{
}

static void
text_input_commit(struct wl_client *client, struct wl_resource *resource)
{
	struct aperture_text_input *input = wl_resource_get_user_data(resource);

	input->commit_count++;
	if (!input->entered_surface || !input->pending_enabled_valid)
		return;

	if (!input->pending_enabled) {
		input->enabled = false;
		if (input->shell->active_text_input == input)
			input->shell->active_text_input = NULL;
	} else if (!input->shell->active_text_input ||
		   input->shell->active_text_input == input) {
		input->enabled = true;
		input->shell->active_text_input = input;
	}
	input->pending_enabled_valid = false;
}

static const struct zwp_text_input_v3_interface text_input_interface = {
	.destroy = text_input_destroy,
	.enable = text_input_enable,
	.disable = text_input_disable,
	.set_surrounding_text = text_input_set_surrounding_text,
	.set_text_change_cause = text_input_set_text_change_cause,
	.set_content_type = text_input_set_content_type,
	.set_cursor_rectangle = text_input_set_cursor_rectangle,
	.commit = text_input_commit,
};

static void
text_input_manager_destroy(struct wl_client *client, struct wl_resource *resource)
{
	wl_resource_destroy(resource);
}

static void
text_input_manager_get_text_input(struct wl_client *client, struct wl_resource *resource,
				  uint32_t id, struct wl_resource *seat_resource)
{
	struct aperture_shell *shell = wl_resource_get_user_data(resource);
	struct aperture_text_input *input;
	struct weston_keyboard *keyboard;

	if (wl_resource_get_user_data(seat_resource) != &shell->input_seat) {
		wl_resource_post_error(resource, 0, "unsupported seat");
		return;
	}

	input = calloc(1, sizeof *input);
	if (!input) {
		wl_client_post_no_memory(client);
		return;
	}
	input->resource = wl_resource_create(client, &zwp_text_input_v3_interface,
					     wl_resource_get_version(resource), id);
	if (!input->resource) {
		free(input);
		wl_client_post_no_memory(client);
		return;
	}

	input->shell = shell;
	wl_list_insert(&shell->text_inputs, &input->link);
	wl_resource_set_implementation(input->resource, &text_input_interface, input,
				       destroy_text_input_resource);

	keyboard = weston_seat_get_keyboard(&shell->input_seat);
	if (keyboard && keyboard->focus && keyboard->focus->resource &&
	    wl_resource_get_client(keyboard->focus->resource) == client) {
		input->entered_surface = keyboard->focus;
		zwp_text_input_v3_send_enter(input->resource, keyboard->focus->resource);
	}
}

static const struct zwp_text_input_manager_v3_interface text_input_manager_interface = {
	.destroy = text_input_manager_destroy,
	.get_text_input = text_input_manager_get_text_input,
};

static void
handle_text_input_focus(struct wl_listener *listener, void *data)
{
	struct aperture_shell *shell =
		wl_container_of(listener, shell, text_input_focus_listener);
	struct weston_keyboard *keyboard = weston_seat_get_keyboard(&shell->input_seat);
	struct weston_surface *focus = keyboard ? keyboard->focus : NULL;
	struct aperture_text_input *input;

	wl_list_for_each(input, &shell->text_inputs, link) {
		if (input->entered_surface == focus)
			continue;
		if (input->entered_surface)
			zwp_text_input_v3_send_leave(input->resource,
						     input->entered_surface->resource);
		if (shell->active_text_input == input)
			shell->active_text_input = NULL;
		input->entered_surface = NULL;
		input->enabled = false;
		input->pending_enabled_valid = false;

		if (focus && focus->resource &&
		    wl_resource_get_client(input->resource) ==
			    wl_resource_get_client(focus->resource)) {
			input->entered_surface = focus;
			zwp_text_input_v3_send_enter(input->resource, focus->resource);
		}
	}
}

static void
bind_text_input_manager(struct wl_client *client, void *data, uint32_t version,
			uint32_t id)
{
	struct wl_resource *resource;

	resource = wl_resource_create(client, &zwp_text_input_manager_v3_interface, version, id);
	if (!resource) {
		wl_client_post_no_memory(client);
		return;
	}
	wl_resource_set_implementation(resource, &text_input_manager_interface, data, NULL);
}

static int
create_text_input_manager(struct aperture_shell *shell)
{
	shell->text_input_global = wl_global_create(
		shell->compositor->wl_display, &zwp_text_input_manager_v3_interface, 1, shell,
		bind_text_input_manager);
	return shell->text_input_global ? 0 : -1;
}

static void
flush_pointer_frame(struct aperture_shell *shell)
{
	if (!shell->pointer_frame_pending)
		return;

	notify_pointer_frame(&shell->input_seat);
	shell->pointer_frame_pending = false;
}

static void
destroy_fractional_scale_resource(struct wl_resource *resource)
{
	struct aperture_fractional_scale *scale = wl_resource_get_user_data(resource);

	wl_list_remove(&scale->link);
	wl_list_remove(&scale->surface_destroy_listener.link);
	free(scale);
}

static void
destroy_fractional_scale_for_surface(struct wl_listener *listener, void *data)
{
	struct aperture_fractional_scale *scale =
		wl_container_of(listener, scale, surface_destroy_listener);

	wl_resource_destroy(scale->resource);
}

static void
fractional_scale_destroy(struct wl_client *client, struct wl_resource *resource)
{
	wl_resource_destroy(resource);
}

static const struct wp_fractional_scale_v1_interface fractional_scale_interface = {
	fractional_scale_destroy,
};

static void
fractional_scale_manager_destroy(struct wl_client *client, struct wl_resource *resource)
{
	wl_resource_destroy(resource);
}

static void
fractional_scale_manager_get_fractional_scale(struct wl_client *client,
					      struct wl_resource *resource, uint32_t id,
					      struct wl_resource *surface_resource)
{
	struct aperture_shell *shell = wl_resource_get_user_data(resource);
	struct weston_surface *surface = wl_resource_get_user_data(surface_resource);
	struct aperture_fractional_scale *scale;
	int version = wl_resource_get_version(resource);

	wl_list_for_each(scale, &shell->fractional_scales, link) {
		if (scale->surface == surface) {
			wl_resource_post_error(
				resource,
				WP_FRACTIONAL_SCALE_MANAGER_V1_ERROR_FRACTIONAL_SCALE_EXISTS,
				"fractional scale object already exists for this surface");
			return;
		}
	}

	scale = calloc(1, sizeof *scale);
	if (!scale) {
		wl_client_post_no_memory(client);
		return;
	}

	scale->resource =
		wl_resource_create(client, &wp_fractional_scale_v1_interface, version, id);
	if (!scale->resource) {
		free(scale);
		wl_client_post_no_memory(client);
		return;
	}

	scale->shell = shell;
	scale->surface = surface;
	scale->surface_destroy_listener.notify = destroy_fractional_scale_for_surface;
	wl_signal_add(&surface->destroy_signal, &scale->surface_destroy_listener);
	wl_list_insert(&shell->fractional_scales, &scale->link);
	wl_resource_set_implementation(scale->resource, &fractional_scale_interface, scale,
				       destroy_fractional_scale_resource);
	send_fractional_scale(scale);
}

static const struct wp_fractional_scale_manager_v1_interface
	fractional_scale_manager_interface = {
		fractional_scale_manager_destroy,
		fractional_scale_manager_get_fractional_scale,
	};

static void
cursor_shape_device_destroy(struct wl_client *client, struct wl_resource *resource)
{
	wl_resource_destroy(resource);
}

static void
cursor_shape_device_set_shape(struct wl_client *client, struct wl_resource *resource,
			      uint32_t serial, uint32_t shape)
{
	uint32_t max_shape = wl_resource_get_version(resource) >= 2 ?
				     WP_CURSOR_SHAPE_DEVICE_V1_SHAPE_ALL_RESIZE :
				     WP_CURSOR_SHAPE_DEVICE_V1_SHAPE_ZOOM_OUT;

	if (shape < WP_CURSOR_SHAPE_DEVICE_V1_SHAPE_DEFAULT || shape > max_shape) {
		wl_resource_post_error(resource,
				       WP_CURSOR_SHAPE_DEVICE_V1_ERROR_INVALID_SHAPE,
				       "invalid cursor shape");
		return;
	}
}

static const struct wp_cursor_shape_device_v1_interface cursor_shape_device_interface = {
	cursor_shape_device_destroy,
	cursor_shape_device_set_shape,
};

static void
cursor_shape_manager_destroy(struct wl_client *client, struct wl_resource *resource)
{
	wl_resource_destroy(resource);
}

static void
cursor_shape_manager_get_pointer(struct wl_client *client, struct wl_resource *resource,
				 uint32_t id, struct wl_resource *pointer_resource)
{
	struct wl_resource *device_resource;

	device_resource = wl_resource_create(client, &wp_cursor_shape_device_v1_interface,
					    wl_resource_get_version(resource), id);
	if (!device_resource) {
		wl_client_post_no_memory(client);
		return;
	}
	wl_resource_set_implementation(device_resource, &cursor_shape_device_interface,
				       NULL, NULL);
}

static void
cursor_shape_manager_get_tablet_tool_v2(struct wl_client *client,
					struct wl_resource *resource, uint32_t id,
					struct wl_resource *tablet_tool_resource)
{
	struct wl_resource *device_resource;

	device_resource = wl_resource_create(client, &wp_cursor_shape_device_v1_interface,
					    wl_resource_get_version(resource), id);
	if (!device_resource) {
		wl_client_post_no_memory(client);
		return;
	}
	wl_resource_set_implementation(device_resource, &cursor_shape_device_interface,
				       NULL, NULL);
}

static const struct wp_cursor_shape_manager_v1_interface cursor_shape_manager_interface = {
	cursor_shape_manager_destroy,
	cursor_shape_manager_get_pointer,
	cursor_shape_manager_get_tablet_tool_v2,
};

static void
viewport_destroy_resource(struct wl_resource *resource)
{
	struct aperture_viewport *viewport = wl_resource_get_user_data(resource);

	if (viewport->surface) {
		unset_viewport_source(&viewport->surface->pending.buffer_viewport);
		unset_viewport_destination(&viewport->surface->pending.buffer_viewport);
		viewport->surface->viewport_resource = NULL;
		wl_list_remove(&viewport->surface_destroy_listener.link);
	}
	free(viewport);
}

static void
destroy_viewport_for_surface(struct wl_listener *listener, void *data)
{
	struct aperture_viewport *viewport =
		wl_container_of(listener, viewport, surface_destroy_listener);

	viewport->surface = NULL;
	wl_resource_destroy(viewport->resource);
}

static void
viewport_destroy(struct wl_client *client, struct wl_resource *resource)
{
	wl_resource_destroy(resource);
}

static void
viewport_set_source(struct wl_client *client, struct wl_resource *resource,
		    wl_fixed_t x, wl_fixed_t y, wl_fixed_t width, wl_fixed_t height)
{
	struct aperture_viewport *viewport = wl_resource_get_user_data(resource);
	struct weston_buffer_viewport *pending;

	if (!viewport->surface) {
		wl_resource_post_error(resource, WP_VIEWPORT_ERROR_NO_SURFACE,
				       "surface was destroyed");
		return;
	}

	pending = &viewport->surface->pending.buffer_viewport;
	if (x == wl_fixed_from_int(-1) && y == wl_fixed_from_int(-1) &&
	    width == wl_fixed_from_int(-1) && height == wl_fixed_from_int(-1)) {
		unset_viewport_source(pending);
		return;
	}

	if (x < 0 || y < 0 || width <= 0 || height <= 0) {
		wl_resource_post_error(resource, WP_VIEWPORT_ERROR_BAD_VALUE,
				       "invalid viewport source");
		return;
	}

	pending->buffer.src_x = x;
	pending->buffer.src_y = y;
	pending->buffer.src_width = width;
	pending->buffer.src_height = height;
}

static void
viewport_set_destination(struct wl_client *client, struct wl_resource *resource,
			 int32_t width, int32_t height)
{
	struct aperture_viewport *viewport = wl_resource_get_user_data(resource);
	struct weston_buffer_viewport *pending;

	if (!viewport->surface) {
		wl_resource_post_error(resource, WP_VIEWPORT_ERROR_NO_SURFACE,
				       "surface was destroyed");
		return;
	}

	pending = &viewport->surface->pending.buffer_viewport;
	if (width == -1 && height == -1) {
		unset_viewport_destination(pending);
		return;
	}

	if (width <= 0 || height <= 0) {
		wl_resource_post_error(resource, WP_VIEWPORT_ERROR_BAD_VALUE,
				       "invalid viewport destination");
		return;
	}

	pending->surface.width = width;
	pending->surface.height = height;
}

static const struct wp_viewport_interface viewport_interface = {
	viewport_destroy,
	viewport_set_source,
	viewport_set_destination,
};

static void
viewporter_destroy(struct wl_client *client, struct wl_resource *resource)
{
	wl_resource_destroy(resource);
}

static void
viewporter_get_viewport(struct wl_client *client, struct wl_resource *resource,
			uint32_t id, struct wl_resource *surface_resource)
{
	struct weston_surface *surface = wl_resource_get_user_data(surface_resource);
	struct aperture_viewport *viewport;
	int version = wl_resource_get_version(resource);

	if (surface->viewport_resource) {
		wl_resource_post_error(resource, WP_VIEWPORTER_ERROR_VIEWPORT_EXISTS,
				       "viewport object already exists for this surface");
		return;
	}

	viewport = calloc(1, sizeof *viewport);
	if (!viewport) {
		wl_client_post_no_memory(client);
		return;
	}

	viewport->resource = wl_resource_create(client, &wp_viewport_interface, version, id);
	if (!viewport->resource) {
		free(viewport);
		wl_client_post_no_memory(client);
		return;
	}

	viewport->surface = surface;
	viewport->surface_destroy_listener.notify = destroy_viewport_for_surface;
	wl_signal_add(&surface->destroy_signal, &viewport->surface_destroy_listener);
	wl_resource_set_implementation(viewport->resource, &viewport_interface, viewport,
				       viewport_destroy_resource);
	surface->viewport_resource = viewport->resource;
}

static const struct wp_viewporter_interface viewporter_interface = {
	viewporter_destroy,
	viewporter_get_viewport,
};

static void
bind_viewporter(struct wl_client *client, void *data, uint32_t version, uint32_t id)
{
	struct wl_resource *resource;

	resource = wl_resource_create(client, &wp_viewporter_interface, version, id);
	if (!resource) {
		wl_client_post_no_memory(client);
		return;
	}
	wl_resource_set_implementation(resource, &viewporter_interface, data, NULL);
}

static int
create_viewporter(struct aperture_shell *shell)
{
	shell->viewporter_global = wl_global_create(shell->compositor->wl_display,
						    &wp_viewporter_interface, 1, shell,
						    bind_viewporter);
	return shell->viewporter_global ? 0 : -1;
}

static void
bind_fractional_scale_manager(struct wl_client *client, void *data, uint32_t version,
			      uint32_t id)
{
	struct wl_resource *resource;

	resource = wl_resource_create(client, &wp_fractional_scale_manager_v1_interface,
				      version, id);
	if (!resource) {
		wl_client_post_no_memory(client);
		return;
	}
	wl_resource_set_implementation(resource, &fractional_scale_manager_interface, data,
				       NULL);
}

static int
create_fractional_scale_manager(struct aperture_shell *shell)
{
	shell->fractional_scale_global = wl_global_create(
		shell->compositor->wl_display, &wp_fractional_scale_manager_v1_interface, 1,
		shell, bind_fractional_scale_manager);
	return shell->fractional_scale_global ? 0 : -1;
}

static void
bind_cursor_shape_manager(struct wl_client *client, void *data, uint32_t version,
			  uint32_t id)
{
	struct wl_resource *resource;

	resource = wl_resource_create(client, &wp_cursor_shape_manager_v1_interface,
				      version, id);
	if (!resource) {
		wl_client_post_no_memory(client);
		return;
	}
	wl_resource_set_implementation(resource, &cursor_shape_manager_interface, data,
				       NULL);
}

static int
create_cursor_shape_manager(struct aperture_shell *shell)
{
	shell->cursor_shape_global = wl_global_create(
		shell->compositor->wl_display, &wp_cursor_shape_manager_v1_interface, 2,
		shell, bind_cursor_shape_manager);
	return shell->cursor_shape_global ? 0 : -1;
}

static void
desktop_surface_added(struct weston_desktop_surface *desktop_surface, void *data)
{
	struct aperture_shell *shell = data;
	struct aperture_shell_surface *surface = calloc(1, sizeof *surface);
	struct weston_desktop_surface *parent;

	if (!surface)
		return;

	surface->desktop_surface = desktop_surface;
	surface->id = ++shell->next_surface_id;
	surface->view = weston_desktop_surface_create_view(desktop_surface);
	if (!surface->view) {
		free(surface);
		return;
	}
	wl_list_init(&surface->fit_transform.link);

	wl_list_insert(&shell->surfaces, &surface->link);
	weston_desktop_surface_set_user_data(desktop_surface, surface);
	parent = weston_desktop_surface_get_parent(desktop_surface);
	if (parent) {
		struct aperture_shell_surface *root;

		surface->parent = find_shell_surface_for_weston_surface(
			shell, weston_desktop_surface_get_surface(parent));
		root = root_shell_surface(shell, surface);
		if (root && root != surface) {
			surface->capture_output = root->capture_output;
			surface->width = root->width;
			surface->height = root->height;
			surface->scale_numerator = root->scale_numerator;
		}
	} else if (shell->pending_surface_nonce) {
		surface->binding_nonce = shell->pending_surface_nonce;
		shell->pending_surface_nonce = NULL;
	}
	weston_log("aperture-shell: surface %llu added title=%s binding=%s\n",
		   (unsigned long long)surface->id,
		   weston_desktop_surface_get_title(desktop_surface) ?: "",
		   surface->binding_nonce ?: "");
}

static void
desktop_surface_removed(struct weston_desktop_surface *desktop_surface, void *data)
{
	struct aperture_shell *shell = data;
	struct aperture_shell_surface *surface =
		weston_desktop_surface_get_user_data(desktop_surface);
	struct aperture_shell_surface *child;

	if (!surface)
		return;
	wl_list_for_each(child, &shell->surfaces, link) {
		if (child->parent != surface)
			continue;
		child->parent = NULL;
		if (child->capture_output)
			unbind_surface_tree(shell, child);
	}

	weston_desktop_surface_set_user_data(desktop_surface, NULL);
	wl_list_remove(&surface->link);
	if (surface->fit_transform_added)
		weston_view_remove_transform(surface->view, &surface->fit_transform);
	weston_desktop_surface_unlink_view(surface->view);
	weston_view_destroy(surface->view);
	free(surface->binding_nonce);
	free(surface);
}

static void
desktop_surface_committed(struct weston_desktop_surface *desktop_surface,
			  struct weston_coord_surface origin, void *data)
{
	struct aperture_shell *shell = data;
	struct aperture_shell_surface *surface =
		weston_desktop_surface_get_user_data(desktop_surface);
	struct weston_surface *weston_surface =
		weston_desktop_surface_get_surface(desktop_surface);

	if (!surface || !surface->view)
		return;
	if (!surface->capture_output)
		return;

	if (weston_surface_is_mapped(weston_surface)) {
		layout_surface(shell, surface, surface->width, surface->height);
		return;
	}

	weston_surface_map(weston_surface);
	layout_surface(shell, surface, surface->width, surface->height);
	activate_surface(shell, surface, WESTON_ACTIVATE_FLAG_NONE);
}

static void
desktop_surface_move(struct weston_desktop_surface *desktop_surface,
		     struct weston_seat *seat, uint32_t serial, void *data)
{
}

static void
desktop_surface_resize(struct weston_desktop_surface *desktop_surface,
		       struct weston_seat *seat, uint32_t serial,
		       enum weston_desktop_surface_edge edges, void *data)
{
}

static void
desktop_surface_set_parent(struct weston_desktop_surface *desktop_surface,
			   struct weston_desktop_surface *parent, void *data)
{
	struct aperture_shell *shell = data;
	struct aperture_shell_surface *surface =
		weston_desktop_surface_get_user_data(desktop_surface);
	struct aperture_shell_surface *next_parent = parent ?
		find_shell_surface_for_weston_surface(
			shell, weston_desktop_surface_get_surface(parent)) : NULL;
	struct aperture_shell_surface *root;

	if (!surface || surface->parent == next_parent)
		return;
	surface->parent = next_parent;
	root = root_shell_surface(shell, surface);
	if (root && root != surface && root->capture_output) {
		bind_surface_tree(shell, root, root->capture_output, root->width,
				  root->height, root->scale_numerator);
		return;
	}
	if (surface->capture_output)
		unbind_surface_tree(shell, surface);
}

static void
desktop_surface_fullscreen_requested(struct weston_desktop_surface *desktop_surface,
				     bool fullscreen, struct weston_output *output, void *data)
{
	struct aperture_shell_surface *surface =
		weston_desktop_surface_get_user_data(desktop_surface);

	if (surface)
		layout_surface(data, surface, surface->width, surface->height);
}

static void
desktop_surface_maximized_requested(struct weston_desktop_surface *desktop_surface,
				    bool maximized, void *data)
{
	struct aperture_shell_surface *surface =
		weston_desktop_surface_get_user_data(desktop_surface);

	if (surface)
		layout_surface(data, surface, surface->width, surface->height);
}

static void
desktop_surface_minimized_requested(struct weston_desktop_surface *desktop_surface, void *data)
{
}

static void
desktop_surface_ping_timeout(struct weston_desktop_client *client, void *data)
{
}

static void
desktop_surface_pong(struct weston_desktop_client *client, void *data)
{
}

static const struct weston_desktop_api desktop_api = {
	.struct_size = sizeof(struct weston_desktop_api),
	.surface_added = desktop_surface_added,
	.surface_removed = desktop_surface_removed,
	.committed = desktop_surface_committed,
	.set_parent = desktop_surface_set_parent,
	.move = desktop_surface_move,
	.resize = desktop_surface_resize,
	.fullscreen_requested = desktop_surface_fullscreen_requested,
	.maximized_requested = desktop_surface_maximized_requested,
	.minimized_requested = desktop_surface_minimized_requested,
	.ping_timeout = desktop_surface_ping_timeout,
	.pong = desktop_surface_pong,
};

static void
click_to_activate(struct weston_pointer *pointer, const struct timespec *time,
		  uint32_t button, void *data)
{
	if (pointer->grab != &pointer->default_grab || !pointer->focus)
		return;

	weston_view_activate_input(pointer->focus, pointer->seat, WESTON_ACTIVATE_FLAG_CLICKED);
}

static int
create_background(struct aperture_shell *shell)
{
	struct weston_output *output = default_output(shell);
	struct weston_curtain_params params;

	if (!output)
		return -1;

	params = (struct weston_curtain_params) {
		.r = 0.0,
		.g = 0.0,
		.b = 0.0,
		.a = 1.0,
		.pos = output->pos,
		.width = output->width,
		.height = output->height,
		.capture_input = false,
		.surface_committed = NULL,
		.label = strdup("aperture background"),
		.surface_private = NULL,
	};

	shell->background = weston_shell_utils_curtain_create(shell->compositor, &params);
	if (!shell->background)
		return -1;

	weston_view_move_to_layer(shell->background->view, &shell->background_layer.view_list);
	return 0;
}

static int
create_capture_background(struct aperture_shell *shell, struct aperture_output *capture)
{
	struct weston_curtain_params params = {
		.r = 0.0,
		.g = 0.0,
		.b = 0.0,
		.a = 1.0,
		.pos = capture->output->pos,
		.width = capture->output->width,
		.height = capture->output->height,
		.capture_input = false,
		.surface_committed = NULL,
		.label = strdup("aperture background"),
		.surface_private = NULL,
	};

	capture->background = weston_shell_utils_curtain_create(shell->compositor, &params);
	if (!capture->background)
		return -1;
	weston_view_set_output(capture->background->view, capture->output);
	weston_view_move_to_layer(capture->background->view,
				  &shell->background_layer.view_list);
	return 0;
}

static const char *
create_capture_output(struct aperture_shell *shell, const char *capture_id,
		      uint32_t width, uint32_t height,
		      struct aperture_output **created)
{
	const struct weston_pipewire_output_api *api =
		weston_pipewire_output_get_api(shell->compositor);
	struct weston_output *staging = default_output(shell);
	struct weston_head *head = NULL;
	struct weston_output *output;
	struct aperture_output *capture;
	struct pipewire_config config;
	struct weston_coord_global position;
	int64_t output_x;
	char name[160];

	if (!api || !staging || weston_get_backend_type(staging->backend) != WESTON_BACKEND_PIPEWIRE)
		return "PipeWire output API is unavailable";
	if (!valid_control_id(capture_id) || find_capture_output(shell, capture_id))
		return "invalid or duplicate capture id";
	if (width < aperture_min_dimension || height < aperture_min_dimension ||
	    width > aperture_max_dimension || height > aperture_max_dimension ||
	    width % aperture_media_canvas_bucket != 0 ||
	    height % aperture_media_canvas_bucket != 0)
		return "invalid output specification";
	output_x = (int64_t)staging->pos.c.x + staging->width;
	for (;;) {
		bool overlaps = false;
		struct aperture_output *existing;

		if (output_x > INT32_MAX - (int64_t)width)
			return "output coordinate space is exhausted";
		wl_list_for_each(existing, &shell->outputs, link) {
			int64_t existing_x = (int64_t)existing->output->pos.c.x;
			int64_t existing_end = existing_x + existing->output->width;

			if (output_x >= existing_end ||
			    output_x + width <= existing_x)
				continue;
			output_x = existing_end;
			overlaps = true;
			break;
		}
		if (!overlaps)
			break;
	}

	snprintf(name, sizeof name, "aperture-%s", capture_id);
	config = (struct pipewire_config) {
		.width = (int32_t)width,
		.height = (int32_t)height,
		.framerate = 60,
	};
	api->head_create(staging->backend, name, &config);
	while ((head = weston_compositor_iterate_heads(shell->compositor, head))) {
		if (strcmp(weston_head_get_name(head), name) == 0)
			break;
	}
	if (!head)
		return "output head creation failed";
	output = weston_compositor_create_output(shell->compositor, head, name);
	if (!output) {
		api->head_destroy(head);
		return "output creation failed";
	}

	weston_output_set_scale(output, 1);
	weston_output_set_transform(output, WL_OUTPUT_TRANSFORM_NORMAL);
	api->set_gbm_format(output, "xrgb8888");
	if (api->output_set_size(output, (int)width, (int)height, 60) < 0 ||
	    weston_output_enable(output) < 0) {
		weston_output_destroy(output);
		api->head_destroy(head);
		return "output enable failed";
	}
	position.c = weston_coord((float)output_x, 0);
	weston_output_move(output, position);
	weston_output_set_ready(output);

	capture = calloc(1, sizeof *capture);
	if (!capture) {
		weston_output_destroy(output);
		api->head_destroy(head);
		return "out of memory";
	}
	capture->capture_id = strdup(capture_id);
	capture->name = strdup(name);
	if (!capture->capture_id || !capture->name) {
		free(capture->capture_id);
		free(capture->name);
		free(capture);
		weston_output_destroy(output);
		api->head_destroy(head);
		return "out of memory";
	}
	capture->output = output;
	capture->width = width;
	capture->height = height;
	if (create_capture_background(shell, capture) < 0) {
		free(capture->capture_id);
		free(capture->name);
		free(capture);
		weston_output_destroy(output);
		api->head_destroy(head);
		return "output background creation failed";
	}
	wl_list_insert(&shell->outputs, &capture->link);
	*created = capture;
	return NULL;
}

static const char *
destroy_capture_output(struct aperture_shell *shell, struct aperture_output *capture)
{
	const struct weston_pipewire_output_api *api =
		weston_pipewire_output_get_api(shell->compositor);
	struct aperture_shell_surface *surface;
	struct weston_head *head = weston_output_iterate_heads(capture->output, NULL);

	wl_list_for_each(surface, &shell->surfaces, link) {
		if (surface->capture_output == capture)
			return "output still has bound surfaces";
	}
	wl_list_remove(&capture->link);
	if (capture->background)
		weston_shell_utils_curtain_destroy(capture->background);
	weston_output_destroy(capture->output);
	if (head)
		api->head_destroy(head);
	free(capture->capture_id);
	free(capture->name);
	free(capture);
	return NULL;
}

static void
bind_surface_tree(struct aperture_shell *shell, struct aperture_shell_surface *root,
		  struct aperture_output *capture, uint32_t width, uint32_t height,
		  uint32_t scale_numerator)
{
	struct aperture_shell_surface *surface;

	wl_list_for_each(surface, &shell->surfaces, link) {
		if (root_shell_surface(shell, surface) != root)
			continue;
		surface->capture_output = capture;
		surface->width = width;
		surface->height = height;
		surface->scale_numerator = scale_numerator;
		if (surface == root)
			send_fractional_scale_surface(shell, surface);
		if (!weston_surface_is_mapped(
			    weston_desktop_surface_get_surface(surface->desktop_surface)) &&
		    weston_surface_has_content(
			    weston_desktop_surface_get_surface(surface->desktop_surface)))
			weston_surface_map(
				weston_desktop_surface_get_surface(surface->desktop_surface));
		layout_surface(shell, surface, width, height);
	}
	weston_desktop_surface_propagate_layer(root->desktop_surface);
}

static void
unbind_surface_tree(struct aperture_shell *shell, struct aperture_shell_surface *root)
{
	struct aperture_shell_surface *surface;

	wl_list_for_each(surface, &shell->surfaces, link) {
		if (root_shell_surface(shell, surface) != root)
			continue;
		surface->capture_output = NULL;
		surface->width = 0;
		surface->height = 0;
		surface->scale_numerator = 0;
		if (surface == root)
			send_fractional_scale_surface(shell, surface);
		weston_surface_unmap(
			weston_desktop_surface_get_surface(surface->desktop_surface));
	}
}

static void
destroy_control_client(struct aperture_control_client *client)
{
	if (client->source)
		wl_event_source_remove(client->source);
	if (client->fd >= 0)
		close(client->fd);
	wl_list_remove(&client->link);
	free(client);
}

static void
write_control_response(struct aperture_control_client *client, const char *response)
{
	ssize_t n = write(client->fd, response, strlen(response));
	(void)n;
}

static void
handle_control_command(struct aperture_control_client *client)
{
	unsigned int width;
	unsigned int height;
	unsigned int scale_numerator = 0;
	unsigned int code;
	unsigned int pressed;
	unsigned long long surface_id;
	double x;
	double y;
	double dx;
	double dy;
	char trailing;
	char identifier[129];
	int text_offset;
	const char *error;
	char response[512];
	struct aperture_shell_surface *surface;
	struct aperture_output *capture;

	if (sscanf(client->buffer, "surface-prepare %128s %c", identifier, &trailing) == 1) {
		if (!valid_control_id(identifier)) {
			write_control_response(client, "error invalid binding nonce\n");
			return;
		}
		if (client->shell->pending_surface_nonce) {
			write_control_response(client, "error binding already pending\n");
			return;
		}
		wl_list_for_each(surface, &client->shell->surfaces, link) {
			if (surface->binding_nonce &&
			    strcmp(surface->binding_nonce, identifier) == 0) {
				write_control_response(client, "error binding nonce already used\n");
				return;
			}
		}
		client->shell->pending_surface_nonce = strdup(identifier);
		if (!client->shell->pending_surface_nonce) {
			write_control_response(client, "error out of memory\n");
			return;
		}
		write_control_response(client, "ok\n");
		return;
	}

	if (sscanf(client->buffer, "surface-cancel %128s %c", identifier, &trailing) == 1) {
		if (client->shell->pending_surface_nonce &&
		    strcmp(client->shell->pending_surface_nonce, identifier) == 0) {
			free(client->shell->pending_surface_nonce);
			client->shell->pending_surface_nonce = NULL;
		}
		wl_list_for_each(surface, &client->shell->surfaces, link) {
			if (!surface->binding_nonce ||
			    strcmp(surface->binding_nonce, identifier) != 0)
				continue;
			free(surface->binding_nonce);
			surface->binding_nonce = NULL;
		}
		write_control_response(client, "ok\n");
		return;
	}

	if (sscanf(client->buffer, "output-create %128s %u %u %c", identifier,
		   &width, &height, &trailing) == 3) {
		error = create_capture_output(client->shell, identifier, width, height,
					      &capture);
		if (error) {
			snprintf(response, sizeof response, "error %s\n", error);
			write_control_response(client, response);
			return;
		}
		snprintf(response, sizeof response, "ok %s %s %u %u\n",
			 capture->capture_id, capture->name, capture->width,
			 capture->height);
		write_control_response(client, response);
		return;
	}

	if (sscanf(client->buffer, "output-repaint %128s %c", identifier, &trailing) == 1) {
		capture = find_capture_output(client->shell, identifier);
		if (!capture) {
			write_control_response(client, "error output not found\n");
			return;
		}
		capture->output->full_repaint_needed = true;
		weston_output_schedule_repaint(capture->output);
		write_control_response(client, "ok\n");
		return;
	}

	if (sscanf(client->buffer, "output-destroy %128s %c", identifier, &trailing) == 1) {
		capture = find_capture_output(client->shell, identifier);
		if (!capture) {
			write_control_response(client, "error output not found\n");
			return;
		}
		error = destroy_capture_output(client->shell, capture);
		if (error) {
			snprintf(response, sizeof response, "error %s\n", error);
			write_control_response(client, response);
			return;
		}
		write_control_response(client, "ok\n");
		return;
	}

	if (sscanf(client->buffer, "surface-find %128s %c", identifier, &trailing) == 1) {
		wl_list_for_each(surface, &client->shell->surfaces, link) {
			if (surface->binding_nonce &&
			    strcmp(surface->binding_nonce, identifier) == 0) {
				snprintf(response, sizeof response, "ok %llu\n",
					 (unsigned long long)surface->id);
				write_control_response(client, response);
				return;
			}
		}
		write_control_response(client, "error surface not found\n");
		return;
	}

	if (sscanf(client->buffer, "surface-bind %llu %128s %u %u %u %c", &surface_id,
		   identifier, &width, &height, &scale_numerator, &trailing) == 5) {
		surface = find_shell_surface(client->shell, (uint64_t)surface_id);
		capture = find_capture_output(client->shell, identifier);
		if (!surface || !capture) {
			write_control_response(client, "error surface or output not found\n");
			return;
		}
		if (width < aperture_min_configure_width ||
		    height < aperture_min_dimension || width > aperture_max_dimension ||
		    height > aperture_max_dimension ||
		    scale_numerator < aperture_min_scale_numerator ||
		    scale_numerator > aperture_max_scale_numerator ||
		    scaled_dimension(width, scale_numerator) > capture->width ||
		    scaled_dimension(height, scale_numerator) > capture->height) {
			write_control_response(client, "error invalid surface specification\n");
			return;
		}
		surface = root_shell_surface(client->shell, surface);
		if (!surface) {
			write_control_response(client, "error root surface not found\n");
			return;
		}
		bind_surface_tree(client->shell, surface, capture, width, height,
				  scale_numerator);
		write_control_response(client, "ok\n");
		return;
	}

	if (sscanf(client->buffer, "surface-unbind %llu %c", &surface_id, &trailing) == 1) {
		surface = find_shell_surface(client->shell, (uint64_t)surface_id);
		if (!surface) {
			write_control_response(client, "error surface not found\n");
			return;
		}
		surface = root_shell_surface(client->shell, surface);
		if (!surface) {
			write_control_response(client, "error root surface not found\n");
			return;
		}
		unbind_surface_tree(client->shell, surface);
		write_control_response(client, "ok\n");
		return;
	}

	if (sscanf(client->buffer, "surface-status %llu %c", &surface_id, &trailing) == 1) {
		struct weston_surface *weston_surface;

		surface = find_shell_surface(client->shell, (uint64_t)surface_id);
		if (!surface || !surface->capture_output) {
			write_control_response(client, "error surface is unavailable\n");
			return;
		}
		weston_surface = weston_desktop_surface_get_surface(surface->desktop_surface);
		snprintf(response, sizeof response, "ok %s %d %d %u\n",
			 surface->capture_output->capture_id, weston_surface->width,
			 weston_surface->height, weston_surface_is_mapped(weston_surface) ? 1 : 0);
		write_control_response(client, response);
		return;
	}

	if (sscanf(client->buffer, "motion %llu %lf %lf %c", &surface_id, &x, &y,
		   &trailing) == 3) {
		surface = find_shell_surface(client->shell, (uint64_t)surface_id);
		error = inject_pointer_motion(client->shell, surface, x, y);
		if (error) {
			snprintf(response, sizeof response, "error %s\n", error);
			write_control_response(client, response);
			return;
		}
		flush_pointer_frame(client->shell);
		write_control_response(client, "ok\n");
		return;
	}

	if (sscanf(client->buffer, "button-at %llu %lf %lf %u %u %c", &surface_id, &x,
		   &y, &code, &pressed, &trailing) == 5) {
		surface = find_shell_surface(client->shell, (uint64_t)surface_id);
		error = inject_pointer_motion(client->shell, surface, x, y);
		if (!error)
			error = inject_button(client->shell, surface, code, pressed != 0);
		if (error) {
			snprintf(response, sizeof response, "error %s\n", error);
			write_control_response(client, response);
			return;
		}
		flush_pointer_frame(client->shell);
		write_control_response(client, "ok\n");
		return;
	}

	if (sscanf(client->buffer, "button %llu %u %u %c", &surface_id, &code, &pressed,
		   &trailing) == 3) {
		surface = find_shell_surface(client->shell, (uint64_t)surface_id);
		error = inject_button(client->shell, surface, code, pressed != 0);
		if (error) {
			snprintf(response, sizeof response, "error %s\n", error);
			write_control_response(client, response);
			return;
		}
		flush_pointer_frame(client->shell);
		write_control_response(client, "ok\n");
		return;
	}

	if (sscanf(client->buffer, "axis-at %llu %lf %lf %lf %lf %c", &surface_id, &x, &y,
		   &dx, &dy, &trailing) == 5) {
		surface = find_shell_surface(client->shell, (uint64_t)surface_id);
		error = inject_pointer_motion(client->shell, surface, x, y);
		if (!error)
			error = inject_axis(client->shell, surface, dx, dy);
		if (error) {
			snprintf(response, sizeof response, "error %s\n", error);
			write_control_response(client, response);
			return;
		}
		flush_pointer_frame(client->shell);
		write_control_response(client, "ok\n");
		return;
	}

	if (sscanf(client->buffer, "axis %llu %lf %lf %c", &surface_id, &dx, &dy,
		   &trailing) == 3) {
		surface = find_shell_surface(client->shell, (uint64_t)surface_id);
		error = inject_axis(client->shell, surface, dx, dy);
		if (error) {
			snprintf(response, sizeof response, "error %s\n", error);
			write_control_response(client, response);
			return;
		}
		flush_pointer_frame(client->shell);
		write_control_response(client, "ok\n");
		return;
	}

	if (sscanf(client->buffer, "key %llu %u %u %c", &surface_id, &code, &pressed,
		   &trailing) == 3) {
		surface = find_shell_surface(client->shell, (uint64_t)surface_id);
		error = inject_key(client->shell, surface, code, pressed != 0);
		if (error) {
			snprintf(response, sizeof response, "error %s\n", error);
			write_control_response(client, response);
			return;
		}
		write_control_response(client, "ok\n");
		return;
	}

	text_offset = 0;
	if (sscanf(client->buffer, "text %llu %n", &surface_id, &text_offset) == 1 &&
	    text_offset > 0) {
		surface = find_shell_surface(client->shell, (uint64_t)surface_id);
		error = inject_text(client->shell, surface, client->buffer + text_offset);
		if (error) {
			snprintf(response, sizeof response, "error %s\n", error);
			write_control_response(client, response);
			return;
		}
		write_control_response(client, "ok\n");
		return;
	}

	write_control_response(client, "error invalid command\n");
}

static int
dispatch_control_client(int fd, uint32_t mask, void *data)
{
	struct aperture_control_client *client = data;
	ssize_t n;
	char *newline;

	if (mask & (WL_EVENT_HANGUP | WL_EVENT_ERROR)) {
		destroy_control_client(client);
		return 0;
	}

	n = read(fd, client->buffer + client->length,
		 sizeof client->buffer - client->length - 1);
	if (n <= 0) {
		destroy_control_client(client);
		return 0;
	}

	client->length += (size_t)n;
	client->buffer[client->length] = '\0';
	newline = strchr(client->buffer, '\n');
	if (!newline) {
		if (client->length == sizeof client->buffer - 1) {
			write_control_response(client, "error command too long\n");
			destroy_control_client(client);
		}
		return 0;
	}

	*newline = '\0';
	handle_control_command(client);
	destroy_control_client(client);
	return 0;
}

static int
dispatch_control_listener(int fd, uint32_t mask, void *data)
{
	struct aperture_shell *shell = data;
	struct wl_event_loop *loop;

	if (mask & (WL_EVENT_HANGUP | WL_EVENT_ERROR))
		return 0;

	loop = wl_display_get_event_loop(shell->compositor->wl_display);
	for (;;) {
		struct aperture_control_client *client;
		int client_fd = accept(fd, NULL, NULL);

		if (client_fd < 0) {
			if (errno != EAGAIN && errno != EWOULDBLOCK)
				weston_log("aperture-shell: accept control client failed: %s\n",
					   strerror(errno));
			return 0;
		}

		if (set_nonblock_cloexec(client_fd) < 0) {
			close(client_fd);
			continue;
		}

		client = calloc(1, sizeof *client);
		if (!client) {
			close(client_fd);
			continue;
		}

		client->shell = shell;
		client->fd = client_fd;
		client->source = wl_event_loop_add_fd(loop, client_fd, WL_EVENT_READABLE,
						     dispatch_control_client, client);
		if (!client->source) {
			close(client_fd);
			free(client);
			continue;
		}
		wl_list_insert(&shell->control_clients, &client->link);
	}
}

static int
setup_control_socket(struct aperture_shell *shell)
{
	const char *socket_path = getenv("APERTURE_CONTROL_SOCKET");
	struct wl_event_loop *loop;
	struct sockaddr_un addr = {0};
	int fd;

	if (!socket_path || !socket_path[0])
		return 0;
	if (strlen(socket_path) >= sizeof addr.sun_path) {
		weston_log("aperture-shell: control socket path is too long\n");
		return -1;
	}

	fd = socket(AF_UNIX, SOCK_STREAM, 0);
	if (fd < 0)
		return -1;
	if (set_nonblock_cloexec(fd) < 0)
		goto err_fd;

	shell->control_socket_path = strdup(socket_path);
	if (!shell->control_socket_path)
		goto err_fd;

	unlink(socket_path);
	addr.sun_family = AF_UNIX;
	strncpy(addr.sun_path, socket_path, sizeof addr.sun_path - 1);
	if (bind(fd, (struct sockaddr *)&addr, sizeof addr) < 0)
		goto err_path;
	if (listen(fd, 8) < 0)
		goto err_path;

	loop = wl_display_get_event_loop(shell->compositor->wl_display);
	shell->control_fd = fd;
	shell->control_source = wl_event_loop_add_fd(loop, fd, WL_EVENT_READABLE,
						     dispatch_control_listener, shell);
	if (!shell->control_source)
		goto err_path;

	weston_log("aperture-shell: control socket listening on %s (%ux%u)\n",
		   shell->control_socket_path, shell->width, shell->height);
	return 0;

err_path:
	unlink(socket_path);
	free(shell->control_socket_path);
	shell->control_socket_path = NULL;
err_fd:
	close(fd);
	return -1;
}

static void
destroy_shell(struct wl_listener *listener, void *data)
{
	struct aperture_shell *shell = wl_container_of(listener, shell, destroy_listener);
	struct aperture_control_client *control_client;
	struct aperture_control_client *next_control_client;
	struct aperture_fractional_scale *fractional_scale;
	struct aperture_fractional_scale *next_fractional_scale;
	struct aperture_text_input *text_input;
	struct aperture_text_input *next_text_input;
	struct aperture_output *capture;
	struct aperture_output *next_capture;

	wl_list_remove(&shell->destroy_listener.link);
	wl_list_remove(&shell->text_input_focus_listener.link);
	if (shell->control_source)
		wl_event_source_remove(shell->control_source);
	if (shell->cursor_shape_global)
		wl_global_destroy(shell->cursor_shape_global);
	if (shell->fractional_scale_global)
		wl_global_destroy(shell->fractional_scale_global);
	if (shell->text_input_global)
		wl_global_destroy(shell->text_input_global);
	if (shell->viewporter_global)
		wl_global_destroy(shell->viewporter_global);
	wl_list_for_each_safe(fractional_scale, next_fractional_scale,
			      &shell->fractional_scales, link)
		wl_resource_destroy(fractional_scale->resource);
	wl_list_for_each_safe(text_input, next_text_input, &shell->text_inputs, link)
		wl_resource_destroy(text_input->resource);
	wl_list_for_each_safe(control_client, next_control_client,
			      &shell->control_clients, link)
		destroy_control_client(control_client);
	if (shell->desktop)
		weston_desktop_destroy(shell->desktop);
	wl_list_for_each_safe(capture, next_capture, &shell->outputs, link) {
		wl_list_remove(&capture->link);
		if (capture->background)
			weston_shell_utils_curtain_destroy(capture->background);
		free(capture->capture_id);
		free(capture->name);
		free(capture);
	}
	if (shell->background)
		weston_shell_utils_curtain_destroy(shell->background);
	if (shell->control_fd >= 0)
		close(shell->control_fd);
	if (shell->control_socket_path) {
		unlink(shell->control_socket_path);
		free(shell->control_socket_path);
	}
	free(shell->pending_surface_nonce);
	if (shell->input_seat_initialized) {
		if (shell->input_keyboard_initialized)
			weston_seat_release_keyboard(&shell->input_seat);
		if (shell->input_pointer_initialized)
			weston_seat_release_pointer(&shell->input_seat);
		weston_seat_release(&shell->input_seat);
	}
	weston_layer_fini(&shell->normal_layer);
	weston_layer_fini(&shell->background_layer);
	free(shell);
}

WL_EXPORT int
wet_shell_init(struct weston_compositor *compositor, int *argc, char *argv[])
{
	struct aperture_shell *shell = calloc(1, sizeof *shell);
	struct weston_output *output;

	if (!shell)
		return -1;

	shell->compositor = compositor;
	shell->control_fd = -1;
	shell->width = parse_positive_env("APERTURE_VIEWPORT_WIDTH", 1280);
	shell->height = parse_positive_env("APERTURE_VIEWPORT_HEIGHT", 720);
	shell->scale_numerator = aperture_scale_denominator;
	wl_list_init(&shell->surfaces);
	wl_list_init(&shell->outputs);
	wl_list_init(&shell->control_clients);
	wl_list_init(&shell->fractional_scales);
	wl_list_init(&shell->text_inputs);
	wl_list_init(&shell->text_input_focus_listener.link);
	weston_layer_init(&shell->background_layer, compositor);
	weston_layer_init(&shell->normal_layer, compositor);
	weston_layer_set_position(&shell->background_layer, WESTON_LAYER_POSITION_BACKGROUND);
	weston_layer_set_position(&shell->normal_layer, WESTON_LAYER_POSITION_NORMAL);

	shell->destroy_listener.notify = destroy_shell;
	wl_signal_add(&compositor->destroy_signal, &shell->destroy_listener);

	weston_seat_init(&shell->input_seat, compositor, "aperture");
	shell->input_seat_initialized = true;
	if (weston_seat_init_pointer(&shell->input_seat) < 0)
		goto err;
	shell->input_pointer_initialized = true;
	if (weston_seat_init_keyboard(&shell->input_seat, NULL) < 0)
		goto err;
	shell->input_keyboard_initialized = true;
	shell->text_input_focus_listener.notify = handle_text_input_focus;
	wl_signal_add(&weston_seat_get_keyboard(&shell->input_seat)->focus_signal,
		      &shell->text_input_focus_listener);

	if (create_background(shell) < 0)
		goto err;
	if (create_fractional_scale_manager(shell) < 0)
		goto err;
	if (create_viewporter(shell) < 0)
		goto err;
	if (create_cursor_shape_manager(shell) < 0)
		goto err;
	if (create_text_input_manager(shell) < 0)
		goto err;
	if (setup_control_socket(shell) < 0)
		goto err;

	shell->desktop = weston_desktop_create(compositor, &desktop_api, shell);
	if (!shell->desktop)
		goto err;

	weston_compositor_add_button_binding(compositor, BTN_LEFT, 0, click_to_activate, shell);

	output = default_output(shell);
	if (output)
		weston_output_set_ready(output);

	weston_log("aperture-shell: initialized\n");
	return 0;

err:
	destroy_shell(&shell->destroy_listener, NULL);
	return -1;
}
