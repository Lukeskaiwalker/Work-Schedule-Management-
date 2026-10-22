import { useEffect, useRef } from "react";

import type { PanelPlanSummary } from "../types/schaltplan";
import { clearPendingPanel, peekPendingPanel } from "../utils/schaltplanHandoff";

/**
 * SchaltplanPage's half of the start-page handoff (docs/DASHBOARD.md §9.5;
 * utils/schaltplanHandoff.ts holds the other half).
 *
 * On mount it peeks at the panel a „Zuletzt bearbeitete Verteiler“ row asked
 * for and hands it to `pick` — the page's own „Zuletzt bearbeitet“ pick,
 * which scopes the picker and opens the panel. It clears the request only once
 * `openedPanelId` shows that panel, so an open that failed (the error banner
 * says so) is not lost with it, and it lapses on its own after 30 s.
 *
 * React.StrictMode (main.tsx) runs the mount effect twice on one instance. The
 * request survives that because it is only peeked; the ref keeps the second
 * run from asking the server for the same panel again.
 *
 * Kept out of the page so the page's change is one import and one call: a
 * parallel branch is reworking SchaltplanPage.tsx.
 */
export function usePendingPanelHandoff(
  pick: (summary: PanelPlanSummary) => void,
  openedPanelId: number | null,
): void {
  // The latest pick without making it a mount-effect dependency: the page
  // rebuilds it whenever its token or label hooks change.
  const pickRef = useRef(pick);
  pickRef.current = pick;
  const pickedIdRef = useRef<number | null>(null);

  useEffect(() => {
    const pending = peekPendingPanel();
    if (!pending || pickedIdRef.current === pending.id) return;
    pickedIdRef.current = pending.id;
    pickRef.current(pending);
  }, []);

  useEffect(() => {
    if (openedPanelId === null) return;
    if (peekPendingPanel()?.id === openedPanelId) clearPendingPanel();
  }, [openedPanelId]);
}
