package com.synara.android.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Extension
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.synara.android.data.CatalogueEntry
import com.synara.android.data.SynaraUiState
import com.synara.android.data.SynaraViewModel
import com.synara.android.ui.components.EmptyState
import com.synara.android.ui.components.InlineNotice
import com.synara.android.ui.components.SectionLabel
import com.synara.android.ui.components.SynaraBadge
import com.synara.android.ui.components.SynaraDivider
import com.synara.android.ui.components.SynaraListRow
import com.synara.android.ui.theme.SynaraTheme

/**
 * What this thread's provider can actually do: its skills, slash commands and subagents.
 *
 * All three are per-provider *and* per-checkout — a skill in the repo's `.claude/skills` exists
 * only for a thread rooted there — so this is scoped to the open thread rather than presented as
 * global settings, which is how the desktop's plugins route can afford to frame it.
 */
@Composable
fun CatalogueScreen(state: SynaraUiState, viewModel: SynaraViewModel) {
    val catalogueState = state.catalogue
    val catalogue = catalogueState.catalogue

    Scaffold(
        containerColor = MaterialTheme.colorScheme.background,
        topBar = {
            SynaraTopBar(
                onBack = viewModel::closeCatalogue,
                title = "Skills & commands",
                subtitle = catalogueState.providerLabel,
            )
        },
    ) { padding ->
        Box(Modifier.fillMaxSize().padding(padding)) {
            when {
                catalogueState.isLoading -> Box(
                    Modifier.fillMaxSize(),
                    contentAlignment = Alignment.Center,
                ) {
                    CircularProgressIndicator(
                        Modifier.size(22.dp),
                        strokeWidth = 2.dp,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }

                catalogueState.error != null -> Box(Modifier.padding(SynaraTheme.spacing.screenGutter)) {
                    InlineNotice(catalogueState.error)
                }

                catalogue == null || catalogue.isEmpty -> Box(
                    Modifier.fillMaxSize(),
                    contentAlignment = Alignment.Center,
                ) {
                    EmptyState(
                        icon = Icons.Outlined.Extension,
                        title = "Nothing discovered",
                        body = "This provider reported no skills, commands or subagents for this checkout.",
                    )
                }

                else -> LazyColumn(
                    Modifier.fillMaxSize(),
                    contentPadding = PaddingValues(bottom = SynaraTheme.spacing.xxl),
                ) {
                    catalogueSection("Skills", catalogue.skills)
                    catalogueSection("Slash commands", catalogue.commands, prefix = "/")
                    catalogueSection("Subagents", catalogue.agents)
                }
            }
        }
    }
}

private fun androidx.compose.foundation.lazy.LazyListScope.catalogueSection(
    title: String,
    entries: List<CatalogueEntry>,
    prefix: String = "",
) {
    if (entries.isEmpty()) return
    item("$title-label") {
        SectionLabel(
            "$title · ${entries.size}",
            Modifier.padding(
                start = SynaraTheme.spacing.screenGutter,
                end = SynaraTheme.spacing.screenGutter,
                top = SynaraTheme.spacing.lg,
                bottom = SynaraTheme.spacing.xs,
            ),
        )
    }
    items(entries, key = { "$title-${it.name}" }) { entry ->
        CatalogueRow(entry, prefix)
        SynaraDivider(startIndent = SynaraTheme.spacing.screenGutter)
    }
}

@Composable
private fun CatalogueRow(entry: CatalogueEntry, prefix: String) {
    SynaraListRow(verticalPadding = SynaraTheme.spacing.md) {
        Row(
            Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(SynaraTheme.spacing.sm),
        ) {
            Text(
                "$prefix${entry.name}",
                Modifier.weight(1f),
                style = SynaraTheme.textStyles.mono,
                color = if (entry.enabled) {
                    MaterialTheme.colorScheme.onSurface
                } else {
                    MaterialTheme.colorScheme.onSurfaceVariant
                },
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            // Scope distinguishes a repo-local skill from a globally installed one, which is the
            // difference between "this project has it" and "every project does".
            entry.scope?.let { SynaraBadge(it) }
            if (!entry.enabled) {
                SynaraBadge(
                    "off",
                    container = SynaraTheme.accents.mutedSurface,
                    contentColor = MaterialTheme.colorScheme.outline,
                )
            }
        }
        entry.description?.takeIf { it.isNotBlank() }?.let {
            Text(
                it,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 3,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}
