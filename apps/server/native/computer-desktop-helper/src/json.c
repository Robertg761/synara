#include "json.h"

#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* Deep enough for any request this helper takes, shallow enough that a hostile
 * document cannot recurse the stack away. */
#define JSON_MAX_DEPTH 32

typedef struct {
	const char *text;
	size_t length;
	size_t offset;
	char *error;
	size_t error_size;
	int depth;
} json_parser;

static void json_fail(json_parser *parser, const char *message) {
	if (parser->error != NULL && parser->error_size > 0 && parser->error[0] == '\0') {
		snprintf(parser->error, parser->error_size, "%s at byte %zu", message, parser->offset);
	}
}

static json_value *json_parse_value(json_parser *parser);

static void json_skip_space(json_parser *parser) {
	while (parser->offset < parser->length) {
		char c = parser->text[parser->offset];
		if (c == ' ' || c == '\t' || c == '\n' || c == '\r') {
			parser->offset++;
		} else {
			break;
		}
	}
}

static bool json_literal(json_parser *parser, const char *literal) {
	size_t size = strlen(literal);
	if (parser->length - parser->offset < size) return false;
	if (memcmp(parser->text + parser->offset, literal, size) != 0) return false;
	parser->offset += size;
	return true;
}

static json_value *json_new(json_type type) {
	json_value *value = calloc(1, sizeof(json_value));
	if (value != NULL) value->type = type;
	return value;
}

/* Encodes one code point as UTF-8. Lone surrogates become U+FFFD rather than
 * invalid bytes, because the consumer of this text is a UTF-8 decoder that
 * rejects them. */
static void json_append_utf8(char *out, size_t *out_length, unsigned int code_point) {
	if (code_point >= 0xD800 && code_point <= 0xDFFF) code_point = 0xFFFD;
	if (code_point < 0x80) {
		out[(*out_length)++] = (char)code_point;
	} else if (code_point < 0x800) {
		out[(*out_length)++] = (char)(0xC0 | (code_point >> 6));
		out[(*out_length)++] = (char)(0x80 | (code_point & 0x3F));
	} else if (code_point < 0x10000) {
		out[(*out_length)++] = (char)(0xE0 | (code_point >> 12));
		out[(*out_length)++] = (char)(0x80 | ((code_point >> 6) & 0x3F));
		out[(*out_length)++] = (char)(0x80 | (code_point & 0x3F));
	} else {
		out[(*out_length)++] = (char)(0xF0 | (code_point >> 18));
		out[(*out_length)++] = (char)(0x80 | ((code_point >> 12) & 0x3F));
		out[(*out_length)++] = (char)(0x80 | ((code_point >> 6) & 0x3F));
		out[(*out_length)++] = (char)(0x80 | (code_point & 0x3F));
	}
}

static bool json_hex4(json_parser *parser, unsigned int *out) {
	if (parser->length - parser->offset < 4) return false;
	unsigned int value = 0;
	for (int index = 0; index < 4; index++) {
		char c = parser->text[parser->offset + (size_t)index];
		value <<= 4;
		if (c >= '0' && c <= '9') {
			value |= (unsigned int)(c - '0');
		} else if (c >= 'a' && c <= 'f') {
			value |= (unsigned int)(c - 'a' + 10);
		} else if (c >= 'A' && c <= 'F') {
			value |= (unsigned int)(c - 'A' + 10);
		} else {
			return false;
		}
	}
	parser->offset += 4;
	*out = value;
	return true;
}

/*
 * Measures the escaped string starting after the opening quote. Sizing the
 * buffer from the string rather than from the rest of the document is what
 * keeps a four megabyte line of two-character strings from allocating a
 * megabyte per string.
 */
static bool json_scan_string(const json_parser *parser, size_t *raw_length) {
	size_t offset = parser->offset;
	while (offset < parser->length) {
		char c = parser->text[offset];
		if (c == '"') {
			*raw_length = offset - parser->offset;
			return true;
		}
		/* Only a backslash's own escape consumes the byte after it, so this is
		 * also what decides that a quote is the closing one. */
		offset += c == '\\' ? 2 : 1;
	}
	return false;
}

