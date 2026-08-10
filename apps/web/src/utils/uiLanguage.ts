/**
 * The UI language, readable from outside React.
 *
 * App holds `language` in state and never persists it, which is fine for
 * everything rendered inside App. It does not help components mounted beside
 * App — the native file viewer and the server gate — which would otherwise have
 * to guess from `navigator.language` and get it wrong on any German crew member
 * whose phone is set to English.
 *
 * `<html lang>` is the natural place to publish it: the attribute has to be
 * correct anyway for screen readers and hyphenation, and App keeps it in sync.
 */
export type UiLanguage = "de" | "en";

/** Reads the language App published on <html lang>. German-first, like App. */
export function uiLanguage(): UiLanguage {
  if (typeof document === "undefined") return "de";
  return document.documentElement.lang.toLowerCase().startsWith("en") ? "en" : "de";
}

/** True when the UI is German. Convenience for the common `de ? … : …` shape. */
export function isGerman(): boolean {
  return uiLanguage() === "de";
}
