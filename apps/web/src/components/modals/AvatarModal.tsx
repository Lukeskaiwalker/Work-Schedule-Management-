import React from "react";
import { useAppContext } from "../../context/AppContext";
import { IMAGE_INPUT_ACCEPT } from "../../constants";
import { isHeicFile } from "../../utils/misc";

export function AvatarModal() {
  const {
    avatarModalOpen,
    language,
    closeAvatarModal,
    avatarSourceUrl,
    onAvatarFileChange,
    avatarSelectedFile,
    avatarPreviewDataUrl,
    avatarCropStageRef,
    avatarIsDragging,
    onAvatarDragStart,
    onAvatarDragMove,
    onAvatarDragEnd,
    avatarStageState,
    avatarZoom,
    setAvatarZoom,
    deleteAvatar,
    user,
    saveAvatar,
  } = useAppContext();

  if (!avatarModalOpen || !user) return null;

  return (
    <div className="modal-backdrop" onClick={closeAvatarModal}>
      <div className="card modal-card modal-card-sm" onClick={(event) => event.stopPropagation()}>
        <h3>{language === "de" ? "Profilbild anpassen" : "Adjust profile picture"}</h3>
        <label>
          {language === "de" ? "Bilddatei" : "Image file"}
          <input type="file" accept={IMAGE_INPUT_ACCEPT} onChange={onAvatarFileChange} />
        </label>
        {!avatarSourceUrl && (
          <small className="muted">
            {language === "de"
              ? "Bild auswählen, dann Bild mit der Maus/Finger verschieben und Zoom anpassen."
              : "Choose an image, then drag the picture and adjust zoom."}
          </small>
        )}
        {avatarSelectedFile && isHeicFile(avatarSelectedFile) && !avatarPreviewDataUrl && (
          <small className="muted">
            {language === "de"
              ? "HEIC-Vorschau ist im Browser eventuell nicht verfügbar. Speichern lädt das Original hoch."
              : "HEIC preview may be unavailable in your browser. Save uploads the original file."}
          </small>
        )}
        {avatarSourceUrl && (
          <div className="avatar-crop-section">
            <div className="avatar-crop-editor">
              <div
                className={avatarIsDragging ? "avatar-crop-stage dragging" : "avatar-crop-stage"}
                ref={avatarCropStageRef as React.RefObject<HTMLDivElement>}
                onPointerDown={onAvatarDragStart}
                onPointerMove={onAvatarDragMove}
                onPointerUp={onAvatarDragEnd}
                onPointerCancel={onAvatarDragEnd}
              >
                <img
                  src={avatarSourceUrl}
                  alt=""
                  className="avatar-crop-image"
                  draggable={false}
                  style={{
                    transform: `translate(${avatarStageState.translateX}px, ${avatarStageState.translateY}px) scale(${avatarZoom})`,
                  }}
                />
                <div className="avatar-crop-focus" />
              </div>
              <div className="avatar-crop-preview-wrap">
                {avatarPreviewDataUrl ? (
                  <img src={avatarPreviewDataUrl} alt="" className="avatar-crop-preview" />
                ) : (
                  <div className="avatar-crop-preview avatar-crop-placeholder" />
                )}
              </div>
            </div>
            <div className="avatar-crop-controls">
              <label>
                {language === "de" ? "Zoom" : "Zoom"}
                <input
                  type="range"
                  min={1}
                  max={3}
                  step={0.05}
                  value={avatarZoom}
                  onChange={(event) => setAvatarZoom(Number(event.target.value))}
                />
              </label>
            </div>
          </div>
        )}
        <div className="row wrap">
          <button
            type="button"
            className="danger-btn"
            onClick={() => void deleteAvatar()}
            disabled={!user.avatar_updated_at}
          >
            {language === "de" ? "Profilbild entfernen" : "Remove profile picture"}
          </button>
          <button
            type="button"
            onClick={() => void saveAvatar()}
            disabled={!avatarPreviewDataUrl && !(avatarSelectedFile && isHeicFile(avatarSelectedFile))}
          >
            {language === "de" ? "Speichern" : "Save"}
          </button>
          <button type="button" onClick={closeAvatarModal}>
            {language === "de" ? "Abbrechen" : "Cancel"}
          </button>
        </div>
      </div>
    </div>
  );
}
