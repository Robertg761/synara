package com.synara.android

import android.app.Application
import com.synara.android.data.SynaraRepository
import com.synara.android.notifications.SynaraNotifier

/**
 * Holds the one connection the whole process shares.
 *
 * The repository used to be created per-Activity, which meant the WebSocket died with the UI. That
 * is fatal for notifications: an agent asking for approval while the phone is in a pocket is
 * exactly the case worth reporting, and an activity-scoped socket is disconnected by then. Owning
 * it here lets [com.synara.android.notifications.SynaraConnectionService] keep it alive across
 * configuration changes and while the app is backgrounded, with the UI attaching to the same
 * instance rather than opening a second one.
 */
class SynaraApplication : Application() {
    val repository: SynaraRepository by lazy { SynaraRepository(this) }

    override fun onCreate() {
        super.onCreate()
        SynaraNotifier.createChannels(this)
    }
}
