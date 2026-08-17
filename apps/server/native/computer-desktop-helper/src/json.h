/*
 * The smallest JSON this helper can get away with.
 *
 * The transport is JSON-RPC over stdio, so a parser is unavoidable; a
 * dependency is not. Requests are small and shallow (numbers, strings, bools),
 * and responses are built by hand, so this is a recursive-descent reader plus a
 * growable writer rather than a general-purpose library.
 */
#ifndef SYNARA_HELPER_JSON_H
#define SYNARA_HELPER_JSON_H

#include <stdbool.h>
#include <stddef.h>

typedef enum {
	JSON_NULL,
	JSON_BOOL,
	JSON_NUMBER,
	JSON_STRING,
	JSON_ARRAY,
	JSON_OBJECT
} json_type;

typedef struct json_value {
	json_type type;
	double number;
	bool boolean;
	char *string;             /* JSON_STRING: unescaped, NUL-terminated */
	char *name;               /* member name when this value is in an object */
	struct json_value *first; /* array elements or object members */
	struct json_value *next;  /* next sibling */
} json_value;

/* Returns NULL and fills `error` on malformed input. Never partially succeeds. */
json_value *json_parse(const char *text, size_t length, char *error, size_t error_size);
void json_free(json_value *value);

const json_value *json_member(const json_value *object, const char *name);
/* Finite numbers only: a NaN or an infinity in a coordinate is a bug, not a value. */
bool json_as_number(const json_value *value, double *out);
bool json_member_number(const json_value *object, const char *name, double *out);
const char *json_as_string(const json_value *value);
bool json_member_bool(const json_value *object, const char *name, bool fallback);

/*
 * A growable output buffer. Every append checks `failed`, so a single
 * out-of-memory is detectable once at the end instead of at every call site.
 */
typedef struct {
	char *data;
	size_t length;
	size_t capacity;
	bool failed;
} json_writer;

void jw_init(json_writer *writer);
void jw_free(json_writer *writer);
void jw_raw(json_writer *writer, const char *text);
void jw_char(json_writer *writer, char value);
/* Writes a quoted, escaped JSON string. A NULL pointer writes `""`. */
void jw_string(json_writer *writer, const char *value);
void jw_number(json_writer *writer, double value);
void jw_int(json_writer *writer, long long value);
/* `"name":` — the caller writes the value and owns the commas. */
void jw_key(json_writer *writer, const char *name);

#endif
