import { useEffect, useRef, useState } from "react";

/**
 * KebabMenu — a tiny popover with a stack of action items. Used by the
 * "…" button on Werkstatt taxonomy rows (categories, locations).
 *
 * Behavior:
 *   - Anchors below the trigger button by default, right-aligned.
 *   - Closes on: outside click, Escape, item selection, scroll.
 *   - Items with `danger: true` render in red; others neutral.
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

export function KebabMenu({ items, ariaLabel, buttonClassName }: KebabMenuProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return undefined;
    function onDocClick(event: MouseEvent) {
      const container = containerRef.current;
      if (!container) return;
      if (!container.contains(event.target as Node)) setOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    function onScroll() {
      setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [open]);

  function pick(item: KebabMenuItem) {
    if (item.disabled) return;
    setOpen(false);
    item.onSelect();
  }

  return (
    <div
      className="werkstatt-kebab"
      ref={containerRef}
      onClick={(event) => event.stopPropagation()}
    >
      <button
        type="button"
        className={buttonClassName ?? "werkstatt-row-overflow"}
        aria-label={ariaLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        title={ariaLabel}
        onClick={() => setOpen((prev) => !prev)}
      >
        …
      </button>
      {open && (
        <div className="werkstatt-kebab-menu" role="menu">
          {items.map((item) => (
            <button
              key={item.key}
              type="button"
              role="menuitem"
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
      )}
    </div>
  );
}
