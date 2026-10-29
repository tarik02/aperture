#define _GNU_SOURCE /* pipe2 */

#include <linux/input-event-codes.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <signal.h>
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

#include "fractional-scale-v1-server-protocol.h"
#include "primary-selection-unstable-v1-server-protocol.h"
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

void notify_motion(const struct weston_pointer_motion_event *event);
void notify_button(const struct weston_pointer_button_event *event);
void notify_axis(const struct weston_pointer_axis_event *event);
void notify_axis_source(struct weston_seat *seat, uint32_t source);
void notify_pointer_frame(struct weston_seat *seat);
void notify_key(const struct weston_key_event *event);

enum {
	aperture_max_text_bytes = 4096,
	aperture_control_buffer_size = aperture_max_text_bytes * 2 + 7,
	/* Larger selections reach watchers cut to this many bytes and marked truncated. */
	aperture_max_selection_bytes = 256 * 1024,
	/* A watcher this far behind is disconnected rather than buffered without bound. */
	aperture_max_watcher_backlog = 4 * 1024 * 1024,
	/* Pipes for the shell's own clipboard that no watcher took; the oldest is closed beyond this. */
	aperture_max_pending_sends = 16,
};

enum aperture_selection_kind {
	APERTURE_SELECTION_CLIPBOARD,
	APERTURE_SELECTION_PRIMARY,
	APERTURE_SELECTION_KIND_COUNT,
};

struct aperture_selection_read;
struct aperture_primary_source;

/* The text last read from one selection, as watchers see it, and the types its owner offers. */
struct aperture_selection_state {
	struct aperture_selection_read *read;
	char *text;
	size_t length;
	bool truncated;
	/* Newline-separated MIME types, or NULL when the selection is empty. */
	char *types;
};

/* A request for the shell's own clipboard data, waiting for a watcher to take its pipe. */
struct aperture_pending_send {
	struct wl_list link;
	uint64_t id;
	int fd;
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
	struct wl_list primary_devices;
	struct wl_list primary_sources;
	struct wl_event_source *control_source;
	struct wl_listener destroy_listener;
	struct wl_listener text_input_focus_listener;
	struct wl_listener primary_focus_listener;
	struct wl_listener selection_listener;
	struct wl_global *fractional_scale_global;
	struct wl_global *primary_selection_global;
	struct wl_global *text_input_global;
	struct wl_global *viewporter_global;
	struct aperture_text_input *active_text_input;
	struct aperture_primary_source *primary_source;
	struct aperture_selection_state selections[APERTURE_SELECTION_KIND_COUNT];
	struct wl_list pending_sends;
	uint64_t next_send_id;
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
	bool cursor_visible;
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
	/* A watcher stays connected and receives a line for every selection change. */
	bool watching;
	char *output;
	size_t output_length;
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
update_cursor_visibility(struct aperture_shell *shell)
{
	struct weston_output *output;

	weston_layer_set_position(&shell->compositor->cursor_layer,
				  shell->cursor_visible ?
				  WESTON_LAYER_POSITION_CURSOR :
				  WESTON_LAYER_POSITION_HIDDEN);
	wl_list_for_each(output, &shell->compositor->output_list, link)
		weston_output_schedule_repaint(output);
}

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
	struct weston_pointer_motion_event event;
	struct timespec time;

	if (!surface || !surface->capture_output)
		return "surface is unavailable";
	if (x < 0.0 || y < 0.0 || x > surface->width || y > surface->height)
		return "invalid motion coordinates";

	viewport_to_global(surface, x, y, &pos);
	now(&time);
	weston_pointer_motion_event_init(&event, &time, &shell->input_seat,
					 WESTON_POINTER_MOTION_ABS, &pos, NULL, NULL);
	notify_motion(&event);
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
		struct weston_pointer_axis_event event;

		weston_pointer_axis_event_init(&event, &time, &shell->input_seat,
					       WL_POINTER_AXIS_HORIZONTAL_SCROLL,
					       dx, false, 0);
		notify_axis(&event);
		shell->pointer_frame_pending = true;
	}
	if (dy != 0.0) {
		struct weston_pointer_axis_event event;

		weston_pointer_axis_event_init(&event, &time, &shell->input_seat,
					       WL_POINTER_AXIS_VERTICAL_SCROLL,
					       dy, false, 0);
		notify_axis(&event);
		shell->pointer_frame_pending = true;
	}
	return NULL;
}

