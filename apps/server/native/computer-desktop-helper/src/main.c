/*
 * synara-computer-desktop-helper
 *
 * A JSON-RPC server over stdio that owns one Wayland connection. The server
 * process speaks to it the way it speaks to the AT-SPI helper: newline-framed
 * JSON-RPC on stdin/stdout, plus one write-only pipe on fd 3 carrying binary
 * capture payloads inside the shared frame envelope, because base64'ing a
 * full-desktop PNG through the JSON channel twice a second is not affordable.
 *
 * Two short-lived CLI modes exist for the probe: `--print-globals` and
 * `--print-outputs` connect, print one JSON document, and exit.
 */
#define _GNU_SOURCE

#include <errno.h>
#include <fcntl.h>
#include <math.h>
#include <poll.h>
#include <signal.h>
#include <stdarg.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

#include "image.h"
#include "json.h"
#include "wayland.h"

#define HELPER_PROTOCOL_VERSION 1
/* "HS" little-endian: the desktop helper's private frame channel. Distinct from
 * the computer frame magic so a mis-wired pipe fails loudly instead of decoding
 * into something plausible. */
#define HELPER_FRAME_MAGIC 0x5348
#define HELPER_FRAME_VERSION 1
#define HELPER_FRAME_FLAG_KEYFRAME 0x01
#define FRAME_FD 3
#define MAX_REQUEST_BYTES (4 * 1024 * 1024)
/* The server's own cap on one frame record (`HELPER_MAX_CAPTURE_BYTES` in
 * desktopHelperClient.ts). A record past it is read as a desync and costs the
 * process, so an oversized capture is refused while it is still an answer. */
#define MAX_FRAME_RECORD_BYTES (64 * 1024 * 1024)
/*
 * How long the helper will spend inside one write to the server.
 *
 * The process is single threaded: while it is blocked writing a payload it
 * services neither stdin nor the Wayland fd, and a compositor whose client has
 * stopped reading eventually drops the connection. So fd 3 is put in
 * non-blocking mode, written through poll, and a server that has not drained
 * the pipe in this long is treated as gone.
 */
#define WRITE_BUDGET_MS 10000
/* One full-desktop PNG in a single write() rather than a dozen poll-and-retry
 * rounds. Best effort: the kernel caps this at /proc/sys/fs/pipe-max-size. */
#define FRAME_PIPE_BYTES (1024 * 1024)

/* JSON-RPC codes. -32001 and -32002 are this helper's own: the server retries
 * a transient refusal and never retries a permanent one, and both leave the
 * process alone. */
#define HELPER_CODE_INVALID (-32000)
#define HELPER_CODE_UNSUPPORTED (-32001)
#define HELPER_CODE_TRANSIENT (-32002)
#define HELPER_CODE_UNKNOWN_METHOD (-32601)
#define HELPER_CODE_PARSE_ERROR (-32700)
#define HELPER_CODE_INVALID_REQUEST (-32600)

static volatile sig_atomic_t stop_requested = 0;

static void handle_signal(int signal_number) {
	(void)signal_number;
	stop_requested = 1;
}

// ── Output plumbing ──────────────────────────────────────────────────

static void fatal(const char *format, ...) __attribute__((noreturn, format(printf, 1, 2)));

/*
 * Dies, loudly.
 *
 * Neither channel can resynchronise: a half-written frame record leaves a
 * length prefix promising bytes that will never arrive, and the server's parser
 * has nothing to hunt for to find the next record. Exiting is the recovery —
 * the client's restart path exists for exactly this, and the compositor
 * releases the virtual devices' held keys when this process disconnects, so
 * dying cannot strand a modifier on the human's keyboard either.
 */
static void fatal(const char *format, ...) {
	va_list arguments;
	va_start(arguments, format);
	vfprintf(stderr, format, arguments);
	va_end(arguments);
	fputc('\n', stderr);
	fflush(stderr);
	_exit(1);
}

static int64_t monotonic_ms(void) {
	struct timespec now;
	clock_gettime(CLOCK_MONOTONIC, &now);
	return (int64_t)now.tv_sec * 1000 + now.tv_nsec / 1000000;
}

/*
 * Writes every byte or gives up at `deadline_ms`. On a non-blocking fd the poll
 * is what bounds the wait; on a blocking one (fd 3 redirected to a file by
 * hand, say) the write itself never reports EAGAIN and the deadline never
 * comes up, which is the right behaviour for a destination that cannot stall.
 */
