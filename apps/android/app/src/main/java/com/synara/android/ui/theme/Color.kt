package com.synara.android.ui.theme

import androidx.compose.material3.ColorScheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color

/**
 * The Android palette is a direct port of the web app's design tokens in
 * `apps/web/src/index.css` (`:root` and its `@variant dark` block) so both clients read as one
 * product. Tailwind ships those tokens as OKLCH; the values below are their exact sRGB
 * conversions, and every `color-mix()` in the CSS is resolved here to the same sRGB result.
 *
 * Two rules keep this file honest:
 *  1. Every Material 3 color role is assigned. Material's `lightColorScheme`/`darkColorScheme`
 *     builders default any omitted role to the *baseline purple* scheme, which is how lavender
 *     buttons and navigation pills leak into an otherwise neutral app. Omit nothing.
 *  2. Anything the web expresses as a translucent overlay (`--border`, `--input`, `--muted`)
 *     stays translucent here too, so it composites over whatever surface it lands on exactly
 *     like the CSS does.
 */
private object Tw {
    // Tailwind v4 defaults, converted from OKLCH to sRGB.
    val Neutral100 = Color(0xFFF5F5F5)
    val Neutral400 = Color(0xFFA1A1A1)
    val Neutral500 = Color(0xFF737373)
    val Neutral800 = Color(0xFF262626)
    val Neutral900 = Color(0xFF171717)
    val Red400 = Color(0xFFFF6467)
    val Red500 = Color(0xFFFB2C36)
    val Red700 = Color(0xFFC10007)
    val Emerald400 = Color(0xFF00D492)
    val Emerald500 = Color(0xFF00BC7D)
    val Emerald700 = Color(0xFF007A55)
    val Amber400 = Color(0xFFFFB900)
    val Amber500 = Color(0xFFFE9A00)
    val Amber700 = Color(0xFFBB4D00)
    val Blue500 = Color(0xFF2B7FFF)
    val Indigo500 = Color(0xFF615FFF)
    val Zinc500 = Color(0xFF71717B)
}

/**
 * Semantic colors Material 3 has no role for. The web carries these as their own tokens
 * (`--success`, `--warning`, `--info`, `--status-*`, `--claude`), so they live beside the
 * `ColorScheme` rather than being forced into `tertiary`/`secondary` and losing their meaning.
 */
@Immutable
data class SynaraAccents(
    /** Solid fill color; pair with [onSuccess] for text sitting on the fill. */
    val success: Color,
    val onSuccess: Color,
    /** Readable ink for success text on a plain or tinted surface. */
    val successForeground: Color,
    val successSurface: Color,
    val warning: Color,
    val onWarning: Color,
    val warningForeground: Color,
    val warningSurface: Color,
    val info: Color,
    val infoForeground: Color,
    val infoSurface: Color,
    val dangerForeground: Color,
    val dangerSurface: Color,
    /** Status indicator tints: the role color in light, a step toward white in dark. */
    val statusSuccess: Color,
    val statusFailure: Color,
    val statusNeutral: Color,
    val statusMerged: Color,
    /** The live-agent pulse. Deliberately the same hue as [statusSuccess]. */
    val running: Color,
    /** Anthropic's brand orange, mirroring the web's `--claude` token. */
    val claude: Color,
    /** Hairline used for internal dividers; lighter than `outline`, matching `--app-surface-divider`. */
    val divider: Color,
    /** Translucent fill for the composer / inputs, matching `--input`. */
    val inputSurface: Color,
    /** Low-contrast fill for skeletons and inert chips, matching `--muted`. */
    val mutedSurface: Color,
    val isLight: Boolean,
)

// ── Light ────────────────────────────────────────────────────────────────────────────────────
// --background #fcfcfc, --card #fff, --foreground neutral-800, --primary neutral-900.

private val LightBackground = Color(0xFFFCFCFC)
private val LightForeground = Tw.Neutral800
private val LightCard = Color(0xFFFFFFFF)

