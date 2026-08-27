package com.synara.android.ui.theme

import androidx.compose.runtime.Immutable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

/**
 * One spacing ramp for the whole app. Before this existed the screens used ad-hoc values —
 * 9dp, 11dp, 13dp, 14dp, 18dp, 22dp — which is why nothing lined up between cards.
 */
@Immutable
data class SynaraSpacing(
    val xxs: Dp = 2.dp,
    val xs: Dp = 4.dp,
    val sm: Dp = 8.dp,
    val md: Dp = 12.dp,
    val lg: Dp = 16.dp,
    val xl: Dp = 20.dp,
    val xxl: Dp = 24.dp,
    val xxxl: Dp = 32.dp,
    /** Horizontal gutter every screen's content aligns to. */
    val screenGutter: Dp = 16.dp,
    /** Inner padding of a standard card. */
    val cardPadding: Dp = 16.dp,
    /** Smallest comfortable touch target; below this, add an invisible hit-area instead. */
    val minTouchTarget: Dp = 48.dp,
)

internal val LocalSynaraSpacing = staticCompositionLocalOf { SynaraSpacing() }
