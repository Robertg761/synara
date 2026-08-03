package com.synara.android.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.material.icons.automirrored.outlined.CallMade
import androidx.compose.material.icons.automirrored.outlined.CallSplit
import androidx.compose.material.icons.outlined.History
import androidx.compose.material.icons.outlined.PowerSettingsNew
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.DriveFileMove
import androidx.compose.material.icons.outlined.AccountTree
import androidx.compose.material.icons.outlined.Archive
import androidx.compose.material.icons.outlined.Difference
import androidx.compose.material.icons.outlined.Compress
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material.icons.outlined.Extension
import androidx.compose.material.icons.outlined.FolderOpen
import androidx.compose.material.icons.outlined.DriveFileRenameOutline
import androidx.compose.material.icons.outlined.Memory
import androidx.compose.material.icons.outlined.PushPin
import androidx.compose.material.icons.outlined.Security
import androidx.compose.material.icons.outlined.Terminal
import androidx.compose.material.icons.outlined.Unarchive
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.synara.android.ui.format.formatRelativeTimestamp
import com.synara.android.ui.theme.SynaraTheme
import com.synara.android.data.InteractionMode
import com.synara.android.data.ModelOption
import com.synara.android.data.Provider
import com.synara.android.data.RuntimeMode
import com.synara.android.data.SynaraUiState
import com.synara.android.data.SynaraViewModel
import com.synara.android.data.ThreadItem
import com.synara.android.ui.components.ActionSheetChoice
import com.synara.android.ui.components.ActionSheetItem
import com.synara.android.ui.components.ActionSheetSection
import com.synara.android.ui.components.SynaraActionSheet
import com.synara.android.ui.components.SynaraField

/** Fork keeps the same agent; handoff moves the work to a different one. */
enum class BranchMode(val title: String, val confirm: String) {
    FORK("Fork thread", "Fork"),
    HANDOFF("Hand off thread", "Hand off"),
}

/** Which nested picker, if any, is layered over the main action sheet. */
private enum class ThreadSubSheet { MODEL, RUNTIME, INTERACTION }

/**
 * The thread menu — the mobile equivalent of the desktop sidebar's right-click menu plus the chat
 * header's model and mode controls, which had no representation on the phone at all.
 */
