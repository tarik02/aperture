#define _GNU_SOURCE

#include <drm_fourcc.h>
#include <errno.h>
#include <stdio.h>
#include <jpeglib.h>
#include <pixman.h>
#include <poll.h>
#include <setjmp.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <time.h>
#include <unistd.h>
#include <wayland-client.h>

#include "weston-output-capture-client-protocol.h"

#define CAPTURE_SHM_LIMIT ((size_t)128 * 1024 * 1024)
#define CAPTURE_TIMEOUT_MS 4000
/* Must match aperture_capture_attempt_limit in the shell. */
#define CAPTURE_ATTEMPTS 3

struct capture_output {
	struct capture_output *next;
	struct wl_output *output;
	char *name;
};

struct capture_app {
	struct wl_display *display;
	struct wl_registry *registry;
	struct wl_shm *shm;
	struct weston_capture_v1 *capture;
	struct capture_output *outputs;
	struct timespec deadline;
};

struct capture_source {
	struct weston_capture_source_v1 *source;
	int32_t width;
	int32_t height;
	uint32_t formats[16];
	size_t format_count;
	bool formats_done;
	bool size_received;
	bool complete;
	bool retry;
	bool failed;
	char failure[256];
};

struct capture_buffer {
	struct wl_buffer *buffer;
	void *data;
	size_t size;
	int32_t width;
	int32_t height;
	int32_t stride;
	pixman_format_code_t pixman_format;
};

struct jpeg_error {
	struct jpeg_error_mgr manager;
	jmp_buf jump;
	char message[JMSG_LENGTH_MAX];
};

static void
output_geometry(void *data, struct wl_output *output, int32_t x, int32_t y,
		int32_t physical_width, int32_t physical_height, int32_t subpixel,
		const char *make, const char *model, int32_t transform)
{
}

static void
output_mode(void *data, struct wl_output *output, uint32_t flags, int32_t width,
	    int32_t height, int32_t refresh)
{
}

static void
output_done(void *data, struct wl_output *output)
{
}

static void
output_scale(void *data, struct wl_output *output, int32_t factor)
{
}

static void
output_name(void *data, struct wl_output *output, const char *name)
{
	struct capture_output *capture_output = data;
	char *copy;

	copy = strdup(name);
	if (!copy)
		return;
	free(capture_output->name);
	capture_output->name = copy;
}

static void
output_description(void *data, struct wl_output *output, const char *description)
{
}

static const struct wl_output_listener output_listener = {
	.geometry = output_geometry,
	.mode = output_mode,
	.done = output_done,
	.scale = output_scale,
	.name = output_name,
	.description = output_description,
};

static void
registry_global(void *data, struct wl_registry *registry, uint32_t name,
		const char *interface, uint32_t version)
{
	struct capture_app *app = data;

	if (strcmp(interface, wl_output_interface.name) == 0) {
		struct capture_output *output;

		if (version < 4)
			return;
		output = calloc(1, sizeof *output);
		if (!output)
			return;
		output->output = wl_registry_bind(registry, name, &wl_output_interface, 4);
		if (!output->output) {
			free(output);
			return;
		}
		wl_output_add_listener(output->output, &output_listener, output);
		output->next = app->outputs;
		app->outputs = output;
	} else if (strcmp(interface, wl_shm_interface.name) == 0) {
		app->shm = wl_registry_bind(registry, name, &wl_shm_interface, 1);
	} else if (strcmp(interface, weston_capture_v1_interface.name) == 0) {
		/* Version 2 adds formats_done, which delimits replaced format lists. */
		if (version < 2)
			return;
		app->capture = wl_registry_bind(registry, name,
						&weston_capture_v1_interface, 2);
	}
}

static void
registry_global_remove(void *data, struct wl_registry *registry, uint32_t name)
{
}

static const struct wl_registry_listener registry_listener = {
	.global = registry_global,
	.global_remove = registry_global_remove,
};

static void
source_format(void *data, struct weston_capture_source_v1 *source, uint32_t format)
{
	struct capture_source *capture = data;

	if (capture->formats_done) {
		capture->format_count = 0;
		capture->formats_done = false;
	}
	if (capture->format_count < sizeof capture->formats / sizeof capture->formats[0])
		capture->formats[capture->format_count++] = format;
}

static void
source_size(void *data, struct weston_capture_source_v1 *source, int32_t width,
	    int32_t height)
{
	struct capture_source *capture = data;

	capture->width = width;
	capture->height = height;
	capture->size_received = true;
}

