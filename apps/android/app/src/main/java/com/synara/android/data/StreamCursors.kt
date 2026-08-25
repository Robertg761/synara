package com.synara.android.data

import java.util.concurrent.ConcurrentHashMap

/**
 * Per-thread cursors of the last orchestration event this client applied.
 *
 * The subscribe RPC accepts an `afterSequence` cursor: when the server can see the gap between
 * that cursor and its journal head it replays exactly the missing events instead of sending a
 * whole-history snapshot, which is what makes surviving a reconnect cheap. Cursors only ever move
 * forward within a stream's lifetime — an out-of-order or replayed frame must not rewind what the
 * client believes it has seen — and they die with the thread list when credentials change.
 */
class StreamCursors {
    private val cursors = ConcurrentHashMap<String, Long>()

    /** The cursor to resume from for [threadId], or `null` when there is nothing to resume. */
    fun resumeFor(threadId: String): Long? =
        cursors[threadId]?.takeIf { it > 0 }

    /**
     * Records that events up to [sequence] have been applied. Returns `false` when the sequence
     * was stale — at or below the cursor — meaning the caller should ignore the frame rather than
     * apply it twice.
     */
    fun advance(threadId: String, sequence: Long): Boolean {
        if (sequence <= 0) return true
        while (true) {
            val current = cursors[threadId] ?: 0L
            if (sequence <= current) return false
            // Absent keys must be *inserted*, not replaced: `replace` is a no-op when the key is
            // missing, so the obvious CAS loop would spin forever on a thread's first event.
            val raced = cursors.putIfAbsent(threadId, sequence)
            if (raced == null) return true
            if (sequence <= raced) return false
            if (cursors.replace(threadId, raced, sequence)) return true
        }
    }

    /**
     * Drops the cursor for [threadId] entirely. Used when a stream ends in an error the resume
     * path cannot fix — a purged thread or an overflowed replay window both demand a fresh
     * snapshot, which is exactly what subscribing without a cursor produces.
     */
    fun forget(threadId: String) {
        cursors.remove(threadId)
    }

    fun clear() = cursors.clear()
}
