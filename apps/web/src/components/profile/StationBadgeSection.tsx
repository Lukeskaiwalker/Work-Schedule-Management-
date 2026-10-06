import { useCallback, useEffect, useState } from "react";

import { ApiError } from "../../api/client";
import { useAppContext } from "../../context/AppContext";
import { getMyStationBadge, rotateMyStationBadge, type StationBadge } from "../../utils/stationBadgeApi";
import { StationBadgeCard } from "./StationBadgeCard";

/**
 * The "Stations-Ausweis" card on the profile page.
 *
 * Everybody has one: a DataMatrix they scan at the Regal station instead of
 * tapping their name, and to clock in and out of a Verteiler. The server mints
 * it the first time anybody opens it, so there is no "create" state — only
 * loading, a failed load, and the badge.
 */

type LoadState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; badge: StationBadge };

function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}

export function StationBadgeSection() {
  const { token, language, setNotice } = useAppContext();
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setState({ kind: "loading" });
    try {
      setState({ kind: "ready", badge: await getMyStationBadge(token) });
    } catch (err) {
      setState({ kind: "error", message: errorMessage(err) });
    }
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleRotate() {
    setBusy(true);
    setActionError(null);
    try {
      setState({ kind: "ready", badge: await rotateMyStationBadge(token) });
      setNotice("Neuer Ausweis-Code erzeugt. Den alten Ausweis bitte entsorgen.");
    } catch (err) {
      setActionError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="profile-page-card profile-page-card--station-badge">
      <header className="profile-page-card-head">
        <h2 className="profile-page-card-title">Stations-Ausweis</h2>
      </header>

      <p className="calendar-feed-intro">
        Dein persönlicher Code für die Scan-Station im Lager. Am Regal scannen statt den Namen anzutippen — und am
        Verteiler: erst den Verteiler scannen, dann deinen Ausweis, und du bist eingestempelt. Zum Ausstempeln nur
        den Ausweis noch einmal scannen.
      </p>

      {state.kind === "loading" && <p className="calendar-feed-muted">Lade…</p>}

      {state.kind === "error" && (
        <div className="calendar-feed-error-block" role="alert">
          <p className="calendar-feed-error">{state.message}</p>
          <button type="button" className="calendar-feed-secondary-btn" onClick={() => void load()}>
            Erneut versuchen
          </button>
        </div>
      )}

      {state.kind === "ready" && (
        <StationBadgeCard
          badge={state.badge}
          busy={busy}
          error={actionError}
          onRotate={() => void handleRotate()}
          language={language}
        />
      )}

      <small className="calendar-feed-note">
        Wer deinen Ausweis hat, kann an der Station in deinem Namen buchen — nicht weitergeben. Verloren? Einfach einen
        neuen Code erzeugen; der alte funktioniert dann sofort nicht mehr.
      </small>
    </div>
  );
}
