package com.synara.android.data

import org.json.JSONObject

const val DEFAULT_TERMINAL_ID = "default"
const val TERMINAL_MIN_COLS = 20
const val TERMINAL_MAX_COLS = 2_000
const val TERMINAL_MIN_ROWS = 5
const val TERMINAL_MAX_ROWS = 1_000

/** `TerminalSessionSnapshot`. `history` is the scrollback produced before this client attached. */
data class TerminalSnapshot(
    val threadId: String,
    val terminalId: String,
    val cwd: String,
    val status: String,
    val pid: Int?,
    val history: String,
    val exitCode: Int?,
) {
    val isRunning: Boolean get() = status == "running" || status == "starting"

    companion object {
        fun fromJson(json: JSONObject) = TerminalSnapshot(
            threadId = json.stringOrNull("threadId") ?: "",
            terminalId = json.stringOrNull("terminalId") ?: DEFAULT_TERMINAL_ID,
            cwd = json.stringOrNull("cwd") ?: "",
            status = json.stringOrNull("status") ?: "starting",
            pid = json.optIntOrNull("pid"),
            history = json.stringOrNull("history").orEmpty(),
            exitCode = json.optIntOrNull("exitCode"),
        )
    }
}

/**
 * The control keys a physical keyboard has and a soft keyboard does not. Without these the phone
 * terminal cannot interrupt a command, complete a path, or answer a pager — which would make it a
 * log viewer rather than a terminal.
 */
enum class TerminalKey(val label: String, val sequence: String, val description: String) {
    CTRL_C("^C", "\u0003", "Interrupt"),
    CTRL_D("^D", "\u0004", "End of input"),
    CTRL_Z("^Z", "\u001A", "Suspend"),
    TAB("tab", "\t", "Complete"),
    ESC("esc", "\u001B", "Escape"),
    UP("↑", "\u001B[A", "Previous command"),
    DOWN("↓", "\u001B[B", "Next command"),
    LEFT("←", "\u001B[D", "Left"),
    RIGHT("→", "\u001B[C", "Right"),
}
