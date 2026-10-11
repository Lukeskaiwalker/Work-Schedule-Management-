/**
 * The row menu has to be visible to be usable.
 *
 * "The edit button does not work or show right": the Bestand row's "…" menu
 * was an absolutely positioned popover inside a table cell with
 * `overflow: hidden`, in a table card with `overflow: hidden`. Pressing "…"
 * flipped aria-expanded and drew nothing — the menu was clipped to the 32 px
 * cell. Bearbeiten, Bestand anpassen and Archivieren were behind it.
 *
 * jsdom does no layout, so the clipping itself cannot be seen here. What can
 * be pinned is the structural fix: the menu is rendered OUTSIDE the row (in a
 * portal on <body>) with fixed positioning taken from the trigger, so no
 * ancestor's overflow can ever cut it off again.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

import { KebabMenu } from "../components/werkstatt/KebabMenu";

function renderInClippedCell(onSelect = vi.fn()) {
  render(
    <div className="werkstatt-table-card" style={{ overflow: "hidden" }}>
      <span data-testid="cell" className="werkstatt-col werkstatt-col-actions" style={{ overflow: "hidden" }}>
        <KebabMenu
          ariaLabel="Artikel-Aktionen"
          items={[
            { key: "edit", label: "Bearbeiten", onSelect },
            { key: "archive", label: "Archivieren", danger: true, onSelect: vi.fn() },
          ]}
        />
      </span>
    </div>,
  );
  return onSelect;
}

describe("KebabMenu — never clipped by the row it sits in", () => {
  afterEach(() => vi.restoreAllMocks());

  it("renders the menu outside the clipping cell, fixed to the viewport", () => {
    renderInClippedCell();
    const trigger = screen.getByRole("button", { name: "Artikel-Aktionen" });
    vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue({
      x: 900,
      y: 300,
      top: 300,
      bottom: 328,
      left: 900,
      right: 928,
      width: 28,
      height: 28,
      toJSON: () => ({}),
    } as DOMRect);

    fireEvent.click(trigger);

    const menu = screen.getByRole("menu");
    // Not a descendant of the overflow:hidden cell — that is the whole fix.
    expect(screen.getByTestId("cell").contains(menu)).toBe(false);
    expect(menu.parentElement).toBe(document.body);
    expect(menu.style.position).toBe("fixed");
    // Anchored under the trigger, right edges aligned.
    expect(menu.style.top).toBe("332px");
    expect(menu.style.right).toBe(`${window.innerWidth - 928}px`);
  });

  it("opens upwards when the trigger sits near the bottom of the screen", () => {
    renderInClippedCell();
    const trigger = screen.getByRole("button", { name: "Artikel-Aktionen" });
    const bottom = window.innerHeight - 10;
    vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue({
      x: 900,
      y: bottom - 28,
      top: bottom - 28,
      bottom,
      left: 900,
      right: 928,
      width: 28,
      height: 28,
      toJSON: () => ({}),
    } as DOMRect);

    fireEvent.click(trigger);

    const menu = screen.getByRole("menu");
    expect(menu.style.top).toBe("");
    expect(menu.style.bottom).toBe(`${window.innerHeight - (bottom - 28) + 4}px`);
  });

  it("still picks an item and closes", () => {
    const onSelect = renderInClippedCell();
    fireEvent.click(screen.getByRole("button", { name: "Artikel-Aktionen" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Bearbeiten" }));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("closes on a click outside, but not on a click inside the portalled menu", () => {
    renderInClippedCell();
    fireEvent.click(screen.getByRole("button", { name: "Artikel-Aktionen" }));
    const menu = screen.getByRole("menu");

    // mousedown inside the menu — which is no longer inside the trigger's
    // container — must not count as "outside".
    fireEvent.mouseDown(menu);
    expect(screen.getByRole("menu")).toBeInTheDocument();

    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("closes on Escape", () => {
    renderInClippedCell();
    fireEvent.click(screen.getByRole("button", { name: "Artikel-Aktionen" }));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("does not let a menu click bubble into the row underneath", () => {
    const rowClick = vi.fn();
    render(
      <div role="row" onClick={rowClick}>
        <KebabMenu ariaLabel="Aktionen" items={[{ key: "x", label: "X", onSelect: vi.fn() }]} />
      </div>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Aktionen" }));
    // React portals bubble synthetic events through the React tree, so the
    // row would open Entnehmen under the menu without the guard.
    fireEvent.click(screen.getByRole("menuitem", { name: "X" }));
    expect(rowClick).not.toHaveBeenCalled();
  });
});

/**
 * Keyboard access. The portal put the menu at the end of <body>, so Tab from
 * "…" no longer landed on its first item (it did while the menu sat right after
 * the trigger): it went on to the next row, the menu stayed open over the page,
 * and "Umbenennen" / "Archivieren" on the Kategorien page were out of reach
 * for anyone without a mouse. The menu now carries focus itself, as the
 * WAI-ARIA menu-button pattern does.
 */
