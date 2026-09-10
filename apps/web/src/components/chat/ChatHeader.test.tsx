// FILE: ChatHeader.test.tsx
// Purpose: Covers chat header presentation helpers and the optional leading-control slot.
// Layer: Component unit tests
// Depends on: ChatHeader pure helpers, static rendering, and Vitest assertions.

import { createMinimalChatHeaderProps, type ChatHeaderProps } from "./chatHeaderTestFixtures";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ChatHeader, resolveChatHeaderThreadIconKind } from "./ChatHeader";
import { SidebarProvider } from "../ui/sidebar";

describe("resolveChatHeaderThreadIconKind", () => {
  it("uses the terminal icon for terminal-first threads", () => {
    expect(resolveChatHeaderThreadIconKind("terminal", "New terminal")).toBe("terminal");
  });

  it("keeps provider branding for chat-first threads", () => {
    expect(resolveChatHeaderThreadIconKind("chat", "Fix auth flow")).toBe("provider");
  });

  it("hides provider branding for untouched new chat threads", () => {
    expect(resolveChatHeaderThreadIconKind("chat", "New thread")).toBe("none");
  });
});

// The header compacts below 700px via a ResizeObserver on itself, so static markup always
// starts in the non-compact branch; both branches share this leading cluster markup.
function renderChatHeader(overrides: Partial<ChatHeaderProps> = {}): string {
  return renderToStaticMarkup(
    <SidebarProvider open={false}>
      <ChatHeader {...createMinimalChatHeaderProps()} {...overrides} />
    </SidebarProvider>,
  );
}

const LEADING_CONTROL = (
  <button type="button" data-testid="chat-header-leading-control">
    Back
  </button>
);

describe("ChatHeader leadingControl slot", () => {
  it("renders the supplied control at the leading edge of the header", () => {
    const html = renderChatHeader({ leadingControl: LEADING_CONTROL });

    expect(html).toContain('data-testid="chat-header-leading-control"');
    // Ahead of the sidebar trigger, which is the first item of the default leading cluster.
    expect(html.indexOf('data-testid="chat-header-leading-control"')).toBeLessThan(
      html.indexOf('aria-label="Toggle thread sidebar"'),
    );
  });

  it("keeps the control from being squeezed by the leading flex row", () => {
    const html = renderChatHeader({ leadingControl: LEADING_CONTROL });
    const controlIndex = html.indexOf('data-testid="chat-header-leading-control"');
    const wrapperStart = html.lastIndexOf("<div", controlIndex);
    const wrapperTag = html.slice(wrapperStart, html.indexOf(">", wrapperStart) + 1);

    expect(wrapperTag).toContain("shrink-0");
  });

  it("renders nothing extra when no control is supplied", () => {
    const html = renderChatHeader();

    expect(html).not.toContain('data-testid="chat-header-leading-control"');
    expect(html).toBe(renderChatHeader({ leadingControl: null }));
    expect(html).toBe(renderChatHeader({ leadingControl: undefined }));
  });

  it("adds only the slot markup to the existing header structure", () => {
    const withControl = renderChatHeader({ leadingControl: LEADING_CONTROL });
    const withoutControl = renderChatHeader();
    const slotMarkup =
      '<div class="flex shrink-0 items-center"><button type="button" data-testid="chat-header-leading-control">Back</button></div>';

    expect(withControl).toContain(slotMarkup);
    expect(withControl.replace(slotMarkup, "")).toBe(withoutControl);
  });
});
