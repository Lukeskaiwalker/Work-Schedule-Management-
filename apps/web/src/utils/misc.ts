import { IMAGE_EXTENSIONS, HEIC_EXTENSIONS } from "../constants";
import type { AvatarCropOutput, AvatarImageSize, Language, UpdateStatus } from "../types";

export function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

export function fileExtension(fileName: string): string {
  const normalized = String(fileName || "").trim().toLowerCase();
  if (!normalized.includes(".")) return "";
  return normalized.split(".").pop() ?? "";
}

export function isHeicFile(file: File): boolean {
  const mime = String(file.type || "").trim().toLowerCase();
  if (mime === "image/heic" || mime === "image/heif") return true;
  return HEIC_EXTENSIONS.has(fileExtension(file.name));
}

export function isImageUploadFile(file: File): boolean {
  const mime = String(file.type || "").trim().toLowerCase();
  if (mime.startsWith("image/")) return true;
  return IMAGE_EXTENSIONS.has(fileExtension(file.name));
}

export function avatarCropOutput(file: File | null): AvatarCropOutput {
  if (file && isHeicFile(file)) return { mimeType: "image/jpeg", extension: "jpg" };
  const mime = String(file?.type || "").trim().toLowerCase();
  if (mime === "image/png") return { mimeType: "image/png", extension: "png" };
  if (mime === "image/webp") return { mimeType: "image/webp", extension: "webp" };
  if (mime === "image/jpeg" || mime === "image/jpg") return { mimeType: "image/jpeg", extension: "jpg" };

  const extension = file ? fileExtension(file.name) : "";
  if (extension === "png") return { mimeType: "image/png", extension: "png" };
  if (extension === "webp") return { mimeType: "image/webp", extension: "webp" };
  if (extension === "jpg" || extension === "jpeg") return { mimeType: "image/jpeg", extension: "jpg" };

  return { mimeType: "image/jpeg", extension: "jpg" };
}

export function loadImage(source: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Image could not be loaded"));
    img.src = source;
  });
}

export async function buildAvatarCropDataUrl(
  source: string,
  zoom: number,
  offsetXPercent: number,
  offsetYPercent: number,
  outputSize = 320,
  outputMimeType = "image/jpeg",
): Promise<string> {
  const img = await loadImage(source);
  const canvas = document.createElement("canvas");
  canvas.width = outputSize;
  canvas.height = outputSize;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas context unavailable");

  const baseCropSize = Math.min(img.width, img.height);
  const safeZoom = clamp(zoom, 1, 3);
  const cropSize = baseCropSize / safeZoom;
  const maxShiftX = Math.max(0, (img.width - cropSize) / 2);
  const maxShiftY = Math.max(0, (img.height - cropSize) / 2);
  const targetCenterX = img.width / 2 + clamp(offsetXPercent, -100, 100) * (maxShiftX / 100);
  const targetCenterY = img.height / 2 + clamp(offsetYPercent, -100, 100) * (maxShiftY / 100);
  const sx = clamp(targetCenterX - cropSize / 2, 0, img.width - cropSize);
  const sy = clamp(targetCenterY - cropSize / 2, 0, img.height - cropSize);

  ctx.drawImage(img, sx, sy, cropSize, cropSize, 0, 0, outputSize, outputSize);
  const safeMime = outputMimeType === "image/png" || outputMimeType === "image/webp" ? outputMimeType : "image/jpeg";
  return canvas.toDataURL(safeMime, 0.92);
}

export function avatarStageMetrics(
  imageSize: AvatarImageSize | null,
  stageSize: number,
  zoom: number,
  offsetXPercent: number,
  offsetYPercent: number,
) {
  if (!imageSize || stageSize <= 0) {
    return { maxPanX: 0, maxPanY: 0, translateX: 0, translateY: 0 };
  }
  const coverScale = Math.max(stageSize / imageSize.width, stageSize / imageSize.height);
  const renderedWidth = imageSize.width * coverScale * zoom;
  const renderedHeight = imageSize.height * coverScale * zoom;
  const maxPanX = Math.max(0, (renderedWidth - stageSize) / 2);
  const maxPanY = Math.max(0, (renderedHeight - stageSize) / 2);
  const translateX = (clamp(offsetXPercent, -100, 100) / 100) * maxPanX;
  const translateY = (clamp(offsetYPercent, -100, 100) / 100) * maxPanY;
  return { maxPanX, maxPanY, translateX, translateY };
}

export function normalizeAddressInput(value: string) {
  if (!value) return "";
  return value
    .replace(/\r/g, " ")
    .replace(/\n/g, ", ")
    .replace(/,\s*/g, ", ")
    .replace(/(,\s*){2,}/g, ", ")
    .replace(/\s{2,}/g, " ")
    .trim()
    .replace(/^[,\s]+|[,\s]+$/g, "");
}

export function formatHours(hours: number) {
  return `${hours.toFixed(2)}h`;
}

export function isPlaceholderReleaseVersion(value: string | null | undefined): boolean {
  return String(value || "").trim().toLowerCase() === "local-production";
}

export function commitRefsMatch(left: string | null | undefined, right: string | null | undefined): boolean {
  const leftValue = String(left || "").trim().toLowerCase();
  const rightValue = String(right || "").trim().toLowerCase();
  if (!leftValue || !rightValue) return false;
  return leftValue === rightValue || leftValue.startsWith(rightValue) || rightValue.startsWith(leftValue);
}

export function resolveCurrentReleaseVersion(updateStatus: UpdateStatus | null): string | null {
  const currentVersion = String(updateStatus?.current_version || "").trim();
  const latestVersion = String(updateStatus?.latest_version || "").trim();
  if (currentVersion && !isPlaceholderReleaseVersion(currentVersion)) return currentVersion;
  if (!latestVersion) return null;
  if (updateStatus?.update_available === false) return latestVersion;
  if (commitRefsMatch(updateStatus?.current_commit, updateStatus?.latest_commit)) return latestVersion;
  return null;
}

export function roleOptionLabel(role: string, language: Language): string {
  const normalized = String(role || "").trim().toLowerCase();
  if (language === "de") {
    if (normalized === "admin") return "Admins";
    if (normalized === "ceo") return "Geschäftsführung";
    if (normalized === "accountant") return "Buchhaltung";
    if (normalized === "planning") return "Planung";
    if (normalized === "employee") return "Mitarbeiter";
    return normalized || role;
  }
  if (normalized === "admin") return "Admins";
  if (normalized === "ceo") return "Management";
  if (normalized === "accountant") return "Accountants";
  if (normalized === "planning") return "Planners";
  if (normalized === "employee") return "Employees";
  return normalized || role;
}
