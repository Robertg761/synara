package com.synara.android.notifications

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import com.synara.android.MainActivity
import com.synara.android.R
import com.synara.android.data.AttentionKind
import com.synara.android.data.ThreadAttention

/**
 * Notification plumbing.
 *
 * Two channels, because the two kinds of alert deserve different treatment and Android only lets
 * the user tune importance per channel. A blocked agent is worth a heads-up notification; a turn
 * finishing is not, and mixing them would push people to silence both.
 */
object SynaraNotifier {
    const val ATTENTION_CHANNEL_ID = "synara.attention"
    const val ACTIVITY_CHANNEL_ID = "synara.activity"
    const val SERVICE_CHANNEL_ID = "synara.connection"

    const val SERVICE_NOTIFICATION_ID = 1

    const val EXTRA_THREAD_ID = "threadId"

    fun createChannels(context: Context) {
        val manager = context.getSystemService(NotificationManager::class.java) ?: return

        manager.createNotificationChannel(
            NotificationChannel(
                ATTENTION_CHANNEL_ID,
                "Needs you",
                NotificationManager.IMPORTANCE_HIGH,
            ).apply {
                description = "An agent is waiting on an approval or an answer."
            },
        )
        manager.createNotificationChannel(
            NotificationChannel(
                ACTIVITY_CHANNEL_ID,
                "Finished work",
                NotificationManager.IMPORTANCE_DEFAULT,
            ).apply {
                description = "A turn finished."
            },
        )
        manager.createNotificationChannel(
            // Minimum importance: this is the "app is connected" notice the platform requires for
            // a foreground service, not something anyone needs to read.
            NotificationChannel(
                SERVICE_CHANNEL_ID,
                "Connection",
                NotificationManager.IMPORTANCE_MIN,
            ).apply {
                description = "Shown while Synara stays connected in the background."
                setShowBadge(false)
            },
        )
    }

    fun canPost(context: Context): Boolean =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) ==
            PackageManager.PERMISSION_GRANTED

    /** The persistent notice the platform requires while the connection service runs. */
    fun connectionNotification(context: Context, connected: Boolean): Notification =
        NotificationCompat.Builder(context, SERVICE_CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(if (connected) "Connected to Synara" else "Reconnecting to Synara")
            .setContentText("Watching for agents that need you.")
            .setContentIntent(openThreadIntent(context, null))
            .setOngoing(true)
            .setSilent(true)
            .setPriority(NotificationCompat.PRIORITY_MIN)
            .build()

    fun notifyAttention(context: Context, attention: ThreadAttention) {
        if (!canPost(context)) return
        val (channel, title) = when (attention.kind) {
            AttentionKind.APPROVAL -> ATTENTION_CHANNEL_ID to "Approval needed"
            AttentionKind.INPUT -> ATTENTION_CHANNEL_ID to "The agent asked a question"
            AttentionKind.FINISHED -> ACTIVITY_CHANNEL_ID to "Turn finished"
        }
        val notification = NotificationCompat.Builder(context, channel)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(title)
            .setContentText(attention.title)
            .setStyle(NotificationCompat.BigTextStyle().bigText(attention.title))
            .setContentIntent(openThreadIntent(context, attention.threadId))
            .setAutoCancel(true)
            .setCategory(
                if (attention.kind == AttentionKind.FINISHED) {
                    NotificationCompat.CATEGORY_STATUS
                } else {
                    NotificationCompat.CATEGORY_CALL
                },
            )
            .setPriority(
                if (attention.kind == AttentionKind.FINISHED) {
                    NotificationCompat.PRIORITY_DEFAULT
                } else {
                    NotificationCompat.PRIORITY_HIGH
                },
            )
            .build()

        // Keyed by thread so a second event for the same thread replaces the first rather than
        // stacking; the newest state is the only one worth acting on.
        runCatching {
            NotificationManagerCompat.from(context).notify(attention.threadId, 0, notification)
        }
    }

    /** Withdraws a thread's notification once it no longer needs anything. */
    fun clearThread(context: Context, threadId: String) {
        runCatching { NotificationManagerCompat.from(context).cancel(threadId, 0) }
    }

    private fun openThreadIntent(context: Context, threadId: String?): PendingIntent {
        val intent = Intent(context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
            threadId?.let { putExtra(EXTRA_THREAD_ID, it) }
        }
        return PendingIntent.getActivity(
            context,
            threadId?.hashCode() ?: 0,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }
}
