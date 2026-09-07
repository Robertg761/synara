// FILE: composerPhoneChrome.browser.tsx
// Purpose: Prove the phone composer chrome resolves to real CSS — the keyboard clearance
//          spacer tracks the visual-viewport inset, and the command-menu cap beats the
//          desktop max-height on specificity (not on utility order in the sheet).
// Layer: Browser test (styling contract)

import "../../index.css";

import { afterEach, describe, expect, it } from "vitest";

import { APP_KEYBOARD_INSET_CSS_VAR } from "~/hooks/useVisualViewportInset";

import {
  COMPOSER_COMMAND_MENU_FLOATING_WRAPPER_CLASS_NAME,
  COMPOSER_COMMAND_MENU_PHONE_MAX_HEIGHT_CLASS_NAME,
} from "./composerPickerStyles";

const hosts: HTMLElement[] = [];

function mountFixture(): { menuBody: HTMLElement; clearance: HTMLElement } {
  const host = document.createElement("div");
  // `max-h-72` mirrors ComposerCommandMenu's own CommandList cap, which the phone
  // override has to outrank; `pb-keyboard-safe` is the clearance spacer ChatView
  // renders as the last child of the composer's outer wrapper on phone layouts.
  host.innerHTML = `
    <div class="${COMPOSER_COMMAND_MENU_FLOATING_WRAPPER_CLASS_NAME} ${COMPOSER_COMMAND_MENU_PHONE_MAX_HEIGHT_CLASS_NAME}">
      <div data-slot="command-list" class="max-h-72" data-testid="menu-body"></div>
    </div>
    <div class="pb-keyboard-safe" data-testid="clearance"></div>
  `;
  document.body.append(host);
  hosts.push(host);
  const menuBody = host.querySelector<HTMLElement>("[data-testid=menu-body]");
  const clearance = host.querySelector<HTMLElement>("[data-testid=clearance]");
  if (!menuBody || !clearance) {
    throw new Error("fixture did not mount");
  }
  return { menuBody, clearance };
}

afterEach(() => {
  for (const host of hosts.splice(0)) {
    host.remove();
  }
  delete document.documentElement.dataset.layout;
  document.documentElement.style.removeProperty(APP_KEYBOARD_INSET_CSS_VAR);
});

describe("phone composer chrome", () => {
  it("caps the command menu at 40dvh on phone layouts", () => {
    document.documentElement.dataset.layout = "phone";
    const { menuBody } = mountFixture();

    // `interactive-widget=resizes-content` (index.html) shrinks the layout viewport —
    // and with it `dvh` and `innerHeight` — while the on-screen keyboard is up, so this
    // ratio is what bounds the menu against the keyboard, not the idle screen height.
    const maxHeightPx = Number.parseFloat(getComputedStyle(menuBody).maxHeight);
    expect(maxHeightPx).toBeCloseTo(window.innerHeight * 0.4, 0);
    // The phone cap must win over the menu's own `max-h-72` (288px). It resolves by
    // specificity (`html[data-layout=phone] …`), never by utility order in the sheet.
    expect(getComputedStyle(menuBody).maxHeight).not.toBe("288px");
  });

  it("leaves the desktop command-menu height untouched", () => {
    document.documentElement.dataset.layout = "desktop";
    const { menuBody } = mountFixture();

    expect(getComputedStyle(menuBody).maxHeight).toBe("288px");
  });

  it("grows the composer clearance with the on-screen keyboard inset", () => {
    const { clearance } = mountFixture();
    expect(clearance.getBoundingClientRect().height).toBe(0);

    document.documentElement.style.setProperty(APP_KEYBOARD_INSET_CSS_VAR, "260px");
    expect(clearance.getBoundingClientRect().height).toBe(260);

    document.documentElement.style.setProperty(APP_KEYBOARD_INSET_CSS_VAR, "0px");
    expect(clearance.getBoundingClientRect().height).toBe(0);
  });
});
