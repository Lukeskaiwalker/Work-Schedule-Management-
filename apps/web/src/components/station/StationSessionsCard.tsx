/**
 * StationSessionsCard — counts the Pi holds locally, and the one action that
 * moves them.
 *
 * A session lives on the Pi until somebody imports it; importing writes it into
 * a Werkstatt inventory. That is deliberately re-runnable — an already-imported
 * session keeps its stamp and offers "import again" rather than disappearing,
 * because the failure mode in the field is a half-finished count, not a
 * duplicate one. Quantities are SET server-side, so a re-import overwrites.
 *
 * The target select decides where the counts land: any inventory that is
 * still open, or the default — a new inventory for a session never imported,
 * and for one imported before the open inventory it fed. The option says so,
 * and a hint under the select names the rows it applies to, because the
 * difference is invisible until a recount lands in yesterday's inventory.
 */
import { useId } from "react";

import type { InventorySessionSummary, StationSession } from "../../utils/stationApi";
import { FeedbackLine, type Feedback } from "./StationPrimitives";
import { formatAge, formatStamp, type StationT } from "./stationText";

export type StationSessionState = "idle" | "loading" | "ready" | "error";

/** "new" or the id of an open Werkstatt inventory. */
export type ImportTarget = "new" | number;

export const IMPORT_TARGET_NEW: ImportTarget = "new";

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
  openInventories: InventorySessionSummary[];
  importTarget: ImportTarget;
  onImportTargetChange: (target: ImportTarget) => void;
  onReload: () => void;
  onImport: (session: StationSession) => void;
}

function parseTarget(value: string): ImportTarget {
  if (value === IMPORT_TARGET_NEW) return IMPORT_TARGET_NEW;
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : IMPORT_TARGET_NEW;
}

/**
 * The sessions for which the default target does *not* create a new
 * inventory: they were imported before, and the server continues the open
 * inventory they fed. Listed by name so the hint can say which ones.
 */
export function continuedSessionNames(sessions: StationSession[]): string[] {
  return sessions
    .filter((session) => session.imported_session_id != null)
    .map((session) => session.name);
}

function ImportTargetSelect({
  t,
  openInventories,
  importTarget,
  continuedNames,
  onChange,
  disabled,
}: {
  t: StationT;
  openInventories: InventorySessionSummary[];
  importTarget: ImportTarget;
  continuedNames: string[];
  onChange: (target: ImportTarget) => void;
  disabled: boolean;
}) {
  // A label *wrapping* the select would take every option's text into its
  // accessible name; `htmlFor` keeps the name to the two words it should be.
  const selectId = useId();
  const showHint = importTarget === IMPORT_TARGET_NEW && continuedNames.length > 0;
  return (
    <div className="pi-station-target">
      <label className="admin-invite-field-label" htmlFor={selectId}>
        {t("importTarget")}
      </label>
      <select
        id={selectId}
        className="admin-invite-input pi-station-select"
        value={String(importTarget)}
        onChange={(event) => onChange(parseTarget(event.target.value))}
        disabled={disabled}
      >
        <option value={IMPORT_TARGET_NEW}>
          {t("importTargetNew")} ({t("importTargetDefault")})
        </option>
        {openInventories.map((inventory) => (
          <option key={inventory.id} value={String(inventory.id)}>
            {inventory.name} · {inventory.counted_articles} {t("colArticles")}
          </option>
        ))}
      </select>
      {showHint && (
        <p className="pi-station-hint pi-station-target-hint">
          {t("importTargetHint").replace(
            "{names}",
            continuedNames.map((name) => `„${name}“`).join(", "),
          )}
        </p>
      )}
    </div>
  );
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
            {session.imported_session_id != null && ` · ${t("importedInto")} #${session.imported_session_id}`}
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
  openInventories,
  importTarget,
  onImportTargetChange,
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
        <>
          <ImportTargetSelect
            t={t}
            openInventories={openInventories}
            importTarget={importTarget}
            continuedNames={continuedSessionNames(sessions)}
            onChange={onImportTargetChange}
            disabled={importingName !== null}
          />
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
          {sessions.some((session) => session.name === "default") && (
            <p className="pi-station-hint">{t("sessionsDefaultNote")}</p>
          )}
        </>
      )}

      <FeedbackLine feedback={importFeedback} />
    </div>
  );
}