static const char *
inject_key(struct aperture_shell *shell, struct aperture_shell_surface *surface,
	   uint32_t key, bool press)
{
	struct weston_key_event event;
	struct timespec time;

	if (!key)
		return "invalid key";
	if (!surface || !surface->capture_output)
		return "surface is unavailable";

	activate_surface_for_seat(surface, &shell->input_seat, WESTON_ACTIVATE_FLAG_NONE);
	now(&time);
	weston_key_event_init(&event, &time, &shell->input_seat, key,
			      press ? WL_KEYBOARD_KEY_STATE_PRESSED :
				      WL_KEYBOARD_KEY_STATE_RELEASED,
			      STATE_UPDATE_AUTOMATIC);
	notify_key(&event);
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
	struct aperture_output *previous = root->capture_output;

	/* Once the surface leaves, its previous output would repaint as bare background,
	 * and a recording still reading it until its replacement starts would record
	 * black. Forced off before the move, it keeps the last frame, which PipeWire
	 * consumers repeat. A failed switch binds the surface back to it. */
	if (previous && previous != capture)
		weston_output_power_off(previous->output);
	if (capture->output->power_state == WESTON_OUTPUT_POWER_FORCED_OFF)
		weston_output_power_on(capture->output);

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
	free(client->output);
	free(client);
}

static void
write_control_response(struct aperture_control_client *client, const char *response)
{
	ssize_t n = write(client->fd, response, strlen(response));
	(void)n;
}

/* Writes what the socket takes now and keeps the rest until it is writable again. Returns -1
 * once the watcher is gone or too far behind; the caller destroys it. */
static int
flush_watcher_output(struct aperture_control_client *client)
{
	while (client->output_length > 0) {
		ssize_t n = write(client->fd, client->output, client->output_length);

		if (n < 0) {
			if (errno == EINTR)
				continue;
			if (errno == EAGAIN || errno == EWOULDBLOCK)
				break;
			return -1;
		}
		memmove(client->output, client->output + n, client->output_length - (size_t)n);
		client->output_length -= (size_t)n;
	}
	wl_event_source_fd_update(client->source,
				  client->output_length > 0 ?
				  WL_EVENT_READABLE | WL_EVENT_WRITABLE :
				  WL_EVENT_READABLE);
	return 0;
}

static int
queue_watcher_output(struct aperture_control_client *client, const char *data, size_t length)
{
	char *output;

	if (client->output_length + length > aperture_max_watcher_backlog)
		return -1;
	output = realloc(client->output, client->output_length + length);
	if (!output)
		return -1;
	memcpy(output + client->output_length, data, length);
	client->output = output;
	client->output_length += length;
	return flush_watcher_output(client);
}

static const char *const aperture_selection_names[APERTURE_SELECTION_KIND_COUNT] = {
	[APERTURE_SELECTION_CLIPBOARD] = "clipboard",
	[APERTURE_SELECTION_PRIMARY] = "primary",
};

/* Writes data as lowercase hex, or "-" when it is empty; out needs 2 * length + 1 bytes. */
static size_t
append_hex(char *out, const char *data, size_t length)
{
	static const char digits[] = "0123456789abcdef";

	if (length == 0) {
		out[0] = '-';
		return 1;
	}
	for (size_t i = 0; i < length; i++) {
		unsigned char byte = (unsigned char)data[i];

		out[i * 2] = digits[byte >> 4];
		out[i * 2 + 1] = digits[byte & 0xf];
	}
	return length * 2;
}

/* Decodes lowercase hex, or "-" for empty, into a new NUL-terminated string. */
static char *
decode_hex(const char *hex, size_t *length)
{
	size_t hex_length = strlen(hex);
	char *out;

	if (strcmp(hex, "-") == 0)
		hex_length = 0;
	if (hex_length % 2 != 0)
		return NULL;
	out = malloc(hex_length / 2 + 1);
	if (!out)
		return NULL;
	for (size_t i = 0; i < hex_length / 2; i++) {
		int value = 0;

		for (int nibble = 0; nibble < 2; nibble++) {
			char c = hex[i * 2 + nibble];

			value <<= 4;
			if (c >= '0' && c <= '9')
				value |= c - '0';
			else if (c >= 'a' && c <= 'f')
				value |= c - 'a' + 10;
			else {
				free(out);
				return NULL;
			}
		}
		out[i] = (char)value;
	}
	out[hex_length / 2] = '\0';
	*length = hex_length / 2;
	return out;
}

/* "selection <kind> <truncated> <hex text> <hex newline-separated types>\n" */
static char *
format_selection_line(enum aperture_selection_kind kind,
		      const struct aperture_selection_state *state, size_t *length)
{
	size_t types_length = state->types ? strlen(state->types) : 0;
	size_t capacity = strlen("selection ") + strlen(aperture_selection_names[kind]) + 4 +
			  state->length * 2 + 2 + types_length * 2 + 2;
	char *line = malloc(capacity);
	size_t offset;

	if (!line)
		return NULL;
	offset = (size_t)snprintf(line, capacity, "selection %s %d ",
				  aperture_selection_names[kind], state->truncated ? 1 : 0);
	offset += append_hex(line + offset, state->text, state->length);
	line[offset++] = ' ';
	offset += append_hex(line + offset, state->types, types_length);
	line[offset++] = '\n';
	*length = offset;
	return line;
}

