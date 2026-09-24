/**
 * Materialliste of one Verteiler: what the plan needs against what has been
 * booked for it — scanned at the Regal station, or booked by hand here.
 *
 * Self-loading on purpose: the Schaltplan "Material" tab and the Werkstatt
 * "Verteiler" card both show it, and neither wants to own the fetch. Planned
 * quantities are derived on the server from the panel document on every
 * read; scanned ones come from the Werkstatt ledger. The list edits neither —
 * it books against a stock article, and it tells every panel which stock
 * article a planned line means (a global mapping, not a per-panel one).
 *
 * Order is the server's: device lines in catalog order, then terminal parts,
 * then extras. A finished line is marked, never moved — a fitter reading the
 * list against the rail expects the rows where they were a minute ago.
 */
import { useCallback, useEffect, useState } from "react";

import { PanelMaterialRow } from "./PanelMaterialRow";
import { materialTexts, type MaterialTexts } from "./panelMaterialTexts";
import {
  bookPanelMaterial,
  getPanelMaterial,
  setPanelMaterialMapping,
  unbookPanelMaterial,
} from "../../utils/schaltplanApi";
import { formatRelativeTime } from "../../utils/werkstattOverviewFormat";
import type { PanelMaterial, PanelMaterialLine, PanelMaterialPanel } from "../../types/schaltplan";
import "../../styles/schaltplan-material.css";

export type PanelMaterialListProps = {
  token: string | null;
  panelId: number;
  /** May assign articles to lines and book/unbook quantities (reports:create). */
  canEdit: boolean;
  language: "de" | "en";
  /** Called after any successful booking or mapping change. */
  onChanged?: () => void;
  /** Optional: render without the panel header (the Schaltplan tab already shows the panel). */
  hideHeader?: boolean;
};

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; material: PanelMaterial };

const LOADING: LoadState = { status: "loading" };
const BOOK_QUANTITY = 1;

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

function panelTitle(panel: PanelMaterialPanel): string {
  return `${panel.panel_number} · ${panel.designation} ${panel.name}`.trim();
}

function panelSubtitle(panel: PanelMaterialPanel): string {
  const project = [panel.project_number, panel.project_name].filter(Boolean).join(" ");
  return [panel.customer_name, project].filter(Boolean).join(" · ");
}

function MaterialFooter({ material, t, de }: { material: PanelMaterial; t: MaterialTexts; de: boolean }) {
  return (
    <footer className="sp-mat-foot">
      <span className="sp-mat-foot-total">
        <b>{`${material.scanned_total} / ${material.planned_total}`}</b> {t.scannedOfPlanned}
      </span>
      <span className="sp-mat-foot-open">{t.openLines(material.open_lines)}</span>
      {material.last_scanned_at && (
        <span className="sp-mat-foot-last">
          {`${t.lastScanned} ${formatRelativeTime(material.last_scanned_at, new Date(), de)}`}
        </span>
      )}
    </footer>
  );
}

export function PanelMaterialList({
  token,
  panelId,
  canEdit,
  language,
  onChanged,
  hideHeader = false,
}: PanelMaterialListProps): JSX.Element {
  const de = language === "de";
  const t = materialTexts(language);
  const [load, setLoad] = useState<LoadState>(LOADING);
  // The line whose request is running; every booking button waits for it so
  // two answers cannot race each other into the list.
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [mappingKey, setMappingKey] = useState<string | null>(null);
  // Bumped by "Erneut versuchen"; the load effect keys on it.
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoad(LOADING);
    setMappingKey(null);
    setNotice(null);
    getPanelMaterial(token, panelId)
      .then((material) => {
        if (!cancelled) setLoad({ status: "ready", material });
      })
      .catch((err: unknown) => {
        if (!cancelled) setLoad({ status: "error", message: errorMessage(err, t.loadFailed) });
      });
    return () => {
      cancelled = true;
    };
  }, [token, panelId, attempt, t.loadFailed]);

  const retry = useCallback(() => setAttempt((current) => current + 1), []);

  /** Re-read the list without dropping back to the loading state. */
  const refresh = useCallback(async () => {
    try {
      const material = await getPanelMaterial(token, panelId);
      setLoad({ status: "ready", material });
    } catch (err) {
      setNotice(errorMessage(err, t.loadFailed));
    }
  }, [token, panelId, t.loadFailed]);

  const book = useCallback(
    async (line: PanelMaterialLine, direction: 1 | -1) => {
      if (!line.article || busyKey !== null) return;
      setBusyKey(line.key);
      setNotice(null);
      const body = { article_id: line.article.id, quantity: BOOK_QUANTITY };
      try {
        const material =
          direction > 0
            ? await bookPanelMaterial(token, panelId, body)
            : await unbookPanelMaterial(token, panelId, body);
        setLoad({ status: "ready", material });
        onChanged?.();
      } catch (err) {
        setNotice(errorMessage(err, t.bookFailed));
      } finally {
        setBusyKey(null);
      }
    },
    [token, panelId, busyKey, onChanged, t.bookFailed],
  );

  const assign = useCallback(
    async (line: PanelMaterialLine, articleId: number | null) => {
      if (busyKey !== null) return;
      setBusyKey(line.key);
      setNotice(null);
      try {
        await setPanelMaterialMapping(token, { key: line.key, article_id: articleId });
      } catch (err) {
        setNotice(errorMessage(err, t.mappingFailed));
        setBusyKey(null);
        return;
      }
      setMappingKey(null);
      await refresh();
      setBusyKey(null);
      onChanged?.();
    },
    [token, busyKey, refresh, onChanged, t.mappingFailed],
  );

  if (load.status === "loading") {
    return (
      <div className="sp-mat">
        <p className="sp-mat-empty" role="status">
          {t.loading}
        </p>
      </div>
    );
  }

  if (load.status === "error") {
    return (
      <div className="sp-mat">
        <p className="sp-mat-error" role="alert">
          {load.message}
        </p>
        <div>
          <button type="button" className="sp-btn" onClick={retry}>
            {t.retry}
          </button>
        </div>
      </div>
    );
  }

  const { material } = load;

  return (
    <div className="sp-mat">
      {!hideHeader && (
        <header className="sp-mat-head">
          <div>
            <h4>{panelTitle(material.panel)}</h4>
            {panelSubtitle(material.panel) && <small>{panelSubtitle(material.panel)}</small>}
          </div>
        </header>
      )}

      {notice && (
        <p className="sp-mat-notice" role="alert">
          {notice}
        </p>
      )}

      {material.lines.length === 0 ? (
        <p className="sp-mat-empty">{t.empty}</p>
      ) : (
        <ul className="sp-mat-rows" aria-label={t.listLabel}>
          {material.lines.map((line) => (
            <PanelMaterialRow
              key={line.key}
              line={line}
              token={token}
              canEdit={canEdit}
              t={t}
              busy={busyKey !== null}
              mappingOpen={mappingKey === line.key}
              onOpenMapping={() => setMappingKey(line.key)}
              onCloseMapping={() => setMappingKey(null)}
              onAssign={(articleId) => void assign(line, articleId)}
              onBook={(direction) => void book(line, direction)}
            />
          ))}
        </ul>
      )}

      <MaterialFooter material={material} t={t} de={de} />
    </div>
  );
}
