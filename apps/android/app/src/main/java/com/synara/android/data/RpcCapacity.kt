package com.synara.android.data

import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException

/**
 * A typed rejection from the server's WebSocket RPC layer.
 *
 * The server answers a failed RPC with a `WsRpcError` payload rather than a bare string, and the
 * admission-control codes in particular carry a retry contract the client is expected to honor.
 * Collapsing that into a plain [IOException] threw the contract away — and, because the payload was
 * stringified whole, leaked raw JSON into user-facing copy.
 */
class RpcException(
    message: String,
    val code: String?,
    val retryable: Boolean,
    val retryAfterMs: Long?,
) : IOException(message)

/**
 * Per-client admission control on the server (`apps/server/src/wsRequestAdmission.ts`) caps how many
 * requests of a class may be in flight at once and rejects the overflow *before* running anything.
 * Those rejections are therefore always safe to retry: no work was started, so a retry cannot
 * duplicate a side effect. Every other failure is left alone, because a mutation that failed
 * mid-flight must not be replayed blindly.
 */
object RpcCapacity {
    const val EXPENSIVE_READ_CAPACITY_EXCEEDED = "RPC_EXPENSIVE_READ_CAPACITY_EXCEEDED"
    const val REQUEST_CAPACITY_EXCEEDED = "RPC_REQUEST_CAPACITY_EXCEEDED"

    /**
     * The server's `expensive-read` budget. Deliberately fanning out wider than this only converts
     * work into rejections, so bulk discovery paces itself to the budget instead of relying on the
     * retry loop to absorb the overflow.
     */
    const val EXPENSIVE_READ_BUDGET = 2

    /**
     * A slot frees as soon as an in-flight read finishes, so waiting is cheap and almost always
     * short. The ceiling only exists so a client that somehow never gets a slot still gives up.
     */
    const val RETRY_LIMIT = 12

    private const val DEFAULT_RETRY_AFTER_MS = 250L

    fun isCapacityError(error: Throwable): Boolean =
        error is RpcException &&
            error.retryable &&
            (error.code == EXPENSIVE_READ_CAPACITY_EXCEEDED || error.code == REQUEST_CAPACITY_EXCEEDED)

    fun shouldRetry(attempt: Int, error: Throwable): Boolean =
        isCapacityError(error) && attempt < RETRY_LIMIT

    /** Honors the server's own pacing hint; falls back to its documented default. */
    fun retryDelayMs(error: Throwable): Long =
        (error as? RpcException)?.retryAfterMs?.takeIf { it > 0 } ?: DEFAULT_RETRY_AFTER_MS

    /**
     * Reads the failure side of an Effect `Exit` frame into a typed error.
     *
     * The payload nests the real cause a few levels down and the shape differs between a typed
     * `WsRpcError` and a defect, so the search walks for the first node that actually carries a
     * message. Only genuine strings count: `optString` renders a nested object as JSON text, which
     * is how the whole error payload used to end up in a toast.
     */
    fun fromExit(exit: JSONObject): RpcException {
        val payload = findErrorPayload(exit.opt("cause")) ?: exit
        val message = findMessage(exit.opt("cause"))
            ?: exit.stringOrNull("message")
            ?: "Synara rejected the request."
        return RpcException(
            message = message,
            code = payload.stringOrNull("code"),
            retryable = payload.optBoolean("retryable", false),
            retryAfterMs = payload.optLong("retryAfterMs", 0L).takeIf { it > 0 },
        )
    }

    /** The first node carrying a `message`, which is the node that also carries `code`/`retryable`. */
    private fun findErrorPayload(value: Any?): JSONObject? = when (value) {
        is JSONObject -> value.takeIf { it.stringValueOrNull("message") != null }
            ?: findErrorPayload(value.opt("error"))
            ?: findErrorPayload(value.opt("cause"))
            ?: findErrorPayload(value.opt("data"))
        is JSONArray -> (0 until value.length()).asSequence()
            .mapNotNull { index -> findErrorPayload(value.opt(index)) }
            .firstOrNull()
        else -> null
    }

    private fun findMessage(value: Any?): String? = when (value) {
        is JSONObject -> value.stringValueOrNull("message")
            ?: value.stringValueOrNull("error")
            ?: findMessage(value.opt("error"))
            ?: findMessage(value.opt("cause"))
            ?: findMessage(value.opt("data"))
        is JSONArray -> (0 until value.length()).asSequence()
            .mapNotNull { index -> findMessage(value.opt(index)) }
            .firstOrNull()
        else -> null
    }

    /** [stringOrNull] accepts anything `optString` can render; this accepts only real strings. */
    private fun JSONObject.stringValueOrNull(key: String): String? =
        (opt(key) as? String)?.trim()?.takeIf { it.isNotEmpty() }
}
