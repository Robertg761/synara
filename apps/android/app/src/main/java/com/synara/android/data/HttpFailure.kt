package com.synara.android.data

/**
 * What to tell the reader when the server rejected a request without explaining why.
 *
 * Synara normally returns a `message`/`error` sentence and that is always preferred. When it does
 * not — a proxy in front of the tunnel, a route that does not exist on an older server, an
 * unhandled crash — the fallback used to be the status code verbatim ("Synara returned HTTP 404."),
 * which tells someone holding a phone nothing about what to do next. Each branch below names a
 * different remedy, because that is the only reason to distinguish them at all.
 */
internal fun httpFailureMessage(code: Int): String = when (code) {
    404 -> "Your Synara server did not recognise that request. It may be running an older version."
    408, 504 -> "Your Synara server took too long to answer."
    429 -> "Your Synara server is busy right now. Try again in a moment."
    502, 503 -> "Your Synara server is unreachable. Check that it is still running."
    in 500..599 -> "Your Synara server hit an error (HTTP $code)."
    else -> "Synara could not complete the request (HTTP $code)."
}
