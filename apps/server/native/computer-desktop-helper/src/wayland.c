#define _GNU_SOURCE

#include "wayland.h"

#include <errno.h>
#include <fcntl.h>
#include <math.h>
#include <poll.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <time.h>
#include <unistd.h>

#include <wayland-client.h>
#include <xkbcommon/xkbcommon.h>

#include "ext-idle-notify-v1-client-protocol.h"
#include "virtual-keyboard-unstable-v1-client-protocol.h"
#include "wlr-foreign-toplevel-management-unstable-v1-client-protocol.h"
#include "wlr-screencopy-unstable-v1-client-protocol.h"
#include "wlr-virtual-pointer-unstable-v1-client-protocol.h"
#include "xdg-output-unstable-v1-client-protocol.h"

/*
 * The whole budget for one capture request, however many outputs it spans. Per
 * output would be the wrong shape: a four-monitor desktop would then be allowed
 * four times as long as the caller waits, and the caller's own 15 s deadline
 * would fire first and leave this process still talking to the compositor.
 */
#define CAPTURE_BUDGET_MS 10000
/* Pixels per wheel notch. The tool surface speaks pixels; a wheel speaks
 * notches, and toolkits ignore a wheel event that carries neither. These are
 * content pixels, what a page moves per click (about 86 in Firefox on Wayland,
 * 80 in Chromium), not the 15 wire units libinput reports per click: those are
 * degrees, which every toolkit scales up, and taking them for pixels made each
 * scroll several times longer than asked. Keep in sync with SCROLL_STEP_PX in
 * apps/server/src/computer/scrollUnits.ts, which carries the full rationale. */
#define SCROLL_STEP_PX 80.0
/* What one notch is worth on the continuous axis: libinput's wheel unit is
 * degrees of rotation, 15 per click, and that is the scale every client
 * expects in wl_pointer.axis. */
#define AXIS_UNITS_PER_NOTCH 15.0
/* The furthest one scroll request may travel. wl_fixed_from_double is only
 * defined for what an int32 of 1/256ths holds, and no human gesture is a
 * thousand notches long. */
#define SCROLL_LIMIT_PX 10000.0

struct helper_global {
	char *interface;
	uint32_t name;
	uint32_t version;
	struct helper_global *next;
};

struct helper_output {
	struct wl_output *output;
	struct zxdg_output_v1 *xdg_output;
	uint32_t registry_name;
	uint32_t version;
	char *label;
	int32_t geometry_x;
	int32_t geometry_y;
	int32_t mode_width;
	int32_t mode_height;
	int32_t scale;
	int32_t logical_x;
	int32_t logical_y;
	int32_t logical_width;
	int32_t logical_height;
	bool has_logical_position;
	bool has_logical_size;
	struct helper_output *next;
};

struct helper_toplevel {
	struct zwlr_foreign_toplevel_handle_v1 *handle;
	char id[40];
	char *title;
	char *app_id;
	bool activated;
	bool minimized;
	bool maximized;
	bool fullscreen;
	bool closed;
	struct helper_toplevel *next;
};

/* One held button or key, so a disposed helper does not strand a modifier down
 * on the human's real keyboard. */
struct helper_held {
	uint32_t code;
	struct helper_held *next;
};

struct helper_wayland {
	struct wl_display *display;
	struct wl_registry *registry;
	struct helper_global *globals;

	/* Every singleton carries the registry name it was bound under, because
	 * `global_remove` names a global and nothing else: without it a withdrawn
	 * interface would leave this side holding a proxy to an object the
	 * compositor has already forgotten. */
	struct wl_shm *shm;
	uint32_t shm_name;
	struct wl_seat *seat;
	uint32_t seat_name;
	uint32_t seat_version;
	struct helper_output *outputs;
	struct zxdg_output_manager_v1 *xdg_output_manager;
	uint32_t xdg_output_manager_name;

	struct zwlr_virtual_pointer_manager_v1 *pointer_manager;
	uint32_t pointer_manager_name;
	struct zwlr_virtual_pointer_v1 *pointer;
	struct zwp_virtual_keyboard_manager_v1 *keyboard_manager;
	uint32_t keyboard_manager_name;
	struct zwp_virtual_keyboard_v1 *keyboard;
	struct xkb_context *xkb_context;
	struct xkb_keymap *xkb_keymap;
	struct xkb_state *xkb_state;
	uint32_t modifiers_depressed;
	uint32_t modifiers_latched;
	uint32_t modifiers_locked;
	uint32_t modifiers_group;

	struct zwlr_screencopy_manager_v1 *screencopy_manager;
	uint32_t screencopy_manager_name;
	uint32_t screencopy_version;

	struct zwlr_foreign_toplevel_manager_v1 *toplevel_manager;
	uint32_t toplevel_manager_name;
	struct helper_toplevel *toplevels;
	uint32_t next_toplevel_id;

	struct ext_idle_notifier_v1 *idle_notifier;
	uint32_t idle_notifier_name;
	uint32_t idle_notifier_version;
	/* Held open between requests because the protocol only pushes transitions:
	 * a notification created per query would report the seat as active for its
	 * whole timeout, whatever the human was doing. */
	struct ext_idle_notification_v1 *idle_notification;
	uint32_t idle_timeout_ms;
	bool idle;
	bool idle_observed;
	int64_t idle_since_ms;

	struct helper_held *held_buttons;
	struct helper_held *held_keys;

	/* Sub-notch scroll owed to the discrete half of a wheel event. See
	 * `take_discrete_steps`. */
	double axis_remainder_v;
	double axis_remainder_h;

	struct timespec started_at;
	bool broken;
};

void helper_error_set(helper_error *error, helper_refusal kind, const char *format, ...) {
	if (error == NULL) return;
	error->kind = kind;
	va_list arguments;
	va_start(arguments, format);
	vsnprintf(error->message, sizeof(error->message), format, arguments);
	va_end(arguments);
}

/* The connection failing under a request is always the same refusal, and it is
 * the one that also condemns the process. */
static bool connection_failed(helper_wayland *state, helper_error *error, const char *what) {
	state->broken = true;
	helper_error_set(error, HELPER_REFUSAL_TRANSIENT, "%s: %s", what, strerror(errno));
	return false;
}

static int64_t monotonic_ms(void) {
	struct timespec now;
	clock_gettime(CLOCK_MONOTONIC, &now);
	return (int64_t)now.tv_sec * 1000 + now.tv_nsec / 1000000;
}

static uint32_t now_ms(const helper_wayland *state) {
	struct timespec now;
	clock_gettime(CLOCK_MONOTONIC, &now);
	int64_t elapsed = (int64_t)(now.tv_sec - state->started_at.tv_sec) * 1000 +
	                  (now.tv_nsec - state->started_at.tv_nsec) / 1000000;
	return (uint32_t)elapsed;
}

static char *duplicate(const char *text) {
	if (text == NULL) return NULL;
	size_t size = strlen(text) + 1;
	char *copy = malloc(size);
	if (copy != NULL) memcpy(copy, text, size);
	return copy;
}

// ── Outputs ──────────────────────────────────────────────────────────

/*
 * The logical rect is what every coordinate in the tool surface is expressed
 * in. `xdg_output` reports it directly and is the only correct source under
 * fractional scaling; `wl_output`'s physical mode divided by the integer scale
 * is the fallback for a compositor that does not advertise xdg-output.
 */
static helper_box output_box(const struct helper_output *output) {
	helper_box box = {.x = output->geometry_x, .y = output->geometry_y, .width = 0, .height = 0};
	if (output->has_logical_position) {
		box.x = output->logical_x;
		box.y = output->logical_y;
	}
	if (output->has_logical_size && output->logical_width > 0 && output->logical_height > 0) {
		box.width = output->logical_width;
		box.height = output->logical_height;
		return box;
	}
	int32_t scale = output->scale > 0 ? output->scale : 1;
	box.width = output->mode_width / scale;
	box.height = output->mode_height / scale;
	return box;
}

/*
 * Whether a box can take part in the geometry below at all. A compositor is
 * free to report an output anywhere in the int32 plane, and two such boxes
 * unioned would overflow; skipping the implausible ones keeps every union and
 * intersection in this file provably inside an int32.
 */
static bool box_usable(helper_box box) {
	if (box.width <= 0 || box.height <= 0) return false;
	int64_t right = (int64_t)box.x + box.width;
	int64_t bottom = (int64_t)box.y + box.height;
	return box.x >= -HELPER_COORDINATE_LIMIT && box.y >= -HELPER_COORDINATE_LIMIT &&
	       right <= HELPER_COORDINATE_LIMIT && bottom <= HELPER_COORDINATE_LIMIT;
}

/*
 * Physical pixels per logical pixel, which the integer `scale` only
 * approximates once a compositor allows fractional scaling.
 *
 * Bounded because it is a ratio of two numbers the compositor chooses: a mode
 * of 2^31 over a logical width of 1 would otherwise multiply the capture's
 * destination size past anything a uint32 can hold. No display has ever been
 * outside this range, so clamping costs nothing real.
 */
#define OUTPUT_SCALE_LIMIT 16.0

static double output_pixel_scale(const struct helper_output *output) {
	double scale = output->scale > 0 ? (double)output->scale : 1.0;
	helper_box box = output_box(output);
	if (box.width > 0 && output->mode_width > 0) {
		scale = (double)output->mode_width / (double)box.width;
	}
	if (scale > OUTPUT_SCALE_LIMIT) return OUTPUT_SCALE_LIMIT;
	if (scale < 1.0 / OUTPUT_SCALE_LIMIT) return 1.0 / OUTPUT_SCALE_LIMIT;
	return scale;
}