static int
send_selection_to_watcher(struct aperture_control_client *client,
			  enum aperture_selection_kind kind)
{
	size_t length;
	char *line = format_selection_line(kind, &client->shell->selections[kind], &length);
	int result = line ? queue_watcher_output(client, line, length) : -1;

	free(line);
	return result;
}

static void
publish_selection(struct aperture_shell *shell, enum aperture_selection_kind kind)
{
	struct aperture_control_client *client;
	struct aperture_control_client *next;

	wl_list_for_each_safe(client, next, &shell->control_clients, link) {
		if (client->watching && send_selection_to_watcher(client, kind) < 0)
			destroy_control_client(client);
	}
}

static void
set_selection_text(struct aperture_shell *shell, enum aperture_selection_kind kind,
		   char *text, size_t length, bool truncated)
{
	struct aperture_selection_state *state = &shell->selections[kind];

	free(state->text);
	state->text = text;
	state->length = length;
	state->truncated = truncated;
	publish_selection(shell, kind);
}

/* Reads the text a selection owner writes into a pipe, without blocking the compositor. */
struct aperture_selection_read {
	struct aperture_shell *shell;
	enum aperture_selection_kind kind;
	struct wl_event_source *source;
	int fd;
	char *data;
	size_t length;
};

static void
destroy_selection_read(struct aperture_selection_read *selection_read)
{
	struct aperture_selection_state *state =
		&selection_read->shell->selections[selection_read->kind];

	if (state->read == selection_read)
		state->read = NULL;
	wl_event_source_remove(selection_read->source);
	close(selection_read->fd);
	free(selection_read->data);
	free(selection_read);
}

static void
finish_selection_read(struct aperture_selection_read *selection_read, bool truncated)
{
	struct aperture_shell *shell = selection_read->shell;
	enum aperture_selection_kind kind = selection_read->kind;
	char *text = selection_read->data;
	size_t length = selection_read->length;

	selection_read->data = NULL;
	destroy_selection_read(selection_read);
	set_selection_text(shell, kind, text, length, truncated);
}

static int
dispatch_selection_read(int fd, uint32_t mask, void *data)
{
	struct aperture_selection_read *selection_read = data;

	for (;;) {
		char chunk[16384];
		ssize_t n = read(fd, chunk, sizeof chunk);
		size_t room;
		char *grown;

		if (n < 0) {
			if (errno == EINTR)
				continue;
			if (errno == EAGAIN || errno == EWOULDBLOCK)
				break;
			finish_selection_read(selection_read, false);
			return 0;
		}
		if (n == 0) {
			finish_selection_read(selection_read, false);
			return 0;
		}
		/* One byte past the limit tells a selection that is exactly the limit from a longer one. */
		room = aperture_max_selection_bytes + 1 - selection_read->length;
		if ((size_t)n > room)
			n = (ssize_t)room;
		grown = realloc(selection_read->data, selection_read->length + (size_t)n);
		if (!grown) {
			finish_selection_read(selection_read, false);
			return 0;
		}
		memcpy(grown + selection_read->length, chunk, (size_t)n);
		selection_read->data = grown;
		selection_read->length += (size_t)n;
		if (selection_read->length > aperture_max_selection_bytes) {
			selection_read->length = aperture_max_selection_bytes;
			finish_selection_read(selection_read, true);
			return 0;
		}
	}
	if (mask & (WL_EVENT_HANGUP | WL_EVENT_ERROR))
		finish_selection_read(selection_read, false);
	return 0;
}

static const char *
preferred_text_mime_type(const struct wl_array *mime_types)
{
	static const char *const preferred[] = {
		"text/plain;charset=utf-8",
		"UTF8_STRING",
		"text/plain",
		"STRING",
		"TEXT",
	};
	char *const *mime_type;

	for (size_t i = 0; i < sizeof preferred / sizeof preferred[0]; i++) {
		wl_array_for_each(mime_type, mime_types) {
			if (strcmp(*mime_type, preferred[i]) == 0)
				return *mime_type;
		}
	}
	return NULL;
}

/* MIME types are tokens; one with a newline could not be listed, so it is left out. */
static char *
join_mime_types(const struct wl_array *mime_types)
{
	char *const *mime_type;
	size_t length = 0;
	char *joined;

	wl_array_for_each(mime_type, mime_types)
		length += strlen(*mime_type) + 1;
	joined = calloc(1, length + 1);
	if (!joined)
		return NULL;
	wl_array_for_each(mime_type, mime_types) {
		if (strchr(*mime_type, '\n'))
			continue;
		if (joined[0])
			strcat(joined, "\n");
		strcat(joined, *mime_type);
	}
	return joined;
}

static bool
offers_mime_type(const struct wl_array *mime_types, const char *wanted)
{
	char *const *mime_type;

	wl_array_for_each(mime_type, mime_types) {
		if (strcmp(*mime_type, wanted) == 0)
			return true;
	}
	return false;
}

typedef void (*aperture_selection_send_fn)(void *owner, const char *mime_type, int fd);

