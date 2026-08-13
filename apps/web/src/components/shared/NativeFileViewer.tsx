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

  const close = useCallback(() => {
    release();
    setFile(null);
    setTextBody("");
    setFailure("");
    setPhase("idle");
  }, [release]);

  const open = useCallback(
    (request: OpenFileRequest) => {
      release();
      setFile(null);
      setTextBody("");
      setFailure("");
      setPhase("loading");

      void fetchFile(request)
        .then(async (fetched) => {
          objectUrlRef.current = fetched.objectUrl;
          if (isText(fetched.contentType)) {
            // Read the text out now so the body can render it directly; an
            // object URL in an iframe would be a second navigation for nothing.
            const body = await fetch(fetched.objectUrl).then((r) => r.text());
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
    [de, release],
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
  const save = useCallback(() => {
    if (!file) return;
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
          <button type="button" className="file-viewer-save" onClick={save}>
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
          ) : isPdf(file.contentType) ? (
            <iframe className="file-viewer-frame" src={file.objectUrl} title={file.name} />
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
              <button type="button" className="file-viewer-save-large" onClick={save}>
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
