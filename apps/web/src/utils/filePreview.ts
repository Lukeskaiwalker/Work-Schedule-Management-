/**
 * What the click-through viewer needs to know about a file before it renders
 * one: which family its content type belongs to, where its bytes live, and
 * whether this engine can draw a PDF in a frame at all.
 *
 * Kept out of the component because none of it is React's: predicates, URL
 * shapes, a swipe threshold and two navigator probes are all things you want
 * to reason about — and test — without a dialog around them.
 */
import { fetchAuthorizedJson, fetchFile } from "../native/fileOpen";
import { apiUrl } from "../native/shell";
import type { UiLanguage } from "./uiLanguage";

/* ── Content types ─────────────────────────────────────────────────────── */

/** `text/plain; charset=utf-8` and `TEXT/PLAIN` are the same family. */
export function normalizeContentType(raw: string): string {
  return (raw ?? "").split(";")[0].trim().toLowerCase();
}

export function isImageType(contentType: string): boolean {
  return normalizeContentType(contentType).startsWith("image/");
}

export function isPdfType(contentType: string): boolean {
  return normalizeContentType(contentType) === "application/pdf";
}

export function isTextType(contentType: string): boolean {
  return normalizeContentType(contentType).startsWith("text/");
}

/**
 * The families the lightbox can show in place. Everything else gets the
 * download panel — and stays in the sequence, so "next" never skips a file.
 */
export function isLightboxPreviewable(contentType: string): boolean {
  return isImageType(contentType) || isPdfType(contentType) || isTextType(contentType);
}

/* ── URLs ──────────────────────────────────────────────────────────────── */

// These feed href/src attributes rather than fetch(), so the native network
// bridge never sees them — they have to be absolutised here or the WebView
// would look for the file inside the app bundle. Same pair as App.tsx keeps
// for its own file rows.
export function filePreviewUrl(id: number): string {
  return apiUrl(`/api/files/${id}/preview`);
}

export function fileDownloadUrl(id: number): string {
  return apiUrl(`/api/files/${id}/download`);
}

/** The base answers the page count; `${base}/{n}` is one rendered page. */
export function filePagesUrl(id: number): string {
  return apiUrl(`/api/files/${id}/preview-pages`);
}

/* ── PDF capability probes ─────────────────────────────────────────────── */
// Copies of the two probes in components/shared/NativeFileViewer.tsx, not
// imports: scripts/check-pdf-preview-probes.mjs lifts them out of THAT file
// by name to exercise them with bare node, so they have to stay declared
// there. Keep the two pairs identical — the "iOS shows only page 1" report
// is what they exist to prevent, and it would come back one viewer at a time.

/**
 * True when this engine cannot draw a PDF at all. Chrome on Android reports
 * `navigator.pdfViewerEnabled === false` — the frame loads but Chromium only
 * paints its sad-page placeholder behind it. Engines that predate the API
 * report `undefined`, which counts as capable.
 */
export function pdfFrameUnsupported(): boolean {
  return (navigator as { pdfViewerEnabled?: boolean }).pdfViewerEnabled === false;
}

/**
 * True on iOS/iPadOS, where a framed PDF renders as page one and nothing else.
 * "Has a PDF renderer" and "renders a framed PDF usefully" are separate
 * capabilities and only the first has a standard probe, so this one is a UA
 * sniff. iPadOS 13+ reports a desktop `Macintosh` UA; `maxTouchPoints` is
 * the documented way to tell an iPad from a Mac.
 */
export function pdfFrameShowsFirstPageOnly(): boolean {
  const ua = navigator.userAgent || "";
  if (/\b(iPhone|iPad|iPod)\b/.test(ua)) return true;
  return /\bMacintosh\b/.test(ua) && (navigator.maxTouchPoints ?? 0) > 1;
}

/** True where a PDF has to be served as page images rather than framed. */
export function pdfNeedsPager(): boolean {
  return pdfFrameUnsupported() || pdfFrameShowsFirstPageOnly();
}

/* ── Paged PDFs ────────────────────────────────────────────────────────── */

