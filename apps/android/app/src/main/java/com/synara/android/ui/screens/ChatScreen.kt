package com.synara.android.ui.screens

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.clickable
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.material.icons.outlined.Build
import androidx.compose.material.icons.outlined.Checklist
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.input.TextFieldValue
import com.synara.android.data.CatalogueEntry
import com.synara.android.data.ComposerSuggestions
import com.synara.android.data.ProviderCatalogue
import com.synara.android.data.SuggestionKind
import com.synara.android.data.applySuggestion
import com.synara.android.data.composerSuggestionsFor
import com.synara.android.ui.theme.disclosureEnter
import com.synara.android.ui.theme.disclosureExit
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.keyframes
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.gestures.animateScrollBy
import androidx.compose.foundation.gestures.scrollBy
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowUpward
import androidx.compose.material.icons.filled.CheckBox
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material.icons.outlined.Check
import androidx.compose.material.icons.outlined.CheckBoxOutlineBlank
import androidx.compose.material.icons.outlined.ContentCopy
import androidx.compose.material.icons.outlined.Difference
import androidx.compose.material.icons.outlined.RadioButtonUnchecked
import androidx.compose.material.icons.outlined.Refresh
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.synara.android.data.ActivityItem
import com.synara.android.data.ConnectionState
import com.synara.android.data.InteractionMode
import com.synara.android.data.RuntimeMode
import com.synara.android.data.MessageItem
import com.synara.android.data.PendingInteraction
import com.synara.android.data.SynaraUiState
import com.synara.android.data.SynaraViewModel
import com.synara.android.data.ThreadDetail
import com.synara.android.data.ThreadItem
import com.synara.android.data.UserInputQuestion
import com.synara.android.ui.components.DisclosureSection
import com.synara.android.ui.components.ErrorSnackbar
import com.synara.android.ui.components.MarkdownText
import com.synara.android.ui.components.StatusLabel
import com.synara.android.ui.components.SynaraAccentCard
import com.synara.android.ui.components.SynaraBadge
import com.synara.android.ui.components.SynaraCard
import com.synara.android.ui.components.SynaraDivider
import com.synara.android.ui.components.synaraTextFieldColors
import com.synara.android.ui.format.formatTimeOfDay
import com.synara.android.ui.theme.SynaraTheme
import kotlinx.coroutines.flow.first
import org.json.JSONArray
import org.json.JSONObject

