import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { createPortal } from "react-dom";

/**
 * KebabMenu — a tiny popover with a stack of action items. Used by the
 * "…" button on Werkstatt taxonomy rows (categories, locations) and on the
 * Bestand rows.
 *
 * Behavior:
 *   - Anchors below the trigger button by default, right-aligned; opens
 *     upwards when there is no room below.
 *   - Closes on: outside click, Escape, item selection, scroll, resize, and
 *     focus moving anywhere outside the trigger and the menu.
 *   - Items with `danger: true` render in red; others neutral.
 *   - Keyboard (WAI-ARIA menu button): Enter/Space or ArrowDown on "…" opens
 *     with focus on the first item, ArrowUp on the last; ArrowUp/ArrowDown
 *     (wrapping), Home and End move between the enabled items; Escape and Tab
 *     close and hand focus back to "…", as does picking an item. A mouse click
 *     opens without moving focus.
 *
 * The menu is rendered in a PORTAL on <body> with fixed positioning taken from
 * the trigger's rectangle. It used to be an absolutely positioned child of the
 * trigger, which put it inside whatever cell the trigger sat in — and the
 * Bestand table's cells and card both clip with `overflow: hidden`. Pressing
 * "…" there flipped aria-expanded and drew nothing at all, which is how
 * "Bearbeiten" and "Bestand anpassen" became unreachable from the list. Outside
 * the row, no ancestor's overflow can cut it off. The price of the portal is
 * that the menu is the last thing in <body>: Tab from "…" no longer reaches
 * it, so the menu takes focus itself (see the keyboard rules above).
 */

export interface KebabMenuItem {
  key: string;
  label: string;
  icon?: string;           // short glyph / emoji
  danger?: boolean;
  disabled?: boolean;
  onSelect: () => void;
}

export interface KebabMenuProps {
  items: ReadonlyArray<KebabMenuItem>;
  ariaLabel: string;
  /** Optional className on the trigger button. */
  buttonClassName?: string;
}

/** Gap between trigger and menu, in px. */
const MENU_GAP = 4;
/** Room the menu needs below the trigger before it flips upwards. Five items
 *  of ~36 px plus padding; a guess is enough, the flip only has to be right
 *  near the bottom edge of the screen. */
const MENU_ROOM = 220;

/** Where focus goes when the menu opens: an item, or nowhere (a mouse click). */
type OpenFocus = "first" | "last" | null;

/** Fixed-position style for the menu, from the trigger's viewport rectangle. */
export function menuPosition(rect: DOMRect, viewport: { width: number; height: number }): CSSProperties {
  const right = Math.max(0, viewport.width - rect.right);
  const roomBelow = viewport.height - rect.bottom;
  if (roomBelow < MENU_ROOM && rect.top > roomBelow) {
    return { position: "fixed", right, bottom: viewport.height - rect.top + MENU_GAP };
  }
  return { position: "fixed", right, top: rect.bottom + MENU_GAP };
}

/** The viewport a fixed element is laid out in. `window.innerWidth/Height`
 *  include a classic (non-overlay) scrollbar, which put the menu one scrollbar
 *  width left of its trigger on Windows. jsdom has no layout and reports 0. */
function layoutViewport(): { width: number; height: number } {
  const root = document.documentElement;
  return {
    width: root.clientWidth || window.innerWidth,
    height: root.clientHeight || window.innerHeight,
  };
}

/** The items focus can land on — a disabled <button> cannot take it. */
function focusableItems(menu: HTMLElement | null): HTMLElement[] {
  if (!menu) return [];
  return Array.from(menu.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)'));
}

/** The item index a navigation key moves to (wrapping), or null for any
 *  other key. `current` is -1 when no item has focus yet. */
