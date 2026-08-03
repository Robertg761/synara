@file:OptIn(androidx.compose.foundation.ExperimentalFoundationApi::class)

package com.synara.android.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.outlined.Archive
import androidx.compose.material.icons.outlined.Inbox
import androidx.compose.material.icons.outlined.PushPin
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
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
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.CloudOff
import androidx.compose.material.icons.outlined.CreateNewFolder
import androidx.compose.material.icons.outlined.EventRepeat
import androidx.compose.material.icons.outlined.Forum
import androidx.compose.material.icons.outlined.Refresh
import androidx.compose.material.icons.outlined.Settings
import androidx.compose.material.icons.outlined.ViewKanban
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.synara.android.data.AppScreen
import com.synara.android.data.ConnectionState
import com.synara.android.data.ProjectItem
import com.synara.android.data.SynaraUiState
import com.synara.android.data.SynaraViewModel
import com.synara.android.data.ThreadItem
import com.synara.android.ui.components.ConnectionPill
import com.synara.android.ui.components.EmptyState
import com.synara.android.ui.components.ErrorSnackbar
import com.synara.android.ui.components.ProviderMark
import com.synara.android.ui.components.SectionLabel
import com.synara.android.ui.components.SynaraBadge
import com.synara.android.ui.components.SynaraCard
import com.synara.android.ui.components.SynaraDivider
import com.synara.android.ui.components.SynaraListRow
import com.synara.android.ui.components.SynaraWordmark
import com.synara.android.ui.components.StatusLabel
import com.synara.android.ui.components.ThreadRowSkeleton
import com.synara.android.ui.format.formatRelativeTimestamp
import com.synara.android.ui.theme.SynaraTheme