static void output_geometry(void *data, struct wl_output *wl_output, int32_t x, int32_t y,
                            int32_t physical_width, int32_t physical_height, int32_t subpixel,
                            const char *make, const char *model, int32_t transform) {
	(void)wl_output;
	(void)physical_width;
	(void)physical_height;
	(void)subpixel;
	(void)make;
	(void)model;
	(void)transform;
	struct helper_output *output = data;
	output->geometry_x = x;
	output->geometry_y = y;
}

static void output_mode(void *data, struct wl_output *wl_output, uint32_t flags, int32_t width,
                        int32_t height, int32_t refresh) {
	(void)wl_output;
	(void)refresh;
	struct helper_output *output = data;
	if ((flags & WL_OUTPUT_MODE_CURRENT) == 0) return;
	output->mode_width = width;
	output->mode_height = height;
}

static void output_done(void *data, struct wl_output *wl_output) {
	(void)data;
	(void)wl_output;
}

static void output_scale(void *data, struct wl_output *wl_output, int32_t factor) {
	(void)wl_output;
	struct helper_output *output = data;
	output->scale = factor;
}

static void output_name(void *data, struct wl_output *wl_output, const char *name) {
	(void)wl_output;
	struct helper_output *output = data;
	free(output->label);
	output->label = duplicate(name);
}

static void output_description(void *data, struct wl_output *wl_output, const char *description) {
	(void)data;
	(void)wl_output;
	(void)description;
}

static const struct wl_output_listener output_listener = {
	.geometry = output_geometry,
	.mode = output_mode,
	.done = output_done,
	.scale = output_scale,
	.name = output_name,
	.description = output_description,
};

static void xdg_output_logical_position(void *data, struct zxdg_output_v1 *xdg_output, int32_t x,
                                        int32_t y) {
	(void)xdg_output;
	struct helper_output *output = data;
	output->logical_x = x;
	output->logical_y = y;
	output->has_logical_position = true;
}

static void xdg_output_logical_size(void *data, struct zxdg_output_v1 *xdg_output, int32_t width,
                                    int32_t height) {
	(void)xdg_output;
	struct helper_output *output = data;
	output->logical_width = width;
	output->logical_height = height;
	output->has_logical_size = true;
}

static void xdg_output_done(void *data, struct zxdg_output_v1 *xdg_output) {
	(void)data;
	(void)xdg_output;
}

static void xdg_output_name(void *data, struct zxdg_output_v1 *xdg_output, const char *name) {
	(void)xdg_output;
	struct helper_output *output = data;
	if (output->label == NULL) output->label = duplicate(name);
}

static void xdg_output_description(void *data, struct zxdg_output_v1 *xdg_output,
                                   const char *description) {
	(void)data;
	(void)xdg_output;
	(void)description;
}

static const struct zxdg_output_v1_listener xdg_output_listener = {
	.logical_position = xdg_output_logical_position,
	.logical_size = xdg_output_logical_size,
	.done = xdg_output_done,
	.name = xdg_output_name,
	.description = xdg_output_description,
};

static void bind_xdg_output(helper_wayland *state, struct helper_output *output) {
	if (state->xdg_output_manager == NULL || output->xdg_output != NULL) return;
	output->xdg_output = zxdg_output_manager_v1_get_xdg_output(state->xdg_output_manager,
	                                                           output->output);
	/* A NULL proxy is libwayland out of memory. The output keeps its wl_output
	 * geometry, which is the documented fallback anyway. */
	if (output->xdg_output == NULL) return;
	zxdg_output_v1_add_listener(output->xdg_output, &xdg_output_listener, output);
}

static void destroy_output(struct helper_output *output) {
	if (output->xdg_output != NULL) zxdg_output_v1_destroy(output->xdg_output);
	/* `release` only exists from wl_output version 3; sending it to an older
	 * global is a protocol error that kills the whole connection. */
	if (output->version >= 3) {
		wl_output_release(output->output);
	} else {
		wl_output_destroy(output->output);
	}
	free(output->label);
	free(output);
}

// ── Toplevels ────────────────────────────────────────────────────────

static void toplevel_title(void *data, struct zwlr_foreign_toplevel_handle_v1 *handle,
                           const char *title) {
	(void)handle;
	struct helper_toplevel *toplevel = data;
	free(toplevel->title);
	toplevel->title = duplicate(title);
}

static void toplevel_app_id(void *data, struct zwlr_foreign_toplevel_handle_v1 *handle,
                            const char *app_id) {
	(void)handle;
	struct helper_toplevel *toplevel = data;
	free(toplevel->app_id);
	toplevel->app_id = duplicate(app_id);
}

static void toplevel_output_enter(void *data, struct zwlr_foreign_toplevel_handle_v1 *handle,
                                  struct wl_output *output) {
	(void)data;
	(void)handle;
	(void)output;
}

static void toplevel_output_leave(void *data, struct zwlr_foreign_toplevel_handle_v1 *handle,
                                  struct wl_output *output) {
	(void)data;
	(void)handle;
	(void)output;
}

static void toplevel_state(void *data, struct zwlr_foreign_toplevel_handle_v1 *handle,
                           struct wl_array *states) {
	(void)handle;
	struct helper_toplevel *toplevel = data;
	toplevel->activated = false;
	toplevel->minimized = false;
	toplevel->maximized = false;
	toplevel->fullscreen = false;
	uint32_t *entry;
	wl_array_for_each(entry, states) {
		switch (*entry) {
		case ZWLR_FOREIGN_TOPLEVEL_HANDLE_V1_STATE_MAXIMIZED: toplevel->maximized = true; break;
		case ZWLR_FOREIGN_TOPLEVEL_HANDLE_V1_STATE_MINIMIZED: toplevel->minimized = true; break;
		case ZWLR_FOREIGN_TOPLEVEL_HANDLE_V1_STATE_ACTIVATED: toplevel->activated = true; break;
		case ZWLR_FOREIGN_TOPLEVEL_HANDLE_V1_STATE_FULLSCREEN: toplevel->fullscreen = true; break;
		default: break;
		}
	}
}

static void toplevel_done(void *data, struct zwlr_foreign_toplevel_handle_v1 *handle) {
	(void)data;
	(void)handle;
}

static void toplevel_closed(void *data, struct zwlr_foreign_toplevel_handle_v1 *handle) {
	(void)handle;
	struct helper_toplevel *toplevel = data;
	toplevel->closed = true;
}

static void toplevel_parent(void *data, struct zwlr_foreign_toplevel_handle_v1 *handle,
                            struct zwlr_foreign_toplevel_handle_v1 *parent) {
	(void)data;
	(void)handle;
	(void)parent;
}

static const struct zwlr_foreign_toplevel_handle_v1_listener toplevel_listener = {
	.title = toplevel_title,
	.app_id = toplevel_app_id,
	.output_enter = toplevel_output_enter,
	.output_leave = toplevel_output_leave,
	.state = toplevel_state,
	.done = toplevel_done,
	.closed = toplevel_closed,
	.parent = toplevel_parent,
};

static void toplevel_manager_toplevel(void *data,
                                      struct zwlr_foreign_toplevel_manager_v1 *manager,
                                      struct zwlr_foreign_toplevel_handle_v1 *handle) {
	(void)manager;
	helper_wayland *state = data;
	struct helper_toplevel *toplevel = calloc(1, sizeof(struct helper_toplevel));
	if (toplevel == NULL) {
		zwlr_foreign_toplevel_handle_v1_destroy(handle);
		return;
	}
	toplevel->handle = handle;
	snprintf(toplevel->id, sizeof(toplevel->id), "wlr-toplevel-%u", state->next_toplevel_id++);
	toplevel->next = state->toplevels;
	state->toplevels = toplevel;
	zwlr_foreign_toplevel_handle_v1_add_listener(handle, &toplevel_listener, toplevel);
}

static void toplevel_manager_finished(void *data,
                                      struct zwlr_foreign_toplevel_manager_v1 *manager) {
	helper_wayland *state = data;
	zwlr_foreign_toplevel_manager_v1_destroy(manager);
	if (state->toplevel_manager == manager) state->toplevel_manager = NULL;
}

static const struct zwlr_foreign_toplevel_manager_v1_listener toplevel_manager_listener = {
	.toplevel = toplevel_manager_toplevel,
	.finished = toplevel_manager_finished,
};

static void destroy_toplevel(struct helper_toplevel *toplevel) {
	zwlr_foreign_toplevel_handle_v1_destroy(toplevel->handle);
	free(toplevel->title);
	free(toplevel->app_id);
	free(toplevel);
}

/* A closed toplevel is dropped here rather than in the `closed` event, because
 * destroying a handle from inside its own listener is a use-after-free. */
static void reap_closed_toplevels(helper_wayland *state) {
	struct helper_toplevel **cursor = &state->toplevels;
	while (*cursor != NULL) {
		struct helper_toplevel *toplevel = *cursor;
		if (!toplevel->closed) {
			cursor = &toplevel->next;
			continue;
		}
		*cursor = toplevel->next;
		destroy_toplevel(toplevel);
	}
}

static void drop_all_toplevels(helper_wayland *state) {
	while (state->toplevels != NULL) {
		struct helper_toplevel *toplevel = state->toplevels;
		state->toplevels = toplevel->next;
		destroy_toplevel(toplevel);
	}
}

// ── Idle notification ────────────────────────────────────────────────

/*
 * The two transitions the compositor pushes are the whole protocol: there is no
 * request that asks how long the seat has been quiet, so the state one of these
 * last established, and the moment it did, is all this helper can ever know.
 */
