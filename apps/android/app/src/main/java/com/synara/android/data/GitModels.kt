package com.synara.android.data

import org.json.JSONObject

/** One changed path in the working tree, with its line counts. */
data class GitFileChange(
    val path: String,
    val insertions: Int,
    val deletions: Int,
) {
    val fileName: String get() = path.substringAfterLast('/')
    val directory: String get() = path.substringBeforeLast('/', "")

    companion object {
        fun fromJson(json: JSONObject) = GitFileChange(
            path = json.stringOrNull("path") ?: "",
            insertions = json.optInt("insertions", 0),
            deletions = json.optInt("deletions", 0),
        )
    }
}

/** The pull request the current branch resolves to, when there is one. */
data class GitPullRequestInfo(
    val number: Int,
    val title: String,
    val url: String,
    val baseBranch: String,
    val headBranch: String,
    val state: String,
    val isDraft: Boolean,
    val mergeability: String?,
    val additions: Int?,
    val deletions: Int?,
    val changedFiles: Int?,
) {
    companion object {
        fun fromJson(json: JSONObject) = GitPullRequestInfo(
            number = json.optInt("number", 0),
            title = json.stringOrNull("title") ?: "",
            url = json.stringOrNull("url") ?: "",
            baseBranch = json.stringOrNull("baseBranch") ?: "",
            headBranch = json.stringOrNull("headBranch") ?: "",
            state = json.stringOrNull("state") ?: "open",
            isDraft = json.optBoolean("isDraft", false),
            mergeability = json.stringOrNull("mergeability"),
            additions = json.optIntOrNull("additions"),
            deletions = json.optIntOrNull("deletions"),
            changedFiles = json.optIntOrNull("changedFiles"),
        )
    }
}

/** `GitStatusResult`: the whole source-control picture for one checkout. */
data class GitStatus(
    val branch: String?,
    val hasWorkingTreeChanges: Boolean,
    val files: List<GitFileChange>,
    val insertions: Int,
    val deletions: Int,
    val hasUpstream: Boolean,
    val upstreamBranch: String?,
    val aheadCount: Int,
    val behindCount: Int,
    val pullRequest: GitPullRequestInfo?,
) {
    companion object {
        fun fromJson(json: JSONObject): GitStatus {
            val workingTree = json.objectOrNull("workingTree")
            return GitStatus(
                branch = json.stringOrNull("branch"),
                hasWorkingTreeChanges = json.optBoolean("hasWorkingTreeChanges", false),
                files = workingTree?.arrayOrEmpty("files")?.objects()?.map(GitFileChange::fromJson).orEmpty(),
                insertions = workingTree?.optInt("insertions", 0) ?: 0,
                deletions = workingTree?.optInt("deletions", 0) ?: 0,
                hasUpstream = json.optBoolean("hasUpstream", false),
                upstreamBranch = json.stringOrNull("upstreamBranch"),
                aheadCount = json.optInt("aheadCount", 0),
                behindCount = json.optInt("behindCount", 0),
                pullRequest = json.objectOrNull("pr")?.let(GitPullRequestInfo::fromJson),
            )
        }
    }
}

data class GitBranchItem(
    val name: String,
    val isCurrent: Boolean,
    val isDefault: Boolean,
    val isRemote: Boolean,
    val remoteName: String?,
    /** Set when the branch is already checked out in another worktree, which blocks checkout. */
    val worktreePath: String?,
) {
    companion object {
        fun fromJson(json: JSONObject) = GitBranchItem(
            name = json.stringOrNull("name") ?: "",
            isCurrent = json.optBoolean("current", false),
            isDefault = json.optBoolean("isDefault", false),
            isRemote = json.optBoolean("isRemote", false),
            remoteName = json.stringOrNull("remoteName"),
            worktreePath = json.stringOrNull("worktreePath"),
        )
    }
}

data class GitBranches(
    val branches: List<GitBranchItem>,
    val isRepo: Boolean,
    val hasOriginRemote: Boolean,
) {
    companion object {
        fun fromJson(json: JSONObject) = GitBranches(
            branches = json.arrayOrEmpty("branches").objects().map(GitBranchItem::fromJson),
            isRepo = json.optBoolean("isRepo", false),
            hasOriginRemote = json.optBoolean("hasOriginRemote", false),
        )
    }
}

/**
 * `GitStackedAction`: commit, push and open-PR compose into one server-side operation so the
 * phone does not have to sequence them itself and cannot leave a half-finished stack behind.
 */
enum class GitAction(val wire: String, val label: String) {
    COMMIT("commit", "Commit"),
    COMMIT_PUSH("commit_push", "Commit & push"),
    COMMIT_PUSH_PR("commit_push_pr", "Commit, push & open PR"),
    PUSH("push", "Push"),
    CREATE_PR("create_pr", "Open pull request"),
}

/** Outcome of a stacked action, flattened to what a phone-sized summary needs. */
data class GitActionOutcome(
    val action: String,
    val branchStatus: String?,
    val branchName: String?,
    val commitStatus: String?,
    val commitSha: String?,
    val commitSubject: String?,
    val pushStatus: String?,
    val pushBranch: String?,
    val pullRequestUrl: String?,
) {
    companion object {
        fun fromJson(json: JSONObject): GitActionOutcome {
            val branch = json.objectOrNull("branch")
            val commit = json.objectOrNull("commit")
            val push = json.objectOrNull("push")
            val pr = json.objectOrNull("pullRequest") ?: json.objectOrNull("pr")
            return GitActionOutcome(
                action = json.stringOrNull("action") ?: "",
                branchStatus = branch?.stringOrNull("status"),
                branchName = branch?.stringOrNull("name"),
                commitStatus = commit?.stringOrNull("status"),
                commitSha = commit?.stringOrNull("commitSha"),
                commitSubject = commit?.stringOrNull("subject"),
                pushStatus = push?.stringOrNull("status"),
                pushBranch = push?.stringOrNull("branch"),
                pullRequestUrl = pr?.stringOrNull("url"),
            )
        }
    }

    /** One line describing what happened, for the confirmation toast. */
    fun summary(): String {
        val parts = mutableListOf<String>()
        commitSha?.let { parts += "committed ${it.take(7)}" }
        if (pushStatus == "pushed") parts += "pushed to ${pushBranch ?: "remote"}"
        pullRequestUrl?.let { parts += "pull request opened" }
        return if (parts.isEmpty()) "Nothing to do." else parts.joinToString(", ").replaceFirstChar { it.uppercase() }
    }
}

internal fun JSONObject.optIntOrNull(key: String): Int? =
    if (isNull(key) || !has(key)) null else optInt(key)
