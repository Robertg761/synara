package com.synara.android.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Check
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.UnfoldMore
import androidx.compose.material3.Button
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
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
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.synara.android.data.ModelOption
import com.synara.android.data.ProjectItem
import com.synara.android.data.ProjectKind
import com.synara.android.data.InteractionMode
import com.synara.android.data.Provider
import com.synara.android.data.RuntimeMode
import com.synara.android.data.SynaraUiState
import com.synara.android.data.SynaraViewModel
import com.synara.android.data.defaultThreadTarget
import com.synara.android.data.orderedForPicking
import com.synara.android.ui.components.PickerField
import com.synara.android.ui.components.PickerSection
import com.synara.android.ui.components.SynaraField
import com.synara.android.ui.theme.SynaraTheme

@Composable
fun CreateProjectDialog(state: SynaraUiState, viewModel: SynaraViewModel) {
    var title by rememberSaveable { mutableStateOf("") }
    var root by rememberSaveable { mutableStateOf("") }
    var selectedModel by remember(state.models) { mutableStateOf(state.models.firstOrNull()) }

    FormDialog(
        title = "Add a project",
        onDismiss = viewModel::closeCreateProject,
        confirmLabel = "Add project",
        confirmEnabled = title.isNotBlank() && root.isNotBlank() && selectedModel != null,
        onConfirm = { selectedModel?.let { viewModel.createProject(title, root, it) } },
    ) {
        Text(
            "The path is resolved on the machine running Synara, not on this phone.",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        SynaraField(
            label = "Project name",
            value = title,
            onValueChange = { title = it },
            placeholder = "My app",
        )
        SynaraField(
            label = "Workspace path",
            value = root,
            onValueChange = { root = it },
            placeholder = "/home/me/projects/my-app",
            monospace = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
        )
        ModelPicker(state.models, selectedModel) { selectedModel = it }
    }
}

@Composable
fun CreateThreadDialog(state: SynaraUiState, viewModel: SynaraViewModel) {
    var title by rememberSaveable { mutableStateOf("") }
    var selectedModel by remember(state.models) { mutableStateOf(state.models.firstOrNull()) }
    var runtimeMode by rememberSaveable { mutableStateOf(RuntimeMode.APPROVAL_REQUIRED) }
    var interactionMode by rememberSaveable { mutableStateOf(InteractionMode.DEFAULT) }
    // Keyed on the workspace so a snapshot arriving mid-dialog cannot strand the selection on a
    // project that no longer exists, while still leaving a deliberate choice alone.
    var selectedProjectId by rememberSaveable(state.projects) {
        mutableStateOf(state.projects.defaultThreadTarget(state.selectedProjectId)?.id)
    }
    val selectedProject = state.projects.firstOrNull { it.id == selectedProjectId }

    FormDialog(
        title = "New thread",
        onDismiss = viewModel::closeCreateThread,
        confirmLabel = "Create thread",
        confirmEnabled = selectedModel != null && selectedProject != null,
        onConfirm = {
            val project = selectedProject ?: return@FormDialog
            selectedModel?.let {
                viewModel.createThread(project, title, it, runtimeMode, interactionMode)
            }
        },
    ) {
        SynaraField(
            label = "Thread title",
            value = title,
            onValueChange = { title = it },
            placeholder = "Fix the onboarding flow",
            // Naming a thread before writing a word of it is work the desktop never asks for, and
            // on a phone it meant summoning the keyboard just to unlock the button. Left blank the
            // server names the thread from the first message, exactly as it does everywhere else.
            supportingText = "Optional — named from your first message if you leave it blank.",
        )
        ProjectPicker(state.projects, selectedProject) { selectedProjectId = it.id }
        ModelPicker(state.models, selectedModel) { selectedModel = it }

        Column(verticalArrangement = Arrangement.spacedBy(SynaraTheme.spacing.sm)) {
            Text(
                "Permission mode",
                style = MaterialTheme.typography.labelLarge,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Row(horizontalArrangement = Arrangement.spacedBy(SynaraTheme.spacing.sm)) {
                RuntimeMode.entries.forEach { mode ->
                    ModeOption(
                        label = mode.label,
                        selected = runtimeMode == mode,
                        modifier = Modifier.weight(1f),
                    ) { runtimeMode = mode }
                }
            }
            Text(
                runtimeMode.description,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }

        Column(verticalArrangement = Arrangement.spacedBy(SynaraTheme.spacing.sm)) {
            Text(
                "Interaction mode",
                style = MaterialTheme.typography.labelLarge,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Row(horizontalArrangement = Arrangement.spacedBy(SynaraTheme.spacing.sm)) {
                InteractionMode.entries.forEach { mode ->
                    ModeOption(
                        label = mode.label,
                        selected = interactionMode == mode,
                        modifier = Modifier.weight(1f),
                    ) { interactionMode = mode }
                }
            }
            Text(
                interactionMode.description,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

@Composable
private fun ModeOption(
    label: String,
    selected: Boolean,
    modifier: Modifier = Modifier,
    onClick: () -> Unit,
) {
    val shape = MaterialTheme.shapes.medium
    Row(
        modifier = modifier
            .background(
                if (selected) MaterialTheme.colorScheme.secondaryContainer else androidx.compose.ui.graphics.Color.Transparent,
                shape,
            )
            .border(
                1.dp,
                if (selected) MaterialTheme.colorScheme.outline else MaterialTheme.colorScheme.outlineVariant,
                shape,
            )
            .clickable(onClick = onClick)
            .padding(horizontal = SynaraTheme.spacing.md, vertical = SynaraTheme.spacing.sm),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(SynaraTheme.spacing.xs),
    ) {
        if (selected) {
            Icon(
                Icons.Outlined.Check,
                contentDescription = null,
                modifier = Modifier.size(15.dp),
                tint = MaterialTheme.colorScheme.onSurface,
            )
        }
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
private fun FormDialog(
    title: String,
    onDismiss: () -> Unit,
    confirmLabel: String,
    confirmEnabled: Boolean,
    onConfirm: () -> Unit,
    content: @Composable ColumnScope.() -> Unit,
) {
    Dialog(onDismissRequest = onDismiss, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Surface(
            modifier = Modifier
                .fillMaxWidth(0.92f)
                .imePadding(),
            shape = SynaraTheme.corners.sheet,
            color = MaterialTheme.colorScheme.surfaceContainerLow,
            border = androidx.compose.foundation.BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
        ) {
            Column(
                Modifier
                    .verticalScroll(rememberScrollState())
                    .padding(SynaraTheme.spacing.xl),
                verticalArrangement = Arrangement.spacedBy(SynaraTheme.spacing.lg),
            ) {
                Row(
                    Modifier.fillMaxWidth(),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.SpaceBetween,
                ) {
                    Text(
                        title,
                        style = MaterialTheme.typography.headlineSmall,
                        color = MaterialTheme.colorScheme.onSurface,
                    )
                    IconButton(onClick = onDismiss) {
                        Icon(
                            Icons.Outlined.Close,
                            contentDescription = "Close",
                            tint = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
                content()
                Row(
                    Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(SynaraTheme.spacing.sm, Alignment.End),
                ) {
                    TextButton(onClick = onDismiss) {
                        Text("Cancel", style = MaterialTheme.typography.labelLarge)
                    }
                    Button(
                        onClick = onConfirm,
                        enabled = confirmEnabled,
                        shape = MaterialTheme.shapes.medium,
                    ) {
                        Text(confirmLabel, style = MaterialTheme.typography.labelLarge)
                    }
                }
            }
        }
    }
}

@Composable
private fun ModelPicker(
    models: List<ModelOption>,
    selected: ModelOption?,
    onSelected: (ModelOption) -> Unit,
) {
    PickerField(
        label = "Model",
        sections = groupedByProvider(models).map { (provider, providerModels) ->
            PickerSection(Provider.labelFor(provider), providerModels)
        },
        selected = selected,
        placeholder = "Choose a model",
        emptyLabel = "No models discovered",
        primaryText = { it.label },
        // Nine providers can offer models with near-identical names, so the runtime a selection
        // belongs to has to be visible without reopening the menu.
        supportingText = { it.providerLabel },
        itemSupportingText = { it.description },
        isSelected = { it.slug == selected?.slug && it.provider == selected.provider },
        onSelected = onSelected,
    )
}

/**
 * Lets the user say where the thread goes.
 *
 * This used to be a sentence stating the destination, which meant an unlucky default could not be
 * corrected from the phone at all — the reason threads landed in Studio.
 */
@Composable
private fun ProjectPicker(
    projects: List<ProjectItem>,
    selected: ProjectItem?,
    onSelected: (ProjectItem) -> Unit,
) {
    val ordered = remember(projects) { projects.orderedForPicking() }
    PickerField(
        label = "Project",
        sections = remember(ordered) {
            ordered
                .groupBy { it.kind.isSystem }
                .toSortedMap()
                .map { (isSystem, group) ->
                    PickerSection(if (isSystem) "Built in" else "Your projects", group)
                }
        },
        selected = selected,
        placeholder = "Choose a project",
        emptyLabel = "No projects yet",
        primaryText = { it.title },
        supportingText = { it.pickerSubtitle },
        isSelected = { it.id == selected?.id },
        onSelected = onSelected,
    )
}

/**
 * What the destination actually is, in the terms that distinguish it from its neighbours.
 *
 * For a repository that is its path. For the server's own surfaces it is not: Home's root is the
 * bare home directory and Studio's is a folder named after the app, so a path there says nothing
 * about what picking it would do — and reads as a stray fragment ("home/robert") besides.
 */
private val ProjectItem.pickerSubtitle: String
    get() = when (kind) {
        ProjectKind.CHAT -> "Chat outside any repository"
        ProjectKind.STUDIO -> "Image generation workspace"
        ProjectKind.PROJECT -> workspaceRootLabel
    }

/** The tail of the workspace path — a phone has no room for the whole thing, and no need for it. */
private val ProjectItem.workspaceRootLabel: String
    get() = workspaceRoot.trimEnd('/').split('/').filter { it.isNotEmpty() }.takeLast(2)
        .joinToString("/")
        .ifEmpty { workspaceRoot }

/** Groups models by provider in `ProviderKind` declaration order rather than discovery order. */
internal fun groupedByProvider(models: List<ModelOption>): List<Pair<String, List<ModelOption>>> =
    models
        .groupBy { it.provider }
        .toList()
        .sortedBy { (provider, _) ->
            Provider.entries.indexOfFirst { it.kind == provider }.takeIf { it >= 0 } ?: Int.MAX_VALUE
        }
