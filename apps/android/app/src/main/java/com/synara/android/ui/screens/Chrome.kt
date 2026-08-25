package com.synara.android.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.outlined.Home
import androidx.compose.material.icons.outlined.Settings
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.NavigationBarItemDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.synara.android.data.AppScreen
import com.synara.android.ui.components.SynaraDivider
import com.synara.android.ui.theme.SynaraTheme

/**
 * Shared top bar. Deliberately hand-rolled instead of Material's `TopAppBar`: that component
 * enforces a 64dp block with a fixed title slot, and every screen here needs a two-line title
 * (thread name over provider · model) or a custom leading element (the wordmark).
 */
@Composable
fun SynaraTopBar(
    modifier: Modifier = Modifier,
    onBack: (() -> Unit)? = null,
    leading: (@Composable () -> Unit)? = null,
    title: String? = null,
    subtitle: String? = null,
    actions: (@Composable () -> Unit)? = null,
) {
    Column(modifier.fillMaxWidth().background(MaterialTheme.colorScheme.background)) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .statusBarsPadding()
                .heightIn(min = 56.dp)
                .padding(
                    start = if (onBack != null) SynaraTheme.spacing.xs else SynaraTheme.spacing.screenGutter,
                    end = SynaraTheme.spacing.xs,
                ),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (onBack != null) {
                IconButton(onClick = onBack) {
                    Icon(
                        Icons.AutoMirrored.Outlined.ArrowBack,
                        contentDescription = "Back",
                        tint = MaterialTheme.colorScheme.onSurface,
                    )
                }
            }
            if (leading != null) {
                leading()
            }
            if (title != null) {
                Column(Modifier.weight(1f).padding(end = SynaraTheme.spacing.sm)) {
                    Text(
                        title,
                        style = MaterialTheme.typography.titleMedium,
                        color = MaterialTheme.colorScheme.onSurface,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                    if (subtitle != null) {
                        Text(
                            subtitle,
                            style = MaterialTheme.typography.labelMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                }
            } else {
                androidx.compose.foundation.layout.Spacer(Modifier.weight(1f))
            }
            if (actions != null) {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(SynaraTheme.spacing.xxs),
                ) { actions() }
            }
        }
    }
}

/**
 * Bottom navigation on the app's plain background with a hairline above it, rather than Material's
 * raised surface. The neutral palette has no tonal step to spare for a floating bar, so the
 * hairline is what separates it from the list scrolling underneath.
 */
@Composable
fun SynaraBottomNav(
    current: AppScreen,
    onWorkspace: () -> Unit,
    onSettings: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(modifier.fillMaxWidth()) {
        SynaraDivider()
        NavigationBar(
            containerColor = MaterialTheme.colorScheme.background,
            tonalElevation = 0.dp,
        ) {
            NavigationBarItem(
                selected = current == AppScreen.WORKSPACE,
                onClick = onWorkspace,
                icon = { Icon(Icons.Outlined.Home, contentDescription = null, modifier = Modifier.size(22.dp)) },
                label = { Text("Workspace", style = MaterialTheme.typography.labelMedium) },
                colors = navItemColors(),
            )
            NavigationBarItem(
                selected = current == AppScreen.SETTINGS,
                onClick = onSettings,
                icon = { Icon(Icons.Outlined.Settings, contentDescription = null, modifier = Modifier.size(22.dp)) },
                label = { Text("Settings", style = MaterialTheme.typography.labelMedium) },
                colors = navItemColors(),
            )
        }
    }
}

@Composable
private fun navItemColors() = NavigationBarItemDefaults.colors(
    selectedIconColor = MaterialTheme.colorScheme.onSurface,
    selectedTextColor = MaterialTheme.colorScheme.onSurface,
    unselectedIconColor = MaterialTheme.colorScheme.onSurfaceVariant,
    unselectedTextColor = MaterialTheme.colorScheme.onSurfaceVariant,
    indicatorColor = MaterialTheme.colorScheme.secondaryContainer,
)