static bool write_all_until(int fd, const void *data, size_t length, int64_t deadline_ms) {
	const uint8_t *cursor = data;
	while (length > 0) {
		ssize_t written = write(fd, cursor, length);
		if (written > 0) {
			cursor += written;
			length -= (size_t)written;
			continue;
		}
		if (written == 0) {
			errno = EIO;
			return false;
		}
		if (errno == EINTR) continue;
		if (errno != EAGAIN && errno != EWOULDBLOCK) return false;
		int64_t remaining = deadline_ms - monotonic_ms();
		if (remaining <= 0) {
			errno = ETIMEDOUT;
			return false;
		}
		struct pollfd descriptor = {.fd = fd, .events = POLLOUT, .revents = 0};
		int ready = poll(&descriptor, 1, (int)remaining);
		if (ready == 0) {
			errno = ETIMEDOUT;
			return false;
		}
		if (ready < 0 && errno != EINTR) return false;
	}
	return true;
}

static bool write_all(int fd, const void *data, size_t length) {
	return write_all_until(fd, data, length, monotonic_ms() + WRITE_BUDGET_MS);
}

static bool write_line(const json_writer *writer) {
	if (writer->failed) return false;
	if (!write_all(STDOUT_FILENO, writer->data, writer->length)) return false;
	return write_all(STDOUT_FILENO, "\n", 1);
}

/*
 * Writes one control-channel line, or dies trying.
 *
 * A truncated line is a desync of the control channel for the rest of the
 * process's life: the server's framer would read the remainder of this
 * response as the beginning of the next one.
 */
static void write_line_or_die(const json_writer *writer) {
	if (writer->failed) fatal("a response could not be built: out of memory");
	if (!write_line(writer)) {
		fatal("the control channel could not be written: %s", strerror(errno));
	}
}

static double wall_clock_ms(void) {
	struct timespec now;
	clock_gettime(CLOCK_REALTIME, &now);
	return (double)now.tv_sec * 1000.0 + (double)now.tv_nsec / 1000000.0;
}

static void put_u16(uint8_t *out, uint16_t value) {
	out[0] = (uint8_t)(value & 0xFF);
	out[1] = (uint8_t)((value >> 8) & 0xFF);
}

static void put_u32(uint8_t *out, uint32_t value) {
	out[0] = (uint8_t)(value & 0xFF);
	out[1] = (uint8_t)((value >> 8) & 0xFF);
	out[2] = (uint8_t)((value >> 16) & 0xFF);
	out[3] = (uint8_t)((value >> 24) & 0xFF);
}

static void put_f64(uint8_t *out, double value) {
	/* Little-endian IEEE-754, which is what DataView.setFloat64(…, true) reads
	 * and what every platform this ships on stores natively. */
	uint64_t bits;
	memcpy(&bits, &value, sizeof(bits));
	for (int index = 0; index < 8; index++) out[index] = (uint8_t)((bits >> (index * 8)) & 0xFF);
}

/** The record length a payload of this size would take on the wire. */
static size_t frame_record_bytes(const char *stream_id, size_t payload_length) {
	return 17 + strlen(stream_id) + payload_length;
}

/**
 * Writes one length-prefixed frame record to fd 3: u32 length, then the 17-byte
 * envelope header, the stream id, and the payload. A failure here is fatal by
 * design; see `fatal`.
 */
static void write_frame(const char *stream_id, uint32_t sequence, const uint8_t *payload,
                        size_t payload_length) {
	size_t id_length = strlen(stream_id);
	if (id_length == 0 || id_length > 255) fatal("a capture was given an unusable stream id");
	size_t envelope_length = frame_record_bytes(stream_id, payload_length);
	uint8_t header[4 + 17 + 255];
	put_u32(header, (uint32_t)envelope_length);
	put_u16(header + 4, HELPER_FRAME_MAGIC);
	header[6] = HELPER_FRAME_VERSION;
	header[7] = HELPER_FRAME_FLAG_KEYFRAME;
	put_u32(header + 8, sequence);
	put_f64(header + 12, wall_clock_ms());
	header[20] = (uint8_t)id_length;
	memcpy(header + 21, stream_id, id_length);
	/* One deadline for the whole record: the header and the payload are two
	 * writes but a single promise to the reader. */
	int64_t deadline_ms = monotonic_ms() + WRITE_BUDGET_MS;
	if (!write_all_until(FRAME_FD, header, 21 + id_length, deadline_ms) ||
	    !write_all_until(FRAME_FD, payload, payload_length, deadline_ms)) {
		fatal("the capture payload could not be written to the frame pipe: %s", strerror(errno));
	}
}

