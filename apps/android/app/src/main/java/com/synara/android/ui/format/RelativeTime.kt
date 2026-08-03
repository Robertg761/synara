package com.synara.android.ui.format

import java.time.Duration
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

private val TIME_OF_DAY: DateTimeFormatter = DateTimeFormatter.ofPattern("HH:mm", Locale.getDefault())
private val DAY_AND_MONTH: DateTimeFormatter = DateTimeFormatter.ofPattern("d MMM", Locale.getDefault())

/**
 * "just now" / "12m" / "3h" / "Tue" / "14 Mar" — the shorthand a list of threads needs so the
 * timestamp never competes with the title for width.
 *
 * Timestamps arrive from the server as ISO-8601 strings and are occasionally absent or malformed
 * on older rows, so an unparseable value yields an empty label rather than throwing inside
 * composition.
 */
fun formatRelativeTimestamp(
    iso: String,
    now: Instant = Instant.now(),
    zone: ZoneId = ZoneId.systemDefault(),
): String {
    val instant = parseInstantOrNull(iso) ?: return ""
    val elapsed = Duration.between(instant, now)
    if (elapsed.isNegative) return "just now"

    val minutes = elapsed.toMinutes()
    if (minutes < 1) return "just now"
    if (minutes < 60) return "${minutes}m"

    val hours = elapsed.toHours()
    if (hours < 24) return "${hours}h"

    val date = instant.atZone(zone).toLocalDate()
    val today = LocalDate.now(zone)
    val days = java.time.temporal.ChronoUnit.DAYS.between(date, today)
    if (days == 1L) return "yesterday"
    if (days < 7) return "${days}d"
    return DAY_AND_MONTH.format(instant.atZone(zone))
}

/** Wall-clock time for message timestamps inside a transcript. */
fun formatTimeOfDay(iso: String, zone: ZoneId = ZoneId.systemDefault()): String {
    val instant = parseInstantOrNull(iso) ?: return ""
    return TIME_OF_DAY.format(instant.atZone(zone))
}

private fun parseInstantOrNull(iso: String): Instant? {
    if (iso.isBlank()) return null
    return runCatching { Instant.parse(iso) }
        .recoverCatching { java.time.OffsetDateTime.parse(iso).toInstant() }
        .recoverCatching { java.time.ZonedDateTime.parse(iso).toInstant() }
        .getOrNull()
}
