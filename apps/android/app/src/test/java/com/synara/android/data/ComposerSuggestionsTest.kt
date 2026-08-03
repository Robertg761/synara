package com.synara.android.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ComposerSuggestionsTest {
    private fun entry(name: String) = CatalogueEntry(name, null, null, null, true)

    private val catalogue = ProviderCatalogue(
        skills = listOf(entry("dataviz"), entry("diff-review"), entry("react-doctor")),
        commands = listOf(entry("review"), entry("init"), entry("resume")),
        agents = emptyList(),
    )

    @Test
    fun `a slash at the start offers commands`() {
        val result = composerSuggestionsFor("/re", 3, catalogue)!!
        assertEquals(SuggestionKind.COMMAND, result.kind)
        assertEquals(listOf("review", "resume"), result.entries.map { it.name })
    }

    @Test
    fun `a slash mid-draft is not a command`() {
        // Otherwise every pasted URL path would open the command menu.
        assertNull(composerSuggestionsFor("see https://x/re", 16, catalogue))
    }

    @Test
    fun `an at-sign offers skills anywhere in the draft`() {
        val result = composerSuggestionsFor("please run @dat", 15, catalogue)!!
        assertEquals(SuggestionKind.SKILL, result.kind)
        assertEquals(listOf("dataviz"), result.entries.map { it.name })
    }

    @Test
    fun `prefix matches rank above substring matches`() {
        // "di" should mean diff-review, not dataviz, even though both contain the letters.
        val result = composerSuggestionsFor("@di", 3, catalogue)!!
        assertEquals("diff-review", result.entries.first().name)
    }

    @Test
    fun `a completed token stops triggering once a space is typed`() {
        assertNull(composerSuggestionsFor("@dataviz ", 9, catalogue))
    }

    @Test
    fun `no suggestions when nothing matches`() {
        assertNull(composerSuggestionsFor("@zzzz", 5, catalogue))
    }

    @Test
    fun `no suggestions without a catalogue`() {
        assertNull(composerSuggestionsFor("/re", 3, null))
    }

    @Test
    fun `accepting a command replaces the token and leaves a trailing space`() {
        val suggestion = composerSuggestionsFor("/re", 3, catalogue)!!
        val (draft, caret) = applySuggestion("/re", suggestion, entry("review"))
        assertEquals("/review ", draft)
        assertEquals(8, caret)
    }

    @Test
    fun `accepting a mention replaces only the mention token`() {
        val suggestion = composerSuggestionsFor("please run @dat and stop", 15, catalogue)!!
        val (draft, caret) = applySuggestion("please run @dat and stop", suggestion, entry("dataviz"))
        assertEquals("please run @dataviz  and stop", draft)
        assertEquals(20, caret)
    }

    @Test
    fun `caret before the trigger does not match a later token`() {
        // The caret is inside "run", not the mention that follows it.
        assertNull(composerSuggestionsFor("run @dataviz", 3, catalogue))
    }
}
