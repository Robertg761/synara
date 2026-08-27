package com.synara.android.data

/**
 * What the composer should offer for the text currently typed.
 *
 * The desktop composer resolves slash commands and skill mentions as you type. Doing the same here
 * needs one decision made carefully: *which* token the caret is in. Matching anywhere in the draft
 * would keep a menu open for a `/` typed three sentences ago, and matching only at position zero
 * would refuse to complete a mention mid-sentence, which is where mentions normally appear.
 */
enum class SuggestionKind { COMMAND, SKILL }

data class ComposerSuggestions(
    val kind: SuggestionKind,
    val query: String,
    val entries: List<CatalogueEntry>,
    /** Range of the trigger token in the draft, replaced when a suggestion is accepted. */
    val start: Int,
    val end: Int,
)

/**
 * A slash command only counts at the very start of the draft — that is where a shell-style
 * command belongs, and it stops every URL path in a pasted link from opening a menu. A skill
 * mention counts anywhere, as long as the `@` begins a word.
 */
fun composerSuggestionsFor(
    draft: String,
    caret: Int,
    catalogue: ProviderCatalogue?,
): ComposerSuggestions? {
    if (catalogue == null) return null
    val position = caret.coerceIn(0, draft.length)

    val tokenStart = draft.lastIndexOfAny(charArrayOf(' ', '\n', '\t'), position - 1) + 1
    if (tokenStart > position) return null
    val token = draft.substring(tokenStart, position)
    if (token.length < 1) return null
    // A trigger only applies while the token is still one word; a space ends it.
    if (token.any { it.isWhitespace() }) return null

    return when {
        token.startsWith("/") && tokenStart == 0 -> {
            val query = token.drop(1)
            ComposerSuggestions(
                kind = SuggestionKind.COMMAND,
                query = query,
                entries = catalogue.commands.matching(query),
                start = tokenStart,
                end = position,
            )
        }

        token.startsWith("@") -> {
            val query = token.drop(1)
            ComposerSuggestions(
                kind = SuggestionKind.SKILL,
                query = query,
                entries = catalogue.skills.matching(query),
                start = tokenStart,
                end = position,
            )
        }

        else -> null
    }?.takeIf { it.entries.isNotEmpty() }
}

/**
 * Prefix matches lead, then substring matches. Ranking a substring hit above a prefix hit would
 * put `dataviz` ahead of `diff` for the query "di", which is not what anyone typing that means.
 */
private fun List<CatalogueEntry>.matching(query: String): List<CatalogueEntry> {
    if (query.isEmpty()) return take(SUGGESTION_LIMIT)
    val lower = query.lowercase()
    val prefix = filter { it.name.lowercase().startsWith(lower) }
    val contains = filter { it.name.lowercase().contains(lower) && it !in prefix }
    return (prefix + contains).take(SUGGESTION_LIMIT)
}

/** Applies a chosen suggestion, returning the new draft and the caret position after it. */
fun applySuggestion(
    draft: String,
    suggestion: ComposerSuggestions,
    entry: CatalogueEntry,
): Pair<String, Int> {
    val prefix = if (suggestion.kind == SuggestionKind.COMMAND) "/" else "@"
    // A trailing space is added so the next word does not re-trigger the same menu.
    val replacement = "$prefix${entry.name} "
    val updated = draft.replaceRange(suggestion.start, suggestion.end, replacement)
    return updated to (suggestion.start + replacement.length)
}

private const val SUGGESTION_LIMIT = 8
