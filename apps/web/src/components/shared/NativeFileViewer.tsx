/**
 * In-app file viewer for the native shell and the installed PWA.
 *
 * Mounted once at the app root and dormant until a link to an /api file is
 * clicked (see native/fileOpen.ts). Renders nothing at all in a browser tab,
 * where links open a tab and already work.
 *
 * Everything is fetched and displayed from an object URL. In the shell that is
 * the only way to show a server file at all — the request has to carry a bearer
 * token and a plain link cannot. In the PWA the fetch would succeed either way;
 * what it buys there is staying inside the app instead of being handed to
 * Safari.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import {
  fetchAuthorizedBlobUrl,
  fetchAuthorizedJson,
  fetchFile,
  setFileOpenHandler,
  type FetchedFile,
  type OpenFileRequest,
} from "../../native/fileOpen";
import { IS_APP_SURFACE } from "../../native/shell";
import { createPageCache, type PageCache } from "../../utils/pdfPageCache";
import { isGerman } from "../../utils/uiLanguage";

type Phase = "idle" | "loading" | "ready" | "error" | "saving";

/**
 * What happened when the bytes were handed to the OS.
 *  - `shared`   — the share sheet took them.
 *  - `aborted`  — the sheet opened and the user dismissed it. Deliberate, so
 *                 it must not trigger a fallback; that would turn "cancel"
 *                 into "download anyway".
 *  - `declined` — no share path available or it refused. The caller has to
 *                 offer something else rather than assume success.
 */
type SaveOutcome = "shared" | "aborted" | "declined";

/**
 * How many rendered pages to keep as object URLs.
 *
 * Measured on the worst real document in production (a 151-page SUN2000
 * inverter manual): pages come back as 66–436 KB PNGs, so twelve is a few MB
 * at the top end and well under one for a typical report. Enough that paging
 * back through what you just read never touches the network.
 */
const MAX_CACHED_PAGES = 12;

/**
 * Pages to pull ahead of the one on screen.
 *
 * Only forward. Backward needs no prefetch — you were just there, so it is
 * already cached — and the server renders with a semaphore of 2, so a user
 * who fans out in both directions starts queueing against themselves.
 */
const PREFETCH_AHEAD = 1;

function isImage(type: string): boolean {
  return type.startsWith("image/");
}
function isPdf(type: string): boolean {
  return type === "application/pdf";
}
function isText(type: string): boolean {
  return type.startsWith("text/") || type === "application/json";
}

/**
 * True when this engine cannot draw a PDF at all. Chrome on Android reports
 * `navigator.pdfViewerEnabled === false` — the frame loads but Chromium only
 * paints its sad-page placeholder behind it. Engines that predate the API
 * report `undefined`, which counts as capable.
 *
 * Note what this does NOT answer: whether a PDF renders usefully *in a frame*.
 * See `pdfFrameShowsFirstPageOnly`.
 */
function pdfFrameUnsupported(): boolean {
  return (navigator as { pdfViewerEnabled?: boolean }).pdfViewerEnabled === false;
}

/**
 * True on iOS/iPadOS, where a framed PDF renders as page one and nothing else.
 *
 * WebKit draws PDFs in a subframe as a single static page: no scrolling, no
 * page controls, no way to reach page 2. Only a top-level navigation gets the
 * real multi-page viewer, and this app has no top level to navigate to — the
 * whole reason the viewer exists is that an installed PWA cannot open a tab.
 *
 * This is why `pdfViewerEnabled` alone was the wrong gate: iOS answers `true`
 * (it does have a renderer), took the frame path, and every multi-page
 * document showed only its first page. "Has a PDF renderer" and "renders a
 * framed PDF usefully" are separate capabilities and only the first has a
 * standard probe, so this one is a UA sniff — deliberately, and narrowly.
 *
 * iPadOS 13+ reports a desktop `Macintosh` UA; `maxTouchPoints` is the
 * documented way to tell an iPad from a Mac. A Mac running the installed PWA
 * reports 0 and correctly keeps the frame.
 */
function pdfFrameShowsFirstPageOnly(): boolean {
  const ua = navigator.userAgent || "";
  if (/\b(iPhone|iPad|iPod)\b/.test(ua)) return true;
  return /\bMacintosh\b/.test(ua) && (navigator.maxTouchPoints ?? 0) > 1;
}

