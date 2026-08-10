/**
 * Stands in front of the app in the native shell until a reachable server is known.
 *
 * On the web this is a pass-through — it renders its children and mounts no
 * state at all, so the browser build is byte-for-byte unaffected in behaviour.
 *
 * In the shell it answers the one question a bundled app cannot answer for
 * itself: where is the server? A build-time default covers the normal case, so
 * most installs never see this screen. It appears when there is no default,
 * when the stored address stops answering (the usual cause being a moved LAN
 * IP), or when someone points a device at a different deployment.
 *
 * The launch probe is what makes the screen self-healing: rather than leaving
 * the crew staring at a login form that silently fails to submit, an
 * unreachable server sends them straight here with the old address prefilled
 * and an explanation.
 */
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";

import { isGerman } from "../utils/uiLanguage";
import { IS_NATIVE_SHELL, getServerUrl, normalizeServerUrl, setServerUrl } from "./shell";

/** Long enough for a cold container on a slow link, short enough not to feel hung. */
const PROBE_TIMEOUT_MS = 6000;
const HEALTH_PATH = "/api/healthz";

type Phase = "probing" | "setup" | "ready";

/**
 * Ask a candidate server whether it is an SMPL API.
 *
 * Deliberately stricter than "the host answered": a bare IP on a home network
 * will happily return a router login page with HTTP 200. Requiring the
 * `{"ok": true}` body from /api/healthz is what distinguishes the real server
 * from anything else listening on port 80.
 *
 * The absolute URL passes through the native network bridge untouched — the
 * bridge only rewrites same-origin /api paths.
 */
async function probeServer(base: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const response = await fetch(`${base}${HEALTH_PATH}`, {
      method: "GET",
      signal: controller.signal,
      // The probe must never depend on a session; it only asks "are you there".
      credentials: "omit",
      cache: "no-store",
    });
    if (!response.ok) return false;
    const body = (await response.json()) as { ok?: boolean } | null;
    return body?.ok === true;
  } catch {
    // Abort, DNS failure, TLS failure, CORS rejection — all mean "not usable".
    return false;
  } finally {
    window.clearTimeout(timer);
  }
}

function preferGerman(): boolean {
  // <html lang> rather than the device locale: this screen renders before App
  // mounts, so it reads index.html's value — which is "de", matching App's own
  // default. Following navigator.language instead would show an English gate
  // ahead of a German app on any crew phone set to English.
  return isGerman();
}

type CopyKey =
  | "title"
  | "intro"
  | "label"
  | "placeholder"
  | "connect"
  | "checking"
  | "probing"
  | "invalid"
  | "unreachable";

const COPY: Record<"de" | "en", Record<CopyKey, string>> = {
  de: {
    title: "Server verbinden",
    intro: "Gib die Adresse des SMPL-Servers ein, mit dem sich dieses Gerät verbinden soll.",
    label: "Serveradresse",
    placeholder: "z. B. smpl-office.duckdns.org",
    connect: "Verbinden",
    checking: "Verbindung wird geprüft…",
    probing: "Verbindung wird hergestellt…",
    invalid: "Das ist keine gültige Serveradresse.",
    unreachable:
      "Server nicht erreichbar. Prüfe die Adresse und ob das Gerät im richtigen Netz (ggf. VPN) ist.",
  },
  en: {
    title: "Connect to server",
    intro: "Enter the address of the SMPL server this device should connect to.",
    label: "Server address",
    placeholder: "e.g. smpl-office.duckdns.org",
    connect: "Connect",
    checking: "Checking connection…",
    probing: "Connecting…",
    invalid: "That is not a valid server address.",
    unreachable:
      "Server unreachable. Check the address, and that the device is on the right network (VPN if needed).",
  },
};

function ServerGate({ children }: { children: ReactNode }) {
  const [phase, setPhase] = useState<Phase>(() => (getServerUrl() ? "probing" : "setup"));
  const [draft, setDraft] = useState<string>(() => getServerUrl() ?? "");
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  const copy = COPY[preferGerman() ? "de" : "en"];

  // Verify the stored address once per launch. Re-runs are harmless: every
  // phase other than "probing" returns immediately.
  useEffect(() => {
    if (phase !== "probing") return;
    const base = getServerUrl();
    if (!base) {
      setPhase("setup");
      return;
    }

    let cancelled = false;
    void probeServer(base).then((reachable) => {
      if (cancelled) return;
      if (reachable) {
        setPhase("ready");
        return;
      }
      setError(copy.unreachable);
      setPhase("setup");
    });
    return () => {
      cancelled = true;
    };
  }, [phase, copy.unreachable]);

  const handleSubmit = useCallback(
    async (event: FormEvent) => {
      event.preventDefault();
      if (checking) return;

      const normalized = normalizeServerUrl(draft);
      if (!normalized) {
        setError(copy.invalid);
        return;
      }

      setChecking(true);
      setError(null);
      const reachable = await probeServer(normalized);
      setChecking(false);

      if (!reachable) {
        setError(copy.unreachable);
        return;
      }
      // Only persist an address we have actually spoken to, so a typo can
      // never strand the app on a dead server across relaunches.
      setServerUrl(normalized);
      setPhase("ready");
    },
    [checking, draft, copy.invalid, copy.unreachable],
  );

  if (phase === "ready") return <>{children}</>;

  if (phase === "probing") {
    return (
      <div className="server-gate">
        <div className="server-gate-card">
          <span className="server-gate-spinner" aria-hidden="true" />
          <p className="server-gate-probing">{copy.probing}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="server-gate">
      <form className="server-gate-card" onSubmit={handleSubmit}>
        <h1 className="server-gate-title">{copy.title}</h1>
        <p className="server-gate-intro">{copy.intro}</p>

        <label className="server-gate-label" htmlFor="server-gate-url">
          {copy.label}
        </label>
        <input
          id="server-gate-url"
          className="server-gate-input"
          // NOT type="url". That applies URL constraint validation, which
          // requires an explicit scheme — so the browser would silently refuse
          // to submit "smpl-office.duckdns.org", the exact value the label
          // above tells the user to type, and normalizeServerUrl's bare-host
          // handling would be unreachable. inputMode still gets the URL
          // keyboard without imposing the validation.
          type="text"
          inputMode="url"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          value={draft}
          placeholder={copy.placeholder}
          onChange={(event) => setDraft(event.target.value)}
          disabled={checking}
        />

        {error && (
          <p className="server-gate-error" role="alert">
            {error}
          </p>
        )}

        <button type="submit" className="server-gate-submit" disabled={checking || !draft.trim()}>
          {checking ? copy.checking : copy.connect}
        </button>
      </form>
    </div>
  );
}

export function NativeServerGate({ children }: { children: ReactNode }) {
  // Module-level constant, so this branch is stable for the life of the page —
  // the hook-bearing component below is only ever mounted in the shell.
  if (!IS_NATIVE_SHELL) return <>{children}</>;
  return <ServerGate>{children}</ServerGate>;
}
