/**
 * The Verwaltungszentrum's tab strip on a phone.
 *
 * The owner: "Mobile version of the admin center is not optimized for mobile
 * use. I can not even horizontally scroll." At 375 px the strip measured 782 px
 * and `html, body { overflow-x: clip }` cut "Gruppen … Backups" off with no way
 * to reach them. What must hold now: the strip is its own horizontal scroller
 * at every width (the stylesheet half is asserted in adminPageMobile.test.tsx,
 * jsdom does not lay out); when the chosen tab changes it is scrolled into the
 * strip's view, clear of the edge fade, and left alone when it is already in
 * view; the strip says which edge has more tabs behind it, so the fade can
 * hint at them; and the keyboard walks the strip as a WAI-ARIA tab list —
 * Tab reaches the chosen tab only, the arrows/Home/End move the focus, and a
 * tab opens on Enter/Space or a tap (manual activation: opening Protokoll or
 * Rollen loads data, an arrow walking past them must not).
 *
 * On a phone the strip snaps (`scroll-snap-type: x proximity`, each chip
 * `scroll-snap-align: start` against a 32 px scroll-padding). A reveal that
 * ends between two snap positions is pulled back to the nearer one by the
 * browser — in real Chromium Werkzeuge, Protokoll and System were left under
 * the edge fade or cut off — so while the strip snaps the reveal itself must
 * end on a snap position.
 *
 * jsdom has no layout, no Element.scrollTo and no scroll snapping, so all
 * three are faked here: every tab is 100 px wide, side by side from x = 0,
 * inside a 300 px strip that can scroll to 900 px of content.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { AdminTabBar } from "../components/admin/AdminTabBar";
import { scrollLeftToReveal, snapOffsetOf, stripEdges, STRIP_EDGE_MARGIN } from "../components/admin/adminTabStrip";

type Tab = "users" | "groups" | "roles" | "tools" | "audit" | "settings" | "system" | "backups";

const TABS: { id: Tab; label: string }[] = [
  { id: "users", label: "Benutzer" },
  { id: "groups", label: "Gruppen" },
  { id: "roles", label: "Rollen" },
  { id: "tools", label: "Werkzeuge" },
  { id: "audit", label: "Protokoll" },
  { id: "settings", label: "Einstellungen" },
  { id: "system", label: "System" },
  { id: "backups", label: "Backups" },
];

const TAB_WIDTH = 100;
const STRIP_WIDTH = 300;
const CONTENT_WIDTH = TABS.length * TAB_WIDTH + 100;

/** The strip's scroll offset as the fake layout sees it. */
let scrollLeft = 0;
const scrollTo = vi.fn((options: ScrollToOptions) => {
  scrollLeft = options.left ?? scrollLeft;
});

function rect(left: number, width: number): DOMRect {
  return {
    left,
    width,
    right: left + width,
    top: 0,
    bottom: 40,
    height: 40,
    x: left,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect;
}

const saved = {
  getBoundingClientRect: HTMLElement.prototype.getBoundingClientRect,
  clientWidth: Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth"),
  scrollWidth: Object.getOwnPropertyDescriptor(Element.prototype, "scrollWidth"),
  scrollLeft: Object.getOwnPropertyDescriptor(Element.prototype, "scrollLeft"),
};

function isStrip(el: Element): boolean {
  return el.getAttribute("role") === "tablist";
}

beforeEach(() => {
  scrollLeft = 0;
  scrollTo.mockClear();
  HTMLElement.prototype.getBoundingClientRect = function fakeRect(this: HTMLElement) {
    if (isStrip(this)) return rect(0, STRIP_WIDTH);
    const index = TABS.findIndex((t) => t.id === this.dataset.tab);
    if (index >= 0) return rect(index * TAB_WIDTH - scrollLeft, TAB_WIDTH);
    return rect(0, 0);
  };
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get(this: HTMLElement) {
      return isStrip(this) ? STRIP_WIDTH : 0;
    },
  });
  Object.defineProperty(Element.prototype, "scrollWidth", {
    configurable: true,
    get(this: Element) {
      return isStrip(this) ? CONTENT_WIDTH : 0;
    },
  });
  Object.defineProperty(Element.prototype, "scrollLeft", {
    configurable: true,
    get(this: Element) {
      return isStrip(this) ? scrollLeft : 0;
    },
    set(this: Element, value: number) {
      if (isStrip(this)) scrollLeft = value;
    },
  });
  (HTMLElement.prototype as unknown as { scrollTo: typeof scrollTo }).scrollTo = scrollTo;
});

