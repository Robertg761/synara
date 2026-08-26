package com.synara.android.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.size
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.synara.android.ui.theme.SynaraTheme

/**
 * The wordmark. Neutral by construction: the mark takes `--primary` (near-black in light,
 * near-white in dark) exactly as the web header does, so the brand reads as the same product on
 * both clients and no chromatic accent is spent on chrome.
 */
@Composable
fun SynaraWordmark(
    modifier: Modifier = Modifier,
    compact: Boolean = false,
    showName: Boolean = true,
) {
    val markSize = if (compact) 22.dp else 28.dp
    Row(
        modifier = modifier.clearAndSetSemantics { contentDescription = "Synara" },
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(SynaraTheme.spacing.sm),
    ) {
        Box(
            Modifier
                .size(markSize)
                .background(MaterialTheme.colorScheme.primary, MaterialTheme.shapes.extraSmall),
            contentAlignment = Alignment.Center,
        ) {
            Text(
                "S",
                color = MaterialTheme.colorScheme.onPrimary,
                style = MaterialTheme.typography.titleMedium,
                fontSize = if (compact) 13.sp else 16.sp,
            )
        }
        if (showName) {
            Text(
                "Synara",
                style = if (compact) {
                    MaterialTheme.typography.titleMedium
                } else {
                    MaterialTheme.typography.titleLarge
                },
                color = MaterialTheme.colorScheme.onBackground,
            )
        }
    }
}