@Composable
fun ThreadActionsSheet(state: SynaraUiState, viewModel: SynaraViewModel) {
    val threadId = state.threadActionsFor ?: return
    val thread = remember(threadId, state.threads, state.detail) {
        state.threads.firstOrNull { it.id == threadId } ?: state.detail?.thread?.takeIf { it.id == threadId }
    } ?: return

    var subSheet by remember(threadId) { mutableStateOf<ThreadSubSheet?>(null) }
    var renaming by remember(threadId) { mutableStateOf(false) }
    var confirmingDelete by remember(threadId) { mutableStateOf(false) }
    var confirmingRevert by remember(threadId) { mutableStateOf(false) }
    var branching by remember(threadId) { mutableStateOf<BranchMode?>(null) }
    // Reverting addresses a turn by count, and the checkpoint list is the only place that count
    // is exposed, so the action is unavailable until the thread detail has loaded.
    val latestTurnCount = state.detail?.takeIf { it.thread.id == threadId }?.latestTurnCount

    if (subSheet == null && !renaming && !confirmingDelete && !confirmingRevert && branching == null) {
        SynaraActionSheet(
            title = thread.title,
            subtitle = "${thread.providerLabel} · ${thread.model}",
            onDismiss = viewModel::closeThreadActions,
        ) {
            ActionSheetItem(
                icon = Icons.Outlined.DriveFileRenameOutline,
                label = "Rename",
                onClick = { renaming = true },
            )
            ActionSheetItem(
                icon = Icons.Outlined.PushPin,
                label = if (thread.isPinned) "Unpin" else "Pin to top",
                onClick = {
                    viewModel.setThreadPinned(thread.id, !thread.isPinned)
                    viewModel.closeThreadActions()
                },
            )

            ActionSheetSection("Review")
            ActionSheetItem(
                icon = Icons.Outlined.Difference,
                label = "Changes",
                supporting = "Diff of what the agent touched",
                onClick = {
                    viewModel.closeThreadActions()
                    viewModel.openDiff()
                },
            )
            ActionSheetItem(
                icon = Icons.Outlined.AccountTree,
                label = "Source control",
                supporting = thread.branch ?: thread.gitCwd?.substringAfterLast('/'),
                enabled = thread.gitCwd != null,
                onClick = {
                    viewModel.closeThreadActions()
                    viewModel.openSourceControl()
                },
            )

            ActionSheetItem(
                icon = Icons.Outlined.Terminal,
                label = "Terminal",
                supporting = "Shell in this thread's checkout",
                enabled = thread.gitCwd != null,
                onClick = {
                    viewModel.closeThreadActions()
                    viewModel.openTerminal()
                },
            )

            ActionSheetItem(
                icon = Icons.Outlined.FolderOpen,
                label = "Produced files",
                supporting = "Files this thread wrote to the Studio workspace",
                onClick = {
                    viewModel.closeThreadActions()
                    viewModel.openStudioOutputs()
                },
            )
            ActionSheetItem(
                icon = Icons.Outlined.Extension,
                label = "Skills & commands",
                supporting = "What ${thread.providerLabel} can do here",
                enabled = thread.gitCwd != null,
                onClick = {
                    viewModel.closeThreadActions()
                    viewModel.openCatalogue()
                },
            )

            ActionSheetSection("Configuration")
            ActionSheetItem(
                icon = Icons.Outlined.Memory,
                label = "Model",
                supporting = "${thread.providerLabel} · ${thread.model}",
                onClick = { subSheet = ThreadSubSheet.MODEL },
            )
            ActionSheetItem(
                icon = Icons.Outlined.Security,
                label = "Permission mode",
                supporting = RuntimeMode.labelFor(thread.runtimeMode),
                onClick = { subSheet = ThreadSubSheet.RUNTIME },
            )
            ActionSheetItem(
                icon = Icons.AutoMirrored.Outlined.DriveFileMove,
                label = "Interaction mode",
                supporting = InteractionMode.labelFor(thread.interactionMode),
                onClick = { subSheet = ThreadSubSheet.INTERACTION },
            )

            ActionSheetSection("History")
            ActionSheetItem(
                icon = Icons.AutoMirrored.Outlined.CallSplit,
                label = "Fork this thread",
                supporting = "Continue from here in a copy, same agent",
                onClick = { branching = BranchMode.FORK },
            )
            ActionSheetItem(
                icon = Icons.AutoMirrored.Outlined.CallMade,
                label = "Hand off to another agent",
                supporting = "Same history, different provider",
                onClick = { branching = BranchMode.HANDOFF },
            )
            ActionSheetItem(
                icon = Icons.Outlined.History,
                label = "Undo file changes",
                supporting = "Restore the checkout to an earlier turn",
                enabled = latestTurnCount != null,
                onClick = { confirmingRevert = true },
            )
            ActionSheetItem(
                icon = Icons.Outlined.Compress,
                label = "Compact context",
                supporting = "Summarise the history so the agent has room to keep going",
                onClick = {
                    viewModel.compactThread(thread.id)
                    viewModel.closeThreadActions()
                },
            )
            ActionSheetItem(
                icon = Icons.Outlined.PowerSettingsNew,
                label = "Stop the agent session",
                supporting = "The next message starts a fresh one",
                onClick = {
                    viewModel.stopSession(thread.id)
                    viewModel.closeThreadActions()
                },
            )

            ActionSheetSection("Lifecycle")
            ActionSheetItem(
                icon = if (thread.isArchived) Icons.Outlined.Unarchive else Icons.Outlined.Archive,
                label = if (thread.isArchived) "Unarchive" else "Archive",
                onClick = {
                    if (thread.isArchived) {
                        viewModel.unarchiveThread(thread.id)
                    } else {
                        viewModel.archiveThread(thread.id)
                    }
                    viewModel.closeThreadActions()
                },
            )
            ActionSheetItem(
                icon = Icons.Outlined.Delete,
                label = "Delete thread",
                destructive = true,
                onClick = { confirmingDelete = true },
            )
        }
    }

    when (subSheet) {
        ThreadSubSheet.MODEL -> ModelPickerSheet(
            models = state.models,
            selectedSlug = thread.model,
            selectedProvider = thread.provider,
            onDismiss = { subSheet = null },
            onSelect = { model ->
                viewModel.setThreadModel(thread.id, model)
                subSheet = null
                viewModel.closeThreadActions()
            },
        )

        ThreadSubSheet.RUNTIME -> RuntimeModeSheet(
            selected = thread.runtimeMode,
            onDismiss = { subSheet = null },
            onSelect = { mode ->
                viewModel.setRuntimeMode(thread.id, mode)
                subSheet = null
                viewModel.closeThreadActions()
            },
        )

        ThreadSubSheet.INTERACTION -> InteractionModeSheet(
            selected = thread.interactionMode,
            onDismiss = { subSheet = null },
            onSelect = { mode ->
                viewModel.setInteractionMode(thread.id, mode)
                subSheet = null
                viewModel.closeThreadActions()
            },
        )

        null -> Unit
    }

    if (renaming) {
        RenameDialog(
            title = "Rename thread",
            initial = thread.title,
            label = "Thread title",
            onDismiss = { renaming = false },
            onConfirm = { value ->
                viewModel.renameThread(thread.id, value)
                renaming = false
                viewModel.closeThreadActions()
            },
        )
    }

    if (confirmingRevert && latestTurnCount != null) {
        DestructiveConfirmDialog(
            title = "Undo file changes?",
            body = "Files in the checkout are restored to how they were before turn " +
                "$latestTurnCount. The conversation is kept, and uncommitted work not made by " +
                "this thread may be lost.",
            confirmLabel = "Undo changes",
            onDismiss = { confirmingRevert = false },
            onConfirm = {
                viewModel.revertToCheckpoint(thread.id, latestTurnCount, filesOnly = true)
                confirmingRevert = false
                viewModel.closeThreadActions()
            },
        )
    }

    branching?.let { mode ->
        BranchThreadDialog(
            mode = mode,
            thread = thread,
            models = state.models,
            onDismiss = { branching = null },
            onConfirm = { title, model ->
                viewModel.branchThread(mode == BranchMode.HANDOFF, title, model)
                branching = null
                viewModel.closeThreadActions()
            },
        )
    }

    if (confirmingDelete) {
        DestructiveConfirmDialog(
            title = "Delete this thread?",
            body = "The transcript and everything the agent recorded in it are removed for good. " +
                "Archive it instead if you only want it out of the list.",
            confirmLabel = "Delete",
            onDismiss = { confirmingDelete = false },
            onConfirm = {
                viewModel.deleteThread(thread.id)
                confirmingDelete = false
                viewModel.closeThreadActions()
            },
        )
    }
}

