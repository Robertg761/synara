package com.synara.android.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.AccountTree
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.ArrowDownward
import androidx.compose.material.icons.outlined.ArrowUpward
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.automirrored.outlined.OpenInNew
import androidx.compose.material.icons.outlined.Refresh
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.synara.android.data.GitAction
import com.synara.android.data.GitBranchItem
import com.synara.android.data.GitFileChange
import com.synara.android.data.GitStatus
import com.synara.android.data.SynaraUiState
import com.synara.android.data.SynaraViewModel
import com.synara.android.ui.components.ActionSheetChoice
import com.synara.android.ui.components.ActionSheetItem
import com.synara.android.ui.components.ActionSheetSection
import com.synara.android.ui.components.EmptyState
import com.synara.android.ui.components.InlineNotice
import com.synara.android.ui.components.SynaraActionSheet
import com.synara.android.ui.components.SynaraBadge
import com.synara.android.ui.components.SynaraCard
import com.synara.android.ui.components.SynaraDivider
import com.synara.android.ui.components.synaraTextFieldColors
import com.synara.android.ui.theme.SynaraTheme

/**
 * Source control for a thread's checkout: branch state, uncommitted changes, and the commit /
 * push / open-PR actions the desktop exposes through its branch toolbar and git actions control.
 *
 * Commit, push and PR creation deliberately go through the server's single stacked action rather
 * than being sequenced here — a phone losing connectivity between a commit and its push would
 * otherwise strand the branch with no way to tell what had already happened.
 */
