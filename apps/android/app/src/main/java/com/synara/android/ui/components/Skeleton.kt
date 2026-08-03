package com.synara.android.ui.components

import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.synara.android.ui.theme.SynaraMotion
import com.synara.android.ui.theme.SynaraTheme
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue

/**
 * Loading placeholders shaped like the content that replaces them, so the list does not jump when
 * data lands. Matches the web's `--animate-skeleton` sweep: a 2s linear, infinitely repeating
 * highlight pass over a muted base.
 */
@Composable
fun SkeletonBlock(
    modifier: Modifier = Modifier,
    height: Dp = 14.dp,
    shape: androidx.compose.ui.graphics.Shape = RoundedCornerShape(6.dp),
) {
    val accents = SynaraTheme.accents
    var width by remember { mutableFloatStateOf(0f) }

    val brush = if (SynaraTheme.reduceMotion || width <= 0f) {
        Brush.linearGradient(listOf(accents.mutedSurface, accents.mutedSurface))
    } else {
        val transition = rememberInfiniteTransition(label = "skeleton")
        val offset by transition.animateFloat(
            initialValue = -width,
            targetValue = width * 2f,
            animationSpec = infiniteRepeatable(
                animation = tween(2000, easing = SynaraMotion.Linear),
                repeatMode = RepeatMode.Restart,
            ),
            label = "skeleton-sweep",
        )
        val highlight =
            if (accents.isLight) androidx.compose.ui.graphics.Color.Black.copy(alpha = 0.05f)
            else androidx.compose.ui.graphics.Color.White.copy(alpha = 0.05f)
        Brush.linearGradient(
            colors = listOf(accents.mutedSurface, highlight, accents.mutedSurface),
            start = Offset(offset, 0f),
            end = Offset(offset + width, 0f),
        )
    }

    Box(
        modifier
            .height(height)
            .onGloballyPositioned { width = it.size.width.toFloat() }
            .clip(shape)
            .background(brush),
    )
}

/** Placeholder matching the geometry of a thread row, used while the first snapshot loads. */
@Composable
fun ThreadRowSkeleton(modifier: Modifier = Modifier) {
    Row(
        modifier = modifier
            .fillMaxWidth()
            .padding(
                horizontal = SynaraTheme.spacing.screenGutter,
                vertical = SynaraTheme.spacing.md,
            ),
        horizontalArrangement = Arrangement.spacedBy(SynaraTheme.spacing.md),
    ) {
        Box(
            Modifier
                .size(28.dp)
                .clip(MaterialTheme.shapes.extraSmall)
                .background(SynaraTheme.accents.mutedSurface),
        )
        Column(
            Modifier.weight(1f),
            verticalArrangement = Arrangement.spacedBy(SynaraTheme.spacing.sm),
        ) {
            SkeletonBlock(Modifier.fillMaxWidth(0.62f), height = 15.dp)
            SkeletonBlock(Modifier.fillMaxWidth(0.38f), height = 11.dp)
        }
    }
}
