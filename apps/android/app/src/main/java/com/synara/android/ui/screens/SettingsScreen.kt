package com.synara.android.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Bolt
import androidx.compose.material.icons.outlined.Info
import androidx.compose.material.icons.outlined.Lock
import androidx.compose.material.icons.automirrored.outlined.Logout
import androidx.compose.material.icons.outlined.Refresh
import androidx.compose.material.icons.outlined.Terminal
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.synara.android.BuildConfig
import com.synara.android.data.AppScreen
import com.synara.android.data.ConnectionState
import com.synara.android.data.SynaraUiState
import com.synara.android.data.SynaraViewModel
import com.synara.android.ui.components.ConnectionPill
import com.synara.android.ui.components.ErrorSnackbar
import com.synara.android.ui.components.InlineNotice
import com.synara.android.ui.components.SectionLabel
import com.synara.android.ui.components.SynaraCard
import com.synara.android.ui.components.SynaraDivider
import com.synara.android.ui.theme.SynaraTheme

@Composable
fun SettingsScreen(state: SynaraUiState, viewModel: SynaraViewModel) {
    var confirmDisconnect by remember { mutableStateOf(false) }

    Scaffold(
        containerColor = MaterialTheme.colorScheme.background,
        topBar = { SynaraTopBar(onBack = viewModel::openWorkspace, title = "Settings") },
        bottomBar = {
            SynaraBottomNav(
                current = AppScreen.SETTINGS,
                onWorkspace = viewModel::openWorkspace,
                onSettings = viewModel::openSettings,
            )
        },
    ) { padding ->
        Box(Modifier.fillMaxSize().padding(padding)) {
            Column(
                Modifier
                    .fillMaxSize()
                    .verticalScroll(rememberScrollState())
                    .padding(
                        horizontal = SynaraTheme.spacing.screenGutter,
                        vertical = SynaraTheme.spacing.sm,
                    ),
                verticalArrangement = Arrangement.spacedBy(SynaraTheme.spacing.sm),
            ) {
                SectionLabel("Connection", Modifier.padding(top = SynaraTheme.spacing.sm))
                SynaraCard(contentSpacing = SynaraTheme.spacing.md) {
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(SynaraTheme.spacing.md),
                    ) {
                        Text(
                            when (state.connection) {
                                ConnectionState.CONNECTED -> "Connected to Synara"
                                ConnectionState.CONNECTING -> "Connecting…"
                                ConnectionState.RECONNECTING -> "Reconnecting…"
                                ConnectionState.DISCONNECTED -> "Disconnected"
                            },
                            modifier = Modifier.weight(1f),
                            style = MaterialTheme.typography.titleSmall,
                            color = MaterialTheme.colorScheme.onSurface,
                        )
                        ConnectionPill(state.connection)
                    }

                    Column(verticalArrangement = Arrangement.spacedBy(SynaraTheme.spacing.xs)) {
                        Text(
                            "Server",
                            style = MaterialTheme.typography.labelMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        Text(
                            state.serverUrl.ifBlank { "Not paired" },
                            style = SynaraTheme.textStyles.mono,
                            color = MaterialTheme.colorScheme.onSurface,
                        )
                    }

                    if (state.serverUrl.startsWith("http://", ignoreCase = true)) {
                        InlineNotice(
                            message = "HTTP is fine on a trusted LAN. Put Synara behind HTTPS before " +
                                "reaching it over the public internet.",
                            icon = Icons.Outlined.Info,
                            contentColor = SynaraTheme.accents.warningForeground,
                            container = SynaraTheme.accents.warningSurface,
                        )
                    }

                    if (!state.isConnected && state.hasStoredSession) {
                        OutlinedButton(
                            onClick = viewModel::reconnectStored,
                            modifier = Modifier.fillMaxWidth(),
                            enabled = state.connection != ConnectionState.CONNECTING,
                            shape = MaterialTheme.shapes.medium,
                        ) {
                            Icon(Icons.Outlined.Refresh, contentDescription = null, modifier = Modifier.size(17.dp))
                            Spacer(Modifier.size(SynaraTheme.spacing.sm))
                            Text("Reconnect to Synara", style = MaterialTheme.typography.labelLarge)
                        }
                    }
                }

                SectionLabel("What this app does", Modifier.padding(top = SynaraTheme.spacing.md))
                SynaraCard(padding = 0.dp, contentSpacing = 0.dp) {
                    FeatureRow(
                        Icons.Outlined.Terminal,
                        "Live transcript",
                        "Assistant output streams into the selected thread as it is produced.",
                    )
                    SynaraDivider(startIndent = 48.dp)
                    FeatureRow(
                        Icons.Outlined.Lock,
                        "Secure pairing",
                        "The bearer session is stored with an Android Keystore key.",
                    )
                    SynaraDivider(startIndent = 48.dp)
                    FeatureRow(
                        Icons.Outlined.Bolt,
                        "Remote control",
                        "Send turns, stop work, and answer approval requests from anywhere.",
                    )
                }

                Spacer(Modifier.height(SynaraTheme.spacing.md))
                OutlinedButton(
                    onClick = { confirmDisconnect = true },
                    modifier = Modifier.fillMaxWidth(),
                    shape = MaterialTheme.shapes.medium,
                    colors = ButtonDefaults.outlinedButtonColors(
                        contentColor = MaterialTheme.colorScheme.error,
                    ),
                    border = androidx.compose.foundation.BorderStroke(
                        1.dp,
                        MaterialTheme.colorScheme.error.copy(alpha = 0.4f),
                    ),
                ) {
                    Icon(Icons.AutoMirrored.Outlined.Logout, contentDescription = null, modifier = Modifier.size(17.dp))
                    Spacer(Modifier.size(SynaraTheme.spacing.sm))
                    Text("Disconnect and clear pairing", style = MaterialTheme.typography.labelLarge)
                }

                Text(
                    "Synara for Android ${BuildConfig.VERSION_NAME} · protocol epoch 1",
                    Modifier
                        .fillMaxWidth()
                        .padding(vertical = SynaraTheme.spacing.xl),
                    style = MaterialTheme.typography.labelMedium,
                    // `outline` is a 15%-alpha hairline token; as text it is barely legible.
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    textAlign = TextAlign.Center,
                )
            }

            ErrorSnackbar(
                message = state.error,
                onDismiss = viewModel::dismissError,
                modifier = Modifier
                    .align(Alignment.BottomCenter)
                    .padding(bottom = SynaraTheme.spacing.md),
            )
        }
    }

    // Clearing the pairing is unrecoverable without going back to the desktop for a fresh link,
    // so it asks first rather than firing straight off a single tap.
    if (confirmDisconnect) {
        AlertDialog(
            onDismissRequest = { confirmDisconnect = false },
            title = { Text("Disconnect this phone?", style = MaterialTheme.typography.titleMedium) },
            text = {
                Text(
                    "The stored session is deleted from this device. You will need a new pairing " +
                        "link from Synara on your desktop to connect again.",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    confirmDisconnect = false
                    viewModel.disconnect()
                }) {
                    Text(
                        "Disconnect",
                        style = MaterialTheme.typography.labelLarge,
                        color = MaterialTheme.colorScheme.error,
                    )
                }
            },
            dismissButton = {
                TextButton(onClick = { confirmDisconnect = false }) {
                    Text("Cancel", style = MaterialTheme.typography.labelLarge)
                }
            },
            containerColor = MaterialTheme.colorScheme.surfaceContainerHigh,
            shape = MaterialTheme.shapes.extraLarge,
        )
    }
}

@Composable
private fun FeatureRow(icon: ImageVector, title: String, body: String) {
    Row(
        Modifier
            .fillMaxWidth()
            .padding(SynaraTheme.spacing.lg),
        horizontalArrangement = Arrangement.spacedBy(SynaraTheme.spacing.md),
        verticalAlignment = Alignment.Top,
    ) {
        Icon(
            icon,
            contentDescription = null,
            modifier = Modifier.size(20.dp),
            tint = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Column(verticalArrangement = Arrangement.spacedBy(SynaraTheme.spacing.xxs)) {
            Text(
                title,
                style = MaterialTheme.typography.titleSmall,
                color = MaterialTheme.colorScheme.onSurface,
            )
            Text(
                body,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}
