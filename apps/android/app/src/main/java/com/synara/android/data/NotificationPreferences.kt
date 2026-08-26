package com.synara.android.data

import android.content.Context

/**
 * Whether the background watch is switched on.
 *
 * Plain SharedPreferences rather than the encrypted session store: this is a UI preference, not a
 * credential, and the service has to read it during process start before anything is unlocked.
 */
class NotificationPreferences(context: Context) {
    private val prefs = context.applicationContext.getSharedPreferences(FILE, Context.MODE_PRIVATE)

    var backgroundWatchEnabled: Boolean
        get() = prefs.getBoolean(KEY_ENABLED, false)
        set(value) = prefs.edit().putBoolean(KEY_ENABLED, value).apply()

    private companion object {
        const val FILE = "synara.notifications"
        const val KEY_ENABLED = "backgroundWatchEnabled"
    }
}