/**
 * Same ceilings as the native viewer, measured on the same 151-page manual:
 * twelve pages is a few MB at the top end, and prefetching only one page
 * forward keeps a reader who fans out from queueing against the server's
 * render semaphore of two.
 */
export const MAX_CACHED_PAGES = 12;
export const PREFETCH_AHEAD = 1;

/** The page count, or a rejection — a document with no pages cannot be paged. */
export async function loadPageCount(id: number): Promise<number> {
  const meta = await fetchAuthorizedJson<{ page_count?: number }>(filePagesUrl(id));
  const count = Number(meta?.page_count) || 0;
  if (count < 1) throw new Error("no pages");
  return count;
}

/* ── Text files ────────────────────────────────────────────────────────── */

/**
 * The file's text, fetched with the bearer token where one is needed. Read
 * from the Blob, never from its object URL: `fetch("blob:…")` is governed by
 * `connect-src`, which does not list blob:, and that is how every text file
 * once reported "could not be loaded" while sitting decoded in memory.
 */
export async function loadTextFile(id: number, name: string): Promise<string> {
  const fetched = await fetchFile({ url: filePreviewUrl(id), name, intent: "view" });
  try {
    return await fetched.blob.text();
  } finally {
    URL.revokeObjectURL(fetched.objectUrl);
  }
}

/* ── Failures ──────────────────────────────────────────────────────────── */

export type LoadFailure = "forbidden" | "failed";

/** The authorised fetch helpers throw the HTTP status as the message. */
export function classifyLoadError(err: unknown): LoadFailure {
  const status = String((err as Error | null)?.message ?? "");
  return status === "401" || status === "403" ? "forbidden" : "failed";
}

export function loadFailureText(failure: LoadFailure, language: UiLanguage): string {
  const de = language === "de";
  if (failure === "forbidden") {
    return de ? "Keine Berechtigung für diese Datei." : "Not authorised to open this file.";
  }
  return de ? "Datei konnte nicht geladen werden." : "The file could not be loaded.";
}

/* ── Dialog plumbing ───────────────────────────────────────────────────── */

let scrollLocks = 0;
let overflowBeforeLock = "";

/**
 * Stop the page scrolling behind a full-screen overlay. Counted rather than
 * saved per caller: two overlays that close in the other order than they
 * opened would otherwise leave the page locked, each restoring what it saw.
 * (The sidebar drawer's plain save/restore is fine — there is only one of it.)
 */
export function lockBodyScroll(): () => void {
  if (scrollLocks === 0) {
    overflowBeforeLock = document.body.style.overflow;
    document.body.style.overflow = "hidden";
  }
  scrollLocks += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    scrollLocks -= 1;
    if (scrollLocks === 0) document.body.style.overflow = overflowBeforeLock;
  };
}

/** Arrow keys inside a field are the field's, not the viewer's. */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName);
}

/* ── Stepping ──────────────────────────────────────────────────────────── */

/** Wrap-around stepping, so the end of the sequence leads back to its start. */
export function wrapIndex(index: number, total: number): number {
  if (total < 1) return 0;
  return ((index % total) + total) % total;
}

/** A parent may hand over an index that the sequence no longer has. */
export function clampIndex(index: number, total: number): number {
  if (total < 1) return 0;
  return Math.min(Math.max(index, 0), total - 1);
}

export type Point = { x: number; y: number };

/**
 * Deliberately strict: 40 px, and clearly more horizontal than vertical,
 * because a tall page or a long text scrolls vertically on the same stage
 * and stealing that would be worse than having no swipe at all.
 */
export const SWIPE_MIN_DISTANCE = 40;

/** +1 for a swipe to the left (next), -1 for one to the right, 0 for neither. */
export function swipeStep(start: Point, end: Point): -1 | 0 | 1 {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  if (Math.abs(dx) < SWIPE_MIN_DISTANCE || Math.abs(dx) < Math.abs(dy) * 1.5) return 0;
  return dx < 0 ? 1 : -1;
}