/*
 * Checks fd 3 is the server's frame pipe before anything else opens a
 * descriptor.
 *
 * The order matters more than the check: `wl_display_connect` takes the lowest
 * free fd, so a helper started without a frame pipe would be handed fd 3 for
 * the Wayland socket and every capture would be written into the middle of the
 * Wayland stream. Only the server mode needs this — `--print-globals` and
 * `--print-outputs` answer on stdout and are run by the probe with three fds.
 */
static bool prepare_frame_channel(char *error, size_t error_size) {
	struct stat info;
	if (fstat(FRAME_FD, &info) != 0) {
		snprintf(error, error_size,
		         "fd %d is not open: the helper is started with the server's frame pipe on it (%s)",
		         FRAME_FD, strerror(errno));
		return false;
	}
	if (S_ISFIFO(info.st_mode) || S_ISSOCK(info.st_mode)) {
		if (S_ISFIFO(info.st_mode)) fcntl(FRAME_FD, F_SETPIPE_SZ, FRAME_PIPE_BYTES);
		int flags = fcntl(FRAME_FD, F_GETFL);
		if (flags >= 0) fcntl(FRAME_FD, F_SETFL, flags | O_NONBLOCK);
	}
	return true;
}

// ── JSON-RPC envelopes ───────────────────────────────────────────────

/* The id is echoed verbatim so a string id survives the round trip; requests
 * without one are notifications and get no answer. */
static void write_id(json_writer *writer, const json_value *id) {
	if (id == NULL) {
		jw_raw(writer, "null");
		return;
	}
	switch (id->type) {
	case JSON_NUMBER: jw_number(writer, id->number); break;
	case JSON_STRING: jw_string(writer, id->string); break;
	default: jw_raw(writer, "null"); break;
	}
}

static void respond_error(const json_value *id, int code, const char *message) {
	json_writer writer;
	jw_init(&writer);
	jw_raw(&writer, "{\"jsonrpc\":\"2.0\",\"id\":");
	write_id(&writer, id);
	jw_raw(&writer, ",\"error\":{\"code\":");
	jw_int(&writer, code);
	jw_raw(&writer, ",\"message\":");
	jw_string(&writer, message);
	jw_raw(&writer, "}}");
	write_line_or_die(&writer);
	jw_free(&writer);
}

/* What the server reads to decide whether retrying this request can ever help. */
static int json_rpc_code(helper_refusal kind) {
	switch (kind) {
	case HELPER_REFUSAL_UNKNOWN_METHOD: return HELPER_CODE_UNKNOWN_METHOD;
	case HELPER_REFUSAL_UNSUPPORTED: return HELPER_CODE_UNSUPPORTED;
	case HELPER_REFUSAL_TRANSIENT: return HELPER_CODE_TRANSIENT;
	case HELPER_REFUSAL_INVALID: break;
	}
	return HELPER_CODE_INVALID;
}

// ── Requests ─────────────────────────────────────────────────────────

typedef struct {
	helper_wayland *wayland;
	uint32_t next_sequence;
	bool shutdown;
} helper_context;

/**
 * Reads one integer parameter and bounds it.
 *
 * The bound is not politeness. `(int64_t)value` is undefined for a double the
 * integer cannot hold, and `1e300` is one JSON literal away for any caller, so
 * the range is checked in the double domain before the conversion happens.
 */
static bool require_int(const json_value *params, const char *name, int64_t low, int64_t high,
                        int64_t *out, helper_error *error) {
	double value = 0;
	if (!json_member_number(params, name, &value)) {
		helper_error_set(error, HELPER_REFUSAL_INVALID, "\"%s\" must be a number", name);
		return false;
	}
	if (!(value >= (double)low && value <= (double)high)) {
		helper_error_set(error, HELPER_REFUSAL_INVALID, "\"%s\" must be between %lld and %lld", name,
		                 (long long)low, (long long)high);
		return false;
	}
	*out = (int64_t)value;
	return true;
}

/**
 * Reads one free-range number parameter: a coordinate that will be clamped, or
 * a scroll delta that will be bounded further down.
 *
 * Finite is still required. `strtod` accepts `nan` and `inf`, and a NaN survives
 * every clamp written as a pair of comparisons — both are false — to reach a
 * cast the C standard leaves undefined.
 */
