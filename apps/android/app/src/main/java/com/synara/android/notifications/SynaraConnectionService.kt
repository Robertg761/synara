package com.synara.android.notifications

import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import com.synara.android.SynaraApplication
import com.synara.android.data.ConnectionState
import com.synara.android.data.RepositoryEvent
import com.synara.android.data.ThreadAttentionDiffer
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

/**
 * Keeps the Synara connection alive while the app is backgrounded and raises a notification when a
 * thread starts needing a person.
 *
 * A foreground service is the honest mechanism here. The server has no push infrastructure, so
 * there is nothing to deliver a message to a sleeping app; WorkManager's fifteen-minute floor is
 * useless for an agent blocked *now*. Holding the socket is the only way the phone learns about an
 * approval request in time to act on it, and Android requires a visible notice for that — which
 * this posts on a minimum-importance channel.
 *
 * The service is opt-in and stops cleanly, so the cost is only paid by people who want it.
 */
class SynaraConnectionService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val differ = ThreadAttentionDiffer()
    private var shellStream: String? = null
    private var collectJob: Job? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            stopSelf()
            return START_NOT_STICKY
        }

        startForegroundNotice(connected = false)
        if (collectJob == null) start()
        // Restarted after a process death so the watch resumes without the user reopening the app.
        return START_STICKY
    }

    private fun start() {
        val repository = (application as SynaraApplication).repository

        collectJob = scope.launch {
            repository.events().collect { event ->
                when (event) {
                    is RepositoryEvent.ConnectionChanged -> {
                        startForegroundNotice(event.state == ConnectionState.CONNECTED)
                        if (event.state != ConnectionState.CONNECTED) {
                            // State from before a drop cannot be trusted as a baseline: work may
                            // have finished while the socket was down, and diffing across the gap
                            // would report it as if it had just happened.
                            differ.reset()
                        }
                    }

                    is RepositoryEvent.ShellChanged -> {
                        differ.diff(event.snapshot.threads).forEach { attention ->
                            SynaraNotifier.notifyAttention(this@SynaraConnectionService, attention)
                        }
                        differ.resolved(event.snapshot.threads).forEach { threadId ->
                            SynaraNotifier.clearThread(this@SynaraConnectionService, threadId)
                        }
                    }

                    else -> Unit
                }
            }
        }

        scope.launch {
            runCatching {
                if (repository.storedSession() != null) repository.reconnectStored()
                shellStream = repository.subscribeShell()
            }
        }
    }

    private fun startForegroundNotice(connected: Boolean) {
        val notification = SynaraNotifier.connectionNotification(this, connected)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            ServiceCompat.startForeground(
                this,
                SynaraNotifier.SERVICE_NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC,
            )
        } else {
            startForeground(SynaraNotifier.SERVICE_NOTIFICATION_ID, notification)
        }
    }

    override fun onDestroy() {
        // The socket itself is left running: the UI may still be using it, and this service only
        // owns the *watch*, not the connection.
        shellStream?.let { (application as SynaraApplication).repository.stopStream(it) }
        collectJob = null
        scope.cancel()
        super.onDestroy()
    }

    companion object {
        private const val ACTION_STOP = "com.synara.android.STOP_WATCH"

        fun start(context: Context) {
            val intent = Intent(context, SynaraConnectionService::class.java)
            ContextCompat.startForegroundService(context, intent)
        }

        fun stop(context: Context) {
            context.startService(
                Intent(context, SynaraConnectionService::class.java).setAction(ACTION_STOP),
            )
        }
    }
}
