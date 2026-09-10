import "../index.css";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";
import { Dialog, DialogPopup, DialogTitle } from "../components/ui/dialog";
import { dismissMobileOverlay } from "./mobileOverlayBack";

function Fixture() {
  const [open, setOpen] = useState(true);
  return <Dialog open={open} onOpenChange={setOpen}>
    <DialogPopup><DialogTitle>Mobile back test</DialogTitle><input aria-label="Draft" /></DialogPopup>
  </Dialog>;
}

describe("native back on shared dialogs", () => {
  it("closes a desktop dialog through its existing Escape handler", async () => {
    const view = await render(<Fixture />);
    await expect.element(view.getByRole("dialog")).toBeVisible();
    expect(dismissMobileOverlay(document)).toBe(true);
    await expect.element(view.getByRole("dialog")).not.toBeInTheDocument();
    expect(dismissMobileOverlay(document)).toBe(false);
    await view.unmount();
  });
});
