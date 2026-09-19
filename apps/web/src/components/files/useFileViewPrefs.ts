/**
 * The operator's view choice (list or gallery) and gallery tile size, kept
 * in localStorage under keys the host names.
 *
 * Per host rather than global on purpose: someone who scans project photos
 * in a large gallery still wants the customer folder as a list. A backend
 * round-trip would be the wrong tool for a preference this small.
 */
import { useEffect, useState } from "react";

export type FilesViewMode = "list" | "gallery";

/**
 * Gallery tile size, picked by the operator. Maps to the CSS variable
 * --gallery-tile-min on .file-gallery so the grid-template-columns auto-fill
 * calculation respects the choice without recomputing JS on every resize.
 */
export type GallerySize = "s" | "m" | "l";

/**
 * Tile min-width in CSS px per size step, finder-like: small ≈ a compact
 * contact sheet, medium the default, large a desktop-style image-first layout.
 */
export const GALLERY_SIZE_PX: Record<GallerySize, number> = {
  s: 100,
  m: 140,
  l: 240,
};

export type FileViewStorageKeys = {
  viewMode: string;
  gallerySize: string;
};

function readStored(key: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStored(key: string, value: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // localStorage may be disabled (private mode, quota); the choice still
    // holds for the current session.
  }
}

function readViewMode(key: string): FilesViewMode {
  return readStored(key) === "gallery" ? "gallery" : "list";
}

function readGallerySize(key: string): GallerySize {
  const raw = readStored(key);
  return raw === "s" || raw === "l" ? raw : "m";
}

export function useFileViewPrefs(keys: FileViewStorageKeys) {
  const [viewMode, setViewMode] = useState<FilesViewMode>(() => readViewMode(keys.viewMode));
  const [gallerySize, setGallerySize] = useState<GallerySize>(() =>
    readGallerySize(keys.gallerySize),
  );

  // Persisted from an effect rather than inside the setters so the read path
  // stays the single source of truth for what a stored value means.
  useEffect(() => writeStored(keys.viewMode, viewMode), [keys.viewMode, viewMode]);
  useEffect(() => writeStored(keys.gallerySize, gallerySize), [keys.gallerySize, gallerySize]);

  return { viewMode, setViewMode, gallerySize, setGallerySize };
}
