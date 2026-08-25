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

type Phase = "idle" | "loading" | "ready" | "error";

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
 * True when this engine cannot draw a PDF inline. Chrome on Android reports
 * `navigator.pdfViewerEnabled === false` — the frame loads but Chromium only
 * paints its sad-page placeholder behind it (the exact field report). iOS
 * WKWebView and desktop engines either report true or predate the API; both
 * render framed PDFs fine, so `undefined` counts as capable.
 */
function pdfFrameUnsupported(): boolean {
  return (navigator as { pdfViewerEnabled?: boolean }).pdfViewerEnabled === false;
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
    setPage(1);
    setPageUrl("");
    setPhase("idle");
  }, [release, releasePage]);

  const open = useCallback(
    (request: OpenFileRequest) => {
      release();
      releasePage();
      setFile(null);
      setTextBody("");
      setFailure("");
      setSourceUrl(request.url);
      setPageCount(0);
      setPage(1);
      setPageUrl("");
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
    [de, release, releasePage],
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
  const save = useCallback(async () => {
    if (!file) return;
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
      const asFile = new File([file.blob], file.name || "download", {
        type: file.contentType || "application/octet-stream",
      });
      if (nav.canShare?.({ files: [asFile] }) && nav.share) {
        await nav.share({ files: [asFile], title: file.name });
        return;
      }
    } catch (err) {
      if ((err as Error)?.name === "AbortError") return;
      // fall through to the anchor
    }
    const anchor = document.createElement("a");
    anchor.href = file.objectUrl;
    anchor.download = file.name || "download";
    anchor.rel = "noreferrer";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  }, [file]);

  useEffect(() => {
    setFileOpenHandler(open);
    return () => setFileOpenHandler(null);
  }, [open]);

  // Engines with no inline PDF renderer (Chrome on Android) get the document
  // as server-rendered page images instead of a frame that draws Chromium's
  // sad-page placeholder. Only attachments have the pages endpoint; other
  // PDFs (e.g. training reports) show the save hint below instead.
  const pagesBase = file && isPdf(file.contentType) && pdfFrameUnsupported() ? pagesBaseFor(sourceUrl) : null;

  useEffect(() => {
    if (phase !== "ready" || !pagesBase) return;
    let cancelled = false;
    fetchAuthorizedJson<{ page_count: number }>(pagesBase)
      .then((meta) => {
        if (!cancelled) setPageCount(meta.page_count);
      })
      .catch(() => {
        if (!cancelled) setPageCount(0);
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
          ) : isPdf(file.contentType) && !pdfFrameUnsupported() ? (
            <iframe className="file-viewer-frame" src={file.objectUrl} title={file.name} />
          ) : isPdf(file.contentType) && pagesBase && pageCount > 0 ? (
            /* No inline PDF renderer on this engine (Android): server-rendered
               page images with a simple pager. */
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
          ) : isPdf(file.contentType) ? (
            /* PDF on an engine without a renderer AND without a pages endpoint
               (non-attachment PDFs): an honest hint beats a sad-page icon. */
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
