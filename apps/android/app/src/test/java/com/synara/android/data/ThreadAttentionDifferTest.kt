package com.synara.android.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ThreadAttentionDifferTest {
    private fun thread(
        id: String = "t1",
        title: String = "Thread",
        approvals: Boolean = false,
        input: Boolean = false,
        running: Boolean = false,
        archived: Boolean = false,
    ) = ThreadItem(
        id = id,
        projectId = "p1",
        title = title,
        provider = "codex",
        model = "gpt-5.6-sol",
        runtimeMode = "approval-required",
        interactionMode = "default",
        latestTurn = if (running) LatestTurn("turn", "running") else LatestTurn("turn", "completed"),
        sessionStatus = if (running) "running" else "idle",
        activeTurnId = null,
        hasPendingApprovals = approvals,
        hasPendingUserInput = input,
        isPinned = false,
        archivedAt = if (archived) "2026-01-01T00:00:00Z" else null,
        updatedAt = "2026-01-01T00:00:00Z",
        workingDirectory = "/repo",
        worktreePath = null,
        branch = "main",
    )

    @Test
    fun `the first snapshot never notifies`() {
        // Everything looks new on connect. Firing here would greet the user with a burst of
        // notifications for work they already know about.
        val differ = ThreadAttentionDiffer()
        assertTrue(differ.diff(listOf(thread(approvals = true), thread(id = "t2", input = true))).isEmpty())
    }

    @Test
    fun `a newly pending approval notifies once and not again`() {
        val differ = ThreadAttentionDiffer()
        differ.diff(listOf(thread()))

        val first = differ.diff(listOf(thread(approvals = true)))
        assertEquals(1, first.size)
        assertEquals(AttentionKind.APPROVAL, first.single().kind)

        // The server pushes a shell snapshot on any workspace change; a still-pending approval
        // must not re-fire on each one.
        assertTrue(differ.diff(listOf(thread(approvals = true))).isEmpty())
    }

    @Test
    fun `a newly pending question notifies as input`() {
        val differ = ThreadAttentionDiffer()
        differ.diff(listOf(thread()))
        val events = differ.diff(listOf(thread(input = true)))
        assertEquals(AttentionKind.INPUT, events.single().kind)
    }

    @Test
    fun `a finished turn notifies`() {
        val differ = ThreadAttentionDiffer()
        differ.diff(listOf(thread(running = true)))
        val events = differ.diff(listOf(thread(running = false)))
        assertEquals(AttentionKind.FINISHED, events.single().kind)
    }

    @Test
    fun `a turn that ends by asking is input rather than finished`() {
        val differ = ThreadAttentionDiffer()
        differ.diff(listOf(thread(running = true)))
        val events = differ.diff(listOf(thread(running = false, input = true)))
        assertEquals(AttentionKind.INPUT, events.single().kind)
    }

    @Test
    fun `a turn that ends by requesting approval is approval rather than finished`() {
        val differ = ThreadAttentionDiffer()
        differ.diff(listOf(thread(running = true)))
        val events = differ.diff(listOf(thread(running = false, approvals = true)))
        assertEquals(AttentionKind.APPROVAL, events.single().kind)
    }

    @Test
    fun `archived threads never notify`() {
        val differ = ThreadAttentionDiffer()
        differ.diff(listOf(thread()))
        assertTrue(differ.diff(listOf(thread(approvals = true, archived = true))).isEmpty())
    }

    @Test
    fun `a thread first seen after connecting does not notify`() {
        // It has no previous state to have transitioned from, so there is nothing to report.
        val differ = ThreadAttentionDiffer()
        differ.diff(listOf(thread(id = "t1")))
        assertTrue(differ.diff(listOf(thread(id = "t1"), thread(id = "t2", approvals = true))).isEmpty())
    }

    @Test
    fun `several threads can change at once`() {
        val differ = ThreadAttentionDiffer()
        differ.diff(listOf(thread(id = "a"), thread(id = "b", running = true)))
        val events = differ.diff(
            listOf(thread(id = "a", approvals = true), thread(id = "b", running = false)),
        )
        assertEquals(
            mapOf("a" to AttentionKind.APPROVAL, "b" to AttentionKind.FINISHED),
            events.associate { it.threadId to it.kind },
        )
    }

    @Test
    fun `resolved reports threads that need nothing`() {
        val differ = ThreadAttentionDiffer()
        val resolved = differ.resolved(
            listOf(
                thread(id = "idle"),
                thread(id = "waiting", approvals = true),
                thread(id = "busy", running = true),
            ),
        )
        assertEquals(listOf("idle"), resolved)
    }

    @Test
    fun `reset makes the next snapshot a baseline again`() {
        val differ = ThreadAttentionDiffer()
        differ.diff(listOf(thread()))
        differ.reset()
        // After a reconnect the previous state is stale, so the next snapshot is a fresh baseline.
        assertTrue(differ.diff(listOf(thread(approvals = true))).isEmpty())
    }
}
