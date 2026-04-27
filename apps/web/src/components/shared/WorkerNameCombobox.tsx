import { useEffect, useMemo, useRef, useState } from "react";
import type { AssignableUser } from "../../types";

type Props = {
  value: string;
  onChange: (name: string) => void;
  users: ReadonlyArray<AssignableUser>;
  language: "de" | "en";
  /** CSS class forwarded to the underlying input — keeps the existing
   *  `.construction-report-input` look-and-feel. */
  className?: string;
  placeholder?: string;
  /** Optional — when provided, renders that text under the input when the
   *  typed value matches no known user (hint that a free-text name is being
   *  used). */
  freeTextHint?: string;
};

/**
 * A lightweight "search users, or type anything" combobox used in the
 * construction report's "Workers on site" rows. Reuses the keyboard/ARIA
 * pattern from `CustomerCombobox` but intentionally keeps free-text input
 * allowed — report forms sometimes list names of people who aren't app
 * users (trainees, external helpers).
 *
 * - Typing filters the dropdown by case-insensitive substring on
 *   `display_name` / `full_name` / `nickname`.
 * - Clicking a suggestion writes the full name via `onChange`.
 * - Esc closes, ↑/↓ navigates, Enter selects the highlighted row.
 */
export function WorkerNameCombobox({
  value,
  onChange,
  users,
  language,
  className,
  placeholder,
  freeTextHint,
}: Props) {
  const de = language === "de";
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);

  const matches = useMemo<AssignableUser[]>(() => {
    const q = value.trim().toLowerCase();
    if (!q) return users.slice(0, 10);
    return users
      .filter((u) => {
        const full = (u.full_name || "").toLowerCase();
        const display = (u.display_name || "").toLowerCase();
        const nick = (u.nickname || "").toLowerCase();
        return full.includes(q) || display.includes(q) || nick.includes(q);
      })
      .slice(0, 10);
  }, [users, value]);

  const exactMatch = useMemo<AssignableUser | null>(
    () =>
      users.find(
        (u) =>
          (u.full_name || "").toLowerCase() === value.trim().toLowerCase() ||
          (u.display_name || "").toLowerCase() === value.trim().toLowerCase(),
      ) ?? null,
    [users, value],
  );

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    function onDocClick(event: MouseEvent) {
      if (!containerRef.current) return;
      if (containerRef.current.contains(event.target as Node)) return;
      setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  // Keep activeIndex in range when the matches list shrinks.
  useEffect(() => {
    if (activeIndex >= matches.length) setActiveIndex(Math.max(0, matches.length - 1));
  }, [matches.length, activeIndex]);

  function pick(user: AssignableUser) {
    onChange(user.full_name);
    setOpen(false);
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") {
      setOpen(false);
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setOpen(true);
      setActiveIndex((current) =>
        matches.length === 0 ? 0 : (current + 1) % matches.length,
      );
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setOpen(true);
      setActiveIndex((current) =>
        matches.length === 0 ? 0 : (current - 1 + matches.length) % matches.length,
      );
      return;
    }
    if (event.key === "Enter" && open && matches[activeIndex]) {
      event.preventDefault();
      pick(matches[activeIndex]);
    }
  }

  const hint = !exactMatch && value.trim().length > 0 ? freeTextHint : null;

  return (
    <div
      ref={containerRef}
      className="worker-name-combobox"
      style={{ position: "relative" }}
    >
      <input
        className={className}
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder ?? (de ? "Name suchen …" : "Search name …")}
        autoComplete="off"
        role="combobox"
        aria-expanded={open}
        aria-autocomplete="list"
      />
      {open && matches.length > 0 && (
        <ul
          className="worker-name-combobox-dropdown"
          role="listbox"
          style={{
            position: "absolute",
            top: "calc(100% + 4px)",
            left: 0,
            right: 0,
            zIndex: 40,
            listStyle: "none",
            margin: 0,
            padding: 4,
            background: "#ffffff",
            border: "1px solid #c9d9ea",
            borderRadius: 8,
            boxShadow: "0 8px 24px rgba(20, 41, 61, 0.10)",
            maxHeight: 220,
            overflowY: "auto",
          }}
        >
          {matches.map((u, idx) => {
            const isActive = idx === activeIndex;
            return (
              <li
                key={u.id}
                role="option"
                aria-selected={isActive}
                onMouseEnter={() => setActiveIndex(idx)}
                onMouseDown={(event) => {
                  // mouseDown instead of click so input onBlur doesn't steal
                  event.preventDefault();
                  pick(u);
                }}
                style={{
                  padding: "6px 10px",
                  borderRadius: 6,
                  cursor: "pointer",
                  background: isActive ? "#eef4fc" : "transparent",
                  fontSize: 13,
                  color: "#14293d",
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  gap: 8,
                }}
              >
                <span>
                  <b style={{ fontWeight: 600 }}>{u.display_name || u.full_name}</b>
                  {u.nickname && u.nickname !== u.display_name && u.nickname !== u.full_name ? (
                    <span style={{ color: "#5c7895", marginLeft: 6 }}>· {u.nickname}</span>
                  ) : null}
                </span>
                <small style={{ color: "#5c7895", fontSize: 11 }}>{u.role}</small>
              </li>
            );
          })}
        </ul>
      )}
      {hint && (
        <small
          style={{
            display: "block",
            marginTop: 4,
            color: "#5c7895",
            fontSize: 11,
          }}
        >
          {hint}
        </small>
      )}
    </div>
  );
}
