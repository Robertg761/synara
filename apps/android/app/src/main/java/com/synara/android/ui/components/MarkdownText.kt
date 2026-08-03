package com.synara.android.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.synara.android.ui.theme.SynaraTheme

/**
 * Agent transcripts are markdown — fenced code, inline identifiers, bullet plans, bold emphasis.
 * Rendering them as one flat string, which is what the transcript used to do, buries the structure
 * the agent deliberately produced and makes code indistinguishable from prose.
 *
 * This is intentionally a small subset (fences, headings, lists, bold/italic, inline code, block
 * quotes) rather than a full CommonMark implementation: it covers what coding agents actually emit
 * and stays cheap enough to re-run on every streamed token.
 */
@Composable
fun MarkdownText(
    text: String,
    modifier: Modifier = Modifier,
    style: TextStyle = MaterialTheme.typography.bodyLarge,
    color: Color = MaterialTheme.colorScheme.onSurface,
) {
    val blocks = remember(text) { parseMarkdownBlocks(text) }
    Column(
        modifier = modifier,
        verticalArrangement = Arrangement.spacedBy(SynaraTheme.spacing.sm),
    ) {
        blocks.forEach { block ->
            when (block) {
                is MarkdownBlock.Code -> CodeBlock(block)
                is MarkdownBlock.Heading -> Text(
                    inlineMarkdown(block.text, color),
                    style = when (block.level) {
                        1 -> MaterialTheme.typography.titleLarge
                        2 -> MaterialTheme.typography.titleMedium
                        else -> MaterialTheme.typography.titleSmall
                    },
                    color = color,
                )

                is MarkdownBlock.Quote -> Row(
                    Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(SynaraTheme.spacing.sm),
                ) {
                    Column(
                        Modifier
                            .width(2.dp)
                            .background(MaterialTheme.colorScheme.outline),
                    ) {}
                    Text(
                        inlineMarkdown(block.text, color),
                        style = style,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }

                is MarkdownBlock.ListItem -> Row(
                    Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(SynaraTheme.spacing.sm),
                    verticalAlignment = Alignment.Top,
                ) {
                    Text(
                        block.marker,
                        style = style,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(start = (block.depth * 12).dp),
                    )
                    Text(inlineMarkdown(block.text, color), style = style, color = color)
                }

                is MarkdownBlock.Paragraph ->
                    Text(inlineMarkdown(block.text, color), style = style, color = color)
            }
        }
    }
}

@Composable
private fun CodeBlock(block: MarkdownBlock.Code) {
    val shape = MaterialTheme.shapes.small
    Column(
        Modifier
            .fillMaxWidth()
            .clip(shape)
            .background(SynaraTheme.accents.mutedSurface, shape)
            .border(1.dp, MaterialTheme.colorScheme.outlineVariant, shape),
    ) {
        if (block.language.isNotBlank()) {
            Text(
                block.language,
                modifier = Modifier.padding(start = 12.dp, top = 8.dp),
                style = SynaraTheme.textStyles.monoSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        Text(
            block.code,
            modifier = Modifier
                .horizontalScroll(rememberScrollState())
                .padding(horizontal = 12.dp, vertical = 10.dp),
            style = SynaraTheme.textStyles.code,
            color = MaterialTheme.colorScheme.onSurface,
            softWrap = false,
        )
    }
}

// ── Parsing ──────────────────────────────────────────────────────────────────────────────────

internal sealed interface MarkdownBlock {
    data class Paragraph(val text: String) : MarkdownBlock
    data class Heading(val level: Int, val text: String) : MarkdownBlock
    data class ListItem(val marker: String, val text: String, val depth: Int) : MarkdownBlock
    data class Quote(val text: String) : MarkdownBlock
    data class Code(val language: String, val code: String) : MarkdownBlock
}

private val BULLET = Regex("""^(\s*)[-*+]\s+(.*)$""")
private val NUMBERED = Regex("""^(\s*)(\d+)[.)]\s+(.*)$""")
private val HEADING = Regex("""^(#{1,6})\s+(.*)$""")

internal fun parseMarkdownBlocks(source: String): List<MarkdownBlock> {
    val blocks = mutableListOf<MarkdownBlock>()
    val paragraph = StringBuilder()

    fun flushParagraph() {
        // A single newline inside a paragraph is a *soft* break in markdown: it joins with a
        // space and rewraps. Keeping it as a literal newline leaves agent prose broken at
        // whatever column the model happened to wrap at, with orphan half-lines mid-sentence.
        val text = paragraph.toString()
            .trim()
            .lineSequence()
            .joinToString(" ") { it.trim() }
            .trim()
        if (text.isNotEmpty()) blocks += MarkdownBlock.Paragraph(text)
        paragraph.setLength(0)
    }

    val lines = source.lines()
    var index = 0
    while (index < lines.size) {
        val line = lines[index]
        val fence = line.trimStart().startsWith("```")
        if (fence) {
            flushParagraph()
            val language = line.trimStart().removePrefix("```").trim()
            val code = StringBuilder()
            index++
            while (index < lines.size && !lines[index].trimStart().startsWith("```")) {
                code.appendLine(lines[index])
                index++
            }
            // A fence left unterminated is normal mid-stream; render what has arrived so far.
            index++
            blocks += MarkdownBlock.Code(language, code.toString().trimEnd('\n'))
            continue
        }

        val heading = HEADING.matchEntire(line)
        if (heading != null) {
            flushParagraph()
            blocks += MarkdownBlock.Heading(
                heading.groupValues[1].length,
                heading.groupValues[2].trim(),
            )
            index++
            continue
        }

        val bullet = BULLET.matchEntire(line)
        if (bullet != null) {
            flushParagraph()
            blocks += MarkdownBlock.ListItem(
                marker = "•",
                text = bullet.groupValues[2].trim(),
                depth = bullet.groupValues[1].length / 2,
            )
            index++
            continue
        }

        val numbered = NUMBERED.matchEntire(line)
        if (numbered != null) {
            flushParagraph()
            blocks += MarkdownBlock.ListItem(
                marker = "${numbered.groupValues[2]}.",
                text = numbered.groupValues[3].trim(),
                depth = numbered.groupValues[1].length / 2,
            )
            index++
            continue
        }

        if (line.trimStart().startsWith("> ")) {
            flushParagraph()
            blocks += MarkdownBlock.Quote(line.trimStart().removePrefix("> ").trim())
            index++
            continue
        }

        // Lazy list continuation: an indented, unmarked line directly under a list item belongs to
        // that item. Without this it becomes its own paragraph and renders flush left, visually
        // escaping the list it is part of — which is common in agent output, where wrapped list
        // items are the norm.
        val previous = blocks.lastOrNull()
        if (
            line.isNotBlank() &&
            line.first().isWhitespace() &&
            paragraph.isEmpty() &&
            previous is MarkdownBlock.ListItem
        ) {
            blocks[blocks.lastIndex] = previous.copy(text = "${previous.text} ${line.trim()}")
            index++
            continue
        }

        if (line.isBlank()) flushParagraph() else paragraph.appendLine(line)
        index++
    }
    flushParagraph()
    return blocks
}

/** Inline spans: `code`, **bold**, *italic*. Unmatched delimiters are left as literal text. */
@Composable
private fun inlineMarkdown(text: String, baseColor: Color): AnnotatedString {
    val codeBackground = SynaraTheme.accents.mutedSurface
    val codeColor = MaterialTheme.colorScheme.onSurface
    return remember(text, baseColor, codeBackground) {
        buildInlineMarkdown(text, codeBackground, codeColor)
    }
}

internal fun buildInlineMarkdown(
    text: String,
    codeBackground: Color,
    codeColor: Color,
): AnnotatedString = buildAnnotatedString {
    var index = 0
    while (index < text.length) {
        when {
            text.startsWith("`", index) -> {
                val end = text.indexOf('`', index + 1)
                if (end < 0) {
                    append(text.substring(index)); index = text.length
                } else {
                    withStyleSpan(
                        SpanStyle(
                            fontFamily = FontFamily.Monospace,
                            background = codeBackground,
                            color = codeColor,
                        ),
                    ) { append(text.substring(index + 1, end)) }
                    index = end + 1
                }
            }

            text.startsWith("**", index) -> {
                val end = text.indexOf("**", index + 2)
                if (end < 0) {
                    append(text.substring(index)); index = text.length
                } else {
                    withStyleSpan(SpanStyle(fontWeight = FontWeight.SemiBold)) {
                        append(text.substring(index + 2, end))
                    }
                    index = end + 2
                }
            }

            text.startsWith("*", index) -> {
                val end = text.indexOf('*', index + 1)
                if (end < 0) {
                    append(text.substring(index)); index = text.length
                } else {
                    withStyleSpan(SpanStyle(fontStyle = FontStyle.Italic)) {
                        append(text.substring(index + 1, end))
                    }
                    index = end + 1
                }
            }

            else -> {
                // Advance to the next delimiter in one slice rather than per character.
                val next = listOf(
                    text.indexOf('`', index),
                    text.indexOf("**", index),
                    text.indexOf('*', index),
                ).filter { it > index }.minOrNull() ?: text.length
                append(text.substring(index, next))
                index = next
            }
        }
    }
}

private inline fun AnnotatedString.Builder.withStyleSpan(
    style: SpanStyle,
    block: AnnotatedString.Builder.() -> Unit,
) {
    val start = length
    block()
    addStyle(style, start, length)
}
