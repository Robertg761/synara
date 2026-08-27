package com.synara.android.data

import org.json.JSONArray
import org.json.JSONObject

internal fun JSONObject.stringOrNull(key: String): String? {
    if (!has(key) || isNull(key)) return null
    return optString(key).trim().takeIf { it.isNotEmpty() }
}

internal fun JSONObject.objectOrNull(key: String): JSONObject? {
    if (!has(key) || isNull(key)) return null
    return optJSONObject(key)
}

internal fun JSONObject.arrayOrEmpty(key: String): JSONArray = optJSONArray(key) ?: JSONArray()

internal fun JSONArray.objects(): List<JSONObject> = buildList {
    for (index in 0 until length()) {
        optJSONObject(index)?.let(::add)
    }
}

/**
 * The nine providers `ProviderKind` spans in `packages/contracts`. The app previously hardcoded
 * `"codex"` at every creation site, so a thread created on the phone could only ever be a Codex
 * thread regardless of what the workspace used.
 */
enum class Provider(val kind: String, val label: String) {
    CODEX("codex", "Codex"),
    CLAUDE_AGENT("claudeAgent", "Claude"),
    CURSOR("cursor", "Cursor"),
    ANTIGRAVITY("antigravity", "Antigravity"),
    GROK("grok", "Grok"),
    DROID("droid", "Factory Droid"),
    KILO("kilo", "Kilo"),
    OPENCODE("opencode", "OpenCode"),
    PI("pi", "Pi"),
    ;

    companion object {
        fun fromKind(kind: String): Provider? = entries.firstOrNull { it.kind == kind }

        fun labelFor(kind: String): String =
            fromKind(kind)?.label ?: kind.replaceFirstChar { it.uppercase() }
    }
}

data class ModelOption(
    val slug: String,
    val name: String,
    val description: String?,
    val provider: String = Provider.CODEX.kind,
) {
    val label: String
        get() = name.ifBlank { slug }

    val providerLabel: String
        get() = Provider.labelFor(provider)
}

/** `RuntimeMode` in `packages/contracts/src/orchestration.ts`. */
enum class RuntimeMode(val wire: String, val label: String, val description: String) {
    APPROVAL_REQUIRED(
        "approval-required",
        "Ask first",
        "The agent pauses for approval before it changes anything.",
    ),
    AUTO("auto", "Auto-approve", "Routine actions run without asking; risky ones still stop."),
    FULL_ACCESS("full-access", "Full access", "The agent acts without approval prompts."),
    ;

    companion object {
        fun fromWire(wire: String): RuntimeMode? = entries.firstOrNull { it.wire == wire }

        fun labelFor(wire: String): String =
            fromWire(wire)?.label ?: wire.replace('-', ' ').replaceFirstChar { it.uppercase() }
    }
}

/** `ProviderInteractionMode` in `packages/contracts/src/orchestration.ts`. */
enum class InteractionMode(val wire: String, val label: String, val description: String) {
    DEFAULT("default", "Build", "The agent edits files and runs commands as it works."),
    PLAN("plan", "Plan", "The agent researches and proposes a plan without making changes."),
    ;

    companion object {
        fun fromWire(wire: String): InteractionMode? = entries.firstOrNull { it.wire == wire }

        fun labelFor(wire: String): String =
            fromWire(wire)?.label ?: wire.replaceFirstChar { it.uppercase() }
    }
}

data class ProjectItem(
    val id: String,
    val title: String,
    val workspaceRoot: String,
    val isPinned: Boolean,
    val spaceId: String?,
    val threadCount: Int = 0,
) {
    companion object {
        fun fromJson(json: JSONObject, threadCount: Int = 0): ProjectItem = ProjectItem(
            id = json.stringOrNull("id") ?: json.stringOrNull("projectId") ?: "",
            title = json.stringOrNull("title") ?: "Untitled project",
            workspaceRoot = json.stringOrNull("workspaceRoot") ?: "",
            isPinned = json.optBoolean("isPinned", false),
            spaceId = json.stringOrNull("spaceId"),
            threadCount = threadCount,
        )
    }
}

