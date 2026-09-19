/**
 * The contract of the click-through file viewer.
 *
 * Three hosts feed it — the project files tab, the customer file browser and
 * the task attachments — and they only ever hand over ids, names and content
 * types. Every URL is derived from the id inside the viewer, so a host cannot
 * point one file's preview at another file's download by mistake, and the
 * shell's URL rewriting happens in exactly one place.
 */
export type LightboxFile = {
  /** Attachment id; the preview, download and page URLs are derived from it. */
  id: number;
  file_name: string;
  content_type: string;
  /** Where the file lives, shown under the name: the folder, or "Aufgabe: …". */
  subtitle?: string;
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