/** Project menu: rename, pin, and delete, mirroring the desktop sidebar's project menu. */
@Composable
fun ProjectActionsSheet(state: SynaraUiState, viewModel: SynaraViewModel) {
    val projectId = state.projectActionsFor ?: return
    val project = remember(projectId, state.projects) {
        state.projects.firstOrNull { it.id == projectId }
    } ?: return

    var renaming by remember(projectId) { mutableStateOf(false) }
    var confirmingDelete by remember(projectId) { mutableStateOf(false) }
    val threadCount = remember(projectId, state.threads) {
        state.threads.count { it.projectId == projectId }
    }

    if (!renaming && !confirmingDelete) {
        SynaraActionSheet(
            title = project.title,
            subtitle = project.workspaceRoot,
            onDismiss = viewModel::closeProjectActions,
        ) {
            ActionSheetItem(
                icon = Icons.Outlined.DriveFileRenameOutline,
                label = "Rename",
                onClick = { renaming = true },
            )
            ActionSheetItem(
                icon = Icons.Outlined.PushPin,
                label = if (project.isPinned) "Unpin" else "Pin to top",
                onClick = {
                    viewModel.setProjectPinned(project.id, !project.isPinned)
                    viewModel.closeProjectActions()
                },
            )
            if (state.spaces.isNotEmpty()) {
                ActionSheetSection("Space")
                ActionSheetChoice(
                    label = "No space",
                    description = "Sits outside every space",
                    selected = project.spaceId == null,
                    onClick = {
                        viewModel.moveProjectToSpace(project.id, null)
                        viewModel.closeProjectActions()
                    },
                )
                state.spaces.forEach { space ->
                    ActionSheetChoice(
                        label = space.name,
                        description = null,
                        selected = project.spaceId == space.id,
                        onClick = {
                            viewModel.moveProjectToSpace(project.id, space.id)
                            viewModel.closeProjectActions()
                        },
                    )
                }
            }

            ActionSheetSection("Danger")
            ActionSheetItem(
                icon = Icons.Outlined.Delete,
                label = "Delete project",
                destructive = true,
                onClick = { confirmingDelete = true },
            )
        }
    }

    if (renaming) {
        RenameDialog(
            title = "Rename project",
            initial = project.title,
            label = "Project name",
            onDismiss = { renaming = false },
            onConfirm = { value ->
                viewModel.renameProject(project.id, value)
                renaming = false
                viewModel.closeProjectActions()
            },
        )
    }

    if (confirmingDelete) {
        DestructiveConfirmDialog(
            title = "Delete this project?",
            body = if (threadCount > 0) {
                "$threadCount thread${if (threadCount == 1) "" else "s"} belong to it. Deleting the " +
                    "project removes them from Synara. Files on disk are not touched."
            } else {
                "The project is removed from Synara. Files on disk are not touched."
            },
            confirmLabel = "Delete",
            onDismiss = { confirmingDelete = false },
            onConfirm = {
                viewModel.deleteProject(project.id)
                confirmingDelete = false
                viewModel.closeProjectActions()
            },
        )
    }
}

