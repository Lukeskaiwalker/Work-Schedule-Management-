import { useEffect, useState } from "react";

import type { DashboardDevice } from "../types/dashboard";
import { deviceFromMatches } from "../utils/dashboardLayout";

/**
 * Which of the user's three layouts this screen shows (docs/DASHBOARD.md D9,
 * §9.2): `(min-width: 1280px)` → desktop, else `(min-width: 768px)` → tablet,
 * else mobile.
 *
 * Two queries and nothing else, so no fractional width falls between
 * breakpoints. The first value is read synchronously, so the first paint
 * already shows the right layout. Later changes wait 200 ms: a window dragged
 * across 1280 px would otherwise swap layouts — and remount every widget —
 * on each frame of the drag.
 *
 * Deliberately separate from useIsMobileViewport and the Sidebar's 900 px
 * drawer breakpoint, which answer other questions. An iPad Pro 13" is tablet
 * in portrait and desktop in landscape; the owner accepted that (Q5).
 */
const TABLET_QUERY = "(min-width: 768px)";
const DESKTOP_QUERY = "(min-width: 1280px)";
const SETTLE_MS = 200;

function mediaQuery(query: string): MediaQueryList | null {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return null;
  return window.matchMedia(query);
}

function readDevice(): DashboardDevice {
  const tablet = mediaQuery(TABLET_QUERY);
  const desktop = mediaQuery(DESKTOP_QUERY);
  return deviceFromMatches(tablet?.matches === true, desktop?.matches === true);
}

function listen(list: MediaQueryList, listener: () => void): () => void {
  // Safari before 14 only knows the deprecated addListener.
  if (typeof list.addEventListener === "function") {
    list.addEventListener("change", listener);
    return () => list.removeEventListener("change", listener);
  }
  list.addListener(listener);
  return () => list.removeListener(listener);
}

export function useDashboardDevice(): DashboardDevice {
  const [device, setDevice] = useState<DashboardDevice>(readDevice);

  useEffect(() => {
    const lists = [mediaQuery(TABLET_QUERY), mediaQuery(DESKTOP_QUERY)].filter(
      (list): list is MediaQueryList => list !== null,
    );
    let timer: ReturnType<typeof setTimeout> | null = null;
    const settle = () => {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        setDevice(readDevice());
      }, SETTLE_MS);
    };
    const stops = lists.map((list) => listen(list, settle));
    // The width may have changed between the first render and this effect.
    setDevice(readDevice());
    return () => {
      if (timer !== null) clearTimeout(timer);
      stops.forEach((stop) => stop());
    };
  }, []);

  return device;
}
