import { useEffect, useState } from "react";

/**
 * useIsMobileViewport — reactive viewport breakpoint detection for the
 * Werkstatt screens (and any future responsive page that needs to switch
 * rendered components rather than just tweak layout via CSS).
 *
 * Breakpoints match the Paper artboard widths:
 *   - mobile  : < 768px   (phone artboards are drawn at 390px)
 *   - tablet  : 768–1279px (tablet artboards are drawn at 768px)
 *   - desktop : ≥ 1280px
 *
 * The hook subscribes to `matchMedia` change events so the returned flags
 * update live when the user rotates a device or resizes a window. It is SSR
 * safe — during the first render on a server (or before hydration) all three
 * flags read false, which is then corrected on mount.
 *
 * Usage:
 *   const { isMobile, isTablet, isDesktop } = useIsMobileViewport();
 *   if (!isMobile) return null; // self-gate a mobile-only page
 */

export interface ViewportFlags {
  isMobile: boolean;
  isTablet: boolean;
  isDesktop: boolean;
}

const MOBILE_QUERY = "(max-width: 767px)";
const TABLET_QUERY = "(min-width: 768px) and (max-width: 1279px)";
const DESKTOP_QUERY = "(min-width: 1280px)";

function readFlags(): ViewportFlags {
  if (typeof window === "undefined" || !window.matchMedia) {
    return { isMobile: false, isTablet: false, isDesktop: false };
  }
  return {
    isMobile: window.matchMedia(MOBILE_QUERY).matches,
    isTablet: window.matchMedia(TABLET_QUERY).matches,
    isDesktop: window.matchMedia(DESKTOP_QUERY).matches,
  };
}

export function useIsMobileViewport(): ViewportFlags {
  const [flags, setFlags] = useState<ViewportFlags>(() => readFlags());

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return undefined;

    const mobileMql = window.matchMedia(MOBILE_QUERY);
    const tabletMql = window.matchMedia(TABLET_QUERY);
    const desktopMql = window.matchMedia(DESKTOP_QUERY);

    // Refresh from all three queries at once so we always return a
    // consistent snapshot (exactly one flag should be true at any moment).
    const refresh = () => setFlags(readFlags());

    mobileMql.addEventListener("change", refresh);
    tabletMql.addEventListener("change", refresh);
    desktopMql.addEventListener("change", refresh);

    // Sync once on mount in case the initial render happened while SSR
    // defaults were in effect.
    refresh();

    return () => {
      mobileMql.removeEventListener("change", refresh);
      tabletMql.removeEventListener("change", refresh);
      desktopMql.removeEventListener("change", refresh);
    };
  }, []);

  return flags;
}