export function nextItemIndex(key: string, current: number, count: number): number | null {
  if (count === 0) return null;
  switch (key) {
    case "ArrowDown":
      return current < 0 ? 0 : (current + 1) % count;
    case "ArrowUp":
      return current < 0 ? count - 1 : (current - 1 + count) % count;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}

/** Focus without scrolling: any scroll closes the menu (see below). */
function focusQuietly(element: HTMLElement | null | undefined) {
  element?.focus({ preventScroll: true });
}

export function KebabMenu({ items, ariaLabel, buttonClassName }: KebabMenuProps) {
  const [open, setOpen] = useState(false);
  const [style, setStyle] = useState<CSSProperties | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const focusOnOpen = useRef<OpenFocus>(null);

  const place = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    setStyle(menuPosition(trigger.getBoundingClientRect(), layoutViewport()));
  }, []);

  // Measured before paint, so the menu never flashes at the wrong place.
  useLayoutEffect(() => {
    if (open) place();
  }, [open, place]);

  // Opened from the keyboard: once the menu is in the DOM, focus goes in.
  useLayoutEffect(() => {
    if (!open || !style || !focusOnOpen.current) return;
    const items = focusableItems(menuRef.current);
    focusQuietly(focusOnOpen.current === "first" ? items[0] : items[items.length - 1]);
    focusOnOpen.current = null;
  }, [open, style]);

  useEffect(() => {
    if (!open) return undefined;
    function inside(target: EventTarget | null): boolean {
      // The menu is no longer inside the container, so both count as inside.
      if (!(target instanceof Node)) return false;
      return Boolean(containerRef.current?.contains(target) || menuRef.current?.contains(target));
    }
    function onDocClick(event: MouseEvent) {
      if (!inside(event.target)) setOpen(false);
    }
    function onFocusIn(event: FocusEvent) {
      // Tab from "…" while open, or a click into another field: an open menu
      // nobody is in would otherwise stay over the page.
      if (!inside(event.target)) setOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      // Keys on the trigger itself are the trigger's own (onTriggerKey);
      // this listener can be attached while the very key that opened the
      // menu is still bubbling, and must not move focus a second time.
      const inMenu = event.target instanceof Node && Boolean(menuRef.current?.contains(event.target));
      if (event.key === "Escape") {
        setOpen(false);
        if (inMenu) focusQuietly(triggerRef.current);
        return;
      }
      if (!inMenu) return;
      if (event.key === "Tab") {
        // The menu is the last thing in <body>: Tab would leave the page.
        event.preventDefault();
        setOpen(false);
        focusQuietly(triggerRef.current);
        return;
      }
      const items = focusableItems(menuRef.current);
      const current = items.indexOf(document.activeElement as HTMLElement);
      const next = nextItemIndex(event.key, current, items.length);
      if (next === null) return;
      event.preventDefault();
      focusQuietly(items[next]);
    }
    function onScrollOrResize() {
      // A fixed menu would float away from a trigger that scrolled; closing is
      // what the menu always did on scroll, and it is the honest answer.
      setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScrollOrResize, true);
    window.addEventListener("resize", onScrollOrResize);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScrollOrResize, true);
      window.removeEventListener("resize", onScrollOrResize);
    };
  }, [open]);

  function pick(item: KebabMenuItem) {
    if (item.disabled) return;
    // The item unmounts with the menu; focus would fall to <body>. Handed
    // back first, so a dialog the item opens can still take it.
    if (menuRef.current?.contains(document.activeElement)) focusQuietly(triggerRef.current);
    setOpen(false);
    item.onSelect();
  }

  function onTriggerClick(event: ReactMouseEvent<HTMLButtonElement>) {
    if (open) {
      setOpen(false);
      return;
    }
    // Enter/Space on a <button> arrive as a click with detail 0.
    focusOnOpen.current = event.detail === 0 ? "first" : null;
    setOpen(true);
  }

  function onTriggerKey(event: ReactKeyboardEvent<HTMLButtonElement>) {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const where: OpenFocus = event.key === "ArrowDown" ? "first" : "last";
    if (open) {
      const items = focusableItems(menuRef.current);
      focusQuietly(where === "first" ? items[0] : items[items.length - 1]);
      return;
    }
    focusOnOpen.current = where;
    setOpen(true);
  }

  const menu =
    open && style ? (
      <div
        ref={menuRef}
        className="werkstatt-kebab-menu"
        role="menu"
        aria-label={ariaLabel}
        style={style}
        // React bubbles portal events through the COMPONENT tree, so a click
        // here would still reach a clickable row and open Entnehmen under it.
        onClick={(event) => event.stopPropagation()}
      >
        {items.map((item) => (
          <button
            key={item.key}
            type="button"
            role="menuitem"
            // Reached with the arrow keys, not Tab (menu-button pattern).
            tabIndex={-1}
            className={`werkstatt-kebab-item${item.danger ? " werkstatt-kebab-item--danger" : ""}`}
            onClick={() => pick(item)}
            disabled={item.disabled}
          >
            {item.icon && (
              <span className="werkstatt-kebab-item-icon" aria-hidden="true">
                {item.icon}
              </span>
            )}
            <span className="werkstatt-kebab-item-label">{item.label}</span>
          </button>
        ))}
      </div>
    ) : null;

  return (
    <div
      className="werkstatt-kebab"
      ref={containerRef}
      onClick={(event) => event.stopPropagation()}
    >
      <button
        ref={triggerRef}
        type="button"
        className={buttonClassName ?? "werkstatt-row-overflow"}
        aria-label={ariaLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        title={ariaLabel}
        onClick={onTriggerClick}
        onKeyDown={onTriggerKey}
      >
        …
      </button>
      {menu && createPortal(menu, document.body)}
    </div>
  );
}
