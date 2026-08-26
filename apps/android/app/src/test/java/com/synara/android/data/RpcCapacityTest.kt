package com.synara.android.data

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class RpcCapacityTest {
    private fun failure(error: JSONObject): JSONObject = JSONObject()
        .put("_tag", "Failure")
        .put("cause", JSONObject().put("_tag", "Fail").put("error", error))

    @Test
    fun readsTheAdmissionControlRetryContract() {
        val parsed = RpcCapacity.fromExit(
            failure(
                JSONObject()
                    .put("_tag", "WsRpcError")
                    .put("message", "WebSocket expensive-read request capacity exceeded.")
                    .put("code", RpcCapacity.EXPENSIVE_READ_CAPACITY_EXCEEDED)
                    .put("retryable", true)
                    .put("retryAfterMs", 250),
            ),
        )

        assertEquals("WebSocket expensive-read request capacity exceeded.", parsed.message)
        assertEquals(RpcCapacity.EXPENSIVE_READ_CAPACITY_EXCEEDED, parsed.code)
        assertTrue(parsed.retryable)
        assertEquals(250L, parsed.retryAfterMs)
        assertTrue(RpcCapacity.shouldRetry(0, parsed))
        assertEquals(250L, RpcCapacity.retryDelayMs(parsed))
    }

    @Test
    fun neverSurfacesTheRawPayloadAsTheMessage() {
        // `optString` renders a nested object as JSON text, which used to put the whole error
        // envelope in front of the reader instead of the sentence inside it.
        val parsed = RpcCapacity.fromExit(
            failure(
                JSONObject()
                    .put("message", "Failed to discover Cursor models.")
                    .put("cause", JSONObject().put("message", "spawn cursor-agent ENOENT")),
            ),
        )

        assertEquals("Failed to discover Cursor models.", parsed.message)
    }

    @Test
    fun leavesOrdinaryFailuresAlone() {
        val parsed = RpcCapacity.fromExit(
            failure(JSONObject().put("message", "Provider adapter request failed (cursor).")),
        )

        assertFalse(parsed.retryable)
        assertNull(parsed.code)
        assertFalse(RpcCapacity.shouldRetry(0, parsed))
    }

    @Test
    fun givesUpOnceTheRetryCeilingIsReached() {
        val parsed = RpcCapacity.fromExit(
            failure(
                JSONObject()
                    .put("message", "WebSocket standard request capacity exceeded.")
                    .put("code", RpcCapacity.REQUEST_CAPACITY_EXCEEDED)
                    .put("retryable", true),
            ),
        )

        assertTrue(RpcCapacity.shouldRetry(RpcCapacity.RETRY_LIMIT - 1, parsed))
        assertFalse(RpcCapacity.shouldRetry(RpcCapacity.RETRY_LIMIT, parsed))
        // No hint from the server still has to pace itself rather than spin.
        assertEquals(250L, RpcCapacity.retryDelayMs(parsed))
    }

    @Test
    fun fallsBackToAReadableSentenceWhenTheExitCarriesNothing() {
        assertEquals(
            "Synara rejected the request.",
            RpcCapacity.fromExit(JSONObject().put("_tag", "Failure")).message,
        )
    }
}
