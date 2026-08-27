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
  const [pageLoading, setPageLoading] = useState(false);
  // Whether the page-count probe has answered yet. `pageCount === 0` alone
  // cannot say: it is both "not asked yet" and "asked and failed", and those
  // need opposite fallbacks — wait, versus drop back to the frame.
  const [pagesProbe, setPagesProbe] = useState<"pending" | "ok" | "failed">("pending");
  const pageUrlRef = useRef<string | null>(null);

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

  const releasePage = useCallback(() => {
    if (pageUrlRef.current) {
      URL.revokeObjectURL(pageUrlRef.current);
      pageUrlRef.current = null;
    }
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
    setPageLoading(true);
    fetchAuthorizedBlobUrl(`${pagesBase}/${page}`)
      .then((url) => {
        if (cancelled) {
          URL.revokeObjectURL(url);
          return;
        }
        releasePage();
        pageUrlRef.current = url;
        setPageUrl(url);
        setPageLoading(false);
      })
      .catch(() => {
        if (!cancelled) {
          setPageUrl("");
          setPageLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [phase, pagesBase, pageCount, page, releasePage]);

  // Revoke on unmount as well; the app root unmounting mid-view is unlikely but
  // leaking a multi-megabyte blob is not worth the bet.
  useEffect(() => release, [release]);

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
              <div className="file-viewer-page-canvas">
                {pageLoading && <span className="file-viewer-spinner" aria-hidden="true" />}
                {pageUrl && !pageLoading && (
                  <img
                    className="file-viewer-page-image"
                    src={pageUrl}
                    alt={`${file.name} – ${de ? "Seite" : "Page"} ${page}`}
                  />
                )}
              </div>
              {pageCount > 1 && (
                <div className="file-viewer-pager">
                  <button
                    type="button"
                    className="file-viewer-pager-btn"
                    disabled={page <= 1 || pageLoading}
                    onClick={() => setPage((current) => Math.max(1, current - 1))}
                  >
                    ‹
                  </button>
                  <span className="file-viewer-pager-label">
                    {de ? "Seite" : "Page"} {page} / {pageCount}
                  </span>
                  <button
                    type="button"
                    className="file-viewer-pager-btn"
                    disabled={page >= pageCount || pageLoading}
                    onClick={() => setPage((current) => Math.min(pageCount, current + 1))}
                  >
                    ›
                  </button>
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
