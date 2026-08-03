package com.synara.android

import android.graphics.Color
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import com.synara.android.data.SynaraRepository
import com.synara.android.data.SynaraViewModel
import com.synara.android.ui.theme.SynaraTheme

class MainActivity : ComponentActivity() {
    private val viewModel: SynaraViewModel by viewModels {
        SynaraViewModel.factory(SynaraRepository(applicationContext))
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
        setContent {
            SynaraTheme {
                SynaraApp(viewModel)
            }
        }
    }
}
