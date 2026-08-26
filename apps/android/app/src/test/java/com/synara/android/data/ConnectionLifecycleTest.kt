package com.synara.android.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ReconnectBackoffTest {
    private val backoff = ReconnectBackoff()

    @Test
    fun firstRetryIsQuick() {
        assertEquals(500L, backoff.delayForAttempt(1))
    }

    @Test
    fun delayDoublesThenCaps() {
        assertEquals(1000L, backoff.delayForAttempt(2))
        assertEquals(2000L, backoff.delayForAttempt(3))
        assertEquals(4000L, backoff.delayForAttempt(4))
        // Everything past the cap is the same 5s: a server that is down for an hour must not be
        // hammered, but it also must not wait minutes between attempts when it does come back.
        assertEquals(ReconnectBackoff.MAX_MS, backoff.delayForAttempt(5))
        assertEquals(ReconnectBackoff.MAX_MS, backoff.delayForAttempt(50))
    }

    @Test
    fun absurdAttemptNumbersDoNotOverflow() {
        val delay = backoff.delayForAttempt(Int.MAX_VALUE)
        assertTrue(delay in 1..ReconnectBackoff.MAX_MS)
    }

    @Test
    fun jitterTransformsTheNominalDelay() {
        val doubled = ReconnectBackoff(jitter = { it * 2 })
        assertEquals(1000L, doubled.delayForAttempt(1))
    }
}

class StreamCursorsTest {
    @Test
    fun resumeIsAbsentUntilAnEventArrives() {
        val cursors = StreamCursors()
        assertNull(cursors.resumeFor("t1"))
    }

    @Test
    fun advanceMovesForwardAndRejectsStaleFrames() {
        val cursors = StreamCursors()
        assertTrue(cursors.advance("t1", 10L))
        assertEquals(10L, cursors.resumeFor("t1"))
        assertFalse("a replayed frame must not be applied twice", cursors.advance("t1", 10L))
        assertTrue(cursors.advance("t1", 11L))
        assertEquals(11L, cursors.resumeFor("t1"))
    }

    @Test
    fun sequencesAreIndependentPerThread() {
        val cursors = StreamCursors()
        cursors.advance("t1", 10L)
        assertNull("one thread's cursor says nothing about another's", cursors.resumeFor("t2"))
        assertTrue(cursors.advance("t2", 4L))
        assertEquals(10L, cursors.resumeFor("t1"))
    }

    @Test
    fun zeroAndNegativeSequencesAreIgnoredNotStored() {
        val cursors = StreamCursors()
        assertTrue(cursors.advance("t1", 0L))
        assertNull(cursors.resumeFor("t1"))
    }

    @Test
    fun forgetDropsTheCursorSoTheNextSubscribeSnapshots() {
        val cursors = StreamCursors()
        cursors.advance("t1", 10L)
        cursors.forget("t1")
        assertNull(cursors.resumeFor("t1"))
        // After forgetting, any sequence is acceptable again.
        assertTrue(cursors.advance("t1", 5L))
        assertEquals(5L, cursors.resumeFor("t1"))
    }
}