afterEach(() => {
  HTMLElement.prototype.getBoundingClientRect = saved.getBoundingClientRect;
  if (saved.clientWidth) Object.defineProperty(HTMLElement.prototype, "clientWidth", saved.clientWidth);
  if (saved.scrollWidth) Object.defineProperty(Element.prototype, "scrollWidth", saved.scrollWidth);
  if (saved.scrollLeft) Object.defineProperty(Element.prototype, "scrollLeft", saved.scrollLeft);
  delete (HTMLElement.prototype as unknown as { scrollTo?: unknown }).scrollTo;
});

function strip(): HTMLElement {
  return screen.getByRole("tablist", { name: "Verwaltungsbereiche" });
}

function tab(name: string): HTMLElement {
  return screen.getByRole("tab", { name });
}

function bar(active: Tab, onChange: (id: Tab) => void = () => undefined) {
  return <AdminTabBar tabs={TABS} active={active} onChange={onChange} label="Verwaltungsbereiche" />;
}

describe("scrollLeftToReveal", () => {
  const view = { scrollLeft: 0, clientWidth: 300, scrollWidth: 900 };

  it("leaves a tab alone that is already clear of both fades", () => {
    expect(scrollLeftToReveal(view, { left: 100, width: 100 })).toBeNull();
  });

  it("scrolls right just far enough to clear the end fade", () => {
    expect(scrollLeftToReveal(view, { left: 700, width: 100 })).toBe(700 + 100 + STRIP_EDGE_MARGIN - 300);
  });

  it("scrolls left to clear the start fade, never past the start", () => {
    expect(scrollLeftToReveal({ ...view, scrollLeft: 500 }, { left: 100, width: 100 })).toBe(100 - STRIP_EDGE_MARGIN);
    expect(scrollLeftToReveal({ ...view, scrollLeft: 500 }, { left: 0, width: 100 })).toBe(0);
  });

  it("never asks for more than the strip can scroll", () => {
    expect(scrollLeftToReveal(view, { left: 820, width: 80 })).toBe(600);
  });

  describe("on a strip that snaps", () => {
    // 100 px tabs from x = 0, snapping their start 32 px in from the strip's
    // start: -32 (clamped to 0), 68, 168, … 668 (clamped to the 600 maximum).
    const snaps = [0, 68, 168, 268, 368, 468, 568, 600];

    it("goes on to the next snap position past the end fade, not stopping between two", () => {
      // Clearing the fade needs 232; the browser would pull 232 back to 268 or 168.
      const left = scrollLeftToReveal(view, { left: 400, width: 100 }, { snapOffsets: snaps });
      expect(left).toBe(268);
      expect(snaps).toContain(left);
    });

    it("lands on a snap position that still keeps the tab clear of the start fade", () => {
      const left = scrollLeftToReveal({ ...view, scrollLeft: 500 }, { left: 300, width: 100 }, { snapOffsets: snaps });
      expect(left).toBe(268);
      expect(snaps).toContain(left);
      // Snap positions that do not line up with the margin: the one before it.
      expect(
        scrollLeftToReveal({ ...view, scrollLeft: 500 }, { left: 300, width: 100 }, { snapOffsets: [0, 150, 250, 350] }),
      ).toBe(250);
    });

    it("takes the end of the strip when no snap position is far enough", () => {
      expect(scrollLeftToReveal(view, { left: 700, width: 100 }, { snapOffsets: [0, 68, 168] })).toBe(600);
    });

    it("still leaves a tab alone that is already in view", () => {
      expect(scrollLeftToReveal(view, { left: 100, width: 100 }, { snapOffsets: snaps })).toBeNull();
    });
  });
});