static void
source_complete(void *data, struct weston_capture_source_v1 *source)
{
	struct capture_source *capture = data;

	capture->complete = true;
}

static void
source_retry(void *data, struct weston_capture_source_v1 *source)
{
	struct capture_source *capture = data;

	capture->retry = true;
}

static void
source_failed(void *data, struct weston_capture_source_v1 *source, const char *message)
{
	struct capture_source *capture = data;

	capture->failed = true;
	if (message)
		snprintf(capture->failure, sizeof capture->failure, "%s", message);
}

static void
source_formats_done(void *data, struct weston_capture_source_v1 *source)
{
	struct capture_source *capture = data;

	capture->formats_done = true;
}

static const struct weston_capture_source_v1_listener source_listener = {
	.format = source_format,
	.size = source_size,
	.complete = source_complete,
	.retry = source_retry,
	.failed = source_failed,
	.formats_done = source_formats_done,
};

static void
sync_done(void *data, struct wl_callback *callback, uint32_t serial)
{
	bool *done = data;

	*done = true;
}

static const struct wl_callback_listener sync_listener = {
	.done = sync_done,
};

static int
remaining_ms(const struct timespec *deadline)
{
	struct timespec now;
	int64_t remaining;

	clock_gettime(CLOCK_MONOTONIC, &now);
	remaining = (int64_t)(deadline->tv_sec - now.tv_sec) * 1000 +
		    (deadline->tv_nsec - now.tv_nsec) / 1000000;
	if (remaining <= 0)
		return 0;
	return remaining > INT32_MAX ? INT32_MAX : (int)remaining;
}

/* wl_display_dispatch() can block forever; this bounds every wait by the capture deadline. */
static bool
dispatch_with_deadline(struct capture_app *app)
{
	struct pollfd pollfd = {
		.fd = wl_display_get_fd(app->display),
		.events = POLLIN,
	};
	int timeout;
	int ready;

	while (wl_display_prepare_read(app->display) != 0) {
		if (wl_display_dispatch_pending(app->display) < 0)
			return false;
	}
	if (wl_display_flush(app->display) < 0) {
		if (errno != EAGAIN) {
			wl_display_cancel_read(app->display);
			return false;
		}
		pollfd.events |= POLLOUT;
	}
	timeout = remaining_ms(&app->deadline);
	if (timeout == 0) {
		wl_display_cancel_read(app->display);
		errno = ETIMEDOUT;
		return false;
	}
	ready = poll(&pollfd, 1, timeout);
	if (ready <= 0) {
		wl_display_cancel_read(app->display);
		if (ready == 0)
			errno = ETIMEDOUT;
		return ready < 0 && errno == EINTR;
	}
	if (!(pollfd.revents & POLLIN)) {
		wl_display_cancel_read(app->display);
		return true;
	}
	if (wl_display_read_events(app->display) < 0)
		return false;
	return wl_display_dispatch_pending(app->display) >= 0;
}

static bool
roundtrip_with_deadline(struct capture_app *app)
{
	struct wl_callback *callback = wl_display_sync(app->display);
	bool done = false;

	if (!callback)
		return false;
	wl_callback_add_listener(callback, &sync_listener, &done);
	while (!done) {
		if (!dispatch_with_deadline(app)) {
			wl_callback_destroy(callback);
			return false;
		}
	}
	wl_callback_destroy(callback);
	return true;
}

static bool
parse_positive_int(const char *raw, int32_t maximum, int32_t *value)
{
	char *end = NULL;
	long parsed;

	errno = 0;
	parsed = strtol(raw, &end, 10);
	if (errno || !end || *end || parsed <= 0 || parsed > maximum)
		return false;
	*value = (int32_t)parsed;
	return true;
}

static struct capture_output *
find_output(struct capture_app *app, const char *name)
{
	struct capture_output *output;

	for (output = app->outputs; output; output = output->next) {
		if (output->name && strcmp(output->name, name) == 0)
			return output;
	}
	return NULL;
}