@Composable
fun SourceControlScreen(state: SynaraUiState, viewModel: SynaraViewModel) {
    val git = state.git
    val status = git.status
    val busy = git.busyLabel != null

    Scaffold(
        containerColor = MaterialTheme.colorScheme.background,
        topBar = {
            SynaraTopBar(
                onBack = viewModel::closeSourceControl,
                title = "Source control",
                subtitle = status?.branch ?: git.cwd?.substringAfterLast('/'),
                actions = {
                    IconButton(onClick = viewModel::refreshSourceControl, enabled = !git.isLoading && !busy) {
                        Icon(
                            Icons.Outlined.Refresh,
                            contentDescription = "Refresh source control",
                            tint = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                },
            )
        },
    ) { padding ->
        Box(Modifier.fillMaxSize().padding(padding)) {
            when {
                git.isLoading && status == null -> Box(
                    Modifier.fillMaxSize(),
                    contentAlignment = Alignment.Center,
                ) {
                    CircularProgressIndicator(
                        Modifier.size(22.dp),
                        strokeWidth = 2.dp,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }

                status == null -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    EmptyState(
                        icon = Icons.Outlined.AccountTree,
                        title = "Not a git repository",
                        body = git.error ?: "This thread's working directory is not under git.",
                    )
                }

                else -> LazyColumn(
                    Modifier.fillMaxSize().imePadding(),
                    contentPadding = PaddingValues(
                        start = SynaraTheme.spacing.screenGutter,
                        end = SynaraTheme.spacing.screenGutter,
                        top = SynaraTheme.spacing.md,
                        bottom = SynaraTheme.spacing.xxl,
                    ),
                    verticalArrangement = Arrangement.spacedBy(SynaraTheme.spacing.md),
                ) {
                    item("branch") { BranchCard(status, busy, viewModel) }

                    git.notice?.let { notice ->
                        item("notice") {
                            InlineNotice(
                                message = notice,
                                icon = Icons.Outlined.CheckCircle,
                                contentColor = SynaraTheme.accents.successForeground,
                                container = SynaraTheme.accents.successSurface,
                            )
                        }
                    }
                    git.error?.let { error -> item("error") { InlineNotice(error) } }

                    status.pullRequest?.let { pr ->
                        item("pr") { PullRequestCard(pr, viewModel::openPullRequest) }
                    }

                    item("commit") { CommitCard(state, viewModel) }

                    item("changes-label") {
                        Row(
                            Modifier.fillMaxWidth().padding(top = SynaraTheme.spacing.sm),
                            horizontalArrangement = Arrangement.SpaceBetween,
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Text(
                                "Working tree",
                                style = MaterialTheme.typography.labelLarge,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                            DiffCounts(status.insertions, status.deletions)
                        }
                    }

                    if (status.files.isEmpty()) {
                        item("clean") {
                            Text(
                                "No uncommitted changes.",
                                style = MaterialTheme.typography.bodyMedium,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    } else {
                        items(status.files, key = { it.path }) { file -> ChangedFileRow(file) }
                    }
                }
            }
        }
    }

    if (git.branchPickerOpen) BranchPickerSheet(state, viewModel)
}

@Composable
private fun BranchCard(status: GitStatus, busy: Boolean, viewModel: SynaraViewModel) {
    SynaraCard(contentSpacing = SynaraTheme.spacing.md) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Icon(
                Icons.Outlined.AccountTree,
                contentDescription = null,
                modifier = Modifier.size(18.dp),
                tint = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Spacer(Modifier.size(SynaraTheme.spacing.sm))
            Column(Modifier.weight(1f)) {
                Text(
                    status.branch ?: "detached HEAD",
                    style = SynaraTheme.textStyles.mono,
                    color = MaterialTheme.colorScheme.onSurface,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Text(
                    status.upstreamBranch?.let { "tracking $it" } ?: "no upstream",
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            // Ahead/behind is the one thing that decides whether pull or push is the useful
            // action next, so it sits beside the branch rather than inside a menu.
            if (status.aheadCount > 0) {
                AheadBehind(Icons.Outlined.ArrowUpward, status.aheadCount, "ahead")
            }
            if (status.behindCount > 0) {
                AheadBehind(Icons.Outlined.ArrowDownward, status.behindCount, "behind")
            }
        }

        Row(horizontalArrangement = Arrangement.spacedBy(SynaraTheme.spacing.sm)) {
            OutlinedButton(
                onClick = { viewModel.setBranchPickerOpen(true) },
                modifier = Modifier.weight(1f),
                enabled = !busy,
                shape = MaterialTheme.shapes.medium,
            ) {
                Text("Switch branch", style = MaterialTheme.typography.labelLarge)
            }
            OutlinedButton(
                onClick = viewModel::gitPull,
                modifier = Modifier.weight(1f),
                enabled = !busy && status.hasUpstream,
                shape = MaterialTheme.shapes.medium,
            ) {
                Text("Pull", style = MaterialTheme.typography.labelLarge)
            }
        }
    }
}

@Composable
private fun AheadBehind(icon: androidx.compose.ui.graphics.vector.ImageVector, count: Int, label: String) {
    Row(
        Modifier.padding(start = SynaraTheme.spacing.sm),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            icon,
            contentDescription = "$count commits $label",
            modifier = Modifier.size(14.dp),
            tint = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Text(
            count.toString(),
            style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

@Composable
private fun CommitCard(state: SynaraUiState, viewModel: SynaraViewModel) {
    val git = state.git
    val status = git.status ?: return
    val busy = git.busyLabel != null
    val canCommit = status.hasWorkingTreeChanges && git.commitMessage.isNotBlank() && !busy

    SynaraCard(contentSpacing = SynaraTheme.spacing.md) {
        Text(
            "Commit",
            style = MaterialTheme.typography.titleSmall,
            color = MaterialTheme.colorScheme.onSurface,
        )
        OutlinedTextField(
            value = git.commitMessage,
            onValueChange = viewModel::setCommitMessage,
            modifier = Modifier.fillMaxWidth().heightIn(min = 88.dp),
            placeholder = {
                Text("Describe the change…", style = MaterialTheme.typography.bodyMedium)
            },
            textStyle = MaterialTheme.typography.bodyMedium,
            enabled = !busy,
            maxLines = 4,
            shape = MaterialTheme.shapes.medium,
            colors = synaraTextFieldColors(),
        )

        if (busy) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                CircularProgressIndicator(
                    Modifier.size(15.dp),
                    strokeWidth = 2.dp,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Spacer(Modifier.size(SynaraTheme.spacing.sm))
                Text(
                    "${git.busyLabel}…",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }

        Row(horizontalArrangement = Arrangement.spacedBy(SynaraTheme.spacing.sm)) {
            Button(
                onClick = { viewModel.runGitAction(GitAction.COMMIT_PUSH) },
                modifier = Modifier.weight(1f),
                enabled = canCommit,
                shape = MaterialTheme.shapes.medium,
            ) {
                Text("Commit & push", style = MaterialTheme.typography.labelLarge)
            }
            OutlinedButton(
                onClick = { viewModel.runGitAction(GitAction.COMMIT) },
                modifier = Modifier.weight(1f),
                enabled = canCommit,
                shape = MaterialTheme.shapes.medium,
            ) {
                Text("Commit only", style = MaterialTheme.typography.labelLarge)
            }
        }
        OutlinedButton(
            onClick = { viewModel.runGitAction(GitAction.COMMIT_PUSH_PR) },
            modifier = Modifier.fillMaxWidth(),
            enabled = canCommit,
            shape = MaterialTheme.shapes.medium,
        ) {
            Text("Commit, push & open PR", style = MaterialTheme.typography.labelLarge)
        }
    }
}

@Composable
private fun PullRequestCard(pr: com.synara.android.data.GitPullRequestInfo, onOpen: () -> Unit) {
    val accents = SynaraTheme.accents
    val stateColor = when (pr.state) {
        "merged" -> accents.statusMerged
        "closed" -> accents.statusFailure
        else -> accents.statusSuccess
    }
    // Opens the in-app detail rather than the browser: checks and unresolved comments are the
    // reason to look, and bouncing to GitHub loses the session context.
    SynaraCard(contentSpacing = SynaraTheme.spacing.sm, onClick = onOpen) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            SynaraBadge(
                text = if (pr.isDraft) "Draft" else pr.state.replaceFirstChar { it.uppercase() },
                container = stateColor.copy(alpha = 0.16f),
                contentColor = stateColor,
            )
            Spacer(Modifier.size(SynaraTheme.spacing.sm))
            Text(
                "#${pr.number}",
                style = SynaraTheme.textStyles.monoSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Spacer(Modifier.weight(1f))
            Icon(
                Icons.AutoMirrored.Outlined.OpenInNew,
                contentDescription = "Open pull request details",
                modifier = Modifier.size(16.dp),
                tint = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        Text(
            pr.title,
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurface,
        )
        Text(
            "${pr.headBranch} → ${pr.baseBranch}",
            style = SynaraTheme.textStyles.monoSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

@Composable
private fun ChangedFileRow(file: GitFileChange) {
    Row(
        Modifier.fillMaxWidth().padding(vertical = SynaraTheme.spacing.sm),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(SynaraTheme.spacing.sm),
    ) {
        Column(Modifier.weight(1f)) {
            Text(
                file.fileName,
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurface,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            if (file.directory.isNotEmpty()) {
                Text(
                    file.directory,
                    style = SynaraTheme.textStyles.monoSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
        DiffCounts(file.insertions, file.deletions)
    }
}

@Composable
private fun BranchPickerSheet(state: SynaraUiState, viewModel: SynaraViewModel) {
    val git = state.git
    val branches = git.branches?.branches.orEmpty()
    val dirty = git.status?.hasWorkingTreeChanges == true
    var creating by remember { mutableStateOf(false) }
    var newBranch by remember { mutableStateOf("") }

    SynaraActionSheet(
        title = "Branches",
        subtitle = if (dirty) "Switching will stash your uncommitted changes" else null,
        onDismiss = { viewModel.setBranchPickerOpen(false) },
    ) {
        ActionSheetItem(
            icon = Icons.Outlined.Add,
            label = "New branch from here",
            onClick = { creating = true },
        )

        if (creating) {
            Column(
                Modifier.padding(
                    horizontal = SynaraTheme.spacing.xl,
                    vertical = SynaraTheme.spacing.sm,
                ),
                verticalArrangement = Arrangement.spacedBy(SynaraTheme.spacing.sm),
            ) {
                OutlinedTextField(
                    value = newBranch,
                    onValueChange = { newBranch = it },
                    modifier = Modifier.fillMaxWidth(),
                    placeholder = { Text("feature/my-change", style = SynaraTheme.textStyles.mono) },
                    textStyle = SynaraTheme.textStyles.mono,
                    singleLine = true,
                    shape = MaterialTheme.shapes.medium,
                    colors = synaraTextFieldColors(),
                )
                Button(
                    onClick = { viewModel.createBranch(newBranch) },
                    modifier = Modifier.fillMaxWidth(),
                    enabled = newBranch.isNotBlank(),
                    shape = MaterialTheme.shapes.medium,
                ) {
                    Text("Create branch", style = MaterialTheme.typography.labelLarge)
                }
            }
        }

        SynaraDivider()
        Column(Modifier.heightIn(max = 380.dp).verticalScroll(rememberScrollState())) {
            val local = branches.filterNot { it.isRemote }
            val remote = branches.filter { it.isRemote }
            if (local.isNotEmpty()) ActionSheetSection("Local")
            local.forEach { branch -> BranchChoice(branch, dirty, viewModel) }
            if (remote.isNotEmpty()) ActionSheetSection("Remote")
            remote.forEach { branch -> BranchChoice(branch, dirty, viewModel) }
        }
    }
}

@Composable
private fun BranchChoice(branch: GitBranchItem, dirty: Boolean, viewModel: SynaraViewModel) {
    // Git refuses to check out a branch already open in another worktree, so those are shown but
    // not offered — failing the call and surfacing git's message would be a worse explanation.
    val blocked = branch.worktreePath != null && !branch.isCurrent
    ActionSheetChoice(
        label = branch.name,
        description = when {
            blocked -> "Checked out in ${branch.worktreePath}"
            branch.isDefault -> "Default branch"
            else -> null
        },
        selected = branch.isCurrent,
        trailingLabel = if (branch.isDefault) "default" else null,
        onClick = {
            if (!branch.isCurrent && !blocked) viewModel.checkoutBranch(branch.name, stashFirst = dirty)
        },
    )
}
