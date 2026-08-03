package com.synara.android.data

import org.junit.Assert.assertEquals
import org.junit.Test

class KanbanBoardTest {
    private fun thread(
        id: String = "t",
        projectId: String = "p1",
        latestTurn: LatestTurn? = null,
        sessionStatus: String? = null,
        approvals: Boolean = false,
        userInput: Boolean = false,
        archived: Boolean = false,
        pinned: Boolean = false,
        updatedAt: String = "2026-01-01T00:00:00Z",
    ) = ThreadItem(
        id = id,
        projectId = projectId,
        title = id,
        provider = "codex",
        model = "gpt-5.6-sol",
        runtimeMode = "approval-required",
        interactionMode = "default",
        latestTurn = latestTurn,
        sessionStatus = sessionStatus,
        activeTurnId = null,
        hasPendingApprovals = approvals,
        hasPendingUserInput = userInput,
        isPinned = pinned,
        archivedAt = if (archived) "2026-01-01T00:00:00Z" else null,
        updatedAt = updatedAt,
        workingDirectory = "/repo",
        worktreePath = null,
        branch = "main",
    )

    @Test
    fun `a thread that never ran a turn is a draft`() {
        assertEquals(KanbanColumn.DRAFT, deriveKanbanColumn(thread()))
    }

    @Test
    fun `a running turn is in progress`() {
        assertEquals(
            KanbanColumn.IN_PROGRESS,
            deriveKanbanColumn(thread(latestTurn = LatestTurn("t1", "running"))),
        )
    }

    @Test
    fun `a completed turn is done`() {
        assertEquals(
            KanbanColumn.DONE,
            deriveKanbanColumn(thread(latestTurn = LatestTurn("t1", "completed"))),
        )
    }

    @Test
    fun `a pending approval on a live session is in progress`() {
        assertEquals(
            KanbanColumn.IN_PROGRESS,
            deriveKanbanColumn(
                thread(
                    latestTurn = LatestTurn("t1", "completed"),
                    sessionStatus = "running",
                    approvals = true,
                ),
            ),
        )
    }

    @Test
    fun `a pending approval whose session died does not pin the thread to in progress`() {
        // The request can never be answered, so leaving it in progress would strand the card
        // there permanently.
        assertEquals(
            KanbanColumn.DONE,
            deriveKanbanColumn(
                thread(
                    latestTurn = LatestTurn("t1", "completed"),
                    sessionStatus = "exited",
                    approvals = true,
                ),
            ),
        )
    }

    @Test
    fun `a connecting session counts as in progress`() {
        assertEquals(
            KanbanColumn.IN_PROGRESS,
            deriveKanbanColumn(thread(sessionStatus = "connecting")),
        )
    }

    @Test
    fun `a running session with no turn yet is in progress rather than a draft`() {
        assertEquals(
            KanbanColumn.IN_PROGRESS,
            deriveKanbanColumn(thread(sessionStatus = "running", latestTurn = null)),
        )
    }

    @Test
    fun `board groups by column and filters archived threads`() {
        val board = buildKanbanBoard(
            listOf(
                thread(id = "draft"),
                thread(id = "live", latestTurn = LatestTurn("x", "running")),
                thread(id = "done", latestTurn = LatestTurn("x", "completed")),
                thread(id = "gone", latestTurn = LatestTurn("x", "completed"), archived = true),
            ),
            projectId = null,
        )
        assertEquals(listOf("draft"), board.threads(KanbanColumn.DRAFT).map { it.id })
        assertEquals(listOf("live"), board.threads(KanbanColumn.IN_PROGRESS).map { it.id })
        assertEquals(listOf("done"), board.threads(KanbanColumn.DONE).map { it.id })
        assertEquals(3, board.total)
    }

    @Test
    fun `board filters to one project when asked`() {
        val board = buildKanbanBoard(
            listOf(thread(id = "a", projectId = "p1"), thread(id = "b", projectId = "p2")),
            projectId = "p2",
        )
        assertEquals(listOf("b"), board.threads(KanbanColumn.DRAFT).map { it.id })
    }

    @Test
    fun `attention then pinned then recency orders a column`() {
        val board = buildKanbanBoard(
            listOf(
                thread(id = "old", updatedAt = "2026-01-01T00:00:00Z"),
                thread(id = "recent", updatedAt = "2026-03-01T00:00:00Z"),
                thread(id = "pinned", pinned = true, updatedAt = "2026-02-01T00:00:00Z"),
                thread(
                    id = "needs-you",
                    sessionStatus = "running",
                    userInput = true,
                    updatedAt = "2025-01-01T00:00:00Z",
                ),
            ),
            projectId = null,
        )
        assertEquals(listOf("needs-you"), board.threads(KanbanColumn.IN_PROGRESS).map { it.id })
        assertEquals(listOf("pinned", "recent", "old"), board.threads(KanbanColumn.DRAFT).map { it.id })
    }
}