static bool
select_format(const struct capture_source *source, uint32_t *shm_format,
	      pixman_format_code_t *pixman_format)
{
	static const struct {
		uint32_t drm;
		uint32_t shm;
		pixman_format_code_t pixman;
	} supported[] = {
		{ DRM_FORMAT_XRGB8888, WL_SHM_FORMAT_XRGB8888, PIXMAN_x8r8g8b8 },
		{ DRM_FORMAT_ARGB8888, WL_SHM_FORMAT_ARGB8888, PIXMAN_a8r8g8b8 },
		{ DRM_FORMAT_XBGR8888, WL_SHM_FORMAT_XBGR8888, PIXMAN_x8b8g8r8 },
		{ DRM_FORMAT_ABGR8888, WL_SHM_FORMAT_ABGR8888, PIXMAN_a8b8g8r8 },
	};
	size_t i;
	size_t j;

	for (i = 0; i < sizeof supported / sizeof supported[0]; i++) {
		for (j = 0; j < source->format_count; j++) {
			if (source->formats[j] == supported[i].drm) {
				*shm_format = supported[i].shm;
				*pixman_format = supported[i].pixman;
				return true;
			}
		}
	}
	return false;
}

static void
destroy_capture_buffer(struct capture_buffer *buffer)
{
	if (buffer->buffer)
		wl_buffer_destroy(buffer->buffer);
	if (buffer->data && buffer->data != MAP_FAILED)
		munmap(buffer->data, buffer->size);
	memset(buffer, 0, sizeof *buffer);
}

static bool
create_capture_buffer(struct capture_app *app, const struct capture_source *source,
		      int32_t canvas_width, int32_t canvas_height,
		      struct capture_buffer *buffer)
{
	struct wl_shm_pool *pool;
	uint32_t shm_format;
	pixman_format_code_t pixman_format;
	size_t stride;
	int fd;

