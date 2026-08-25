package com.synara.android.data

/**
 * A minimal terminal emulator: enough of one to render a PTY stream faithfully on a phone.
 *
 * `terminal.output` events carry raw PTY bytes, not display text. Appending them straight to a
 * text view produces garbage — every colour is a literal `ESC[32m`, every progress bar redraw
 * stacks up instead of overwriting, and a `clear` leaves the old screen in place. So this
 * interprets the parts that decide what a line *looks like*: SGR styling, carriage return,
 * backspace, erase-in-line and erase-in-display.
 *
 * It is deliberately not a full VT: no cursor addressing, no alternate screen, no scroll regions.
 * A full-screen TUI will not render correctly, and that is an accepted limit — the phone terminal
 * exists for running commands and reading their output, which is line-oriented. Sequences that are
 * not understood are consumed and dropped rather than printed, so unsupported output degrades to
 * plain text instead of escape-code noise.
 */
class AnsiTerminalBuffer(private val maxLines: Int = 2_000) {
    /** One styled run of text. */
    data class Span(
        val text: String,
        val foreground: Int? = null,
        val background: Int? = null,
        val bold: Boolean = false,
        val dim: Boolean = false,
        val italic: Boolean = false,
        val underline: Boolean = false,
    )

    data class Line(val spans: List<Span>) {
        val text: String get() = spans.joinToString("") { it.text }
    }

    private data class Style(
        val foreground: Int? = null,
        val background: Int? = null,
        val bold: Boolean = false,
        val dim: Boolean = false,
        val italic: Boolean = false,
        val underline: Boolean = false,
        val inverse: Boolean = false,
    )

    private data class Cell(val char: Char, val style: Style)

    private val completed = ArrayDeque<List<Cell>>()
    private var current = mutableListOf<Cell>()
    private var column = 0
    private var style = Style()
    /** Carry for an escape sequence split across two output events. */
    private var pending = StringBuilder()

    /** Total lines currently held, including the one being written. */
    val lineCount: Int get() = completed.size + 1

    fun clear() {
        completed.clear()
        current = mutableListOf()
        column = 0
        pending.setLength(0)
    }

    fun append(chunk: String) {
        val input = if (pending.isEmpty()) {
            chunk
        } else {
            // A previous chunk ended mid-escape; re-parse it together with this one.
            val combined = pending.toString() + chunk
            pending.setLength(0)
            combined
        }

        var index = 0
        while (index < input.length) {
            when (val ch = input[index]) {
                '\u001B' -> {
                    val consumed = parseEscape(input, index)
                    if (consumed == INCOMPLETE) {
                        // Hold the partial sequence; the rest arrives in the next event.
                        pending.append(input, index, input.length)
                        return
                    }
                    index += consumed
                }

                '\n' -> {
                    newline()
                    index++
                }

                '\r' -> {
                    column = 0
                    index++
                }

                '\b' -> {
                    if (column > 0) column--
                    index++
                }

                '\t' -> {
                    // Tabs land on the next 8-column stop, which is what shells assume when they
                    // align columns with tabs rather than spaces.
                    val next = ((column / 8) + 1) * 8
                    repeat(next - column) { write(' ') }
                    index++
                }

                '\u0007' -> index++ // bell

                // Printable characters land in the buffer; any other C0 control byte is dropped
                // rather than drawn as a placeholder glyph.
                else -> {
                    if (ch.code >= 32) write(ch)
                    index++
                }
            }
        }
    }

    fun lines(): List<Line> = buildList(completed.size + 1) {
        completed.forEach { add(toLine(it)) }
        add(toLine(current))
    }

    // ── internals ────────────────────────────────────────────────────────────────────────────

    private fun write(ch: Char) {
        val cell = Cell(ch, style)
        if (column < current.size) {
            current[column] = cell
        } else {
            while (current.size < column) current.add(Cell(' ', Style()))
            current.add(cell)
        }
        column++
    }

    private fun newline() {
        completed.addLast(current)
        // Scrollback is bounded: a build log can emit hundreds of thousands of lines, and holding
        // them all would grow without limit on a device that cannot spare it.
        while (completed.size > maxLines) completed.removeFirst()
        current = mutableListOf()
        column = 0
    }

    private fun toLine(cells: List<Cell>): Line {
        if (cells.isEmpty()) return Line(listOf(Span("")))
        val spans = mutableListOf<Span>()
        val text = StringBuilder()
        var runStyle = cells.first().style
        for (cell in cells) {
            if (cell.style != runStyle) {
                spans += span(text.toString(), runStyle)
                text.setLength(0)
                runStyle = cell.style
            }
            text.append(cell.char)
        }
        spans += span(text.toString(), runStyle)
        return Line(spans)
    }

    private fun span(text: String, style: Style): Span {
        // Inverse swaps the pair at render time rather than at parse time, so a later reset still
        // restores the original colours.
        val foreground = if (style.inverse) style.background ?: DEFAULT_BACKGROUND else style.foreground
        val background = if (style.inverse) style.foreground ?: DEFAULT_FOREGROUND else style.background
        return Span(
            text = text,
            foreground = foreground,
            background = background,
            bold = style.bold,
            dim = style.dim,
            italic = style.italic,
            underline = style.underline,
        )
    }

    /** Returns the number of characters consumed, or [INCOMPLETE] if the sequence is truncated. */
    private fun parseEscape(input: String, start: Int): Int {
        if (start + 1 >= input.length) return INCOMPLETE
        return when (input[start + 1]) {
            '[' -> parseCsi(input, start)
            ']' -> parseOsc(input, start)
            // Two-character sequences (ESC c, ESC 7, ESC =, …) carry no display meaning here.
            else -> 2
        }
    }

