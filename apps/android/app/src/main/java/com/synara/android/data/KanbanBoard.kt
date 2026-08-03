package com.synara.android.data

/**
 * Board columns, derived from runtime state exactly as the desktop's `deriveKanbanColumn` does.
 *
 * Column is never stored: it is a function of what the thread is doing right now. Persisting it
 * would let a board drift out of step with the sessions it describes — a thread showing "In
 * progress" whose agent finished an hour ago is worse than no board at all.
 */
enum class KanbanColumn(val label: String) {
    DRAFT("Draft"),
    IN_PROGRESS("In progress"),
    DONE("Done"),
}

/**
 * Mirrors the desktop rule set:
 *  - a thread with an answerable approval or input request, or a running turn, is in progress;
 *  - a thread that has never run a turn is a draft;
 *  - anything else has finished.
 */
fun deriveKanbanColumn(thread: ThreadItem): KanbanColumn {
    val hasPendingRequest = thread.hasPendingApprovals || thread.hasPendingUserInput
    // A pending request whose session already died is unanswerable, and must not pin the thread
    // to In progress forever.
    val sessionCanAnswer = thread.sessionStatus == "running" || thread.sessionStatus == "starting"
    if (hasPendingRequest && sessionCanAnswer) return KanbanColumn.IN_PROGRESS
    if (thread.latestTurn?.state == "running") return KanbanColumn.IN_PROGRESS
    if (thread.sessionStatus == "connecting") return KanbanColumn.IN_PROGRESS
    if (thread.sessionStatus == "running" && thread.latestTurn == null) return KanbanColumn.IN_PROGRESS
    if (thread.latestTurn == null) return KanbanColumn.DRAFT
    return KanbanColumn.DONE
}

data class KanbanBoard(val columns: Map<KanbanColumn, List<ThreadItem>>) {
    fun threads(column: KanbanColumn): List<ThreadItem> = columns[column].orEmpty()

    val total: Int get() = columns.values.sumOf { it.size }
}

fun buildKanbanBoard(threads: List<ThreadItem>, projectId: String?): KanbanBoard {
    val relevant = threads
        .filterNot { it.isArchived }
        .filter { projectId == null || it.projectId == projectId }
    val grouped = KanbanColumn.entries.associateWith { column ->
        relevant
            .filter { deriveKanbanColumn(it) == column }
            .sortedWith(
                compareByDescending<ThreadItem> { it.hasPendingApprovals || it.hasPendingUserInput }
                    .thenByDescending { it.isPinned }
                    .thenByDescending { it.updatedAt },
            )
    }
    return KanbanBoard(grouped)
}
