import { useCallback, useEffect, useRef, useState } from "react";

/**
 * useCameraScanner — decode barcodes from the phone camera.
 *
 * Companion to `useBarcodeScanner` (the HID/Bluetooth keyboard-wedge hook).
 * That one needs hardware; this one needs nothing but the phone in the
 * packer's hand, at the cost of a camera permission and a lazy-loaded decoder.
 *
 * DESIGN NOTES
 *
 * * The decoder (`@zxing/browser`, ~90 kB gzip) is loaded with a dynamic
 *   `import()` the first time the camera is actually opened. It must never
 *   land in the main bundle — most sessions never scan.
 *
 * * `window.isSecureContext` is checked FIRST and reported as its own error.
 *   `navigator.mediaDevices` is simply `undefined` on plain http, which
 *   otherwise surfaces as an unreadable TypeError. This is the failure the
 *   crew will actually hit: the camera works over https and on localhost, but
 *   NOT when the app is reached as `http://<lan-ip>`.
 *
 * * Every start is stamped with a generation number. React StrictMode invokes
 *   effects twice in development, and without this the first (discarded) start
 *   would leave a live MediaStream — a camera light that never goes out.
 *
 * * Repeat suppression is EDGE-triggered, not time-based. ZXing re-invokes the
 *   callback every `delayBetweenScanSuccess` for as long as a code stays
 *   decodable, so a plain time cooldown is a rate limiter: a label left in
 *   frame would be re-added every time the window lapsed. Instead the same code
 *   is accepted again only once the decoder has reported it ABSENT for a few
 *   frames — i.e. the packer moved the phone away and back, which is exactly
 *   the gesture that means "one more of these". DIFFERENT codes are never
 *   throttled.
 */

/** Only formats that actually appear on electrical stock, so the decoder
 *  doesn't burn frames looking for Aztec/PDF417 on a warehouse shelf. */
const WANTED_FORMAT_NAMES = [
  "QR_CODE",
  "EAN_13",
  "EAN_8",
  "CODE_128",
  "CODE_39",
  "ITF",
  "UPC_A",
  "UPC_E",
  "DATA_MATRIX",
] as const;

export type CameraScannerError =
  | "insecure_context"
  | "unsupported"
  | "permission_denied"
  | "no_camera"
  | "load_failed"
  | "unknown";

export type CameraScannerStatus = "idle" | "starting" | "scanning" | "error";

type Options = {
  /** Start the camera when true; release it when false. */
  active: boolean;
  onScan: (code: string) => void;
};

/** How long after a decode the viewfinder still reports "I can see a code". */
const SIGHTED_HOLD_MS = 700;

/**
 * How long a code must go completely UNSEEN before the same code counts as a
 * new item. Long enough that intermittent decode failures (motion blur, focus
 * hunting — routine while a label is held in view) cannot be mistaken for the
 * label having been taken away.
 */
const AWAY_MS = 1200;

export type ScanGateState = {
  /** The last code decoded, accepted or not. */
  code: string;
  /** When that code was LAST SEEN, epoch ms — refreshed on every decode. */
  lastSeenAt: number;
};

/**
 * Decide whether a decoded code is a NEW item or the same label still sitting
 * in the viewfinder.
 *
 * Pure and exported so the rule can be reasoned about without a camera. The
 * whole correctness of camera scanning rests on it: ZXing re-fires for as long
 * as a code stays decodable, so treating every decode as an item would add the
 * same article several times a second.
 *
 * The rule is "has it been GONE", not "has it been N frames since a hit". An
 * earlier version counted consecutive empty frames, which looked right against
 * a clean synthetic timeline but failed in the field: real decoding interleaves
 * hits with misses, so a label held steady would accumulate enough misses to
 * look absent and get added two or three times. Because `lastSeenAt` is
 * refreshed by EVERY decode — including suppressed ones — a label in view keeps
 * the away-timer permanently reset, however noisy the decoding is.
 */
export function shouldAcceptScan(state: ScanGateState, code: string, now: number): boolean {
  if (state.code !== code) return true; // a different label is always new
  return now - state.lastSeenAt >= AWAY_MS; // same label: only after it was gone
}

type ScannerControls = { stop: () => void };

function classifyError(err: unknown): CameraScannerError {
  const name = (err as { name?: string } | null)?.name ?? "";
  if (name === "NotAllowedError" || name === "SecurityError") return "permission_denied";
  if (name === "NotFoundError" || name === "OverconstrainedError") return "no_camera";
  if (name === "NotReadableError" || name === "AbortError") return "no_camera";
  return "unknown";
}

