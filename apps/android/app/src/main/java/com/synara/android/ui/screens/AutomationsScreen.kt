package com.synara.android.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material.icons.outlined.EventRepeat
import androidx.compose.material.icons.outlined.Pause
import androidx.compose.material.icons.outlined.PlayArrow
import androidx.compose.material.icons.outlined.Refresh
import androidx.compose.material.icons.outlined.Stop
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.synara.android.data.Automation
import com.synara.android.data.AutomationRun
import com.synara.android.data.SynaraUiState
import com.synara.android.data.SynaraViewModel
import com.synara.android.ui.components.ActionSheetItem
import com.synara.android.ui.components.ActionSheetSection
import com.synara.android.ui.components.EmptyState
import com.synara.android.ui.components.InlineNotice
import com.synara.android.ui.components.SectionLabel
import com.synara.android.ui.components.StatusDot
import com.synara.android.ui.components.SynaraActionSheet
import com.synara.android.ui.components.SynaraBadge
import com.synara.android.ui.components.SynaraDivider
import com.synara.android.ui.components.SynaraListRow
import com.synara.android.ui.format.formatRelativeTimestamp
import com.synara.android.ui.theme.SynaraTheme

/**
 * Scheduled work: the automations the desktop manages under its /automations route.
 *
 * Two things drive the layout. Agent-proposed automations are separated out and lead the list,
 * because a proposal is inert until someone resolves it and burying it under live schedules means
 * it never runs. And every row carries its last run's outcome, since "did the 6am sweep find
 * anything" is the question a phone is actually opened to answer.
 */
