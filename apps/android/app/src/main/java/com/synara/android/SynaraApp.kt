package com.synara.android

import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.size
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.synara.android.data.AppScreen
import com.synara.android.data.ConnectionState
import com.synara.android.data.SynaraViewModel
import com.synara.android.ui.components.SynaraWordmark
import com.synara.android.ui.screens.AutomationsScreen
import com.synara.android.ui.screens.ChatScreen
import com.synara.android.ui.screens.DiffScreen
import com.synara.android.ui.screens.SettingsScreen
import com.synara.android.ui.screens.SourceControlScreen
import com.synara.android.ui.screens.TerminalScreen
import com.synara.android.ui.screens.SetupScreen
import com.synara.android.ui.screens.WorkspaceScreen
import com.synara.android.ui.theme.SynaraMotion
import com.synara.android.ui.theme.SynaraTheme
import com.synara.android.ui.theme.synaraTween

@Composable
fun SynaraApp(viewModel: SynaraViewModel) {
    val state by viewModel.ui.collectAsStateWithLifecycle()
    val showSetup = !state.hasStoredSession && state.connection != ConnectionState.CONNECTED

    Surface(color = MaterialTheme.colorScheme.background, modifier = Modifier.fillMaxSize()) {
        when {
            showSetup -> SetupScreen(state, viewModel::connect, viewModel::reconnectStored)

            state.connection == ConnectionState.CONNECTING &&
                state.projects.isEmpty() &&
                state.isLoading -> ConnectingScreen()

            else -> {
                // Screens cross-fade rather than slide: the top and bottom bars persist across the
                // change, so lateral movement would read as the chrome sliding too. The specs are
                // resolved here because `transitionSpec` is not a composable scope.
                val enter = synaraTween<Float>(SynaraMotion.ScreenMillis)
                val exit = synaraTween<Float>(SynaraMotion.QuickMillis)
                AnimatedContent(
                    targetState = state.screen,
                    transitionSpec = { fadeIn(enter) togetherWith fadeOut(exit) },
                    label = "screen",
                ) { screen ->
                    when (screen) {
                        AppScreen.WORKSPACE -> WorkspaceScreen(state, viewModel)
                        AppScreen.CHAT -> ChatScreen(state, viewModel)
                        AppScreen.SETTINGS -> SettingsScreen(state, viewModel)
                        AppScreen.DIFF -> DiffScreen(state, viewModel)
                        AppScreen.SOURCE_CONTROL -> SourceControlScreen(state, viewModel)
                        AppScreen.AUTOMATIONS -> AutomationsScreen(state, viewModel)
                        AppScreen.TERMINAL -> TerminalScreen(state, viewModel)
                    }
                }
            }
        }
    }
}

@Composable
private fun ConnectingScreen() {
    Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(SynaraTheme.spacing.xl),
        ) {
            SynaraWordmark()
            CircularProgressIndicator(
                modifier = Modifier.size(20.dp),
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                strokeWidth = 2.dp,
            )
            Text(
                "Connecting to your workspace",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}