	memset(buffer, 0, sizeof *buffer);
	if (source->width != canvas_width || source->height != canvas_height) {
		fprintf(stderr, "capture canvas %dx%d does not match expected %dx%d\n",
			source->width, source->height, canvas_width, canvas_height);
		return false;
	}
	/* Weston requires 4-byte pixels with no row padding for wl_shm captures. */
	stride = (size_t)canvas_width * 4;
	if (stride > INT32_MAX || stride > CAPTURE_SHM_LIMIT / (size_t)canvas_height) {
		fprintf(stderr, "capture canvas exceeds the shared-memory limit\n");
		return false;
	}
	if (!select_format(source, &shm_format, &pixman_format)) {
		fprintf(stderr, "capture source has no supported shared-memory format\n");
		return false;
	}
	buffer->width = canvas_width;
	buffer->height = canvas_height;
	buffer->stride = (int32_t)stride;
	buffer->size = stride * (size_t)canvas_height;
	fd = memfd_create("aperture-weston-capture", MFD_CLOEXEC);
	if (fd < 0) {
		fprintf(stderr, "create capture memory: %s\n", strerror(errno));
		return false;
	}
	if (ftruncate(fd, (off_t)buffer->size) < 0) {
		fprintf(stderr, "size capture memory: %s\n", strerror(errno));
		close(fd);
		return false;
	}
	buffer->data = mmap(NULL, buffer->size, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
	if (buffer->data == MAP_FAILED) {
		fprintf(stderr, "map capture memory: %s\n", strerror(errno));
		close(fd);
		return false;
	}
	pool = wl_shm_create_pool(app->shm, fd, (int32_t)buffer->size);
	close(fd);
	if (!pool) {
		fprintf(stderr, "create capture shared-memory pool failed\n");
		destroy_capture_buffer(buffer);
		return false;
	}
	buffer->buffer = wl_shm_pool_create_buffer(pool, 0, buffer->width, buffer->height,
						   buffer->stride, shm_format);
	wl_shm_pool_destroy(pool);
	if (!buffer->buffer) {
		fprintf(stderr, "create capture buffer failed\n");
		destroy_capture_buffer(buffer);
		return false;
	}
	buffer->pixman_format = pixman_format;
	return true;
}

static void
jpeg_error_exit(j_common_ptr common)
{
	struct jpeg_error *error = (struct jpeg_error *)common->err;

	(*common->err->format_message)(common, error->message);
	longjmp(error->jump, 1);
}

static bool
write_jpeg(const struct capture_buffer *buffer, int32_t content_width,
	   int32_t content_height, int32_t max_width, int quality)
{
	struct jpeg_compress_struct compressor;
	struct jpeg_error error;
	pixman_image_t *volatile source = NULL;
	pixman_image_t *volatile scaled = NULL;
	pixman_transform_t transform;
	uint32_t *scaled_data = NULL;
	JSAMPLE *row = NULL;
	int32_t width = content_width < max_width ? content_width : max_width;
	int32_t height = (int32_t)(((int64_t)content_height * width + content_width / 2) /
				   content_width);
	int32_t y;
	bool ok = false;

	if (height < 1)
		height = 1;
	memset(&compressor, 0, sizeof compressor);
	scaled_data = calloc((size_t)width * (size_t)height, sizeof *scaled_data);
	row = malloc((size_t)width * 3);
	if (!scaled_data || !row) {
		fprintf(stderr, "allocate scaled capture failed\n");
		goto out;
	}
	/* Only the content rectangle is wrapped, which crops the unused canvas edges. */
	source = pixman_image_create_bits(buffer->pixman_format, content_width,
					  content_height, buffer->data, buffer->stride);
	scaled = pixman_image_create_bits(PIXMAN_x8r8g8b8, width, height,
					  scaled_data, width * 4);
	if (!source || !scaled) {
		fprintf(stderr, "create capture images failed\n");
		goto out;
	}
	pixman_transform_init_scale(&transform,
				    pixman_double_to_fixed((double)content_width / width),
				    pixman_double_to_fixed((double)content_height / height));
	/* PAD keeps bilinear samples at the crop edge from blending with transparent black. */
	pixman_image_set_repeat(source, PIXMAN_REPEAT_PAD);
	if (!pixman_image_set_transform(source, &transform) ||
	    !pixman_image_set_filter(source, PIXMAN_FILTER_BILINEAR, NULL, 0)) {
		fprintf(stderr, "configure capture scaling failed\n");
		goto out;
	}
	pixman_image_composite32(PIXMAN_OP_SRC, source, NULL, scaled,
				  0, 0, 0, 0, 0, 0, width, height);

	compressor.err = jpeg_std_error(&error.manager);
	error.manager.error_exit = jpeg_error_exit;
	if (setjmp(error.jump)) {
		fprintf(stderr, "encode JPEG: %s\n", error.message);
		jpeg_destroy_compress(&compressor);
		goto out;
	}
	jpeg_create_compress(&compressor);
	jpeg_stdio_dest(&compressor, stdout);
	compressor.image_width = (JDIMENSION)width;
	compressor.image_height = (JDIMENSION)height;
	compressor.input_components = 3;
	compressor.in_color_space = JCS_RGB;
	jpeg_set_defaults(&compressor);
	jpeg_set_quality(&compressor, quality, TRUE);
	jpeg_start_compress(&compressor, TRUE);
	for (y = 0; y < height; y++) {
		JSAMPROW rows[1] = { row };
		int32_t x;

		for (x = 0; x < width; x++) {
			uint32_t pixel = scaled_data[(size_t)y * width + x];

			row[x * 3] = (JSAMPLE)((pixel >> 16) & 0xff);
			row[x * 3 + 1] = (JSAMPLE)((pixel >> 8) & 0xff);
			row[x * 3 + 2] = (JSAMPLE)(pixel & 0xff);
		}
		jpeg_write_scanlines(&compressor, rows, 1);
	}
	jpeg_finish_compress(&compressor);
	jpeg_destroy_compress(&compressor);
	if (fflush(stdout) == 0 && !ferror(stdout))
		ok = true;
	else
		fprintf(stderr, "write JPEG: %s\n", strerror(errno));

out:
	if (scaled)
		pixman_image_unref(scaled);
	if (source)
		pixman_image_unref(source);
	free(row);
	free(scaled_data);
	return ok;
}

static void
destroy_app(struct capture_app *app)
{
	struct capture_output *output = app->outputs;

	while (output) {
		struct capture_output *next = output->next;

		if (output->output)
			wl_output_release(output->output);
		free(output->name);
		free(output);
		output = next;
	}
	if (app->capture)
		weston_capture_v1_destroy(app->capture);
	if (app->shm)
		wl_shm_destroy(app->shm);
	if (app->registry)
		wl_registry_destroy(app->registry);
	if (app->display)
		wl_display_disconnect(app->display);
}

static bool
wait_for_source_parameters(struct capture_app *app, struct capture_source *source)
{
	while (!source->failed && !(source->formats_done && source->size_received)) {
		if (!dispatch_with_deadline(app))
			return false;
	}
	return !source->failed;
}

int
main(int argc, char *argv[])
{
	struct capture_app app = {0};
	struct capture_output *output;
	struct capture_source source = {0};
	struct capture_buffer buffer = {0};
	char output_name[256];
	int32_t canvas_width;
	int32_t canvas_height;
	int32_t content_width;
	int32_t content_height;
	int32_t max_width;
	int32_t quality;
	int attempt;
	int status = EXIT_FAILURE;

	if (argc != 8 || !parse_positive_int(argv[2], 16384, &canvas_width) ||
	    !parse_positive_int(argv[3], 16384, &canvas_height) ||
	    !parse_positive_int(argv[4], canvas_width, &content_width) ||
	    !parse_positive_int(argv[5], canvas_height, &content_height) ||
	    !parse_positive_int(argv[6], 16384, &max_width) ||
	    !parse_positive_int(argv[7], 100, &quality)) {
		fprintf(stderr, "usage: %s CAPTURE_ID CANVAS_WIDTH CANVAS_HEIGHT "
			"CONTENT_WIDTH CONTENT_HEIGHT MAX_WIDTH QUALITY\n", argv[0]);
		return EXIT_FAILURE;
	}
	if (snprintf(output_name, sizeof output_name, "aperture-%s", argv[1]) >=
	    (int)sizeof output_name) {
		fprintf(stderr, "capture id is too long\n");
		return EXIT_FAILURE;
	}
	clock_gettime(CLOCK_MONOTONIC, &app.deadline);
	app.deadline.tv_sec += CAPTURE_TIMEOUT_MS / 1000;
	app.deadline.tv_nsec += (CAPTURE_TIMEOUT_MS % 1000) * 1000000L;
	if (app.deadline.tv_nsec >= 1000000000L) {
		app.deadline.tv_sec++;
		app.deadline.tv_nsec -= 1000000000L;
	}

	app.display = wl_display_connect(NULL);
	if (!app.display) {
		fprintf(stderr, "connect to compositor: %s\n", strerror(errno));
		goto out;
	}
	app.registry = wl_display_get_registry(app.display);
	if (!app.registry) {
		fprintf(stderr, "get compositor registry failed\n");
		goto out;
	}
	wl_registry_add_listener(app.registry, &registry_listener, &app);
	/* The second roundtrip collects the wl_output.name events of bound outputs. */
	if (!roundtrip_with_deadline(&app) || !roundtrip_with_deadline(&app)) {
		fprintf(stderr, "read compositor globals: %s\n", strerror(errno));
		goto out;
	}
	if (!app.shm || !app.capture) {
		fprintf(stderr, "compositor capture protocol is unavailable\n");
		goto out;
	}
	output = find_output(&app, output_name);
	if (!output) {
		fprintf(stderr, "capture output %s is unavailable\n", output_name);
		goto out;
	}
	source.source = weston_capture_v1_create(app.capture, output->output,
						 WESTON_CAPTURE_V1_SOURCE_FRAMEBUFFER);
	if (!source.source) {
		fprintf(stderr, "create capture source failed\n");
		goto out;
	}
	weston_capture_source_v1_add_listener(source.source, &source_listener, &source);

	for (attempt = 0; attempt < CAPTURE_ATTEMPTS; attempt++) {
		/* Weston sends replacement parameters before retry, so this only waits initially. */
		if (!wait_for_source_parameters(&app, &source)) {
			fprintf(stderr, "read capture source parameters: %s\n",
				source.failed ? source.failure : strerror(errno));
			goto out_source;
		}
		if (!create_capture_buffer(&app, &source, canvas_width, canvas_height, &buffer))
			goto out_source;
		source.complete = false;
		source.retry = false;
		source.failed = false;
		source.failure[0] = '\0';
		weston_capture_source_v1_capture(source.source, buffer.buffer);
		while (!source.complete && !source.retry && !source.failed) {
			if (!dispatch_with_deadline(&app)) {
				fprintf(stderr, "capture compositor output: %s\n", strerror(errno));
				goto out_source;
			}
		}
		if (source.complete)
			break;
		destroy_capture_buffer(&buffer);
		if (source.failed) {
			fprintf(stderr, "capture compositor output: %s\n",
				source.failure[0] ? source.failure : "capture denied or unavailable");
			goto out_source;
		}
	}
	if (!source.complete) {
		fprintf(stderr, "capture source parameters did not stabilize\n");
		goto out_source;
	}
	if (write_jpeg(&buffer, content_width, content_height, max_width, quality))
		status = EXIT_SUCCESS;

out_source:
	/* Destroying the source first cancels any capture still writing into the buffer. */
	weston_capture_source_v1_destroy(source.source);
	destroy_capture_buffer(&buffer);
out:
	destroy_app(&app);
	return status;
}
