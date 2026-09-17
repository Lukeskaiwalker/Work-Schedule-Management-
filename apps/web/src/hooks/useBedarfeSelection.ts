import { useCallback, useMemo, useState } from "react";

/**
 * Selecting rows across collapsible project groups.
 *
 * The behaviour worth naming is shift-click: it extends from the last row
 * clicked to this one, WITHIN one group. Ranges stop at the group boundary on
 * purpose — the groups are different building sites, and a shift-click that
 * spilled into the next site would quietly select material for a project the
 * user was not looking at.
 *
 * The set is replaced on every change, never mutated, so memoised rows below
 * re-render only when their own membership actually changed.
 */
export interface BedarfeSelection {
  selected: ReadonlySet<number>;
  count: number;
  isSelected: (id: number) => boolean;
  /** Plain click, or shift-click to extend the range inside `groupIds`. */
  toggle: (id: number, groupIds: readonly number[], extend: boolean) => void;
  /** The group header's tri-state checkbox. */
  setGroup: (groupIds: readonly number[], checked: boolean) => void;
  clear: () => void;
  /** Drop ids that are no longer on screen after a reload or a delete. */
  retain: (ids: readonly number[]) => void;
}

export function useBedarfeSelection(): BedarfeSelection {
  const [selected, setSelected] = useState<ReadonlySet<number>>(() => new Set<number>());
  const [anchorId, setAnchorId] = useState<number | null>(null);

  const toggle = useCallback(
    (id: number, groupIds: readonly number[], extend: boolean) => {
      setSelected((current) => {
        const next = new Set(current);
        const anchorIndex = anchorId == null ? -1 : groupIds.indexOf(anchorId);
        const targetIndex = groupIds.indexOf(id);
        if (extend && anchorIndex >= 0 && targetIndex >= 0) {
          const from = Math.min(anchorIndex, targetIndex);
          const to = Math.max(anchorIndex, targetIndex);
          // A range always ADDS: shift-clicking to correct an over-wide
          // selection is rare, and silently unselecting rows the user cannot
          // see (the group may scroll) is worse than one extra click.
          for (let index = from; index <= to; index += 1) next.add(groupIds[index]);
          return next;
        }
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
      setAnchorId(id);
    },
    [anchorId],
  );

  const setGroup = useCallback((groupIds: readonly number[], checked: boolean) => {
    setSelected((current) => {
      const next = new Set(current);
      for (const id of groupIds) {
        if (checked) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  }, []);

  const clear = useCallback(() => {
    setSelected(new Set<number>());
    setAnchorId(null);
  }, []);

  const retain = useCallback((ids: readonly number[]) => {
    const alive = new Set(ids);
    setSelected((current) => {
      const next = new Set<number>();
      for (const id of current) if (alive.has(id)) next.add(id);
      // Identity matters: an unchanged selection must not re-render the list.
      return next.size === current.size ? current : next;
    });
  }, []);

  const isSelected = useCallback((id: number) => selected.has(id), [selected]);

  return useMemo(
    () => ({ selected, count: selected.size, isSelected, toggle, setGroup, clear, retain }),
    [selected, isSelected, toggle, setGroup, clear, retain],
  );
}
