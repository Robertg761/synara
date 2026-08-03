package com.synara.android.ui.screens

import androidx.compose.foundation.clickable
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
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.OpenInNew
import androidx.compose.material.icons.outlined.Cancel
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.automirrored.outlined.HelpOutline
import androidx.compose.material.icons.outlined.HourglassEmpty
import androidx.compose.material.icons.automirrored.outlined.MergeType
import androidx.compose.material.icons.outlined.Refresh
import androidx.compose.material.icons.outlined.RemoveCircleOutline
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.synara.android.data.CheckStatus
import com.synara.android.data.GitCheck
import com.synara.android.data.GitPullRequestInfo
import com.synara.android.data.GitReviewComment
import com.synara.android.data.SynaraUiState
import com.synara.android.data.SynaraViewModel
import com.synara.android.ui.components.EmptyState
import com.synara.android.ui.components.InlineNotice
import com.synara.android.ui.components.MarkdownText
import com.synara.android.ui.components.SectionLabel
import com.synara.android.ui.components.SynaraBadge
import com.synara.android.ui.components.SynaraCard
import com.synara.android.ui.components.SynaraDivider
import com.synara.android.ui.format.formatRelativeTimestamp
import com.synara.android.ui.theme.SynaraTheme

/**
 * Live CI and review state for the branch's pull request.
 *
 * Fetched separately from `git.status`, which only knows the PR's identity: checks and comments
 * come from GitHub over the network and folding them into the status read would stall the whole
 * source-control screen behind them.
 *
 * Only unresolved review threads are returned by the server, which is the right default here —
 * the question this screen answers is "what is still blocking the merge", not "what was discussed".
 */