data class LatestTurn(
    val id: String,
    val state: String,
)

data class ThreadItem(
    val id: String,
    val projectId: String,
    val title: String,
    val provider: String,
    val model: String,
    val runtimeMode: String,
    val interactionMode: String,
    val latestTurn: LatestTurn?,
    val sessionStatus: String?,
    val activeTurnId: String?,
    val hasPendingApprovals: Boolean,
    val hasPendingUserInput: Boolean,
    val isPinned: Boolean,
    val archivedAt: String?,
    val updatedAt: String,
    /** Git operations need a checkout to act on; this is the thread's own, worktree included. */
    val workingDirectory: String?,
    val worktreePath: String?,
    val branch: String?,
) {
    /** Where git commands for this thread should run. A worktree wins over the project root. */
    val gitCwd: String?
        get() = worktreePath?.takeIf { it.isNotBlank() } ?: workingDirectory?.takeIf { it.isNotBlank() }

    val isRunning: Boolean
        get() = latestTurn?.state == "running" || sessionStatus == "running" || sessionStatus == "starting"

    val providerLabel: String
        get() = Provider.labelFor(provider)

    val isArchived: Boolean
        get() = archivedAt != null

    companion object {
        fun fromJson(json: JSONObject): ThreadItem {
            val modelSelection = json.objectOrNull("modelSelection")
            val latestTurnJson = json.objectOrNull("latestTurn")
            val session = json.objectOrNull("session")
            return ThreadItem(
                id = json.stringOrNull("id") ?: json.stringOrNull("threadId") ?: "",
                projectId = json.stringOrNull("projectId") ?: "",
                title = json.stringOrNull("title") ?: "Untitled thread",
                provider = modelSelection?.stringOrNull("provider") ?: Provider.CODEX.kind,
                model = modelSelection?.stringOrNull("model") ?: "default",
                runtimeMode = json.stringOrNull("runtimeMode") ?: "full-access",
                interactionMode = json.stringOrNull("interactionMode") ?: "default",
                latestTurn = latestTurnJson?.let {
                    LatestTurn(
                        id = it.stringOrNull("turnId") ?: "",
                        state = it.stringOrNull("state") ?: "completed",
                    )
                },
                sessionStatus = session?.stringOrNull("status"),
                activeTurnId = session?.stringOrNull("activeTurnId"),
                hasPendingApprovals = json.optBoolean("hasPendingApprovals", false),
                hasPendingUserInput = json.optBoolean("hasPendingUserInput", false),
                isPinned = json.optBoolean("isPinned", false),
                archivedAt = json.stringOrNull("archivedAt"),
                updatedAt = json.stringOrNull("updatedAt") ?: "",
                workingDirectory = json.stringOrNull("workingDirectory"),
                worktreePath = json.stringOrNull("worktreePath"),
                branch = json.stringOrNull("branch"),
            )
        }
    }
}

data class MessageItem(
    val id: String,
    val role: String,
    val text: String,
    val streaming: Boolean,
    val createdAt: String,
    val turnId: String?,
) {
    val isUser: Boolean
        get() = role == "user"

    companion object {
        fun fromJson(json: JSONObject): MessageItem = MessageItem(
            id = json.stringOrNull("id") ?: json.stringOrNull("messageId") ?: "",
            role = json.stringOrNull("role") ?: "assistant",
            text = if (json.has("text") && !json.isNull("text")) json.optString("text") else "",
            streaming = json.optBoolean("streaming", false),
            createdAt = json.stringOrNull("createdAt") ?: "",
            turnId = json.stringOrNull("turnId"),
        )
    }
}

data class UserInputOption(
    val label: String,
    val description: String,
)

