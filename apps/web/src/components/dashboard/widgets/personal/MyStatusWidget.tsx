import { useCallback, useRef, useState } from "react";

import { useAppContext } from "../../../../context/AppContext";
import { useDashboardResource } from "../../../../hooks/useDashboardResource";
import type { Language, TimeCurrent } from "../../../../types";
import type { DashboardWidgetSize } from "../../../../types/dashboard";
import { parseServerDateTime } from "../../../../utils/dates";
import {
  TIME_CURRENT_KEY,
  clockIn,
  clockOut,
  endBreak,
  loadTimeCurrent,
  startBreak,
} from "../../../../utils/dashboardTimeApi";
import { DASHBOARD_POLL_MS } from "../../dashboardPolling";
import { DashboardWidgetFrame } from "../../DashboardWidgetFrame";
import { DASHBOARD_WIDGET_META } from "../../widgetMeta";
import type { DashboardWidgetProps } from "../../widgetTypes";
import { formatHours, frameStateOf, localeOf } from "./widgetShared";
import "./personal.css";

/**
 * „Mein Status“: clock in and out, start and end a break, hours today
 * (docs/DASHBOARD.md §1, §1.1, §8.5). Klein shows the state, the hours and
 * the buttons; Mittel adds the hours gauge; Groß adds shift start, the break
 * taken and the hours required today.
 *
 * It reads `/time/current` itself (every 30 s, shared with „Urlaub“) instead
 * of App's `timeCurrent`, which App no longer polls on the overview (§9.4).
 * A clock action is one request however fast the second tap comes, and its
 * failure is said inside the card, not in the app-wide error banner: the
 * person is looking at the card when it happens.
 */
type ClockAction = "clock_in" | "clock_out" | "break_start" | "break_end";

const CLOCK_ACTIONS: Readonly<Record<ClockAction, { run: (token: string | null) => Promise<void>; failed: Record<Language, string> }>> = {
  clock_in: { run: clockIn, failed: { de: "Einstempeln fehlgeschlagen.", en: "Clocking in failed." } },
  clock_out: { run: clockOut, failed: { de: "Ausstempeln fehlgeschlagen.", en: "Clocking out failed." } },
  break_start: {
    run: startBreak,
    failed: { de: "Pause konnte nicht gestartet werden.", en: "The break could not be started." },
  },
  break_end: {
    run: endBreak,
    failed: { de: "Pause konnte nicht beendet werden.", en: "The break could not be ended." },
  },
};

const GAUGE_RADIUS = 26;
const GAUGE_CIRCUMFERENCE = 2 * Math.PI * GAUGE_RADIUS;

type Phase = "out" | "in" | "break";

function phaseOf(current: TimeCurrent): Phase {
  if (!current.clock_entry_id) return "out";
  return current.break_open ? "break" : "in";
}

function phaseLabel(phase: Phase, de: boolean): string {
  if (phase === "break") return de ? "In der Pause" : "On a break";
  if (phase === "in") return de ? "Eingestempelt" : "Clocked in";
  return de ? "Nicht eingestempelt" : "Not clocked in";
}

function HoursGauge({ net, required, language }: { net: number; required: number; language: Language }) {
  const progress = required > 0 ? Math.max(0, Math.min(net / required, 1)) : 0;
  return (
    <svg viewBox="0 0 64 64" className="dw-status__gauge" aria-hidden="true">
      <circle cx="32" cy="32" r={GAUGE_RADIUS} className="dw-status__gauge-track" />
      <circle
        cx="32"
        cy="32"
        r={GAUGE_RADIUS}
        className="dw-status__gauge-fill"
        strokeDasharray={`${progress * GAUGE_CIRCUMFERENCE} ${GAUGE_CIRCUMFERENCE}`}
        transform="rotate(-90 32 32)"
      />
      <text x="32" y="36" textAnchor="middle" className="dw-status__gauge-text">
        {formatHours(net, language).replace(" ", "")}
      </text>
    </svg>
  );
}

