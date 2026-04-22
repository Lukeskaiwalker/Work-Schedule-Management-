import { useCallback, useEffect, useRef, useState } from "react";

/**
 * useBarcodeScanner — detects input from an external HID barcode/QR scanner.
 *
 * Most Bluetooth / USB barcode scanners emulate a keyboard: they "type" the
 * scanned payload character-by-character at very high speed, then press Enter.
 * Human typing, by contrast, is much slower. We use this time-gap signature
 * to distinguish a scan from regular typing.
 *
 * The hook attaches a global `keydown` listener and buffers characters that
 * arrive within `interCharTimeoutMs` of each other. When Enter fires with a
 * non-empty buffer of at least `minLength` chars, we treat it as a scan.
 *
 * Scans are suppressed when the user is actively typing into an input /
 * textarea / contenteditable element — so the scanner can still be used
 * inside a search field by binding to its onChange instead.
 *
 * Usage:
 *   const { isListening, lastScan, simulateScan } = useBarcodeScanner({
 *     enabled: true,
 *     onScan: (code) => resolveAndNavigate(code),
 *   });
 */

export interface UseBarcodeScannerOptions {
  /** Attach listener? Default true. */
  enabled?: boolean;
  /** Called when a scan is detected. The raw payload string is passed in. */
  onScan: (code: string) => void;
  /** Max ms between characters to count them as one scan. Default 30. */
  interCharTimeoutMs?: number;
  /** Minimum payload length to accept. Default 3. */
  minLength?: number;
  /** Ignore events while focus is in these elements. Default true. */
  ignoreWhenTyping?: boolean;
}

export interface UseBarcodeScannerResult {
  /** Whether the global listener is currently attached. */
  isListening: boolean;
  /** The most recent scan payload (null before any scan). */
  lastScan: string | null;
  /** Programmatically fire a scan — useful for tests and a dev "paste" input. */
  simulateScan: (code: string) => void;
}

const INPUT_TAG_NAMES = new Set(["INPUT", "TEXTAREA", "SELECT"]);

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (INPUT_TAG_NAMES.has(target.tagName)) return true;
  if (target.isContentEditable) return true;
  return false;
}

export function useBarcodeScanner({
  enabled = true,
  onScan,
  interCharTimeoutMs = 30,
  minLength = 3,
  ignoreWhenTyping = true,
}: UseBarcodeScannerOptions): UseBarcodeScannerResult {
  const [isListening, setIsListening] = useState(false);
  const [lastScan, setLastScan] = useState<string | null>(null);

  // Keep the latest onScan callback in a ref so changing it doesn't re-bind
  // the global listener (which would lose the in-flight buffer).
  const onScanRef = useRef(onScan);
  useEffect(() => {
    onScanRef.current = onScan;
  }, [onScan]);

  const simulateScan = useCallback(
    (code: string) => {
      const trimmed = code.trim();
      if (trimmed.length < minLength) return;
      setLastScan(trimmed);
      onScanRef.current(trimmed);
    },
    [minLength],
  );

  useEffect(() => {
    if (!enabled) {
      setIsListening(false);
      return undefined;
    }

    // Buffer state — captured in the closure so it persists across keydowns.
    let buffer = "";
    let lastKeyAt = 0;

    function flushBuffer(): string {
      const out = buffer;
      buffer = "";
      lastKeyAt = 0;
      return out;
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (ignoreWhenTyping && isTypingTarget(event.target)) {
        // User is editing a text field; leave buffer untouched in case a scan
        // is about to start outside it on the next keystroke.
        return;
      }

      const now = performance.now();
      const timeSinceLast = now - lastKeyAt;

      // If too much time has passed since the previous char, reset — this
      // was probably a stray keystroke, not part of a scan sequence.
      if (buffer.length > 0 && timeSinceLast > interCharTimeoutMs) {
        buffer = "";
      }

      if (event.key === "Enter") {
        const payload = flushBuffer();
        if (payload.length >= minLength) {
          // Prevent the Enter from also submitting any ambient form.
          event.preventDefault();
          setLastScan(payload);
          onScanRef.current(payload);
        }
        return;
      }

      // Accept printable single-character keys (letters, digits, punctuation
      // including the common barcode symbols like "-", "/", ".").
      if (event.key.length === 1) {
        buffer += event.key;
        lastKeyAt = now;
        return;
      }

      // Any other non-printable key (arrow, shift alone, etc.) — if the
      // buffer is non-empty, discard it; the sequence was interrupted.
      if (buffer.length > 0 && event.key !== "Shift" && event.key !== "Control" && event.key !== "Alt") {
        buffer = "";
        lastKeyAt = 0;
      }
    }

    window.addEventListener("keydown", handleKeyDown, { capture: true });
    setIsListening(true);
    return () => {
      window.removeEventListener("keydown", handleKeyDown, { capture: true });
      setIsListening(false);
    };
  }, [enabled, interCharTimeoutMs, minLength, ignoreWhenTyping]);

  return { isListening, lastScan, simulateScan };
}
