import type { Language } from "../../types";
import { ReportsEmptyDocumentIcon, ReportsNoResultsIcon } from "./ReportsIcons";

/**
 * The three body-replacement states. "Nothing exists" and "your filter is too
 * narrow" are different problems and deliberately never share a message.
 *
 * No skeleton: `skeleton` and `shimmer` both appear zero times in this
 * product's 30k-line stylesheet. Berichte is not the page entitled to set a new
 * loading precedent for the whole application; if a skeleton is wanted it
 * belongs to all the list pages as a shared component.
 */

export function ReportsLoadingState({ language }: { language: Language }) {
  return (
    <div className="reports-state reports-state--loading">
      <p className="reports-state-body">
        {language === "de" ? "Berichte werden geladen…" : "Loading reports…"}
      </p>
    </div>
  );
}

/** No reports in the window at all. No CTA: reports are filed from the site. */
export function ReportsEmptyWindowState({ language }: { language: Language }) {
  const de = language === "de";
  return (
    <div className="reports-state reports-state--empty">
      <ReportsEmptyDocumentIcon />
      <p className="reports-state-title">
        {de
          ? "Keine Berichte in den letzten 4 Wochen"
          : "No reports in the last 4 weeks"}
      </p>
      <p className="reports-state-body">
        {de
          ? "Berichte werden von der Baustelle aus erstellt und erscheinen hier automatisch."
          : "Reports are filed from the site and appear here automatically."}
      </p>
    </div>
  );
}

type NoResultsProps = {
  language: Language;
  query: string;
  totalCount: number;
  windowRange: string;
  onReset: () => void;
};

/**
 * Rows exist but the filters exclude all of them. The scope is stated
 * explicitly: a client-side search over a four-week window that says only "no
 * results" makes a scoped search look global, and the record the user wants
 * almost certainly exists outside the window.
 */
export function ReportsNoResultsState({
  language,
  query,
  totalCount,
  windowRange,
  onReset,
}: NoResultsProps) {
  const de = language === "de";
  const trimmed = query.trim();
  const heading = trimmed
    ? de
      ? `Keine Treffer für „${trimmed}“`
      : `No matches for “${trimmed}”`
    : de
      ? "Keine Treffer"
      : "No matches";

  return (
    <div className="reports-state reports-state--empty">
      <ReportsNoResultsIcon />
      <p className="reports-state-title">{heading}</p>
      <p className="reports-state-body">
        {de
          ? `Durchsucht wurden die ${totalCount} Berichte vom ${windowRange}.`
          : `Searched the ${totalCount} reports from ${windowRange}.`}
      </p>
      <button type="button" className="reports-state-reset" onClick={onReset}>
        {de ? "Filter zurücksetzen" : "Reset filters"}
      </button>
    </div>
  );
}