static void idle_notification_idled(void *data, struct ext_idle_notification_v1 *notification) {
	(void)notification;
	helper_wayland *state = data;
	state->idle = true;
	state->idle_observed = true;
	state->idle_since_ms = monotonic_ms();
}

static void idle_notification_resumed(void *data, struct ext_idle_notification_v1 *notification) {
	(void)notification;
	helper_wayland *state = data;
	state->idle = false;
	state->idle_observed = true;
	state->idle_since_ms = monotonic_ms();
}

static const struct ext_idle_notification_v1_listener idle_notification_listener = {
	.idled = idle_notification_idled,
	.resumed = idle_notification_resumed,
};

/*
 * Drops the notification and everything it established.
 *
 * Both callers have lost the thing it was watching — the seat, the notifier, or
 * the connection — so the remembered transition no longer describes anything.
 * Keeping it would let a stale `idled` answer a later query as though the human
 * were still away.
 */
static void drop_idle_notification(helper_wayland *state) {
	if (state->idle_notification != NULL) {
		ext_idle_notification_v1_destroy(state->idle_notification);
		state->idle_notification = NULL;
	}
	state->idle_timeout_ms = 0;
	state->idle = false;
	state->idle_observed = false;
	state->idle_since_ms = 0;
}

// ── Registry ─────────────────────────────────────────────────────────

static void registry_global(void *data, struct wl_registry *registry, uint32_t name,
                            const char *interface, uint32_t version) {
	helper_wayland *state = data;

	struct helper_global *global = calloc(1, sizeof(struct helper_global));
	if (global != NULL) {
		global->interface = duplicate(interface);
		global->name = name;
		global->version = version;
		global->next = state->globals;
		state->globals = global;
	}

	/* Every branch below binds only into an empty slot. A compositor may
	 * advertise two globals of the same interface, and overwriting the field
	 * would leak the first proxy and strand everything already built on it. */
	if (strcmp(interface, wl_shm_interface.name) == 0) {
		if (state->shm != NULL) return;
		state->shm = wl_registry_bind(registry, name, &wl_shm_interface, 1);
		state->shm_name = name;
	} else if (strcmp(interface, wl_seat_interface.name) == 0) {
		if (state->seat != NULL) return;
		state->seat_version = version < 7 ? version : 7;
		state->seat = wl_registry_bind(registry, name, &wl_seat_interface, state->seat_version);
		state->seat_name = name;
	} else if (strcmp(interface, wl_output_interface.name) == 0) {
		struct helper_output *output = calloc(1, sizeof(struct helper_output));
		if (output == NULL) return;
		output->registry_name = name;
		output->scale = 1;
		output->version = version < 4 ? version : 4;
		output->output = wl_registry_bind(registry, name, &wl_output_interface, output->version);
		if (output->output == NULL) {
			free(output);
			return;
		}
		wl_output_add_listener(output->output, &output_listener, output);
		output->next = state->outputs;
		state->outputs = output;
		bind_xdg_output(state, output);
	} else if (strcmp(interface, zxdg_output_manager_v1_interface.name) == 0) {
		if (state->xdg_output_manager != NULL) return;
		state->xdg_output_manager = wl_registry_bind(registry, name, &zxdg_output_manager_v1_interface,
		                                            version < 3 ? version : 3);
		state->xdg_output_manager_name = name;
		for (struct helper_output *output = state->outputs; output != NULL; output = output->next) {
			bind_xdg_output(state, output);
		}
	} else if (strcmp(interface, zwlr_virtual_pointer_manager_v1_interface.name) == 0) {
		if (state->pointer_manager != NULL) return;
		state->pointer_manager = wl_registry_bind(registry, name,
		                                          &zwlr_virtual_pointer_manager_v1_interface,
		                                          version < 2 ? version : 2);
		state->pointer_manager_name = name;
	} else if (strcmp(interface, zwp_virtual_keyboard_manager_v1_interface.name) == 0) {
		if (state->keyboard_manager != NULL) return;
		state->keyboard_manager = wl_registry_bind(registry, name,
		                                           &zwp_virtual_keyboard_manager_v1_interface, 1);
		state->keyboard_manager_name = name;
	} else if (strcmp(interface, zwlr_screencopy_manager_v1_interface.name) == 0) {
		if (state->screencopy_manager != NULL) return;
		state->screencopy_version = version < 3 ? version : 3;
		state->screencopy_manager = wl_registry_bind(registry, name,
		                                             &zwlr_screencopy_manager_v1_interface,
		                                             state->screencopy_version);
		state->screencopy_manager_name = name;
	} else if (strcmp(interface, zwlr_foreign_toplevel_manager_v1_interface.name) == 0) {
		if (state->toplevel_manager != NULL) return;
		state->toplevel_manager = wl_registry_bind(registry, name,
		                                           &zwlr_foreign_toplevel_manager_v1_interface,
		                                           version < 3 ? version : 3);
		state->toplevel_manager_name = name;
		if (state->toplevel_manager == NULL) return;
		zwlr_foreign_toplevel_manager_v1_add_listener(state->toplevel_manager,
		                                              &toplevel_manager_listener, state);
	} else if (strcmp(interface, ext_idle_notifier_v1_interface.name) == 0) {
		if (state->idle_notifier != NULL) return;
		state->idle_notifier_version = version < 2 ? version : 2;
		state->idle_notifier = wl_registry_bind(registry, name, &ext_idle_notifier_v1_interface,
		                                        state->idle_notifier_version);
		state->idle_notifier_name = name;
	}
}

/* Defined with the input code they belong to; needed here because a withdrawn
 * seat takes the devices built on it with it. */
static void forget_virtual_devices(helper_wayland *state);

/*
 * A withdrawn global is the compositor saying the object behind it is gone.
 * Anything still holding the proxy would be sending requests into a dead
 * object, which is a protocol error that kills the whole connection — so the
 * proxy is destroyed, the field is cleared, and the next request refuses with
 * the same sentence it would have used had the interface never been advertised.
 */
static void registry_global_remove(void *data, struct wl_registry *registry, uint32_t name) {
	(void)registry;
	helper_wayland *state = data;

	if (state->shm != NULL && state->shm_name == name) {
		wl_shm_destroy(state->shm);
		state->shm = NULL;
	}
	if (state->seat != NULL && state->seat_name == name) {
		/* The virtual devices go first: they were created on this seat, and the
		 * compositor has already dropped whatever they were holding down. */
		forget_virtual_devices(state);
		/* The idle notification was created on this seat too, so it is watching
		 * an object the compositor has forgotten. */
		drop_idle_notification(state);
		/* `release` only exists from wl_seat version 5, and sending it to an
		 * older global is a protocol error. */
		if (state->seat_version >= 5) {
			wl_seat_release(state->seat);
		} else {
			wl_seat_destroy(state->seat);
		}
		state->seat = NULL;
	}
	if (state->xdg_output_manager != NULL && state->xdg_output_manager_name == name) {
		/* The per-output zxdg_output_v1 objects outlive their manager; they are
		 * destroyed with the output that owns them. */
		zxdg_output_manager_v1_destroy(state->xdg_output_manager);
		state->xdg_output_manager = NULL;
	}
	if (state->pointer_manager != NULL && state->pointer_manager_name == name) {
		zwlr_virtual_pointer_manager_v1_destroy(state->pointer_manager);
		state->pointer_manager = NULL;
	}
	if (state->keyboard_manager != NULL && state->keyboard_manager_name == name) {
		zwp_virtual_keyboard_manager_v1_destroy(state->keyboard_manager);
		state->keyboard_manager = NULL;
	}
	if (state->screencopy_manager != NULL && state->screencopy_manager_name == name) {
		zwlr_screencopy_manager_v1_destroy(state->screencopy_manager);
		state->screencopy_manager = NULL;
	}
	if (state->toplevel_manager != NULL && state->toplevel_manager_name == name) {
		zwlr_foreign_toplevel_manager_v1_destroy(state->toplevel_manager);
		state->toplevel_manager = NULL;
		/* The handles came from this manager, so the window list is no longer a
		 * description of anything. Reporting it as one would be the lie this
		 * helper is not allowed to tell. */
		drop_all_toplevels(state);
	}
	if (state->idle_notifier != NULL && state->idle_notifier_name == name) {
		/* The notification outlives its manager by the letter of the protocol,
		 * but nothing is left to answer for it, so it goes with the manager. */
		drop_idle_notification(state);
		ext_idle_notifier_v1_destroy(state->idle_notifier);
		state->idle_notifier = NULL;
		state->idle_notifier_version = 0;
	}

	struct helper_global **global_cursor = &state->globals;
	while (*global_cursor != NULL) {
		struct helper_global *global = *global_cursor;
		if (global->name != name) {
			global_cursor = &global->next;
			continue;
		}
		*global_cursor = global->next;
		free(global->interface);
		free(global);
	}

	struct helper_output **cursor = &state->outputs;
	while (*cursor != NULL) {
		struct helper_output *output = *cursor;
		if (output->registry_name != name) {
			cursor = &output->next;
			continue;
		}
		*cursor = output->next;
		destroy_output(output);
	}
}

static const struct wl_registry_listener registry_listener = {
	.global = registry_global,
	.global_remove = registry_global_remove,
};

// ── Connection lifecycle ─────────────────────────────────────────────

