// Native Back uses the same Escape behavior as the desktop popup components.
const POPUP_SELECTOR =
  '[role="dialog"],[role="alertdialog"],[role="menu"],[role="listbox"],[data-slot="popover-popup"]';

export function dismissMobileOverlay(document: Document): boolean {
  const popups = Array.from(document.querySelectorAll<HTMLElement>(POPUP_SELECTOR))
    .filter((element) =>
      element.getClientRects().length > 0 &&
      !element.closest('[inert],[aria-hidden="true"],[data-closed],[data-ending-style]'),
    );
  const popup = popups.at(-1);
  if (!popup) return false;
  const focused = document.activeElement;
  const target = focused && popup.contains(focused) ? focused : popup;
  target.dispatchEvent(new KeyboardEvent("keydown", {
    key: "Escape", code: "Escape", bubbles: true, cancelable: true,
  }));
  // Even a non-dismissible approval modal owns Back. Never navigate behind it.
  return true;
}