@Composable
fun PullRequestScreen(state: SynaraUiState, viewModel: SynaraViewModel) {
    val prState = state.pullRequest
    val snapshot = prState.snapshot
    val uriHandler = LocalUriHandler.current

    Scaffold(
        containerColor = MaterialTheme.colorScheme.background,
        topBar = {
            SynaraTopBar(
                onBack = viewModel::closePullRequest,
                title = snapshot?.pullRequest?.let { "#${it.number}" } ?: "Pull request",
                subtitle = snapshot?.pullRequest?.title,
                actions = {
                    snapshot?.pullRequest?.url?.takeIf { it.isNotBlank() }?.let { url ->
                        IconButton(onClick = { uriHandler.openUri(url) }) {
                            Icon(
                                Icons.AutoMirrored.Outlined.OpenInNew,
                                contentDescription = "Open on GitHub",
                                tint = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }
                    IconButton(onClick = viewModel::refreshPullRequest, enabled = !prState.isLoading) {
                        Icon(
                            Icons.Outlined.Refresh,
                            contentDescription = "Refresh pull request",
                            tint = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                },
            )
        },
    ) { padding ->
        Box(Modifier.fillMaxSize().padding(padding)) {
            when {
                prState.isLoading && snapshot == null -> Box(
                    Modifier.fillMaxSize(),
                    contentAlignment = Alignment.Center,
                ) {
                    CircularProgressIndicator(
                        Modifier.size(22.dp),
                        strokeWidth = 2.dp,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }

                snapshot == null -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    EmptyState(
                        icon = Icons.AutoMirrored.Outlined.MergeType,
                        title = "Pull request unavailable",
                        body = prState.error
                            ?: "GitHub did not return details for this branch's pull request.",
                    )
                }

                else -> LazyColumn(
                    Modifier.fillMaxSize(),
                    contentPadding = PaddingValues(
                        start = SynaraTheme.spacing.screenGutter,
                        end = SynaraTheme.spacing.screenGutter,
                        top = SynaraTheme.spacing.md,
                        bottom = SynaraTheme.spacing.xxl,
                    ),
                    verticalArrangement = Arrangement.spacedBy(SynaraTheme.spacing.md),
                ) {
                    item("header") { PullRequestHeader(snapshot.pullRequest) }

                    prState.error?.let { item("error") { InlineNotice(it) } }

                    item("checks-label") {
                        SectionLabel(
                            when {
                                snapshot.checks.isEmpty() -> "Checks"
                                snapshot.failingChecks > 0 -> "Checks · ${snapshot.failingChecks} failing"
                                snapshot.pendingChecks > 0 -> "Checks · ${snapshot.pendingChecks} running"
                                else -> "Checks · all passing"
                            },
                        )
                    }
                    if (snapshot.checks.isEmpty()) {
                        item("no-checks") {
                            Text(
                                "No checks reported for this pull request.",
                                style = MaterialTheme.typography.bodyMedium,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    } else {
                        items(snapshot.checks, key = { it.name }) { check -> CheckRow(check) }
                    }

                    item("comments-label") {
                        SectionLabel(
                            "Unresolved review comments" +
                                if (snapshot.comments.isEmpty()) "" else " · ${snapshot.comments.size}",
                            Modifier.padding(top = SynaraTheme.spacing.sm),
                        )
                    }
                    snapshot.commentsError?.let { error ->
                        item("comments-error") { InlineNotice(error) }
                    }
                    if (snapshot.comments.isEmpty() && snapshot.commentsError == null) {
                        item("no-comments") {
                            Text(
                                "Nothing unresolved.",
                                style = MaterialTheme.typography.bodyMedium,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    } else {
                        items(snapshot.comments, key = { it.id }) { comment -> CommentCard(comment) }
                    }
                    if (snapshot.commentsTruncated) {
                        item("truncated") {
                            Text(
                                "More comments exist than are shown here. Open the pull request on " +
                                    "GitHub to read the rest.",
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun PullRequestHeader(pr: GitPullRequestInfo) {
    val accents = SynaraTheme.accents
    val stateColor = when (pr.state) {
        "merged" -> accents.statusMerged
        "closed" -> accents.statusFailure
        else -> accents.statusSuccess
    }
    SynaraCard(contentSpacing = SynaraTheme.spacing.sm) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(SynaraTheme.spacing.xs),
        ) {
            SynaraBadge(
                text = if (pr.isDraft) "Draft" else pr.state.replaceFirstChar { it.uppercase() },
                container = stateColor.copy(alpha = 0.16f),
                contentColor = stateColor,
            )
            // Mergeability is eventually consistent on GitHub's side: "unknown" is a real
            // transient state while it recomputes after a push, not a decode failure, so it is
            // shown as-is rather than hidden or guessed at.
            pr.mergeability?.let { mergeability ->
                val color = when (mergeability) {
                    "mergeable" -> accents.statusSuccess
                    "conflicting" -> accents.statusFailure
                    else -> accents.statusNeutral
                }
                SynaraBadge(
                    text = when (mergeability) {
                        "mergeable" -> "Mergeable"
                        "conflicting" -> "Conflicts"
                        else -> "Checking mergeability"
                    },
                    container = color.copy(alpha = 0.16f),
                    contentColor = color,
                )
            }
        }
        Text(
            pr.title,
            style = MaterialTheme.typography.titleSmall,
            color = MaterialTheme.colorScheme.onSurface,
        )
        Text(
            "${pr.headBranch} → ${pr.baseBranch}",
            style = SynaraTheme.textStyles.monoSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
        // `gh` does not always report diff sizes; the stat is hidden rather than rendered as a
        // misleading "+0 −0".
        if (pr.additions != null || pr.deletions != null) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(SynaraTheme.spacing.sm),
            ) {
                DiffCounts(pr.additions ?: 0, pr.deletions ?: 0)
                pr.changedFiles?.let {
                    Text(
                        "$it file${if (it == 1) "" else "s"}",
                        style = MaterialTheme.typography.labelMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        }
    }
}

@Composable
private fun CheckRow(check: GitCheck) {
    val accents = SynaraTheme.accents
    val uriHandler = LocalUriHandler.current
    val (icon, color) = when (check.status) {
        CheckStatus.SUCCESS -> Icons.Outlined.CheckCircle to accents.statusSuccess
        CheckStatus.FAILURE -> Icons.Outlined.Cancel to accents.statusFailure
        CheckStatus.PENDING -> Icons.Outlined.HourglassEmpty to accents.warningForeground
        CheckStatus.SKIPPED -> Icons.Outlined.RemoveCircleOutline to accents.statusNeutral
        CheckStatus.CANCELLED -> Icons.Outlined.RemoveCircleOutline to accents.statusNeutral
        CheckStatus.NEUTRAL -> Icons.AutoMirrored.Outlined.HelpOutline to accents.statusNeutral
    }
    Row(
        Modifier
            .fillMaxWidth()
            .then(
                // Only checks that reported a URL are tappable; the rest have nowhere to go.
                if (check.url.isNullOrBlank()) Modifier else Modifier.clickable { uriHandler.openUri(check.url) },
            )
            .padding(vertical = SynaraTheme.spacing.sm),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(SynaraTheme.spacing.sm),
    ) {
        Icon(icon, contentDescription = null, modifier = Modifier.size(17.dp), tint = color)
        Text(
            check.name,
            Modifier.weight(1f),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurface,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
        )
        Text(
            check.status.label,
            style = MaterialTheme.typography.labelMedium,
            color = color,
        )
    }
}

@Composable
private fun CommentCard(comment: GitReviewComment) {
    val uriHandler = LocalUriHandler.current
    SynaraCard(
        contentSpacing = SynaraTheme.spacing.sm,
        onClick = comment.url?.takeIf { it.isNotBlank() }?.let { { uriHandler.openUri(it) } },
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(SynaraTheme.spacing.sm),
        ) {
            Text(
                comment.author ?: "Reviewer",
                style = MaterialTheme.typography.titleSmall,
                color = MaterialTheme.colorScheme.onSurface,
            )
            Spacer(Modifier.weight(1f))
            comment.createdAt?.let {
                Text(
                    formatRelativeTimestamp(it),
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.outline,
                )
            }
        }
        comment.path?.let {
            Text(
                it,
                style = SynaraTheme.textStyles.monoSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        // Review bodies are markdown, and reviewers quote code constantly.
        MarkdownText(comment.body, style = MaterialTheme.typography.bodyMedium)
    }
}