@Composable
fun AutomationsScreen(state: SynaraUiState, viewModel: SynaraViewModel) {
    val automations = state.automations
    val list = automations.list
    val definitions = remember(list) { list?.definitions?.filter { it.archivedAt == null }.orEmpty() }
    val proposals = remember(definitions) { definitions.filter { it.isProposal } }
    val active = remember(definitions) { definitions.filterNot { it.isProposal } }

    Scaffold(
        containerColor = MaterialTheme.colorScheme.background,
        topBar = {
            SynaraTopBar(
                onBack = viewModel::closeAutomations,
                title = "Automations",
                subtitle = if (definitions.isEmpty()) null else "${definitions.size} scheduled",
                actions = {
                    IconButton(onClick = viewModel::refreshAutomations, enabled = !automations.isLoading) {
                        Icon(
                            Icons.Outlined.Refresh,
                            contentDescription = "Refresh automations",
                            tint = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                },
            )
        },
    ) { padding ->
        Box(Modifier.fillMaxSize().padding(padding)) {
            when {
                automations.isLoading && list == null -> Box(
                    Modifier.fillMaxSize(),
                    contentAlignment = Alignment.Center,
                ) {
                    CircularProgressIndicator(
                        Modifier.size(22.dp),
                        strokeWidth = 2.dp,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }

                definitions.isEmpty() -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    EmptyState(
                        icon = Icons.Outlined.EventRepeat,
                        title = "No automations",
                        body = automations.error
                            ?: "Automations run a prompt on a schedule. Create one from Synara on your desktop, or ask an agent to propose one.",
                    )
                }

                else -> LazyColumn(
                    Modifier.fillMaxSize(),
                    contentPadding = PaddingValues(bottom = SynaraTheme.spacing.xxl),
                ) {
                    automations.notice?.let { notice ->
                        item("notice") {
                            Box(Modifier.padding(SynaraTheme.spacing.screenGutter)) {
                                InlineNotice(
                                    message = notice,
                                    icon = Icons.Outlined.CheckCircle,
                                    contentColor = SynaraTheme.accents.successForeground,
                                    container = SynaraTheme.accents.successSurface,
                                )
                            }
                        }
                    }
                    automations.error?.let { error ->
                        item("error") {
                            Box(Modifier.padding(SynaraTheme.spacing.screenGutter)) {
                                InlineNotice(error)
                            }
                        }
                    }

                    if (proposals.isNotEmpty()) {
                        item("proposals-label") {
                            SectionLabel(
                                "Proposed by an agent",
                                Modifier.padding(
                                    horizontal = SynaraTheme.spacing.screenGutter,
                                    vertical = SynaraTheme.spacing.sm,
                                ),
                            )
                        }
                        items(proposals, key = { "p-${it.id}" }) { automation ->
                            ProposalRow(automation, state, viewModel)
                            SynaraDivider()
                        }
                    }

                    if (active.isNotEmpty()) {
                        item("active-label") {
                            SectionLabel(
                                "Scheduled",
                                Modifier.padding(
                                    start = SynaraTheme.spacing.screenGutter,
                                    end = SynaraTheme.spacing.screenGutter,
                                    top = SynaraTheme.spacing.lg,
                                    bottom = SynaraTheme.spacing.sm,
                                ),
                            )
                        }
                        items(active, key = { it.id }) { automation ->
                            AutomationRow(
                                automation = automation,
                                lastRun = list?.runsFor(automation.id)?.firstOrNull(),
                                busy = automations.busyId == automation.id,
                                onOpen = { viewModel.selectAutomation(automation.id) },
                                onToggle = { viewModel.setAutomationEnabled(automation.id, it) },
                            )
                            SynaraDivider()
                        }
                    }
                }
            }
        }
    }

    automations.selectedId?.let { id ->
        val automation = definitions.firstOrNull { it.id == id }
        if (automation != null) AutomationDetailSheet(automation, state, viewModel)
    }
}

@Composable
private fun AutomationRow(
    automation: Automation,
    lastRun: AutomationRun?,
    busy: Boolean,
    onOpen: () -> Unit,
    onToggle: (Boolean) -> Unit,
) {
    SynaraListRow(onClick = onOpen) {
        Row(
            Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.Top,
            horizontalArrangement = Arrangement.spacedBy(SynaraTheme.spacing.md),
        ) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(SynaraTheme.spacing.xs)) {
                Text(
                    automation.name,
                    style = MaterialTheme.typography.titleSmall,
                    color = MaterialTheme.colorScheme.onSurface,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(SynaraTheme.spacing.xs),
                ) {
                    Text(
                        automation.schedule.describe(),
                        style = MaterialTheme.typography.labelMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Text("·", color = MaterialTheme.colorScheme.outline)
                    Text(
                        automation.mode.label,
                        style = MaterialTheme.typography.labelMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                if (lastRun != null) RunSummaryLine(lastRun)
            }
            if (busy) {
                CircularProgressIndicator(
                    Modifier.size(20.dp).padding(top = 2.dp),
                    strokeWidth = 2.dp,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            } else {
                Switch(
                    checked = automation.enabled,
                    onCheckedChange = onToggle,
                    colors = SwitchDefaults.colors(
                        checkedThumbColor = MaterialTheme.colorScheme.onPrimary,
                        checkedTrackColor = MaterialTheme.colorScheme.primary,
                        uncheckedThumbColor = MaterialTheme.colorScheme.onSurfaceVariant,
                        uncheckedTrackColor = SynaraTheme.accents.mutedSurface,
                        uncheckedBorderColor = MaterialTheme.colorScheme.outlineVariant,
                    ),
                )
            }
        }
    }
}

/** Last-run status in one line: a dot for outcome, the summary, and when it happened. */
@Composable
private fun RunSummaryLine(run: AutomationRun) {
    val accents = SynaraTheme.accents
    val color = when {
        run.isRunning -> accents.running
        run.status == "failed" -> accents.statusFailure
        run.severity == "warning" -> accents.warningForeground
        run.outcome == "findings" || run.outcome == "needs-attention" -> accents.warningForeground
        run.status == "succeeded" -> accents.statusSuccess
        else -> accents.statusNeutral
    }
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        StatusDot(color, pulsing = run.isRunning, size = 6.dp)
        Text(
            run.title ?: run.summary ?: run.status.replace('-', ' ').replaceFirstChar { it.uppercase() },
            style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f, fill = false),
        )
        val stamp = formatRelativeTimestamp(run.finishedAt ?: run.startedAt ?: run.scheduledFor)
        if (stamp.isNotEmpty()) {
            Text(
                " · $stamp",
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.outline,
            )
        }
        if (run.unread) {
            Spacer(Modifier.size(SynaraTheme.spacing.xs))
            SynaraBadge(
                "new",
                container = accents.infoSurface,
                contentColor = accents.infoForeground,
            )
        }
    }
}

@Composable
private fun ProposalRow(automation: Automation, state: SynaraUiState, viewModel: SynaraViewModel) {
    val busy = state.automations.busyId == automation.id
    SynaraListRow(onClick = { viewModel.selectAutomation(automation.id) }) {
        Text(
            automation.name,
            style = MaterialTheme.typography.titleSmall,
            color = MaterialTheme.colorScheme.onSurface,
        )
        Text(
            automation.prompt,
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            maxLines = 3,
            overflow = TextOverflow.Ellipsis,
        )
        Text(
            automation.schedule.describe(),
            style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Row(horizontalArrangement = Arrangement.spacedBy(SynaraTheme.spacing.sm)) {
            OutlinedButton(
                onClick = { viewModel.resolveAutomationProposal(automation.id, accept = true) },
                enabled = !busy,
                shape = MaterialTheme.shapes.medium,
            ) {
                Text("Accept", style = MaterialTheme.typography.labelLarge)
            }
            OutlinedButton(
                onClick = { viewModel.resolveAutomationProposal(automation.id, accept = false) },
                enabled = !busy,
                shape = MaterialTheme.shapes.medium,
            ) {
                Text("Dismiss", style = MaterialTheme.typography.labelLarge)
            }
        }
    }
}

@Composable
private fun AutomationDetailSheet(
    automation: Automation,
    state: SynaraUiState,
    viewModel: SynaraViewModel,
) {
    val runs = state.automations.list?.runsFor(automation.id).orEmpty()
    val busy = state.automations.busyId == automation.id
    var confirmingDelete by remember(automation.id) { mutableStateOf(false) }

    if (!confirmingDelete) {
        SynaraActionSheet(
            title = automation.name,
            subtitle = "${automation.schedule.describe()} · ${automation.mode.label}",
            onDismiss = { viewModel.selectAutomation(null) },
        ) {
            Column(
                Modifier.padding(
                    horizontal = SynaraTheme.spacing.xl,
                    vertical = SynaraTheme.spacing.md,
                ),
                verticalArrangement = Arrangement.spacedBy(SynaraTheme.spacing.sm),
            ) {
                Text(
                    automation.prompt,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 6,
                    overflow = TextOverflow.Ellipsis,
                )
                Row(horizontalArrangement = Arrangement.spacedBy(SynaraTheme.spacing.xs)) {
                    SynaraBadge("${automation.providerLabel} · ${automation.model}")
                    automation.maxIterations?.let {
                        SynaraBadge("${automation.iterationCount}/$it runs")
                    } ?: SynaraBadge("${automation.iterationCount} runs")
                }
                automation.nextRunAt?.let { next ->
                    Text(
                        "Next run ${formatRelativeTimestamp(next).ifEmpty { "scheduled" }}",
                        style = MaterialTheme.typography.labelMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }

            SynaraDivider()
            ActionSheetItem(
                icon = Icons.Outlined.PlayArrow,
                label = "Run now",
                enabled = !busy,
                onClick = { viewModel.runAutomationNow(automation.id) },
            )
            ActionSheetItem(
                icon = if (automation.enabled) Icons.Outlined.Pause else Icons.Outlined.PlayArrow,
                label = if (automation.enabled) "Pause schedule" else "Resume schedule",
                enabled = !busy,
                onClick = { viewModel.setAutomationEnabled(automation.id, !automation.enabled) },
            )
            ActionSheetItem(
                icon = Icons.Outlined.Delete,
                label = "Delete automation",
                destructive = true,
                enabled = !busy,
                onClick = { confirmingDelete = true },
            )

            if (runs.isNotEmpty()) {
                ActionSheetSection("Recent runs")
                Column(Modifier.heightIn(max = 260.dp).verticalScroll(rememberScrollState())) {
                    runs.take(12).forEach { run -> RunRow(run, automation.id, busy, viewModel) }
                }
            }
        }
    }

    if (confirmingDelete) {
        DestructiveConfirmDialog(
            title = "Delete this automation?",
            body = "The schedule stops and its run history is removed. Threads it already created " +
                "are left alone.",
            confirmLabel = "Delete",
            onDismiss = { confirmingDelete = false },
            onConfirm = {
                confirmingDelete = false
                viewModel.deleteAutomation(automation.id)
            },
        )
    }
}

@Composable
private fun RunRow(run: AutomationRun, automationId: String, busy: Boolean, viewModel: SynaraViewModel) {
    Row(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = SynaraTheme.spacing.xl, vertical = SynaraTheme.spacing.sm),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(SynaraTheme.spacing.sm),
    ) {
        Column(Modifier.weight(1f)) {
            RunSummaryLine(run)
            run.error?.let {
                Text(
                    it,
                    style = MaterialTheme.typography.bodySmall,
                    color = SynaraTheme.accents.dangerForeground,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
        // A run still in flight is the only one worth an action here; finished runs are history.
        if (run.isRunning) {
            IconButton(
                onClick = { viewModel.cancelAutomationRun(run.id, automationId) },
                enabled = !busy,
            ) {
                Icon(
                    Icons.Outlined.Stop,
                    contentDescription = "Cancel run",
                    modifier = Modifier.size(18.dp),
                    tint = MaterialTheme.colorScheme.error,
                )
            }
        } else if (run.threadId != null) {
            OutlinedButton(
                onClick = {
                    viewModel.selectAutomation(null)
                    viewModel.selectThread(run.threadId)
                },
                shape = MaterialTheme.shapes.small,
            ) {
                Text("Open", style = MaterialTheme.typography.labelMedium)
            }
        }
    }
}
