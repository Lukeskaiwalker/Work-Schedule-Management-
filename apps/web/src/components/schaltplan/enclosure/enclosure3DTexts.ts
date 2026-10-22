/**
 * German copy of the 3D view (docs/PANEL_ENCLOSURE.md §11 "3D"), shared by
 * the lazy view and its boundary. Its own module, free of `three`, so the
 * boundary can use it without pulling the 3D chunk in.
 */
export const LOADING_TEXT = "3D wird geladen…";
export const UNSUPPORTED_TEXT = "3D ist auf diesem Gerät nicht verfügbar — die 2D-Ansicht zeigt dasselbe.";
export const FAILED_TEXT = "3D konnte nicht geladen werden.";
export const RELOAD_LABEL = "3D neu laden";
export const EXIT_LABEL = "2D";
export const RELOAD_PAGE_LABEL = "Seite neu laden";
/** Under the buttons once a retry failed too, or the browser said the chunk is gone. */
export const RELOAD_PAGE_HINT = "Nach einem Update der App fehlt die alte 3D-Datei — dann hilft nur „Seite neu laden“. Änderungen werden vorher gespeichert.";