/**
 * Model picker grouped by provider. Grouping matters here: with nine providers the flat list the
 * create dialog used would run to dozens of entries with no indication of which runtime each
 * belongs to.
 */
@Composable
fun ModelPickerSheet(
    models: List<ModelOption>,
    selectedSlug: String?,
    selectedProvider: String?,
    onDismiss: () -> Unit,
    onSelect: (ModelOption) -> Unit,
) {
    val grouped = remember(models) {
        models.groupBy { it.provider }
            .toList()
            .sortedBy { (provider, _) -> Provider.entries.indexOfFirst { it.kind == provider } }
    }
    SynaraActionSheet(
        title = "Model",
        subtitle = if (models.isEmpty()) null else "${models.size} available",
        onDismiss = onDismiss,
    ) {
        if (models.isEmpty()) {
            ActionSheetSection("No models discovered. Check the providers configured on your desktop.")
            return@SynaraActionSheet
        }
        Column(
            Modifier
                .heightIn(max = 480.dp)
                .verticalScroll(rememberScrollState()),
        ) {
            grouped.forEach { (provider, providerModels) ->
                ActionSheetSection(Provider.labelFor(provider))
                providerModels.forEach { model ->
                    ActionSheetChoice(
                        label = model.label,
                        description = model.description,
                        selected = model.slug == selectedSlug && model.provider == selectedProvider,
                        onClick = { onSelect(model) },
                    )
                }
            }
        }
    }
}

@Composable
private fun RuntimeModeSheet(
    selected: String,
    onDismiss: () -> Unit,
    onSelect: (RuntimeMode) -> Unit,
) {
    SynaraActionSheet(
        title = "Permission mode",
        subtitle = "How much the agent may do before asking",
        onDismiss = onDismiss,
    ) {
        RuntimeMode.entries.forEach { mode ->
            ActionSheetChoice(
                label = mode.label,
                description = mode.description,
                selected = mode.wire == selected,
                onClick = { onSelect(mode) },
            )
        }
    }
}

