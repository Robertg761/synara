package com.synara.android.ui.theme

import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Shapes
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.unit.dp

/**
 * The web derives every corner from a single `--radius: 0.625rem` (10px) with fixed multipliers
 * (`--radius-sm` ×0.6 … `--radius-4xl` ×2.6). The same base and the same multipliers are used
 * here so a card on the phone has the corner of a card in the browser.
 */
private const val RADIUS = 10

internal val SynaraShapes = Shapes(
    extraSmall = RoundedCornerShape((RADIUS * 0.6f).dp), // --radius-sm, 6dp
    small = RoundedCornerShape((RADIUS * 0.8f).dp), // --radius-md, 8dp
    medium = RoundedCornerShape(RADIUS.dp), // --radius-lg, 10dp
    large = RoundedCornerShape((RADIUS * 1.4f).dp), // --radius-xl, 14dp
    extraLarge = RoundedCornerShape((RADIUS * 1.8f).dp), // --radius-2xl, 18dp
)

/** Corners past Material's five slots, plus the web's dedicated chat-bubble radius. */
@Immutable
data class SynaraCorners(
    val sheet: RoundedCornerShape,
    val userMessage: RoundedCornerShape,
    val pill: RoundedCornerShape,
)

internal val SynaraCornersDefault = SynaraCorners(
    sheet = RoundedCornerShape((RADIUS * 2.2f).dp), // --radius-3xl, 22dp
    userMessage = RoundedCornerShape(13.dp), // --radius-user-message, 0.8rem
    pill = RoundedCornerShape(percent = 50),
)

internal val LocalSynaraCorners = staticCompositionLocalOf { SynaraCornersDefault }