/* Asks a selection owner for its text. send takes ownership of the write end. */
static void
read_selection(struct aperture_shell *shell, enum aperture_selection_kind kind,
	       const struct wl_array *mime_types, aperture_selection_send_fn send, void *owner)
{
	struct aperture_selection_state *state = &shell->selections[kind];
	struct aperture_selection_read *selection_read;
	const char *mime_type = mime_types ? preferred_text_mime_type(mime_types) : NULL;
	int fds[2];

	if (state->read)
		destroy_selection_read(state->read);
	free(state->types);
	state->types = mime_types ? join_mime_types(mime_types) : NULL;
	if (!mime_type) {
		set_selection_text(shell, kind, NULL, 0, false);
		return;
	}
	if (pipe2(fds, O_CLOEXEC) < 0) {
		weston_log("aperture-shell: selection pipe failed: %s\n", strerror(errno));
		return;
	}
	selection_read = calloc(1, sizeof *selection_read);
	if (!selection_read || set_nonblock_cloexec(fds[0]) < 0) {
		free(selection_read);
		close(fds[0]);
		close(fds[1]);
		return;
	}
	selection_read->shell = shell;
	selection_read->kind = kind;
	selection_read->fd = fds[0];
	selection_read->source = wl_event_loop_add_fd(
		wl_display_get_event_loop(shell->compositor->wl_display), fds[0],
		WL_EVENT_READABLE, dispatch_selection_read, selection_read);
	if (!selection_read->source) {
		free(selection_read);
		close(fds[0]);
		close(fds[1]);
		return;
	}
	state->read = selection_read;
	send(owner, mime_type, fds[1]);
}

static void
send_clipboard_source(void *owner, const char *mime_type, int fd)
{
	struct weston_data_source *source = owner;

	source->send(source, mime_type, fd);
}

static void
handle_selection(struct wl_listener *listener, void *data)
{
	struct aperture_shell *shell = wl_container_of(listener, shell, selection_listener);
	struct weston_data_source *source = shell->input_seat.selection_data_source;

	read_selection(shell, APERTURE_SELECTION_CLIPBOARD, source ? &source->mime_types : NULL,
		       send_clipboard_source, source);
}

/* Weston has no primary selection, so the shell implements zwp_primary_selection_v1 itself:
 * Chromium then fills it on every text selection, and middle-click pastes it. */
struct aperture_primary_source {
	struct wl_list link;
	struct aperture_shell *shell;
	struct wl_resource *resource;
	struct wl_array mime_types;
	/* Offers made for this source; they go inert once it is gone. */
	struct wl_list offers;
};

static void
primary_offer_receive(struct wl_client *client, struct wl_resource *resource,
		      const char *mime_type, int32_t fd)
{
	struct aperture_primary_source *source = wl_resource_get_user_data(resource);

	if (source)
		zwp_primary_selection_source_v1_send_send(source->resource, mime_type, fd);
	close(fd);
}

static void
primary_offer_destroy(struct wl_client *client, struct wl_resource *resource)
{
	wl_resource_destroy(resource);
}

static const struct zwp_primary_selection_offer_v1_interface primary_offer_interface = {
	.receive = primary_offer_receive,
	.destroy = primary_offer_destroy,
};

static void
destroy_primary_offer_resource(struct wl_resource *resource)
{
	wl_list_remove(wl_resource_get_link(resource));
}

static void
send_primary_selection(struct aperture_shell *shell, struct wl_resource *device)
{
	struct aperture_primary_source *source = shell->primary_source;
	struct wl_resource *offer;
	char **mime_type;

	if (!source) {
		zwp_primary_selection_device_v1_send_selection(device, NULL);
		return;
	}
	offer = wl_resource_create(wl_resource_get_client(device),
				   &zwp_primary_selection_offer_v1_interface,
				   wl_resource_get_version(device), 0);
	if (!offer) {
		wl_client_post_no_memory(wl_resource_get_client(device));
		return;
	}
	wl_resource_set_implementation(offer, &primary_offer_interface, source,
				       destroy_primary_offer_resource);
	wl_list_insert(&source->offers, wl_resource_get_link(offer));
	zwp_primary_selection_device_v1_send_data_offer(device, offer);
	wl_array_for_each(mime_type, &source->mime_types)
		zwp_primary_selection_offer_v1_send_offer(offer, *mime_type);
	zwp_primary_selection_device_v1_send_selection(device, offer);
}

/* Only the client with keyboard focus may see the selection. */
static void
send_primary_selection_to_focus(struct aperture_shell *shell)
{
	struct weston_keyboard *keyboard = weston_seat_get_keyboard(&shell->input_seat);
	struct wl_resource *device;
	struct wl_client *client;

	if (!keyboard || !keyboard->focus || !keyboard->focus->resource)
		return;
	client = wl_resource_get_client(keyboard->focus->resource);
	wl_resource_for_each(device, &shell->primary_devices) {
		if (wl_resource_get_client(device) == client)
			send_primary_selection(shell, device);
	}
}