function StatusDetails({ current, language }: { current: TimeCurrent; language: Language }) {
  const de = language === "de";
  const shiftStart = parseServerDateTime(current.clock_in);
  const breakMinutes = Math.round(Number(current.break_hours_live ?? 0) * 60);
  return (
    <dl className="dw-status__details">
      <div>
        <dt>{de ? "Schicht seit" : "Shift since"}</dt>
        <dd>
          {shiftStart && current.clock_entry_id
            ? shiftStart.toLocaleTimeString(localeOf(language), { hour: "2-digit", minute: "2-digit" })
            : "–"}
        </dd>
      </div>
      <div>
        <dt>{de ? "Pause heute" : "Break today"}</dt>
        <dd>{`${Number.isFinite(breakMinutes) ? breakMinutes : 0} min`}</dd>
      </div>
      <div>
        <dt>{de ? "Soll heute" : "Required today"}</dt>
        <dd>{formatHours(Number(current.required_daily_hours ?? 0), language)}</dd>
      </div>
    </dl>
  );
}

type StatusBodyProps = {
  current: TimeCurrent;
  size: DashboardWidgetSize;
  language: Language;
  pending: ClockAction | null;
  failed: ClockAction | null;
  onRun: (action: ClockAction) => void;
};

function StatusBody({ current, size, language, pending, failed, onRun }: StatusBodyProps) {
  const de = language === "de";
  const phase = phaseOf(current);
  const net = Number(current.daily_net_hours ?? 0);
  const required = Number(current.required_daily_hours ?? 0);
  const hoursLine = `${de ? "Heute" : "Today"}: ${formatHours(net, language).replace(" h", "")} / ${formatHours(required, language)}`;
  const busy = pending !== null;
  const clockedIn = phase !== "out";

  return (
    <div className={`dw-status dw-status--${size}`}>
      <div className="dw-status__summary">
        {size !== "small" ? <HoursGauge net={net} required={required} language={language} /> : null}
        <div className="dw-status__copy">
          <p className="dw-status__state">
            <span className={`dw-status__dot dw-status__dot--${phase}`} aria-hidden="true" />
            <span>{phaseLabel(phase, de)}</span>
          </p>
          <p className="dw-status__hours">{hoursLine}</p>
        </div>
      </div>
      {size === "large" ? <StatusDetails current={current} language={language} /> : null}
      <div className="dw-status__actions">
        <button
          type="button"
          className="dw-status__button dw-status__button--primary"
          disabled={busy}
          aria-busy={pending === "clock_in" || pending === "clock_out"}
          onClick={() => onRun(clockedIn ? "clock_out" : "clock_in")}
        >
          {clockedIn ? (de ? "Ausstempeln" : "Clock out") : de ? "Einstempeln" : "Clock in"}
        </button>
        <button
          type="button"
          className="dw-status__button"
          disabled={busy || !clockedIn}
          aria-busy={pending === "break_start" || pending === "break_end"}
          onClick={() => onRun(phase === "break" ? "break_end" : "break_start")}
        >
          {phase === "break" ? (de ? "Pause beenden" : "End break") : de ? "Pause" : "Break"}
        </button>
      </div>
      {failed ? (
        <p className="dw-status__error" role="alert">
          {CLOCK_ACTIONS[failed].failed[language]}
        </p>
      ) : null}
    </div>
  );
}

export default function MyStatusWidget({ size }: DashboardWidgetProps) {
  const { language, token } = useAppContext();
  const resource = useDashboardResource(TIME_CURRENT_KEY, loadTimeCurrent, { pollMs: DASHBOARD_POLL_MS.timeCurrent });
  const { reload } = resource;
  const [pending, setPending] = useState<ClockAction | null>(null);
  const [failed, setFailed] = useState<ClockAction | null>(null);
  // A ref as well as the state: two taps inside one frame both still see
  // `pending === null`, and a second clock-in would be a second shift.
  const inFlight = useRef(false);

  const run = useCallback(
    async (action: ClockAction) => {
      if (inFlight.current) return;
      inFlight.current = true;
      setPending(action);
      setFailed(null);
      try {
        await CLOCK_ACTIONS[action].run(token);
      } catch {
        setFailed(action);
      }
      try {
        // After a failure too: „Already clocked in“ means another device
        // moved the state, and the card should show where things stand. The
        // buttons stay off until it does: until then they still offer the
        // old phase's action, and a second tap would send the wrong request.
        await reload();
      } finally {
        inFlight.current = false;
        setPending(null);
      }
    },
    [token, reload],
  );

  return (
    <DashboardWidgetFrame title={DASHBOARD_WIDGET_META.my_status.title[language]} state={frameStateOf(resource)}>
      {resource.data ? (
        <StatusBody
          current={resource.data}
          size={size}
          language={language}
          pending={pending}
          failed={failed}
          onRun={(action) => void run(action)}
        />
      ) : null}
    </DashboardWidgetFrame>
  );
}
