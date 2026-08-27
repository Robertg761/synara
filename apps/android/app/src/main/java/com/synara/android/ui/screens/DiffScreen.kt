package com.synara.android.ui.screens

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.outlined.Difference
import androidx.compose.material.icons.outlined.Refresh
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.synara.android.data.DiffFile
import com.synara.android.data.DiffFileStatus
import com.synara.android.data.DiffLine
import com.synara.android.data.DiffLineKind
import com.synara.android.data.DiffScope
import com.synara.android.data.SynaraUiState
import com.synara.android.data.SynaraViewModel
import com.synara.android.ui.components.EmptyState
import com.synara.android.ui.components.InlineNotice
import com.synara.android.ui.components.SynaraDivider
import com.synara.android.ui.theme.SynaraTheme
import com.synara.android.ui.theme.disclosureEnter
import com.synara.android.ui.theme.disclosureExit
import com.synara.android.ui.theme.synaraTween

/**
 * Reviewing what the agent actually changed, which had no representation on the phone at all.
 *
 * Every diff RPC returns a flat patch string, so the file list, per-file counts and line numbering
 * here are all derived by [com.synara.android.data.parseUnifiedDiff]. Files start collapsed with
 * their counts visible: on a phone the first question is "what did it touch", and only then "how".
 */
