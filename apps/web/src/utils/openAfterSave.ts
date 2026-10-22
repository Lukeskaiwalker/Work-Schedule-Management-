/**
 * Open a server-rendered PDF only after the editor's autosave has landed.
 *
 * Every Verteilerplan PDF is drawn from the SAVED document, and autosave
 * waits for a pause in typing. A plain `<a target="_blank">` therefore showed
 * the board as it was a second ago — the breaker just added missing, with
 * nothing saying so.
 *
 * Waiting first and opening afterwards does not work either: iOS Safari (and
 * Chrome's popup blocker) let a tap open a window, but not a promise that
 * resolves after the tap. So the window is opened inside the tap, empty, and
 * pointed at the PDF once the saves have settled. A save that fails closes
 * it again rather than leave an empty tab or the old drawing behind.
 *
 * On the app surfaces (the iOS shell, the home-screen PWA) a link to the API
 * opens in the in-app viewer, whose interceptor runs before any onClick. The
 * PDF links therefore opt out of it (`OWN_OPENER_PROPS`) and hand the file
 * to the viewer themselves, after the saves — no window, so no popup rule.
 */
import { IS_APP_SURFACE } from "../native/shell";
import { openServerFile } from "../native/fileOpen";

export { OWN_OPENER_PROPS } from "../native/fileOpen";

export const PDF_NOT_SAVED =
  "PDF nicht geöffnet: Die Änderungen konnten nicht gespeichert werden — das PDF würde den alten Stand zeigen.";
export const PDF_BLOCKED =
  "Das PDF-Fenster wurde vom Browser blockiert — bitte Pop-ups für diese Seite erlauben.";

/**
 * `settleSaves` resolves true once the server holds the latest edits.
 * `report` gets a German sentence when the PDF was not opened. Resolves true
 * when the window was pointed at the PDF.
 */
export async function openAfterSave(
  url: string,
  settleSaves: () => Promise<boolean>,
  report: (message: string) => void,
): Promise<boolean> {
  // Before the first await, or the popup rule refuses it. No "noopener"
  // feature string: with it, window.open returns null and the window could
  // never be pointed at the PDF afterwards.
  const win = window.open("", "_blank");
  if (!win) {
    report(PDF_BLOCKED);
    return false;
  }
  // What rel="noopener" did for the old link: the PDF tab cannot reach back.
  win.opener = null;

  let saved = false;
  try {
    saved = await settleSaves();
  } catch {
    saved = false;
  }
  if (!saved) {
    win.close();
    report(PDF_NOT_SAVED);
    return false;
  }
  win.location.href = url;
  return true;
}

export const PAGE_NOT_SAVED =
  "Seite nicht neu geladen: Die Änderungen konnten nicht gespeichert werden — sie gingen sonst verloren.";

/**
 * Reload the page, but only once the server holds the latest edits — a
 * reload drops whatever autosave still waits for. Used where nothing short
 * of a reload helps (a 3D chunk a deploy removed). `reload` is injectable
 * for tests; the app reloads the window.
 */
export async function reloadAfterSave(
  settleSaves: () => Promise<boolean>,
  report: (message: string) => void,
  reload: () => void = () => window.location.reload(),
): Promise<boolean> {
  let saved = false;
  try {
    saved = await settleSaves();
  } catch {
    saved = false;
  }
  if (!saved) {
    report(PAGE_NOT_SAVED);
    return false;
  }
  reload();
  return true;
}

/** The parts of a mouse event that say whether the browser should handle a link click itself. */
export type LinkClick = Pick<MouseEvent, "button" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey">;

/**
 * A plain primary click. Anything else — middle click, cmd/ctrl-click for a
 * background tab, shift for a window, alt for a download — stays the
 * browser's: whoever asks for that knows they get the saved state.
 */
export function isPlainClick(event: LinkClick): boolean {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

/**
 * The in-app viewer's twin of `openAfterSave`: settle, then hand the file to
 * the viewer (which fetches it with the session). Nothing opens on a failed
 * save, for the same reason as there.
 */
export async function openInAppAfterSave(
  path: string,
  name: string,
  settleSaves: () => Promise<boolean>,
  report: (message: string) => void,
): Promise<boolean> {
  let saved = false;
  try {
    saved = await settleSaves();
  } catch {
    saved = false;
  }
  if (!saved) {
    report(PDF_NOT_SAVED);
    return false;
  }
  openServerFile(path, name);
  return true;
}

/**
 * The click handler of a PDF link (which also spreads `OWN_OPENER_PROPS`): a
 * plain tap waits for the saves, any other click is left to the browser. The
 * link keeps its `href`, so a long-press "in neuem Tab öffnen" still works.
 * `name` is what the in-app viewer shows until the file names itself.
 */
export function savedPdfClick(
  href: string,
  settleSaves: () => Promise<boolean>,
  report: (message: string) => void,
  name = "PDF",
): (event: LinkClick & { preventDefault(): void }) => void {
  return (event) => {
    if (!isPlainClick(event)) return;
    event.preventDefault();
    if (IS_APP_SURFACE) void openInAppAfterSave(href, name, settleSaves, report);
    else void openAfterSave(href, settleSaves, report);
  };
}
