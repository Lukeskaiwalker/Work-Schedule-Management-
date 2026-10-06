/**
 * The Arbeitszeit block under a board's Materialliste: who worked on it, and
 * for how long, clocked at the Regal station with their badge.
 *
 * One position per person. Closed sessions are summed; a running one is shown
 * as "läuft seit 14:02" beside the sum and NOT added in — it has no length
 * yet. A session running past STALE_RUNNING_HOURS is marked, because at that
 * point a forgotten clock-out is far likelier than a fifteen-hour shift.
 *
 * Ending a running session by hand is the correction for exactly that: the
 * owner may end their own, a Werkstatt manager anybody's. The end time is
 * asked for, because the honest end of a forgotten session is when the person
 * stopped, not when somebody noticed. It defaults to now only while "now" is
 * plausible; on a stale session the field starts EMPTY and must be filled --
 * there, now is the one answer known to be wrong, and a single click on
 * Speichern would otherwise book everything since yesterday afternoon.
 */
import { useState } from "react";

import type { MaterialTexts } from "./panelMaterialTexts";
import {
  canEndRunning,
  formatLabourHours,
  formatRunningSince,
  isStale,
  toLocalInputValue,
} from "./panelLabour";
import type { PanelLabourLine, PanelMaterial } from "../../types/schaltplan";
import { parseServerDateTime } from "../../utils/dates";

export type PanelLabourBlockProps = {
  material: PanelMaterial;
  t: MaterialTexts;
  language: "de" | "en";
  currentUserId?: number | null;
  canManageWerkstatt?: boolean;
  busy: boolean;
  /** `endedAt` is an ISO string, or null for "now". */
  onEnd: (sessionId: number, endedAt: string | null) => void;
  /** Injectable for tests; the real block reads the clock. */
  now?: Date;
};

export function PanelLabourBlock({
  material,
  t,
  language,
  currentUserId,
  canManageWerkstatt = false,
  busy,
  onEnd,
  now,
}: PanelLabourBlockProps): JSX.Element {
  const lines = material.labour ?? [];
  const clock = now ?? new Date();
  const [ending, setEnding] = useState<number | null>(null);

  return (
    <section className="sp-lab" aria-label={t.labourTitle}>
      <header className="sp-lab-head">
        <h5>{t.labourTitle}</h5>
        {lines.length > 0 && (
          <span className="sp-lab-total">
            <b>{formatLabourHours(material.labour_minutes ?? 0, language)}</b> {t.labourTotal}
          </span>
        )}
      </header>

      {lines.length === 0 ? (
        <p className="sp-lab-empty">{t.labourEmpty}</p>
      ) : (
        <ul className="sp-lab-rows">
          {lines.map((line) => (
            <LabourRow
              key={line.user_id}
              line={line}
              t={t}
              language={language}
              now={clock}
              mayEnd={canEndRunning(line, currentUserId, canManageWerkstatt)}
              busy={busy}
              formOpen={ending !== null && ending === line.running_session_id}
              onOpen={() => setEnding(line.running_session_id)}
              onCancel={() => setEnding(null)}
              onSubmit={(endedAt) => {
                if (line.running_session_id == null) return;
                onEnd(line.running_session_id, endedAt);
                setEnding(null);
              }}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

type LabourRowProps = {
  line: PanelLabourLine;
  t: MaterialTexts;
  language: "de" | "en";
  now: Date;
  mayEnd: boolean;
  busy: boolean;
  formOpen: boolean;
  onOpen: () => void;
  onCancel: () => void;
  onSubmit: (endedAt: string) => void;
};

function LabourRow({ line, t, language, now, mayEnd, busy, formOpen, onOpen, onCancel, onSubmit }: LabourRowProps) {
  const running = line.running_since !== null;
  const stale = running && isStale(line.running_since, now);
  const [endValue, setEndValue] = useState(() => (stale ? "" : toLocalInputValue(now)));
  // The picker cannot go before the start: the server refuses that with a 400.
  const startedAt = parseServerDateTime(line.running_since);

  return (
    <li className={`sp-lab-row${stale ? " is-stale" : ""}`}>
      <span className="sp-lab-name">{line.name}</span>
      <span className="sp-lab-hours">{formatLabourHours(line.minutes, language)}</span>
      <span className="sp-lab-sessions">{line.sessions > 0 ? t.labourSessions(line.sessions) : ""}</span>
      {running && (
        <span className="sp-lab-running">
          <span className="sp-lab-dot" aria-hidden="true" />
          {`${t.labourRunning} ${formatRunningSince(line.running_since, now, language)}`}
          {stale && <b className="sp-lab-stale">{t.labourStale}</b>}
        </span>
      )}
      {running && mayEnd && !formOpen && (
        <button type="button" className="sp-btn sp-lab-end" disabled={busy} onClick={onOpen}>
          {t.labourEnd}
        </button>
      )}
      {formOpen && (
        <form
          className="sp-lab-form"
          onSubmit={(event) => {
            event.preventDefault();
            // Never send null from here: the server reads it as "now".
            const parsed = endValue ? new Date(endValue) : null;
            if (!parsed || Number.isNaN(parsed.getTime())) return;
            onSubmit(parsed.toISOString());
          }}
        >
          <label>
            {t.labourEndAt}
            <input
              type="datetime-local"
              value={endValue}
              min={startedAt ? toLocalInputValue(startedAt) : undefined}
              max={toLocalInputValue(now)}
              onChange={(event) => setEndValue(event.target.value)}
              required
            />
          </label>
          <button type="submit" className="sp-btn sp-btn--primary" disabled={busy}>
            {t.labourEndConfirm}
          </button>
          <button type="button" className="sp-btn" onClick={onCancel}>
            {t.cancel}
          </button>
        </form>
      )}
    </li>
  );
}
