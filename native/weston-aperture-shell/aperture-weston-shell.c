#include <linux/input-event-codes.h>
#include <errno.h>
#include <fcntl.h>
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
	struct wl_list control_clients;
	struct wl_list fractional_scales;
	struct wl_list text_inputs;
	struct wl_event_source *control_source;
	struct wl_event_source *resize_timer;
	struct wl_listener destroy_listener;
	struct wl_listener text_input_focus_listener;
	struct wl_global *cursor_shape_global;
	struct wl_global *fractional_scale_global;
	struct wl_global *text_input_global;
	struct wl_global *viewporter_global;
	struct aperture_text_input *active_text_input;
	char *control_socket_path;
	int control_fd;
	uint32_t width;
	uint32_t height;
	uint32_t scale_numerator;
	uint32_t pending_width;
	uint32_t pending_height;
	uint32_t pending_scale_numerator;
	bool resize_scheduled;
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
	bool fit_transform_added;
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
static const int aperture_resize_coalesce_ms = 16;

static int
create_background(struct aperture_shell *shell);

static int
background_get_label(struct weston_surface *surface, char *buf, size_t len)
{
	return snprintf(buf, len, "aperture background");
}

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
	wp_fractional_scale_v1_send_preferred_scale(scale->resource,
						    scale->shell->scale_numerator);
}

