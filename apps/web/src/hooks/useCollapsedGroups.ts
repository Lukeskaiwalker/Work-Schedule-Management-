import { useCallback, useEffect, useState } from "react";

/**
 * Which project groups are folded, remembered between visits.
 *
 * Per viewer and per browser, which is exactly right for this: it is a
 * convenience ("I never look at the Halle-B block"), not data. Every access is
 * wrapped, because `localStorage` throws rather than returning null in a
 * private window and with site data blocked — and a folded-group preference is
 * never worth an error banner or a blank screen.
 */
export interface CollapsedGroups {
  collapsed: ReadonlySet<number>;
  isCollapsed: (id: number) => boolean;
  toggle: (id: number) => void;
  /** Fold or unfold everything currently on screen. */
  setAll: (ids: readonly number[], collapsedState: boolean) => void;
}

function read(storageKey: string): ReadonlySet<number> {
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) return new Set<number>();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set<number>();
    return new Set(parsed.filter((value): value is number => typeof value === "number"));
  } catch {
    return new Set<number>();
  }
}

function write(storageKey: string, ids: ReadonlySet<number>): void {
  try {
    window.localStorage.setItem(storageKey, JSON.stringify([...ids]));
  } catch {
    // Nothing to do and nothing worth saying: the page works unfolded.
  }
}

export function useCollapsedGroups(storageKey: string): CollapsedGroups {
  const [collapsed, setCollapsed] = useState<ReadonlySet<number>>(() => read(storageKey));

  useEffect(() => {
    write(storageKey, collapsed);
  }, [storageKey, collapsed]);

  const toggle = useCallback((id: number) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const setAll = useCallback((ids: readonly number[], collapsedState: boolean) => {
    setCollapsed(collapsedState ? new Set(ids) : new Set<number>());
  }, []);

  const isCollapsed = useCallback((id: number) => collapsed.has(id), [collapsed]);

  return { collapsed, isCollapsed, toggle, setAll };
}
