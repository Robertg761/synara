package com.synara.android

import android.graphics.Color
import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import com.synara.android.data.SynaraViewModel
import com.synara.android.notifications.SynaraNotifier
import com.synara.android.ui.theme.SynaraTheme

class MainActivity : ComponentActivity() {
    // The application owns the connection so the background service and the UI share one socket
    // rather than opening a second.
    private val viewModel: SynaraViewModel by viewModels {
        SynaraViewModel.factory((application as SynaraApplication).repository)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        // Transparent system bars so content runs edge to edge and the app's own background is
        // what shows behind them. Composables apply their own window insets from here on. This
        // replaces the deprecated Window.statusBarColor/navigationBarColor writes the theme used
        // to perform, which no longer have any effect on API 35+.
        enableEdgeToEdge(
            statusBarStyle = SystemBarStyle.auto(Color.TRANSPARENT, Color.TRANSPARENT),
            navigationBarStyle = SystemBarStyle.auto(Color.TRANSPARENT, Color.TRANSPARENT),
        )
        super.onCreate(savedInstanceState)
        openThreadFromIntent(intent)
        // A scanned QR usually cold-starts the app, so the launch intent carries the
        // pairing link here rather than through onNewIntent.
        openPairingFromIntent(intent)
        setContent {
            SynaraTheme {
                SynaraApp(viewModel)
            }
        }
    }

    override fun onStart() {
        super.onStart()
        // Foreground is the moment a half-dead background socket becomes worth fixing now rather
        // than on the reconnect loop's schedule; the repository throttles repeats.
        (application as SynaraApplication).repository.wake()
    }

    /**
     * `singleTop` means tapping a second notification re-delivers here rather than recreating the
     * activity, so the new thread id arrives through onNewIntent and has to be handled too.
     */
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        openThreadFromIntent(intent)
        openPairingFromIntent(intent)
    }

    private fun openThreadFromIntent(intent: Intent?) {
        intent?.getStringExtra(SynaraNotifier.EXTRA_THREAD_ID)?.let(viewModel::openThreadFromNotification)
    }

    /**
     * `synara://pair?server=…&token=…` from a scanned QR or the web app's hand-off button.
     * Prefill only: pairing still takes one deliberate tap, so a stray scan cannot sign the
     * device in by itself.
     */
    private fun openPairingFromIntent(intent: Intent?) {
        val data = intent?.data ?: return
        if (data.scheme != "synara" || data.host != "pair") return
        val server = data.getQueryParameter("server") ?: return
        val token = data.getQueryParameter("token") ?: return
        if (server.isBlank() || token.isBlank()) return
        viewModel.prefillPairing(server, token)
    }
}
