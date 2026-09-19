/**
 * One tile of the gallery: a thumbnail for an image, a glyph for anything
 * else, the name and the folder underneath.
 *
 * A button, not a link: a tap opens the in-app viewer on this file, and the
 * viewer offers the download for what it cannot show. The old tile was a
 * link into a new tab, which is what people asked to be rid of.
 */
import { AuthedImage } from "../shared/AuthedImage";
import { filePreviewUrl } from "../../utils/filePreview";
import { iconForContentType, isImageFile } from "./folderGroups";
import type { StoredFile } from "../../types";

export function GalleryTile({
  file,
  onOpen,
}: {
  file: StoredFile;
  onOpen: (file: StoredFile) => void;
}) {
  return (
    <button
      type="button"
      className="gallery-tile file-browser-tile"
      title={`${file.file_name} · ${file.folder || "/"}`}
      onClick={() => onOpen(file)}
    >
      {isImageFile(file) ? (
        <AuthedImage
          src={filePreviewUrl(file.id)}
          alt={file.file_name}
          className="gallery-tile-image"
          loading="lazy"
        />
      ) : (
        <div className="gallery-tile-icon" aria-hidden="true">
          {iconForContentType(file.content_type)}
        </div>
      )}
      <div className="gallery-tile-name">{file.file_name}</div>
      <div className="gallery-tile-folder">{file.folder || "/"}</div>
    </button>
  );
}
