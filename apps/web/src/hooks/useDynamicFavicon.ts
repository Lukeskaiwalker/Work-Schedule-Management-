import { useEffect } from "react";

/**
 * v2.5.27 — drive the browser tab icon from the configured company logo.
 *
 * Calling `useDynamicFavicon(companySettings?.logo_url)` swaps the
 * favicon (and the Apple touch icon, for iOS home-screen installs) to
 * whatever URL the admin has set in Admin Center → Company settings.
 * Falsy / empty values leave the existing icon in place, so a config
 * deployment with no logo configured looks identical to today.
 *
 * Implementation notes:
 *
 *   • Browsers aggressively cache favicons by *URL*. Simply mutating
 *     the `href` of an existing `<link rel="icon">` doesn't reliably
 *     trigger a refresh in Chrome/Safari. The trick is to remove the
 *     old element and append a new one — the DOM mutation forces the
 *     browser to refetch.
 *
 *   • Three link relations are updated:
 *       - rel="icon"                  → modern browsers
 *       - rel="shortcut icon"         → legacy fallback (older Edge/IE)
 *       - rel="apple-touch-icon"      → iOS "Add to Home Screen"
 *     The PWA manifest is *not* updated at runtime — that's a static
 *     file and is only consulted at install time.
 *
 *   • The hook is intentionally idempotent: if the same URL is set
 *     twice in a row (e.g. the auth refetch returns the same value),
 *     the second pass is a no-op because we compare against the
 *     existing `href` before mutating.
 */
export function useDynamicFavicon(logoUrl: string | null | undefined): void {
  useEffect(() => {
    const url = (logoUrl || "").trim();
    if (!url) return;

    const relations: readonly string[] = ["icon", "shortcut icon", "apple-touch-icon"];
    const inserted: HTMLLinkElement[] = [];

    for (const rel of relations) {
      // Find the existing link of this relation, if any. There can be
      // more than one (the template ships an apple-touch-icon, the SPA
      // may have added an "icon" earlier in the session). Remove all
      // matching elements so the browser only sees the new one.
      const existing = Array.from(document.head.querySelectorAll(`link[rel="${rel}"]`));
      const sameHref = existing.find(
        (link) => link instanceof HTMLLinkElement && link.href === new URL(url, document.baseURI).href,
      );
      if (sameHref && existing.length === 1) {
        // Already pointing at the right URL — nothing to do.
        continue;
      }
      for (const link of existing) link.parentElement?.removeChild(link);

      const link = document.createElement("link");
      link.rel = rel;
      link.href = url;
      document.head.appendChild(link);
      inserted.push(link);
    }

    // Cleanup: if the component unmounts (won't happen for App, but
    // makes the hook safe to use elsewhere too) we leave the icons in
    // place — there's nothing to revert to since the original
    // template doesn't have a <link rel="icon"> at all. If the URL
    // changes, the next run of this effect removes the previously
    // inserted nodes via the querySelectorAll sweep above, so we don't
    // leak link elements over time.
    return () => {
      // No-op by design — see comment above.
      void inserted;
    };
  }, [logoUrl]);
}