helper_wayland *helper_wayland_connect(helper_error *error) {
	helper_wayland *state = calloc(1, sizeof(helper_wayland));
	if (state == NULL) {
		helper_error_set(error, HELPER_REFUSAL_TRANSIENT, "out of memory");
		return NULL;
	}
	clock_gettime(CLOCK_MONOTONIC, &state->started_at);
	state->next_toplevel_id = 1;
	state->display = wl_display_connect(NULL);
	if (state->display == NULL) {
		const char *socket = getenv("WAYLAND_DISPLAY");
		helper_error_set(error, HELPER_REFUSAL_UNSUPPORTED,
		                 "could not connect to the Wayland display %s (WAYLAND_DISPLAY=%s, "
		                 "XDG_RUNTIME_DIR=%s)",
		                 socket == NULL ? "socket" : socket, socket == NULL ? "unset" : socket,
		                 getenv("XDG_RUNTIME_DIR") == NULL ? "unset" : getenv("XDG_RUNTIME_DIR"));
		free(state);
		return NULL;
	}
	state->registry = wl_display_get_registry(state->display);
	wl_registry_add_listener(state->registry, &registry_listener, state);
	/* Twice: the first round brings the globals in, the second brings the
	 * events the objects bound during the first round emit — output modes,
	 * xdg-output logical geometry, and the initial toplevel list. */
	if (wl_display_roundtrip(state->display) < 0 || wl_display_roundtrip(state->display) < 0) {
		helper_error_set(error, HELPER_REFUSAL_TRANSIENT,
		                 "the Wayland connection failed during startup: %s", strerror(errno));
		helper_wayland_destroy(state);
		return NULL;
	}
	return state;
}

void helper_wayland_destroy(helper_wayland *state) {
	if (state == NULL) return;
	helper_wayland_release_all(state);

	drop_all_toplevels(state);
	while (state->outputs != NULL) {
		struct helper_output *output = state->outputs;
		state->outputs = output->next;
		destroy_output(output);
	}
	while (state->globals != NULL) {
		struct helper_global *global = state->globals;
		state->globals = global->next;
		free(global->interface);
		free(global);
	}

	drop_idle_notification(state);
	if (state->idle_notifier != NULL) ext_idle_notifier_v1_destroy(state->idle_notifier);
	if (state->pointer != NULL) zwlr_virtual_pointer_v1_destroy(state->pointer);
	if (state->keyboard != NULL) zwp_virtual_keyboard_v1_destroy(state->keyboard);
	if (state->xkb_state != NULL) xkb_state_unref(state->xkb_state);
	if (state->xkb_keymap != NULL) xkb_keymap_unref(state->xkb_keymap);
	if (state->xkb_context != NULL) xkb_context_unref(state->xkb_context);
	if (state->display != NULL) {
		wl_display_flush(state->display);
		wl_display_disconnect(state->display);
	}
	free(state);
}

int helper_wayland_fd(const helper_wayland *state) {
	return wl_display_get_fd(state->display);
}

bool helper_wayland_broken(const helper_wayland *state) {
	return state->broken;
}

bool helper_wayland_prepare(helper_wayland *state) {
	while (wl_display_prepare_read(state->display) != 0) {
		if (wl_display_dispatch_pending(state->display) < 0) return false;
	}
	if (wl_display_flush(state->display) < 0 && errno != EAGAIN) {
		wl_display_cancel_read(state->display);
		return false;
	}
	return true;
}

bool helper_wayland_read(helper_wayland *state, bool readable) {
	if (readable) {
		if (wl_display_read_events(state->display) < 0) return false;
	} else {
		wl_display_cancel_read(state->display);
	}
	if (wl_display_dispatch_pending(state->display) < 0) return false;
	reap_closed_toplevels(state);
	return true;
}

/*
 * Dispatches until `done` flips or the deadline passes. Used by capture, which
 * is the only request that has to wait on the compositor rather than the
 * caller. The deadline is absolute and shared by every wait one request makes,
 * so a capture spanning four outputs costs the same wall clock as one spanning
 * a single output.
 */
static bool wait_for(helper_wayland *state, const bool *done, int64_t deadline_ms,
                     helper_error *error) {
	while (!*done) {
		while (wl_display_prepare_read(state->display) != 0) {
			if (wl_display_dispatch_pending(state->display) < 0) {
				return connection_failed(state, error, "the Wayland connection failed");
			}
			if (*done) return true;
		}
		if (wl_display_flush(state->display) < 0 && errno != EAGAIN) {
			wl_display_cancel_read(state->display);
			return connection_failed(state, error, "the Wayland connection could not be flushed");
		}
		int64_t remaining = deadline_ms - monotonic_ms();
		if (remaining <= 0) {
			wl_display_cancel_read(state->display);
			helper_error_set(error, HELPER_REFUSAL_TRANSIENT,
			                 "the compositor did not answer within %d ms", CAPTURE_BUDGET_MS);
			return false;
		}
		struct pollfd descriptor = {.fd = wl_display_get_fd(state->display), .events = POLLIN,
		                            .revents = 0};
		int ready = poll(&descriptor, 1, (int)remaining);
		if (ready < 0) {
			wl_display_cancel_read(state->display);
			if (errno == EINTR) continue;
			return connection_failed(state, error, "waiting on the Wayland connection failed");
		}
		if (ready == 0) {
			wl_display_cancel_read(state->display);
			helper_error_set(error, HELPER_REFUSAL_TRANSIENT,
			                 "the compositor did not answer within %d ms", CAPTURE_BUDGET_MS);
			return false;
		}
		if (wl_display_read_events(state->display) < 0 ||
		    wl_display_dispatch_pending(state->display) < 0) {
			return connection_failed(state, error, "the Wayland connection failed");
		}
	}
	return true;
}

// ── Globals, outputs, workspace ──────────────────────────────────────

void helper_wayland_write_globals(const helper_wayland *state, json_writer *writer) {
	jw_char(writer, '[');
	bool first = true;
	for (const struct helper_global *global = state->globals; global != NULL; global = global->next) {
		if (!first) jw_char(writer, ',');
		first = false;
		jw_raw(writer, "{\"interface\":");
		jw_string(writer, global->interface);
		jw_raw(writer, ",\"name\":");
		jw_int(writer, global->name);
		jw_raw(writer, ",\"version\":");
		jw_int(writer, global->version);
		jw_char(writer, '}');
	}
	jw_char(writer, ']');
}

void helper_wayland_write_outputs(const helper_wayland *state, json_writer *writer) {
	jw_char(writer, '[');
	bool first = true;
	for (const struct helper_output *output = state->outputs; output != NULL;
	     output = output->next) {
		helper_box box = output_box(output);
		if (!first) jw_char(writer, ',');
		first = false;
		jw_raw(writer, "{\"name\":");
		jw_string(writer, output->label == NULL ? "" : output->label);
		jw_raw(writer, ",\"x\":");
		jw_int(writer, box.x);
		jw_raw(writer, ",\"y\":");
		jw_int(writer, box.y);
		jw_raw(writer, ",\"width\":");
		jw_int(writer, box.width);
		jw_raw(writer, ",\"height\":");
		jw_int(writer, box.height);
		jw_raw(writer, ",\"scale\":");
		jw_number(writer, output_pixel_scale(output));
		jw_char(writer, '}');
	}
	jw_char(writer, ']');
}

bool helper_wayland_workspace(const helper_wayland *state, helper_box *out, helper_error *error) {
	bool any = false;
	int32_t left = 0;
	int32_t top = 0;
	int32_t right = 0;
	int32_t bottom = 0;
	for (const struct helper_output *output = state->outputs; output != NULL;
	     output = output->next) {
		helper_box box = output_box(output);
		if (!box_usable(box)) continue;
		if (!any) {
			left = box.x;
			top = box.y;
			right = box.x + box.width;
			bottom = box.y + box.height;
			any = true;
			continue;
		}
		if (box.x < left) left = box.x;
		if (box.y < top) top = box.y;
		if (box.x + box.width > right) right = box.x + box.width;
		if (box.y + box.height > bottom) bottom = box.y + box.height;
	}
	if (!any) {
		/* Transient rather than unsupported: a desktop with every monitor asleep
		 * or mid-hotplug looks exactly like this and comes back on its own. */
		helper_error_set(error, HELPER_REFUSAL_TRANSIENT,
		                 "the compositor advertises no output with a usable size, so the desktop has "
		                 "no coordinate space to work in");
		return false;
	}
	out->x = left;
	out->y = top;
	out->width = right - left;
	out->height = bottom - top;
	return true;
}

// ── Input ────────────────────────────────────────────────────────────

static void remember_held(struct helper_held **list, uint32_t code, bool pressed) {
	if (pressed) {
		for (struct helper_held *held = *list; held != NULL; held = held->next) {
			if (held->code == code) return;
		}
		struct helper_held *held = calloc(1, sizeof(struct helper_held));
		if (held == NULL) return;
		held->code = code;
		held->next = *list;
		*list = held;
		return;
	}
	struct helper_held **cursor = list;
	while (*cursor != NULL) {
		struct helper_held *held = *cursor;
		if (held->code == code) {
			*cursor = held->next;
			free(held);
			return;
		}
		cursor = &held->next;
	}
}

static void forget_held(struct helper_held **list) {
	while (*list != NULL) {
		struct helper_held *held = *list;
		*list = held->next;
		free(held);
	}
}

/* Drops the xkb objects so the next `ensure_keyboard` builds them afresh. Every
 * failure path in there runs through this: retrying without it would leak a
 * context, a keymap and a state per attempt. */
static void reset_keymap(helper_wayland *state) {
	if (state->xkb_state != NULL) xkb_state_unref(state->xkb_state);
	if (state->xkb_keymap != NULL) xkb_keymap_unref(state->xkb_keymap);
	if (state->xkb_context != NULL) xkb_context_unref(state->xkb_context);
	state->xkb_state = NULL;
	state->xkb_keymap = NULL;
	state->xkb_context = NULL;
	state->modifiers_depressed = 0;
	state->modifiers_latched = 0;
	state->modifiers_locked = 0;
	state->modifiers_group = 0;
}

