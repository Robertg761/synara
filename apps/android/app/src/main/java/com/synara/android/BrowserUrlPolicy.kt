package com.synara.android

import java.net.URI

/** Guest pages never load the privileged shell origin, local files, or cleartext URLs. */
internal object BrowserUrlPolicy {
    fun allows(value: String): Boolean {
        if (value == "about:blank") return true
        if (value.length > 8192 || value.any { it.isWhitespace() || it == '\\' }) return false
        return try {
            val uri = URI(value)
            uri.scheme.equals("https", ignoreCase = true) &&
                !uri.host.isNullOrBlank() && uri.rawUserInfo == null &&
                !uri.host.trimEnd('.').equals("app.synara.local", ignoreCase = true) &&
                (uri.port == -1 || uri.port in 1..65535)
        } catch (_: Exception) { false }
    }
}
