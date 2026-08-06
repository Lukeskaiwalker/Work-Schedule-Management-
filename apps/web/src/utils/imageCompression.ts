/**
 * Client-side photo downscaling for construction-report uploads.
 *
 * A modern phone camera produces 4–6 MB per shot, and a report routinely
 * carries six — roughly 25 MB over a rural link, with no XHR timeout and no
 * cancel. Downscaling on the device turns that into a couple of hundred KB
 * each without any visible loss at the size the PDF renders them.
 *
 * It also transcodes HEIC for free: Safari can DECODE HEIC into a canvas even
 * though most backends cannot read the container, so re-encoding the canvas as
 * JPEG makes iPhone photos universally readable. `IMAGE_INPUT_ACCEPT` already
 * admits `.heic`.
 *
 * Every failure path returns the ORIGINAL file. A photo that uploads large is
 * far better than a photo that does not upload at all.
 */

/** Long-edge cap. Comfortably above what the PDF renders at. */
const MAX_EDGE = 2048;
const JPEG_QUALITY = 0.8;
/** Below this, re-encoding usually costs more bytes than it saves. */
const SKIP_UNDER_BYTES = 512 * 1024;

function canDownscale(): boolean {
  return typeof createImageBitmap === "function" && typeof document !== "undefined";
}

async function toBlob(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), "image/jpeg", JPEG_QUALITY);
  });
}

/**
 * Downscale one image. Returns the original file unchanged if the image is
 * already small, the browser cannot do it, or anything at all goes wrong.
 */
export async function compressReportImage(file: File): Promise<File> {
  const isHeic = /heic|heif/i.test(file.type) || /\.hei[cf]$/i.test(file.name);
  // HEIC is always worth re-encoding even when small — the backend and the PDF
  // renderer generally cannot read the container at all.
  if (!isHeic && file.size < SKIP_UNDER_BYTES) return file;
  if (!canDownscale()) return file;

  let bitmap: ImageBitmap | null = null;
  try {
    bitmap = await createImageBitmap(file);
    const longEdge = Math.max(bitmap.width, bitmap.height);
    const scale = longEdge > MAX_EDGE ? MAX_EDGE / longEdge : 1;
    // Nothing to gain: already small enough and already a JPEG.
    if (scale === 1 && !isHeic && file.type === "image/jpeg") return file;

    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    const ctx = canvas.getContext("2d");
    if (!ctx) return file;
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);

    const blob = await toBlob(canvas);
    if (!blob) return file;
    // Only accept the result if it actually saved bytes (a small PNG can
    // re-encode larger). HEIC always wins because of the format change.
    if (!isHeic && blob.size >= file.size) return file;

    const name = file.name.replace(/\.(hei[cf]|png|webp|jpeg|jpg)$/i, "") + ".jpg";
    return new File([blob], name, { type: "image/jpeg", lastModified: file.lastModified });
  } catch {
    return file;
  } finally {
    bitmap?.close();
  }
}

/** Downscale a batch, preserving order. Failures fall back per-file. */
export async function compressReportImages(files: File[]): Promise<File[]> {
  return Promise.all(files.map((file) => compressReportImage(file)));
}