@Composable
fun WorkspaceScreen(state: SynaraUiState, viewModel: SynaraViewModel) {
    var selectedProject by rememberSaveable { mutableStateOf<String?>(null) }
    var creatingSpace by rememberSaveable { mutableStateOf(false) }

    val spaceProjectIds = remember(state.projects, state.selectedSpaceId) {
        state.projects
            .filter { state.selectedSpaceId == null || it.spaceId == state.selectedSpaceId }
            .map { it.id }
            .toSet()
    }
    val visible = remember(state.threads, selectedProject, state.showArchived, spaceProjectIds) {
        state.threads
            .filter { if (state.showArchived) it.isArchived else !it.isArchived }
            .filter { it.projectId in spaceProjectIds }
            .filter { selectedProject == null || it.projectId == selectedProject }
            .sortedWith(
                compareByDescending<ThreadItem> { it.needsAttention }
                    .thenByDescending { it.isRunning }
                    .thenByDescending { it.isPinned }
                    .thenByDescending { it.updatedAt },
            )
    }
    val attention = remember(visible) { visible.filter { it.needsAttention } }
    val rest = remember(visible) { visible.filterNot { it.needsAttention } }
    val projectsById = remember(state.projects) { state.projects.associateBy(ProjectItem::id) }
    // Projects outside the chosen space are hidden along with their threads, so a space acts as a
    // real workspace boundary rather than only a label on the chip row.
    val spaceProjects = remember(state.projects, spaceProjectIds) {
        state.projects.filter { it.id in spaceProjectIds }
    }
    val showSkeletons = state.isLoading && state.threads.isEmpty()
    val showEmptyState = !showSkeletons && visible.isEmpty()

    Scaffold(
        containerColor = MaterialTheme.colorScheme.background,
        topBar = {
            SynaraTopBar(
                leading = { SynaraWordmark(compact = true) },
                actions = {
                    ConnectionPill(state.connection, Modifier.padding(end = SynaraTheme.spacing.xs))
                    // Refresh belongs to the whole workspace, so it sits in the bar rather than
                    // beside one section heading where it implied it refreshed only that group.
                    IconButton(
                        onClick = viewModel::refresh,
                        enabled = state.connection == ConnectionState.CONNECTED && !state.isRefreshing,
                    ) {
                        if (state.isRefreshing) {
                            CircularProgressIndicator(
                                Modifier.size(17.dp),
                                strokeWidth = 2.dp,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        } else {
                            Icon(
                                Icons.Outlined.Refresh,
                                contentDescription = "Refresh workspace",
                                tint = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }
                    WorkspaceOverflowMenu(state, viewModel) { creatingSpace = true }
                },
            )
        },
        bottomBar = {
            SynaraBottomNav(
                current = AppScreen.WORKSPACE,
                onWorkspace = viewModel::openWorkspace,
                onSettings = viewModel::openSettings,
            )
        },
        floatingActionButton = {
            // The empty state already presents this exact action as its own button; showing both
            // put two identical "Add project" calls to action on one otherwise blank screen.
            if (!showEmptyState) {
                ExtendedFloatingActionButton(
                    onClick = {
                        if (state.projects.isEmpty()) {
                            viewModel.openCreateProject()
                        } else {
                            viewModel.openCreateThread(selectedProject ?: state.projects.firstOrNull()?.id)
                        }
                    },
                    icon = { Icon(Icons.Outlined.Add, contentDescription = null) },
                    text = { Text(if (state.projects.isEmpty()) "Add project" else "New thread") },
                    containerColor = MaterialTheme.colorScheme.primary,
                    contentColor = MaterialTheme.colorScheme.onPrimary,
                    shape = MaterialTheme.shapes.large,
                )
            }
        },
    ) { padding ->
        Box(Modifier.fillMaxSize().padding(padding)) {
            LazyColumn(
                modifier = Modifier.fillMaxSize(),
                // Bottom room for the extended FAB so the final row is never trapped beneath it.
                contentPadding = PaddingValues(bottom = 96.dp),
            ) {
                if (state.connection != ConnectionState.CONNECTED) {
                    item(key = "offline") {
                        OfflineNotice(state, viewModel::refreshOrReconnect)
                    }
                }

                if (state.spaces.isNotEmpty()) {
                    item(key = "spaces") {
                        SpaceFilters(
                            spaces = state.spaces,
                            selected = state.selectedSpaceId,
                            onSelect = viewModel::selectSpace,
                            onLongPress = { spaceId -> viewModel.openSpaceActions(spaceId) },
                        )
                    }
                }

                if (spaceProjects.isNotEmpty()) {
                    item(key = "filters") {
                        ProjectFilters(
                            projects = spaceProjects,
                            selected = selectedProject,
                            onSelect = { selectedProject = it },
                            onLongPress = viewModel::openProjectActions,
                        )
                    }
                }

                if (attention.isNotEmpty()) {
                    item(key = "attention-label") {
                        SectionLabel(
                            "Needs you",
                            Modifier.padding(
                                start = SynaraTheme.spacing.screenGutter,
                                end = SynaraTheme.spacing.screenGutter,
                                top = SynaraTheme.spacing.lg,
                                bottom = SynaraTheme.spacing.xs,
                            ),
                        )
                    }
                    // Dividers separate rows *within* a section only. A trailing divider under the
                    // last row would stack against the next section heading and read as a double
                    // rule.
                    itemsIndexed(attention, key = { _, thread -> "a-${thread.id}" }) { index, thread ->
                        if (index > 0) SynaraDivider(startIndent = 56.dp)
                        ThreadRow(
                            thread = thread,
                            projectTitle = projectsById[thread.projectId]?.title,
                            onClick = { viewModel.selectThread(thread.id) },
                            onLongClick = { viewModel.openThreadActions(thread.id) },
                        )
                    }
                }

                // A section heading over nothing is just noise, so it is skipped entirely while
                // the empty state has the screen to itself.
                if (!showEmptyState) {
                    item(key = "threads-label") {
                        SectionLabel(
                            text = if (attention.isEmpty()) "Threads" else "Everything else",
                            modifier = Modifier.padding(
                                start = SynaraTheme.spacing.screenGutter,
                                end = SynaraTheme.spacing.screenGutter,
                                top = SynaraTheme.spacing.xl,
                                bottom = SynaraTheme.spacing.xs,
                            ),
                        )
                    }
                }

                when {
                    showSkeletons -> items(4) { ThreadRowSkeleton() }

                    showEmptyState -> item(key = "empty") {
                        Box(
                            // Fills the remaining viewport so the empty state sits optically
                            // centred instead of clinging to the top of an otherwise blank screen.
                            Modifier.fillParentMaxHeight().padding(bottom = 64.dp),
                            contentAlignment = Alignment.Center,
                        ) {
                            WorkspaceEmptyState(state, viewModel)
                        }
                    }

                    else -> itemsIndexed(rest, key = { _, thread -> thread.id }) { index, thread ->
                        if (index > 0) SynaraDivider(startIndent = 56.dp)
                        ThreadRow(
                            thread = thread,
                            projectTitle = projectsById[thread.projectId]?.title,
                            onClick = { viewModel.selectThread(thread.id) },
                            onLongClick = { viewModel.openThreadActions(thread.id) },
                        )
                    }
                }
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

    if (state.createProjectOpen) CreateProjectDialog(state, viewModel)
    if (state.createThreadOpen) CreateThreadDialog(state, viewModel)
    ThreadActionsSheet(state, viewModel)
    ProjectActionsSheet(state, viewModel)
    SpaceActionsSheet(state, viewModel)
    if (creatingSpace) {
        CreateSpaceDialog(
            onDismiss = { creatingSpace = false },
            onCreate = viewModel::createSpace,
        )
    }
}

/**
 * Space row. "All" is not a space — it is the absence of the filter, which also reveals projects
 * that sit outside every space (the desktop calls that Void). Modelling it as a chip beside the
 * real spaces keeps that reachable without inventing a fake space to hold it.
 */
@Composable
private fun SpaceFilters(
    spaces: List<com.synara.android.data.SpaceItem>,
    selected: String?,
    onSelect: (String?) -> Unit,
    onLongPress: (String) -> Unit,
) {
    LazyRow(
        modifier = Modifier.padding(top = SynaraTheme.spacing.sm),
        contentPadding = PaddingValues(horizontal = SynaraTheme.spacing.screenGutter),
        horizontalArrangement = Arrangement.spacedBy(SynaraTheme.spacing.sm),
    ) {
        item {
            ProjectChip("All spaces", selected == null, onClick = { onSelect(null) })
        }
        items(spaces, key = { it.id }) { space ->
            ProjectChip(
                label = space.name,
                selected = selected == space.id,
                onClick = { onSelect(space.id) },
                onLongClick = { onLongPress(space.id) },
            )
        }
    }
}

/**
 * Workspace-level menu. Settings already has a permanent home in the bottom bar, so the top bar
 * spends its slot on the archived view instead — otherwise archived threads are reachable from
 * the desktop but invisible on the phone.
 */
@Composable
private fun WorkspaceOverflowMenu(
    state: SynaraUiState,
    viewModel: SynaraViewModel,
    onCreateSpace: () -> Unit,
) {
    var expanded by remember { mutableStateOf(false) }
    val archivedCount = remember(state.threads) { state.threads.count { it.isArchived } }
    Box {
        IconButton(onClick = { expanded = true }) {
            Icon(
                Icons.Default.MoreVert,
                contentDescription = "More workspace actions",
                tint = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        DropdownMenu(
            expanded = expanded,
            onDismissRequest = { expanded = false },
            modifier = Modifier.background(MaterialTheme.colorScheme.surfaceContainerHigh),
        ) {
            DropdownMenuItem(
                text = {
                    Text(
                        if (state.showArchived) "Show active threads" else "Show archived",
                        style = MaterialTheme.typography.bodyMedium,
                    )
                },
                leadingIcon = {
                    Icon(
                        if (state.showArchived) Icons.Outlined.Inbox else Icons.Outlined.Archive,
                        contentDescription = null,
                        modifier = Modifier.size(18.dp),
                    )
                },
                trailingIcon = if (!state.showArchived && archivedCount > 0) {
                    { SynaraBadge(archivedCount.toString()) }
                } else {
                    null
                },
                onClick = {
                    viewModel.setShowArchived(!state.showArchived)
                    expanded = false
                },
            )
            DropdownMenuItem(
                text = { Text("New space", style = MaterialTheme.typography.bodyMedium) },
                leadingIcon = {
                    Icon(
                        Icons.Outlined.CreateNewFolder,
                        contentDescription = null,
                        modifier = Modifier.size(18.dp),
                    )
                },
                onClick = {
                    expanded = false
                    onCreateSpace()
                },
            )
            DropdownMenuItem(
                text = { Text("Board", style = MaterialTheme.typography.bodyMedium) },
                leadingIcon = {
                    Icon(
                        Icons.Outlined.ViewKanban,
                        contentDescription = null,
                        modifier = Modifier.size(18.dp),
                    )
                },
                onClick = {
                    expanded = false
                    viewModel.openKanban()
                },
            )
            DropdownMenuItem(
                text = { Text("Automations", style = MaterialTheme.typography.bodyMedium) },
                leadingIcon = {
                    Icon(
                        Icons.Outlined.EventRepeat,
                        contentDescription = null,
                        modifier = Modifier.size(18.dp),
                    )
                },
                onClick = {
                    expanded = false
                    viewModel.openAutomations()
                },
            )
            DropdownMenuItem(
                text = { Text("Settings", style = MaterialTheme.typography.bodyMedium) },
                leadingIcon = {
                    Icon(
                        Icons.Outlined.Settings,
                        contentDescription = null,
                        modifier = Modifier.size(18.dp),
                    )
                },
                onClick = {
                    expanded = false
                    viewModel.openSettings()
                },
            )
        }
    }
}

/** A thread's live state is the reason to open it, so it leads the row's trailing column. */
private val ThreadItem.needsAttention: Boolean
    get() = hasPendingApprovals || hasPendingUserInput

@Composable
private fun ThreadRow(
    thread: ThreadItem,
    projectTitle: String?,
    onClick: () -> Unit,
    onLongClick: () -> Unit,
) {
    val accents = SynaraTheme.accents
    SynaraListRow(
        onClick = onClick,
        onLongClick = onLongClick,
        verticalPadding = SynaraTheme.spacing.md,
    ) {
        Row(
            Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(SynaraTheme.spacing.md),
        ) {
            ProviderMark(thread.provider, thread.providerLabel)
            Column(
                Modifier.weight(1f),
                verticalArrangement = Arrangement.spacedBy(SynaraTheme.spacing.xs),
            ) {
                Row(
                    Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(SynaraTheme.spacing.sm),
                    verticalAlignment = Alignment.Top,
                ) {
                    Text(
                        thread.title,
                        modifier = Modifier.weight(1f),
                        style = MaterialTheme.typography.titleSmall,
                        color = MaterialTheme.colorScheme.onSurface,
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis,
                    )
                    val timestamp = formatRelativeTimestamp(thread.updatedAt)
                    if (timestamp.isNotEmpty()) {
                        Text(
                            timestamp,
                            style = MaterialTheme.typography.labelMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            maxLines = 1,
                        )
                    }
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
                            overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.weight(1f, fill = false),
                        )
                        Text(
                            "·",
                            style = MaterialTheme.typography.labelMedium,
                            color = MaterialTheme.colorScheme.outline,
                        )
                    }
                    Text(
                        thread.model,
                        style = SynaraTheme.textStyles.monoSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f, fill = false),
                    )
                }

                when {
                    thread.needsAttention -> SynaraBadge(
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
    }
}

@Composable
private fun ProjectFilters(
    projects: List<ProjectItem>,
    selected: String?,
    onSelect: (String?) -> Unit,
    onLongPress: (String) -> Unit,
) {
    LazyRow(
        modifier = Modifier.padding(top = SynaraTheme.spacing.sm),
        contentPadding = PaddingValues(horizontal = SynaraTheme.spacing.screenGutter),
        horizontalArrangement = Arrangement.spacedBy(SynaraTheme.spacing.sm),
    ) {
        item {
            ProjectChip("All threads", selected == null, onClick = { onSelect(null) })
        }
        items(projects, key = { it.id }) { project ->
            ProjectChip(
                label = project.title,
                selected = selected == project.id,
                pinned = project.isPinned,
                onClick = { onSelect(project.id) },
                onLongClick = { onLongPress(project.id) },
            )
        }
    }
}

/**
 * Hand-rolled rather than Material's `FilterChip` so the chip can carry a long-press for the
 * project menu; `FilterChip` owns its own click handling and offers no long-press slot.
 */
@Composable
private fun ProjectChip(
    label: String,
    selected: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    pinned: Boolean = false,
    onLongClick: (() -> Unit)? = null,
) {
    val shape = MaterialTheme.shapes.small
    val interaction = if (onLongClick != null) {
        Modifier.combinedClickable(onClick = onClick, onLongClick = onLongClick)
    } else {
        Modifier.clickable(onClick = onClick)
    }
    Row(
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
            .then(interaction)
            .padding(horizontal = SynaraTheme.spacing.md, vertical = SynaraTheme.spacing.sm),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(SynaraTheme.spacing.xs),
    ) {
        if (pinned) {
            Icon(
                Icons.Outlined.PushPin,
                contentDescription = null,
                modifier = Modifier.size(12.dp),
                tint = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        Text(
            label,
            style = MaterialTheme.typography.labelMedium,
            color = if (selected) {
                MaterialTheme.colorScheme.onSurface
            } else {
                MaterialTheme.colorScheme.onSurfaceVariant
            },
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

/**
 * Shown in place of the header status line the screen used to carry permanently. Telling someone
 * their server is online costs a third of the viewport and says nothing; a notice only appears
 * when the connection actually needs attention, and it carries the reconnect action itself.
 */
@Composable
private fun OfflineNotice(state: SynaraUiState, onReconnect: () -> Unit) {
    val connecting = state.connection == ConnectionState.CONNECTING ||
        state.connection == ConnectionState.RECONNECTING
    SynaraCard(
        modifier = Modifier.padding(
            horizontal = SynaraTheme.spacing.screenGutter,
            vertical = SynaraTheme.spacing.sm,
        ),
        padding = SynaraTheme.spacing.md,
        contentSpacing = SynaraTheme.spacing.sm,
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(SynaraTheme.spacing.sm),
        ) {
            Icon(
                Icons.Outlined.CloudOff,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.size(18.dp),
            )
            Text(
                if (connecting) "Reaching your Synara server…" else "The server connection is offline.",
                modifier = Modifier.weight(1f),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurface,
            )
            if (!connecting && state.hasStoredSession) {
                TextButton(onClick = onReconnect) {
                    Text("Reconnect", style = MaterialTheme.typography.labelLarge)
                }
            }
        }
    }
}

@Composable
private fun WorkspaceEmptyState(state: SynaraUiState, viewModel: SynaraViewModel) {
    val noProjects = state.projects.isEmpty()
    Column(Modifier.fillMaxWidth()) {
        EmptyState(
            icon = if (noProjects) Icons.Outlined.CreateNewFolder else Icons.Outlined.Forum,
            title = if (noProjects) "Start with a project" else "No threads here yet",
            body = if (noProjects) {
                "Add the path to a repository on the machine running Synara."
            } else {
                "Create a thread when you have a task ready for an agent."
            },
            action = {
                FilledTonalButton(
                    onClick = {
                        if (noProjects) viewModel.openCreateProject() else viewModel.openCreateThread()
                    },
                    shape = MaterialTheme.shapes.medium,
                ) {
                    Icon(Icons.Outlined.Add, contentDescription = null, modifier = Modifier.size(18.dp))
                    Spacer(Modifier.size(SynaraTheme.spacing.sm))
                    Text(
                        if (noProjects) "Add project" else "New thread",
                        style = MaterialTheme.typography.labelLarge,
                    )
                }
            },
        )
    }
}
