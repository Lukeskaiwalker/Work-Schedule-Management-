/**
 * The Verwaltungszentrum's section tabs: Benutzer · Gruppen · Rollen ·
 * Werkzeuge · Protokoll · Einstellungen · Startseiten · System · Backups.
 *
 * Nine tabs are ~880 px of strip. On a phone, and on a tablet beside the
 * sidebar, that is wider than the page, and the page root clips (`html, body
 * { overflow-x: clip }` — it stops the whole page wobbling sideways), so the
 * last tabs were simply unreachable. The strip is therefore its own sideways
 * scroller (admin-mobile.css), and this component does the parts CSS cannot:
 *
 *  - the chosen tab is scrolled into the strip's view whenever it changes —
 *    including the first render — and kept clear of the edge fade. On a
 *    phone the strip snaps, and the browser pulls a scroll that ends between
 *    two snap positions to the nearer one; so there the reveal ends on a snap
 *    position itself, or the tab would slide back under the fade;
 *  - the strip says which edge has tabs hidden behind it
 *    (`admin-page-tabs--more-start` / `--more-end`), so the fade appears only
 *    where there is something to hint at;
 *  - the keyboard: a WAI-ARIA tab list with a roving tabindex. Tab reaches the
 *    chosen tab only; the arrows (wrapping), Home and End move the focus; Enter
 *    or Space opens the focused tab. Manual activation on purpose — opening
 *    Protokoll or Rollen fetches data, and an arrow walking past them must not.
 *
 * It only knows which tab is chosen and says when that changes; the page
 * mounts the panel.
 */
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";

import {
  scrollLeftToReveal,
  snapOffsetOf,
  stripEdges,
  tabAfterKey,
  type SnapAlign,
  type StripItem,
  type StripViewport,
} from "./adminTabStrip";

export type AdminTabItem<T extends string> = {
  id: T;
  label: string;
};

type AdminTabBarProps<T extends string> = {
  tabs: readonly AdminTabItem<T>[];
  active: T;
  onChange: (id: T) => void;
  /** The tab list's accessible name. */
  label: string;
};

/** The id of a tab's button — what its panel's `aria-labelledby` points at. */
export function adminTabId(id: string): string {
  return `admin-tab-${id}`;
}

/** The id of a tab's panel — what the chosen tab's `aria-controls` points at. */
export function adminTabPanelId(id: string): string {
  return `admin-tabpanel-${id}`;
}

function viewportOf(strip: HTMLElement): StripViewport {
  return { scrollLeft: strip.scrollLeft, clientWidth: strip.clientWidth, scrollWidth: strip.scrollWidth };
}

/** The tab's position in the strip's scroll coordinates (padding box, scroll included). */
function itemOf(strip: HTMLElement, tab: HTMLElement): StripItem {
  const stripRect = strip.getBoundingClientRect();
  const tabRect = tab.getBoundingClientRect();
  return {
    left: tabRect.left - stripRect.left - strip.clientLeft + strip.scrollLeft,
    width: tabRect.width,
  };
}

/** A computed length in px; "auto" and anything unparsable count as 0. */
function px(value: string | undefined): number {
  const parsed = Number.parseFloat(value ?? "");
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Does a computed `scroll-snap-type` snap along the strip (the horizontal axis)? */
function snapsSideways(snapType: string | undefined): boolean {
  const axis = (snapType ?? "").trim().split(/\s+/)[0];
  return axis === "x" || axis === "inline" || axis === "both";
}

/** A computed `scroll-snap-align` along the strip: its second value when it has two (block, inline). */
function snapAlignOf(value: string | undefined): SnapAlign {
  const parts = (value ?? "").trim().split(/\s+/);
  const inline = parts[1] ?? parts[0];
  return inline === "start" || inline === "center" || inline === "end" ? inline : "none";
}

/**
 * Where the strip comes to rest when it snaps — one position per tab — or
 * undefined when it does not snap (wider screens; jsdom, which has no CSS).
 */
function snapOffsetsOf(strip: HTMLElement, tabs: Iterable<HTMLElement>): number[] | undefined {
  const style = window.getComputedStyle(strip);
  if (!snapsSideways(style.scrollSnapType)) return undefined;
  const view = viewportOf(strip);
  const padding = { start: px(style.scrollPaddingLeft), end: px(style.scrollPaddingRight) };
  const offsets: number[] = [];
  for (const tab of tabs) {
    const align = snapAlignOf(window.getComputedStyle(tab).scrollSnapAlign);
    const offset = snapOffsetOf(view, itemOf(strip, tab), align, padding);
    if (offset !== null) offsets.push(offset);
  }
  return offsets;
}

function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  } catch {
    return false;
  }
}

