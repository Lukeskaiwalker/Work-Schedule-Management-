/**
 * The click-through file viewer: images, PDFs and text in place, everything
 * else as a download — and always the whole sequence, so "next" from a photo
 * lands on the report beside it instead of skipping it.
 *
 * Three hosts render this (project files, customer files, task attachments)
 * against the contract in lightboxTypes.ts, so it is purely controlled: the
 * parent owns the sequence and the open index, exactly like the chat
 * lightbox it generalises.
 *
 * Fetching follows AuthedImage and NativeFileViewer. On the web the session
 * cookie rides along with an image, a frame or a plain link; in the native
 * shell none of those can carry the bearer token, so whatever needs bytes is
 * fetched with it and shown from an object URL.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";

import { fetchAuthorizedBlobUrl } from "../../native/fileOpen";
import { IS_NATIVE_SHELL } from "../../native/shell";
import {
  MAX_CACHED_PAGES,
  PREFETCH_AHEAD,
  clampIndex,
  classifyLoadError,
  isEditableTarget,
  isImageType,
  isPdfType,
  isTextType,
  lightboxDownloadUrl,
  lightboxPagesUrl,
  lightboxPreviewUrl,
  loadFailureText,
  loadPageCount,
  loadTextFile,
  lockBodyScroll,
  pdfNeedsPager,
  swipeStep,
  wrapIndex,
  type LoadFailure,
  type Point,
} from "../../utils/filePreview";
import { createPageCache, type PageCache } from "../../utils/pdfPageCache";
import { AuthedImage } from "../shared/AuthedImage";
import type { FileLightboxProps, LightboxFile } from "./lightboxTypes";
import "../../styles/files.css";

export type { FileLightboxProps, LightboxFile } from "./lightboxTypes";
// The viewer's public face: hosts build their links and thumbnails from the
// same helpers the viewer renders with, so the two cannot disagree.
export { fileDownloadUrl, filePreviewUrl, isLightboxPreviewable } from "../../utils/filePreview";

type Language = FileLightboxProps["language"];
type StageProps = { file: LightboxFile; language: Language };

type Loaded<T> =
  | { status: "loading" }
  | { status: "ready"; value: T }
  | { status: "error"; failure: LoadFailure };

/**
 * Run `load` for `fileId` and report its phases. `dispose` frees what a run
 * produced — an object URL, typically — both when the stage goes away and
 * when a result arrives after it already has.
 */