/** `--muted-foreground`: color-mix(neutral-500 90%, black). */
private val LightMutedForeground = Color(0xFF686868)

/**
 * Surface steps. The web only needs `--card` because hover/elevation are CSS effects; Material
 * asks for a five-step container ramp, so these interpolate between `--card` and a slightly
 * dimmed `--background` while staying inside the same near-white band.
 */
private val LightSurfaceContainerLowest = Color(0xFFFFFFFF)
private val LightSurfaceContainerLow = Color(0xFFFFFFFF)
private val LightSurfaceContainer = Color(0xFFF7F7F7)
private val LightSurfaceContainerHigh = Color(0xFFF2F2F2)
private val LightSurfaceContainerHighest = Color(0xFFEDEDED)

internal val LightColorScheme: ColorScheme = lightColorScheme(
    primary = Tw.Neutral900,
    onPrimary = Color.White,
    primaryContainer = Color(0xFFF0F0F0),
    onPrimaryContainer = Tw.Neutral900,
    inversePrimary = Tw.Neutral100,

    secondary = LightMutedForeground,
    onSecondary = Color.White,
    secondaryContainer = Color(0xFFF2F2F2),
    onSecondaryContainer = LightForeground,

    // `--info` doubles as the app's tertiary accent; nothing else in the design is chromatic.
    tertiary = Tw.Blue500,
    onTertiary = Color.White,
    tertiaryContainer = Color(0xFFE7F0FF),
    onTertiaryContainer = Color(0xFF0B3F8F),

    background = LightBackground,
    onBackground = LightForeground,
    surface = LightBackground,
    onSurface = LightForeground,
    surfaceVariant = Color(0xFFF2F2F2),
    onSurfaceVariant = LightMutedForeground,
    // Neutral tint keeps Material's tonal elevation from washing surfaces purple.
    surfaceTint = Tw.Neutral900,
    inverseSurface = Tw.Neutral800,
    inverseOnSurface = Tw.Neutral100,

    surfaceBright = Color(0xFFFFFFFF),
    surfaceDim = Color(0xFFEFEFEF),
    surfaceContainerLowest = LightSurfaceContainerLowest,
    surfaceContainerLow = LightSurfaceContainerLow,
    surfaceContainer = LightSurfaceContainer,
    surfaceContainerHigh = LightSurfaceContainerHigh,
    surfaceContainerHighest = LightSurfaceContainerHighest,

    error = Tw.Red500,
    onError = Color.White,
    errorContainer = Color(0xFFFDECED),
    onErrorContainer = Tw.Red700,

    // `--border` is black/5% on the web. A 1px hairline that faint disappears on a phone held at
    // arm's length, so `outline` (interactive edges: text fields, outlined buttons) is stepped up
    // while `outlineVariant` (passive dividers) keeps the web's weight.
    outline = Color(0x1F000000),
    outlineVariant = Color(0x0D000000),
    scrim = Color(0xFF000000),
)

internal val LightAccents = SynaraAccents(
    success = Tw.Emerald500,
    onSuccess = Color.White,
    successForeground = Tw.Emerald700,
    successSurface = Color(0x1400BC7D),
    warning = Tw.Amber500,
    onWarning = Color.White,
    warningForeground = Tw.Amber700,
    warningSurface = Color(0x1AFE9A00),
    info = Tw.Blue500,
    infoForeground = Color(0xFF526FFF),
    infoSurface = Color(0x142B7FFF),
    dangerForeground = Tw.Red700,
    dangerSurface = Color(0x14FB2C36),
    statusSuccess = Tw.Emerald500,
    statusFailure = Tw.Red500,
    statusNeutral = Tw.Zinc500,
    statusMerged = Tw.Indigo500,
    running = Tw.Emerald500,
    claude = Color(0xFFD97757),
    divider = Color(0x0D000000),
    inputSurface = Color(0x0F000000),
    mutedSurface = Color(0x0A000000),
    isLight = true,
)

