package com.synara.android.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Info
import androidx.compose.material.icons.outlined.Lock
import androidx.compose.material.icons.outlined.Refresh
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import com.synara.android.data.ConnectionState
import com.synara.android.data.SynaraUiState
import com.synara.android.ui.components.InlineNotice
import com.synara.android.ui.components.SynaraCard
import com.synara.android.ui.components.SynaraDivider
import com.synara.android.ui.components.SynaraField
import com.synara.android.ui.components.SynaraWordmark
import com.synara.android.ui.theme.SynaraTheme

@Composable
fun SetupScreen(
    state: SynaraUiState,
    onConnect: (String, String) -> Unit,
    onReconnect: () -> Unit,
) {
    var serverUrl by rememberSaveable(state.serverUrl) { mutableStateOf(state.serverUrl) }
    var pairingInput by rememberSaveable { mutableStateOf("") }
    var pairingVisible by rememberSaveable { mutableStateOf(false) }
    val canConnect = serverUrl.isNotBlank() && pairingInput.isNotBlank() && !state.isLoading
    val hasSavedConnection = state.hasStoredSession && state.connection != ConnectionState.CONNECTING
    val isInsecure = serverUrl.trim().startsWith("http://", ignoreCase = true)

    Surface(color = MaterialTheme.colorScheme.background) {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .systemBarsPadding()
                .imePadding()
                .padding(horizontal = SynaraTheme.spacing.xl, vertical = SynaraTheme.spacing.xxl),
            verticalArrangement = Arrangement.Center,
        ) {
            SynaraWordmark()
            Spacer(Modifier.height(SynaraTheme.spacing.xxl))
            Text(
                "Your agents, in your pocket.",
                style = MaterialTheme.typography.displayLarge,
                color = MaterialTheme.colorScheme.onBackground,
            )
            Spacer(Modifier.height(SynaraTheme.spacing.md))
            Text(
                "Connect to the Synara server running beside your repositories. " +
                    "Your phone becomes a focused remote for chats, approvals, and live agent work.",
                style = MaterialTheme.typography.bodyLarge,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Spacer(Modifier.height(SynaraTheme.spacing.xxl))

            SynaraCard(
                padding = SynaraTheme.spacing.lg,
                contentSpacing = SynaraTheme.spacing.lg,
            ) {
                Column(verticalArrangement = Arrangement.spacedBy(SynaraTheme.spacing.xs)) {
                    Text(
                        "Connect a workspace",
                        style = MaterialTheme.typography.titleLarge,
                        color = MaterialTheme.colorScheme.onSurface,
                    )
                    Text(
                        "Generate a pairing link in Synara on your desktop, then paste the full link or its token here.",
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }

                SynaraField(
                    label = "Server URL",
                    value = serverUrl,
                    onValueChange = { serverUrl = it },
                    placeholder = "http://192.168.1.20:3773",
                    enabled = !state.isLoading,
                    monospace = true,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
                )

                SynaraField(
                    label = "Pairing link or token",
                    value = pairingInput,
                    onValueChange = { pairingInput = it },
                    placeholder = "Paste from Synara",
                    enabled = !state.isLoading,
                    monospace = true,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
                    visualTransformation = if (pairingVisible) {
                        VisualTransformation.None
                    } else {
                        PasswordVisualTransformation()
                    },
                    trailingIcon = {
                        TextButton(onClick = { pairingVisible = !pairingVisible }) {
                            Text(
                                if (pairingVisible) "Hide" else "Show",
                                style = MaterialTheme.typography.labelLarge,
                            )
                        }
                    },
                )

                if (isInsecure) {
                    InlineNotice(
                        message = "This connection is unencrypted on the local network. " +
                            "Use HTTPS when exposing Synara outside your LAN.",
                        icon = Icons.Outlined.Info,
                        contentColor = SynaraTheme.accents.warningForeground,
                        container = SynaraTheme.accents.warningSurface,
                    )
                }

                state.setupError?.let { message -> InlineNotice(message) }

                Button(
                    onClick = { onConnect(serverUrl, pairingInput) },
                    modifier = Modifier.fillMaxWidth(),
                    enabled = canConnect,
                    shape = MaterialTheme.shapes.medium,
                    contentPadding = PaddingValues(vertical = SynaraTheme.spacing.md),
                ) {
                    if (state.isLoading) {
                        CircularProgressIndicator(
                            modifier = Modifier.size(16.dp),
                            strokeWidth = 2.dp,
                            color = MaterialTheme.colorScheme.onPrimary,
                        )
                        Spacer(Modifier.size(SynaraTheme.spacing.sm))
                    }
                    Text(
                        if (state.isLoading) "Connecting…" else "Connect to Synara",
                        style = MaterialTheme.typography.labelLarge,
                    )
                }

                if (hasSavedConnection) {
                    SynaraDivider()
                    Column(verticalArrangement = Arrangement.spacedBy(SynaraTheme.spacing.sm)) {
                        Text(
                            "A saved session is available for ${state.serverUrl}.",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        OutlinedButton(
                            onClick = onReconnect,
                            modifier = Modifier.fillMaxWidth(),
                            shape = MaterialTheme.shapes.medium,
                        ) {
                            Icon(Icons.Outlined.Refresh, contentDescription = null, modifier = Modifier.size(17.dp))
                            Spacer(Modifier.size(SynaraTheme.spacing.sm))
                            Text("Reconnect saved session", style = MaterialTheme.typography.labelLarge)
                        }
                    }
                }
            }

            Spacer(Modifier.height(SynaraTheme.spacing.lg))
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.Center,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(
                    Icons.Outlined.Lock,
                    contentDescription = null,
                    modifier = Modifier.size(14.dp),
                    tint = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Spacer(Modifier.size(SynaraTheme.spacing.xs))
                Text(
                    "Local-first. Your credentials stay on this phone.",
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}
