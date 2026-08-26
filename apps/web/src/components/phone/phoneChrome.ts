// FILE: phoneChrome.ts
// Purpose: Class tokens shared by the phone chrome, so two surfaces can never drift into
//          almost-identical geometry.
// Layer: Phone layout tokens (no runtime logic, no React)
// Exports: PHONE_HEADER_ICON_BUTTON_CLASS

/**
 * The phone header's icon-button size: a 44px (`size-11`) hit target with a 20px glyph, which is
 * the minimum comfortable touch target — the desktop `size-icon` box is far below it. `!` because
 * `IconButton`'s own size variant would otherwise win the cascade.
 *
 * Used by every top-level phone header control (the chat back chevron, the pane screen's close
 * button); import it rather than restating the utilities, so the two stay the same target.
 */
export const PHONE_HEADER_ICON_BUTTON_CLASS = "!size-11 rounded-xl [&_svg]:!size-5";