static bool require_number(const json_value *params, const char *name, double *out,
                           helper_error *error) {
	if (!json_member_number(params, name, out) || !isfinite(*out)) {
		helper_error_set(error, HELPER_REFUSAL_INVALID, "\"%s\" must be a finite number", name);
		return false;
	}
	return true;
}

/**
 * Runs one method and writes its result body into `writer` (the object braces
 * included). Returns false with `error` filled when the method refused, which
 * the caller turns into a JSON-RPC error rather than a plausible-looking empty
 * success.
 */
static bool dispatch(helper_context *context, const char *method, const json_value *params,
                     json_writer *writer, helper_error *error) {
	helper_wayland *wayland = context->wayland;

	if (strcmp(method, "globals") == 0) {
		jw_raw(writer, "{\"globals\":");
		helper_wayland_write_globals(wayland, writer);
		jw_char(writer, '}');
		return true;
	}

	if (strcmp(method, "outputs") == 0) {
		helper_box workspace;
		if (!helper_wayland_workspace(wayland, &workspace, error)) return false;
		jw_raw(writer, "{\"outputs\":");
		helper_wayland_write_outputs(wayland, writer);
		jw_raw(writer, ",\"workspace\":{\"x\":");
		jw_int(writer, workspace.x);
		jw_raw(writer, ",\"y\":");
		jw_int(writer, workspace.y);
		jw_raw(writer, ",\"width\":");
		jw_int(writer, workspace.width);
		jw_raw(writer, ",\"height\":");
		jw_int(writer, workspace.height);
		jw_raw(writer, "}}");
		return true;
	}

	if (strcmp(method, "pointerMotion") == 0) {
		double x = 0;
		double y = 0;
		if (!require_number(params, "x", &x, error)) return false;
		if (!require_number(params, "y", &y, error)) return false;
		/* Deliberately not bounded past finiteness: the pointer is clamped into
		 * the workspace below, which is a better answer than a refusal for a
		 * caller whose idea of the desktop is one frame out of date. */
		if (!helper_wayland_pointer_motion(wayland, x, y, error)) return false;
		jw_raw(writer, "{\"ok\":true}");
		return true;
	}

	if (strcmp(method, "pointerButton") == 0) {
		int64_t code = 0;
		if (!require_int(params, "code", 0, UINT16_MAX, &code, error)) return false;
		bool pressed = json_member_bool(params, "pressed", false);
		if (!helper_wayland_pointer_button(wayland, (uint32_t)code, pressed, error)) return false;
		jw_raw(writer, "{\"ok\":true}");
		return true;
	}

	if (strcmp(method, "scroll") == 0) {
		double delta_x = 0;
		double delta_y = 0;
		if (!require_number(params, "deltaX", &delta_x, error)) return false;
		if (!require_number(params, "deltaY", &delta_y, error)) return false;
		if (!helper_wayland_pointer_axis(wayland, delta_x, delta_y, error)) return false;
		jw_raw(writer, "{\"ok\":true}");
		return true;
	}

	if (strcmp(method, "key") == 0) {
		int64_t code = 0;
		if (!require_int(params, "code", 0, UINT16_MAX, &code, error)) return false;
		bool pressed = json_member_bool(params, "pressed", false);
		if (!helper_wayland_key(wayland, (uint32_t)code, pressed, error)) return false;
		jw_raw(writer, "{\"ok\":true}");
		return true;
	}

	if (strcmp(method, "releaseAll") == 0) {
		helper_wayland_release_all(wayland);
		jw_raw(writer, "{\"ok\":true}");
		return true;
	}

	if (strcmp(method, "capture") == 0) {
		int64_t x = 0;
		int64_t y = 0;
		int64_t width = 0;
		int64_t height = 0;
		const int64_t limit = HELPER_COORDINATE_LIMIT;
		if (!require_int(params, "x", -limit, limit, &x, error)) return false;
		if (!require_int(params, "y", -limit, limit, &y, error)) return false;
		if (!require_int(params, "width", 0, limit, &width, error)) return false;
		if (!require_int(params, "height", 0, limit, &height, error)) return false;
		int64_t max_dimension = 0;
		if (json_member(params, "maxDimension") != NULL &&
		    !require_int(params, "maxDimension", 0, IMAGE_MAX_DIMENSION, &max_dimension, error)) {
			return false;
		}
		bool overlay_cursor = json_member_bool(params, "overlayCursor", false);

		helper_box region = {.x = (int32_t)x,
		                     .y = (int32_t)y,
		                     .width = (int32_t)width,
		                     .height = (int32_t)height};
		image_rgba image = {0};
		helper_box covered = {0};
		if (!helper_wayland_capture(wayland, region, (uint32_t)max_dimension, overlay_cursor, &image,
		                            &covered, error)) {
			return false;
		}
		uint8_t *bytes = NULL;
		size_t length = 0;
		bool encoded = image_encode_png(&image, &bytes, &length);
		uint32_t pixel_width = image.width;
		uint32_t pixel_height = image.height;
		image_free(&image);
		if (!encoded) {
			helper_error_set(error, HELPER_REFUSAL_TRANSIENT,
			                 "the %ux%u capture could not be encoded as PNG", pixel_width,
			                 pixel_height);
			return false;
		}
		uint32_t sequence = context->next_sequence++;
		char stream_id[32];
		snprintf(stream_id, sizeof(stream_id), "capture-%u", sequence);
		/* Refused rather than written: a record past the server's cap is read
		 * there as a desync, which costs the process and every request queued
		 * behind it. Asking for a smaller `maxDimension` is the way out. */
		if (frame_record_bytes(stream_id, length) > MAX_FRAME_RECORD_BYTES) {
			free(bytes);
			helper_error_set(error, HELPER_REFUSAL_INVALID,
			                 "the %ux%u capture encodes to %zu bytes, past the %d byte limit on one "
			                 "frame record",
			                 pixel_width, pixel_height, length, MAX_FRAME_RECORD_BYTES);
			return false;
		}
		write_frame(stream_id, sequence, bytes, length);
		free(bytes);
		jw_raw(writer, "{\"streamId\":");
		jw_string(writer, stream_id);
		jw_raw(writer, ",\"sequence\":");
		jw_int(writer, sequence);
		jw_raw(writer, ",\"encoding\":\"png\",\"byteLength\":");
		jw_int(writer, (long long)length);
		jw_raw(writer, ",\"width\":");
		jw_int(writer, pixel_width);
		jw_raw(writer, ",\"height\":");
		jw_int(writer, pixel_height);
		jw_raw(writer, ",\"region\":{\"x\":");
		jw_int(writer, covered.x);
		jw_raw(writer, ",\"y\":");
		jw_int(writer, covered.y);
		jw_raw(writer, ",\"width\":");
		jw_int(writer, covered.width);
		jw_raw(writer, ",\"height\":");
		jw_int(writer, covered.height);
		jw_raw(writer, "}}");
		return true;
	}

	if (strcmp(method, "listWindows") == 0) {
		jw_raw(writer, "{\"windows\":");
		if (!helper_wayland_write_windows(wayland, writer, error)) return false;
		jw_char(writer, '}');
		return true;
	}

	if (strcmp(method, "activateWindow") == 0 || strcmp(method, "closeWindow") == 0) {
		const char *id = json_as_string(json_member(params, "id"));
		if (id == NULL) {
			helper_error_set(error, HELPER_REFUSAL_INVALID, "\"id\" must be a string");
			return false;
		}
		bool ok = strcmp(method, "activateWindow") == 0
		              ? helper_wayland_activate_window(wayland, id, error)
		              : helper_wayland_close_window(wayland, id, error);
		if (!ok) return false;
		jw_raw(writer, "{\"ok\":true}");
		return true;
	}

	if (strcmp(method, "shutdown") == 0) {
		context->shutdown = true;
		jw_raw(writer, "{\"ok\":true}");
		return true;
	}

	helper_error_set(error, HELPER_REFUSAL_UNKNOWN_METHOD, "unknown method \"%s\"", method);
	return false;
}