static void
send_primary_source(void *owner, const char *mime_type, int fd)
{
	struct aperture_primary_source *source = owner;

	zwp_primary_selection_source_v1_send_send(source->resource, mime_type, fd);
	close(fd);
}

static void
set_primary_selection(struct aperture_shell *shell, struct aperture_primary_source *source)
{
	struct aperture_primary_source *previous = shell->primary_source;

	if (previous == source)
		return;
	shell->primary_source = source;
	if (previous)
		zwp_primary_selection_source_v1_send_cancelled(previous->resource);
	send_primary_selection_to_focus(shell);
	read_selection(shell, APERTURE_SELECTION_PRIMARY, source ? &source->mime_types : NULL,
		       send_primary_source, source);
}

static void
primary_source_offer(struct wl_client *client, struct wl_resource *resource,
		     const char *mime_type)
{
	struct aperture_primary_source *source = wl_resource_get_user_data(resource);
	char **slot = wl_array_add(&source->mime_types, sizeof *slot);

	if (!slot || !(*slot = strdup(mime_type))) {
		if (slot)
			source->mime_types.size -= sizeof *slot;
		wl_client_post_no_memory(client);
	}
}

static void
primary_source_destroy(struct wl_client *client, struct wl_resource *resource)
{
	wl_resource_destroy(resource);
}

static const struct zwp_primary_selection_source_v1_interface primary_source_interface = {
	.offer = primary_source_offer,
	.destroy = primary_source_destroy,
};

static void
destroy_primary_source_resource(struct wl_resource *resource)
{
	struct aperture_primary_source *source = wl_resource_get_user_data(resource);
	struct wl_resource *offer;
	struct wl_resource *next;
	char **mime_type;

	wl_resource_for_each_safe(offer, next, &source->offers) {
		wl_resource_set_user_data(offer, NULL);
		wl_list_remove(wl_resource_get_link(offer));
		wl_list_init(wl_resource_get_link(offer));
	}
	if (source->shell->primary_source == source) {
		source->shell->primary_source = NULL;
		send_primary_selection_to_focus(source->shell);
		read_selection(source->shell, APERTURE_SELECTION_PRIMARY, NULL, NULL, NULL);
	}
	wl_list_remove(&source->link);
	wl_array_for_each(mime_type, &source->mime_types)
		free(*mime_type);
	wl_array_release(&source->mime_types);
	free(source);
}

static void
primary_device_set_selection(struct wl_client *client, struct wl_resource *resource,
			     struct wl_resource *source_resource, uint32_t serial)
{
	struct aperture_shell *shell = wl_resource_get_user_data(resource);

	set_primary_selection(shell, source_resource ?
			      wl_resource_get_user_data(source_resource) : NULL);
}

static void
primary_device_destroy(struct wl_client *client, struct wl_resource *resource)
{
	wl_resource_destroy(resource);
}

static const struct zwp_primary_selection_device_v1_interface primary_device_interface = {
	.set_selection = primary_device_set_selection,
	.destroy = primary_device_destroy,
};

static void
destroy_primary_device_resource(struct wl_resource *resource)
{
	wl_list_remove(wl_resource_get_link(resource));
}

static void
primary_manager_create_source(struct wl_client *client, struct wl_resource *resource,
			      uint32_t id)
{
	struct aperture_primary_source *source = calloc(1, sizeof *source);

	if (!source) {
		wl_client_post_no_memory(client);
		return;
	}
	source->resource = wl_resource_create(client, &zwp_primary_selection_source_v1_interface,
					      wl_resource_get_version(resource), id);
	if (!source->resource) {
		free(source);
		wl_client_post_no_memory(client);
		return;
	}
	source->shell = wl_resource_get_user_data(resource);
	wl_list_insert(&source->shell->primary_sources, &source->link);
	wl_array_init(&source->mime_types);
	wl_list_init(&source->offers);
	wl_resource_set_implementation(source->resource, &primary_source_interface, source,
				       destroy_primary_source_resource);
}

static void
primary_manager_get_device(struct wl_client *client, struct wl_resource *resource,
			   uint32_t id, struct wl_resource *seat_resource)
{
	struct aperture_shell *shell = wl_resource_get_user_data(resource);
	struct weston_keyboard *keyboard;
	struct wl_resource *device;

	device = wl_resource_create(client, &zwp_primary_selection_device_v1_interface,
				    wl_resource_get_version(resource), id);
	if (!device) {
		wl_client_post_no_memory(client);
		return;
	}
	wl_resource_set_implementation(device, &primary_device_interface, shell,
				       destroy_primary_device_resource);
	wl_list_insert(&shell->primary_devices, wl_resource_get_link(device));

	keyboard = weston_seat_get_keyboard(&shell->input_seat);
	if (keyboard && keyboard->focus && keyboard->focus->resource &&
	    wl_resource_get_client(keyboard->focus->resource) == client)
		send_primary_selection(shell, device);
}

