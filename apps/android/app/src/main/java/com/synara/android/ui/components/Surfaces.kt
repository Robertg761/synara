@file:OptIn(androidx.compose.foundation.ExperimentalFoundationApi::class)

package com.synara.android.ui.components

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.synara.android.ui.theme.SynaraTheme

/**
 * The app's one card surface: `--card` fill plus the hairline `--border`, matching how the web
 * builds every panel. Deliberately flat — depth comes from the fill/border pair, not from a
 * Material tonal-elevation tint, which would push the neutral palette off-hue.
 */
@Composable
fun SynaraCard(
    modifier: Modifier = Modifier,
    shape: Shape = MaterialTheme.shapes.large,
    padding: Dp = SynaraTheme.spacing.cardPadding,
    contentSpacing: Dp = SynaraTheme.spacing.sm,
    border: BorderStroke? = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
    onClick: (() -> Unit)? = null,
    onLongClick: (() -> Unit)? = null,
    content: @Composable ColumnScope.() -> Unit,
) {
    val interaction = when {
        onClick != null && onLongClick != null ->
            Modifier.combinedClickable(onClick = onClick, onLongClick = onLongClick)

        onClick != null -> Modifier.clickable(onClick = onClick)
        else -> Modifier
    }
    val base = modifier
        .clip(shape)
        .background(MaterialTheme.colorScheme.surfaceContainerLow, shape)
        .then(if (border != null) Modifier.border(border, shape) else Modifier)
        .then(interaction)
    Column(
        modifier = base.padding(padding),
        verticalArrangement = Arrangement.spacedBy(contentSpacing),
        content = content,
    )
}

/**
 * A card that needs to pull attention — pending approvals, blocking questions. Uses a tinted
 * fill and a matching border rather than a heavier shadow, so it stays in the flat language.
 */
@Composable
fun SynaraAccentCard(
    tint: androidx.compose.ui.graphics.Color,
    border: androidx.compose.ui.graphics.Color,
    modifier: Modifier = Modifier,
    shape: Shape = MaterialTheme.shapes.large,
    padding: Dp = SynaraTheme.spacing.cardPadding,
    contentSpacing: Dp = SynaraTheme.spacing.md,
    content: @Composable ColumnScope.() -> Unit,
) {
    Column(
        modifier = modifier
            .clip(shape)
            .background(tint, shape)
            .border(BorderStroke(1.dp, border), shape)
            .padding(padding),
        verticalArrangement = Arrangement.spacedBy(contentSpacing),
        content = content,
    )
}

/**
 * A tappable list row. Threads and settings entries use these instead of stacked cards: a list of
 * bordered boxes fragments the page, while rows separated by hairlines read as one list — which
 * is also how the web sidebar presents the same data.
 */
@Composable
fun SynaraListRow(
    modifier: Modifier = Modifier,
    onClick: (() -> Unit)? = null,
    onLongClick: (() -> Unit)? = null,
    horizontalPadding: Dp = SynaraTheme.spacing.screenGutter,
    verticalPadding: Dp = SynaraTheme.spacing.md,
    content: @Composable ColumnScope.() -> Unit,
) {
    val interaction = when {
        onClick != null && onLongClick != null ->
            Modifier.combinedClickable(onClick = onClick, onLongClick = onLongClick)

        onClick != null -> Modifier.clickable(onClick = onClick)
        else -> Modifier
    }
    Column(
        modifier = modifier
            .fillMaxWidth()
            .then(interaction)
            .padding(horizontal = horizontalPadding, vertical = verticalPadding),
        verticalArrangement = Arrangement.spacedBy(SynaraTheme.spacing.sm),
        content = content,
    )
}

/** Hairline divider at `--app-surface-divider` weight — lighter than an outline. */
@Composable
fun SynaraDivider(
    modifier: Modifier = Modifier,
    startIndent: Dp = 0.dp,
) {
    Box(
        modifier
            .fillMaxWidth()
            .padding(start = startIndent)
            .height(1.dp)
            .background(SynaraTheme.accents.divider),
    )
}

/**
 * Section label above a group of content. Sentence case with muted ink rather than the tracked
 * uppercase "eyebrow" the app used before — the web app labels sections the same restrained way.
 */
@Composable
fun SectionLabel(
    text: String,
    modifier: Modifier = Modifier,
    trailing: (@Composable () -> Unit)? = null,
) {
    Row(
        modifier = modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.SpaceBetween,
    ) {
        Text(
            text,
            style = MaterialTheme.typography.labelLarge,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        trailing?.invoke()
    }
}
