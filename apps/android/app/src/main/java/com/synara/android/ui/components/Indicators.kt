package com.synara.android.ui.components

import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.scale
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.synara.android.data.ConnectionState
import com.synara.android.ui.theme.SynaraMotion
import com.synara.android.ui.theme.SynaraTheme

/**
 * The state glyph used everywhere a thread or connection reports itself. A live agent gets a slow
 * halo pulse so "something is happening on the server" is legible without reading the label;
 * everything else is a plain dot. The pulse honors the system reduce-motion setting.
 */
@Composable
fun StatusDot(
    color: Color,
    modifier: Modifier = Modifier,
    pulsing: Boolean = false,
    size: androidx.compose.ui.unit.Dp = 7.dp,
) {
    Box(modifier.size(size * 2), contentAlignment = Alignment.Center) {
        if (pulsing && !SynaraTheme.reduceMotion) {
            val transition = rememberInfiniteTransition(label = "status-pulse")
            val scale by transition.animateFloat(
                initialValue = 1f,
                targetValue = 2.1f,
                animationSpec = infiniteRepeatable(
                    animation = tween(1600, easing = SynaraMotion.EaseOut),
                    repeatMode = RepeatMode.Restart,
                ),
                label = "status-pulse-scale",
            )
            val alpha by transition.animateFloat(
                initialValue = 0.32f,
                targetValue = 0f,
                animationSpec = infiniteRepeatable(
                    animation = tween(1600, easing = SynaraMotion.EaseOut),
                    repeatMode = RepeatMode.Restart,
                ),
                label = "status-pulse-alpha",
            )
            Box(
                Modifier
                    .size(size)
                    .scale(scale)
                    .background(color.copy(alpha = alpha), CircleShape),
            )
        }
        Box(Modifier.size(size).background(color, CircleShape))
    }
}

/**
 * Compact status text with its dot. Presented to accessibility services as a single phrase so
 * TalkBack reads "Running" rather than announcing an unlabeled decorative shape first.
 */
@Composable
fun StatusLabel(
    color: Color,
    label: String,
    modifier: Modifier = Modifier,
    pulsing: Boolean = false,
    labelColor: Color = color,
) {
    Row(
        modifier = modifier.clearAndSetSemantics {
            this.contentDescription = label
        },
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        StatusDot(color, pulsing = pulsing)
        Text(label, style = MaterialTheme.typography.labelMedium, color = labelColor)
    }
}

/** Small, low-noise chip for metadata and states. Filled variants carry semantic tints. */
@Composable
fun SynaraBadge(
    text: String,
    modifier: Modifier = Modifier,
    container: Color = SynaraTheme.accents.mutedSurface,
    contentColor: Color = MaterialTheme.colorScheme.onSurfaceVariant,
    borderColor: Color? = null,
    leading: (@Composable () -> Unit)? = null,
) {
    val shape = MaterialTheme.shapes.extraSmall
    Row(
        modifier = modifier
            .clip(shape)
            .background(container, shape)
            .then(if (borderColor != null) Modifier.border(1.dp, borderColor, shape) else Modifier)
            .padding(horizontal = 7.dp, vertical = 3.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        leading?.invoke()
        Text(
            text,
            style = MaterialTheme.typography.labelMedium,
            color = contentColor,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

/**
 * Connection state, rendered identically in the workspace bar and in Settings.
 *
 * The dot takes the `--status-*` tint and the text takes the readable `*-foreground` ink. They are
 * different values on purpose: emerald-500 is right for a 7dp glyph but only reaches ~2.3:1 against
 * a near-white background as text, which is below any usable contrast floor.
 */
@Composable
fun ConnectionPill(state: ConnectionState, modifier: Modifier = Modifier) {
    val accents = SynaraTheme.accents
    val (dot, text) = when (state) {
        ConnectionState.CONNECTED -> accents.statusSuccess to accents.successForeground
        ConnectionState.CONNECTING, ConnectionState.RECONNECTING ->
            accents.warning to accents.warningForeground

        ConnectionState.DISCONNECTED -> accents.statusNeutral to accents.statusNeutral
    }
    val label = when (state) {
        ConnectionState.CONNECTED -> "Online"
        ConnectionState.CONNECTING -> "Connecting"
        ConnectionState.RECONNECTING -> "Reconnecting"
        ConnectionState.DISCONNECTED -> "Offline"
    }
    StatusLabel(
        color = dot,
        label = label,
        modifier = modifier,
        pulsing = state != ConnectionState.CONNECTED && state != ConnectionState.DISCONNECTED,
        labelColor = text,
    )
}

/**
 * Provider mark shown beside a thread.
 *
 * Two letters, not one: with nine providers, "Codex", "Claude", and "Cursor" all collapse to the
 * same glyph under a single initial, which makes the mark useless for exactly the scanning it
 * exists to support. Slicing the display label keeps every current provider distinct (Co, Cl, Cu,
 * An, Gr, Dr, Ki, Op, Pi) without a lookup table to maintain as providers are added.
 *
 * Monochrome by design — the palette reserves color for status, and the web app likewise gives
 * only Claude a brand color.
 */
@Composable
fun ProviderMark(
    provider: String,
    label: String,
    modifier: Modifier = Modifier,
    size: androidx.compose.ui.unit.Dp = 28.dp,
) {
    val accents = SynaraTheme.accents
    val isClaude = provider == "claudeAgent"
    val tint = if (isClaude) accents.claude else MaterialTheme.colorScheme.onSurfaceVariant
    val container = if (isClaude) accents.claude.copy(alpha = 0.14f) else accents.mutedSurface
    Box(
        modifier = modifier
            .size(size)
            .background(container, MaterialTheme.shapes.extraSmall)
            .clearAndSetSemantics { contentDescription = label },
        contentAlignment = Alignment.Center,
    ) {
        Text(
            label.take(2),
            style = MaterialTheme.typography.labelMedium,
            color = tint,
        )
    }
}
