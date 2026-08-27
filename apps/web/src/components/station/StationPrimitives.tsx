/**
 * StationPrimitives — the three atoms the station panels share.
 *
 * They are deliberately dumb: a pill, a definition-list cell, and a one-line
 * result message. Everything that decides *what* they say lives in the panel
 * that renders them.
 */
import type { StationStatus } from "../../utils/stationApi";

/** The outcome of a one-shot action, rendered by `FeedbackLine`. */
export type Feedback = { ok: boolean; text: string };

export function StatusPill({ status, label }: { status: StationStatus; label: string }) {
  return (
    <span className={`pi-station-pill pi-station-pill--${status}`}>
      <span className="pi-station-pill-dot" />
      {label}
    </span>
  );
}

export function MetaItem({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="pi-station-meta-item">
      <dt>{label}</dt>
      <dd className={mono ? "pi-station-mono" : undefined}>{value}</dd>
    </div>
  );
}

export function FeedbackLine({ feedback }: { feedback: Feedback | null }) {
  if (!feedback) return null;
  return (
    <p className={`pi-station-feedback${feedback.ok ? "" : " pi-station-feedback--bad"}`}>
      {feedback.text}
    </p>
  );
}
