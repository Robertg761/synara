package com.synara.android.ui.theme

import androidx.compose.material3.Typography
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp

/**
 * Type mirrors the web app's two decisions rather than its font files.
 *
 * The web resolves `--font-ui-family` to `-apple-system`/`system-ui` — the host platform's own UI
 * face — and then explicitly sets `letter-spacing: normal` so "text reads native rather than
 * designed". [FontFamily.Default] is the Android side of that same choice, and every style below
 * keeps tracking at zero instead of inheriting Material's baked-in letter spacing.
 *
 * Code and machine identifiers (model slugs, server URLs, paths, diffs) use the platform mono,
 * standing in for the web's `--font-mono-family` JetBrains Mono stack.
 */
private val Ui = FontFamily.Default
private val Mono = FontFamily.Monospace

private fun ui(
    size: Int,
    lineHeight: Int,
    weight: FontWeight = FontWeight.Normal,
    tracking: Double = 0.0,
) = TextStyle(
    fontFamily = Ui,
    fontWeight = weight,
    fontSize = size.sp,
    lineHeight = lineHeight.sp,
    letterSpacing = tracking.sp,
)

/**
 * Sizes are tightened relative to Material's baseline scale: this is a dense console on a phone,
 * not a marketing page, and the baseline display sizes (57sp) would fit three words per line.
 */
internal val SynaraTypography = Typography(
    displayLarge = ui(36, 41, FontWeight.SemiBold, -0.6),
    displayMedium = ui(30, 36, FontWeight.SemiBold, -0.4),
    displaySmall = ui(26, 32, FontWeight.SemiBold, -0.3),

    headlineLarge = ui(24, 30, FontWeight.SemiBold, -0.2),
    headlineMedium = ui(22, 28, FontWeight.SemiBold, -0.2),
    headlineSmall = ui(20, 26, FontWeight.SemiBold, -0.1),

    titleLarge = ui(18, 24, FontWeight.SemiBold),
    titleMedium = ui(16, 22, FontWeight.SemiBold),
    titleSmall = ui(14, 20, FontWeight.SemiBold),

    bodyLarge = ui(16, 24),
    bodyMedium = ui(14, 21),
    bodySmall = ui(13, 19),

    labelLarge = ui(14, 18, FontWeight.Medium),
    labelMedium = ui(12, 16, FontWeight.Medium),
    labelSmall = ui(11, 14, FontWeight.Medium),
)

/** Monospace styles Material has no slot for. */
@Immutable
data class SynaraTextStyles(
    /** Inline machine text: model slugs, ids, hosts. */
    val mono: TextStyle,
    /** Smaller mono for metadata rows. */
    val monoSmall: TextStyle,
    /** Fenced code blocks in assistant messages. */
    val code: TextStyle,
)

internal val SynaraTextStylesDefault = SynaraTextStyles(
    mono = TextStyle(fontFamily = Mono, fontSize = 13.sp, lineHeight = 19.sp),
    monoSmall = TextStyle(fontFamily = Mono, fontSize = 11.sp, lineHeight = 15.sp),
    code = TextStyle(fontFamily = Mono, fontSize = 13.sp, lineHeight = 20.sp),
)

internal val LocalSynaraTextStyles = staticCompositionLocalOf { SynaraTextStylesDefault }
