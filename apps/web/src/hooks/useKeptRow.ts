import { useEffect, useRef } from "react";

/**
 * Keep the last value a lookup resolved to, so a dialog outlives a refetch.
 *
 * The Werkstatt stock dialogs render as `{row && <Modal …>}` where `row` is
 * looked up by id in the freshly fetched list. Looking it up every render is
 * deliberate — it is how a booking's new counters flow into the open dialog
 * instead of it showing figures the server has already called stale.
 *
 * But it also means a refetch that does not return that article — a search
 * narrowed by a stray barcode scan, a filter, a colleague archiving the row —
 * unmounts the dialog mid-edit, taking the typed amount, the reason and any
 * error message with it. The work is lost without anyone deciding to lose it.
 *
 * So: live value when there is one, otherwise the last one seen for the SAME
 * key. The key check matters — falling back across a change of key would show
 * one article's numbers under another article's name.
 *
 * `key === null` means nothing is open, and answers null rather than whatever
 * was open last.
 */
export function useKeptRow<T>(live: T | null, key: number | string | null): T | null {
  const kept = useRef<{ key: number | string; value: T } | null>(null);

  useEffect(() => {
    if (key !== null && live !== null) kept.current = { key, value: live };
  }, [key, live]);

  if (key === null) return null;
  if (live !== null) return live;
  const previous = kept.current;
  return previous && previous.key === key ? previous.value : null;
}
