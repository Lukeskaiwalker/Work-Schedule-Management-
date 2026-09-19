/**
 * The two segmented pickers of the file browser toolbar: Liste/Galerie and
 * the S/M/L tile size. One button shape for both — they used to be five
 * near-identical inline blocks that drifted apart.
 */
import type { Language } from "../../types";
import type { FilesViewMode, GallerySize } from "./useFileViewPrefs";

function SegmentedButton({
  active,
  label,
  title,
  onClick,
}: {
  active: boolean;
  label: string;
  title: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      className={active ? "is-active" : undefined}
      onClick={onClick}
      title={title}
    >
      {label}
    </button>
  );
}

export function FileViewModeToggle({
  value,
  onChange,
  language,
}: {
  value: FilesViewMode;
  onChange: (mode: FilesViewMode) => void;
  language: Language;
}) {
  const de = language === "de";
  return (
    <div className="file-view-toggle" role="tablist" aria-label={de ? "Ansicht" : "View"}>
      <SegmentedButton
        active={value === "list"}
        label={de ? "Liste" : "List"}
        title={de ? "Listenansicht" : "List view"}
        onClick={() => onChange("list")}
      />
      <SegmentedButton
        active={value === "gallery"}
        label={de ? "Galerie" : "Gallery"}
        title={de ? "Galerieansicht" : "Gallery view"}
        onClick={() => onChange("gallery")}
      />
    </div>
  );
}

/**
 * Three-step size picker for the gallery grid. Mirrors the Finder slider —
 * operators who want a quick contact sheet pick S, those who want a
 * desktop-style image-first browse pick L. Hosts hide it in list view
 * because list rows have a fixed layout.
 */
export function GallerySizeToggle({
  value,
  onChange,
  language,
}: {
  value: GallerySize;
  onChange: (size: GallerySize) => void;
  language: Language;
}) {
  const de = language === "de";
  return (
    <div
      className="file-view-toggle file-view-toggle--sizes"
      role="tablist"
      aria-label={de ? "Größe" : "Size"}
    >
      <SegmentedButton
        active={value === "s"}
        label="S"
        title={de ? "Klein" : "Small"}
        onClick={() => onChange("s")}
      />
      <SegmentedButton
        active={value === "m"}
        label="M"
        title={de ? "Mittel" : "Medium"}
        onClick={() => onChange("m")}
      />
      <SegmentedButton
        active={value === "l"}
        label="L"
        title={de ? "Groß" : "Large"}
        onClick={() => onChange("l")}
      />
    </div>
  );
}
