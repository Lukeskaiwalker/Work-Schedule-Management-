/**
 * One person's station badge: the DataMatrix, whose it is, and the two things
 * you do with it — print it, or retire it by minting a new one.
 *
 * Used for your own badge (profile page) and, behind users:manage, for a
 * colleague's (the person who hands out badges is not the person on them).
 *
 * Printing goes through a portal: a root directly under <body> holds the badge
 * sheet, and while printing every OTHER child of <body> is display:none. That
 * prints exactly one page with exactly the badge on it — a visibility trick on
 * the live page would still lay out the whole hidden profile and print blank
 * pages after it. A new browser window would not: it would inherit the app's
 * CSP and lose its styles.
 */
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

import { DataMatrixCode } from "../shared/DataMatrixCode";
import type { StationBadge } from "../../utils/stationBadgeApi";
import { formatServerDateTime } from "../../utils/dates";
// The buttons share the Kalender-Abo card's styles; imported here so the card
// is styled wherever it is mounted, not only beside that card.
import "../../styles/calendar-feed.css";
import "../../styles/station-badge.css";

export const PRINT_ROOT_CLASS = "station-badge-print-root";
export const PRINTING_CLASS = "printing-station-badge";

const ROTATE_CONFIRM =
  "Neuen Ausweis-Code erzeugen?\n\nDer bisherige Ausweis funktioniert danach an keiner Station mehr. Er muss neu gedruckt werden.";

/** This card's own print root: one per card, so two cards never print each other. */
function usePrintRoot(): HTMLElement | null {
  const [root, setRoot] = useState<HTMLElement | null>(null);
  useEffect(() => {
    const node = document.createElement("div");
    node.className = PRINT_ROOT_CLASS;
    document.body.appendChild(node);
    setRoot(node);
    return () => {
      node.remove();
      if (!document.querySelector(`.${PRINT_ROOT_CLASS}.is-printing`)) {
        document.body.classList.remove(PRINTING_CLASS);
      }
    };
  }, []);
  return root;
}

/** Print exactly this root's badge, then put the page back. */
export function printStationBadge(root: HTMLElement | null): void {
  if (!root) return;
  const body = document.body;
  const done = () => {
    root.classList.remove("is-printing");
    body.classList.remove(PRINTING_CLASS);
    window.removeEventListener("afterprint", done);
  };
  root.classList.add("is-printing");
  body.classList.add(PRINTING_CLASS);
  window.addEventListener("afterprint", done);
  window.print();
}

type StationBadgeCardProps = {
  badge: StationBadge;
  busy: boolean;
  error: string | null;
  onRotate: () => void;
  language: "de" | "en";
};

export function StationBadgeCard({ badge, busy, error, onRotate, language }: StationBadgeCardProps): JSX.Element {
  const printRoot = usePrintRoot();

  function handleRotate() {
    if (!window.confirm(ROTATE_CONFIRM)) return;
    onRotate();
  }

  return (
    <div className="station-badge">
      <div className="station-badge-face">
        <DataMatrixCode
          value={badge.code}
          size={152}
          label={`Stations-Ausweis von ${badge.user_name}`}
          className="station-badge-matrix"
        />
        <div className="station-badge-who">
          <strong className="station-badge-name">{badge.user_name}</strong>
          <span className="station-badge-kind">Stations-Ausweis · SMPL Werkstatt</span>
          <code className="station-badge-code">{badge.code}</code>
          <span className="station-badge-use">
            {badge.last_used_at
              ? `Zuletzt gescannt ${formatServerDateTime(badge.last_used_at, language)} · ${badge.use_count}× insgesamt`
              : "Noch nie an einer Station gescannt."}
          </span>
        </div>
      </div>

      {error && (
        <p className="station-badge-error" role="alert">
          {error}
        </p>
      )}

      <div className="profile-page-form-actions">
        <button type="button" className="profile-page-save-btn" onClick={() => printStationBadge(printRoot)}>
          Ausweis drucken
        </button>
        <button type="button" className="calendar-feed-secondary-btn" disabled={busy} onClick={handleRotate}>
          {busy ? "Wird erzeugt…" : "Neuen Code erzeugen"}
        </button>
      </div>

      {printRoot &&
        createPortal(
          <div className="station-badge-sheet" aria-hidden="true">
            <DataMatrixCode value={badge.code} size={110} label="" className="station-badge-sheet-matrix" />
            <div className="station-badge-sheet-who">
              <strong>{badge.user_name}</strong>
              {/* No break inside "SMPL Werkstatt": on the narrow card the line
                  wraps, and it should wrap after the dot. */}
              <span>Stations-Ausweis · SMPL{" "}Werkstatt</span>
              <code>{badge.code}</code>
            </div>
          </div>,
          printRoot,
        )}
    </div>
  );
}