/*
 * Drops the virtual devices without sending releases first.
 *
 * The only caller is the seat going away, and the compositor releases a virtual
 * device's held keys when the device dies. Sending on an object whose seat the
 * compositor has already destroyed would be a protocol error, which costs the
 * whole connection rather than one keystroke.
 */
static void forget_virtual_devices(helper_wayland *state) {
	if (state->pointer != NULL) {
		zwlr_virtual_pointer_v1_destroy(state->pointer);
		state->pointer = NULL;
	}
	if (state->keyboard != NULL) {
		zwp_virtual_keyboard_v1_destroy(state->keyboard);
		state->keyboard = NULL;
	}
	forget_held(&state->held_keys);
	forget_held(&state->held_buttons);
	/* A balance carried against a pointer that no longer exists would be spent
	 * by the next one, handing the human a notch nobody scrolled. */
	state->axis_remainder_v = 0;
	state->axis_remainder_h = 0;
	reset_keymap(state);
}

static bool ensure_pointer(helper_wayland *state, helper_error *error) {
	if (state->pointer != NULL) return true;
	if (state->pointer_manager == NULL) {
		helper_error_set(error, HELPER_REFUSAL_UNSUPPORTED,
		                 "this compositor does not advertise zwlr_virtual_pointer_manager_v1, so "
		                 "pointer input cannot be injected");
		return false;
	}
	state->pointer = zwlr_virtual_pointer_manager_v1_create_virtual_pointer(state->pointer_manager,
	                                                                        state->seat);
	if (state->pointer == NULL) {
		helper_error_set(error, HELPER_REFUSAL_TRANSIENT,
		                 "the compositor refused to create a virtual pointer");
		return false;
	}
	return true;
}

/*
 * The keymap is Synara's own, not the human's.
 *
 * Every layer above speaks evdev keycodes against a US QWERTY layout, which is
 * what `evdevInput.ts` encodes. Uploading that exact layout on the virtual
 * keyboard makes typing correct on a Dvorak or AZERTY desktop too, where
 * injecting a raw keycode into the human's layout would produce a different
 * letter than the agent asked for.
 */