static void
primary_manager_destroy(struct wl_client *client, struct wl_resource *resource)
{
	wl_resource_destroy(resource);
}

static const struct zwp_primary_selection_device_manager_v1_interface
	primary_manager_interface = {
		.create_source = primary_manager_create_source,
		.get_device = primary_manager_get_device,
		.destroy = primary_manager_destroy,
	};

static void
bind_primary_selection_manager(struct wl_client *client, void *data, uint32_t version,
			       uint32_t id)
{
	struct wl_resource *resource;

	resource = wl_resource_create(client, &zwp_primary_selection_device_manager_v1_interface,
				      version, id);
	if (!resource) {
		wl_client_post_no_memory(client);
		return;
	}
	wl_resource_set_implementation(resource, &primary_manager_interface, data, NULL);
}

static void
handle_primary_focus(struct wl_listener *listener, void *data)
{
	struct aperture_shell *shell = wl_container_of(listener, shell, primary_focus_listener);

	send_primary_selection_to_focus(shell);
}

static int
create_primary_selection_manager(struct aperture_shell *shell)
{
	shell->primary_selection_global = wl_global_create(
		shell->compositor->wl_display, &zwp_primary_selection_device_manager_v1_interface,
		1, shell, bind_primary_selection_manager);
	return shell->primary_selection_global ? 0 : -1;
}

static bool
parse_selection_kind(const char *name, enum aperture_selection_kind *kind)
{
	for (int candidate = 0; candidate < APERTURE_SELECTION_KIND_COUNT; candidate++) {
		if (strcmp(name, aperture_selection_names[candidate]) == 0) {
			*kind = (enum aperture_selection_kind)candidate;
			return true;
		}
	}
	return false;
}

/* Answers a control command with a file descriptor alongside the response line. */
static void
write_control_response_fd(struct aperture_control_client *client, const char *response, int fd)
{
	char control[CMSG_SPACE(sizeof fd)];
	struct iovec iov = { .iov_base = (void *)response, .iov_len = strlen(response) };
	struct msghdr message = {
		.msg_iov = &iov,
		.msg_iovlen = 1,
		.msg_control = control,
		.msg_controllen = sizeof control,
	};
	struct cmsghdr *header;

	memset(control, 0, sizeof control);
	header = CMSG_FIRSTHDR(&message);
	header->cmsg_level = SOL_SOCKET;
	header->cmsg_type = SCM_RIGHTS;
	header->cmsg_len = CMSG_LEN(sizeof fd);
	memcpy(CMSG_DATA(header), &fd, sizeof fd);
	if (sendmsg(client->fd, &message, MSG_NOSIGNAL) < 0)
		weston_log("aperture-shell: send control fd failed: %s\n", strerror(errno));
}

/* The shell's own clipboard, set when the web client pastes. The data stays with the watcher that
 * set it: every request for it is handed over as a pipe for that watcher to fill. */
struct aperture_owned_source {
	struct weston_data_source base;
	struct aperture_shell *shell;
};

static void
destroy_pending_send(struct aperture_pending_send *pending)
{
	wl_list_remove(&pending->link);
	close(pending->fd);
	free(pending);
}

static void
owned_source_accept(struct weston_data_source *source, uint32_t serial, const char *mime_type)
{
}

static void
owned_source_send(struct weston_data_source *base, const char *mime_type, int32_t fd)
{
	struct aperture_owned_source *source = wl_container_of(base, source, base);
	struct aperture_shell *shell = source->shell;
	struct aperture_control_client *client;
	struct aperture_control_client *next;
	struct aperture_pending_send *pending;
	struct aperture_pending_send *added;
	size_t mime_length = strlen(mime_type);
	size_t capacity = 32 + mime_length * 2;
	char *line = malloc(capacity);
	bool delivered = false;
	size_t length;

	pending = calloc(1, sizeof *pending);
	if (!pending || !line) {
		free(pending);
		free(line);
		close(fd);
		return;
	}
	pending->id = ++shell->next_send_id;
	pending->fd = fd;
	wl_list_insert(shell->pending_sends.prev, &pending->link);
	added = pending;
	if (wl_list_length(&shell->pending_sends) > aperture_max_pending_sends)
		destroy_pending_send(wl_container_of(shell->pending_sends.next, pending, link));

	length = (size_t)snprintf(line, capacity, "send %llu ", (unsigned long long)pending->id);
	length += append_hex(line + length, mime_type, mime_length);
	line[length++] = '\n';
	wl_list_for_each_safe(client, next, &shell->control_clients, link) {
		if (!client->watching)
			continue;
		if (queue_watcher_output(client, line, length) < 0)
			destroy_control_client(client);
		else
			delivered = true;
	}
	free(line);
	if (!delivered)
		destroy_pending_send(added);
}

static void
destroy_owned_source(void *data)
{
	struct aperture_owned_source *source = data;
	char **mime_type;

	/* Offers made for this source drop it now. */
	wl_signal_emit(&source->base.destroy_signal, &source->base);
	wl_array_for_each(mime_type, &source->base.mime_types)
		free(*mime_type);
	wl_array_release(&source->base.mime_types);
	free(source);
}