static void handle_line(helper_context *context, const char *line, size_t length) {
	char parse_error[256];
	json_value *request = json_parse(line, length, parse_error, sizeof(parse_error));
	if (request == NULL) {
		respond_error(NULL, HELPER_CODE_PARSE_ERROR, parse_error);
		return;
	}
	const json_value *id = json_member(request, "id");
	const char *method = json_as_string(json_member(request, "method"));
	if (method == NULL) {
		respond_error(id, HELPER_CODE_INVALID_REQUEST, "a request needs a \"method\" string");
		json_free(request);
		return;
	}
	const json_value *params = json_member(request, "params");

	json_writer body;
	jw_init(&body);
	helper_error error = {.kind = HELPER_REFUSAL_INVALID, .message = ""};
	bool ok = dispatch(context, method, params, &body, &error);

	/* A notification is fire-and-forget, but a failure still deserves to reach
	 * the log rather than vanish, so it goes to stderr. */
	if (id == NULL) {
		if (!ok) fprintf(stderr, "%s failed: %s\n", method, error.message);
		jw_free(&body);
		json_free(request);
		return;
	}
	if (!ok) {
		respond_error(id, json_rpc_code(error.kind), error.message);
		jw_free(&body);
		json_free(request);
		return;
	}
	if (body.failed) {
		respond_error(id, HELPER_CODE_TRANSIENT, "the response could not be built (out of memory)");
		jw_free(&body);
		json_free(request);
		return;
	}

	json_writer response;
	jw_init(&response);
	jw_raw(&response, "{\"jsonrpc\":\"2.0\",\"id\":");
	write_id(&response, id);
	jw_raw(&response, ",\"result\":");
	jw_raw(&response, body.data == NULL ? "{}" : body.data);
	jw_char(&response, '}');
	write_line_or_die(&response);
	jw_free(&response);
	jw_free(&body);
	json_free(request);
}