static bool ensure_keyboard(helper_wayland *state, helper_error *error) {
	if (state->keyboard != NULL) return true;
	if (state->keyboard_manager == NULL) {
		helper_error_set(error, HELPER_REFUSAL_UNSUPPORTED,
		                 "this compositor does not advertise zwp_virtual_keyboard_manager_v1, so "
		                 "keyboard input cannot be injected");
		return false;
	}
	if (state->seat == NULL) {
		helper_error_set(error, HELPER_REFUSAL_UNSUPPORTED,
		                 "this compositor advertises no wl_seat to attach a keyboard to");
		return false;
	}
	/* Every refusal below leaves through reset_keymap: this runs again on the
	 * next keystroke, and a half-built keymap kept across the retry would be a
	 * leak per attempt. */
	reset_keymap(state);
	state->xkb_context = xkb_context_new(XKB_CONTEXT_NO_FLAGS);
	if (state->xkb_context == NULL) {
		helper_error_set(error, HELPER_REFUSAL_TRANSIENT, "xkbcommon could not be initialised");
		return false;
	}
	struct xkb_rule_names names = {
		.rules = "evdev", .model = "pc105", .layout = "us", .variant = NULL, .options = NULL};
	state->xkb_keymap = xkb_keymap_new_from_names(state->xkb_context, &names,
	                                              XKB_KEYMAP_COMPILE_NO_FLAGS);
	if (state->xkb_keymap == NULL) {
		helper_error_set(error, HELPER_REFUSAL_UNSUPPORTED,
		                 "the us keyboard layout could not be compiled; install xkeyboard-config");
		reset_keymap(state);
		return false;
	}
	state->xkb_state = xkb_state_new(state->xkb_keymap);
	char *keymap_text = xkb_keymap_get_as_string(state->xkb_keymap, XKB_KEYMAP_FORMAT_TEXT_V1);
	if (state->xkb_state == NULL || keymap_text == NULL) {
		free(keymap_text);
		helper_error_set(error, HELPER_REFUSAL_TRANSIENT,
		                 "the keyboard layout could not be serialised");
		reset_keymap(state);
		return false;
	}
	size_t size = strlen(keymap_text) + 1;
	int fd = memfd_create("synara-keymap", MFD_CLOEXEC);
	if (fd < 0 || ftruncate(fd, (off_t)size) != 0) {
		if (fd >= 0) close(fd);
		free(keymap_text);
		helper_error_set(error, HELPER_REFUSAL_TRANSIENT,
		                 "the keymap file could not be created: %s", strerror(errno));
		reset_keymap(state);
		return false;
	}
	void *mapped = mmap(NULL, size, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
	if (mapped == MAP_FAILED) {
		close(fd);
		free(keymap_text);
		helper_error_set(error, HELPER_REFUSAL_TRANSIENT, "the keymap could not be mapped: %s",
		                 strerror(errno));
		reset_keymap(state);
		return false;
	}
	memcpy(mapped, keymap_text, size);
	munmap(mapped, size);
	free(keymap_text);

	state->keyboard = zwp_virtual_keyboard_manager_v1_create_virtual_keyboard(state->keyboard_manager,
	                                                                          state->seat);
	if (state->keyboard == NULL) {
		close(fd);
		helper_error_set(error, HELPER_REFUSAL_TRANSIENT,
		                 "the compositor refused to create a virtual keyboard");
		reset_keymap(state);
		return false;
	}
	zwp_virtual_keyboard_v1_keymap(state->keyboard, WL_KEYBOARD_KEYMAP_FORMAT_XKB_V1, fd,
	                               (uint32_t)size);
	/* libwayland dups the fd into its outgoing message, so this one is ours to
	 * close; leaving it open would hold the keymap memory for the process's life. */
	close(fd);
	wl_display_flush(state->display);
	return true;
}

bool helper_wayland_pointer_motion(helper_wayland *state, double x, double y, helper_error *error) {
	if (!ensure_pointer(state, error)) return false;
	helper_box workspace;
	if (!helper_wayland_workspace(state, &workspace, error)) return false;
	double local_x = x - workspace.x;
	double local_y = y - workspace.y;
	if (local_x < 0) local_x = 0;
	if (local_y < 0) local_y = 0;
	if (local_x > workspace.width - 1) local_x = workspace.width - 1;
	if (local_y > workspace.height - 1) local_y = workspace.height - 1;
	zwlr_virtual_pointer_v1_motion_absolute(state->pointer, now_ms(state), (uint32_t)(local_x + 0.5),
	                                        (uint32_t)(local_y + 0.5), (uint32_t)workspace.width,
	                                        (uint32_t)workspace.height);
	zwlr_virtual_pointer_v1_frame(state->pointer);
	wl_display_flush(state->display);
	return true;
}

bool helper_wayland_pointer_button(helper_wayland *state, uint32_t code, bool pressed,
                                   helper_error *error) {
	if (!ensure_pointer(state, error)) return false;
	zwlr_virtual_pointer_v1_button(state->pointer, now_ms(state), code,
	                               pressed ? WL_POINTER_BUTTON_STATE_PRESSED
	                                       : WL_POINTER_BUTTON_STATE_RELEASED);
	zwlr_virtual_pointer_v1_frame(state->pointer);
	wl_display_flush(state->display);
	remember_held(&state->held_buttons, code, pressed);
	return true;
}

/* Deltas arrive as JSON numbers, so the bound has to be applied before the
 * fixed-point conversion rather than trusted from the caller. */
static double clamp_scroll(double delta) {
	if (delta > SCROLL_LIMIT_PX) return SCROLL_LIMIT_PX;
	if (delta < -SCROLL_LIMIT_PX) return -SCROLL_LIMIT_PX;
	return delta;
}

/*
 * Whole wheel notches owed to a client that can only be told about whole ones.
 *
 * A notch is SCROLL_STEP_PX, so any delta smaller than that truncates to zero
 * steps. Rounding it up instead — which is what this used to do — turns a 2 px
 * trackpad nudge into a full notch, and a stack that speaks pixels end to end
 * then scrolls seven times further than it was asked to. The sub-notch part is
 * carried in @p remainder instead, so repeated small deltas still add up to a
 * notch and nothing is invented. Same shape as `takeDiscreteSteps` in the KWin
 * plugin, deliberately: one scroll must mean one thing on every desktop.
 */
static int32_t take_discrete_steps(double *remainder, double delta) {
	if (delta == 0) return 0;
	*remainder += delta;
	double steps = trunc(*remainder / SCROLL_STEP_PX);
	*remainder -= steps * SCROLL_STEP_PX;
	return (int32_t)steps;
}

/*
 * Wheel source with both halves, matching SynaraComputerUsePlugin::axis(): a
 * finger-source variant was tried on 2026-08-22 and Gecko ignored those
 * events entirely while Qt geared them up, so wheel is the one scroll every
 * toolkit acts on. The per-toolkit distance it travels is measured and
 * corrected server-side (scrollCalibration.ts), not here.
 *
 * The protocol says `axis_discrete` "allows the client to extend data
 * normally sent using the axis event with discrete value" — it is an
 * annotation on an axis event, not a substitute for one, so the continuous
 * half goes out first and the discrete half extends it. A compositor that
 * takes the pixel delta only from `axis` sees nothing at all otherwise.
 * They are not additive: both carry the same delta, and the discrete
 * request names the notch count that delta amounts to.
 */
static void send_axis(helper_wayland *state, uint32_t axis, double delta, double *remainder) {
	if (delta == 0) return;
	int32_t steps = take_discrete_steps(remainder, delta);
	zwlr_virtual_pointer_v1_axis_source(state->pointer, WL_POINTER_AXIS_SOURCE_WHEEL);
	/*
	 * The continuous value is in the wheel's own units, not pixels: a client
	 * reads it at libinput's scale of 15 per notch and multiplies up from
	 * there, so the pixel delta is converted at SCROLL_STEP_PX per notch.
	 */
	double axis_value = delta * AXIS_UNITS_PER_NOTCH / SCROLL_STEP_PX;
	zwlr_virtual_pointer_v1_axis(state->pointer, now_ms(state), axis,
	                             wl_fixed_from_double(axis_value));
	if (steps != 0) {
		zwlr_virtual_pointer_v1_axis_discrete(state->pointer, now_ms(state), axis,
		                                      wl_fixed_from_double(axis_value), steps);
	}
}

bool helper_wayland_pointer_axis(helper_wayland *state, double delta_x, double delta_y,
                                 helper_error *error) {
	if (!ensure_pointer(state, error)) return false;
	if (delta_x == 0 && delta_y == 0) return true;
	send_axis(state, WL_POINTER_AXIS_VERTICAL_SCROLL, clamp_scroll(delta_y),
	          &state->axis_remainder_v);
	send_axis(state, WL_POINTER_AXIS_HORIZONTAL_SCROLL, clamp_scroll(delta_x),
	          &state->axis_remainder_h);
	zwlr_virtual_pointer_v1_frame(state->pointer);
	wl_display_flush(state->display);
	return true;
}

/*
 * wlroots does not run a virtual keyboard's keys through the keymap: the
 * protocol has a `modifiers` request precisely because the client is expected
 * to say what is held. So the helper keeps its own xkb state, updates it with
 * every key it sends, and republishes the serialized modifiers — otherwise a
 * Shift press would be a keycode nobody applies and every capital letter would
 * arrive lowercase.
 */
static void publish_modifiers(helper_wayland *state) {
	uint32_t depressed = xkb_state_serialize_mods(state->xkb_state, XKB_STATE_MODS_DEPRESSED);
	uint32_t latched = xkb_state_serialize_mods(state->xkb_state, XKB_STATE_MODS_LATCHED);
	uint32_t locked = xkb_state_serialize_mods(state->xkb_state, XKB_STATE_MODS_LOCKED);
	uint32_t group = xkb_state_serialize_layout(state->xkb_state, XKB_STATE_LAYOUT_EFFECTIVE);
	if (depressed == state->modifiers_depressed && latched == state->modifiers_latched &&
	    locked == state->modifiers_locked && group == state->modifiers_group) {
		return;
	}
	state->modifiers_depressed = depressed;
	state->modifiers_latched = latched;
	state->modifiers_locked = locked;
	state->modifiers_group = group;
	zwp_virtual_keyboard_v1_modifiers(state->keyboard, depressed, latched, locked, group);
}

bool helper_wayland_key(helper_wayland *state, uint32_t code, bool pressed, helper_error *error) {
	if (!ensure_keyboard(state, error)) return false;
	zwp_virtual_keyboard_v1_key(state->keyboard, now_ms(state), code,
	                            pressed ? WL_KEYBOARD_KEY_STATE_PRESSED
	                                    : WL_KEYBOARD_KEY_STATE_RELEASED);
	/* xkb counts from the X11 keycode space, which is evdev plus eight. */
	xkb_state_update_key(state->xkb_state, code + 8, pressed ? XKB_KEY_DOWN : XKB_KEY_UP);
	publish_modifiers(state);
	wl_display_flush(state->display);
	remember_held(&state->held_keys, code, pressed);
	return true;
}

void helper_wayland_release_all(helper_wayland *state) {
	while (state->held_keys != NULL) {
		uint32_t code = state->held_keys->code;
		if (state->keyboard != NULL) {
			zwp_virtual_keyboard_v1_key(state->keyboard, now_ms(state), code,
			                            WL_KEYBOARD_KEY_STATE_RELEASED);
			xkb_state_update_key(state->xkb_state, code + 8, XKB_KEY_UP);
			publish_modifiers(state);
		}
		remember_held(&state->held_keys, code, false);
	}
	while (state->held_buttons != NULL) {
		uint32_t code = state->held_buttons->code;
		if (state->pointer != NULL) {
			zwlr_virtual_pointer_v1_button(state->pointer, now_ms(state), code,
			                               WL_POINTER_BUTTON_STATE_RELEASED);
			zwlr_virtual_pointer_v1_frame(state->pointer);
		}
		remember_held(&state->held_buttons, code, false);
	}
	if (state->display != NULL) wl_display_flush(state->display);
}

// ── Capture ──────────────────────────────────────────────────────────

struct capture_frame {
	helper_wayland *state;
	uint32_t format;
	uint32_t width;
	uint32_t height;
	uint32_t stride;
	bool have_buffer;
	bool offers_ready;
	bool ready;
	bool failed;
	bool y_invert;
	bool settled;
	char failure[256];
};

static void frame_buffer(void *data, struct zwlr_screencopy_frame_v1 *frame, uint32_t format,
                         uint32_t width, uint32_t height, uint32_t stride) {
	(void)frame;
	struct capture_frame *capture = data;
	/* Several formats may be offered; the first one this helper can decode
	 * wins, and an offer it cannot decode is remembered only to name it in the
	 * refusal if none of them work out. */
	if (!capture->have_buffer || !image_format_supported(capture->format)) {
		capture->format = format;
		capture->width = width;
		capture->height = height;
		capture->stride = stride;
		capture->have_buffer = true;
	}
	/* Before version 3 there is no buffer_done: the single offer is the end of
	 * the offer phase and the copy has to be issued right after it. */
	if (capture->state->screencopy_version < 3) capture->offers_ready = true;
}

static void frame_flags(void *data, struct zwlr_screencopy_frame_v1 *frame, uint32_t flags) {
	(void)frame;
	struct capture_frame *capture = data;
	capture->y_invert = (flags & ZWLR_SCREENCOPY_FRAME_V1_FLAGS_Y_INVERT) != 0;
}

static void frame_ready(void *data, struct zwlr_screencopy_frame_v1 *frame, uint32_t tv_sec_hi,
                        uint32_t tv_sec_lo, uint32_t tv_nsec) {
	(void)frame;
	(void)tv_sec_hi;
	(void)tv_sec_lo;
	(void)tv_nsec;
	struct capture_frame *capture = data;
	capture->ready = true;
	capture->settled = true;
}

static void frame_failed(void *data, struct zwlr_screencopy_frame_v1 *frame) {
	(void)frame;
	struct capture_frame *capture = data;
	capture->failed = true;
	capture->settled = true;
	capture->offers_ready = true;
	snprintf(capture->failure, sizeof(capture->failure),
	         "the compositor rejected the screencopy request for this output");
}

static void frame_damage(void *data, struct zwlr_screencopy_frame_v1 *frame, uint32_t x, uint32_t y,
                         uint32_t width, uint32_t height) {
	(void)data;
	(void)frame;
	(void)x;
	(void)y;
	(void)width;
	(void)height;
}

static void frame_linux_dmabuf(void *data, struct zwlr_screencopy_frame_v1 *frame, uint32_t format,
                               uint32_t width, uint32_t height) {
	(void)data;
	(void)frame;
	(void)format;
	(void)width;
	(void)height;
}

static void frame_buffer_done(void *data, struct zwlr_screencopy_frame_v1 *frame) {
	(void)frame;
	struct capture_frame *capture = data;
	capture->offers_ready = true;
}

static const struct zwlr_screencopy_frame_v1_listener frame_listener = {
	.buffer = frame_buffer,
	.flags = frame_flags,
	.ready = frame_ready,
	.failed = frame_failed,
	.damage = frame_damage,
	.linux_dmabuf = frame_linux_dmabuf,
	.buffer_done = frame_buffer_done,
};

/* All four edges in int64: both boxes are int32 rects, and the sum of a
 * coordinate and an extent is not. Both callers pass boxes `box_usable` has
 * already vouched for, so the result fits back into int32. */
static bool intersect_box(helper_box a, helper_box b, helper_box *out) {
	int64_t left = a.x > b.x ? a.x : b.x;
	int64_t top = a.y > b.y ? a.y : b.y;
	int64_t a_right = (int64_t)a.x + a.width;
	int64_t b_right = (int64_t)b.x + b.width;
	int64_t a_bottom = (int64_t)a.y + a.height;
	int64_t b_bottom = (int64_t)b.y + b.height;
	int64_t right = a_right < b_right ? a_right : b_right;
	int64_t bottom = a_bottom < b_bottom ? a_bottom : b_bottom;
	if (right <= left || bottom <= top) return false;
	out->x = (int32_t)left;
	out->y = (int32_t)top;
	out->width = (int32_t)(right - left);
	out->height = (int32_t)(bottom - top);
	return true;
}

/* The smallest box covering both. Same int64 discipline as the intersection. */
static helper_box union_of(helper_box a, helper_box b) {
	int64_t left = a.x < b.x ? a.x : b.x;
	int64_t top = a.y < b.y ? a.y : b.y;
	int64_t a_right = (int64_t)a.x + a.width;
	int64_t b_right = (int64_t)b.x + b.width;
	int64_t a_bottom = (int64_t)a.y + a.height;
	int64_t b_bottom = (int64_t)b.y + b.height;
	int64_t right = a_right > b_right ? a_right : b_right;
	int64_t bottom = a_bottom > b_bottom ? a_bottom : b_bottom;
	helper_box out = {.x = (int32_t)left,
	                  .y = (int32_t)top,
	                  .width = (int32_t)(right - left),
	                  .height = (int32_t)(bottom - top)};
	return out;
}

static struct helper_output *find_output(helper_wayland *state, uint32_t registry_name) {
	for (struct helper_output *output = state->outputs; output != NULL; output = output->next) {
		if (output->registry_name == registry_name) return output;
	}
	return NULL;
}

/** Captures one output's sub-rect, in that output's local logical coordinates. */
static bool capture_one(helper_wayland *state, struct helper_output *output, helper_box local,
                        bool overlay_cursor, image_rgba *out, int64_t deadline_ms,
                        helper_error *error) {
	struct capture_frame capture = {0};
	capture.state = state;
	/* A previous piece's wait_for dispatches events, and a global_remove can
	 * destroy the manager between pieces; re-validate rather than marshal
	 * through a NULL proxy. */
	if (state->screencopy_manager == NULL) {
		helper_error_set(error, HELPER_REFUSAL_TRANSIENT,
		                 "the compositor withdrew zwlr_screencopy_manager_v1 mid-capture");
		return false;
	}
	struct zwlr_screencopy_frame_v1 *frame = zwlr_screencopy_manager_v1_capture_output_region(
		state->screencopy_manager, overlay_cursor ? 1 : 0, output->output, local.x, local.y,
		local.width, local.height);
	if (frame == NULL) {
		helper_error_set(error, HELPER_REFUSAL_TRANSIENT,
		                 "the compositor refused to start a screencopy frame");
		return false;
	}
	zwlr_screencopy_frame_v1_add_listener(frame, &frame_listener, &capture);

	if (!wait_for(state, &capture.offers_ready, deadline_ms, error)) {
		zwlr_screencopy_frame_v1_destroy(frame);
		return false;
	}
	if (capture.failed) {
		helper_error_set(error, HELPER_REFUSAL_TRANSIENT, "%s", capture.failure);
		zwlr_screencopy_frame_v1_destroy(frame);
		return false;
	}
	if (!capture.have_buffer) {
		helper_error_set(error, HELPER_REFUSAL_TRANSIENT,
		                 "the compositor offered no buffer format for this output");
		zwlr_screencopy_frame_v1_destroy(frame);
		return false;
	}
	if (!image_format_supported(capture.format)) {
		helper_error_set(error, HELPER_REFUSAL_UNSUPPORTED,
		                 "the compositor only offered %s (wl_shm format 0x%08x), which this "
		                 "helper cannot decode",
		                 image_format_name(capture.format), capture.format);
		zwlr_screencopy_frame_v1_destroy(frame);
		return false;
	}
	if (state->shm == NULL) {
		helper_error_set(error, HELPER_REFUSAL_UNSUPPORTED,
		                 "this compositor advertises no wl_shm, so no capture buffer can be "
		                 "allocated");
		zwlr_screencopy_frame_v1_destroy(frame);
		return false;
	}

	/* The offer's dimensions are the compositor's word, and wl_shm counts its
	 * pool and buffer in int32. A buffer that does not survive that conversion
	 * is refused here rather than truncated into a pool the size of a
	 * screenshot's low bits. */
	uint64_t size = (uint64_t)capture.stride * capture.height;
	if (capture.width == 0 || capture.height == 0 || capture.width > IMAGE_MAX_DIMENSION ||
	    capture.height > IMAGE_MAX_DIMENSION || capture.stride > (uint32_t)INT32_MAX ||
	    size == 0 || size > (uint64_t)INT32_MAX) {
		helper_error_set(error, HELPER_REFUSAL_TRANSIENT,
		                 "the compositor offered a %ux%u buffer of %u bytes per row, which is not a "
		                 "frame this helper can map",
		                 capture.width, capture.height, capture.stride);
		zwlr_screencopy_frame_v1_destroy(frame);
		return false;
	}
	int fd = memfd_create("synara-capture", MFD_CLOEXEC);
	if (fd < 0 || ftruncate(fd, (off_t)size) != 0) {
		if (fd >= 0) close(fd);
		helper_error_set(error, HELPER_REFUSAL_TRANSIENT,
		                 "the capture buffer could not be created: %s", strerror(errno));
		zwlr_screencopy_frame_v1_destroy(frame);
		return false;
	}
	void *pixels = mmap(NULL, (size_t)size, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
	if (pixels == MAP_FAILED) {
		close(fd);
		helper_error_set(error, HELPER_REFUSAL_TRANSIENT,
		                 "the capture buffer could not be mapped: %s", strerror(errno));
		zwlr_screencopy_frame_v1_destroy(frame);
		return false;
	}
	struct wl_shm_pool *pool = wl_shm_create_pool(state->shm, fd, (int32_t)size);
	struct wl_buffer *buffer = pool == NULL
	                               ? NULL
	                               : wl_shm_pool_create_buffer(pool, 0, (int32_t)capture.width,
	                                                           (int32_t)capture.height,
	                                                           (int32_t)capture.stride,
	                                                           capture.format);
	if (pool != NULL) wl_shm_pool_destroy(pool);
	close(fd);
	if (buffer == NULL) {
		munmap(pixels, (size_t)size);
		helper_error_set(error, HELPER_REFUSAL_TRANSIENT,
		                 "the capture buffer could not be shared with the compositor");
		zwlr_screencopy_frame_v1_destroy(frame);
		return false;
	}

	capture.settled = false;
	zwlr_screencopy_frame_v1_copy(frame, buffer);
	bool ok = wait_for(state, &capture.settled, deadline_ms, error);
	if (ok && capture.failed) {
		helper_error_set(error, HELPER_REFUSAL_TRANSIENT, "%s", capture.failure);
		ok = false;
	}
	if (ok) {
		ok = image_from_shm(out, pixels, capture.width, capture.height, capture.stride,
		                    capture.format, capture.y_invert);
		if (!ok) {
			helper_error_set(error, HELPER_REFUSAL_TRANSIENT,
			                 "the captured %ux%u frame could not be decoded", capture.width,
			                 capture.height);
		}
	}
	munmap(pixels, (size_t)size);
	wl_buffer_destroy(buffer);
	zwlr_screencopy_frame_v1_destroy(frame);
	return ok;
}

/*
 * One output's contribution, resolved before any of them are captured.
 *
 * The output is held by registry name rather than by pointer on purpose:
 * capturing dispatches Wayland events, and one of them may be the
 * `global_remove` that frees the very node a pointer walk would still be
 * standing on. A name is a value, so a monitor unplugged mid-capture is a
 * lookup that fails rather than a read of freed memory.
 */
struct capture_piece {
	uint32_t registry_name;
	helper_box local;
	int32_t destination_x;
	int32_t destination_y;
	uint32_t destination_width;
	uint32_t destination_height;
};

bool helper_wayland_capture(helper_wayland *state, helper_box region, uint32_t max_dimension,
                            bool overlay_cursor, image_rgba *out, helper_box *covered,
                            helper_error *error) {
	if (state->screencopy_manager == NULL) {
		helper_error_set(error, HELPER_REFUSAL_UNSUPPORTED,
		                 "this compositor does not advertise zwlr_screencopy_manager_v1, so the "
		                 "screen cannot be captured");
		return false;
	}
	if (!box_usable(region)) {
		helper_error_set(error, HELPER_REFUSAL_INVALID,
		                 "a capture region must have a positive width and height inside %d px of the "
		                 "origin",
		                 HELPER_COORDINATE_LIMIT);
		return false;
	}

	/* The destination is rendered at the sharpest scale any contributing output
	 * has, so a capture spanning a HiDPI and a 1x monitor is not quantised down
	 * to the coarser one before the caller's own downscale runs. */
	double scale = 0;
	helper_box union_box = {0};
	size_t output_count = 0;
	bool any = false;
	for (struct helper_output *output = state->outputs; output != NULL; output = output->next) {
		output_count++;
		helper_box box = output_box(output);
		helper_box overlap;
		if (!box_usable(box)) continue;
		if (!intersect_box(region, box, &overlap)) continue;
		double output_scale = output_pixel_scale(output);
		if (output_scale > scale) scale = output_scale;
		union_box = any ? union_of(union_box, overlap) : overlap;
		any = true;
	}
	if (!any) {
		helper_error_set(error, HELPER_REFUSAL_INVALID,
		                 "the region %dx%d at (%d, %d) lies outside every output on this desktop",
		                 region.width, region.height, region.x, region.y);
		return false;
	}
	if (scale <= 0) scale = 1;

	struct capture_piece *pieces = calloc(output_count, sizeof(struct capture_piece));
	if (pieces == NULL) {
		helper_error_set(error, HELPER_REFUSAL_TRANSIENT, "out of memory planning the capture");
		return false;
	}
	size_t piece_count = 0;
	for (struct helper_output *output = state->outputs; output != NULL; output = output->next) {
		helper_box box = output_box(output);
		helper_box overlap;
		if (!box_usable(box)) continue;
		if (!intersect_box(union_box, box, &overlap)) continue;
		if (piece_count >= output_count) break;
		pieces[piece_count++] = (struct capture_piece){
			.registry_name = output->registry_name,
			.local = {.x = overlap.x - box.x,
			          .y = overlap.y - box.y,
			          .width = overlap.width,
			          .height = overlap.height},
			.destination_x = (int32_t)((overlap.x - union_box.x) * scale + 0.5),
			.destination_y = (int32_t)((overlap.y - union_box.y) * scale + 0.5),
			.destination_width = (uint32_t)(overlap.width * scale + 0.5),
			.destination_height = (uint32_t)(overlap.height * scale + 0.5),
		};
	}

	uint32_t width = (uint32_t)(union_box.width * scale + 0.5);
	uint32_t height = (uint32_t)(union_box.height * scale + 0.5);
	if (width == 0) width = 1;
	if (height == 0) height = 1;
	if (!image_alloc(out, width, height)) {
		free(pieces);
		helper_error_set(error, HELPER_REFUSAL_TRANSIENT,
		                 "a %ux%u capture buffer could not be allocated", width, height);
		return false;
	}

	int64_t deadline_ms = monotonic_ms() + CAPTURE_BUDGET_MS;
	for (size_t index = 0; index < piece_count; index++) {
		const struct capture_piece *piece = &pieces[index];
		struct helper_output *output = find_output(state, piece->registry_name);
		if (output == NULL) {
			helper_error_set(error, HELPER_REFUSAL_TRANSIENT,
			                 "an output was removed while the desktop was being captured");
			image_free(out);
			free(pieces);
			return false;
		}
		image_rgba captured = {0};
		if (!capture_one(state, output, piece->local, overlay_cursor, &captured, deadline_ms,
		                 error)) {
			image_free(out);
			free(pieces);
			return false;
		}
		bool blitted = image_blit_resampled(out, piece->destination_x, piece->destination_y,
		                                    piece->destination_width, piece->destination_height,
		                                    &captured);
		image_free(&captured);
		if (!blitted) {
			/* The alternative is a screenshot with one monitor's worth of black
			 * in it, which reads as a desktop rather than as a failure. */
			helper_error_set(error, HELPER_REFUSAL_TRANSIENT,
			                 "the %ux%u capture of one output did not fit the desktop image at "
			                 "(%d, %d)",
			                 piece->destination_width, piece->destination_height,
			                 piece->destination_x, piece->destination_y);
			image_free(out);
			free(pieces);
			return false;
		}
	}
	free(pieces);

	if (max_dimension > 0 && !image_fit_within(out, max_dimension)) {
		image_free(out);
		helper_error_set(error, HELPER_REFUSAL_TRANSIENT, "the capture could not be scaled to %u px",
		                 max_dimension);
		return false;
	}
	*covered = union_box;
	return true;
}

// ── Windows ──────────────────────────────────────────────────────────

static bool refresh_toplevels(helper_wayland *state, helper_error *error) {
	if (state->toplevel_manager == NULL) {
		helper_error_set(error, HELPER_REFUSAL_UNSUPPORTED,
		                 "this compositor does not advertise zwlr_foreign_toplevel_manager_v1, so "
		                 "its windows cannot be enumerated");
		return false;
	}
	if (wl_display_roundtrip(state->display) < 0) {
		return connection_failed(state, error, "the Wayland connection failed");
	}
	reap_closed_toplevels(state);
	/* The roundtrip above may have carried the manager's own withdrawal, which
	 * takes the window list with it. */
	if (state->toplevel_manager == NULL) {
		helper_error_set(error, HELPER_REFUSAL_TRANSIENT,
		                 "the compositor withdrew zwlr_foreign_toplevel_manager_v1 while its "
		                 "windows were being enumerated");
		return false;
	}
	return true;
}

bool helper_wayland_write_windows(helper_wayland *state, json_writer *writer, helper_error *error) {
	if (!refresh_toplevels(state, error)) return false;
	jw_char(writer, '[');
	bool first = true;
	for (const struct helper_toplevel *toplevel = state->toplevels; toplevel != NULL;
	     toplevel = toplevel->next) {
		if (!first) jw_char(writer, ',');
		first = false;
		jw_raw(writer, "{\"id\":");
		jw_string(writer, toplevel->id);
		jw_raw(writer, ",\"title\":");
		jw_string(writer, toplevel->title == NULL ? "" : toplevel->title);
		jw_raw(writer, ",\"appId\":");
		jw_string(writer, toplevel->app_id == NULL ? "" : toplevel->app_id);
		jw_raw(writer, ",\"activated\":");
		jw_raw(writer, toplevel->activated ? "true" : "false");
		jw_raw(writer, ",\"minimized\":");
		jw_raw(writer, toplevel->minimized ? "true" : "false");
		jw_raw(writer, ",\"maximized\":");
		jw_raw(writer, toplevel->maximized ? "true" : "false");
		jw_raw(writer, ",\"fullscreen\":");
		jw_raw(writer, toplevel->fullscreen ? "true" : "false");
		jw_char(writer, '}');
	}
	jw_char(writer, ']');
	return true;
}

static struct helper_toplevel *find_toplevel(helper_wayland *state, const char *id) {
	for (struct helper_toplevel *toplevel = state->toplevels; toplevel != NULL;
	     toplevel = toplevel->next) {
		if (strcmp(toplevel->id, id) == 0) return toplevel;
	}
	return NULL;
}

bool helper_wayland_activate_window(helper_wayland *state, const char *id, helper_error *error) {
	if (!refresh_toplevels(state, error)) return false;
	struct helper_toplevel *toplevel = find_toplevel(state, id);
	if (toplevel == NULL) {
		helper_error_set(error, HELPER_REFUSAL_INVALID, "no window with id \"%s\" is open", id);
		return false;
	}
	if (state->seat == NULL) {
		helper_error_set(error, HELPER_REFUSAL_UNSUPPORTED,
		                 "this compositor advertises no wl_seat, so a window cannot be activated");
		return false;
	}
	zwlr_foreign_toplevel_handle_v1_activate(toplevel->handle, state->seat);
	wl_display_flush(state->display);
	return true;
}

bool helper_wayland_close_window(helper_wayland *state, const char *id, helper_error *error) {
	if (!refresh_toplevels(state, error)) return false;
	struct helper_toplevel *toplevel = find_toplevel(state, id);
	if (toplevel == NULL) {
		helper_error_set(error, HELPER_REFUSAL_INVALID, "no window with id \"%s\" is open", id);
		return false;
	}
	zwlr_foreign_toplevel_handle_v1_close(toplevel->handle);
	wl_display_flush(state->display);
	return true;
}

// ── Idle ─────────────────────────────────────────────────────────────

bool helper_wayland_idle_state(helper_wayland *state, uint32_t timeout_ms, helper_idle_state *out,
                               helper_error *error) {
	if (state->idle_notifier == NULL) {
		helper_error_set(error, HELPER_REFUSAL_UNSUPPORTED,
		                 "this compositor does not advertise ext_idle_notifier_v1, so whether the "
		                 "human is at the keyboard cannot be observed");
		return false;
	}
	if (state->seat == NULL) {
		helper_error_set(error, HELPER_REFUSAL_TRANSIENT,
		                 "this compositor advertises no wl_seat whose idle state could be watched");
		return false;
	}
	/* A caller that changed its mind about the window gets a new notification:
	 * the timeout is fixed at creation, so re-arming is the only way to ask a
	 * different question, and the clock starts again with it. */
	if (state->idle_notification != NULL && state->idle_timeout_ms != timeout_ms) {
		drop_idle_notification(state);
	}
	if (state->idle_notification == NULL) {
		/*
		 * Version 2's input-idle notification is the one that answers the
		 * question actually being asked. A plain idle notification is suppressed
		 * by any zwp_idle_inhibitor_v1 — a playing video, a presentation — and a
		 * notification the compositor is forbidden to idle never idles, never
		 * resumes, and reports a seat that is busy forever. That reads as "the
		 * human is always here", which retires the yield silently for as long as
		 * something on the desktop is holding an inhibitor. Input alone is the
		 * signal; version 1 compositors get the notification that can be
		 * inhibited, because it is the only one they have.
		 */
		state->idle_notification =
		    state->idle_notifier_version >= 2
		        ? ext_idle_notifier_v1_get_input_idle_notification(state->idle_notifier, timeout_ms,
		                                                           state->seat)
		        : ext_idle_notifier_v1_get_idle_notification(state->idle_notifier, timeout_ms,
		                                                     state->seat);
		if (state->idle_notification == NULL) {
			helper_error_set(error, HELPER_REFUSAL_TRANSIENT,
			                 "the compositor refused to create an idle notification for this seat");
			return false;
		}
		ext_idle_notification_v1_add_listener(state->idle_notification, &idle_notification_listener,
		                                      state);
		state->idle_timeout_ms = timeout_ms;
		state->idle = false;
		state->idle_observed = false;
		state->idle_since_ms = monotonic_ms();
	}
	/*
	 * Settled before answering, not after.
	 *
	 * Nothing else in this process drives the event queue between requests, so
	 * an `idled` or `resumed` the compositor sent while the helper was idle sits
	 * unread in the socket. Answering from the remembered state without the
	 * round trip would report a transition that already happened as though it
	 * had not — a human who came back a second ago still reported as away, which
	 * is the one wrong answer here the caller acts on.
	 */
	if (wl_display_roundtrip(state->display) < 0) {
		return connection_failed(state, error, "the Wayland connection failed");
	}
	/* The round trip may have carried the withdrawal of the seat or the notifier,
	 * either of which takes the notification with it. */
	if (state->idle_notification == NULL) {
		helper_error_set(error, HELPER_REFUSAL_TRANSIENT,
		                 "the compositor withdrew the seat or ext_idle_notifier_v1 while its idle "
		                 "state was being read");
		return false;
	}
	int64_t since_ms = monotonic_ms() - state->idle_since_ms;
	out->idle = state->idle;
	out->since_ms = since_ms > 0 ? since_ms : 0;
	out->timeout_ms = state->idle_timeout_ms;
	out->observed = state->idle_observed;
	return true;
}