/* Weston cancels a replaced selection before it stops listening for that source's destruction,
 * so the source is destroyed once the replacement is done. */
static void
owned_source_cancel(struct weston_data_source *base)
{
	struct aperture_owned_source *source = wl_container_of(base, source, base);

	if (!wl_event_loop_add_idle(wl_display_get_event_loop(source->shell->compositor->wl_display),
				    destroy_owned_source, source))
		weston_log("aperture-shell: could not schedule clipboard source cleanup\n");
}

/* encoded is the hex of newline-separated MIME types the watcher will provide. */
static const char *
set_owned_clipboard(struct aperture_shell *shell, const char *encoded)
{
	struct aperture_owned_source *source;
	size_t length;
	char *types = decode_hex(encoded, &length);
	char *type;
	char *rest;

	if (!types || length == 0) {
		free(types);
		return "invalid types";
	}
	source = calloc(1, sizeof *source);
	if (!source) {
		free(types);
		return "out of memory";
	}
	source->shell = shell;
	wl_signal_init(&source->base.destroy_signal);
	wl_array_init(&source->base.mime_types);
	source->base.accept = owned_source_accept;
	source->base.send = owned_source_send;
	source->base.cancel = owned_source_cancel;
	for (type = strtok_r(types, "\n", &rest); type; type = strtok_r(NULL, "\n", &rest)) {
		char **slot;

		for (const char *c = type; *c; c++) {
			if ((unsigned char)*c < 0x20 || *c == 0x7f) {
				free(types);
				destroy_owned_source(source);
				return "invalid types";
			}
		}
		slot = wl_array_add(&source->base.mime_types, sizeof *slot);
		if (!slot || !(*slot = strdup(type))) {
			if (slot)
				source->base.mime_types.size -= sizeof *slot;
			free(types);
			destroy_owned_source(source);
			return "out of memory";
		}
	}
	free(types);
	weston_seat_set_selection(&shell->input_seat, &source->base,
				  wl_display_next_serial(shell->compositor->wl_display));
	return NULL;
}

