import { useEffect } from "react";

export type LightboxImage = {
  id: number | string;
  src: string;
  alt: string;
  /** Optional file name shown in the corner caption. */
  fileName?: string;
};

type Props = {
  /** Ordered list of images shown in the same message bubble; lets the
   *  viewer step through siblings with arrow keys without reopening. */
  images: LightboxImage[];
  /** Index of the currently visible image (0-based). */
  index: number;
  /** Update the visible index — the parent owns the state so opening,
   *  navigation, and closing are all controlled. */
  onIndexChange: (next: number) => void;
  /** Close handler — fired on backdrop click, ESC, or close button. */
  onClose: () => void;
  language: "de" | "en";
};

/**
 * WhatsApp-style lightbox for thread images. Opens on top of the page,
 * fills most of the viewport, and supports keyboard navigation (← / → /
 * ESC). Pure-presentational: the parent decides which images and which
 * starting index — that lets us reuse the same component from any list
 * (chat bubbles today, project file viewer tomorrow).
 */
export function MessageImageLightbox({
  images,
  index,
  onIndexChange,
  onClose,
  language,
}: Props) {
  const de = language === "de";
  const total = images.length;
  const safeIndex = total === 0 ? 0 : Math.min(Math.max(index, 0), total - 1);
  const current = images[safeIndex];

  // Keyboard handler installs once per open; clamps navigation to the
  // image list bounds so end-of-list wraps to start (and vice versa) for
  // a familiar gallery feel.
  useEffect(() => {
    if (total === 0) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (total < 2) return;
      if (event.key === "ArrowRight") {
        event.preventDefault();
        onIndexChange((safeIndex + 1) % total);
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        onIndexChange((safeIndex - 1 + total) % total);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [safeIndex, total, onClose, onIndexChange]);

  if (!current) return null;

  return (
    <div
      className="message-lightbox-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={current.alt || (de ? "Bildvorschau" : "Image preview")}
      onClick={onClose}
    >
      <div
        className="message-lightbox-stage"
        // Stop clicks inside the stage from bubbling to the backdrop's
        // close handler — only background clicks should dismiss.
        onClick={(event) => event.stopPropagation()}
      >
        <button
          type="button"
          className="message-lightbox-close"
          onClick={onClose}
          aria-label={de ? "Schließen" : "Close"}
          title={de ? "Schließen" : "Close"}
        >
          ×
        </button>
        {total > 1 && (
          <button
            type="button"
            className="message-lightbox-nav message-lightbox-nav--prev"
            onClick={() => onIndexChange((safeIndex - 1 + total) % total)}
            aria-label={de ? "Vorheriges Bild" : "Previous image"}
            title={de ? "Vorheriges Bild" : "Previous image"}
          >
            ‹
          </button>
        )}
        <img
          className="message-lightbox-image"
          src={current.src}
          alt={current.alt}
          // Don't trigger the close handler when clicking the image itself;
          // users may want to long-press / save / inspect.
          onClick={(event) => event.stopPropagation()}
        />
        {total > 1 && (
          <button
            type="button"
            className="message-lightbox-nav message-lightbox-nav--next"
            onClick={() => onIndexChange((safeIndex + 1) % total)}
            aria-label={de ? "Nächstes Bild" : "Next image"}
            title={de ? "Nächstes Bild" : "Next image"}
          >
            ›
          </button>
        )}
        <div className="message-lightbox-caption">
          {current.fileName && (
            <span className="message-lightbox-caption-name" title={current.fileName}>
              {current.fileName}
            </span>
          )}
          {total > 1 && (
            <span className="message-lightbox-caption-counter">
              {safeIndex + 1} / {total}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
