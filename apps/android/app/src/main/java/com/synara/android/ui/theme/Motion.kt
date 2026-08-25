package com.synara.android.ui.theme

import android.provider.Settings
import androidx.compose.animation.EnterTransition
import androidx.compose.animation.ExitTransition
import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.Easing
import androidx.compose.animation.core.FiniteAnimationSpec
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.snap
import androidx.compose.animation.core.tween
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.runtime.Composable
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.runtime.remember
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.platform.LocalContext

/**
 * The single source of open/close motion, the Android counterpart of
 * `apps/web/src/lib/disclosureMotion.ts`. That module exists so every toggle in the product feels
 * identical (220ms `ease-out`, with `motion-reduce` fallbacks); duplicating one-off tweens per
 * screen here would break that promise across clients. Use [SynaraMotion] rather than writing a
 * bespoke `tween`.
 */
object SynaraMotion {
    /** `DISCLOSURE_TRANSITION_MS` on the web. */
    const val DisclosureMillis = 220

    /** Short acknowledgements: pressed states, status dot changes, chip selection. */
    const val QuickMillis = 120

    /** Screen-level transitions, where a little more travel time reads as intentional. */
    const val ScreenMillis = 300

    /** CSS `ease-out`, i.e. cubic-bezier(0, 0, 0.58, 1). */
    val EaseOut: Easing = CubicBezierEasing(0f, 0f, 0.58f, 1f)

    /** CSS `ease-in-out`, for things that both arrive and leave under their own power. */
    val EaseInOut: Easing = CubicBezierEasing(0.42f, 0f, 0.58f, 1f)

    /** Continuous, non-easing motion: shimmer sweeps and indeterminate pulses. */
    val Linear: Easing = LinearEasing
}

/**
 * True when the user has turned animations off system-wide (Settings › Developer options ›
 * Animator duration scale, or the Accessibility "remove animations" toggle, both of which write
 * [Settings.Global.ANIMATOR_DURATION_SCALE]). This is the platform equivalent of the web's
 * `prefers-reduced-motion`, and every helper below collapses to an instant change when it is set.
 */
internal val LocalReduceMotion = staticCompositionLocalOf { false }

@Composable
internal fun rememberSystemReduceMotion(): Boolean {
    val context = LocalContext.current
    return remember(context) {
        runCatching {
            Settings.Global.getFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) == 0f
        }.getOrDefault(false)
    }
}

/** A tween honoring [LocalReduceMotion]; the shared replacement for hand-written specs. */
@Composable
@ReadOnlyComposable
fun <T> synaraTween(
    durationMillis: Int = SynaraMotion.DisclosureMillis,
    easing: Easing = SynaraMotion.EaseOut,
): FiniteAnimationSpec<T> =
    if (LocalReduceMotion.current) snap() else tween(durationMillis, easing = easing)

/** Expand/collapse pair for disclosures, matching the web's grid-rows + opacity transition. */
@Composable
fun disclosureEnter(): EnterTransition =
    expandVertically(animationSpec = synaraTween()) + fadeIn(animationSpec = synaraTween())

@Composable
fun disclosureExit(): ExitTransition =
    shrinkVertically(animationSpec = synaraTween()) + fadeOut(animationSpec = synaraTween())

/** Transient surfaces that slide in from the bottom edge: snackbars, the pending-work banner. */
@Composable
fun bottomSheetEnter(): EnterTransition =
    slideInVertically(animationSpec = synaraTween()) { it } + fadeIn(animationSpec = synaraTween())

@Composable
fun bottomSheetExit(): ExitTransition =
    slideOutVertically(animationSpec = synaraTween()) { it } + fadeOut(animationSpec = synaraTween())
