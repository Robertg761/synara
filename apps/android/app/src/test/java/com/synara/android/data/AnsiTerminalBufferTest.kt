package com.synara.android.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

private const val ESC = "\u001B"

class AnsiTerminalBufferTest {
    private fun text(buffer: AnsiTerminalBuffer): List<String> = buffer.lines().map { it.text }

    @Test
    fun `plain output splits on newlines`() {
        val buffer = AnsiTerminalBuffer()
        buffer.append("one\ntwo\nthree")
        assertEquals(listOf("one", "two", "three"), text(buffer))
    }

    @Test
    fun `carriage return overwrites the current line`() {
        // This is how every progress bar and spinner redraws. Without it the buffer would stack
        // one line per frame instead of replacing.
        val buffer = AnsiTerminalBuffer()
        buffer.append("Downloading 10%\rDownloading 90%")
        assertEquals(listOf("Downloading 90%"), text(buffer))
    }

    @Test
    fun `carriage return leaves the tail of a longer previous line`() {
        // Real terminals behave this way; the shell is expected to emit ESC[K to clear the rest.
        val buffer = AnsiTerminalBuffer()
        buffer.append("aaaaaaaaaa\rbbb")
        assertEquals(listOf("bbbaaaaaaa"), text(buffer))
    }

    @Test
    fun `erase to end of line clears the leftover tail`() {
        val buffer = AnsiTerminalBuffer()
        buffer.append("aaaaaaaaaa\rbbb$ESC[K")
        assertEquals(listOf("bbb"), text(buffer))
    }

    @Test
    fun `backspace moves the cursor back so the next write overwrites`() {
        val buffer = AnsiTerminalBuffer()
        buffer.append("abc\b\bXY")
        assertEquals(listOf("aXY"), text(buffer))
    }

    @Test
    fun `sgr colour applies to the following run only`() {
        val buffer = AnsiTerminalBuffer()
        buffer.append("plain${ESC}[31mred${ESC}[0mplain")
        val spans = buffer.lines().single().spans.filter { it.text.isNotEmpty() }
        assertEquals(listOf("plain", "red", "plain"), spans.map { it.text })
        assertNull(spans[0].foreground)
        assertEquals(AnsiTerminalBuffer.Span("", foreground = null).foreground, spans[2].foreground)
        assertTrue(spans[1].foreground != null)
    }

    @Test
    fun `bold and dim are tracked and reset`() {
        val buffer = AnsiTerminalBuffer()
        buffer.append("${ESC}[1mbold${ESC}[22mnormal")
        val spans = buffer.lines().single().spans.filter { it.text.isNotEmpty() }
        assertTrue(spans[0].bold)
        assertTrue(!spans[1].bold)
    }

    @Test
    fun `truecolor and 256 colour sequences are parsed`() {
        val buffer = AnsiTerminalBuffer()
        buffer.append("${ESC}[38;2;255;0;0mtrue${ESC}[0m${ESC}[38;5;33mindexed")
        val spans = buffer.lines().single().spans.filter { it.text.isNotEmpty() }
        assertEquals(0xFFFF0000.toInt(), spans[0].foreground)
        assertTrue(spans[1].foreground != null)
    }

    @Test
    fun `escape sequence split across two chunks is still understood`() {
        // Output arrives in whatever sizes the PTY flushes, so a sequence can straddle two events.
        // Printing the fragment instead of buffering it would leak "[31m" into the transcript.
        val buffer = AnsiTerminalBuffer()
        buffer.append("before${ESC}[3")
        buffer.append("1mred")
        val spans = buffer.lines().single().spans.filter { it.text.isNotEmpty() }
        assertEquals(listOf("before", "red"), spans.map { it.text })
        assertTrue(spans[1].foreground != null)
    }

    @Test
    fun `osc title sequences are consumed rather than printed`() {
        val buffer = AnsiTerminalBuffer()
        buffer.append("$ESC]0;my title\u0007prompt$ ")
        assertEquals(listOf("prompt$ "), text(buffer))
    }

    @Test
    fun `unknown csi sequences are dropped instead of rendered`() {
        val buffer = AnsiTerminalBuffer()
        buffer.append("${ESC}[?25lhidden cursor${ESC}[?25h")
        assertEquals(listOf("hidden cursor"), text(buffer))
    }

    @Test
    fun `clear screen empties the buffer`() {
        val buffer = AnsiTerminalBuffer()
        buffer.append("old output\nmore\n")
        buffer.append("${ESC}[2Jfresh")
        assertEquals(listOf("fresh"), text(buffer))
    }

    @Test
    fun `tabs advance to the next eight column stop`() {
        val buffer = AnsiTerminalBuffer()
        buffer.append("ab\tc")
        assertEquals(listOf("ab      c"), text(buffer))
    }

    @Test
    fun `scrollback is bounded`() {
        val buffer = AnsiTerminalBuffer(maxLines = 10)
        repeat(100) { buffer.append("line $it\n") }
        assertEquals(11, buffer.lineCount)
        assertEquals("line 99", buffer.lines()[buffer.lines().lastIndex - 1].text)
    }

    @Test
    fun `control bytes are dropped rather than drawn`() {
        val buffer = AnsiTerminalBuffer()
        buffer.append("a\u0000b\u0001c")
        assertEquals(listOf("abc"), text(buffer))
    }
}