@Composable
private fun InteractionModeSheet(
    selected: String,
    onDismiss: () -> Unit,
    onSelect: (InteractionMode) -> Unit,
) {
    SynaraActionSheet(
        title = "Interaction mode",
        subtitle = "Whether the agent builds or only plans",
        onDismiss = onDismiss,
    ) {
        InteractionMode.entries.forEach { mode ->
            ActionSheetChoice(
                label = mode.label,
                description = mode.description,
                selected = mode.wire == selected,
                onClick = { onSelect(mode) },
            )
        }
    }
}

@Composable
fun RenameDialog(
    title: String,
    initial: String,
    label: String,
    onDismiss: () -> Unit,
    onConfirm: (String) -> Unit,
) {
    var value by remember { mutableStateOf(initial) }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(title, style = MaterialTheme.typography.titleMedium) },
        text = {
            SynaraField(
                label = label,
                value = value,
                onValueChange = { value = it },
            )
        },
        confirmButton = {
            TextButton(
                onClick = { onConfirm(value) },
                enabled = value.isNotBlank() && value.trim() != initial,
            ) {
                Text("Save", style = MaterialTheme.typography.labelLarge)
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) {
                Text("Cancel", style = MaterialTheme.typography.labelLarge)
            }
        },
        containerColor = MaterialTheme.colorScheme.surfaceContainerHigh,
        shape = MaterialTheme.shapes.extraLarge,
    )
}

@Composable
fun DestructiveConfirmDialog(
    title: String,
    body: String,
    confirmLabel: String,
    onDismiss: () -> Unit,
    onConfirm: () -> Unit,
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(title, style = MaterialTheme.typography.titleMedium) },
        text = {
            Text(
                body,
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        },
        confirmButton = {
            TextButton(onClick = onConfirm) {
                Text(
                    confirmLabel,
                    style = MaterialTheme.typography.labelLarge,
                    color = MaterialTheme.colorScheme.error,
                )
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) {
                Text("Cancel", style = MaterialTheme.typography.labelLarge)
            }
        },
        containerColor = MaterialTheme.colorScheme.surfaceContainerHigh,
        shape = MaterialTheme.shapes.extraLarge,
    )
}

/** Space menu: rename or delete. Projects inside a deleted space fall back to no space. */
@Composable
fun SpaceActionsSheet(state: SynaraUiState, viewModel: SynaraViewModel) {
    val spaceId = state.spaceActionsFor ?: return
    val space = remember(spaceId, state.spaces) { state.spaces.firstOrNull { it.id == spaceId } } ?: return
    val projectCount = remember(spaceId, state.projects) {
        state.projects.count { it.spaceId == spaceId }
    }

    var renaming by remember(spaceId) { mutableStateOf(false) }
    var confirmingDelete by remember(spaceId) { mutableStateOf(false) }

    if (!renaming && !confirmingDelete) {
        SynaraActionSheet(
            title = space.name,
            subtitle = "$projectCount project${if (projectCount == 1) "" else "s"}",
            onDismiss = viewModel::closeSpaceActions,
        ) {
            ActionSheetItem(
                icon = Icons.Outlined.DriveFileRenameOutline,
                label = "Rename",
                onClick = { renaming = true },
            )
            ActionSheetItem(
                icon = Icons.Outlined.Delete,
                label = "Delete space",
                destructive = true,
                onClick = { confirmingDelete = true },
            )
        }
    }

    if (renaming) {
        RenameDialog(
            title = "Rename space",
            initial = space.name,
            label = "Space name",
            onDismiss = { renaming = false },
            onConfirm = { value ->
                viewModel.renameSpace(space.id, value)
                renaming = false
                viewModel.closeSpaceActions()
            },
        )
    }

    if (confirmingDelete) {
        DestructiveConfirmDialog(
            title = "Delete this space?",
            body = if (projectCount > 0) {
                "$projectCount project${if (projectCount == 1) "" else "s"} will move out of it. " +
                    "The projects and their threads are not deleted."
            } else {
                "The space is removed. Nothing else changes."
            },
            confirmLabel = "Delete",
            onDismiss = { confirmingDelete = false },
            onConfirm = {
                confirmingDelete = false
                viewModel.deleteSpace(space.id)
                viewModel.closeSpaceActions()
            },
        )
    }
}