describe("snapOffsetOf", () => {
  const view = { scrollLeft: 0, clientWidth: 300, scrollWidth: 900 };
  const padding = { start: 32, end: 32 };

  it("puts a start-aligned tab at the start of the snapport, inside the scroll-padding", () => {
    expect(snapOffsetOf(view, { left: 400, width: 100 }, "start", padding)).toBe(368);
  });

  it("handles end and centre alignment", () => {
    expect(snapOffsetOf(view, { left: 400, width: 100 }, "end", padding)).toBe(400 + 100 - (300 - 32));
    expect(snapOffsetOf(view, { left: 400, width: 100 }, "center", padding)).toBe(400 + 50 - (32 + (300 - 64) / 2));
  });

  it("clamps a position past either end of the strip, as the browser does", () => {
    expect(snapOffsetOf(view, { left: 0, width: 100 }, "start", padding)).toBe(0);
    expect(snapOffsetOf(view, { left: 800, width: 100 }, "start", padding)).toBe(600);
  });

  it("gives a tab that does not snap no position", () => {
    expect(snapOffsetOf(view, { left: 400, width: 100 }, "none", padding)).toBeNull();
  });
});

describe("stripEdges", () => {
  it("reports nothing behind either edge when everything fits", () => {
    expect(stripEdges({ scrollLeft: 0, clientWidth: 800, scrollWidth: 800 })).toEqual({ start: false, end: false });
  });

  it("reports what is hidden at each edge", () => {
    expect(stripEdges({ scrollLeft: 0, clientWidth: 300, scrollWidth: 900 })).toEqual({ start: false, end: true });
    expect(stripEdges({ scrollLeft: 300, clientWidth: 300, scrollWidth: 900 })).toEqual({ start: true, end: true });
    expect(stripEdges({ scrollLeft: 600, clientWidth: 300, scrollWidth: 900 })).toEqual({ start: true, end: false });
  });
});