data class UserInputQuestion(
    val id: String,
    val header: String,
    val question: String,
    val options: List<UserInputOption>,
    val multiSelect: Boolean,
) {
    companion object {
        fun fromJson(json: JSONObject): UserInputQuestion? {
            val id = json.stringOrNull("id") ?: return null
            val question = json.stringOrNull("question") ?: return null
            return UserInputQuestion(
                id = id,
                header = json.stringOrNull("header") ?: id,
                question = question,
                options = json.arrayOrEmpty("options").objects().mapNotNull { option ->
                    val label = option.stringOrNull("label") ?: return@mapNotNull null
                    UserInputOption(label, option.stringOrNull("description") ?: "")
                },
                multiSelect = json.optBoolean("multiSelect", false),
            )
        }
    }
}

data class ActivityItem(
    val id: String,
    val tone: String,
    val kind: String,
    val summary: String,
    val createdAt: String,
    val payload: JSONObject?,
) {
    companion object {
        fun fromJson(json: JSONObject): ActivityItem = ActivityItem(
            id = json.stringOrNull("id") ?: "",
            tone = json.stringOrNull("tone") ?: "info",
            kind = json.stringOrNull("kind") ?: "activity",
            summary = json.stringOrNull("summary") ?: "",
            createdAt = json.stringOrNull("createdAt") ?: "",
            payload = json.objectOrNull("payload"),
        )
    }
}

data class PendingInteraction(
    val kind: String,
    val requestId: String,
    val lifecycleGeneration: String?,
    val status: String,
    val decision: String?,
) {
    val isApproval: Boolean
        get() = kind == "approval"

    companion object {
        fun fromJson(json: JSONObject): PendingInteraction = PendingInteraction(
            kind = json.stringOrNull("interactionKind") ?: "approval",
            requestId = json.stringOrNull("requestId") ?: "",
            lifecycleGeneration = json.stringOrNull("lifecycleGeneration"),
            status = json.stringOrNull("status") ?: "pending",
            decision = json.stringOrNull("decision"),
        )
    }
}

data class ThreadDetail(
    val thread: ThreadItem,
    val messages: List<MessageItem>,
    val activities: List<ActivityItem>,
    val pendingInteractions: List<PendingInteraction>,
    val notes: String?,
    val proposedPlan: String?,
    val sequence: Long,
    /**
     * Turn checkpoints, oldest first. The diff RPCs address turns by count rather than id, and the
     * checkpoint list is the only place that count is exposed to a client.
     */
    val checkpoints: List<Checkpoint> = emptyList(),
    /** Ids of messages the user pinned, so the transcript can mark them. */
    val pinnedMessageIds: Set<String> = emptySet(),
) {
    /** Highest checkpoint turn count, i.e. the `toTurnCount` for a whole-thread diff. */
    val latestTurnCount: Int?
        get() = checkpoints.maxOfOrNull { it.turnCount }
    fun userInputQuestions(interaction: PendingInteraction): List<UserInputQuestion> =
        activities.asReversed()
            .firstOrNull { activity ->
                activity.kind == "user-input.requested" &&
                    activity.payload?.stringOrNull("requestId") == interaction.requestId
            }
            ?.payload
            ?.arrayOrEmpty("questions")
            ?.objects()
            ?.mapNotNull(UserInputQuestion::fromJson)
            .orEmpty()

    companion object {
        fun fromSnapshot(json: JSONObject): ThreadDetail? {
            val threadJson = json.objectOrNull("thread") ?: return null
            return fromThreadJson(threadJson, json.optLong("snapshotSequence", 0L))
        }

        fun fromThreadJson(json: JSONObject, sequence: Long = 0L): ThreadDetail = ThreadDetail(
            thread = ThreadItem.fromJson(json),
            messages = json.arrayOrEmpty("messages").objects().map(MessageItem::fromJson),
            activities = json.arrayOrEmpty("activities").objects().map(ActivityItem::fromJson),
            pendingInteractions = json.arrayOrEmpty("pendingInteractions")
                .objects()
                .map(PendingInteraction::fromJson),
            notes = json.stringOrNull("notes"),
            proposedPlan = json.arrayOrEmpty("proposedPlans")
                .objects()
                .lastOrNull()
                ?.stringOrNull("planMarkdown"),
            sequence = sequence,
            pinnedMessageIds = json.arrayOrEmpty("pinnedMessages")
                .objects()
                .mapNotNull { it.stringOrNull("messageId") }
                .toSet(),
            checkpoints = json.arrayOrEmpty("checkpoints")
                .objects()
                .map(Checkpoint::fromJson)
                .sortedBy { it.turnCount },
        )
    }
}