@Composable
fun ChatScreen(state: SynaraUiState, viewModel: SynaraViewModel) {
    val detail = state.detail
    val thread = detail?.thread ?: state.selectedThread
    // TextFieldValue rather than String: composer suggestions need the caret position to know
    // which token is being typed, and a plain String throws that away.
    var draft by rememberSaveable(state.selectedThreadId, stateSaver = TextFieldValue.Saver) {
        mutableStateOf(TextFieldValue())
    }
    val listState = rememberLazyListState()
    val focusManager = LocalFocusManager.current

    // Only follow the stream while the reader is already at the bottom. Yanking the viewport back
    // down while someone is scrolled up reading an earlier step is the single most disruptive
    // thing a streaming transcript can do.
    val following by remember {
        derivedStateOf {
            val info = listState.layoutInfo
            val last = info.visibleItemsInfo.lastOrNull()
            last == null || last.index >= info.totalItemsCount - 2
        }
    }
    val lastMessage = detail?.messages?.lastOrNull()
    val pendingKey = remember(detail?.pendingInteractions) {
        detail?.pendingInteractions
            ?.filter { it.status == "pending" || it.status == "retryable" }
            ?.joinToString(",") { "${it.kind}:${it.requestId}" }
            .orEmpty()
    }
    val hasPending = pendingKey.isNotEmpty()

    // Opening a thread should land at the newest message immediately; only later updates animate.
    var hasLanded by remember(state.selectedThreadId) { mutableStateOf(false) }
    LaunchedEffect(lastMessage?.id, lastMessage?.text?.length, lastMessage?.streaming) {
        if (lastMessage == null) return@LaunchedEffect
        // The first pass runs before the list has been laid out, when totalItemsCount is still 0.
        // Waiting for the first non-empty layout is what makes the initial jump happen at all.
        snapshotFlow { listState.layoutInfo.totalItemsCount }.first { it > 0 }
        if (!hasLanded) {
            listState.scrollToBottom(animate = false)
            hasLanded = true
        } else if (following) {
            listState.scrollToBottom(animate = true)
        }
    }

    // A new request for approval or input blocks the agent, so it overrides the "don't yank the
    // viewport" rule that governs ordinary streaming updates.
    LaunchedEffect(pendingKey) {
        if (!hasPending) return@LaunchedEffect
        snapshotFlow { listState.layoutInfo.totalItemsCount }.first { it > 0 }
        listState.scrollToBottom(animate = hasLanded)
    }

    Scaffold(
        containerColor = MaterialTheme.colorScheme.background,
        topBar = {
            SynaraTopBar(
                onBack = viewModel::openWorkspace,
                title = thread?.title ?: "Thread",
                subtitle = thread?.let { "${it.providerLabel} · ${it.model}" },
                actions = {
                    // Mirrors the desktop chat header's +N/-M toggle, which opens the DiffPanel.
                    IconButton(
                        onClick = { viewModel.openDiff() },
                        enabled = detail?.latestTurnCount != null,
                    ) {
                        Icon(
                            Icons.Outlined.Difference,
                            contentDescription = "View changes",
                            tint = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    IconButton(onClick = viewModel::refreshOrReconnect) {
                        Icon(
                            Icons.Outlined.Refresh,
                            contentDescription = "Refresh thread",
                            tint = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    // Long-press on a workspace row is not discoverable from inside a thread, so
                    // the same menu gets an explicit entry point here.
                    IconButton(
                        onClick = { thread?.id?.let(viewModel::openThreadActions) },
                        enabled = thread != null,
                    ) {
                        Icon(
                            Icons.Default.MoreVert,
                            contentDescription = "Thread actions",
                            tint = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                },
            )
        },
        bottomBar = {
            Composer(
                draft = draft,
                onDraftChange = { draft = it },
                catalogue = state.catalogue.catalogue,
                interactionMode = thread?.interactionMode,
                onToggleInteractionMode = {
                    thread?.let {
                        viewModel.setInteractionMode(
                            it.id,
                            if (it.interactionMode == InteractionMode.PLAN.wire) {
                                InteractionMode.DEFAULT
                            } else {
                                InteractionMode.PLAN
                            },
                        )
                    }
                },
                onSend = {
                    viewModel.sendMessage(draft.text)
                    draft = TextFieldValue()
                    focusManager.clearFocus()
                },
                onStop = viewModel::interruptThread,
                enabled = thread != null && state.connection == ConnectionState.CONNECTED,
                isSending = state.isSending,
                isRunning = thread?.isRunning == true,
            )
        },
    ) { padding ->
        Box(Modifier.fillMaxSize().padding(padding)) {
            if (detail == null || thread == null) {
                Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    if (state.isLoading) {
                        CircularProgressIndicator(
                            Modifier.size(22.dp),
                            strokeWidth = 2.dp,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    } else {
                        Text(
                            "Thread unavailable",
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
            } else {
                LazyColumn(
                    state = listState,
                    modifier = Modifier.fillMaxSize(),
                    contentPadding = PaddingValues(
                        start = SynaraTheme.spacing.screenGutter,
                        end = SynaraTheme.spacing.screenGutter,
                        top = SynaraTheme.spacing.md,
                        bottom = SynaraTheme.spacing.lg,
                    ),
                    verticalArrangement = Arrangement.spacedBy(SynaraTheme.spacing.lg),
                ) {
                    item(key = "status") { ThreadStatusStrip(detail) }

                    detail.proposedPlan?.let { plan ->
                        item(key = "plan") { ProposedPlanCard(plan) }
                    }

                    if (detail.messages.isEmpty()) {
                        item(key = "empty") { EmptyThreadCard(thread) }
                    } else {
                        items(detail.messages, key = { it.id }) { message -> Message(message) }
                    }

                    // Pending work sits *after* the transcript, not above it. It is the newest
                    // thing that happened, and anchoring it at the top meant the auto-scroll to
                    // the latest message pushed a blocking question off-screen — the agent would
                    // sit waiting on an answer the user could not see.
                    if (hasPending) {
                        item(key = "pending") { PendingInteractionsCard(detail, viewModel) }
                    }

                    if (detail.activities.isNotEmpty()) {
                        item(key = "activity") { ActivitySection(detail.activities) }
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

    ThreadActionsSheet(state, viewModel)
}

/**
 * Scrolls to the true bottom. `animateScrollToItem(lastIndex)` only aligns the last item's *top*
 * with the viewport, which leaves a long streaming reply scrolled off-screen; the follow-up
 * scroll consumes whatever of that item still overflows.
 */
private suspend fun LazyListState.scrollToBottom(animate: Boolean) {
    val count = layoutInfo.totalItemsCount
    if (count == 0) return
    if (animate) animateScrollToItem(count - 1) else scrollToItem(count - 1)
    val info = layoutInfo
    val last = info.visibleItemsInfo.lastOrNull() ?: return
    val viewport = info.viewportEndOffset - info.viewportStartOffset
    val overflow = last.size - viewport
    if (overflow > 0) {
        if (animate) animateScrollBy(overflow.toFloat()) else scrollBy(overflow.toFloat())
    }
}

@Composable
private fun ThreadStatusStrip(detail: ThreadDetail) {
    val accents = SynaraTheme.accents
    val running = detail.thread.isRunning
    Row(
        Modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(SynaraTheme.spacing.sm),
    ) {
        StatusLabel(
            color = if (running) accents.running else accents.statusNeutral,
            label = if (running) "Agent is working" else "Ready",
            pulsing = running,
            labelColor = if (running) accents.successForeground else accents.statusNeutral,
        )
        Spacer(Modifier.weight(1f))
        // Plan mode changes what a turn will actually do, so it is called out rather than left
        // to the menu; "Build" is the default and needs no badge of its own.
        if (detail.thread.interactionMode == InteractionMode.PLAN.wire) {
            SynaraBadge(
                text = InteractionMode.PLAN.label,
                container = accents.infoSurface,
                contentColor = accents.infoForeground,
            )
        }
        SynaraBadge(text = RuntimeMode.labelFor(detail.thread.runtimeMode))
    }
}

// ── Messages ─────────────────────────────────────────────────────────────────────────────────

@Composable
private fun Message(message: MessageItem) {
    if (message.isUser) UserMessage(message) else AssistantMessage(message)
}

/**
 * User turns are bubbled and right-aligned; assistant turns are not.
 *
 * That asymmetry is deliberate and matches the web client, which keeps a dedicated
 * `--radius-user-message` for the bubble and renders assistant output as plain document flow. An
 * agent's reply is usually long, structured markdown — boxing it in a bubble wastes the horizontal
 * room its code blocks and lists need.
 */
@Composable
private fun UserMessage(message: MessageItem) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
        Column(
            modifier = Modifier
                .widthIn(max = 320.dp)
                .clip(SynaraTheme.corners.userMessage)
                .background(MaterialTheme.colorScheme.secondaryContainer, SynaraTheme.corners.userMessage)
                .padding(horizontal = 14.dp, vertical = 10.dp),
            horizontalAlignment = Alignment.End,
        ) {
            SelectionContainer {
                Text(
                    message.text,
                    style = MaterialTheme.typography.bodyLarge,
                    color = MaterialTheme.colorScheme.onSecondaryContainer,
                )
            }
            val time = formatTimeOfDay(message.createdAt)
            if (time.isNotEmpty()) {
                Text(
                    time,
                    modifier = Modifier.padding(top = 3.dp),
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}

@Composable
private fun AssistantMessage(message: MessageItem) {
    val clipboard = LocalClipboardManager.current
    var copied by remember(message.id) { mutableStateOf(false) }

    Column(
        Modifier.fillMaxWidth(),
        verticalArrangement = Arrangement.spacedBy(SynaraTheme.spacing.xs),
    ) {
        Row(
            Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(SynaraTheme.spacing.sm),
        ) {
            Text(
                "Agent",
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            val time = formatTimeOfDay(message.createdAt)
            if (time.isNotEmpty()) {
                Text(
                    time,
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.outline,
                )
            }
            Spacer(Modifier.weight(1f))
            if (message.text.isNotBlank()) {
                IconButton(
                    onClick = {
                        clipboard.setText(AnnotatedString(message.text))
                        copied = true
                    },
                    modifier = Modifier.size(32.dp),
                ) {
                    Icon(
                        if (copied) Icons.Outlined.Check else Icons.Outlined.ContentCopy,
                        contentDescription = if (copied) "Copied" else "Copy message",
                        modifier = Modifier.size(15.dp),
                        tint = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        }

        if (message.text.isNotBlank()) {
            SelectionContainer {
                MarkdownText(message.text, Modifier.fillMaxWidth())
            }
        }
        if (message.streaming) StreamingDots()
    }
}

/** Three staggered dots — a quieter "still working" signal than a full-width progress bar. */
@Composable
private fun StreamingDots(modifier: Modifier = Modifier) {
    val color = MaterialTheme.colorScheme.onSurfaceVariant
    if (SynaraTheme.reduceMotion) {
        Text(
            "Working…",
            modifier = modifier,
            style = MaterialTheme.typography.bodySmall,
            color = color,
        )
        return
    }
    val transition = rememberInfiniteTransition(label = "streaming")
    Row(
        modifier = modifier.height(16.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        repeat(3) { index ->
            val alpha by transition.animateFloat(
                initialValue = 0.25f,
                targetValue = 0.25f,
                animationSpec = infiniteRepeatable(
                    animation = keyframes {
                        durationMillis = 1050
                        0.25f at 0
                        1f at 250 + index * 150
                        0.25f at 650 + index * 150
                    },
                    repeatMode = RepeatMode.Restart,
                ),
                label = "streaming-dot-$index",
            )
            Box(
                Modifier
                    .size(5.dp)
                    .background(color.copy(alpha = alpha), CircleShape),
            )
        }
    }
}

@Composable
private fun EmptyThreadCard(thread: ThreadItem) {
    SynaraCard(contentSpacing = SynaraTheme.spacing.xs) {
        Text(
            "Ready when you are.",
            style = MaterialTheme.typography.titleMedium,
            color = MaterialTheme.colorScheme.onSurface,
        )
        Text(
            "Send a focused task to ${thread.providerLabel}. The live response will appear here.",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

// ── Pending work ─────────────────────────────────────────────────────────────────────────────

@Composable
private fun PendingInteractionsCard(detail: ThreadDetail, viewModel: SynaraViewModel) {
    val accents = SynaraTheme.accents
    val pending = detail.pendingInteractions.filter { it.status == "pending" || it.status == "retryable" }
    if (pending.isEmpty()) return
    val approvals = pending.filter(PendingInteraction::isApproval)
    val userInputs = pending.filterNot(PendingInteraction::isApproval)

    SynaraAccentCard(
        tint = accents.warningSurface,
        border = accents.warning.copy(alpha = 0.35f),
    ) {
        Text(
            if (approvals.isNotEmpty()) "Approval needed" else "The agent needs input",
            style = MaterialTheme.typography.titleMedium,
            color = MaterialTheme.colorScheme.onSurface,
        )
        Text(
            if (approvals.isNotEmpty()) {
                "The agent is paused until you decide. Review the request, then choose how to proceed."
            } else {
                "Answer the agent's questions to continue this turn."
            },
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )

        approvals.forEach { interaction ->
            Row(
                Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(SynaraTheme.spacing.sm),
            ) {
                Button(
                    onClick = { viewModel.respondToApproval(interaction, "accept") },
                    modifier = Modifier.weight(1f),
                    shape = MaterialTheme.shapes.medium,
                    colors = ButtonDefaults.buttonColors(
                        containerColor = MaterialTheme.colorScheme.primary,
                        contentColor = MaterialTheme.colorScheme.onPrimary,
                    ),
                ) {
                    Icon(Icons.Outlined.Check, contentDescription = null, modifier = Modifier.size(16.dp))
                    Spacer(Modifier.size(SynaraTheme.spacing.xs))
                    Text("Approve", style = MaterialTheme.typography.labelLarge)
                }
                OutlinedButton(
                    onClick = { viewModel.respondToApproval(interaction, "decline") },
                    modifier = Modifier.weight(1f),
                    shape = MaterialTheme.shapes.medium,
                ) {
                    Text("Decline", style = MaterialTheme.typography.labelLarge)
                }
            }
        }

        userInputs.forEach { interaction ->
            val questions = detail.userInputQuestions(interaction)
            if (questions.isEmpty()) {
                Text(
                    "The question details are unavailable. Refresh this thread to try again.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            } else {
                UserInputQuestions(
                    questions = questions,
                    enabled = interaction.status == "pending" || interaction.status == "retryable",
                    onSubmit = { answers -> viewModel.respondToUserInput(interaction, answers) },
                )
            }
        }
    }
}

@Composable
private fun UserInputQuestions(
    questions: List<UserInputQuestion>,
    enabled: Boolean,
    onSubmit: (JSONObject) -> Unit,
) {
    var selections by remember(questions) { mutableStateOf<Map<String, List<String>>>(emptyMap()) }
    var customAnswers by remember(questions) { mutableStateOf<Map<String, String>>(emptyMap()) }
    val complete = questions.isNotEmpty() && questions.all { question ->
        customAnswers[question.id]?.trim()?.isNotEmpty() == true ||
            selections[question.id].orEmpty().isNotEmpty()
    }

    Column(verticalArrangement = Arrangement.spacedBy(SynaraTheme.spacing.lg)) {
        questions.forEach { question ->
            Column(verticalArrangement = Arrangement.spacedBy(SynaraTheme.spacing.sm)) {
                Text(
                    question.header,
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Text(
                    question.question,
                    style = MaterialTheme.typography.titleSmall,
                    color = MaterialTheme.colorScheme.onSurface,
                )
                question.options.forEach { option ->
                    val selected = selections[question.id].orEmpty().contains(option.label)
                    AnswerOption(
                        label = option.label,
                        description = option.description,
                        selected = selected,
                        multiSelect = question.multiSelect,
                        enabled = enabled,
                    ) {
                        val current = selections[question.id].orEmpty()
                        val next = if (question.multiSelect) {
                            if (selected) current - option.label else current + option.label
                        } else {
                            listOf(option.label)
                        }
                        selections = selections + (question.id to next)
                        customAnswers = customAnswers - question.id
                    }
                }
                OutlinedTextField(
                    value = customAnswers[question.id].orEmpty(),
                    onValueChange = { value ->
                        customAnswers = customAnswers + (question.id to value)
                        if (value.isNotBlank()) selections = selections - question.id
                    },
                    modifier = Modifier.fillMaxWidth(),
                    placeholder = {
                        Text("Your own answer", style = MaterialTheme.typography.bodyMedium)
                    },
                    textStyle = MaterialTheme.typography.bodyMedium,
                    enabled = enabled,
                    maxLines = 3,
                    shape = MaterialTheme.shapes.medium,
                    colors = synaraTextFieldColors(),
                )
            }
        }
        Button(
            onClick = {
                val answers = JSONObject()
                questions.forEach { question ->
                    val custom = customAnswers[question.id]?.trim().orEmpty()
                    val selected = selections[question.id].orEmpty()
                    when {
                        custom.isNotEmpty() -> answers.put(question.id, custom)
                        question.multiSelect -> answers.put(question.id, JSONArray(selected))
                        selected.isNotEmpty() -> answers.put(question.id, selected.first())
                    }
                }
                onSubmit(answers)
            },
            enabled = enabled && complete,
            modifier = Modifier.fillMaxWidth(),
            shape = MaterialTheme.shapes.medium,
        ) {
            Text(
                if (enabled) "Submit answers" else "Submitting…",
                style = MaterialTheme.typography.labelLarge,
            )
        }
    }
}

/**
 * A selectable answer with its description. The previous version put the description *outside* the
 * chip, so the tap target was the label alone while the text explaining it sat unclickable
 * underneath; here the whole block is one target.
 */
@Composable
private fun AnswerOption(
    label: String,
    description: String,
    selected: Boolean,
    multiSelect: Boolean,
    enabled: Boolean,
    onClick: () -> Unit,
) {
    val shape = MaterialTheme.shapes.medium
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(shape)
            .background(
                if (selected) MaterialTheme.colorScheme.secondaryContainer else SynaraTheme.accents.mutedSurface,
                shape,
            )
            .border(
                1.dp,
                if (selected) MaterialTheme.colorScheme.outline else MaterialTheme.colorScheme.outlineVariant,
                shape,
            )
            .then(
                if (enabled) {
                    Modifier.selectable(selected = selected, enabled = true, onClick = onClick)
                } else {
                    Modifier
                },
            )
            .padding(SynaraTheme.spacing.md),
        horizontalArrangement = Arrangement.spacedBy(SynaraTheme.spacing.sm),
        verticalAlignment = Alignment.Top,
    ) {
        // The unselected state must not be a dimmed tick: a checkmark reads as "chosen" whatever
        // its opacity. Radio vs checkbox glyphs also tell the user up front whether the question
        // takes one answer or several, which the surrounding copy never says.
        Icon(
            imageVector = when {
                multiSelect && selected -> Icons.Filled.CheckBox
                multiSelect -> Icons.Outlined.CheckBoxOutlineBlank
                selected -> Icons.Filled.CheckCircle
                else -> Icons.Outlined.RadioButtonUnchecked
            },
            contentDescription = null,
            modifier = Modifier.size(18.dp),
            tint = if (selected) {
                MaterialTheme.colorScheme.onSurface
            } else {
                MaterialTheme.colorScheme.onSurfaceVariant
            },
        )
        Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(
                label,
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurface,
            )
            if (description.isNotBlank()) {
                Text(
                    description,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}

@Composable
private fun ProposedPlanCard(plan: String) {
    SynaraCard(contentSpacing = SynaraTheme.spacing.xs) {
        DisclosureSection(title = "Proposed plan", initiallyExpanded = true) {
            SelectionContainer {
                MarkdownText(plan, style = MaterialTheme.typography.bodyMedium)
            }
        }
    }
}

@Composable
private fun ActivitySection(activities: List<ActivityItem>) {
    val accents = SynaraTheme.accents
    val recent = remember(activities) { activities.takeLast(8).asReversed() }
    SynaraCard(contentSpacing = SynaraTheme.spacing.xs) {
        DisclosureSection(
            title = "Recent activity",
            trailingSummary = "${activities.size}",
        ) {
            recent.forEach { activity ->
                Row(
                    Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(SynaraTheme.spacing.sm),
                    verticalAlignment = Alignment.Top,
                ) {
                    Box(Modifier.padding(top = 5.dp)) {
                        Box(
                            Modifier
                                .size(6.dp)
                                .background(
                                    when (activity.tone) {
                                        "error" -> accents.statusFailure
                                        "approval" -> accents.warningForeground
                                        else -> accents.statusNeutral
                                    },
                                    CircleShape,
                                ),
                        )
                    }
                    Text(
                        activity.summary,
                        modifier = Modifier.weight(1f),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 3,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
        }
    }
}

// ── Composer ─────────────────────────────────────────────────────────────────────────────────

@Composable
private fun Composer(
    draft: TextFieldValue,
    onDraftChange: (TextFieldValue) -> Unit,
    catalogue: ProviderCatalogue?,
    interactionMode: String?,
    onToggleInteractionMode: () -> Unit,
    onSend: () -> Unit,
    onStop: () -> Unit,
    enabled: Boolean,
    isSending: Boolean,
    isRunning: Boolean,
) {
    val suggestions = remember(draft.text, draft.selection.end, catalogue) {
        composerSuggestionsFor(draft.text, draft.selection.end, catalogue)
    }
    Column(
        Modifier
            .fillMaxWidth()
            .background(MaterialTheme.colorScheme.background)
            .imePadding()
            .navigationBarsPadding(),
    ) {
        SynaraDivider()
        AnimatedVisibility(
            visible = suggestions != null,
            enter = disclosureEnter(),
            exit = disclosureExit(),
        ) {
            suggestions?.let { active ->
                SuggestionRow(active) { entry ->
                    val (text, caret) = applySuggestion(draft.text, active, entry)
                    onDraftChange(TextFieldValue(text, TextRange(caret)))
                }
            }
        }
        PlanModeToggle(interactionMode, enabled, onToggleInteractionMode)
        Row(
            Modifier
                .fillMaxWidth()
                .padding(
                    horizontal = SynaraTheme.spacing.md,
                    vertical = SynaraTheme.spacing.sm,
                ),
            verticalAlignment = Alignment.Bottom,
            horizontalArrangement = Arrangement.spacedBy(SynaraTheme.spacing.sm),
        ) {
            OutlinedTextField(
                value = draft,
                onValueChange = onDraftChange,
                modifier = Modifier.weight(1f),
                placeholder = {
                    Text(
                        if (enabled) "Ask your agent anything…" else "Reconnect to send",
                        style = MaterialTheme.typography.bodyMedium,
                    )
                },
                textStyle = MaterialTheme.typography.bodyMedium,
                maxLines = 6,
                enabled = enabled && !isSending,
                shape = SynaraTheme.corners.pill,
                colors = synaraTextFieldColors(),
            )

            val canSend = enabled && draft.text.isNotBlank() && !isSending
            if (isRunning) {
                ComposerAction(
                    onClick = onStop,
                    enabled = true,
                    container = SynaraTheme.accents.dangerSurface,
                    content = MaterialTheme.colorScheme.error,
                    icon = Icons.Default.Stop,
                    description = "Stop the agent",
                )
            } else {
                ComposerAction(
                    onClick = onSend,
                    enabled = canSend,
                    container = if (canSend) {
                        MaterialTheme.colorScheme.primary
                    } else {
                        SynaraTheme.accents.mutedSurface
                    },
                    content = if (canSend) {
                        MaterialTheme.colorScheme.onPrimary
                    } else {
                        MaterialTheme.colorScheme.outline
                    },
                    icon = Icons.Default.ArrowUpward,
                    description = "Send message",
                )
            }
        }
    }
}

/**
 * Slash commands and skill mentions, offered as the token is typed. Horizontal rather than a
 * popup list: a popup over a soft keyboard covers the very text being edited.
 */
@Composable
private fun SuggestionRow(
    suggestions: ComposerSuggestions,
    onSelect: (CatalogueEntry) -> Unit,
) {
    LazyRow(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = SynaraTheme.spacing.md, vertical = SynaraTheme.spacing.xs),
        horizontalArrangement = Arrangement.spacedBy(SynaraTheme.spacing.xs),
    ) {
        items(suggestions.entries, key = { it.name }) { entry ->
            val shape = MaterialTheme.shapes.small
            Column(
                Modifier
                    .widthIn(max = 240.dp)
                    .clip(shape)
                    .background(SynaraTheme.accents.mutedSurface, shape)
                    .border(1.dp, MaterialTheme.colorScheme.outlineVariant, shape)
                    .clickable { onSelect(entry) }
                    .padding(horizontal = SynaraTheme.spacing.md, vertical = SynaraTheme.spacing.sm),
            ) {
                Text(
                    (if (suggestions.kind == SuggestionKind.COMMAND) "/" else "@") + entry.name,
                    style = SynaraTheme.textStyles.monoSmall,
                    color = MaterialTheme.colorScheme.onSurface,
                    maxLines = 1,
                )
                entry.description?.takeIf { it.isNotBlank() }?.let {
                    Text(
                        it,
                        style = MaterialTheme.typography.labelMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
        }
    }
}

/**
 * Plan mode is switchable from the composer, not just the thread menu: it decides whether the
 * turn about to be sent will change files, which is a per-message decision in practice.
 */
@Composable
private fun PlanModeToggle(interactionMode: String?, enabled: Boolean, onToggle: () -> Unit) {
    if (interactionMode == null) return
    val planning = interactionMode == InteractionMode.PLAN.wire
    val accents = SynaraTheme.accents
    val shape = MaterialTheme.shapes.extraSmall
    Row(
        Modifier.padding(start = SynaraTheme.spacing.md, top = SynaraTheme.spacing.xs),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Row(
            Modifier
                .clip(shape)
                .background(if (planning) accents.infoSurface else SynaraTheme.accents.mutedSurface, shape)
                .border(
                    1.dp,
                    if (planning) accents.info.copy(alpha = 0.4f) else MaterialTheme.colorScheme.outlineVariant,
                    shape,
                )
                .clickable(enabled = enabled, onClick = onToggle)
                .padding(horizontal = 9.dp, vertical = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            Icon(
                if (planning) Icons.Outlined.Checklist else Icons.Outlined.Build,
                contentDescription = null,
                modifier = Modifier.size(13.dp),
                tint = if (planning) accents.infoForeground else MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Text(
                if (planning) "Plan mode" else "Build mode",
                style = MaterialTheme.typography.labelMedium,
                color = if (planning) accents.infoForeground else MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

@Composable
private fun ComposerAction(
    onClick: () -> Unit,
    enabled: Boolean,
    container: androidx.compose.ui.graphics.Color,
    content: androidx.compose.ui.graphics.Color,
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    description: String,
) {
    IconButton(
        onClick = onClick,
        enabled = enabled,
        modifier = Modifier
            .padding(bottom = 4.dp)
            .size(48.dp)
            .background(container, CircleShape),
    ) {
        Icon(icon, contentDescription = description, tint = content, modifier = Modifier.size(20.dp))
    }
}
