/**
 * What the browser shell decides once and every row set below it follows:
 * list or gallery, the tile size, the search, the language.
 *
 * A context rather than props because the customer card nests row sets the
 * shell does not know about (one per project folder), and each of them has to
 * flip to tiles with the same toggle.
 */
import { createContext, useContext } from "react";

import type { Language } from "../../types";
import type { FilesViewMode, GallerySize } from "./useFileViewPrefs";

export type FileBrowserView = {
  viewMode: FilesViewMode;
  gallerySize: GallerySize;
  language: Language;
  /** The search text; a non-empty one flattens every group into matches. */
  query: string;
};

export const FileBrowserViewContext = createContext<FileBrowserView | null>(null);

export function useFileBrowserView(): FileBrowserView {
  const view = useContext(FileBrowserViewContext);
  if (!view) {
    throw new Error("FileBrowserFiles must be rendered inside a FileBrowser");
  }
  return view;
}