/* Asks a selection's owner for one type of its data and returns the pipe it writes into. */
static const char *
open_selection(struct aperture_shell *shell, enum aperture_selection_kind kind,
	       const char *mime_type, int *read_fd)
{
	struct weston_data_source *clipboard = shell->input_seat.selection_data_source;
	struct aperture_primary_source *primary = shell->primary_source;
	int fds[2];

	if (kind == APERTURE_SELECTION_CLIPBOARD &&
	    (!clipboard || !offers_mime_type(&clipboard->mime_types, mime_type)))
		return "type is not offered";
	if (kind == APERTURE_SELECTION_PRIMARY &&
	    (!primary || !offers_mime_type(&primary->mime_types, mime_type)))
		return "type is not offered";
	if (pipe2(fds, O_CLOEXEC) < 0)
		return "pipe failed";
	if (kind == APERTURE_SELECTION_CLIPBOARD)
		clipboard->send(clipboard, mime_type, fds[1]);
	else
		send_primary_source(primary, mime_type, fds[1]);
	*read_fd = fds[0];
	return NULL;
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

	if (strcmp(client->buffer, "selection-watch") == 0) {
		write_control_response(client, "ok\n");
		client->watching = true;
		for (int kind = 0; kind < APERTURE_SELECTION_KIND_COUNT; kind++) {
			if (send_selection_to_watcher(client, (enum aperture_selection_kind)kind) < 0) {
				client->watching = false;
				return;
			}
		}
		return;
	}

	if (strncmp(client->buffer, "selection-set clipboard ", 24) == 0) {
		error = set_owned_clipboard(client->shell, client->buffer + 24);
		if (error) {
			snprintf(response, sizeof response, "error %s\n", error);
			write_control_response(client, response);
			return;
		}
		write_control_response(client, "ok\n");
		return;
	}

	text_offset = 0;
	if (sscanf(client->buffer, "selection-read %128s %n", identifier, &text_offset) == 1 &&
	    text_offset > 0) {
		enum aperture_selection_kind kind;
		size_t mime_length;
		char *mime_type = decode_hex(client->buffer + text_offset, &mime_length);
		int read_fd = -1;

		if (!parse_selection_kind(identifier, &kind) || !mime_type || mime_length == 0)
			error = "invalid selection request";
		else
			error = open_selection(client->shell, kind, mime_type, &read_fd);
		free(mime_type);
		if (error) {
			snprintf(response, sizeof response, "error %s\n", error);
			write_control_response(client, response);
			return;
		}
		write_control_response_fd(client, "ok\n", read_fd);
		close(read_fd);
		return;
	}

	if (sscanf(client->buffer, "selection-take %llu %c", &surface_id, &trailing) == 1) {
		struct aperture_pending_send *pending;

		wl_list_for_each(pending, &client->shell->pending_sends, link) {
			if (pending->id == (uint64_t)surface_id) {
				write_control_response_fd(client, "ok\n", pending->fd);
				destroy_pending_send(pending);
				return;
			}
		}
		write_control_response(client, "error request is gone\n");
		return;
	}

	if (strcmp(client->buffer, "cursor-status") == 0) {
		snprintf(response, sizeof response, "ok %u\n",
			 client->shell->cursor_visible ? 1 : 0);
		write_control_response(client, response);
		return;
	}

	if (sscanf(client->buffer, "cursor-visible %u %c", &pressed, &trailing) == 1) {
		if (pressed > 1) {
			write_control_response(client, "error invalid cursor visibility\n");
			return;
		}
		client->shell->cursor_visible = pressed != 0;
		update_cursor_visibility(client->shell);
		snprintf(response, sizeof response, "ok %u\n", pressed);
		write_control_response(client, response);
		return;
	}

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

	if (client->watching) {
		char discard[256];

		if ((mask & WL_EVENT_WRITABLE) && flush_watcher_output(client) < 0) {
			destroy_control_client(client);
			return 0;
		}
		/* A watcher sends nothing after its command; reading only notices it leaving. */
		if (mask & WL_EVENT_READABLE) {
			n = read(fd, discard, sizeof discard);
			if (n == 0 || (n < 0 && errno != EAGAIN && errno != EWOULDBLOCK &&
				       errno != EINTR))
				destroy_control_client(client);
		}
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
	if (!client->watching)
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
	struct aperture_primary_source *primary_source;
	struct aperture_primary_source *next_primary_source;
	struct wl_resource *primary_device;
	struct wl_resource *next_primary_device;
	struct aperture_pending_send *pending_send;
	struct aperture_pending_send *next_pending_send;

	wl_list_remove(&shell->destroy_listener.link);
	wl_list_remove(&shell->text_input_focus_listener.link);
	wl_list_remove(&shell->primary_focus_listener.link);
	wl_list_remove(&shell->selection_listener.link);
	if (shell->control_source)
		wl_event_source_remove(shell->control_source);
	if (shell->fractional_scale_global)
		wl_global_destroy(shell->fractional_scale_global);
	if (shell->primary_selection_global)
		wl_global_destroy(shell->primary_selection_global);
	/* Their destructors use the shell, and clients outlive it. */
	wl_list_for_each_safe(primary_source, next_primary_source, &shell->primary_sources, link)
		wl_resource_destroy(primary_source->resource);
	wl_resource_for_each_safe(primary_device, next_primary_device, &shell->primary_devices)
		wl_resource_destroy(primary_device);
	wl_list_for_each_safe(pending_send, next_pending_send, &shell->pending_sends, link)
		destroy_pending_send(pending_send);
	for (int kind = 0; kind < APERTURE_SELECTION_KIND_COUNT; kind++) {
		if (shell->selections[kind].read)
			destroy_selection_read(shell->selections[kind].read);
		free(shell->selections[kind].text);
		free(shell->selections[kind].types);
	}
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

	/* Clipboard pipes and control sockets close whenever their reader stops early, such as Weston's
	 * clipboard manager serving a selection the shell stopped reading. A write then must fail
	 * with EPIPE, which every writer here handles, instead of killing the compositor. */
	signal(SIGPIPE, SIG_IGN);

	shell->compositor = compositor;
	shell->control_fd = -1;
	shell->width = parse_positive_env("APERTURE_VIEWPORT_WIDTH", 1280);
	shell->height = parse_positive_env("APERTURE_VIEWPORT_HEIGHT", 720);
	shell->scale_numerator = aperture_scale_denominator;
	shell->cursor_visible = true;
	wl_list_init(&shell->surfaces);
	wl_list_init(&shell->outputs);
	wl_list_init(&shell->control_clients);
	wl_list_init(&shell->fractional_scales);
	wl_list_init(&shell->text_inputs);
	wl_list_init(&shell->text_input_focus_listener.link);
	wl_list_init(&shell->primary_devices);
	wl_list_init(&shell->primary_sources);
	wl_list_init(&shell->pending_sends);
	wl_list_init(&shell->primary_focus_listener.link);
	wl_list_init(&shell->selection_listener.link);
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
	shell->primary_focus_listener.notify = handle_primary_focus;
	wl_signal_add(&weston_seat_get_keyboard(&shell->input_seat)->focus_signal,
		      &shell->primary_focus_listener);
	shell->selection_listener.notify = handle_selection;
	wl_signal_add(&shell->input_seat.selection_signal, &shell->selection_listener);

	if (create_background(shell) < 0)
		goto err;
	if (create_fractional_scale_manager(shell) < 0)
		goto err;
	if (create_viewporter(shell) < 0)
		goto err;
	if (create_text_input_manager(shell) < 0)
		goto err;
	if (create_primary_selection_manager(shell) < 0)
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
