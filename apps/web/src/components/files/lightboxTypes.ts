/**
 * The contract of the click-through file viewer.
 *
 * Three hosts feed it — the project files tab, the customer file browser and
 * the task attachments — and they only ever hand over ids, names and content
 * types. Every URL is derived from the id inside the viewer, so a host cannot
 * point one file's preview at another file's download by mistake, and the
 * shell's URL rewriting happens in exactly one place.
 *
 * The one exception is a document that is not a file: the Projektbericht
 * preview is rendered on request and has no attachment id to derive from,
 * so a host may bring its URLs along in `source`. The viewer treats such a
 * file exactly like any other — it only reads its bytes from elsewhere.
 */
export type LightboxSource = {
  /** Inline bytes for the frame, the image or the text. */
  previewUrl: string;
  /** What "Herunterladen" links to. */
  downloadUrl: string;
  /** The paged PDF fallback: `${pagesUrl}` answers the count, `${pagesUrl}/{n}` one page. */
  pagesUrl?: string;
};

export type LightboxFile = {
  /** Attachment id; the preview, download and page URLs are derived from it unless `source` is given. */
  id: number;
  file_name: string;
  content_type: string;
  /** Where the file lives, shown under the name: the folder, or "Aufgabe: …". */
  subtitle?: string;
  /** Overrides the id-derived URLs for a document that is not a stored file. */
  source?: LightboxSource;
};

export type FileLightboxProps = {
  /** The ordered sequence to step through. */
  files: readonly LightboxFile[];
  /**
   * Which one is open. The parent owns it — like the chat lightbox — so
   * opening, stepping and closing are all controlled from one place.
   */
  index: number;
  onIndexChange: (next: number) => void;
  onClose: () => void;
  /** Renders a "Löschen" control when given; what deleting means is the host's. */
  onDelete?: (file: LightboxFile) => void | Promise<void>;
  language: "de" | "en";
};