// ── CLI modes ────────────────────────────────────────────────────────

static int print_document(bool outputs) {
	helper_error error = {.kind = HELPER_REFUSAL_TRANSIENT, .message = ""};
	helper_wayland *wayland = helper_wayland_connect(&error);
	if (wayland == NULL) {
		fprintf(stderr, "%s\n", error.message);
		return 1;
	}
	json_writer writer;
	jw_init(&writer);
	if (outputs) {
		helper_wayland_write_outputs(wayland, &writer);
	} else {
		jw_raw(&writer, "{\"protocolVersion\":");
		jw_int(&writer, HELPER_PROTOCOL_VERSION);
		jw_raw(&writer, ",\"globals\":");
		helper_wayland_write_globals(wayland, &writer);
		jw_char(&writer, '}');
	}
	bool ok = write_line(&writer);
	jw_free(&writer);
	helper_wayland_destroy(wayland);
	if (!ok) {
		fprintf(stderr, "the result could not be written to stdout: %s\n", strerror(errno));
		return 1;
	}
	return 0;
}

// ── Main loop ────────────────────────────────────────────────────────

int main(int argc, char **argv) {
	for (int index = 1; index < argc; index++) {
		if (strcmp(argv[index], "--print-globals") == 0) return print_document(false);
		if (strcmp(argv[index], "--print-outputs") == 0) return print_document(true);
		if (strcmp(argv[index], "--version") == 0) {
			printf("synara-computer-desktop-helper %d\n", HELPER_PROTOCOL_VERSION);
			return 0;
		}
		fprintf(stderr, "unknown argument \"%s\"\n", argv[index]);
		return 2;
	}

	/* A broken stdout is reported through the write() return value; the default
	 * SIGPIPE would take the process down mid-request instead. */
	signal(SIGPIPE, SIG_IGN);
	struct sigaction action = {0};
	action.sa_handler = handle_signal;
	sigaction(SIGTERM, &action, NULL);
	sigaction(SIGINT, &action, NULL);

	char channel_error[256];
	if (!prepare_frame_channel(channel_error, sizeof(channel_error))) {
		fprintf(stderr, "%s\n", channel_error);
		return 1;
	}

	helper_error error = {.kind = HELPER_REFUSAL_TRANSIENT, .message = ""};
	helper_wayland *wayland = helper_wayland_connect(&error);
	if (wayland == NULL) {
		fprintf(stderr, "%s\n", error.message);
		return 1;
	}

	helper_context context = {.wayland = wayland, .next_sequence = 1, .shutdown = false};

	json_writer ready;
	jw_init(&ready);
	jw_raw(&ready, "{\"jsonrpc\":\"2.0\",\"method\":\"ready\",\"params\":{\"protocolVersion\":");
	jw_int(&ready, HELPER_PROTOCOL_VERSION);
	jw_raw(&ready, ",\"globals\":");
	helper_wayland_write_globals(wayland, &ready);
	jw_raw(&ready, "}}");
	write_line_or_die(&ready);
	jw_free(&ready);

	char *pending = NULL;
	size_t pending_length = 0;
	size_t pending_capacity = 0;
	/* Set when a line outgrew the buffer: its remaining bytes are dropped up to
	 * the next newline, which is the only boundary that means anything here. */
	bool skipping_line = false;
	int status = 0;

	while (!stop_requested && !context.shutdown) {
		if (!helper_wayland_prepare(wayland)) {
			fprintf(stderr, "the Wayland connection was lost\n");
			status = 1;
			break;
		}
		struct pollfd descriptors[2] = {
			{.fd = helper_wayland_fd(wayland), .events = POLLIN, .revents = 0},
			{.fd = STDIN_FILENO, .events = POLLIN, .revents = 0},
		};
		int ready_count = poll(descriptors, 2, -1);
		if (ready_count < 0 && errno != EINTR) {
			helper_wayland_read(wayland, false);
			fprintf(stderr, "poll failed: %s\n", strerror(errno));
			status = 1;
			break;
		}
		bool wayland_readable = ready_count > 0 && (descriptors[0].revents & POLLIN) != 0;
		if (!helper_wayland_read(wayland, wayland_readable)) {
			fprintf(stderr, "the Wayland connection was lost\n");
			status = 1;
			break;
		}
		if (ready_count <= 0) continue;

		/* POLLNVAL is stdin having been closed out from under the process; poll
		 * would report it again on every iteration, so retrying is a busy loop. */
		if ((descriptors[1].revents & POLLNVAL) != 0) {
			fprintf(stderr, "stdin is no longer a valid descriptor\n");
			status = 1;
			break;
		}
		if ((descriptors[1].revents & (POLLIN | POLLHUP | POLLERR)) == 0) continue;

		char chunk[65536];
		ssize_t count = read(STDIN_FILENO, chunk, sizeof(chunk));
		if (count == 0) break; /* the server closed stdin: shut down cleanly */
		if (count < 0) {
			if (errno == EINTR || errno == EAGAIN) continue;
			fprintf(stderr, "reading stdin failed: %s\n", strerror(errno));
			status = 1;
			break;
		}

		/*
		 * Consumed line by line rather than buffered whole, so that an oversized
		 * request only costs itself: the complete requests that shared its chunk
		 * are still answered, and only the bytes between the overflow and the
		 * next newline are dropped.
		 */
		const char *cursor = chunk;
		size_t remaining = (size_t)count;
		bool failed = false;
		while (remaining > 0 && !context.shutdown) {
			const char *newline = memchr(cursor, '\n', remaining);
			size_t take = newline == NULL ? remaining : (size_t)(newline - cursor);
			size_t step = newline == NULL ? remaining : take + 1;
			if (skipping_line) {
				if (newline != NULL) skipping_line = false;
				cursor += step;
				remaining -= step;
				continue;
			}
			if (pending_length + take > MAX_REQUEST_BYTES) {
				fprintf(stderr, "a request larger than %d bytes was discarded\n", MAX_REQUEST_BYTES);
				/* Best effort: the id is somewhere in the bytes that were dropped,
				 * so the answer is the one JSON-RPC prescribes when the request
				 * cannot be read at all. */
				respond_error(NULL, HELPER_CODE_INVALID_REQUEST,
				              "the request was larger than the helper accepts and was discarded");
				pending_length = 0;
				skipping_line = newline == NULL;
				cursor += step;
				remaining -= step;
				continue;
			}
			if (pending_length + take > pending_capacity) {
				size_t capacity = pending_capacity == 0 ? 65536 : pending_capacity;
				while (capacity < pending_length + take) capacity *= 2;
				char *grown = realloc(pending, capacity);
				if (grown == NULL) {
					fprintf(stderr, "out of memory buffering a request\n");
					status = 1;
					failed = true;
					break;
				}
				pending = grown;
				pending_capacity = capacity;
			}
			memcpy(pending + pending_length, cursor, take);
			pending_length += take;
			cursor += step;
			remaining -= step;
			if (newline == NULL) break; /* the rest of this line is in the next read */
			if (pending_length > 0) handle_line(&context, pending, pending_length);
			pending_length = 0;
		}
		if (failed) break;
		/* A request that killed the connection cannot be followed by another that
		 * works; the supervisor's restart is what recovers a live display. */
		if (helper_wayland_broken(wayland)) {
			fprintf(stderr, "the Wayland connection was lost\n");
			status = 1;
			break;
		}
	}

	free(pending);
	helper_wayland_destroy(wayland);
	return status;
}