/** `OrchestrationCheckpointSummary`: one committed turn's file snapshot. */
data class Checkpoint(
    val turnId: String,
    val turnCount: Int,
    val status: String,
    val assistantMessageId: String?,
    val completedAt: String,
    val fileCount: Int,
) {
    companion object {
        fun fromJson(json: JSONObject): Checkpoint = Checkpoint(
            turnId = json.stringOrNull("turnId") ?: "",
            turnCount = json.optInt("checkpointTurnCount", 0),
            status = json.stringOrNull("status") ?: "unknown",
            assistantMessageId = json.stringOrNull("assistantMessageId"),
            completedAt = json.stringOrNull("completedAt") ?: "",
            fileCount = json.arrayOrEmpty("files").length(),
        )
    }
}

/**
 * A space groups projects. Projects with no space live in "Void" — the desktop's term for the
 * ungrouped default, which is a real state rather than an absence, so it is modelled explicitly.
 */
data class SpaceItem(
    val id: String,
    val name: String,
    val icon: String,
    val sortOrder: Int,
) {
    companion object {
        fun fromJson(json: JSONObject) = SpaceItem(
            id = json.stringOrNull("id") ?: "",
            name = json.stringOrNull("name") ?: "Space",
            icon = json.stringOrNull("icon") ?: "folder",
            sortOrder = json.optInt("sortOrder", 0),
        )
    }
}

/** Files a thread produced into the Studio workspace. */
data class StudioOutput(
    val name: String,
    val relativePath: String,
    val fullPath: String,
    val modifiedAt: String,
) {
    companion object {
        fun fromJson(json: JSONObject) = StudioOutput(
            name = json.stringOrNull("name") ?: "",
            relativePath = json.stringOrNull("relativePath") ?: "",
            fullPath = json.stringOrNull("fullPath") ?: "",
            modifiedAt = json.stringOrNull("modifiedAt") ?: "",
        )
    }
}

data class WorkspaceSnapshot(
    val spaces: List<SpaceItem>,
    val projects: List<ProjectItem>,
    val threads: List<ThreadItem>,
    val updatedAt: String,
    val sequence: Long,
) {
    companion object {
        fun fromJson(json: JSONObject): WorkspaceSnapshot {
            val threads = json.arrayOrEmpty("threads").objects().map(ThreadItem::fromJson)
            val counts = threads.groupingBy { it.projectId }.eachCount()
            val projects = json.arrayOrEmpty("projects").objects().map {
                ProjectItem.fromJson(it, counts[it.stringOrNull("id")] ?: 0)
            }
            return WorkspaceSnapshot(
                spaces = json.arrayOrEmpty("spaces")
                    .objects()
                    .map(SpaceItem::fromJson)
                    .sortedBy { it.sortOrder },
                projects = projects,
                threads = threads,
                updatedAt = json.stringOrNull("updatedAt") ?: "",
                sequence = json.optLong("snapshotSequence", 0L),
            )
        }
    }
}

data class PairingInfo(
    val baseUrl: String,
    val credential: String,
)

/**
 * `ModelSelection` is a discriminated union keyed on `provider`, so the provider must travel with
 * the slug rather than being assumed.
 */
fun modelSelectionJson(model: ModelOption): JSONObject = JSONObject()
    .put("provider", model.provider)
    .put("model", model.slug)

fun nowIso(): String = java.time.OffsetDateTime.now(java.time.ZoneOffset.UTC).toString()
