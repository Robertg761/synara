package com.synara.android.ui.theme

import android.app.Activity
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.runtime.SideEffect
import androidx.compose.ui.platform.LocalView
import androidx.core.view.WindowCompat

/**
 * Wraps Material 3 with the tokens ported from the web app.
 *
 * System bar *colors* are deliberately not set here: [MainActivity] opts into edge-to-edge, so the
 * bars are transparent and the app's own background shows through. All that remains is telling the
 * platform whether to draw its icons dark or light.
 */
@Composable
fun SynaraTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    content: @Composable () -> Unit,
) {
    val view = LocalView.current
    if (!view.isInEditMode) {
        SideEffect {
            val window = (view.context as? Activity)?.window ?: return@SideEffect
            WindowCompat.getInsetsController(window, view).apply {
                isAppearanceLightStatusBars = !darkTheme
                isAppearanceLightNavigationBars = !darkTheme
            }
        }
    }

    CompositionLocalProvider(
        LocalSynaraAccents provides if (darkTheme) DarkAccents else LightAccents,
        LocalSynaraSpacing provides SynaraSpacing(),
        LocalSynaraCorners provides SynaraCornersDefault,
        LocalSynaraTextStyles provides SynaraTextStylesDefault,
        LocalReduceMotion provides rememberSystemReduceMotion(),
    ) {
        MaterialTheme(
            colorScheme = if (darkTheme) DarkColorScheme else LightColorScheme,
            typography = SynaraTypography,
            shapes = SynaraShapes,
            content = content,
        )
    }
}

/**
 * Accessors for the tokens Material has no home for. Mirrors the `MaterialTheme.colorScheme`
 * shape so call sites read the same way: `SynaraTheme.accents.running`, `SynaraTheme.spacing.lg`.
 */
object SynaraTheme {
    val accents: SynaraAccents
        @Composable @ReadOnlyComposable get() = LocalSynaraAccents.current

    val spacing: SynaraSpacing
        @Composable @ReadOnlyComposable get() = LocalSynaraSpacing.current

    val corners: SynaraCorners
        @Composable @ReadOnlyComposable get() = LocalSynaraCorners.current

    val textStyles: SynaraTextStyles
        @Composable @ReadOnlyComposable get() = LocalSynaraTextStyles.current

    val reduceMotion: Boolean
        @Composable @ReadOnlyComposable get() = LocalReduceMotion.current
}