describe("AdminTabBar", () => {
  it("is a tab list with one tab per section and the chosen one selected", () => {
    render(bar("audit"));
    expect(strip()).toHaveClass("admin-page-tabs");
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(TABS.map((t) => t.label));
    expect(tab("Protokoll")).toHaveAttribute("aria-selected", "true");
    expect(tab("Benutzer")).toHaveAttribute("aria-selected", "false");
  });

  it("puts only the chosen tab in the Tab order", () => {
    render(bar("audit"));
    expect(tab("Protokoll")).toHaveAttribute("tabindex", "0");
    for (const other of TABS.filter((t) => t.id !== "audit")) {
      expect(tab(other.label)).toHaveAttribute("tabindex", "-1");
    }
  });

  it("opens a tab on a tap", () => {
    const onChange = vi.fn();
    render(bar("users", onChange));
    fireEvent.click(tab("Backups"));
    expect(onChange).toHaveBeenCalledWith("backups");
  });

  it("scrolls the chosen tab into view when it changes", () => {
    const { rerender } = render(bar("users"));
    scrollTo.mockClear();

    rerender(bar("backups"));
    expect(scrollTo).toHaveBeenCalledWith(expect.objectContaining({ left: 7 * TAB_WIDTH + TAB_WIDTH + STRIP_EDGE_MARGIN - STRIP_WIDTH }));

    scrollTo.mockClear();
    rerender(bar("users"));
    expect(scrollTo).toHaveBeenCalledWith(expect.objectContaining({ left: 0 }));
  });

  it("does not move the strip when the chosen tab is already in view", () => {
    const { rerender } = render(bar("users"));
    scrollTo.mockClear();
    rerender(bar("groups"));
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("opens on a tab that starts out of view and shows it", () => {
    render(bar("system"));
    expect(scrollTo).toHaveBeenCalledWith(expect.objectContaining({ left: 6 * TAB_WIDTH + TAB_WIDTH + STRIP_EDGE_MARGIN - STRIP_WIDTH }));
  });

  it("marks the edges that have tabs behind them, and follows the scroll", () => {
    render(bar("users"));
    expect(strip()).toHaveClass("admin-page-tabs--more-end");
    expect(strip()).not.toHaveClass("admin-page-tabs--more-start");

    scrollLeft = CONTENT_WIDTH - STRIP_WIDTH;
    fireEvent.scroll(strip());
    expect(strip()).toHaveClass("admin-page-tabs--more-start");
    expect(strip()).not.toHaveClass("admin-page-tabs--more-end");
  });

  it("walks the focus with the arrows, Home and End without opening anything", () => {
    const onChange = vi.fn();
    render(bar("users", onChange));
    tab("Benutzer").focus();

    fireEvent.keyDown(strip(), { key: "ArrowRight" });
    expect(document.activeElement).toBe(tab("Gruppen"));
    fireEvent.keyDown(strip(), { key: "End" });
    expect(document.activeElement).toBe(tab("Backups"));
    fireEvent.keyDown(strip(), { key: "ArrowRight" });
    expect(document.activeElement).toBe(tab("Benutzer"));
    fireEvent.keyDown(strip(), { key: "ArrowLeft" });
    expect(document.activeElement).toBe(tab("Backups"));
    fireEvent.keyDown(strip(), { key: "Home" });
    expect(document.activeElement).toBe(tab("Benutzer"));

    expect(onChange).not.toHaveBeenCalled();
  });

  it("brings a tab the keyboard lands on into view", () => {
    render(bar("users"));
    tab("Benutzer").focus();
    scrollTo.mockClear();
    fireEvent.keyDown(strip(), { key: "End" });
    expect(scrollTo).toHaveBeenCalledWith(expect.objectContaining({ left: 7 * TAB_WIDTH + TAB_WIDTH + STRIP_EDGE_MARGIN - STRIP_WIDTH }));
  });

  describe("when the strip snaps (the phone layout)", () => {
    let savedGetComputedStyle: typeof window.getComputedStyle;

    beforeEach(() => {
      savedGetComputedStyle = window.getComputedStyle;
      // What Chromium reports for admin-mobile.css's phone block.
      window.getComputedStyle = ((el: Element) => {
        const real = savedGetComputedStyle(el);
        const fake: Record<string, string> = isStrip(el)
          ? { scrollSnapType: "x", scrollPaddingLeft: "32px", scrollPaddingRight: "32px" }
          : el.getAttribute("role") === "tab"
            ? { scrollSnapAlign: "start" }
            : {};
        return new Proxy(real, {
          get: (target, key) => {
            if (typeof key === "string" && key in fake) return fake[key];
            const value = Reflect.get(target, key);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      }) as typeof window.getComputedStyle;
    });

    afterEach(() => {
      window.getComputedStyle = savedGetComputedStyle;
    });

    it("reveals the chosen tab at a snap position, so the browser does not pull it back under the fade", () => {
      const { rerender } = render(bar("users"));
      scrollTo.mockClear();
      rerender(bar("audit"));
      // Clearing the end fade needs 400 + 100 + 32 - 300 = 232, between the
      // snap positions 168 and 268; 268 is the one that keeps the tab clear.
      expect(scrollTo).toHaveBeenCalledWith(expect.objectContaining({ left: 268 }));
    });

    it("does the same for a tab the keyboard lands on", () => {
      render(bar("users"));
      tab("Benutzer").focus();
      scrollTo.mockClear();
      fireEvent.keyDown(strip(), { key: "ArrowRight" });
      fireEvent.keyDown(strip(), { key: "ArrowRight" });
      fireEvent.keyDown(strip(), { key: "ArrowRight" });
      // Werkzeuge: 300 + 100 + 32 - 300 = 132 to clear the fade; next snap 168.
      expect(scrollTo).toHaveBeenLastCalledWith(expect.objectContaining({ left: 168 }));
    });
  });

  it("survives a browser without Element.scrollTo", () => {
    delete (HTMLElement.prototype as unknown as { scrollTo?: unknown }).scrollTo;
    const { rerender } = render(bar("users"));
    rerender(bar("backups"));
    expect(scrollLeft).toBe(7 * TAB_WIDTH + TAB_WIDTH + STRIP_EDGE_MARGIN - STRIP_WIDTH);
  });
});