/* The unescaped form is never longer than the escaped one — a surrogate pair
 * spends twelve bytes on four — so the scanned length is always enough. */
static char *json_parse_string_raw(json_parser *parser) {
	if (parser->offset >= parser->length || parser->text[parser->offset] != '"') {
		json_fail(parser, "expected a string");
		return NULL;
	}
	parser->offset++;
	size_t raw_length = 0;
	if (!json_scan_string(parser, &raw_length)) {
		json_fail(parser, "unterminated string");
		return NULL;
	}
	char *out = malloc(raw_length + 1);
	if (out == NULL) {
		json_fail(parser, "out of memory");
		return NULL;
	}
	size_t out_length = 0;
	while (parser->offset < parser->length) {
		char c = parser->text[parser->offset++];
		if (c == '"') {
			out[out_length] = '\0';
			return out;
		}
		if (c != '\\') {
			out[out_length++] = c;
			continue;
		}
		if (parser->offset >= parser->length) break;
		char escape = parser->text[parser->offset++];
		switch (escape) {
		case '"': out[out_length++] = '"'; break;
		case '\\': out[out_length++] = '\\'; break;
		case '/': out[out_length++] = '/'; break;
		case 'b': out[out_length++] = '\b'; break;
		case 'f': out[out_length++] = '\f'; break;
		case 'n': out[out_length++] = '\n'; break;
		case 'r': out[out_length++] = '\r'; break;
		case 't': out[out_length++] = '\t'; break;
		case 'u': {
			unsigned int code_point = 0;
			if (!json_hex4(parser, &code_point)) {
				free(out);
				json_fail(parser, "invalid \\u escape");
				return NULL;
			}
			if (code_point >= 0xD800 && code_point <= 0xDBFF && parser->length - parser->offset >= 6 &&
			    parser->text[parser->offset] == '\\' && parser->text[parser->offset + 1] == 'u') {
				size_t saved = parser->offset;
				parser->offset += 2;
				unsigned int low = 0;
				if (json_hex4(parser, &low) && low >= 0xDC00 && low <= 0xDFFF) {
					code_point = 0x10000 + ((code_point - 0xD800) << 10) + (low - 0xDC00);
				} else {
					parser->offset = saved;
				}
			}
			json_append_utf8(out, &out_length, code_point);
			break;
		}
		default:
			free(out);
			json_fail(parser, "invalid escape");
			return NULL;
		}
	}
	free(out);
	json_fail(parser, "unterminated string");
	return NULL;
}

static json_value *json_parse_container(json_parser *parser, bool is_object) {
	json_value *container = json_new(is_object ? JSON_OBJECT : JSON_ARRAY);
	if (container == NULL) {
		json_fail(parser, "out of memory");
		return NULL;
	}
	parser->offset++; /* '{' or '[' */
	json_value *tail = NULL;
	json_skip_space(parser);
	char closing = is_object ? '}' : ']';
	if (parser->offset < parser->length && parser->text[parser->offset] == closing) {
		parser->offset++;
		return container;
	}
	for (;;) {
		json_skip_space(parser);
		char *name = NULL;
		if (is_object) {
			name = json_parse_string_raw(parser);
			if (name == NULL) {
				json_free(container);
				return NULL;
			}
			json_skip_space(parser);
			if (parser->offset >= parser->length || parser->text[parser->offset] != ':') {
				free(name);
				json_free(container);
				json_fail(parser, "expected ':'");
				return NULL;
			}
			parser->offset++;
		}
		json_value *child = json_parse_value(parser);
		if (child == NULL) {
			free(name);
			json_free(container);
			return NULL;
		}
		child->name = name;
		if (tail == NULL) {
			container->first = child;
		} else {
			tail->next = child;
		}
		tail = child;
		json_skip_space(parser);
		if (parser->offset < parser->length && parser->text[parser->offset] == ',') {
			parser->offset++;
			continue;
		}
		if (parser->offset < parser->length && parser->text[parser->offset] == closing) {
			parser->offset++;
			return container;
		}
		json_free(container);
		json_fail(parser, "expected ',' or a closing bracket");
		return NULL;
	}
}