/** Scroll the strip sideways only — never the page, which `scrollIntoView` would also move. */
function scrollStrip(strip: HTMLElement, left: number, smooth: boolean): void {
  if (typeof strip.scrollTo === "function") {
    strip.scrollTo({ left, behavior: smooth ? "smooth" : "auto" });
  } else {
    strip.scrollLeft = left;
  }
}

export function AdminTabBar<T extends string>({ tabs, active, onChange, label }: AdminTabBarProps<T>): JSX.Element {
  const stripRef = useRef<HTMLElement | null>(null);
  const tabRefs = useRef(new Map<T, HTMLButtonElement>());
  const hasRevealed = useRef(false);
  const [edges, setEdges] = useState({ start: false, end: false });

  const measureEdges = useCallback(() => {
    const strip = stripRef.current;
    if (!strip) return;
    const next = stripEdges(viewportOf(strip));
    setEdges((prev) => (prev.start === next.start && prev.end === next.end ? prev : next));
  }, []);

  const reveal = useCallback((id: T, smooth: boolean) => {
    const strip = stripRef.current;
    const tab = tabRefs.current.get(id);
    if (!strip || !tab) return;
    const snapOffsets = snapOffsetsOf(strip, tabRefs.current.values());
    const left = scrollLeftToReveal(viewportOf(strip), itemOf(strip, tab), { snapOffsets });
    if (left !== null) scrollStrip(strip, left, smooth && !prefersReducedMotion());
  }, []);

  // Only on a change of the chosen tab. The page re-renders often (every
  // context update), and re-revealing then would yank the strip back from
  // wherever the reader has just swiped it to.
  useEffect(() => {
    // The first reveal is a jump, not an animation: nobody watched it move.
    reveal(active, hasRevealed.current);
    hasRevealed.current = true;
    measureEdges();
  }, [active, reveal, measureEdges]);

  // The strip's width changes with the viewport (rotation, a resized window,
  // the sidebar opening), and its content with the set of tabs the person may see.
  const tabKey = tabs.map((tab) => tab.id).join("|");
  useEffect(() => {
    const strip = stripRef.current;
    measureEdges();
    if (!strip || typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver(() => measureEdges());
    observer.observe(strip);
    return () => observer.disconnect();
  }, [measureEdges, tabKey]);

  function handleKeyDown(event: KeyboardEvent<HTMLElement>) {
    const ids = tabs.map((tab) => tab.id);
    const focused = (document.activeElement as HTMLElement | null)?.dataset?.tab as T | undefined;
    const from = focused !== undefined && ids.includes(focused) ? focused : active;
    const next = tabAfterKey(ids, from, event.key);
    if (next === null) return;
    event.preventDefault();
    // preventScroll: the browser's own focus scroll would park the tab under
    // the edge fade; reveal() keeps the margin.
    tabRefs.current.get(next)?.focus({ preventScroll: true });
    reveal(next, true);
  }

  const className = [
    "admin-page-tabs",
    edges.start ? "admin-page-tabs--more-start" : "",
    edges.end ? "admin-page-tabs--more-end" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <nav
      ref={stripRef}
      className={className}
      role="tablist"
      aria-label={label}
      onKeyDown={handleKeyDown}
      onScroll={measureEdges}
    >
      {tabs.map((tab) => {
        const selected = tab.id === active;
        return (
          <button
            key={tab.id}
            ref={(node) => {
              if (node) tabRefs.current.set(tab.id, node);
              else tabRefs.current.delete(tab.id);
            }}
            id={adminTabId(tab.id)}
            type="button"
            role="tab"
            aria-selected={selected}
            aria-controls={selected ? adminTabPanelId(tab.id) : undefined}
            tabIndex={selected ? 0 : -1}
            data-tab={tab.id}
            className={selected ? "admin-page-tab active" : "admin-page-tab"}
            onClick={() => onChange(tab.id)}
          >
            {tab.label}
          </button>
        );
      })}
    </nav>
  );
}