export function useCameraScanner({ active, onScan }: Options) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const controlsRef = useRef<ScannerControls | null>(null);
  const generationRef = useRef(0);
  const lastSeenRef = useRef<ScanGateState>({ code: "", lastSeenAt: 0 });
  /** Cleared by a timer so the UI can say "searching" vs "code in view". */
  const sightedTimerRef = useRef<number | null>(null);
  // Kept in a ref so restarting the camera is not coupled to render identity
  // of the callback — the packing screen re-renders on every added line.
  const onScanRef = useRef(onScan);
  onScanRef.current = onScan;

  const [status, setStatus] = useState<CameraScannerStatus>("idle");
  const [error, setError] = useState<CameraScannerError | null>(null);
  const [attempt, setAttempt] = useState(0);
  /** True while a barcode is actually decodable — drives the live viewfinder
   *  feedback, so the packer can tell "aiming" from "nothing readable". */
  const [sighted, setSighted] = useState(false);

  const retry = useCallback(() => {
    setError(null);
    setAttempt((value) => value + 1);
  }, []);

  useEffect(() => {
    if (!active) return;

    const generation = ++generationRef.current;
    let cancelled = false;
    /** Set as soon as getUserMedia resolves, so a start aborted before the
     *  decoder hands back controls still releases the camera. */
    let rawStream: MediaStream | null = null;
    let trackEndedHandler: (() => void) | null = null;

    /** Tracks whose 'ended' we are listening to, so cleanup can detach. */
    let watchedTracks: MediaStreamTrack[] = [];

    async function start() {
      setStatus("starting");
      setError(null);
      // Per-session reset: without this, closing and reopening the sheet within
      // the flicker window would swallow the first scan of the new session.
      lastSeenRef.current = { code: "", lastSeenAt: 0 };

      if (typeof window !== "undefined" && window.isSecureContext === false) {
        setError("insecure_context");
        setStatus("error");
        return;
      }
      if (!navigator.mediaDevices?.getUserMedia) {
        setError("unsupported");
        setStatus("error");
        return;
      }

      let zxing: typeof import("@zxing/browser");
      try {
        zxing = await import("@zxing/browser");
      } catch {
        if (cancelled) return;
        setError("load_failed");
        setStatus("error");
        return;
      }
      if (cancelled || generation !== generationRef.current) return;

      const video = videoRef.current;
      if (!video) {
        setError("unknown");
        setStatus("error");
        return;
      }

      try {
        const reader = new zxing.BrowserMultiFormatReader(undefined, {
          delayBetweenScanAttempts: 120,
          delayBetweenScanSuccess: 400,
        });
        const formats = WANTED_FORMAT_NAMES.map(
          (name) => zxing.BarcodeFormat[name as keyof typeof zxing.BarcodeFormat],
        ).filter((value): value is number => typeof value === "number");
        if (formats.length > 0) reader.possibleFormats = formats;

        const controls = await reader.decodeFromConstraints(
          // "ideal" rather than "exact": a laptop with only a front camera
          // must still work instead of throwing OverconstrainedError.
          { video: { facingMode: { ideal: "environment" } } },
          video,
          (result) => {
            // A frame with nothing decodable is completely normal and carries
            // no information about whether the label has been taken away —
            // that is decided purely by elapsed time since the last decode.
            if (!result) return;
            const code = result.getText().trim();
            if (!code) return;

            const now = Date.now();
            const accept = shouldAcceptScan(lastSeenRef.current, code, now);
            // Refresh on EVERY decode, accepted or not: this is what keeps a
            // label that is merely being held in view from ever looking absent.
            lastSeenRef.current = { code, lastSeenAt: now };

            // Live feedback — the packer needs to know the camera can read
            // something even when the code is a repeat we are suppressing.
            setSighted(true);
            if (sightedTimerRef.current) window.clearTimeout(sightedTimerRef.current);
            sightedTimerRef.current = window.setTimeout(
              () => setSighted(false),
              SIGHTED_HOLD_MS,
            );

            if (!accept) return;
            // Android gives haptic confirmation; a no-op on iOS, which has no
            // Vibration API — the sheet's own feedback line is what iOS gets.
            navigator.vibrate?.(40);
            onScanRef.current(code);
          },
        );

        if (cancelled || generation !== generationRef.current) {
          controls.stop();
          return;
        }
        controlsRef.current = controls;
        rawStream = (video.srcObject as MediaStream | null) ?? null;

        // A track can end under us — permission revoked mid-shift, another app
        // grabbing the camera, the OS suspending it. Without this the preview
        // freezes on the last frame while the UI still claims "scanning" and
        // offers no way out.
        const handleTrackEnded = () => {
          if (cancelled || generation !== generationRef.current) return;
          setError("no_camera");
          setStatus("error");
        };
        watchedTracks = rawStream?.getVideoTracks() ?? [];
        watchedTracks.forEach((track) =>
          track.addEventListener("ended", handleTrackEnded),
        );
        trackEndedHandler = handleTrackEnded;

        setStatus("scanning");
      } catch (err: unknown) {
        if (cancelled) return;
        setError(classifyError(err));
        setStatus("error");
      }
    }

    void start();

    return () => {
      cancelled = true;
      if (trackEndedHandler) {
        watchedTracks.forEach((track) =>
          track.removeEventListener("ended", trackEndedHandler as () => void),
        );
      }
      controlsRef.current?.stop();
      controlsRef.current = null;
      // Belt and braces: controls.stop() disposes the stream, but a start
      // aborted between getUserMedia and controls would otherwise leak it.
      rawStream?.getTracks().forEach((track) => track.stop());
      const video = videoRef.current;
      if (video?.srcObject) {
        (video.srcObject as MediaStream).getTracks().forEach((track) => track.stop());
        video.srcObject = null;
      }
      setStatus("idle");
      setSighted(false);
      if (sightedTimerRef.current) window.clearTimeout(sightedTimerRef.current);
      // Clear the failure too: the hook outlives a closed sheet, so a denied
      // permission would otherwise paint a stale error over the next session's
      // viewfinder even after the user granted access.
      setError(null);
    };
  }, [active, attempt]);

  return { status, error, sighted, videoRef, retry };
}