function useLoaded<T>(fileId: number, load: () => Promise<T>, dispose?: (value: T) => void) {
  const [state, setState] = useState<Loaded<T>>({ status: "loading" });
  useEffect(() => {
    let cancelled = false;
    let produced: T | undefined;
    setState({ status: "loading" });
    load()
      .then((value) => {
        if (cancelled) return dispose?.(value);
        produced = value;
        setState({ status: "ready", value });
      })
      .catch((err: unknown) => {
        if (!cancelled) setState({ status: "error", failure: classifyLoadError(err) });
      });
    return () => {
      cancelled = true;
      if (produced !== undefined) dispose?.(produced);
    };
    // `load` and `dispose` are inline closures; the file id is the real
    // dependency, and re-running per parent render would refetch the file.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileId]);
  return state;
}

/**
 * A link with `download`, on every surface. In the shell and the installed
 * PWA the click interceptor (native/fileOpen) turns exactly that attribute
 * into the save intent — the one-tap share-sheet path — whereas a button
 * going through openServerFile could only ask for "view" and would land in
 * the native viewer with a second Save tap. The web gets a plain download.
 */
function DownloadLink({ file, language }: StageProps) {
  return (
    <a
      className="file-lightbox-action"
      href={lightboxDownloadUrl(file)}
      download={file.file_name}
      target="_blank"
      rel="noreferrer"
    >
      {language === "de" ? "Herunterladen" : "Download"}
    </a>
  );
}

function LoadingNote({ language }: { language: Language }) {
  return (
    <div className="file-lightbox-note" role="status">
      <span className="file-lightbox-spinner" aria-hidden="true" />
      <span>{language === "de" ? "Wird geladen…" : "Loading…"}</span>
    </div>
  );
}

/** Never a blank stage: the name, one line of why, and the way out. */
function Panel({ file, language, text, alert }: StageProps & { text: string; alert?: boolean }) {
  return (
    <div className="file-lightbox-panel">
      <p className="file-lightbox-panel-title">{file.file_name}</p>
      <p className="file-lightbox-panel-text" role={alert ? "alert" : undefined}>
        {text}
      </p>
      <DownloadLink file={file} language={language} />
    </div>
  );
}

function FailurePanel({ file, language, failure }: StageProps & { failure: LoadFailure }) {
  return <Panel file={file} language={language} text={loadFailureText(failure, language)} alert />;
}

function ImageStage({ file, language }: StageProps) {
  const [failed, setFailed] = useState(false);
  if (failed) return <FailurePanel file={file} language={language} failure="failed" />;
  return (
    <>
      <AuthedImage
        className="file-lightbox-image"
        src={lightboxPreviewUrl(file)}
        alt={file.file_name}
        onError={() => setFailed(true)}
      />
      {/* Hidden by files.css as soon as the image element exists beside it. */}
      <LoadingNote language={language} />
    </>
  );
}

/** The engine's own PDF viewer in a frame — wherever the probes allow it. */
function PdfFrameStage({ file, language }: StageProps) {
  const [painted, setPainted] = useState(false);
  // A frame cannot carry the bearer token, so in the shell the document is
  // fetched with it and framed from an object URL — the trade the native
  // viewer makes. On the web the cookie rides along with the URL itself, so
  // there is nothing to wait for and the loader is a no-op.
  const previewUrl = lightboxPreviewUrl(file);
  const blob = useLoaded<string>(
    file.id,
    () => (IS_NATIVE_SHELL ? fetchAuthorizedBlobUrl(previewUrl) : Promise.resolve("")),
    (url) => url && URL.revokeObjectURL(url),
  );
  if (IS_NATIVE_SHELL && blob.status === "error") {
    return <FailurePanel file={file} language={language} failure={blob.failure} />;
  }
  const src = IS_NATIVE_SHELL ? blob.status === "ready" && blob.value : previewUrl;
  return (
    <>
      {src && (
        <iframe className="file-lightbox-frame" title={file.file_name} src={src} onLoad={() => setPainted(true)} />
      )}
      {(!src || !painted) && <LoadingNote language={language} />}
    </>
  );
}

function PagerButton({ label, glyph, disabled, onClick }: {
  label: string;
  glyph: string;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button type="button" className="file-lightbox-pager-btn" disabled={disabled} aria-label={label} onClick={onClick}>
      {glyph}
    </button>
  );
}

/**
 * Server-rendered page images with a pager, for engines whose frame cannot
 * do the job: Chromium on Android draws nothing at all, WebKit on iOS draws
 * page one only.
 */
function PdfPagesStage({ file, language }: StageProps) {
  const de = language === "de";
  const pagesUrl = lightboxPagesUrl(file);
  const count = useLoaded<number>(file.id, () => loadPageCount(pagesUrl));
  const [page, setPage] = useState(1);
  const [pageUrl, setPageUrl] = useState("");
  // True only while a page the reader is waiting for is in flight; a
  // prefetch never sets it, because the point of prefetching is invisibility.
  const [pageLoading, setPageLoading] = useState(false);
  const [pageError, setPageError] = useState(false);
  // Rendered pages. The cache owns every URL it hands out — a displayed page
  // is usually a cached one — so nothing here revokes; clear() on unmount does.
  const cacheRef = useRef<PageCache | null>(null);

  const acquire = useCallback(
    (wanted: number): Promise<string> => {
      if (!cacheRef.current) {
        cacheRef.current = createPageCache({
          maxEntries: MAX_CACHED_PAGES,
          fetchPage: (n) => fetchAuthorizedBlobUrl(`${pagesUrl}/${n}`),
        });
      }
      return cacheRef.current.acquire(wanted);
    },
    [pagesUrl],
  );

  useEffect(() => () => cacheRef.current?.clear(), []);

  const total = count.status === "ready" ? count.value : 0;

  useEffect(() => {
    if (total < 1) return;
    let cancelled = false;
    // A cache hit must not flash a spinner — that is the whole point of it.
    const cached = cacheRef.current?.peek(page);
    if (cached) setPageUrl(cached);
    setPageLoading(!cached);
    setPageError(false);
    acquire(page)
      .then((url) => {
        if (cancelled) return;
        setPageUrl(url);
        setPageLoading(false);
        // Pull the next page in behind this one, so the wait that used to sit
        // in front of every tap now sits behind it. Forward only: backward is
        // already cached, and the server renders with a semaphore of two.
        for (let ahead = page + 1; ahead <= Math.min(page + PREFETCH_AHEAD, total); ahead++) {
          void acquire(ahead).catch(() => {
            /* fetched again, visibly, if the reader actually goes there */
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
  }, [total, page, acquire]);

  if (count.status === "loading") return <LoadingNote language={language} />;
  if (count.status === "error") {
    return <FailurePanel file={file} language={language} failure={count.failure} />;
  }
  const goTo = (target: number) => setPage(Math.min(Math.max(target, 1), total));
  return (
    <div className="file-lightbox-pages">
      <div className="file-lightbox-page-canvas">
        {pageUrl && (
          <img
            className={`file-lightbox-page-image${pageLoading ? " is-stale" : ""}`}
            src={pageUrl}
            alt={`${file.file_name} – ${de ? "Seite" : "Page"} ${page}`}
          />
        )}
        {pageLoading && !pageUrl && <LoadingNote language={language} />}
        {pageError && !pageLoading && (
          <p className="file-lightbox-error" role="alert">
            {de ? "Seite konnte nicht geladen werden." : "That page could not be loaded."}
          </p>
        )}
      </div>
      {total > 1 && (
        <div className="file-lightbox-pager">
          <PagerButton
            label={de ? "Vorherige Seite" : "Previous page"}
            glyph="‹"
            disabled={page <= 1}
            onClick={() => goTo(page - 1)}
          />
          <span className="file-lightbox-pager-label">{`${de ? "Seite" : "Page"} ${page} / ${total}`}</span>
          <PagerButton
            label={de ? "Nächste Seite" : "Next page"}
            glyph="›"
            disabled={page >= total}
            onClick={() => goTo(page + 1)}
          />
        </div>
      )}
    </div>
  );
}

function TextStage({ file, language }: StageProps) {
  const text = useLoaded<string>(file.id, () => loadTextFile(lightboxPreviewUrl(file), file.file_name));
  if (text.status === "loading") return <LoadingNote language={language} />;
  if (text.status === "error") {
    return <FailurePanel file={file} language={language} failure={text.failure} />;
  }
  return <pre className="file-lightbox-text">{text.value}</pre>;
}

function Stage({ file, language }: StageProps) {
  if (isImageType(file.content_type)) return <ImageStage file={file} language={language} />;
  if (isPdfType(file.content_type)) {
    // Probed per render, not once: "has a PDF renderer" is not "renders a
    // framed PDF usefully" — iOS answers yes to the first and shows page one
    // only — and both shortfalls take the server-rendered pager.
    const Pdf = pdfNeedsPager() ? PdfPagesStage : PdfFrameStage;
    return <Pdf file={file} language={language} />;
  }
  if (isTextType(file.content_type)) return <TextStage file={file} language={language} />;
  const text = language === "de" ? "Keine Vorschau für diesen Dateityp" : "No preview for this file type";
  return <Panel file={file} language={language} text={text} />;
}

function NavButton({ direction, language, onClick }: {
  direction: -1 | 1;
  language: Language;
  onClick: () => void;
}) {
  const de = language === "de";
  const label =
    direction < 0 ? (de ? "Vorherige Datei" : "Previous file") : de ? "Nächste Datei" : "Next file";
  return (
    <button
      type="button"
      className={`file-lightbox-nav file-lightbox-nav--${direction < 0 ? "prev" : "next"}`}
      onClick={onClick}
      aria-label={label}
      title={label}
    >
      {/* A drawn chevron, not a text glyph: "‹" sits high and left of the
          circle's centre because of its side bearings and baseline, and no
          amount of line-height fixes what the font decided. */}
      <svg className="file-lightbox-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path
          d={direction < 0 ? "M15 5 L8 12 L15 19" : "M9 5 L16 12 L9 19"}
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  );
}

export function FileLightbox({
  files,
  index,
  onIndexChange,
  onClose,
  onDelete,
  language,
}: FileLightboxProps): JSX.Element | null {
  const de = language === "de";
  const total = files.length;
  const safeIndex = clampIndex(index, total);
  const current: LightboxFile | undefined = files[safeIndex];
  const rootRef = useRef<HTMLDivElement>(null);
  const swipeRef = useRef<Point | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteFailed, setDeleteFailed] = useState(false);

  const step = useCallback(
    (delta: number) => {
      if (total > 1) onIndexChange(wrapIndex(safeIndex + delta, total));
    },
    [safeIndex, total, onIndexChange],
  );

  // Keys are taken in the capture phase on window and stopped there: the
  // modal underneath may listen for Escape too, and one press has to close
  // the viewer alone, not the modal it was opened from.
  useEffect(() => {
    const actions: Record<string, () => void> = {
      Escape: onClose,
      ArrowRight: () => step(1),
      ArrowLeft: () => step(-1),
    };
    function onKeyDown(event: KeyboardEvent) {
      const action: (() => void) | undefined = actions[event.key];
      if (!action || isEditableTarget(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
      action();
    }
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [onClose, step]);

  // Focus moves in on open and back out on close, and the page must not
  // scroll behind a full-screen overlay. Keyed on `open` rather than on
  // mount: a host that empties the sequence without unmounting (the last
  // file deleted) renders nothing, and must not keep the page locked.
  const open = current !== undefined;
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const unlock = lockBodyScroll();
    rootRef.current?.focus();
    return () => {
      unlock();
      if (previous?.isConnected) previous.focus();
    };
  }, [open]);

  const onPointerDown = useCallback((event: ReactPointerEvent) => {
    // Mouse drags are left alone: on the desktop a drag across an image
    // starts a native drag, and "next file" from that would be a surprise.
    swipeRef.current = event.pointerType === "mouse" ? null : { x: event.clientX, y: event.clientY };
  }, []);

  const onPointerUp = useCallback(
    (event: ReactPointerEvent) => {
      const start = swipeRef.current;
      swipeRef.current = null;
      const delta = start ? swipeStep(start, { x: event.clientX, y: event.clientY }) : 0;
      if (delta) step(delta);
    },
    [step],
  );

  const runDelete = useCallback(async () => {
    if (!current || !onDelete || deleting) return;
    setDeleting(true);
    setDeleteFailed(false);
    try {
      await onDelete(current);
    } catch {
      setDeleteFailed(true);
    } finally {
      setDeleting(false);
    }
  }, [current, onDelete, deleting]);

  // Only the bare backdrop or the empty stage closes; clicks on the content,
  // the arrows and the toolbar are theirs.
  const closeFromBare = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      if (event.target === event.currentTarget) onClose();
    },
    [onClose],
  );

  if (!current) return null;

  return createPortal(
    <div
      ref={rootRef}
      className="file-lightbox-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={current.file_name}
      tabIndex={-1}
      onClick={(event) => {
        // Nothing here may reach the host: it may be a modal that closes on
        // a backdrop click of its own, and this overlay covers it.
        event.stopPropagation();
        closeFromBare(event);
      }}
    >
      <div className="file-lightbox-toolbar">
        {total > 1 && <span className="file-lightbox-counter">{`${safeIndex + 1} / ${total}`}</span>}
        <div className="file-lightbox-actions">
          {deleteFailed && (
            <span className="file-lightbox-error" role="alert">
              {de ? "Löschen fehlgeschlagen." : "Delete failed."}
            </span>
          )}
          {onDelete && (
            <button
              type="button"
              className="file-lightbox-action file-lightbox-action--danger"
              disabled={deleting}
              onClick={() => void runDelete()}
            >
              {deleting ? (de ? "Wird gelöscht…" : "Deleting…") : de ? "Löschen" : "Delete"}
            </button>
          )}
          <DownloadLink file={current} language={language} />
          <button
            type="button"
            className="file-lightbox-close"
            onClick={onClose}
            aria-label={de ? "Schließen" : "Close"}
            title={de ? "Schließen" : "Close"}
          >
            <svg className="file-lightbox-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <path d="M6 6 L18 18 M18 6 L6 18" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      </div>

      <div
        className="file-lightbox-stage"
        onClick={closeFromBare}
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
        onPointerCancel={() => (swipeRef.current = null)}
      >
        {total > 1 && <NavButton direction={-1} language={language} onClick={() => step(-1)} />}
        {/* Keyed by id, so a stage never carries one file's page or text
            into the next one. */}
        <div className="file-lightbox-content" key={current.id}>
          <Stage file={current} language={language} />
        </div>
        {total > 1 && <NavButton direction={1} language={language} onClick={() => step(1)} />}
      </div>

      <div className="file-lightbox-caption">
        <span className="file-lightbox-caption-name">{current.file_name}</span>
        {current.subtitle && <span className="file-lightbox-caption-subtitle">{current.subtitle}</span>}
      </div>
    </div>,
    document.body,
  );
}
