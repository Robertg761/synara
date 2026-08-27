package com.synara.android.ui.screens

import android.Manifest
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.ui.platform.LocalContext
import com.synara.android.data.NotificationPreferences
import com.synara.android.notifications.SynaraConnectionService
import com.synara.android.notifications.SynaraNotifier
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import com.synara.android.data.ProviderSettings
import com.synara.android.data.ProviderStatus
import com.synara.android.data.ProviderUsage
import com.synara.android.ui.components.SynaraBadge
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
import androidx.compose.ui.text.style.TextOverflow
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

                NotificationSection()

                ServerSettingsSections(state, viewModel)

                MachineSections(state, viewModel)

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

/**
 * Server-side settings: the same values the desktop's Settings route writes, read and patched
 * over `server.getSettings` / `server.updateSettings`.
 *
 * Every write is a sparse patch. Sending the whole settings object back would make the phone
 * clobber fields it never rendered — per-provider launch args, custom model lists, skill
 * exclusions — simply by having loaded them.
 */
@Composable
private fun ServerSettingsSections(state: SynaraUiState, viewModel: SynaraViewModel) {
    val server = state.serverSettings
    val settings = server.settings

    SectionLabel(
        "Server",
        Modifier.padding(top = SynaraTheme.spacing.md),
        trailing = {
            if (server.isLoading || server.isSaving) {
                CircularProgressIndicator(
                    Modifier.size(14.dp),
                    strokeWidth = 2.dp,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            } else {
                TextButton(onClick = { viewModel.loadServerSettings(refresh = true) }) {
                    Text("Refresh", style = MaterialTheme.typography.labelMedium)
                }
            }
        },
    )

    server.error?.let { InlineNotice(it) }

    if (settings == null) {
        if (!server.isLoading) {
            Text(
                if (state.isConnected) {
                    "Server settings are unavailable."
                } else {
                    "Connect to read server settings."
                },
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        return
    }

    SynaraCard(padding = 0.dp, contentSpacing = 0.dp) {
        SettingSwitch(
            title = "Stream assistant output",
            body = "Show tokens as they are produced instead of waiting for the finished turn.",
            checked = settings.enableAssistantStreaming,
            enabled = !server.isSaving,
            onChange = viewModel::setAssistantStreaming,
        )
        SynaraDivider(startIndent = SynaraTheme.spacing.lg)
        SettingSwitch(
            title = "Check for provider updates",
            body = "Let Synara report when an installed agent CLI is behind its latest release.",
            checked = settings.enableProviderUpdateChecks,
            enabled = !server.isSaving,
            onChange = viewModel::setProviderUpdateChecks,
        )
    }

    Column(verticalArrangement = Arrangement.spacedBy(SynaraTheme.spacing.sm)) {
        Text(
            "New threads run in",
            style = MaterialTheme.typography.labelLarge,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Row(horizontalArrangement = Arrangement.spacedBy(SynaraTheme.spacing.sm)) {
            listOf("local" to "The checkout", "worktree" to "A worktree").forEach { (wire, label) ->
                EnvModeOption(
                    label = label,
                    selected = settings.defaultThreadEnvMode == wire,
                    enabled = !server.isSaving,
                    modifier = Modifier.weight(1f),
                ) { viewModel.setDefaultThreadEnvMode(wire) }
            }
        }
    }

    SectionLabel("Providers", Modifier.padding(top = SynaraTheme.spacing.md))
    SynaraCard(padding = 0.dp, contentSpacing = 0.dp) {
        settings.providers.forEachIndexed { index, providerSettings ->
            if (index > 0) SynaraDivider(startIndent = SynaraTheme.spacing.lg)
            ProviderRow(
                settings = providerSettings,
                status = server.statuses.firstOrNull { it.provider == providerSettings.provider },
                enabled = !server.isSaving,
                onToggle = { viewModel.setProviderEnabled(providerSettings.provider, it) },
            )
        }
    }

    if (server.usage.isNotEmpty()) {
        SectionLabel("Usage", Modifier.padding(top = SynaraTheme.spacing.md))
        SynaraCard(padding = 0.dp, contentSpacing = 0.dp) {
            server.usage.forEachIndexed { index, usage ->
                if (index > 0) SynaraDivider(startIndent = SynaraTheme.spacing.lg)
                UsageRow(usage)
            }
        }
    }
}

@Composable
private fun SettingSwitch(
    title: String,
    body: String,
    checked: Boolean,
    enabled: Boolean,
    onChange: (Boolean) -> Unit,
) {
    Row(
        Modifier.fillMaxWidth().padding(SynaraTheme.spacing.lg),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(SynaraTheme.spacing.md),
    ) {
        Column(Modifier.weight(1f)) {
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
        Switch(
            checked = checked,
            onCheckedChange = onChange,
            enabled = enabled,
            colors = settingSwitchColors(),
        )
    }
}

@Composable
private fun ProviderRow(
    settings: ProviderSettings,
    status: ProviderStatus?,
    enabled: Boolean,
    onToggle: (Boolean) -> Unit,
) {
    val accents = SynaraTheme.accents
    Row(
        Modifier.fillMaxWidth().padding(SynaraTheme.spacing.lg),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(SynaraTheme.spacing.md),
    ) {
        Column(Modifier.weight(1f)) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(SynaraTheme.spacing.xs),
            ) {
                Text(
                    settings.provider.label,
                    style = MaterialTheme.typography.titleSmall,
                    color = MaterialTheme.colorScheme.onSurface,
                )
                status?.version?.let { SynaraBadge(it) }
                if (status?.updateAvailable == true) {
                    SynaraBadge(
                        "update",
                        container = accents.infoSurface,
                        contentColor = accents.infoForeground,
                    )
                }
            }
            // Availability and auth are separate failures: an installed binary that is not signed
            // in needs a different fix from one that is missing, so they are not merged.
            val detail = when {
                status == null -> "Status unknown"
                !status.available -> status.message ?: "Not installed"
                status.authStatus == "authenticated" -> status.authLabel ?: "Signed in"
                else -> "Needs sign-in"
            }
            val detailColor = when {
                status == null -> MaterialTheme.colorScheme.onSurfaceVariant
                !status.available -> accents.statusNeutral
                status.authStatus == "authenticated" -> accents.successForeground
                else -> accents.warningForeground
            }
            Text(detail, style = MaterialTheme.typography.bodySmall, color = detailColor)
        }
        Switch(
            checked = settings.enabled,
            onCheckedChange = onToggle,
            enabled = enabled,
            colors = settingSwitchColors(),
        )
    }
}

@Composable
private fun UsageRow(usage: ProviderUsage) {
    val accents = SynaraTheme.accents
    Column(
        Modifier.fillMaxWidth().padding(SynaraTheme.spacing.lg),
        verticalArrangement = Arrangement.spacedBy(SynaraTheme.spacing.xs),
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(SynaraTheme.spacing.xs),
        ) {
            Text(
                usage.provider.label,
                style = MaterialTheme.typography.titleSmall,
                color = MaterialTheme.colorScheme.onSurface,
            )
            usage.planName?.let { SynaraBadge(it) }
        }
        when {
            // "No usage to show" and "could not fetch" look identical without this distinction.
            !usage.isOk -> Text(
                usage.detail ?: when (usage.status) {
                    "needs-auth" -> "Sign in to read usage."
                    "unsupported" -> "This provider does not report usage."
                    else -> "Usage could not be fetched."
                },
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )

            else -> {
                usage.limits.forEach { limit ->
                    Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
                        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                            Text(
                                limit.window,
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                            limit.usedPercent?.let {
                                Text(
                                    "${it.toInt()}%",
                                    style = SynaraTheme.textStyles.monoSmall,
                                    color = if (it >= 90) accents.statusFailure else MaterialTheme.colorScheme.onSurface,
                                )
                            }
                        }
                        limit.usedPercent?.let { percent ->
                            LinearProgressIndicator(
                                progress = { (percent / 100.0).toFloat().coerceIn(0f, 1f) },
                                modifier = Modifier.fillMaxWidth().height(4.dp),
                                color = if (percent >= 90) accents.statusFailure else MaterialTheme.colorScheme.onSurface,
                                trackColor = accents.mutedSurface,
                                strokeCap = StrokeCap.Round,
                                gapSize = 0.dp,
                                drawStopIndicator = {},
                            )
                        }
                    }
                }
                usage.lines.forEach { line ->
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                        Text(
                            line.label,
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        Text(
                            line.value,
                            style = SynaraTheme.textStyles.monoSmall,
                            color = MaterialTheme.colorScheme.onSurface,
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun EnvModeOption(
    label: String,
    selected: Boolean,
    enabled: Boolean,
    modifier: Modifier = Modifier,
    onClick: () -> Unit,
) {
    val shape = MaterialTheme.shapes.medium
    Box(
        modifier
            .background(
                if (selected) MaterialTheme.colorScheme.secondaryContainer else Color.Transparent,
                shape,
            )
            .border(
                1.dp,
                if (selected) MaterialTheme.colorScheme.outline else MaterialTheme.colorScheme.outlineVariant,
                shape,
            )
            .clickable(enabled = enabled, onClick = onClick)
            .padding(vertical = SynaraTheme.spacing.sm),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            label,
            style = MaterialTheme.typography.labelLarge,
            color = if (selected) {
                MaterialTheme.colorScheme.onSurface
            } else {
                MaterialTheme.colorScheme.onSurfaceVariant
            },
        )
    }
}

@Composable
private fun settingSwitchColors() = SwitchDefaults.colors(
    checkedThumbColor = MaterialTheme.colorScheme.onPrimary,
    checkedTrackColor = MaterialTheme.colorScheme.primary,
    uncheckedThumbColor = MaterialTheme.colorScheme.onSurfaceVariant,
    uncheckedTrackColor = SynaraTheme.accents.mutedSurface,
    uncheckedBorderColor = MaterialTheme.colorScheme.outlineVariant,
)

/**
 * The background watch.
 *
 * The server has no push infrastructure, so the only way the phone learns about a blocked agent
 * while backgrounded is to hold the connection itself — which Android requires a foreground
 * service and a persistent notice for. That cost is stated plainly rather than hidden, and the
 * whole thing is off until asked for.
 */
@Composable
private fun NotificationSection() {
    val context = LocalContext.current
    val preferences = remember { NotificationPreferences(context) }
    var enabled by remember { mutableStateOf(preferences.backgroundWatchEnabled) }
    var permissionDenied by remember { mutableStateOf(false) }

    fun apply(on: Boolean) {
        enabled = on
        preferences.backgroundWatchEnabled = on
        if (on) SynaraConnectionService.start(context) else SynaraConnectionService.stop(context)
    }

    val permissionLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { granted ->
        // Starting the service without permission would run the socket and silently drop every
        // notification, which is worse than not starting it.
        if (granted) apply(true) else permissionDenied = true
    }

    SectionLabel("Notifications", Modifier.padding(top = SynaraTheme.spacing.md))
    SynaraCard(padding = 0.dp, contentSpacing = 0.dp) {
        SettingSwitch(
            title = "Watch in the background",
            body = "Stay connected while the app is closed and notify when an agent needs an " +
                "approval, asks a question, or finishes. Shows a permanent notice, as Android requires.",
            checked = enabled,
            enabled = true,
            onChange = { on ->
                when {
                    !on -> apply(false)
                    SynaraNotifier.canPost(context) -> apply(true)
                    Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU ->
                        permissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)

                    else -> apply(true)
                }
            },
        )
    }
    if (permissionDenied) {
        InlineNotice(
            "Notifications are blocked for Synara. Turn them on in Android settings to use the " +
                "background watch.",
            icon = Icons.Outlined.Info,
            contentColor = SynaraTheme.accents.warningForeground,
            container = SynaraTheme.accents.warningSurface,
        )
    }
}

/**
 * What the machine is currently holding: worktrees, listening dev servers, paired MCP clients.
 *
 * Sections are omitted entirely when empty rather than rendered as "None". On a phone an empty
 * heading is pure noise, and these are all normally empty.
 */
@Composable
private fun MachineSections(state: SynaraUiState, viewModel: SynaraViewModel) {
    val machine = state.machine

    if (machine.worktrees.isNotEmpty()) {
        SectionLabel("Worktrees", Modifier.padding(top = SynaraTheme.spacing.md))
        SynaraCard(padding = 0.dp, contentSpacing = 0.dp) {
            machine.worktrees.forEachIndexed { index, worktree ->
                if (index > 0) SynaraDivider(startIndent = SynaraTheme.spacing.lg)
                Column(Modifier.fillMaxWidth().padding(SynaraTheme.spacing.lg)) {
                    Text(
                        worktree.branch ?: worktree.name,
                        style = MaterialTheme.typography.titleSmall,
                        color = MaterialTheme.colorScheme.onSurface,
                    )
                    Text(
                        worktree.path,
                        style = SynaraTheme.textStyles.monoSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
        }
    }

    if (machine.localServers.isNotEmpty()) {
        SectionLabel("Dev servers", Modifier.padding(top = SynaraTheme.spacing.md))
        SynaraCard(padding = 0.dp, contentSpacing = 0.dp) {
            machine.localServers.forEachIndexed { index, server ->
                if (index > 0) SynaraDivider(startIndent = SynaraTheme.spacing.lg)
                Row(
                    Modifier.fillMaxWidth().padding(SynaraTheme.spacing.lg),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(SynaraTheme.spacing.md),
                ) {
                    Column(Modifier.weight(1f)) {
                        Text(
                            server.displayName,
                            style = MaterialTheme.typography.titleSmall,
                            color = MaterialTheme.colorScheme.onSurface,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                        Text(
                            buildString {
                                append("pid ${server.pid}")
                                if (server.ports.isNotEmpty()) {
                                    append(" · port ${server.ports.joinToString(", ")}")
                                }
                            },
                            style = SynaraTheme.textStyles.monoSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    TextButton(
                        onClick = { viewModel.stopLocalServer(server.id) },
                        enabled = machine.busyId != server.id,
                    ) {
                        Text(
                            "Stop",
                            style = MaterialTheme.typography.labelLarge,
                            color = MaterialTheme.colorScheme.error,
                        )
                    }
                }
            }
        }
    }

    if (machine.integrations.isNotEmpty()) {
        SectionLabel("External MCP clients", Modifier.padding(top = SynaraTheme.spacing.md))
        SynaraCard(padding = 0.dp, contentSpacing = 0.dp) {
            machine.integrations.forEachIndexed { index, integration ->
                if (index > 0) SynaraDivider(startIndent = SynaraTheme.spacing.lg)
                Row(
                    Modifier.fillMaxWidth().padding(SynaraTheme.spacing.lg),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(
                        integration.name,
                        Modifier.weight(1f),
                        style = MaterialTheme.typography.titleSmall,
                        color = MaterialTheme.colorScheme.onSurface,
                    )
                    TextButton(
                        onClick = { viewModel.revokeIntegration(integration.id) },
                        enabled = machine.busyId != integration.id,
                    ) {
                        Text(
                            "Revoke",
                            style = MaterialTheme.typography.labelLarge,
                            color = MaterialTheme.colorScheme.error,
                        )
                    }
                }
            }
        }
    }
}
