package com.synara.android.ui.components

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.synara.android.ui.theme.SynaraTheme
import com.synara.android.ui.theme.bottomSheetEnter
import com.synara.android.ui.theme.bottomSheetExit

/**
 * Empty states carry real weight in this app — a fresh install has no projects and no threads, so
 * this is the first screen most people see after pairing. Icon, one line of explanation, one
 * action; nothing else.
 */
@Composable
fun EmptyState(
    icon: ImageVector,
    title: String,
    body: String,
    modifier: Modifier = Modifier,
    action: (@Composable () -> Unit)? = null,
) {
    Column(
        modifier = modifier.fillMaxWidth().padding(horizontal = SynaraTheme.spacing.xl),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(SynaraTheme.spacing.sm),
    ) {
        Box(
            Modifier
                .size(48.dp)
                .background(SynaraTheme.accents.mutedSurface, CircleShape),
            contentAlignment = Alignment.Center,
        ) {
            Icon(
                icon,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.size(22.dp),
            )
        }
        Text(
            title,
            style = MaterialTheme.typography.titleMedium,
            color = MaterialTheme.colorScheme.onSurface,
            textAlign = TextAlign.Center,
        )
        Text(
            body,
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            textAlign = TextAlign.Center,
        )
        if (action != null) {
            Box(Modifier.padding(top = SynaraTheme.spacing.sm)) { action() }
        }
    }
}

/**
 * Inline, non-blocking notice attached to the thing it describes — a failing form field, an
 * insecure-URL warning. Text takes the role color and the tint carries the signal; the on-fill
 * `*Foreground` inks are never painted over a tint, matching the rule documented on the web
 * tokens.
 */
@Composable
fun InlineNotice(
    message: String,
    modifier: Modifier = Modifier,
    icon: ImageVector = Icons.Outlined.ErrorOutline,
    contentColor: Color = SynaraTheme.accents.dangerForeground,
    container: Color = SynaraTheme.accents.dangerSurface,
) {
    val shape = MaterialTheme.shapes.small
    Row(
        modifier = modifier
            .fillMaxWidth()
            .clip(shape)
            .background(container, shape)
            .padding(horizontal = SynaraTheme.spacing.md, vertical = SynaraTheme.spacing.sm),
        horizontalArrangement = Arrangement.spacedBy(SynaraTheme.spacing.sm),
        verticalAlignment = Alignment.Top,
    ) {
        Icon(icon, contentDescription = null, tint = contentColor, modifier = Modifier.size(16.dp))
        Text(message, style = MaterialTheme.typography.bodySmall, color = contentColor)
    }
}

/**
 * Transient errors, anchored to the bottom of the screen.
 *
 * Previously these rendered as a banner pinned to the top, which covered the workspace header —
 * the brand mark, connection state, and the settings button all disappeared behind it, exactly
 * when a user needed the reconnect affordance most. Bottom placement keeps navigation reachable.
 */
@Composable
fun ErrorSnackbar(
    message: String?,
    onDismiss: () -> Unit,
    modifier: Modifier = Modifier,
    actionLabel: String? = null,
    onAction: (() -> Unit)? = null,
) {
    // The message is retained past dismissal so the copy does not blank out halfway through the
    // exit animation, which reads as a glitch rather than a dismissal.
    val retained = remember { mutableStateOf("") }
    if (message != null) retained.value = message

    AnimatedVisibility(
        visible = message != null,
        enter = bottomSheetEnter(),
        exit = bottomSheetExit(),
        modifier = modifier,
    ) {
        val shape = MaterialTheme.shapes.large
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = SynaraTheme.spacing.md)
                .clip(shape)
                .background(MaterialTheme.colorScheme.inverseSurface, shape)
                .border(1.dp, MaterialTheme.colorScheme.outlineVariant, shape)
                .padding(start = SynaraTheme.spacing.md, end = SynaraTheme.spacing.xs),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(
                Icons.Outlined.ErrorOutline,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.inverseOnSurface,
                modifier = Modifier.size(18.dp),
            )
            Text(
                retained.value,
                modifier = Modifier
                    .weight(1f)
                    .padding(start = SynaraTheme.spacing.sm, top = 12.dp, bottom = 12.dp),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.inverseOnSurface,
                maxLines = 3,
            )
            if (actionLabel != null && onAction != null) {
                TextButton(onClick = onAction) {
                    Text(
                        actionLabel,
                        style = MaterialTheme.typography.labelLarge,
                        color = MaterialTheme.colorScheme.inversePrimary,
                    )
                }
            }
            IconButton(onClick = onDismiss) {
                Icon(
                    Icons.Default.Close,
                    contentDescription = "Dismiss error",
                    tint = MaterialTheme.colorScheme.inverseOnSurface,
                    modifier = Modifier.size(18.dp),
                )
            }
        }
    }
}
