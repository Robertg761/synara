package com.synara.android.data

import kotlin.math.min

/**
 * Reconnect delay schedule.
 *
 * Exponential with a hard ceiling, matching the web client's transport: the first retry lands
 * within a second so a network blip costs nothing, while the ceiling keeps a server that is down
 * for an hour from burning battery with an attempt every few hundred milliseconds. [jitter]
 * exists so callers can spread simultaneous clients out; tests pass it through untouched.
 */
class ReconnectBackoff(
    private val jitter: (Long) -> Long = { it },
) {
    /** Delay before retry number [attempt], counting from one. */
    fun delayForAttempt(attempt: Int): Long {
        val step = (attempt - 1).coerceIn(0, MAX_SHIFT)
        return jitter(min(BASE_MS shl step, MAX_MS))
    }

    companion object {
        const val BASE_MS = 500L
        const val MAX_MS = 5_000L
        private const val MAX_SHIFT = 30
    }
}
