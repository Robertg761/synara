package com.synara.android.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.ViewKanban
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.synara.android.data.KanbanColumn
import com.synara.android.data.ProjectItem
import com.synara.android.data.SynaraUiState
import com.synara.android.data.SynaraViewModel
import com.synara.android.data.ThreadItem
import com.synara.android.data.buildKanbanBoard
import com.synara.android.ui.components.EmptyState
import com.synara.android.ui.components.ProviderMark
import com.synara.android.ui.components.StatusLabel
import com.synara.android.ui.components.SynaraBadge
import com.synara.android.ui.components.SynaraCard
import com.synara.android.ui.format.formatRelativeTimestamp
import com.synara.android.ui.theme.SynaraTheme
import kotlinx.coroutines.launch

/**
 * The project board.
 *
 * The desktop shows three columns side by side; a phone cannot, so the columns become pages. That
 * is the only structural change — column membership is still derived from live runtime state by
 * the same rules, never stored, so the board cannot drift out of step with what the agents are
 * actually doing.
 */
@Composable
fun KanbanScreen(state: SynaraUiState, viewModel: SynaraViewModel) {
    var selectedProject by rememberSaveable { mutableStateOf<String?>(null) }
    val board = remember(state.threads, selectedProject) {
        buildKanbanBoard(state.threads, selectedProject)
    }
    val scope = rememberCoroutineScope()
    val pagerState = rememberPagerState(
        // Open on In progress: it is where anything needing a person lives.
        initialPage = KanbanColumn.IN_PROGRESS.ordinal,
        pageCount = { KanbanColumn.entries.size },
    )

    Scaffold(
        containerColor = MaterialTheme.colorScheme.background,
        topBar = {
            SynaraTopBar(
                onBack = viewModel::closeKanban,
                title = "Board",
                subtitle = "${board.total} thread${if (board.total == 1) "" else "s"}",
            )
        },
    ) { padding ->
        Column(Modifier.fillMaxSize().padding(padding)) {
            if (state.projects.isNotEmpty()) {
                LazyRow(
                    contentPadding = PaddingValues(
                        horizontal = SynaraTheme.spacing.screenGutter,
                        vertical = SynaraTheme.spacing.sm,
                    ),
                    horizontalArrangement = Arrangement.spacedBy(SynaraTheme.spacing.sm),
                ) {
                    item {
                        BoardChip("All projects", selectedProject == null) { selectedProject = null }
                    }
                    items(state.projects, key = ProjectItem::id) { project ->
                        BoardChip(project.title, selectedProject == project.id) {
                            selectedProject = project.id
                        }
                    }
                }
            }

            ColumnTabs(pagerState.currentPage, board) { page ->
                // Tapping a tab animates the pager rather than jumping, so the tab and the swipe
                // read as one control instead of two ways to change the same thing.
                scope.launch { pagerState.animateScrollToPage(page) }
            }

            HorizontalPager(
                state = pagerState,
                modifier = Modifier.fillMaxSize(),
                pageSpacing = SynaraTheme.spacing.sm,
            ) { page ->
                val column = KanbanColumn.entries[page]
                val threads = board.threads(column)
                if (threads.isEmpty()) {
                    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                        EmptyState(
                            icon = Icons.Outlined.ViewKanban,
                            title = "Nothing in ${column.label.lowercase()}",
                            body = when (column) {
                                KanbanColumn.DRAFT -> "Threads that have not run a turn yet appear here."
                                KanbanColumn.IN_PROGRESS -> "Threads with live work or a waiting request appear here."
                                KanbanColumn.DONE -> "Threads whose last turn finished appear here."
                            },
                        )
                    }
                } else {
                    LazyColumn(
                        Modifier.fillMaxSize(),
                        contentPadding = PaddingValues(
                            horizontal = SynaraTheme.spacing.screenGutter,
                            vertical = SynaraTheme.spacing.sm,
                        ),
                        verticalArrangement = Arrangement.spacedBy(SynaraTheme.spacing.sm),
                    ) {
                        items(threads, key = { it.id }) { thread ->
                            BoardCard(
                                thread = thread,
                                projectTitle = state.projects.firstOrNull { it.id == thread.projectId }?.title,
                                onClick = { viewModel.selectThread(thread.id) },
                                onLongClick = { viewModel.openThreadActions(thread.id) },
                            )
                        }
                    }
                }
            }
        }
    }

    ThreadActionsSheet(state, viewModel)
}

@Composable
private fun ColumnTabs(current: Int, board: com.synara.android.data.KanbanBoard, onSelect: (Int) -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = SynaraTheme.spacing.screenGutter, vertical = SynaraTheme.spacing.xs),
        horizontalArrangement = Arrangement.spacedBy(SynaraTheme.spacing.sm),
    ) {
        KanbanColumn.entries.forEachIndexed { index, column ->
            val selected = index == current
            val shape = MaterialTheme.shapes.small
            Row(
                Modifier
                    .weight(1f)
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
                    .clickable { onSelect(index) }
                    .padding(vertical = SynaraTheme.spacing.sm),
                horizontalArrangement = Arrangement.Center,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    column.label,
                    style = MaterialTheme.typography.labelMedium,
                    color = if (selected) {
                        MaterialTheme.colorScheme.onSurface
                    } else {
                        MaterialTheme.colorScheme.onSurfaceVariant
                    },
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Text(
                    "  ${board.threads(column).size}",
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.outline,
                )
            }
        }
    }
}

@Composable
private fun BoardChip(label: String, selected: Boolean, onClick: () -> Unit) {
    val shape = MaterialTheme.shapes.small
    Box(
        Modifier
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
            .clickable(onClick = onClick)
            .padding(horizontal = SynaraTheme.spacing.md, vertical = SynaraTheme.spacing.sm),
    ) {
        Text(
            label,
            style = MaterialTheme.typography.labelMedium,
            color = if (selected) {
                MaterialTheme.colorScheme.onSurface
            } else {
                MaterialTheme.colorScheme.onSurfaceVariant
            },
            maxLines = 1,
        )
    }
}

@Composable
private fun BoardCard(
    thread: ThreadItem,
    projectTitle: String?,
    onClick: () -> Unit,
    onLongClick: () -> Unit,
) {
    val accents = SynaraTheme.accents
    val attention = thread.hasPendingApprovals || thread.hasPendingUserInput
    SynaraCard(
        modifier = Modifier.fillMaxWidth(),
        contentSpacing = SynaraTheme.spacing.sm,
        onClick = onClick,
        onLongClick = onLongClick,
    ) {
        Row(
            Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(SynaraTheme.spacing.sm),
        ) {
            ProviderMark(thread.provider, thread.providerLabel, size = 22.dp)
            Text(
                thread.title,
                Modifier.weight(1f),
                style = MaterialTheme.typography.titleSmall,
                color = MaterialTheme.colorScheme.onSurface,
                maxLines = 3,
                overflow = TextOverflow.Ellipsis,
            )
        }
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(SynaraTheme.spacing.xs),
        ) {
            if (projectTitle != null) {
                Text(
                    projectTitle,
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                )
                Text("·", color = MaterialTheme.colorScheme.outline)
            }
            Text(
                formatRelativeTimestamp(thread.updatedAt),
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.outline,
            )
        }
        when {
            attention -> SynaraBadge(
                text = if (thread.hasPendingApprovals) "Approval needed" else "Input needed",
                container = accents.warningSurface,
                contentColor = accents.warningForeground,
            )

            thread.isRunning -> StatusLabel(
                color = accents.running,
                label = "Running",
                pulsing = true,
                labelColor = accents.successForeground,
            )
        }
    }
}
