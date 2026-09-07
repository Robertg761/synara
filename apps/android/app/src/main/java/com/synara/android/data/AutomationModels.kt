package com.synara.android.data

import org.json.JSONObject

/**
 * `AutomationSchedule` is a discriminated union on `type`. Rather than model every variant as a
 * class, the parsed form keeps the raw type plus the fields any variant might carry, and renders a
 * single human sentence — a phone list needs "Every 30 minutes", not a schedule object.
 */
data class AutomationSchedule(
    val type: String,
    val everySeconds: Int?,
    val timeOfDay: String?,
    val dayOfWeek: Int?,
    val expression: String?,
    val runAt: String?,
    val timezone: String?,
) {
    fun describe(): String = when (type) {
        "manual" -> "Manual only"
        "once" -> "Once"
        "interval" -> everySeconds?.let { "Every ${humanDuration(it)}" } ?: "On an interval"
        "daily" -> "Daily at ${timeOfDay ?: "a set time"}"
        "weekdays" -> "Weekdays at ${timeOfDay ?: "a set time"}"
        "weekly" -> "${dayName(dayOfWeek)} at ${timeOfDay ?: "a set time"}"
        "cron" -> expression ?: "On a cron schedule"
        else -> type.replaceFirstChar { it.uppercase() }
    }

    companion object {
        fun fromJson(json: JSONObject?): AutomationSchedule = AutomationSchedule(
            type = json?.stringOrNull("type") ?: "manual",
            everySeconds = json?.optIntOrNull("everySeconds"),
            timeOfDay = json?.stringOrNull("timeOfDay"),
            dayOfWeek = json?.optIntOrNull("dayOfWeek"),
            expression = json?.stringOrNull("expression"),
            runAt = json?.stringOrNull("runAt"),
            timezone = json?.stringOrNull("timezone"),
        )

        private fun dayName(day: Int?): String = when (day) {
            0 -> "Sunday"; 1 -> "Monday"; 2 -> "Tuesday"; 3 -> "Wednesday"
            4 -> "Thursday"; 5 -> "Friday"; 6 -> "Saturday"
            else -> "Weekly"
        }

        private fun humanDuration(seconds: Int): String = when {
            seconds % 86_400 == 0 -> "${seconds / 86_400} day${plural(seconds / 86_400)}"
            seconds % 3_600 == 0 -> "${seconds / 3_600} hour${plural(seconds / 3_600)}"
            seconds % 60 == 0 -> "${seconds / 60} minute${plural(seconds / 60)}"
            else -> "$seconds second${plural(seconds)}"
        }

        private fun plural(value: Int) = if (value == 1) "" else "s"
    }
}

/** `AutomationMode`: where each run executes. */
enum class AutomationMode(val wire: String, val label: String, val description: String) {
    STANDALONE("standalone", "Standalone", "Every run opens a fresh thread."),
    HEARTBEAT("heartbeat", "Heartbeat", "Every run continues a thread you choose."),
    DEDICATED("dedicated", "Dedicated", "One thread the automation owns, growing across runs."),
    ;

    companion object {
        fun fromWire(wire: String?) = entries.firstOrNull { it.wire == wire } ?: STANDALONE
    }
}

data class Automation(
    val id: String,
    val projectId: String,
    val name: String,
    val prompt: String,
    val schedule: AutomationSchedule,
    val enabled: Boolean,
    val nextRunAt: String?,
    val mode: AutomationMode,
    val provider: String,
    val model: String,
    val runtimeMode: String,
    val maxIterations: Int?,
    val iterationCount: Int,
    val stopOnError: Boolean,
    val proposalState: String?,
    val archivedAt: String?,
    val updatedAt: String,
) {
    /** Agent-proposed automations stay disabled until a user accepts them. */
    val isProposal: Boolean get() = proposalState == "pending"

    val providerLabel: String get() = Provider.labelFor(provider)

    companion object {
        fun fromJson(json: JSONObject): Automation {
            val selection = json.objectOrNull("modelSelection")
            return Automation(
                id = json.stringOrNull("id") ?: "",
                projectId = json.stringOrNull("projectId") ?: "",
                name = json.stringOrNull("name") ?: "Untitled automation",
                prompt = json.stringOrNull("prompt") ?: "",
                schedule = AutomationSchedule.fromJson(json.objectOrNull("schedule")),
                enabled = json.optBoolean("enabled", false),
                nextRunAt = json.stringOrNull("nextRunAt"),
                mode = AutomationMode.fromWire(json.stringOrNull("mode")),
                provider = selection?.stringOrNull("provider") ?: Provider.CODEX.kind,
                model = selection?.stringOrNull("model") ?: "default",
                runtimeMode = json.stringOrNull("runtimeMode") ?: "approval-required",
                maxIterations = json.optIntOrNull("maxIterations"),
                iterationCount = json.optInt("iterationCount", 0),
                stopOnError = json.optBoolean("stopOnError", true),
                proposalState = json.stringOrNull("proposalState"),
                archivedAt = json.stringOrNull("archivedAt"),
                updatedAt = json.stringOrNull("updatedAt") ?: "",
            )
        }
    }
}

data class AutomationRun(
    val id: String,
    val automationId: String,
    val threadId: String?,
    val status: String,
    val trigger: String,
    val scheduledFor: String,
    val startedAt: String?,
    val finishedAt: String?,
    val outcome: String?,
    val title: String?,
    val summary: String?,
    val severity: String?,
    val unread: Boolean,
    val error: String?,
) {
    val isTerminal: Boolean
        get() = status in setOf("succeeded", "failed", "cancelled", "interrupted", "skipped")

    val isRunning: Boolean
        get() = status in setOf("pending", "claimed", "running", "waiting-for-approval")

    companion object {
        fun fromJson(json: JSONObject): AutomationRun {
            val result = json.objectOrNull("result")
            return AutomationRun(
                id = json.stringOrNull("id") ?: "",
                automationId = json.stringOrNull("automationId") ?: "",
                threadId = json.stringOrNull("threadId"),
                status = json.stringOrNull("status") ?: "pending",
                trigger = json.objectOrNull("trigger")?.stringOrNull("type") ?: "scheduled",
                scheduledFor = json.stringOrNull("scheduledFor") ?: "",
                startedAt = json.stringOrNull("startedAt"),
                finishedAt = json.stringOrNull("finishedAt"),
                outcome = result?.stringOrNull("outcome"),
                title = result?.stringOrNull("title"),
                summary = result?.stringOrNull("summary"),
                severity = result?.stringOrNull("severity"),
                unread = result?.optBoolean("unread", false) ?: false,
                error = json.stringOrNull("error") ?: json.stringOrNull("failureReason"),
            )
        }
    }
}

data class AutomationList(
    val definitions: List<Automation>,
    val runs: List<AutomationRun>,
) {
    fun runsFor(automationId: String): List<AutomationRun> =
        runs.filter { it.automationId == automationId }.sortedByDescending { it.scheduledFor }

    companion object {
        fun fromJson(json: JSONObject) = AutomationList(
            definitions = json.arrayOrEmpty("definitions").objects().map(Automation::fromJson),
            runs = json.arrayOrEmpty("runs").objects().map(AutomationRun::fromJson),
        )
    }
}