/** Prompts for a new space name. */
@Composable
fun CreateSpaceDialog(onDismiss: () -> Unit, onCreate: (String) -> Unit) {
    RenameDialog(
        title = "New space",
        initial = "",
        label = "Space name",
        onDismiss = onDismiss,
        onConfirm = { onCreate(it); onDismiss() },
    )
}

/**
 * Studio outputs for the open thread. A sheet rather than a screen: it is a short list of file
 * names with nothing to drill into from a phone, which cannot open the files anyway.
 */
@Composable
fun StudioOutputsSheet(state: SynaraUiState, viewModel: SynaraViewModel) {
    if (!state.studioOpen) return
    val outputs = state.studioOutputs

    SynaraActionSheet(
        title = "Produced files",
        subtitle = outputs?.let { "${it.size} file${if (it.size == 1) "" else "s"}" },
        onDismiss = viewModel::closeStudioOutputs,
    ) {
        when {
            outputs == null -> ActionSheetSection("Loading…")
            outputs.isEmpty() -> ActionSheetSection("This thread has not written any Studio files.")
            else -> Column(Modifier.heightIn(max = 420.dp).verticalScroll(rememberScrollState())) {
                outputs.forEach { output ->
                    Column(
                        Modifier
                            .fillMaxWidth()
                            .padding(
                                horizontal = SynaraTheme.spacing.xl,
                                vertical = SynaraTheme.spacing.sm,
                            ),
                    ) {
                        Text(
                            output.name,
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurface,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                        Text(
                            output.relativePath,
                            style = SynaraTheme.textStyles.monoSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                        Text(
                            formatRelativeTimestamp(output.modifiedAt),
                            style = MaterialTheme.typography.labelMedium,
                            color = MaterialTheme.colorScheme.outline,
                        )
                    }
                }
            }
        }
    }
}

/**
 * Names the new thread and picks its model. Handoff defaults to a *different* provider where one
 * is available, since moving to the same agent is what a fork is for.
 */
@Composable
private fun BranchThreadDialog(
    mode: BranchMode,
    thread: ThreadItem,
    models: List<ModelOption>,
    onDismiss: () -> Unit,
    onConfirm: (String, ModelOption) -> Unit,
) {
    var title by remember { mutableStateOf(thread.title) }
    var model by remember {
        mutableStateOf(
            if (mode == BranchMode.HANDOFF) {
                models.firstOrNull { it.provider != thread.provider } ?: models.firstOrNull()
            } else {
                models.firstOrNull { it.slug == thread.model && it.provider == thread.provider }
                    ?: models.firstOrNull()
            },
        )
    }
    var pickingModel by remember { mutableStateOf(false) }

    if (pickingModel) {
        ModelPickerSheet(
            models = models,
            selectedSlug = model?.slug,
            selectedProvider = model?.provider,
            onDismiss = { pickingModel = false },
            onSelect = { model = it; pickingModel = false },
        )
        return
    }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(mode.title, style = MaterialTheme.typography.titleMedium) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text(
                    if (mode == BranchMode.HANDOFF) {
                        "A new thread with this one's history, run by a different agent."
                    } else {
                        "A new thread with this one's history, so you can try another approach " +
                            "without losing this one."
                    },
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                SynaraField(label = "Title", value = title, onValueChange = { title = it })
                ActionSheetChoice(
                    label = model?.label ?: "Choose a model",
                    description = model?.providerLabel,
                    selected = false,
                    onClick = { pickingModel = true },
                )
            }
        },
        confirmButton = {
            TextButton(
                onClick = { model?.let { onConfirm(title, it) } },
                enabled = title.isNotBlank() && model != null,
            ) {
                Text(mode.confirm, style = MaterialTheme.typography.labelLarge)
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) {
                Text("Cancel", style = MaterialTheme.typography.labelLarge)
            }
        },
        containerColor = MaterialTheme.colorScheme.surfaceContainerHigh,
        shape = MaterialTheme.shapes.extraLarge,
    )
}
