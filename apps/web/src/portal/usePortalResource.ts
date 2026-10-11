// Load one portal resource, and keep it fresh without a live event stream.
//
// The office app gets pushed updates over SSE; a partner login is refused
// there on purpose (the stream carries internal events). So the portal
// re-reads when it matters: when the tab comes back into view — the phone
// taken out of the pocket at the next site — and once a minute while it is
// visible. That is how a job the office assigns shows up in the panel.

import { useCallback, useEffect, useRef, useState } from "react";

export const PORTAL_REFRESH_MS = 60_000;

type State<T> = { data: T | null; error: unknown; loading: boolean };

export function usePortalResource<T>(load: (() => Promise<T>) | null, key: string) {
  const [state, setState] = useState<State<T>>({ data: null, error: null, loading: Boolean(load) });
  const loadRef = useRef(load);
  loadRef.current = load;
  const generation = useRef(0);

  const run = useCallback(async (quiet: boolean) => {
    const loader = loadRef.current;
    if (!loader) return;
    const mine = ++generation.current;
    if (!quiet) setState((previous) => ({ ...previous, loading: true, error: null }));
    try {
      const data = await loader();
      // A slower, older request must never overwrite a newer answer.
      if (mine === generation.current) setState({ data, error: null, loading: false });
    } catch (error) {
      if (mine === generation.current) setState((previous) => ({ ...previous, error, loading: false }));
    }
  }, []);

  useEffect(() => {
    setState({ data: null, error: null, loading: Boolean(loadRef.current) });
    void run(false);
  }, [key, run]);

  useEffect(() => {
    if (!loadRef.current) return undefined;
    const refreshIfVisible = () => {
      if (document.visibilityState === "visible") void run(true);
    };
    const timer = window.setInterval(refreshIfVisible, PORTAL_REFRESH_MS);
    document.addEventListener("visibilitychange", refreshIfVisible);
    window.addEventListener("focus", refreshIfVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refreshIfVisible);
      window.removeEventListener("focus", refreshIfVisible);
    };
  }, [key, run]);

  const reload = useCallback(() => run(true), [run]);
  const replace = useCallback((data: T) => setState({ data, error: null, loading: false }), []);
  return { ...state, reload, replace };
}