static json_value *json_parse_value(json_parser *parser) {
	if (parser->depth >= JSON_MAX_DEPTH) {
		json_fail(parser, "document is nested too deeply");
		return NULL;
	}
	json_skip_space(parser);
	if (parser->offset >= parser->length) {
		json_fail(parser, "unexpected end of document");
		return NULL;
	}
	char c = parser->text[parser->offset];
	if (c == '{' || c == '[') {
		parser->depth++;
		json_value *value = json_parse_container(parser, c == '{');
		parser->depth--;
		return value;
	}
	if (c == '"') {
		char *text = json_parse_string_raw(parser);
		if (text == NULL) return NULL;
		json_value *value = json_new(JSON_STRING);
		if (value == NULL) {
			free(text);
			json_fail(parser, "out of memory");
			return NULL;
		}
		value->string = text;
		return value;
	}
	if (c == 't' || c == 'f') {
		bool boolean = json_literal(parser, "true");
		if (!boolean && !json_literal(parser, "false")) {
			json_fail(parser, "expected a value");
			return NULL;
		}
		json_value *value = json_new(JSON_BOOL);
		if (value == NULL) return NULL;
		value->boolean = boolean;
		return value;
	}
	if (json_literal(parser, "null")) {
		return json_new(JSON_NULL);
	}
	char *end = NULL;
	double number = strtod(parser->text + parser->offset, &end);
	if (end == parser->text + parser->offset) {
		json_fail(parser, "expected a value");
		return NULL;
	}
	parser->offset = (size_t)(end - parser->text);
	json_value *value = json_new(JSON_NUMBER);
	if (value == NULL) return NULL;
	value->number = number;
	return value;
}

json_value *json_parse(const char *text, size_t length, char *error, size_t error_size) {
	if (error != NULL && error_size > 0) error[0] = '\0';
	json_parser parser = {
		.text = text, .length = length, .offset = 0, .error = error, .error_size = error_size, .depth = 0};
	json_value *value = json_parse_value(&parser);
	if (value == NULL) return NULL;
	json_skip_space(&parser);
	if (parser.offset != parser.length) {
		json_free(value);
		json_fail(&parser, "trailing content after the document");
		return NULL;
	}
	return value;
}

void json_free(json_value *value) {
	while (value != NULL) {
		json_value *next = value->next;
		json_free(value->first);
		free(value->string);
		free(value->name);
		free(value);
		value = next;
	}
}

const json_value *json_member(const json_value *object, const char *name) {
	if (object == NULL || object->type != JSON_OBJECT) return NULL;
	for (const json_value *child = object->first; child != NULL; child = child->next) {
		if (child->name != NULL && strcmp(child->name, name) == 0) return child;
	}
	return NULL;
}

bool json_as_number(const json_value *value, double *out) {
	if (value == NULL || value->type != JSON_NUMBER || !isfinite(value->number)) return false;
	*out = value->number;
	return true;
}

bool json_member_number(const json_value *object, const char *name, double *out) {
	return json_as_number(json_member(object, name), out);
}

const char *json_as_string(const json_value *value) {
	if (value == NULL || value->type != JSON_STRING) return NULL;
	return value->string;
}

bool json_member_bool(const json_value *object, const char *name, bool fallback) {
	const json_value *value = json_member(object, name);
	if (value == NULL || value->type != JSON_BOOL) return fallback;
	return value->boolean;
}

void jw_init(json_writer *writer) {
	writer->data = NULL;
	writer->length = 0;
	writer->capacity = 0;
	writer->failed = false;
}

void jw_free(json_writer *writer) {
	free(writer->data);
	jw_init(writer);
}

static bool jw_reserve(json_writer *writer, size_t extra) {
	if (writer->failed) return false;
	if (writer->length + extra + 1 <= writer->capacity) return true;
	size_t capacity = writer->capacity == 0 ? 256 : writer->capacity;
	while (capacity < writer->length + extra + 1) capacity *= 2;
	char *data = realloc(writer->data, capacity);
	if (data == NULL) {
		writer->failed = true;
		return false;
	}
	writer->data = data;
	writer->capacity = capacity;
	return true;
}

