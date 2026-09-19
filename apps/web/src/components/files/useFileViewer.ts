/**
 * The host side of the click-through viewer: which sequence is open and at
 * which position. Shared by the project tab and the customer card so both
 * open, step, close and shrink the sequence after a delete the same way.
 *
 * The sequence is a snapshot of what was on screen at the click; the browser
 * may regroup or refilter underneath, and "next" still means the file that
 * was below the one the user chose.
 */
import { useCallback, useState } from "react";

import type { LightboxFile } from "./lightboxTypes";
import type { StoredFile } from "../../types";

export type FileViewerState = {
  files: LightboxFile[];
  index: number;
};

export function useFileViewer() {
  const [state, setState] = useState<FileViewerState | null>(null);

  const open = useCallback(
    (
      sequence: readonly StoredFile[],
      file: StoredFile,
      subtitleFor: (file: StoredFile) => string | undefined,
    ) => {
      const index = Math.max(0, sequence.findIndex((entry) => entry.id === file.id));
      const files = sequence.map((entry) => ({
        id: entry.id,
        file_name: entry.file_name,
        content_type: entry.content_type,
        subtitle: subtitleFor(entry),
      }));
      setState({ files, index });
    },
    [],
  );

  const close = useCallback(() => setState(null), []);

  const setIndex = useCallback((index: number) => {
    setState((current) => (current ? { ...current, index } : current));
  }, []);

  /** After a delete: drop the file, stay at the same position, close on the last one. */
  const remove = useCallback((id: number) => {
    setState((current) => {
      if (!current) return current;
      const files = current.files.filter((entry) => entry.id !== id);
      if (files.length === 0) return null;
      return { files, index: Math.min(current.index, files.length - 1) };
    });
  }, []);

  return { state, open, close, setIndex, remove };
}
