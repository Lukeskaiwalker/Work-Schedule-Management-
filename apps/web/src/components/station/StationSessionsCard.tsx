/**
 * StationSessionsCard — counts the Pi holds locally, and the one action that
 * moves them.
 *
 * A session lives on the Pi until somebody imports it; importing writes it into
 * a Werkstatt inventory. That is deliberately re-runnable — an already-imported
 * session keeps its stamp and offers "import again" rather than disappearing,
 * because the failure mode in the field is a half-finished count, not a
 * duplicate one.
 */
import type { StationSession } from "../../utils/stationApi";
import { FeedbackLine, type Feedback } from "./StationPrimitives";
import { formatAge, formatStamp, type StationT } from "./stationText";

export type StationSessionState = "idle" | "loading" | "ready" | "error";

export interface StationSessionsCardProps {
  t: StationT;
  de: boolean;
  now: number;
  sessions: StationSession[];
  sessionState: StationSessionState;
  sessionError: string | null;
  /** Name of the session currently importing, or null. Blocks the other rows. */
  importingName: string | null;
  importFeedback: Feedback | null;
  onReload: () => void;
  onImport: (session: StationSession) => void;
}

function SessionRow({
  session,
  t,
  de,
  now,
  importingName,
  onImport,
}: {
  session: StationSession;
  t: StationT;
  de: boolean;
  now: number;
  importingName: string | null;
  onImport: (session: StationSession) => void;
}) {
  const label = importingName === session.name
    ? t("importing")
    : session.imported_at
      ? t("importAgain")
      : t("importAction");

  return (
    <tr>
      <td>
        <span className="pi-station-mono">{session.name}</span>
        {session.imported_at && (
          <span className="pi-station-tag">
            {t("imported")} · {formatStamp(session.imported_at, de)}
          </span>
        )}
      </td>
      <td className="pi-station-num">{session.articles}</td>
      <td className="pi-station-num">{session.total_qty}</td>
      <td className="pi-station-num">{session.total_scans}</td>
      <td>{formatAge(session.last_counted_at ?? session.started_at, de, now)}</td>
      <td className="pi-station-row-action">
        <button
          type="button"
          className="werkstatt-card-action"
          onClick={() => onImport(session)}
          disabled={importingName !== null}
        >
          {label}
        </button>
      </td>
    </tr>
  );
}

export function StationSessionsCard({
  t,
  de,
  now,
  sessions,
  sessionState,
  sessionError,
  importingName,
  importFeedback,
  onReload,
  onImport,
}: StationSessionsCardProps) {
  return (
    <div className="admin-page-card">
      <h2 className="admin-page-card-title">{t("sessionsTitle")}</h2>
      <p className="admin-tools-desc">{t("sessionsIntro")}</p>

      {sessionState === "loading" && <p className="admin-page-muted">{t("reloading")}</p>}

      {sessionState === "error" && (
        <div className="pi-station-notice pi-station-notice--bad">
          <strong>{sessionError ?? t("sessionsFailed")}</strong>
          <button type="button" className="werkstatt-card-action" onClick={onReload}>
            {t("reload")}
          </button>
        </div>
      )}

      {sessionState === "ready" && sessions.length === 0 && (
        <p className="admin-page-muted">{t("sessionsEmpty")}</p>
      )}

      {sessions.length > 0 && (
        <div className="pi-station-table-wrap">
          <table className="pi-station-table">
            <thead>
              <tr>
                <th>{t("colSession")}</th>
                <th className="pi-station-num">{t("colArticles")}</th>
                <th className="pi-station-num">{t("colQty")}</th>
                <th className="pi-station-num">{t("colScans")}</th>
                <th>{t("colLast")}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {sessions.map((session) => (
                <SessionRow
                  key={session.name}
                  session={session}
                  t={t}
                  de={de}
                  now={now}
                  importingName={importingName}
                  onImport={onImport}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      <FeedbackLine feedback={importFeedback} />
    </div>
  );
}