static void
send_fractional_scale_all(struct aperture_shell *shell)
{
	struct aperture_fractional_scale *scale;

	wl_list_for_each(scale, &shell->fractional_scales, link)
		send_fractional_scale(scale);
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

static const char *
resize_output(struct aperture_shell *shell, uint32_t width, uint32_t height,
	      uint32_t scale_numerator)
{
	struct weston_output *output = default_output(shell);
	struct weston_mode mode;
	uint32_t physical_width = scaled_dimension(width, scale_numerator);
	uint32_t physical_height = scaled_dimension(height, scale_numerator);
	int32_t output_scale = 1;

	if (!output || !output->current_mode)
		return "output is unavailable";
	if (physical_width < aperture_min_dimension || physical_height < aperture_min_dimension ||
	    physical_width > aperture_max_dimension || physical_height > aperture_max_dimension)
		return "invalid physical dimensions";
	if (output->current_mode->width == (int32_t)physical_width &&
	    output->current_mode->height == (int32_t)physical_height &&
	    output->current_scale == output_scale)
		return NULL;

	mode = *output->current_mode;
	mode.width = (int32_t)physical_width;
	mode.height = (int32_t)physical_height;
	if (weston_output_mode_set_native(output, &mode, output_scale) < 0)
		return "output resize failed";

	if (shell->background) {
		weston_shell_utils_curtain_destroy(shell->background);
		shell->background = NULL;
		if (create_background(shell) < 0)
			return "background resize failed";
	}
	return NULL;
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
	struct weston_output *output = default_output(shell);
	struct weston_geometry geometry;
	struct weston_size min_size;
	uint32_t configure_width = width;
	uint32_t configure_height = height;
	float scale;
	float x = 0.0f;
	float y = 0.0f;
	struct weston_coord_global origin = {
		.c = weston_coord(0, 0),
	};

	if (!output || !surface || !surface->view)
		return;

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

	scale = 1.0f;
	if (width > 0 && height > 0) {
		float scale_x = (float)output->width / (float)width;
		float scale_y = (float)output->height / (float)height;

		scale = scale_x < scale_y ? scale_x : scale_y;
		x = ((float)output->width - (float)width * scale) / 2.0f;
		y = ((float)output->height - (float)height * scale) / 2.0f;
	}
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
	origin.c = weston_coord(x, y);
	weston_view_set_position_with_offset(surface->view, origin,
					     weston_coord_surface_invert(
						     weston_coord_surface(geometry.x, geometry.y,
									   surface->view->surface)));
	weston_view_move_to_layer(surface->view, &shell->normal_layer.view_list);
	weston_view_schedule_repaint(surface->view);
}

static void
layout_all_surfaces(struct aperture_shell *shell)
{
	struct aperture_shell_surface *surface;

	wl_list_for_each(surface, &shell->surfaces, link)
		layout_surface(shell, surface, shell->width, shell->height);
}

static void
resolve_viewport_size(struct aperture_shell *shell, uint32_t *width, uint32_t *height)
{
	struct aperture_shell_surface *surface;

	if (*width < aperture_min_configure_width)
		*width = aperture_min_configure_width;

	wl_list_for_each(surface, &shell->surfaces, link) {
		struct weston_size min_size =
			weston_desktop_surface_get_min_size(surface->desktop_surface);

		if (min_size.width > 0 && (uint32_t)min_size.width > *width)
			*width = (uint32_t)min_size.width;
		if (min_size.height > 0 && (uint32_t)min_size.height > *height)
			*height = (uint32_t)min_size.height;
	}
}

static void
apply_viewport_size(struct aperture_shell *shell, uint32_t width, uint32_t height,
		    uint32_t scale_numerator)
{
	const char *error;
	uint32_t physical_width = scaled_dimension(width, scale_numerator);
	uint32_t physical_height = scaled_dimension(height, scale_numerator);
	int32_t output_scale = 1;

	if (shell->width == width && shell->height == height &&
	    shell->scale_numerator == scale_numerator)
		return;

	error = resize_output(shell, width, height, scale_numerator);
	if (error) {
		weston_log("aperture-shell: resize output failed: %s\n", error);
		return;
	}

	shell->width = width;
	shell->height = height;
	shell->scale_numerator = scale_numerator;
	send_fractional_scale_all(shell);
	layout_all_surfaces(shell);
	weston_log("aperture-shell: resized viewport to %ux%u @ %u/120 (%ux%u physical, wl_output scale %d)\n",
		   width, height, scale_numerator, physical_width, physical_height,
		   output_scale);
}

static int
dispatch_resize_timer(void *data)
{
	struct aperture_shell *shell = data;

	shell->resize_scheduled = false;
	apply_viewport_size(shell, shell->pending_width, shell->pending_height,
			    shell->pending_scale_numerator);
	return 0;
}

static const char *
queue_viewport_resize(struct aperture_shell *shell, uint32_t width, uint32_t height,
		      uint32_t scale_numerator)
{
	uint32_t physical_width;
	uint32_t physical_height;

	if (width < aperture_min_dimension || height < aperture_min_dimension ||
	    width > aperture_max_dimension || height > aperture_max_dimension)
		return "invalid dimensions";
	if (scale_numerator < aperture_min_scale_numerator ||
	    scale_numerator > aperture_max_scale_numerator)
		return "invalid scale";

	if (!shell->resize_timer)
		return "resize timer is unavailable";

	resolve_viewport_size(shell, &width, &height);
	physical_width = scaled_dimension(width, scale_numerator);
	physical_height = scaled_dimension(height, scale_numerator);
	if (physical_width < aperture_min_dimension || physical_height < aperture_min_dimension ||
	    physical_width > aperture_max_dimension || physical_height > aperture_max_dimension)
		return "invalid physical dimensions";
	if (!shell->resize_scheduled && shell->width == width && shell->height == height &&
	    shell->scale_numerator == scale_numerator)
		return NULL;
	if (shell->resize_scheduled && shell->pending_width == width &&
	    shell->pending_height == height && shell->pending_scale_numerator == scale_numerator)
		return NULL;

	shell->pending_width = width;
	shell->pending_height = height;
	shell->pending_scale_numerator = scale_numerator;
	if (shell->resize_scheduled)
		return NULL;

	shell->resize_scheduled = true;
	if (wl_event_source_timer_update(shell->resize_timer, aperture_resize_coalesce_ms) < 0) {
		shell->resize_scheduled = false;
		return "schedule resize failed";
	}
	return NULL;
}

static struct aperture_shell_surface *
first_shell_surface(struct aperture_shell *shell)
{
	struct aperture_shell_surface *surface;

	wl_list_for_each(surface, &shell->surfaces, link)
		return surface;

	return NULL;
}

static void
now(struct timespec *time)
{
	clock_gettime(CLOCK_MONOTONIC, time);
}

static void
viewport_to_global(struct aperture_shell *shell, double x, double y,
		   struct weston_coord_global *pos)
{
	struct weston_output *output = default_output(shell);
	float scale = 1.0f;
	float offset_x = 0.0f;
	float offset_y = 0.0f;

	if (output && shell->width > 0 && shell->height > 0) {
		float scale_x = (float)output->width / (float)shell->width;
		float scale_y = (float)output->height / (float)shell->height;

		scale = scale_x < scale_y ? scale_x : scale_y;
		offset_x = ((float)output->width - (float)shell->width * scale) / 2.0f;
		offset_y = ((float)output->height - (float)shell->height * scale) / 2.0f;
	}

	pos->c = weston_coord(offset_x + x * scale, offset_y + y * scale);
}

static const char *
inject_pointer_motion(struct aperture_shell *shell, double x, double y)
{
	struct weston_coord_global pos;
	struct timespec time;

	if (x < 0.0 || y < 0.0 || x > shell->width || y > shell->height)
		return "invalid motion coordinates";

	viewport_to_global(shell, x, y, &pos);
	now(&time);
	notify_motion_absolute(&shell->input_seat, &time, pos);
	weston_seat_repick(&shell->input_seat);
	shell->pointer_frame_pending = true;
	return NULL;
}

static const char *
inject_button(struct aperture_shell *shell, uint32_t button, bool press)
{
	struct weston_pointer *pointer = weston_seat_get_pointer(&shell->input_seat);
	struct timespec time;
	enum wl_pointer_button_state state =
		press ? WL_POINTER_BUTTON_STATE_PRESSED : WL_POINTER_BUTTON_STATE_RELEASED;

	if (!button)
		return "invalid button";
	if (!pointer || !pointer->grab || !pointer->grab->interface)
		return "pointer is not ready";
	if (!press && pointer->button_count == 0)
		return NULL;

	now(&time);
	weston_seat_repick(&shell->input_seat);
	if (press) {
		struct aperture_shell_surface *surface = first_shell_surface(shell);

		if (surface)
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
	pointer->grab->interface->button(pointer->grab, &time, button, state);
	if (pointer->button_count == 1)
		pointer->grab_serial = wl_display_get_serial(shell->compositor->wl_display);
	shell->pointer_frame_pending = true;
	return NULL;
}

static const char *
inject_axis(struct aperture_shell *shell, double dx, double dy)
{
	struct timespec time;

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
inject_key(struct aperture_shell *shell, uint32_t key, bool press)
{
	struct timespec time;

	if (!key)
		return "invalid key";

	now(&time);
	notify_key(&shell->input_seat, &time, key,
		   press ? WL_KEYBOARD_KEY_STATE_PRESSED : WL_KEYBOARD_KEY_STATE_RELEASED,
		   STATE_UPDATE_AUTOMATIC);
	return NULL;
}

static const char *
inject_text(struct aperture_shell *shell, const char *encoded)
{
	struct aperture_text_input *input = shell->active_text_input;
	struct weston_keyboard *keyboard = weston_seat_get_keyboard(&shell->input_seat);
	size_t encoded_length = strlen(encoded);
	size_t text_length;
	char text[aperture_max_text_bytes + 1];
	size_t i;

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
	struct aperture_shell_surface *surface = calloc(1, sizeof *surface);

	if (!surface)
		return;

	surface->desktop_surface = desktop_surface;
	surface->view = weston_desktop_surface_create_view(desktop_surface);
	if (!surface->view) {
		free(surface);
		return;
	}
	wl_list_init(&surface->fit_transform.link);

	wl_list_insert(&((struct aperture_shell *)data)->surfaces, &surface->link);
	weston_desktop_surface_set_user_data(desktop_surface, surface);
}

static void
desktop_surface_removed(struct weston_desktop_surface *desktop_surface, void *data)
{
	struct aperture_shell_surface *surface =
		weston_desktop_surface_get_user_data(desktop_surface);

	if (!surface)
		return;

	weston_desktop_surface_set_user_data(desktop_surface, NULL);
	wl_list_remove(&surface->link);
	if (surface->fit_transform_added)
		weston_view_remove_transform(surface->view, &surface->fit_transform);
	weston_desktop_surface_unlink_view(surface->view);
	weston_view_destroy(surface->view);
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

	if (weston_surface_is_mapped(weston_surface)) {
		layout_surface(shell, surface, shell->width, shell->height);
		return;
	}

	weston_surface_map(weston_surface);
	layout_surface(shell, surface, shell->width, shell->height);
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
desktop_surface_fullscreen_requested(struct weston_desktop_surface *desktop_surface,
				     bool fullscreen, struct weston_output *output, void *data)
{
	struct aperture_shell_surface *surface =
		weston_desktop_surface_get_user_data(desktop_surface);

	if (surface)
		layout_surface(data, surface, ((struct aperture_shell *)data)->width,
			       ((struct aperture_shell *)data)->height);
}

static void
desktop_surface_maximized_requested(struct weston_desktop_surface *desktop_surface,
				    bool maximized, void *data)
{
	struct aperture_shell_surface *surface =
		weston_desktop_surface_get_user_data(desktop_surface);

	if (surface)
		layout_surface(data, surface, ((struct aperture_shell *)data)->width,
			       ((struct aperture_shell *)data)->height);
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
		.get_label = background_get_label,
		.surface_private = NULL,
	};

	shell->background = weston_shell_utils_curtain_create(shell->compositor, &params);
	if (!shell->background)
		return -1;

	weston_view_move_to_layer(shell->background->view, &shell->background_layer.view_list);
	return 0;
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
	double x;
	double y;
	double dx;
	double dy;
	uint32_t applied_width;
	uint32_t applied_height;
	uint32_t applied_scale_numerator;
	uint32_t physical_width;
	uint32_t physical_height;
	char trailing;
	const char *error;
	char response[128];

	if (sscanf(client->buffer, "resize %u %u %u %c", &width, &height,
		   &scale_numerator, &trailing) == 3 ||
	    sscanf(client->buffer, "resize %u %u %c", &width, &height, &trailing) == 2) {
		applied_width = width;
		applied_height = height;
		applied_scale_numerator =
			scale_numerator ? scale_numerator : client->shell->scale_numerator;
		resolve_viewport_size(client->shell, &applied_width, &applied_height);
		error = queue_viewport_resize(client->shell, applied_width, applied_height,
					      applied_scale_numerator);
		if (error) {
			snprintf(response, sizeof response, "error %s\n", error);
			write_control_response(client, response);
			return;
		}

		physical_width = scaled_dimension(applied_width, applied_scale_numerator);
		physical_height = scaled_dimension(applied_height, applied_scale_numerator);
		snprintf(response, sizeof response, "ok %u %u %u %u %u\n", applied_width,
			 applied_height, applied_scale_numerator, physical_width, physical_height);
		write_control_response(client, response);
		return;
	}

	if (sscanf(client->buffer, "motion %lf %lf %c", &x, &y, &trailing) == 2) {
		error = inject_pointer_motion(client->shell, x, y);
		if (error) {
			snprintf(response, sizeof response, "error %s\n", error);
			write_control_response(client, response);
			return;
		}
		flush_pointer_frame(client->shell);
		write_control_response(client, "ok\n");
		return;
	}

	if (sscanf(client->buffer, "button %u %u %c", &code, &pressed, &trailing) == 2) {
		error = inject_button(client->shell, code, pressed != 0);
		if (error) {
			snprintf(response, sizeof response, "error %s\n", error);
			write_control_response(client, response);
			return;
		}
		flush_pointer_frame(client->shell);
		write_control_response(client, "ok\n");
		return;
	}

	if (sscanf(client->buffer, "axis %lf %lf %c", &dx, &dy, &trailing) == 2) {
		error = inject_axis(client->shell, dx, dy);
		if (error) {
			snprintf(response, sizeof response, "error %s\n", error);
			write_control_response(client, response);
			return;
		}
		flush_pointer_frame(client->shell);
		write_control_response(client, "ok\n");
		return;
	}

	if (sscanf(client->buffer, "key %u %u %c", &code, &pressed, &trailing) == 2) {
		error = inject_key(client->shell, code, pressed != 0);
		if (error) {
			snprintf(response, sizeof response, "error %s\n", error);
			write_control_response(client, response);
			return;
		}
		write_control_response(client, "ok\n");
		return;
	}

	if (strncmp(client->buffer, "text ", 5) == 0) {
		error = inject_text(client->shell, client->buffer + 5);
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

	wl_list_remove(&shell->destroy_listener.link);
	wl_list_remove(&shell->text_input_focus_listener.link);
	if (shell->control_source)
		wl_event_source_remove(shell->control_source);
	if (shell->resize_timer)
		wl_event_source_remove(shell->resize_timer);
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
	if (shell->background)
		weston_shell_utils_curtain_destroy(shell->background);
	if (shell->control_fd >= 0)
		close(shell->control_fd);
	if (shell->control_socket_path) {
		unlink(shell->control_socket_path);
		free(shell->control_socket_path);
	}
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
	shell->pending_width = shell->width;
	shell->pending_height = shell->height;
	shell->pending_scale_numerator = shell->scale_numerator;
	wl_list_init(&shell->surfaces);
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
	shell->resize_timer =
		wl_event_loop_add_timer(wl_display_get_event_loop(compositor->wl_display),
					dispatch_resize_timer, shell);
	if (!shell->resize_timer)
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
