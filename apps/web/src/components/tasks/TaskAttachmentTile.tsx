/**
 * One attachment in the task modal: the picture itself when there is one,
 * a glyph otherwise, the name and the day. The whole face opens the viewer;
 * the × in the corner is a sibling, not a child — a button inside a button
 * is not HTML — and only exists for someone who may remove the file.
 */
import { useState } from "react";
import type { Language, StoredFile } from "../../types";
import { isImageType } from "../../utils/filePreview";
import { filePreviewUrl } from "../files/FileLightbox";
import { AuthedImage } from "../shared/AuthedImage";
import { attachmentGlyph, formatAttachmentDate } from "./taskAttachmentsModel";

type Props = {
  file: StoredFile;
  language: Language;
  canRemove: boolean;
  onOpen: () => void;
  onRemove: () => void;
};

export function TaskAttachmentTile({ file, language, canRemove, onOpen, onRemove }: Props) {
  const de = language === "de";
  // A picture whose bytes will not come (a 403, a file gone from disk) keeps
  // the glyph instead of the browser's broken-image icon. The glyph is drawn
  // underneath in any case: in the native shell AuthedImage renders nothing
  // until the bytes are fetched, and an empty frame would read as "no file".
  const [imageFailed, setImageFailed] = useState(false);
  const showImage = isImageType(file.content_type) && !imageFailed;

  return (
    <li className="task-attachments-tile">
      <button type="button" className="task-attachments-tile-open" onClick={onOpen} title={file.file_name}>
        <span className="task-attachments-tile-thumb">
          <span className="task-attachments-tile-glyph" aria-hidden="true">
            {attachmentGlyph(file.content_type)}
          </span>
          {showImage && (
            <AuthedImage
              src={filePreviewUrl(file.id)}
              alt=""
              className="task-attachments-tile-image"
              loading="lazy"
              onError={() => setImageFailed(true)}
            />
          )}
        </span>
        <span className="task-attachments-tile-name">{file.file_name}</span>
        <span className="task-attachments-tile-date">{formatAttachmentDate(file.created_at, language)}</span>
      </button>
      {canRemove && (
        <button
          type="button"
          className="task-attachments-tile-remove"
          onClick={onRemove}
          aria-label={de ? `Anhang entfernen: ${file.file_name}` : `Remove attachment: ${file.file_name}`}
          title={de ? "Anhang entfernen" : "Remove attachment"}
        >
          ×
        </button>
      )}
    </li>
  );
}
