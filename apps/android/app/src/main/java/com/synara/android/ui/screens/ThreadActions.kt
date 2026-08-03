package com.synara.android.ui.screens

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.DriveFileMove
import androidx.compose.material.icons.outlined.Archive
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material.icons.outlined.DriveFileRenameOutline
import androidx.compose.material.icons.outlined.Memory
import androidx.compose.material.icons.outlined.PushPin
import androidx.compose.material.icons.outlined.Security
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
import androidx.compose.ui.unit.dp
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

    if (subSheet == null && !renaming && !confirmingDelete) {
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