void jw_raw(json_writer *writer, const char *text) {
	size_t size = strlen(text);
	if (!jw_reserve(writer, size)) return;
	memcpy(writer->data + writer->length, text, size);
	writer->length += size;
	writer->data[writer->length] = '\0';
}

void jw_char(json_writer *writer, char value) {
	if (!jw_reserve(writer, 1)) return;
	writer->data[writer->length++] = value;
	writer->data[writer->length] = '\0';
}

/*
 * The length of the well-formed UTF-8 sequence at `cursor`, or 0 when the bytes
 * there are not one. Overlong forms, surrogates and anything past U+10FFFF are
 * all ill-formed; a truncated sequence stops at the terminator, so this never
 * reads past the end of the string.
 */
static size_t utf8_sequence_length(const unsigned char *cursor) {
	unsigned char first = cursor[0];
	size_t length;
	unsigned int code_point;
	if (first < 0xC2) return 0; /* a continuation byte, or an overlong two-byte lead */
	if (first < 0xE0) {
		length = 2;
		code_point = first & 0x1Fu;
	} else if (first < 0xF0) {
		length = 3;
		code_point = first & 0x0Fu;
	} else if (first < 0xF5) {
		length = 4;
		code_point = first & 0x07u;
	} else {
		return 0;
	}
	for (size_t index = 1; index < length; index++) {
		if ((cursor[index] & 0xC0) != 0x80) return 0;
		code_point = (code_point << 6) | (cursor[index] & 0x3Fu);
	}
	if (length == 3 && (code_point < 0x800 || (code_point >= 0xD800 && code_point <= 0xDFFF))) {
		return 0;
	}
	if (length == 4 && (code_point < 0x10000 || code_point > 0x10FFFF)) return 0;
	return length;
}

/*
 * Window titles and app ids come from arbitrary Wayland clients, which are free
 * to hand over bytes that are not UTF-8 at all. The reader on the other end of
 * this pipe decodes fatally, so one mojibake title would fail every response
 * that quotes it, for as long as that window stays open. Ill-formed bytes
 * become U+FFFD here, the same substitution the parser makes on the way in.
 */
void jw_string(json_writer *writer, const char *value) {
	jw_char(writer, '"');
	if (value != NULL) {
		for (const unsigned char *cursor = (const unsigned char *)value; *cursor != '\0'; cursor++) {
			unsigned char c = *cursor;
			switch (c) {
			case '"': jw_raw(writer, "\\\""); break;
			case '\\': jw_raw(writer, "\\\\"); break;
			case '\n': jw_raw(writer, "\\n"); break;
			case '\r': jw_raw(writer, "\\r"); break;
			case '\t': jw_raw(writer, "\\t"); break;
			case '\b': jw_raw(writer, "\\b"); break;
			case '\f': jw_raw(writer, "\\f"); break;
			default:
				if (c < 0x20) {
					char escape[7];
					snprintf(escape, sizeof(escape), "\\u%04x", c);
					jw_raw(writer, escape);
				} else if (c < 0x80) {
					jw_char(writer, (char)c);
				} else {
					size_t sequence = utf8_sequence_length(cursor);
					if (sequence == 0) {
						jw_raw(writer, "\xEF\xBF\xBD");
					} else {
						for (size_t index = 0; index < sequence; index++) {
							jw_char(writer, (char)cursor[index]);
						}
						cursor += sequence - 1; /* the loop's own step covers the last byte */
					}
				}
			}
		}
	}
	jw_char(writer, '"');
}

void jw_number(json_writer *writer, double value) {
	if (!isfinite(value)) {
		jw_raw(writer, "null");
		return;
	}
	char text[64];
	snprintf(text, sizeof(text), "%.10g", value);
	jw_raw(writer, text);
}

void jw_int(json_writer *writer, long long value) {
	char text[32];
	snprintf(text, sizeof(text), "%lld", value);
	jw_raw(writer, text);
}

void jw_key(json_writer *writer, const char *name) {
	jw_string(writer, name);
	jw_char(writer, ':');
}
