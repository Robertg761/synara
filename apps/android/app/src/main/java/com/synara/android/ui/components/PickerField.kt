package com.synara.android.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Check
import androidx.compose.material.icons.outlined.UnfoldMore
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.synara.android.ui.theme.SynaraTheme

/** One optionally-titled run of choices inside a [PickerField] menu. */
data class PickerSection<T>(val label: String?, val items: List<T>)

/**
 * The labelled "current value, tap to change" control the form dialogs use.
 *
 * Both the model and project choices need the same thing — a two-line summary of what is selected
 * plus a grouped menu — so the behaviour lives here once. Anything that has to be chosen from a
 * list in a dialog should reuse this rather than growing another dropdown.
 *
 * The summary is two lines on purpose: models repeat across providers and projects repeat across
 * checkouts, so the qualifier ([supportingText]) has to be readable without reopening the menu.
 */
@Composable
fun <T> PickerField(
    label: String,
    sections: List<PickerSection<T>>,
    selected: T?,
    placeholder: String,
    emptyLabel: String,
    primaryText: (T) -> String,
    isSelected: (T) -> Boolean,
    onSelected: (T) -> Unit,
    modifier: Modifier = Modifier,
    supportingText: (T) -> String? = { null },
    itemSupportingText: (T) -> String? = supportingText,
) {
    var expanded by remember { mutableStateOf(false) }
    val shape = MaterialTheme.shapes.medium
    val density = LocalDensity.current
    // A dropdown sizes itself to its widest item, which on a phone means a menu that is narrower
    // than the control it belongs to and floats over unrelated fields. Matching the trigger keeps
    // the menu reading as the field opening up, and gives long project paths the room they need.
    var triggerWidth by remember { mutableStateOf(0.dp) }

    Column(modifier, verticalArrangement = Arrangement.spacedBy(SynaraTheme.spacing.xs)) {
        Text(
            label,
            style = MaterialTheme.typography.labelLarge,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Box {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .onSizeChanged { triggerWidth = with(density) { it.width.toDp() } }
                    .background(SynaraTheme.accents.inputSurface, shape)
                    .border(1.dp, MaterialTheme.colorScheme.outlineVariant, shape)
                    .clickable { expanded = true }
                    .padding(horizontal = SynaraTheme.spacing.md, vertical = 14.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column(Modifier.weight(1f)) {
                    Text(
                        selected?.let(primaryText) ?: placeholder,
                        style = MaterialTheme.typography.bodyMedium,
                        color = if (selected == null) {
                            MaterialTheme.colorScheme.onSurfaceVariant
                        } else {
                            MaterialTheme.colorScheme.onSurface
                        },
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                    selected?.let(supportingText)?.let {
                        Text(
                            it,
                            style = MaterialTheme.typography.labelMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                }
                Icon(
                    Icons.Outlined.UnfoldMore,
                    contentDescription = label,
                    modifier = Modifier.size(18.dp),
                    tint = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            DropdownMenu(
                expanded = expanded,
                onDismissRequest = { expanded = false },
                modifier = Modifier
                    // Before the first layout pass there is nothing to match, so fall back to the
                    // menu's own intrinsic width rather than collapsing it to zero.
                    .then(if (triggerWidth > Dp.Hairline) Modifier.width(triggerWidth) else Modifier)
                    .background(MaterialTheme.colorScheme.surfaceContainerHigh)
                    .heightIn(max = 320.dp),
            ) {
                if (sections.all { it.items.isEmpty() }) {
                    DropdownMenuItem(
                        text = {
                            Text(
                                emptyLabel,
                                style = MaterialTheme.typography.bodyMedium,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        },
                        onClick = { expanded = false },
                    )
                } else {
                    sections.filter { it.items.isNotEmpty() }.forEach { section ->
                        section.label?.let { heading ->
                            Text(
                                heading,
                                modifier = Modifier.padding(
                                    start = SynaraTheme.spacing.md,
                                    end = SynaraTheme.spacing.md,
                                    top = SynaraTheme.spacing.sm,
                                    bottom = SynaraTheme.spacing.xxs,
                                ),
                                style = MaterialTheme.typography.labelMedium,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                        section.items.forEach { item ->
                            DropdownMenuItem(
                                text = {
                                    Column {
                                        Text(
                                            primaryText(item),
                                            style = MaterialTheme.typography.bodyMedium,
                                            color = MaterialTheme.colorScheme.onSurface,
                                        )
                                        itemSupportingText(item)?.let {
                                            Text(
                                                it,
                                                style = MaterialTheme.typography.bodySmall,
                                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                                maxLines = 2,
                                                overflow = TextOverflow.Ellipsis,
                                            )
                                        }
                                    }
                                },
                                trailingIcon = if (isSelected(item)) {
                                    {
                                        Icon(
                                            Icons.Outlined.Check,
                                            contentDescription = null,
                                            modifier = Modifier.size(16.dp),
                                            tint = MaterialTheme.colorScheme.onSurface,
                                        )
                                    }
                                } else {
                                    null
                                },
                                onClick = {
                                    onSelected(item)
                                    expanded = false
                                },
                            )
                        }
                    }
                }
            }
        }
    }
}
