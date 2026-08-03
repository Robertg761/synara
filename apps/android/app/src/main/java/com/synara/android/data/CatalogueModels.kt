package com.synara.android.data

import org.json.JSONObject

/**
 * A skill, slash command or subagent the current provider offers.
 *
 * The three server shapes differ only in which optional fields they carry, so one type covers all
 * three rather than three near-identical classes whose only real difference is the screen section
 * they land in.
 */
data class CatalogueEntry(
    val name: String,
    val description: String?,
    val path: String?,
    val scope: String?,
    val enabled: Boolean,
) {
    companion object {
        fun skill(json: JSONObject) = CatalogueEntry(
            name = json.stringOrNull("name") ?: "",
            description = json.stringOrNull("description"),
            path = json.stringOrNull("path"),
            scope = json.stringOrNull("scope"),
            enabled = json.optBoolean("enabled", true),
        )

        fun command(json: JSONObject) = CatalogueEntry(
            name = json.stringOrNull("name") ?: "",
            description = json.stringOrNull("description"),
            path = null,
            scope = null,
            enabled = true,
        )

        fun agent(json: JSONObject) = CatalogueEntry(
            name = json.stringOrNull("name") ?: json.stringOrNull("id") ?: "",
            description = json.stringOrNull("description"),
            path = json.stringOrNull("path"),
            scope = json.stringOrNull("scope") ?: json.stringOrNull("source"),
            enabled = json.optBoolean("enabled", true),
        )
    }
}

data class ProviderCatalogue(
    val skills: List<CatalogueEntry>,
    val commands: List<CatalogueEntry>,
    val agents: List<CatalogueEntry>,
) {
    val isEmpty: Boolean get() = skills.isEmpty() && commands.isEmpty() && agents.isEmpty()
    val total: Int get() = skills.size + commands.size + agents.size
}