@Composable
fun DiffScreen(state: SynaraUiState, viewModel: SynaraViewModel) {
    val diff = state.diff
    val parsed = diff.parsed
    val thread = state.detail?.thread ?: state.selectedThread

    Scaffold(
        containerColor = MaterialTheme.colorScheme.background,
        topBar = {
            SynaraTopBar(
                onBack = viewModel::closeDiff,
                title = "Changes",
                subtitle = thread?.title,
                actions = {
                    IconButton(onClick = viewModel::reloadDiff, enabled = !diff.isLoading) {
                        Icon(
                            Icons.Outlined.Refresh,
                            contentDescription = "Reload diff",
                            tint = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                },
            )
        },
    ) { padding ->
        Column(Modifier.fillMaxSize().padding(padding)) {
            DiffScopeSelector(
                selected = diff.scope,
                // The working tree only exists if the thread has a checkout on disk.
                workingTreeAvailable = thread?.gitCwd != null,
                onSelect = viewModel::setDiffScope,
            )
            if (parsed != null && !parsed.isEmpty) {
                DiffTotals(parsed.files.size, parsed.insertions, parsed.deletions)
            }
            SynaraDivider()

            when {
                diff.isLoading && parsed == null -> Box(
                    Modifier.fillMaxSize(),
                    contentAlignment = Alignment.Center,
                ) {
                    CircularProgressIndicator(
                        Modifier.size(22.dp),
                        strokeWidth = 2.dp,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }

                diff.error != null -> Box(Modifier.padding(SynaraTheme.spacing.screenGutter)) {
                    InlineNotice(diff.error)
                }

                parsed == null || parsed.isEmpty -> Box(
                    Modifier.fillMaxSize(),
                    contentAlignment = Alignment.Center,
                ) {
                    EmptyState(
                        icon = Icons.Outlined.Difference,
                        title = "No changes",
                        body = when (diff.scope) {
                            DiffScope.WORKING_TREE -> "The checkout is clean."
                            DiffScope.TURN -> "The latest turn did not touch any files."
                            DiffScope.THREAD -> "This thread has not changed any files yet."
                        },
                    )
                }

                else -> LazyColumn(
                    Modifier.fillMaxSize(),
                    contentPadding = PaddingValues(bottom = SynaraTheme.spacing.xxl),
                ) {
                    items(parsed.files, key = { it.path }) { file ->
                        DiffFileEntry(
                            file = file,
                            expanded = file.path in diff.expanded,
                            onToggle = { viewModel.toggleDiffFile(file.path) },
                        )
                        SynaraDivider()
                    }
                }
            }
        }
    }
}

@Composable
private fun DiffScopeSelector(
    selected: DiffScope,
    workingTreeAvailable: Boolean,
    onSelect: (DiffScope) -> Unit,
) {
    Row(
        Modifier
            .fillMaxWidth()
            .padding(
                horizontal = SynaraTheme.spacing.screenGutter,
                vertical = SynaraTheme.spacing.sm,
            ),
        horizontalArrangement = Arrangement.spacedBy(SynaraTheme.spacing.sm),
    ) {
        DiffScope.entries.forEach { scope ->
            val enabled = scope != DiffScope.WORKING_TREE || workingTreeAvailable
            ScopeChip(
                label = scope.label,
                selected = scope == selected,
                enabled = enabled,
                modifier = Modifier.weight(1f),
                onClick = { onSelect(scope) },
            )
        }
    }
}

@Composable
private fun ScopeChip(
    label: String,
    selected: Boolean,
    enabled: Boolean,
    modifier: Modifier = Modifier,
    onClick: () -> Unit,
) {
    val shape = MaterialTheme.shapes.small
    Box(
        modifier = modifier
            .clip(shape)
            .background(
                if (selected) MaterialTheme.colorScheme.secondaryContainer else Color.Transparent,
                shape,
            )
            .border(
                1.dp,
                if (selected) Color.Transparent else MaterialTheme.colorScheme.outlineVariant,
                shape,
            )
            .clickable(enabled = enabled, onClick = onClick)
            .padding(vertical = SynaraTheme.spacing.sm),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            label,
            style = MaterialTheme.typography.labelMedium,
            color = when {
                !enabled -> MaterialTheme.colorScheme.outline
                selected -> MaterialTheme.colorScheme.onSurface
                else -> MaterialTheme.colorScheme.onSurfaceVariant
            },
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

@Composable
private fun DiffTotals(fileCount: Int, insertions: Int, deletions: Int) {
    Row(
        Modifier
            .fillMaxWidth()
            .padding(
                start = SynaraTheme.spacing.screenGutter,
                end = SynaraTheme.spacing.screenGutter,
                bottom = SynaraTheme.spacing.sm,
            ),
        horizontalArrangement = Arrangement.spacedBy(SynaraTheme.spacing.sm),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            "$fileCount file${if (fileCount == 1) "" else "s"}",
            style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        DiffCounts(insertions, deletions)
    }
}

/** The `+N −M` pair, coloured by the status tokens the web uses for the same badge. */
@Composable
fun DiffCounts(insertions: Int, deletions: Int, modifier: Modifier = Modifier) {
    val accents = SynaraTheme.accents
    Row(modifier, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        if (insertions > 0) {
            Text(
                "+$insertions",
                style = SynaraTheme.textStyles.monoSmall,
                color = accents.statusSuccess,
            )
        }
        if (deletions > 0) {
            Text(
                "−$deletions",
                style = SynaraTheme.textStyles.monoSmall,
                color = accents.statusFailure,
            )
        }
    }
}

@Composable
private fun DiffFileEntry(file: DiffFile, expanded: Boolean, onToggle: () -> Unit) {
    val rotation by animateFloatAsState(
        targetValue = if (expanded) 180f else 0f,
        animationSpec = synaraTween(),
        label = "diff-file-chevron",
    )
    Column(Modifier.fillMaxWidth()) {
        Row(
            Modifier
                .fillMaxWidth()
                .clickable(role = Role.Button, onClick = onToggle)
                .padding(
                    horizontal = SynaraTheme.spacing.screenGutter,
                    vertical = SynaraTheme.spacing.md,
                ),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(SynaraTheme.spacing.sm),
        ) {
            FileStatusMark(file.status)
            Column(Modifier.weight(1f)) {
                Text(
                    file.fileName,
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurface,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                val directory = if (file.status == DiffFileStatus.RENAMED) {
                    file.displayPath
                } else {
                    file.directory
                }
                if (directory.isNotEmpty()) {
                    Text(
                        directory,
                        style = SynaraTheme.textStyles.monoSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
            if (file.isBinary) {
                Text(
                    "binary",
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            } else {
                DiffCounts(file.insertions, file.deletions)
            }
            Icon(
                Icons.Default.KeyboardArrowDown,
                contentDescription = if (expanded) "Collapse ${file.fileName}" else "Expand ${file.fileName}",
                modifier = Modifier.size(18.dp).rotate(rotation),
                tint = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }

        AnimatedVisibility(visible = expanded, enter = disclosureEnter(), exit = disclosureExit()) {
            if (file.isBinary) {
                Text(
                    "Binary file — no textual diff.",
                    Modifier.padding(
                        start = SynaraTheme.spacing.screenGutter,
                        end = SynaraTheme.spacing.screenGutter,
                        bottom = SynaraTheme.spacing.md,
                    ),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            } else {
                // One horizontal scroller for the whole file, not one per line, so long lines
                // scroll together and the gutter stays aligned with the code beside it.
                Column(
                    Modifier
                        .fillMaxWidth()
                        .horizontalScroll(rememberScrollState())
                        .padding(bottom = SynaraTheme.spacing.md),
                ) {
                    file.hunks.forEach { hunk ->
                        HunkHeader(hunk.header)
                        hunk.lines.forEach { line -> DiffLineRow(line) }
                    }
                }
            }
        }
    }
}

@Composable
private fun HunkHeader(header: String) {
    Text(
        header.ifBlank { "…" },
        Modifier
            .fillMaxWidth()
            .background(SynaraTheme.accents.mutedSurface)
            .padding(horizontal = SynaraTheme.spacing.screenGutter, vertical = 4.dp),
        style = SynaraTheme.textStyles.monoSmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        maxLines = 1,
    )
}

@Composable
private fun DiffLineRow(line: DiffLine) {
    val accents = SynaraTheme.accents
    val background = when (line.kind) {
        DiffLineKind.ADDED -> accents.successSurface
        DiffLineKind.REMOVED -> accents.dangerSurface
        else -> Color.Transparent
    }
    val marker = when (line.kind) {
        DiffLineKind.ADDED -> "+"
        DiffLineKind.REMOVED -> "−"
        else -> " "
    }
    val markerColor = when (line.kind) {
        DiffLineKind.ADDED -> accents.successForeground
        DiffLineKind.REMOVED -> accents.dangerForeground
        else -> MaterialTheme.colorScheme.outline
    }

    Row(
        Modifier
            .background(background)
            .padding(start = SynaraTheme.spacing.sm, end = SynaraTheme.spacing.lg),
        verticalAlignment = Alignment.Top,
    ) {
        LineNumber(line.oldNumber)
        LineNumber(line.newNumber)
        Text(
            marker,
            Modifier.padding(horizontal = 4.dp),
            style = SynaraTheme.textStyles.code,
            color = markerColor,
        )
        Text(
            line.text,
            style = SynaraTheme.textStyles.code,
            color = if (line.kind == DiffLineKind.META) {
                MaterialTheme.colorScheme.onSurfaceVariant
            } else {
                MaterialTheme.colorScheme.onSurface
            },
            softWrap = false,
        )
    }
}

@Composable
private fun LineNumber(value: Int?) {
    Text(
        value?.toString().orEmpty(),
        Modifier.width(34.dp),
        style = SynaraTheme.textStyles.monoSmall,
        color = MaterialTheme.colorScheme.outline,
        maxLines = 1,
        textAlign = androidx.compose.ui.text.style.TextAlign.End,
    )
}

@Composable
private fun FileStatusMark(status: DiffFileStatus) {
    val accents = SynaraTheme.accents
    val (letter, color) = when (status) {
        DiffFileStatus.ADDED -> "A" to accents.statusSuccess
        DiffFileStatus.DELETED -> "D" to accents.statusFailure
        DiffFileStatus.RENAMED -> "R" to accents.statusMerged
        DiffFileStatus.MODIFIED -> "M" to accents.statusNeutral
    }
    Box(
        Modifier
            .size(20.dp)
            .background(color.copy(alpha = 0.16f), MaterialTheme.shapes.extraSmall),
        contentAlignment = Alignment.Center,
    ) {
        Text(letter, style = SynaraTheme.textStyles.monoSmall, color = color)
    }
}