describe("KebabMenu — usable from the keyboard", () => {
  afterEach(() => vi.restoreAllMocks());

  function renderMenu() {
    const rename = vi.fn();
    render(
      <div>
        <button type="button">Davor</button>
        <KebabMenu
          ariaLabel="Kategorie-Aktionen"
          items={[
            { key: "rename", label: "Umbenennen", onSelect: rename },
            { key: "move", label: "Verschieben", disabled: true, onSelect: vi.fn() },
            { key: "child", label: "Unterkategorie", onSelect: vi.fn() },
            { key: "archive", label: "Archivieren", danger: true, onSelect: vi.fn() },
          ]}
        />
        <button type="button">Danach</button>
      </div>,
    );
    const trigger = screen.getByRole("button", { name: "Kategorie-Aktionen" });
    trigger.focus();
    return { trigger, rename };
  }

  const item = (name: string) => screen.getByRole("menuitem", { name });
  const press = (key: string, init: Record<string, unknown> = {}) =>
    fireEvent.keyDown(document.activeElement ?? document.body, { key, ...init });

  it("puts focus on the first item when opened with Enter or Space", () => {
    const { trigger } = renderMenu();
    // Enter/Space on a <button> is a click with detail 0 — that is what the
    // browser dispatches for a keyboard activation.
    fireEvent.click(trigger, { detail: 0 });
    expect(document.activeElement).toBe(item("Umbenennen"));
  });

  it("leaves focus on the trigger after a mouse click, and ArrowDown enters the menu", () => {
    const { trigger } = renderMenu();
    fireEvent.click(trigger, { detail: 1 });
    expect(screen.getByRole("menu")).toBeInTheDocument();
    expect(document.activeElement).toBe(trigger);

    press("ArrowDown");
    expect(document.activeElement).toBe(item("Umbenennen"));
  });

  it("opens from the closed trigger with ArrowDown (first item) and ArrowUp (last item)", () => {
    const { trigger } = renderMenu();
    press("ArrowDown");
    expect(document.activeElement).toBe(item("Umbenennen"));

    press("Escape");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger);

    press("ArrowUp");
    expect(document.activeElement).toBe(item("Archivieren"));
  });

  it("moves with ArrowDown/ArrowUp/Home/End, skipping disabled items and wrapping", () => {
    const { trigger } = renderMenu();
    fireEvent.click(trigger, { detail: 0 });

    press("ArrowDown");
    // "Verschieben" is disabled and cannot take focus — it is skipped.
    expect(document.activeElement).toBe(item("Unterkategorie"));
    press("ArrowDown");
    expect(document.activeElement).toBe(item("Archivieren"));
    press("ArrowDown");
    expect(document.activeElement).toBe(item("Umbenennen"));
    press("ArrowUp");
    expect(document.activeElement).toBe(item("Archivieren"));
    press("Home");
    expect(document.activeElement).toBe(item("Umbenennen"));
    press("End");
    expect(document.activeElement).toBe(item("Archivieren"));
  });

  it("closes on Escape and gives focus back to the trigger", () => {
    const { trigger } = renderMenu();
    fireEvent.click(trigger, { detail: 0 });
    press("ArrowDown");
    expect(screen.getByRole("menu").contains(document.activeElement)).toBe(true);

    press("Escape");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("closes on Tab and Shift+Tab and gives focus back to the trigger", () => {
    const { trigger } = renderMenu();
    fireEvent.click(trigger, { detail: 0 });
    // Without this, Tab from the last item would leave the page entirely: the
    // portalled menu is the last thing in <body>.
    expect(press("Tab")).toBe(false); // default prevented
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger);

    fireEvent.click(trigger, { detail: 0 });
    press("Tab", { shiftKey: true });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("closes when focus moves somewhere else on the page", () => {
    const { trigger } = renderMenu();
    fireEvent.click(trigger, { detail: 1 });
    // Tab from the trigger while the menu is open: the browser moves focus on.
    act(() => screen.getByRole("button", { name: "Danach" }).focus());
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("picks the focused item with Enter and returns focus to the trigger", () => {
    const { trigger, rename } = renderMenu();
    fireEvent.click(trigger, { detail: 0 });
    // Enter on the focused menuitem <button> is its click.
    fireEvent.click(document.activeElement as HTMLElement, { detail: 0 });
    expect(rename).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).toBeNull();
    // Not lost on <body> with the unmounted item.
    expect(document.activeElement).toBe(trigger);
  });

  it("closes on a click outside", () => {
    const { trigger } = renderMenu();
    fireEvent.click(trigger, { detail: 0 });
    fireEvent.mouseDown(screen.getByRole("button", { name: "Davor" }));
    expect(screen.queryByRole("menu")).toBeNull();
  });
});

describe("KebabMenu — anchored to the viewport the menu is laid out in", () => {
  afterEach(() => vi.restoreAllMocks());

  it("measures from the client width, which excludes a classic scrollbar", () => {
    /* position:fixed offsets count from the viewport WITHOUT the vertical
     * scrollbar; window.innerWidth includes it. With a classic (Windows)
     * scrollbar the menu sat one scrollbar width left of its "…". */
    vi.spyOn(document.documentElement, "clientWidth", "get").mockReturnValue(window.innerWidth - 15);
    renderInClippedCell();
    const trigger = screen.getByRole("button", { name: "Artikel-Aktionen" });
    vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue({
      x: 900,
      y: 300,
      top: 300,
      bottom: 328,
      left: 900,
      right: 928,
      width: 28,
      height: 28,
      toJSON: () => ({}),
    } as DOMRect);

    fireEvent.click(trigger);

    expect(screen.getByRole("menu").style.right).toBe(`${window.innerWidth - 15 - 928}px`);
  });
});
