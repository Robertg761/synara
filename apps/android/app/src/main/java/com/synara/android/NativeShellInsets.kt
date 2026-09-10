package com.synara.android

import android.view.View
import androidx.core.graphics.Insets
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat

/** Keep the whole renderer viewport inside system UI, rather than relying on CSS env support. */
internal object NativeShellInsets {
    fun install(activity: MainActivity) {
        WindowCompat.setDecorFitsSystemWindows(activity.window, false)
        val container = activity.bridge.webView.parent as View
        ViewCompat.setOnApplyWindowInsetsListener(container) { view, insets ->
            apply(view, insets)
        }
        ViewCompat.requestApplyInsets(container)
    }

    internal fun apply(container: View, insets: WindowInsetsCompat): WindowInsetsCompat {
        val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
        val keyboard = insets.getInsets(WindowInsetsCompat.Type.ime())
        container.setPadding(bars.left, bars.top, bars.right, maxOf(bars.bottom, keyboard.bottom))
        // Children already live inside these bounds. Zero values avoid a second CSS/WebView
        // adjustment while preserving dispatch/recalculation (unlike returning CONSUMED).
        return WindowInsetsCompat.Builder(insets)
            .setInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout() or WindowInsetsCompat.Type.ime(), Insets.NONE)
            .build()
    }
}
