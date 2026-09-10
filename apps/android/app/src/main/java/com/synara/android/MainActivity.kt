package com.synara.android

import android.content.Intent
import android.os.Bundle
import com.getcapacitor.BridgeActivity

/** The shared web app owns navigation, feature state, and the server connection. */
class MainActivity : BridgeActivity() {
    override fun onNewIntent(intent: Intent) {
        setIntent(intent)
        super.onNewIntent(intent)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        registerPlugin(SynaraShellPlugin::class.java)
        registerPlugin(SynaraBrowserPlugin::class.java)
        super.onCreate(savedInstanceState)
    }
}