// ── Dark ─────────────────────────────────────────────────────────────────────────────────────
// --background #0e0e0e, --card color-mix(background 99%, white) = #101010, --foreground neutral-100.

private val DarkBackground = Color(0xFF0E0E0E)
private val DarkForeground = Tw.Neutral100
private val DarkCard = Color(0xFF101010)

/** `--muted-foreground`: color-mix(neutral-500 90%, white). */
private val DarkMutedForeground = Color(0xFF818181)

/** `--destructive`: color-mix(red-500 90%, white). */
private val DarkDestructive = Color(0xFFFB414A)

private val DarkSurfaceContainerLowest = Color(0xFF0A0A0A)
private val DarkSurfaceContainerLow = DarkCard
private val DarkSurfaceContainer = Color(0xFF151515)
private val DarkSurfaceContainerHigh = Color(0xFF1C1C1C)
private val DarkSurfaceContainerHighest = Color(0xFF242424)

internal val DarkColorScheme: ColorScheme = darkColorScheme(
    primary = Tw.Neutral100,
    onPrimary = Tw.Neutral900,
    primaryContainer = Color(0xFF262626),
    onPrimaryContainer = Tw.Neutral100,
    inversePrimary = Tw.Neutral900,

    secondary = DarkMutedForeground,
    onSecondary = DarkBackground,
    secondaryContainer = Color(0xFF1C1C1C),
    onSecondaryContainer = Tw.Neutral100,

    tertiary = Tw.Blue500,
    onTertiary = Color.White,
    tertiaryContainer = Color(0xFF14243D),
    onTertiaryContainer = Color(0xFF9FC2FF),

    background = DarkBackground,
    onBackground = DarkForeground,
    surface = DarkBackground,
    onSurface = DarkForeground,
    surfaceVariant = Color(0xFF1A1A1A),
    onSurfaceVariant = DarkMutedForeground,
    surfaceTint = Tw.Neutral100,
    inverseSurface = Tw.Neutral100,
    inverseOnSurface = Tw.Neutral900,

    surfaceBright = Color(0xFF262626),
    surfaceDim = DarkBackground,
    surfaceContainerLowest = DarkSurfaceContainerLowest,
    surfaceContainerLow = DarkSurfaceContainerLow,
    surfaceContainer = DarkSurfaceContainer,
    surfaceContainerHigh = DarkSurfaceContainerHigh,
    surfaceContainerHighest = DarkSurfaceContainerHighest,

    error = DarkDestructive,
    onError = Tw.Neutral900,
    errorContainer = Color(0xFF2A1416),
    onErrorContainer = Tw.Red400,

    outline = Color(0x26FFFFFF),
    outlineVariant = Color(0x14FFFFFF),
    scrim = Color(0xFF000000),
)

internal val DarkAccents = SynaraAccents(
    success = Tw.Emerald500,
    onSuccess = Tw.Neutral900,
    successForeground = Tw.Emerald400,
    successSurface = Color(0x1F00BC7D),
    warning = Tw.Amber500,
    onWarning = Tw.Neutral900,
    warningForeground = Tw.Amber400,
    warningSurface = Color(0x1FFE9A00),
    info = Tw.Blue500,
    infoForeground = Color(0xFF6073CC),
    infoSurface = Color(0x1F2B7FFF),
    dangerForeground = Tw.Red400,
    dangerSurface = Color(0x1FFB414A),
    // `--status-*` in dark: color-mix(role 72%, white).
    statusSuccess = Color(0xFF47CFA1),
    statusFailure = Color(0xFFFC767D),
    statusNeutral = Color(0xFF9999A0),
    statusMerged = Color(0xFF8D8CFF),
    running = Color(0xFF47CFA1),
    claude = Color(0xFFD97757),
    divider = Color(0x0FFFFFFF),
    inputSurface = Color(0x0DFFFFFF),
    mutedSurface = Color(0x0AFFFFFF),
    isLight = false,
)

internal val LocalSynaraAccents = staticCompositionLocalOf { DarkAccents }