/**
 * The paged-preview base for an attachment URL, or null when the file is not
 * an attachment (e.g. the training-report PDF) — those fall back to a hint.
 * Works on absolute (native shell) and relative (PWA) URLs alike, because it
 * only rewrites the suffix.
 */
function pagesBaseFor(sourceUrl: string): string | null {
  const match = /^(.*\/api\/files\/\d+)\/(preview|download)(?:\?.*)?$/.exec(sourceUrl);
  return match ? `${match[1]}/preview-pages` : null;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function Viewer() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [file, setFile] = useState<FetchedFile | null>(null);
  const [textBody, setTextBody] = useState<string>("");
  const [failure, setFailure] = useState<string>("");
  // Paged-PDF mode (engines without an inline PDF renderer): the source URL
  // of the open request, the page count, the current page and its object URL.
  const [sourceUrl, setSourceUrl] = useState<string>("");
  const [pageCount, setPageCount] = useState<number>(0);
  const [page, setPage] = useState<number>(1);
  const [pageUrl, setPageUrl] = useState<string>("");
  // True only while a page the user is *waiting for* is in flight. A prefetch
  // never sets it: the point of prefetching is that it is invisible.
  const [pageLoading, setPageLoading] = useState(false);
  const [pageError, setPageError] = useState(false);
  // Draft value of the page box while it is being typed in, and of the slider
  // while it is being dragged. Both are held locally so that neither fires a
  // render request per keystroke or per pixel of drag.
  const [pageDraft, setPageDraft] = useState<string>("");
  const [scrubPage, setScrubPage] = useState<number | null>(null);
  // Whether the page-count probe has answered yet. `pageCount === 0` alone
  // cannot say: it is both "not asked yet" and "asked and failed", and those
  // need opposite fallbacks — wait, versus drop back to the frame.
  const [pagesProbe, setPagesProbe] = useState<"pending" | "ok" | "failed">("pending");
  /**
   * Rendered pages. A displayed URL is only ever borrowed from here — the
   * cache owns it, so nothing else may revoke it or paging back would show a
   * broken image. Created lazily because the base URL is not known until a
   * file is open.
   */
  const pageCacheRef = useRef<PageCache | null>(null);

  // Read per render rather than once: the user can toggle DE/EN while the app
  // is running, and App republishes it on <html lang>.
  const de = isGerman();

  // The object URL must outlive render but be revoked on close, so it is
  // tracked in a ref as well as state — state is gone by the time cleanup runs.
  const objectUrlRef = useRef<string | null>(null);

  const release = useCallback(() => {
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    }
  }, []);

  /** Drop every cached page. Called on close, on open, and on unmount. */
  const releasePage = useCallback(() => {
    pageCacheRef.current?.clear();
    pageCacheRef.current = null;
  }, []);

  /**
   * One rendered page, from cache when possible. The cache is rebuilt per
   * document, so the base URL is captured at creation and a new file can never
   * read the previous one's pages.
   */
  const acquirePage = useCallback((base: string, wanted: number): Promise<string> => {
    if (!pageCacheRef.current) {
      pageCacheRef.current = createPageCache({
        maxEntries: MAX_CACHED_PAGES,
        fetchPage: (n) => fetchAuthorizedBlobUrl(`${base}/${n}`),
      });
    }
    return pageCacheRef.current.acquire(wanted);
  }, []);

  const close = useCallback(() => {
    release();
    releasePage();
    setFile(null);
    setTextBody("");
    setFailure("");
    setSourceUrl("");
    setPageCount(0);
    setPagesProbe("pending");
    setPage(1);
    setPageUrl("");
    setPhase("idle");
  }, [release, releasePage]);

  /**
   * Offer `target`'s bytes to the OS share sheet.
   *
   * Split out of `save` so a save-intent click can reach it without a viewer
   * render in between. Reports what happened instead of swallowing it, because
   * the two callers want different things from a refusal.
   */
  const offerToShareSheet = useCallback(async (target: FetchedFile): Promise<SaveOutcome> => {
    // Prefer the OS share sheet: on Android's installed PWA a programmatic
    // blob <a download> silently does nothing (the second half of the field
    // report — "download did not work either"), while share with files is
    // reliable and offers "save to Files/Drive". AbortError = user closed
    // the sheet; that is not a failure and must not trigger the fallback,
    // or cancelling would immediately start a download.
    try {
      const nav = navigator as Navigator & {
        canShare?: (data: { files: File[] }) => boolean;
        share?: (data: { files: File[]; title?: string }) => Promise<void>;
      };
      const asFile = new File([target.blob], target.name || "download", {
        type: target.contentType || "application/octet-stream",
      });
      if (nav.canShare?.({ files: [asFile] }) && nav.share) {
        await nav.share({ files: [asFile], title: target.name });
        return "shared";
      }
    } catch (err) {
      if ((err as Error)?.name === "AbortError") return "aborted";
      // Anything else — including iOS refusing the call because the user
      // gesture expired while the file was downloading — is a decline.
    }
    return "declined";
  }, []);

  /** Write `target` to the downloads folder via a synthetic anchor. */
  const offerToAnchor = useCallback((target: FetchedFile) => {
    const anchor = document.createElement("a");
    anchor.href = target.objectUrl;
    anchor.download = target.name || "download";
    anchor.rel = "noreferrer";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  }, []);

  const open = useCallback(
    (request: OpenFileRequest) => {
      release();
      releasePage();
      setFile(null);
      setTextBody("");
      setFailure("");
      setSourceUrl(request.url);
      setPageCount(0);
      setPagesProbe("pending");
      setPage(1);
      setPageUrl("");

      /**
       * A save-intent click never renders the document. It used to: every
       * intercepted link landed in the viewer, so "Download" beside "Vorschau"
       * re-opened the file the user was already looking at and saving took a
       * second tap inside it.
       *
       * The bytes still have to be fetched first (that is what the bearer
       * token is for), which is why this cannot be a plain link. Fetching
       * costs the user gesture, and iOS may then refuse `share()` for want of
       * transient activation — so a refusal falls back to the viewer with its
       * Save button rather than failing silently. That is the old two-tap
       * flow, reached only when the one-tap path is genuinely unavailable.
       */
      if (request.intent === "save") {
        setPhase("saving");
        void fetchFile(request)
          .then(async (fetched) => {
            objectUrlRef.current = fetched.objectUrl;
            setFile(fetched);
            const outcome = await offerToShareSheet(fetched);
            if (outcome === "shared" || outcome === "aborted") {
              close();
              return;
            }
            // No share path. Not worth trying the anchor unattended here:
            // this viewer only ever runs on an app surface (installed PWA or
            // WKWebView), and those are precisely where a programmatic blob
            // anchor can no-op silently — which would look like the tap did
            // nothing. Show the file with its Save button instead, so the
            // fallback is something the user can see and act on.
            //
            // That state renders the file for real, so anything the view path
            // prepares has to be prepared here too — a text body is read from
            // the blob, not from the object URL, or the <pre> shows empty.
            if (isText(fetched.contentType)) {
              setTextBody(await fetched.blob.text());
            }
            setPhase("ready");
          })
          .catch(() => {
            setFailure(
              de ? "Datei konnte nicht geladen werden." : "The file could not be loaded.",
            );
            setPhase("error");
          });
        return;
      }

      setPhase("loading");

      void fetchFile(request)
        .then(async (fetched) => {
          objectUrlRef.current = fetched.objectUrl;
          if (isText(fetched.contentType)) {
            // Read the text out now so the body can render it directly; an
            // object URL in an iframe would be a second navigation for nothing.
            //
            // Read from the Blob, not from its object URL. `fetch("blob:…")` is
            // a fetch like any other and is checked against `connect-src`, which
            // does not list blob: — so this threw a CSP error, the rejection
            // escaped to the catch below, and every text file reported "could
            // not be loaded" while sitting decoded in memory. Blob.text() is a
            // local read with no request and no policy to satisfy.
            const body = await fetched.blob.text();
            setTextBody(body);
          }
          setFile(fetched);
          setPhase("ready");
        })
        .catch((err: unknown) => {
          const status = String((err as Error)?.message ?? "");
          setFailure(
            status === "401" || status === "403"
              ? de
                ? "Keine Berechtigung für diese Datei."
                : "Not authorised to open this file."
              : de
                ? "Datei konnte nicht geladen werden."
                : "The file could not be loaded.",
          );
          setPhase("error");
        });
    },
    [de, release, releasePage, close, offerToShareSheet],
  );

  /**
   * Hand the fetched bytes to the OS.
   *
   * Downloading was broken on every app surface, and not because downloads
   * are hard: `fileOpen` intercepts *any* /api link, so a "Herunterladen"
   * link was captured and handed to this viewer — which had no way to save
   * anything. The file was fetched, shown if it happened to be renderable,
   * and otherwise the tap simply did nothing.
   *
   * Interception cannot be dropped for download links, because that is what
   * attaches the bearer token; a bare link 401s in the native shell. So the
   * saving has to live here, where the bytes already are.
   *
   * A synthetic `<a download>` over the existing object URL is the portable
   * form: Safari and WKWebView route it to the share sheet, everything else
   * writes it to the downloads folder.
   */
  /** The viewer's own Save button: share sheet first, anchor as the fallback. */
  const save = useCallback(async () => {
    if (!file) return;
    const outcome = await offerToShareSheet(file);
    if (outcome === "shared" || outcome === "aborted") return;
    offerToAnchor(file);
  }, [file, offerToShareSheet, offerToAnchor]);

  useEffect(() => {
    setFileOpenHandler(open);
    return () => setFileOpenHandler(null);
  }, [open]);

  /**
   * Serve the document as server-rendered page images when the frame cannot do
   * the job: Chromium on Android draws nothing at all, and WebKit draws only
   * page one. Both end up here; what differs is their fallback when a file has
   * no pages endpoint (only attachments do — a training report does not).
   */
  const pdfNeedsPages =
    !!file && isPdf(file.contentType) && (pdfFrameUnsupported() || pdfFrameShowsFirstPageOnly());
  const pagesBase = pdfNeedsPages ? pagesBaseFor(sourceUrl) : null;

  useEffect(() => {
    if (phase !== "ready" || !pagesBase) return;
    let cancelled = false;
    fetchAuthorizedJson<{ page_count: number }>(pagesBase)
      .then((meta) => {
        if (cancelled) return;
        const count = Number(meta.page_count) || 0;
        setPageCount(count);
        // A document that reports no pages is not something the pager can
        // show; treat it like a failed probe so the frame still gets a turn.
        setPagesProbe(count > 0 ? "ok" : "failed");
      })
      .catch(() => {
        if (!cancelled) {
          setPageCount(0);
          setPagesProbe("failed");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [phase, pagesBase]);

  useEffect(() => {
    if (phase !== "ready" || !pagesBase || pageCount < 1) return;
    let cancelled = false;
    const base = pagesBase;
    const wanted = page;

    // A cache hit must not flash a spinner — that is the whole point of the
    // cache. Only an actual wait sets the loading flag.
    const cached = pageCacheRef.current?.peek(wanted);
    if (cached) {
      setPageUrl(cached);
      setPageLoading(false);
    } else {
      setPageLoading(true);
    }
    setPageError(false);

    acquirePage(base, wanted)
      .then((url) => {
        if (cancelled) return;
        setPageUrl(url);
        setPageLoading(false);
        // Pull the next page in behind this one. By the time the reader taps
        // forward the render has already happened, so the wait that used to
        // sit in front of every tap now sits behind it.
        for (let ahead = wanted + 1; ahead <= Math.min(wanted + PREFETCH_AHEAD, pageCount); ahead++) {
          void acquirePage(base, ahead).catch(() => {
            /* a prefetch that fails is not an error the reader should see —
               the page is fetched again, visibly, if they actually go there */
          });
        }
      })
      .catch(() => {
        if (cancelled) return;
        setPageLoading(false);
        setPageError(true);
      });

    return () => {
      cancelled = true;
    };
  }, [phase, pagesBase, pageCount, page, acquirePage]);

  // Keep the page box showing the live page whenever it is not being typed in.
  useEffect(() => {
    setPageDraft(String(page));
  }, [page]);

  // Revoke on unmount as well; the app root unmounting mid-view is unlikely but
  // leaking a multi-megabyte blob is not worth the bet.
  useEffect(() => release, [release]);

  /** Move to `target`, clamped. The single funnel every control goes through. */
  const goToPage = useCallback(
    (target: number) => {
      if (!Number.isFinite(target)) return;
      setPage(Math.min(Math.max(Math.round(target), 1), Math.max(pageCount, 1)));
    },
    [pageCount],
  );

  /** Commit whatever was typed in the page box, or restore it if it was junk. */
  const commitPageDraft = useCallback(() => {
    const parsed = Number.parseInt(pageDraft, 10);
    if (Number.isNaN(parsed)) {
      setPageDraft(String(page));
      return;
    }
    goToPage(parsed);
  }, [pageDraft, page, goToPage]);

  /**
   * Horizontal swipe across the page canvas.
   *
   * Deliberately strict: the gesture must be 60px and clearly more horizontal
   * than vertical, because a tall page scrolls vertically in this same box and
   * stealing that would be worse than having no swipe at all.
   */
  const swipeRef = useRef<{ x: number; y: number } | null>(null);
  const onCanvasTouchStart = useCallback((event: React.TouchEvent) => {
    const touch = event.touches[0];
    swipeRef.current = touch ? { x: touch.clientX, y: touch.clientY } : null;
  }, []);
  const onCanvasTouchEnd = useCallback(
    (event: React.TouchEvent) => {
      const start = swipeRef.current;
      swipeRef.current = null;
      const touch = event.changedTouches[0];
      if (!start || !touch) return;
      const dx = touch.clientX - start.x;
      const dy = touch.clientY - start.y;
      if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
      goToPage(page + (dx < 0 ? 1 : -1));
    },
    [page, goToPage],
  );

  if (phase === "idle") return null;

  const title = file?.name ?? (de ? "Datei" : "File");

  return (
    <div className="file-viewer" role="dialog" aria-modal="true" aria-label={title}>
      <div className="file-viewer-head">
        <span className="file-viewer-title" title={title}>
          {title}
        </span>
        {file ? <span className="file-viewer-size">{formatSize(file.size)}</span> : null}
        {phase === "ready" && file ? (
          <button type="button" className="file-viewer-save" onClick={() => void save()}>
            {de ? "Speichern" : "Save"}
          </button>
        ) : null}
        <button type="button" className="file-viewer-close" onClick={close}>
          {de ? "Schließen" : "Close"}
        </button>
      </div>

      <div className="file-viewer-body">
        {phase === "loading" ? (
          <div className="file-viewer-centre">
            <span className="file-viewer-spinner" aria-hidden="true" />
            <p>{de ? "Datei wird geladen…" : "Loading file…"}</p>
          </div>
        ) : null}

        {/* Deliberately not the document: a save-intent tap should never look
            like the preview re-opening. */}
        {phase === "saving" ? (
          <div className="file-viewer-centre">
            <span className="file-viewer-spinner" aria-hidden="true" />
            <p>{de ? "Datei wird vorbereitet…" : "Preparing file…"}</p>
          </div>
        ) : null}

        {phase === "error" ? (
          <div className="file-viewer-centre">
            <p className="file-viewer-error" role="alert">
              {failure}
            </p>
          </div>
        ) : null}

        {phase === "ready" && file ? (
          isImage(file.contentType) ? (
            <img className="file-viewer-image" src={file.objectUrl} alt={file.name} />
          ) : isPdf(file.contentType) && pagesBase && pagesProbe === "pending" ? (
            /* The pager is wanted but the page count has not arrived. Waiting
               beats rendering the frame here: on iOS the frame would paint a
               first page that is about to be replaced, and mounting a blob PDF
               only to tear it down is the flash the pager exists to avoid. */
            <div className="file-viewer-centre">
              <span className="file-viewer-spinner" aria-hidden="true" />
            </div>
          ) : isPdf(file.contentType) && pagesBase && pageCount > 0 ? (
            /* Server-rendered page images with a simple pager. Checked before
               the frame: on iOS the frame is *available* but shows only page
               one, so preferring it would reinstate the bug. */
            <div className="file-viewer-pages">
              <div
                className="file-viewer-page-canvas"
                onTouchStart={onCanvasTouchStart}
                onTouchEnd={onCanvasTouchEnd}
              >
                {/* The outgoing page stays on screen, dimmed, while the next
                    one loads. Blanking to a spinner made every page turn feel
                    like a fresh load even when it took well under a second. */}
                {pageUrl && (
                  <img
                    className={`file-viewer-page-image${pageLoading ? " is-stale" : ""}`}
                    src={pageUrl}
                    alt={`${file.name} – ${de ? "Seite" : "Page"} ${page}`}
                  />
                )}
                {pageLoading && (
                  <span className="file-viewer-page-spinner" aria-hidden="true" />
                )}
                {pageError && !pageLoading && (
                  <p className="file-viewer-error" role="alert">
                    {de ? "Seite konnte nicht geladen werden." : "That page could not be loaded."}
                  </p>
                )}
              </div>

              {pageCount > 1 && (
                <div className="file-viewer-pager">
                  {/* A slider only earns its space once tapping ‹ › stops being
                      a plausible way to cross the document. */}
                  {pageCount > 8 && (
                    <input
                      className="file-viewer-pager-slider"
                      type="range"
                      min={1}
                      max={pageCount}
                      step={1}
                      value={scrubPage ?? page}
                      aria-label={de ? "Seite wählen" : "Jump to page"}
                      // Dragging updates the label only. Committing per pixel
                      // would queue a render for every page dragged past.
                      onChange={(event) => setScrubPage(Number(event.target.value))}
                      onPointerUp={() => {
                        if (scrubPage !== null) goToPage(scrubPage);
                        setScrubPage(null);
                      }}
                      onKeyUp={() => {
                        if (scrubPage !== null) goToPage(scrubPage);
                        setScrubPage(null);
                      }}
                      onBlur={() => setScrubPage(null)}
                    />
                  )}

                  <div className="file-viewer-pager-row">
                    <button
                      type="button"
                      className="file-viewer-pager-btn"
                      disabled={page <= 1}
                      aria-label={de ? "Vorherige Seite" : "Previous page"}
                      onClick={() => goToPage(page - 1)}
                    >
                      ‹
                    </button>

                    <span className="file-viewer-pager-jump">
                      {/* Typing a number is the only way to cross 151 pages in
                          one action; the slider is for browsing, this is for
                          "take me to the wiring diagram on page 96". */}
                      <input
                        className="file-viewer-pager-input"
                        type="text"
                        inputMode="numeric"
                        pattern="[0-9]*"
                        value={scrubPage !== null ? String(scrubPage) : pageDraft}
                        aria-label={de ? "Seitenzahl" : "Page number"}
                        onChange={(event) =>
                          setPageDraft(event.target.value.replace(/[^0-9]/g, ""))
                        }
                        onFocus={(event) => event.target.select()}
                        onBlur={commitPageDraft}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            event.preventDefault();
                            commitPageDraft();
                            event.currentTarget.blur();
                          }
                        }}
                      />
                      <span className="file-viewer-pager-total">/ {pageCount}</span>
                    </span>

                    <button
                      type="button"
                      className="file-viewer-pager-btn"
                      disabled={page >= pageCount}
                      aria-label={de ? "Nächste Seite" : "Next page"}
                      onClick={() => goToPage(page + 1)}
                    >
                      ›
                    </button>
                  </div>
                </div>
              )}
            </div>
          ) : isPdf(file.contentType) && !pdfFrameUnsupported() ? (
            /* The frame can draw something. On iOS with no pages endpoint that
               is page one only — imperfect, but it is what this engine has
               always shown, and a readable first page beats replacing it with
               an "unsupported" notice. */
            <iframe className="file-viewer-frame" src={file.objectUrl} title={file.name} />
          ) : isPdf(file.contentType) ? (
            /* No renderer AND no pages endpoint: an honest hint beats a
               sad-page icon. */
            <div className="file-viewer-centre">
              <p>
                {de
                  ? "PDF-Anzeige wird auf diesem Gerät nicht unterstützt."
                  : "Inline PDF display is not supported on this device."}
              </p>
              <button type="button" className="file-viewer-save-large" onClick={() => void save()}>
                {de ? "PDF speichern / teilen" : "Save / share PDF"}
              </button>
            </div>
          ) : isText(file.contentType) ? (
            <pre className="file-viewer-text">{textBody}</pre>
          ) : (
            <div className="file-viewer-centre">
              <p>
                {de
                  ? "Dieser Dateityp kann in der App nicht angezeigt werden."
                  : "This file type cannot be displayed in the app."}
              </p>
              <p className="file-viewer-muted">{file.contentType || "unbekannt"}</p>
              {/* The only way out of this branch. Without it the tap is a
                  dead end: the bytes have been fetched and there is nothing
                  the user can do with them. */}
              <button type="button" className="file-viewer-save-large" onClick={() => void save()}>
                {de ? "Datei speichern" : "Save file"}
              </button>
            </div>
          )
        ) : null}
      </div>
    </div>
  );
}

export function NativeFileViewer() {
  // Module-level constant, so this branch never flips for the life of the page.
  // Covers the native shell and an installed PWA — both are surfaces where a
  // link cannot open a tab, so a file has to be shown in place.
  if (!IS_APP_SURFACE) return null;
  return <Viewer />;
}
