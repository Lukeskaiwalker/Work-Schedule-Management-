/**
 * StationSetupCard — the copy-pasteable block that turns a fresh Raspberry Pi
 * OS install into a scan station.
 *
 * The script itself is fetched by the page (it is server state); the card owns
 * only the clipboard, which is a purely local concern. Copying can fail — a
 * denied permission, a non-secure origin — and when it does the card says so
 * rather than pretending, because the `<pre>` above is still selectable by hand.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import type { StationT } from "./stationText";

/** How long the "Copied" confirmation stays up. */
const COPY_FEEDBACK_MS = 2_500;

export interface StationSetupCardProps {
  t: StationT;
  script: string;
}

async function copyText(value: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    // Falls through: a denied permission is not an error worth throwing.
  }
  return false;
}

export function StationSetupCard({ t, script }: StationSetupCardProps) {
  const [copied, setCopied] = useState<"idle" | "ok" | "fail">("idle");
  const mountedRef = useRef(true);
  const timerRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (timerRef.current) window.clearTimeout(timerRef.current);
    };
  }, []);

  const doCopy = useCallback(() => {
    void (async () => {
      const ok = await copyText(script);
      if (!mountedRef.current) return;
      setCopied(ok ? "ok" : "fail");
      if (timerRef.current) window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => {
        if (mountedRef.current) setCopied("idle");
      }, COPY_FEEDBACK_MS);
    })();
  }, [script]);

  return (
    <div className="admin-page-card">
      <h2 className="admin-page-card-title">{t("setupTitle")}</h2>
      <p className="admin-tools-desc">{t("setupIntro")}</p>
      <pre className="pi-station-pre">{script}</pre>
      <div className="pi-station-actions">
        <button
          type="button"
          className="admin-invite-submit admin-invite-submit--secondary"
          onClick={doCopy}
        >
          {copied === "ok" ? t("copied") : t("copy")}
        </button>
        {copied === "fail" && <span className="pi-station-warn">{t("copyFailed")}</span>}
      </div>
    </div>
  );
}
