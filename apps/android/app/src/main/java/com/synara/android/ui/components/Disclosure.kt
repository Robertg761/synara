package com.synara.android.ui.components

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import com.synara.android.ui.theme.SynaraTheme
import com.synara.android.ui.theme.disclosureEnter
import com.synara.android.ui.theme.disclosureExit
import com.synara.android.ui.theme.synaraTween

/**
 * Every expand/collapse in the app goes through here.
 *
 * This is the Android counterpart of the project's standing UI rule for the web client: toggles
 * must reuse one shared disclosure motion (220ms ease-out with a reduce-motion fallback) rather
 * than each growing its own height/opacity animation, so no two disclosures feel different. The
 * timing and easing come from `SynaraMotion`, which mirrors `apps/web/src/lib/disclosureMotion.ts`.
 */
@Composable
fun DisclosureSection(
    title: String,
    modifier: Modifier = Modifier,
    initiallyExpanded: Boolean = false,
    trailingSummary: String? = null,
    content: @Composable ColumnScope.() -> Unit,
) {
    var expanded by rememberSaveable(title) { mutableStateOf(initiallyExpanded) }
    val rotation by animateFloatAsState(
        targetValue = if (expanded) 180f else 0f,
        animationSpec = synaraTween(),
        label = "disclosure-chevron",
    )

    Column(modifier.fillMaxWidth()) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .clickable(role = Role.Button) { expanded = !expanded }
                .padding(vertical = SynaraTheme.spacing.sm),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(SynaraTheme.spacing.sm),
        ) {
            Text(
                title,
                style = MaterialTheme.typography.labelLarge,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            if (trailingSummary != null) {
                Text(
                    trailingSummary,
                    modifier = Modifier.weight(1f),
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.outline,
                )
            } else {
                androidx.compose.foundation.layout.Spacer(Modifier.weight(1f))
            }
            Icon(
                Icons.Default.KeyboardArrowDown,
                contentDescription = if (expanded) "Collapse $title" else "Expand $title",
                modifier = Modifier.size(18.dp).rotate(rotation),
                tint = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        AnimatedVisibility(visible = expanded, enter = disclosureEnter(), exit = disclosureExit()) {
            Column(
                Modifier.padding(bottom = SynaraTheme.spacing.sm),
                verticalArrangement = Arrangement.spacedBy(SynaraTheme.spacing.sm),
                content = content,
            )
        }
    }
}
