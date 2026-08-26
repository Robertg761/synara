package com.synara.android.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.DeleteSweep
import androidx.compose.material.icons.outlined.RestartAlt
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.synara.android.data.AnsiTerminalBuffer
import com.synara.android.data.SynaraUiState
import com.synara.android.data.SynaraViewModel
import com.synara.android.data.TerminalKey
import com.synara.android.ui.components.InlineNotice
import com.synara.android.ui.components.StatusLabel
import com.synara.android.ui.components.SynaraDivider
import com.synara.android.ui.components.synaraTextFieldColors
import com.synara.android.ui.theme.SynaraTheme

/**
 * A real terminal attached to the thread's checkout.
 *
 * The PTY keeps running when this screen is left — closing a view is not the same as ending a
 * session, and a build killed by backing out would be a nasty surprise. Output is rendered from
 * [AnsiTerminalBuffer], which interprets the escape sequences a PTY actually emits; the raw stream
 * would otherwise show every colour as literal `ESC[32m` text and stack each progress-bar frame
 * instead of overwriting it.
 */
@Composable
fun TerminalScreen(state: SynaraUiState, viewModel: SynaraViewModel) {
    val terminal = state.terminal
    val listState = rememberLazyListState()
    var input by remember { mutableStateOf("") }

    // Re-read the buffer whenever the revision changes; the emulator is mutable and
    // identity-stable, so the counter is what tells Compose a redraw is due.
    val lines = remember(terminal.revision) { viewModel.terminalBuffer.lines() }

    LaunchedEffect(terminal.revision) {
        if (lines.isNotEmpty()) listState.scrollToItem(lines.lastIndex)
    }

    // The PTY is told how wide the view actually is, measured from the mono advance width, so the
    // shell wraps where the user sees the edge instead of at an assumed 80 columns.
    val density = LocalDensity.current
    val textMeasurer = rememberTextMeasurer()
    var viewportWidthPx by remember { mutableIntStateOf(0) }
    val columns by remember(viewportWidthPx) {
        derivedStateOf {
            if (viewportWidthPx <= 0) return@derivedStateOf 80
            val advance = textMeasurer.measure(AnnotatedString("0"), TerminalTextStyle).size.width
            if (advance <= 0) 80 else (viewportWidthPx / advance).coerceIn(20, 500)
        }
    }
    val gutterPx = with(density) { (SynaraTheme.spacing.md * 2).roundToPx() }
    LaunchedEffect(columns) { viewModel.resizeTerminal(columns, 40) }

    Scaffold(
        containerColor = TerminalBackground,
        topBar = {
            SynaraTopBar(
                onBack = viewModel::closeTerminalScreen,
                title = "Terminal",
                subtitle = terminal.cwd?.substringAfterLast('/'),
                actions = {
                    IconButton(onClick = viewModel::clearTerminal) {
                        Icon(
                            Icons.Outlined.DeleteSweep,
                            contentDescription = "Clear terminal",
                            tint = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    IconButton(onClick = viewModel::restartTerminal) {
                        Icon(
                            Icons.Outlined.RestartAlt,
                            contentDescription = "Restart shell",
                            tint = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                },
            )
        },
        bottomBar = {
            Column(
                Modifier
                    .fillMaxWidth()
                    .background(MaterialTheme.colorScheme.background)
                    .imePadding()
                    .navigationBarsPadding(),
            ) {
                SynaraDivider()
                TerminalKeyBar(viewModel)
                Row(
                    Modifier
                        .fillMaxWidth()
                        .padding(
                            horizontal = SynaraTheme.spacing.md,
                            vertical = SynaraTheme.spacing.sm,
                        ),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    OutlinedTextField(
                        value = input,
                        onValueChange = { input = it },
                        modifier = Modifier.weight(1f),
                        placeholder = { Text("Command", style = SynaraTheme.textStyles.mono) },
                        textStyle = SynaraTheme.textStyles.mono,
                        singleLine = true,
                        shape = MaterialTheme.shapes.medium,
                        colors = synaraTextFieldColors(),
                        keyboardOptions = KeyboardOptions(
                            imeAction = ImeAction.Send,
                            autoCorrectEnabled = false,
                        ),
                        keyboardActions = KeyboardActions(
                            onSend = {
                                // Enter is sent as part of the payload so the shell receives one
                                // write, not a command followed by a separate newline.
                                viewModel.sendTerminalInput(input + "\n")
                                input = ""
                            },
                        ),
                    )
                }
            }
        },
    ) { padding ->
        Box(
            Modifier
                .fillMaxSize()
                .padding(padding)
                .background(TerminalBackground)
                .onSizeChanged { viewportWidthPx = (it.width - gutterPx).coerceAtLeast(0) },
        ) {
            when {
                terminal.isConnecting -> Box(
                    Modifier.fillMaxSize(),
                    contentAlignment = Alignment.Center,
                ) {
                    CircularProgressIndicator(
                        Modifier.size(22.dp),
                        strokeWidth = 2.dp,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }

                else -> Column(Modifier.fillMaxSize()) {
                    TerminalStatusStrip(state)
                    terminal.error?.let {
                        Box(Modifier.padding(SynaraTheme.spacing.md)) { InlineNotice(it) }
                    }
                    LazyColumn(
                        state = listState,
                        modifier = Modifier
                            .fillMaxSize()
                            .horizontalScroll(rememberScrollState()),
                        contentPadding = PaddingValues(
                            horizontal = SynaraTheme.spacing.md,
                            vertical = SynaraTheme.spacing.sm,
                        ),
                    ) {
                        itemsIndexed(lines) { _, line ->
                            Text(
                                text = line.toAnnotatedString(),
                                style = TerminalTextStyle,
                                softWrap = false,
                            )
                        }
                    }
                }
            }
        }
    }

}

@Composable
private fun TerminalStatusStrip(state: SynaraUiState) {
    val accents = SynaraTheme.accents
    val terminal = state.terminal
    val snapshot = terminal.snapshot
    Row(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = SynaraTheme.spacing.md, vertical = SynaraTheme.spacing.xs),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(SynaraTheme.spacing.sm),
    ) {
        StatusLabel(
            color = if (terminal.isRunning) accents.running else accents.statusNeutral,
            label = when {
                terminal.isRunning -> "Running"
                snapshot?.exitCode != null -> "Exited (${snapshot.exitCode})"
                else -> "Stopped"
            },
            pulsing = terminal.isRunning,
            labelColor = if (terminal.isRunning) accents.successForeground else accents.statusNeutral,
        )
        Text(
            terminal.cwd.orEmpty(),
            style = SynaraTheme.textStyles.monoSmall,
            color = MaterialTheme.colorScheme.outline,
            maxLines = 1,
        )
    }
}

/**
 * Control keys a soft keyboard does not offer. Without ^C in particular the phone terminal could
 * start a long-running command and then have no way to stop it.
 */
@Composable
private fun TerminalKeyBar(viewModel: SynaraViewModel) {
    Row(
        Modifier
            .fillMaxWidth()
            .horizontalScroll(rememberScrollState())
            .padding(horizontal = SynaraTheme.spacing.md, vertical = SynaraTheme.spacing.xs),
        horizontalArrangement = Arrangement.spacedBy(SynaraTheme.spacing.xs),
    ) {
        TerminalKey.entries.forEach { key ->
            val shape = MaterialTheme.shapes.extraSmall
            Box(
                Modifier
                    .clip(shape)
                    .background(SynaraTheme.accents.mutedSurface, shape)
                    .border(1.dp, MaterialTheme.colorScheme.outlineVariant, shape)
                    .clickable { viewModel.sendTerminalKey(key) }
                    .padding(horizontal = 12.dp, vertical = 7.dp),
            ) {
                Text(
                    key.label,
                    style = SynaraTheme.textStyles.monoSmall,
                    color = MaterialTheme.colorScheme.onSurface,
                )
            }
        }
    }
}

private fun AnsiTerminalBuffer.Line.toAnnotatedString(): AnnotatedString = buildAnnotatedString {
    spans.forEach { span ->
        val base = span.foreground?.let(::Color) ?: TerminalForeground
        val style = SpanStyle(
            // SGR 2 (dim) is a reduction of the current colour, not a separate palette entry, so
            // it folds into the alpha rather than selecting a different ink.
            color = if (span.dim) base.copy(alpha = 0.6f) else base,
            background = span.background?.let(::Color) ?: Color.Unspecified,
            fontWeight = if (span.bold) FontWeight.Bold else null,
            fontStyle = if (span.italic) FontStyle.Italic else null,
            textDecoration = if (span.underline) TextDecoration.Underline else null,
        )
        withStyle(style) { append(span.text) }
    }
}

private val TerminalBackground = Color(0xFF0A0A0A)
private val TerminalForeground = Color(0xFFD9D9D9)
private val TerminalTextStyle = androidx.compose.ui.text.TextStyle(
    fontFamily = androidx.compose.ui.text.font.FontFamily.Monospace,
    fontSize = 12.sp,
    lineHeight = 17.sp,
)
