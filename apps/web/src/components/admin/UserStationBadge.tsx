import { useState } from "react";

import { ApiError } from "../../api/client";
import { StationBadgeCard } from "../profile/StationBadgeCard";
import { getUserStationBadge, rotateUserStationBadge, type StationBadge } from "../../utils/stationBadgeApi";

/**
 * A colleague's station badge inside their admin user details, for whoever
 * hands badges out (users:manage).
 *
 * Loaded on request, not on expand: reading a badge mints one if the person
 * has none yet, and browsing the user list should not mint a badge for every
 * row an admin happens to open.
 */
type State =
  | { kind: "closed" }
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; badge: StationBadge };

function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}

type UserStationBadgeProps = {
  token: string | null;
  userId: number;
  language: "de" | "en";
};

export function UserStationBadge({ token, userId, language }: UserStationBadgeProps): JSX.Element {
  const [state, setState] = useState<State>({ kind: "closed" });
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  async function open() {
    setState({ kind: "loading" });
    try {
      setState({ kind: "ready", badge: await getUserStationBadge(token, userId) });
    } catch (err) {
      setState({ kind: "error", message: errorMessage(err) });
    }
  }

  async function rotate() {
    setBusy(true);
    setActionError(null);
    try {
      setState({ kind: "ready", badge: await rotateUserStationBadge(token, userId) });
    } catch (err) {
      setActionError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (state.kind === "closed" || state.kind === "error") {
    return (
      <div>
        {state.kind === "error" && (
          <p className="calendar-feed-error" role="alert">
            {state.message}
          </p>
        )}
        <button type="button" className="admin-users-inline-save" onClick={() => void open()}>
          {language === "de" ? "Stations-Ausweis anzeigen" : "Show station badge"}
        </button>
      </div>
    );
  }
  if (state.kind === "loading") {
    return <p className="calendar-feed-muted">{language === "de" ? "Lade…" : "Loading…"}</p>;
  }
  return (
    <StationBadgeCard
      badge={state.badge}
      busy={busy}
      error={actionError}
      onRotate={() => void rotate()}
      language={language}
    />
  );
}
