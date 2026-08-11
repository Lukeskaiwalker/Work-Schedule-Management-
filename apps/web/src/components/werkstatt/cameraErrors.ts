/**
 * User-facing copy for camera failures.
 *
 * Shared by every scanner surface (the Kisten sheet, the mobile scan page).
 * These strings are the only explanation the crew gets when the camera refuses
 * to start, and the most common failure — reaching the app over plain http on
 * the LAN — is one nobody guesses without being told. Two copies of that
 * explanation would mean one of them eventually stops matching reality.
 */
import type { CameraScannerError } from "../../hooks/useCameraScanner";

export type CameraErrorCopy = { title: string; body: string };

export function cameraErrorText(error: CameraScannerError, de: boolean): CameraErrorCopy {
  switch (error) {
    case "insecure_context":
      return {
        title: de ? "Kamera nur über HTTPS" : "Camera needs HTTPS",
        body: de
          ? "Browser erlauben die Kamera nur über eine sichere Verbindung. Über http:// im lokalen Netz bleibt sie gesperrt — Bluetooth-Scanner und Suche funktionieren weiterhin."
          : "Browsers only allow the camera over a secure connection. Reached over plain http:// on the LAN it stays blocked — the Bluetooth scanner and search still work.",
      };
    case "unsupported":
      return {
        title: de ? "Kamera nicht verfügbar" : "Camera unavailable",
        body: de
          ? "Dieser Browser unterstützt keinen Kamerazugriff."
          : "This browser does not support camera access.",
      };
    case "permission_denied":
      return {
        title: de ? "Kamerazugriff abgelehnt" : "Camera access denied",
        body: de
          ? "Erlaube den Kamerazugriff in den Browser-Einstellungen und versuche es erneut."
          : "Allow camera access in your browser settings, then try again.",
      };
    case "no_camera":
      return {
        title: de ? "Keine Kamera gefunden" : "No camera found",
        body: de
          ? "Es wurde keine nutzbare Kamera gefunden oder sie wird von einer anderen App belegt."
          : "No usable camera was found, or another app is holding it.",
      };
    case "load_failed":
      return {
        title: de ? "Scanner nicht geladen" : "Scanner failed to load",
        body: de
          ? "Der Scanner konnte nicht geladen werden. Prüfe die Verbindung und versuche es erneut."
          : "The scanner could not be downloaded. Check the connection and try again.",
      };
    default:
      return {
        title: de ? "Kamera konnte nicht starten" : "Camera could not start",
        body: de ? "Bitte erneut versuchen." : "Please try again.",
      };
  }
}

/**
 * Whether offering a retry makes sense.
 *
 * An insecure context or a browser without `mediaDevices` will not change
 * because the user tapped a button — showing a retry there just teaches people
 * that the button does nothing.
 */
export function cameraErrorIsRetryable(error: CameraScannerError): boolean {
  return error !== "insecure_context" && error !== "unsupported";
}
