package com.synara.android.data

/** Why a thread is worth interrupting someone for. */
enum class AttentionKind {
    /** The agent is blocked on an approval decision. */
    APPROVAL,

    /** The agent asked a question and cannot continue without an answer. */
    INPUT,

    /** A turn that was running has finished. */
    FINISHED,
}

data class ThreadAttention(
    val threadId: String,
    val title: String,
    val kind: AttentionKind,
)

/**
 * Decides which threads changed into a state worth notifying about.
 *
 * Notifications are driven by *transitions*, never by current state. A thread that has been
 * waiting on an approval for an hour must not re-notify on every shell snapshot — the server
 * pushes one on any workspace change, so state-based notification would fire continuously.
 *
 * The first snapshot after connecting intentionally produces nothing. Everything looks new at that
 * point, and a burst of notifications for work the user already knows about is the fastest way to
 * get an app's notifications turned off for good.
 */
class ThreadAttentionDiffer {
    private var previous: Map<String, Snapshot>? = null

    private data class Snapshot(
        val approvals: Boolean,
        val input: Boolean,
        val running: Boolean,
        val archived: Boolean,
    )

    /** Threads that just entered an attention-worthy state. */
    fun diff(threads: List<ThreadItem>): List<ThreadAttention> {
        val current = threads.associate { thread ->
            thread.id to Snapshot(
                approvals = thread.hasPendingApprovals,
                input = thread.hasPendingUserInput,
                running = thread.isRunning,
                archived = thread.isArchived,
            )
        }
        val before = previous
        previous = current
        if (before == null) return emptyList()

        return threads.mapNotNull { thread ->
            // An archived thread is one the user has explicitly set aside; it should not surface.
            if (thread.isArchived) return@mapNotNull null
            val old = before[thread.id] ?: return@mapNotNull null
            val new = current.getValue(thread.id)

            val kind = when {
                new.approvals && !old.approvals -> AttentionKind.APPROVAL
                new.input && !old.input -> AttentionKind.INPUT
                // "Finished" only counts when nothing else is now blocking: a turn that ends by
                // asking a question is an INPUT event, not a completion.
                old.running && !new.running && !new.approvals && !new.input -> AttentionKind.FINISHED
                else -> null
            } ?: return@mapNotNull null

            ThreadAttention(thread.id, thread.title, kind)
        }
    }

    /** Threads whose notification should be withdrawn because they no longer need anything. */
    fun resolved(threads: List<ThreadItem>): List<String> =
        threads.filter { !it.hasPendingApprovals && !it.hasPendingUserInput && !it.isRunning }
            .map { it.id }

    fun reset() {
        previous = null
    }
}
