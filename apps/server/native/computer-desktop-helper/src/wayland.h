/*
 * The Wayland connection, which is the only thing this helper exists for.
 *
 * Node has no binding for `wl_display`, so everything that requires one lives
 * behind this interface: enumerating globals for the probe, the unprivileged
 * wlroots protocols for input and capture, and foreign-toplevel enumeration.
 * Every entry point either succeeds or fills `error` with a sentence naming the
 * missing protocol or the failed step — a silent empty answer here becomes a
 * lie two layers up, where an agent reads it as "the desktop is empty".
 */
#ifndef SYNARA_HELPER_WAYLAND_H
#define SYNARA_HELPER_WAYLAND_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "image.h"
#include "json.h"

/**
 * The furthest a coordinate may be from the origin.
 *
 * Two jobs. It is the sanity bound a request is validated against at the
 * dispatch edge, and it is what makes the geometry below safe: the union of two
 * boxes inside this limit is still an int32, so no intersection or union has to
 * defend itself against a caller who asked for a rect a billion pixels wide.
 */
#define HELPER_COORDINATE_LIMIT 1000000

/**
 * The window an idle query may ask about.
 *
 * The floor keeps a caller from arming a notification so short that every
 * keystroke costs a round of `idled`/`resumed` traffic; the ceiling is ten
 * minutes, past which the question stops being "is the human here" and becomes
 * a screensaver's business.
 */
#define HELPER_IDLE_TIMEOUT_MIN_MS 100
#define HELPER_IDLE_TIMEOUT_MAX_MS 600000

/**
 * Why a request was refused.
 *
 * The distinction is the caller's, not this helper's: a compositor that does
 * not implement a protocol will not implement it on the next request either, so
 * retrying is pointless, while a capture that timed out may well succeed. The
 * server reads these off the JSON-RPC error code and decides on them whether to
 * retry at all.
 */
typedef enum {
	/** The request itself was wrong: an out-of-range rect, an unknown window. */
	HELPER_REFUSAL_INVALID = 0,
	HELPER_REFUSAL_UNKNOWN_METHOD,
	/** This compositor cannot ever serve it: the protocol is not advertised. */
	HELPER_REFUSAL_UNSUPPORTED,
	/** It failed this once: a timeout, an allocation, a compositor that said no. */
	HELPER_REFUSAL_TRANSIENT,
} helper_refusal;

/** A refusal, in one sentence a human can act on plus the kind above. */
typedef struct {
	helper_refusal kind;
	char message[512];
} helper_error;

void helper_error_set(helper_error *error, helper_refusal kind, const char *format, ...)
    __attribute__((format(printf, 3, 4)));

/** A rect in desktop logical coordinates: the space windows and clicks live in. */
typedef struct {
	int32_t x;
	int32_t y;
	int32_t width;
	int32_t height;
} helper_box;

typedef struct helper_wayland helper_wayland;

/** Connects to `WAYLAND_DISPLAY` and enumerates globals. NULL on failure. */
helper_wayland *helper_wayland_connect(helper_error *error);
void helper_wayland_destroy(helper_wayland *state);

int helper_wayland_fd(const helper_wayland *state);
/** Arms a read and flushes. False means the connection is gone. */
bool helper_wayland_prepare(helper_wayland *state);
/** Completes the armed read (or cancels it) and dispatches. False means gone. */
bool helper_wayland_read(helper_wayland *state, bool readable);
/**
 * Whether the connection has failed under a request. Nothing else can be served
 * over a dead display, so the caller exits and lets its supervisor start a
 * helper that has a live one.
 */
bool helper_wayland_broken(const helper_wayland *state);

/** `[{"interface":…,"name":…,"version":…}]`, the probe's whole answer. */
void helper_wayland_write_globals(const helper_wayland *state, json_writer *writer);
/** `[{"name":…,"x":…,"y":…,"width":…,"height":…,"scale":…}]` in logical space. */
void helper_wayland_write_outputs(const helper_wayland *state, json_writer *writer);
/** The union of every output: the coordinate space every other call uses. */
bool helper_wayland_workspace(const helper_wayland *state, helper_box *out, helper_error *error);

bool helper_wayland_pointer_motion(helper_wayland *state, double x, double y, helper_error *error);
bool helper_wayland_pointer_button(helper_wayland *state, uint32_t code, bool pressed,
                                   helper_error *error);
bool helper_wayland_pointer_axis(helper_wayland *state, double delta_x, double delta_y,
                                 helper_error *error);
bool helper_wayland_key(helper_wayland *state, uint32_t code, bool pressed, helper_error *error);
/** Releases every button and key this helper is still holding down. */
void helper_wayland_release_all(helper_wayland *state);

/**
 * Captures `region` (desktop logical coordinates), compositing every output it
 * touches, and fits the result inside `max_dimension`. `covered` reports the
 * region actually captured, which is `region` clipped to the outputs.
 */
bool helper_wayland_capture(helper_wayland *state, helper_box region, uint32_t max_dimension,
                            bool overlay_cursor, image_rgba *out, helper_box *covered,
                            helper_error *error);

/**
 * Whether the seat is idle, and for how long it has been in that state.
 *
 * `idle == false` is the load-bearing half: it means the human touched a key or
 * moved the pointer within the last `timeout_ms`, which is what makes the agent
 * yield the shared seat. `timeout_ms` is the timeout the notification is armed
 * at, echoed back because a re-arm is what a caller changing its mind gets, and
 * because it is the only way the caller can turn `idle` into a duration.
 *
 * `observed` is false until the compositor has sent a transition. The protocol
 * measures the timeout from the notification's creation rather than from the
 * seat's last input, so the first `timeout_ms` after arming carry no
 * information whatsoever: `idle` is false there because nothing has yet
 * contradicted the initial state, not because anyone is at the keyboard. A
 * caller that cannot tell those apart refuses its first action of every helper
 * lifetime in the human's name, on a desktop nobody is sitting at.
 */
typedef struct {
	bool idle;
	int64_t since_ms;
	uint32_t timeout_ms;
	bool observed;
} helper_idle_state;

/**
 * Reads the seat's idle state, arming the compositor's notification at
 * `timeout_ms` on the first call and re-arming it whenever the timeout changes.
 *
 * `ext_idle_notifier_v1` has no request that asks the question directly, so the
 * only way to answer it is to hold a notification open and report what it last
 * said. What it has not said yet is reported as `observed == false` rather than
 * guessed at: "nobody has told us the human left" and "the human left" are
 * different facts, and the caller acts on the second one.
 */
bool helper_wayland_idle_state(helper_wayland *state, uint32_t timeout_ms, helper_idle_state *out,
                               helper_error *error);

/** Writes the toplevel array. Refuses when the compositor has no such protocol. */
bool helper_wayland_write_windows(helper_wayland *state, json_writer *writer, helper_error *error);
bool helper_wayland_activate_window(helper_wayland *state, const char *id, helper_error *error);
bool helper_wayland_close_window(helper_wayland *state, const char *id, helper_error *error);

#endif
