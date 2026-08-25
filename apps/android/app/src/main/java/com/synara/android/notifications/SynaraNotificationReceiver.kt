package com.synara.android.notifications

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationManagerCompat
import com.synara.android.SynaraApplication
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

/**
 * Answers an approval straight from the notification shade.
 *
 * The action buttons carry only the thread id — request ids live in the thread detail, which the
 * background watch never loads. [com.synara.android.data.SynaraRepository.respondToOldestPendingApproval]
 * fetches the detail and answers the oldest still-pending request, so one tap resolves exactly
 * what the notification was about even when several approvals are stacked on a thread.
 */
class SynaraNotificationReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val decision = when (intent.action) {
            ACTION_APPROVE -> "accept"
            ACTION_DECLINE -> "decline"
            else -> return
        }
        val threadId = intent.getStringExtra(SynaraNotifier.EXTRA_THREAD_ID) ?: return

        // goAsync keeps this process alive for the network round trips; a broadcast receiver that
        // returns immediately would be killed before the answer reached the server.
        val pendingResult = goAsync()
        CoroutineScope(Dispatchers.IO).launch {
            try {
                val repository = (context.applicationContext as SynaraApplication).repository
                if (repository.storedSession() == null) return@launch
                if (!repository.isConnected() && repository.currentBearerToken() != null) {
                    repository.wake(force = true)
                    if (!repository.awaitConnected()) return@launch
                }
                val delivered = runCatching {
                    repository.respondToOldestPendingApproval(threadId, decision)
                }.getOrDefault(false)
                if (delivered) NotificationManagerCompat.from(context).cancel(threadId, 0)
            } finally {
                pendingResult.finish()
            }
        }
    }

    companion object {
        const val ACTION_APPROVE = "com.synara.android.APPROVE"
        const val ACTION_DECLINE = "com.synara.android.DECLINE"
    }
}
