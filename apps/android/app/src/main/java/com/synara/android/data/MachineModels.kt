package com.synara.android.data

import org.json.JSONObject

/** A worktree Synara manages for a thread. */
data class ManagedWorktree(
    val path: String,
    val branch: String?,
    val projectId: String?,
    val threadId: String?,
) {
    val name: String get() = path.substringAfterLast('/')

    companion object {
        fun fromJson(json: JSONObject) = ManagedWorktree(
            path = json.stringOrNull("path") ?: "",
            branch = json.stringOrNull("branch"),
            projectId = json.stringOrNull("projectId"),
            threadId = json.stringOrNull("threadId"),
        )
    }
}

/**
 * A process listening on the machine. Synara reports these whether or not it started them, so a
 * dev server left running by hand shows up alongside one an agent launched.
 */
data class LocalServerProcess(
    val id: String,
    val pid: Int,
    val displayName: String,
    val command: String,
    val cwd: String?,
    val ports: List<Int>,
) {
    companion object {
        fun fromJson(json: JSONObject) = LocalServerProcess(
            id = json.stringOrNull("id") ?: "",
            pid = json.optInt("pid", 0),
            displayName = json.stringOrNull("displayName") ?: json.stringOrNull("command") ?: "Process",
            command = json.stringOrNull("command") ?: "",
            cwd = json.stringOrNull("cwd"),
            ports = json.arrayOrEmpty("ports").let { array ->
                (0 until array.length()).mapNotNull { array.optInt(it).takeIf { p -> p > 0 } }
            },
        )
    }
}

/** A paired external MCP client. */
data class ExternalMcpIntegration(
    val id: String,
    val name: String,
    val createdAt: String?,
    val lastUsedAt: String?,
) {
    companion object {
        fun fromJson(json: JSONObject) = ExternalMcpIntegration(
            id = json.stringOrNull("id") ?: "",
            name = json.stringOrNull("name") ?: json.stringOrNull("clientName") ?: "Integration",
            createdAt = json.stringOrNull("createdAt"),
            lastUsedAt = json.stringOrNull("lastUsedAt"),
        )
    }
}

/** Work parked by a stash-and-checkout, so it can be found again rather than silently lost. */
data class GitStashInfo(
    val stashRef: String,
    val branch: String?,
    val message: String,
    val files: List<String>,
) {
    companion object {
        fun fromJson(json: JSONObject): GitStashInfo? {
            val ref = json.stringOrNull("stashRef") ?: return null
            val files = json.arrayOrEmpty("files")
            return GitStashInfo(
                stashRef = ref,
                branch = json.stringOrNull("branch"),
                message = json.stringOrNull("message") ?: "Stashed changes",
                files = (0 until files.length()).mapNotNull { files.optString(it).takeIf(String::isNotBlank) },
            )
        }
    }
}