    private fun parseCsi(input: String, start: Int): Int {
        var index = start + 2
        val params = StringBuilder()
        while (index < input.length) {
            val ch = input[index]
            if (ch in '@'..'~') {
                applyCsi(ch, params.toString())
                return index - start + 1
            }
            params.append(ch)
            index++
        }
        return INCOMPLETE
    }

    private fun parseOsc(input: String, start: Int): Int {
        // OSC runs until BEL or ST (ESC \). These set window titles and similar; nothing to draw.
        var index = start + 2
        while (index < input.length) {
            if (input[index] == '\u0007') return index - start + 1
            if (input[index] == '\u001B' && index + 1 < input.length && input[index + 1] == '\\') {
                return index - start + 2
            }
            index++
        }
        return INCOMPLETE
    }

    private fun applyCsi(final: Char, params: String) {
        when (final) {
            'm' -> applySgr(params)
            'K' -> when (params.trim().ifEmpty { "0" }) {
                // Erase to end of line is how a shell repaints a prompt over a longer previous one.
                "0" -> if (column < current.size) current.subList(column, current.size).clear()
                "1" -> for (i in 0 until minOf(column, current.size)) current[i] = Cell(' ', Style())
                "2" -> current.clear().also { column = 0 }
            }

            'J' -> when (params.trim().ifEmpty { "0" }) {
                "2", "3" -> clear()
                else -> if (column < current.size) current.subList(column, current.size).clear()
            }

            'C' -> column += params.toIntOrNull() ?: 1
            'D' -> column = (column - (params.toIntOrNull() ?: 1)).coerceAtLeast(0)
            'G' -> column = ((params.toIntOrNull() ?: 1) - 1).coerceAtLeast(0)
            else -> Unit
        }
    }

    private fun applySgr(params: String) {
        val codes = params.split(';').map { it.trim() }
        var index = 0
        while (index < codes.size) {
            when (val code = codes[index].toIntOrNull() ?: 0) {
                0 -> style = Style()
                1 -> style = style.copy(bold = true)
                2 -> style = style.copy(dim = true)
                3 -> style = style.copy(italic = true)
                4 -> style = style.copy(underline = true)
                7 -> style = style.copy(inverse = true)
                22 -> style = style.copy(bold = false, dim = false)
                23 -> style = style.copy(italic = false)
                24 -> style = style.copy(underline = false)
                27 -> style = style.copy(inverse = false)
                39 -> style = style.copy(foreground = null)
                49 -> style = style.copy(background = null)
                in 30..37 -> style = style.copy(foreground = PALETTE[code - 30])
                in 90..97 -> style = style.copy(foreground = PALETTE[code - 90 + 8])
                in 40..47 -> style = style.copy(background = PALETTE[code - 40])
                in 100..107 -> style = style.copy(background = PALETTE[code - 100 + 8])
                38, 48 -> {
                    val extended = readExtendedColor(codes, index)
                    if (extended != null) {
                        style = if (code == 38) {
                            style.copy(foreground = extended.first)
                        } else {
                            style.copy(background = extended.first)
                        }
                        index += extended.second
                    }
                }
            }
            index++
        }
    }

    /** `38;5;N` (256-colour) and `38;2;R;G;B` (truecolour); returns the colour and codes consumed. */
    private fun readExtendedColor(codes: List<String>, index: Int): Pair<Int, Int>? {
        return when (codes.getOrNull(index + 1)?.toIntOrNull()) {
            5 -> codes.getOrNull(index + 2)?.toIntOrNull()?.let { xterm256(it) to 2 }
            2 -> {
                val r = codes.getOrNull(index + 2)?.toIntOrNull() ?: return null
                val g = codes.getOrNull(index + 3)?.toIntOrNull() ?: return null
                val b = codes.getOrNull(index + 4)?.toIntOrNull() ?: return null
                (0xFF shl 24 or (r shl 16) or (g shl 8) or b) to 4
            }

            else -> null
        }
    }

    private fun xterm256(value: Int): Int = when {
        value < 16 -> PALETTE[value]
        value < 232 -> {
            val n = value - 16
            val r = CUBE[n / 36]
            val g = CUBE[(n / 6) % 6]
            val b = CUBE[n % 6]
            0xFF shl 24 or (r shl 16) or (g shl 8) or b
        }

        else -> {
            val grey = 8 + (value - 232) * 10
            0xFF shl 24 or (grey shl 16) or (grey shl 8) or grey
        }
    }

    private companion object {
        const val INCOMPLETE = -1
        const val DEFAULT_FOREGROUND = 0xFFE5E5E5.toInt()
        const val DEFAULT_BACKGROUND = 0xFF0E0E0E.toInt()
        val CUBE = intArrayOf(0, 95, 135, 175, 215, 255)

        /**
         * The 16 ANSI colours. Tuned against the app's near-black terminal surface rather than
         * taken from the classic VGA set, whose blue is unreadable at 12sp on a phone.
         */
        val PALETTE = intArrayOf(
            0xFF4A4A4A.toInt(), // black (lifted so it stays visible on a dark surface)
            0xFFFB4B54.toInt(), // red
            0xFF3FD08A.toInt(), // green
            0xFFE3B341.toInt(), // yellow
            0xFF62A0FF.toInt(), // blue
            0xFFC77DFF.toInt(), // magenta
            0xFF4FD3D3.toInt(), // cyan
            0xFFD4D4D4.toInt(), // white
            0xFF6E6E6E.toInt(), // bright black
            0xFFFF7B72.toInt(),
            0xFF56D364.toInt(),
            0xFFF2CC60.toInt(),
            0xFF79B8FF.toInt(),
            0xFFD2A8FF.toInt(),
            0xFF76E3EA.toInt(),
            0xFFFFFFFF.toInt(),
        )
    }
}
