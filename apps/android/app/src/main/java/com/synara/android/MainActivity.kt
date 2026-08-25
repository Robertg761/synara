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
        setContent {
            SynaraTheme {
                SynaraApp(viewModel)
            }
        }
    }

    /**
     * `singleTop` means tapping a second notification re-delivers here rather than recreating the
     * activity, so the new thread id arrives through onNewIntent and has to be handled too.
     */
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        openThreadFromIntent(intent)
    }

    private fun openThreadFromIntent(intent: Intent?) {
        intent?.getStringExtra(SynaraNotifier.EXTRA_THREAD_ID)?.let(viewModel::selectThread)
    }
}
