package com.synara.android

import java.net.URI

internal object SessionPolicy {
    fun isValid(serverUrl: String?, token: String?): Boolean {
        if (serverUrl.isNullOrBlank() || token.isNullOrBlank()) return false
        return runCatching {
            val uri = URI(serverUrl)
            uri.scheme == "https" && !uri.host.isNullOrBlank() &&
                uri.rawUserInfo == null && uri.rawQuery == null && uri.rawFragment == null &&
                (uri.rawPath.isNullOrEmpty() || uri.rawPath == "/") &&
                (uri.port == -1 || uri.port in 1..65535)
        }.getOrDefault(false)
    }
}
