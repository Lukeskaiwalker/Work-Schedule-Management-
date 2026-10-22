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
 * Order is the server's: the cabinet and its modules (boards with a cabinet),
 * device lines in catalog order, then terminal parts, then the lines added by
 * hand, then extras. A finished line is marked, never moved — a fitter
 * reading the list against the rail expects the rows where they were a
 * minute ago.
 *
 * Added by hand (owner, 2026-10-09): what the plan cannot derive — duct,
 * cable ties, a spare breaker — goes on the list here, a shelf article or a
 * free text, and the whole list opens as a PDF for anyone who can see it.
 *
 * Returns (docs/PANEL_ENCLOSURE.md §6): a part taken out of a pre-fitted
 * module goes back on the shelf. It is not a pick, so the `removed` lines
 * stand in their own block after the list, as on the PDF, and their open
 * count sits apart from the picking totals ("{n} × ins Lager offen"). Only
 * the Werkstatt books them; everybody else sees why the buttons are off.
 *
 * The PDF is drawn from the SAVED board: on the Schaltplan page the link
 * waits for the editor's autosave (`settleSaves`), elsewhere there is no
 * editor and it opens at once — always through `savedPdfClick`, so the
 * in-app viewer on the app surfaces gets it the same way.
 */
import { useCallback, useEffect, useId, useState, type ReactNode } from "react";

import { PanelLabourBlock } from "./PanelLabourBlock";
import { PanelMaterialAddForm } from "./PanelMaterialAddForm";
import { PanelMaterialRow, isReturnLine } from "./PanelMaterialRow";
import { materialTexts, type MaterialTexts } from "./panelMaterialTexts";
import { OWN_OPENER_PROPS, savedPdfClick } from "../../utils/openAfterSave";
import { salvagePanelMaterial, unsalvagePanelMaterial } from "../../utils/schaltplanEnclosureApi";
import {
  addPanelMaterialManual,
  bookPanelMaterial,
  deletePanelMaterialManual,
  endPanelWorkSession,
  getPanelMaterial,
  panelMaterialPdfUrl,
  setPanelMaterialMapping,
  unbookPanelMaterial,
  updatePanelMaterialManual,
} from "../../utils/schaltplanApi";
import { formatRelativeTime } from "../../utils/werkstattOverviewFormat";
import type {
  PanelMaterial,
  PanelMaterialLine,
  PanelMaterialManualInput,
  PanelMaterialManualUpdate,
  PanelMaterialPanel,
} from "../../types/schaltplan";
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
  /** Who is looking: they may end their OWN running session in the Arbeitszeit block. */
  currentUserId?: number | null;
  /** werkstatt:manage — may end anybody's running session, and books returns "Ins Lager". */
  canManageWerkstatt?: boolean;
  /**
   * The editor's `settleSaves` (true once the server holds the latest
   * edits): the PDF link waits for it. Without an editor (the Werkstatt
   * page) there is nothing to wait for.
   */
  settleSaves?: () => Promise<boolean>;
};

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; material: PanelMaterial };

const LOADING: LoadState = { status: "loading" };
const BOOK_QUANTITY = 1;
const ADD_KEY = "manual:add";
const NOTHING_TO_SAVE = (): Promise<boolean> => Promise.resolve(true);

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

function MaterialToolbar({
  panelId,
  canEdit,
  addOpen,
  t,
  settleSaves,
  onToggleAdd,
  onPdfRefused,
}: {
  panelId: number;
  canEdit: boolean;
  addOpen: boolean;
  t: MaterialTexts;
  settleSaves: () => Promise<boolean>;
  onToggleAdd: () => void;
  onPdfRefused: (message: string) => void;
}) {
  const href = panelMaterialPdfUrl(panelId);
  return (
    <div className="sp-mat-toolbar">
      {canEdit && (
        <button type="button" className="sp-btn" aria-expanded={addOpen} onClick={onToggleAdd}>
          <span aria-hidden="true">+ </span>
          {t.addMaterial}
        </button>
      )}
      {/* OWN_OPENER_PROPS: on the app surfaces the in-app viewer must not open it before the saves settled. */}
      <a
        className="sp-btn sp-btn--ghost sp-mat-pdf"
        href={href}
        target="_blank"
        rel="noreferrer"
        title={t.pdfTitle}
        {...OWN_OPENER_PROPS}
        onClick={savedPdfClick(href, settleSaves, onPdfRefused, t.pdfName)}
      >
        {t.pdf}
      </a>
    </div>
  );
}

function MaterialFooter({ material, t, de }: { material: PanelMaterial; t: MaterialTexts; de: boolean }) {
  return (
    <footer className="sp-mat-foot">
      <span className="sp-mat-foot-total">
        <b>{`${material.scanned_total} / ${material.planned_total}`}</b> {t.scannedOfPlanned}
      </span>
      <span className="sp-mat-foot-open">{t.openLines(material.open_lines)}</span>
      {(material.returns_open ?? 0) > 0 && (
        <span className="sp-mat-foot-returns">{t.returnsOpen(material.returns_open ?? 0)}</span>
      )}
      {material.last_scanned_at && (
        <span className="sp-mat-foot-last">
          {`${t.lastScanned} ${formatRelativeTime(material.last_scanned_at, new Date(), de)}`}
        </span>
      )}
    </footer>
  );
}

/** The returns block: its own heading, what it is, and who books it. */
function ReturnsBlock({ t, canManage, children }: { t: MaterialTexts; canManage: boolean; children: ReactNode }) {
  const headingId = useId();
  return (
    <section className="sp-mat-returns" aria-labelledby={headingId}>
      <h5 id={headingId} className="sp-mat-returns-title">
        {t.returnsTitle}
      </h5>
      <p className="sp-mat-returns-hint">{t.returnsHint}</p>
      {!canManage && <p className="sp-mat-returns-perm">{t.returnsNeedManage}</p>}
      <ul className="sp-mat-rows" aria-label={t.returnsTitle}>
        {children}
      </ul>
    </section>
  );
}

export function PanelMaterialList({
  token,
  panelId,
  canEdit,
  language,
  onChanged,
  hideHeader = false,
  currentUserId = null,
  canManageWerkstatt = false,
  settleSaves = NOTHING_TO_SAVE,
}: PanelMaterialListProps): JSX.Element {
  const de = language === "de";
  const t = materialTexts(language);
  const [load, setLoad] = useState<LoadState>(LOADING);
  // The line whose request is running; every booking button waits for it so
  // two answers cannot race each other into the list.
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [mappingKey, setMappingKey] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  // Bumped by "Erneut versuchen"; the load effect keys on it.
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoad(LOADING);
    setMappingKey(null);
    setAddOpen(false);
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

  /**
   * Every write that answers with the whole list shares one shape: wait for
   * any other request, show the server's answer as the new list, say a
   * refusal in the notice. True once it went through, so a form knows
   * whether to clear.
   */
  const write = useCallback(
    async (key: string, request: () => Promise<PanelMaterial>, fallback: string): Promise<boolean> => {
      if (busyKey !== null) return false;
      setBusyKey(key);
      setNotice(null);
      try {
        const material = await request();
        setLoad({ status: "ready", material });
        onChanged?.();
        return true;
      } catch (err) {
        setNotice(errorMessage(err, fallback));
        return false;
      } finally {
        setBusyKey(null);
      }
    },
    [busyKey, onChanged],
  );

  const book = useCallback(
    (line: PanelMaterialLine, direction: 1 | -1) => {
      if (!line.article) return;
      const body = { article_id: line.article.id, quantity: BOOK_QUANTITY };
      const request = () =>
        direction > 0 ? bookPanelMaterial(token, panelId, body) : unbookPanelMaterial(token, panelId, body);
      void write(line.key, request, t.bookFailed);
    },
    [write, token, panelId, t.bookFailed],
  );

  /** A removed part back on the shelf (+1), or that return taken back (−1). The Werkstatt's alone. */
  const bookReturn = useCallback(
    (line: PanelMaterialLine, direction: 1 | -1) => {
      if (!line.article || !canManageWerkstatt) return;
      const articleId = line.article.id;
      const request = () =>
        direction > 0
          ? salvagePanelMaterial(token, panelId, articleId, BOOK_QUANTITY)
          : unsalvagePanelMaterial(token, panelId, articleId, BOOK_QUANTITY);
      void write(line.key, request, t.returnFailed);
    },
    [write, token, panelId, canManageWerkstatt, t.returnFailed],
  );

  const addManual = useCallback(
    (body: PanelMaterialManualInput) =>
      write(ADD_KEY, () => addPanelMaterialManual(token, panelId, body), t.addFailed),
    [write, token, panelId, t.addFailed],
  );

  const updateManual = useCallback(
    (line: PanelMaterialLine, body: PanelMaterialManualUpdate) =>
      line.manual_id == null
        ? Promise.resolve(false)
        : write(line.key, () => updatePanelMaterialManual(token, panelId, line.manual_id as number, body), t.manualFailed),
    [write, token, panelId, t.manualFailed],
  );

  const removeManual = useCallback(
    (line: PanelMaterialLine) => {
      if (line.manual_id == null) return;
      const lineId = line.manual_id;
      void write(line.key, () => deletePanelMaterialManual(token, panelId, lineId), t.manualFailed);
    },
    [write, token, panelId, t.manualFailed],
  );

  const endSession = useCallback(
    (sessionId: number, endedAt: string | null) =>
      void write(`labour:${sessionId}`, () => endPanelWorkSession(token, panelId, sessionId, endedAt), t.labourEndFailed),
    [write, token, panelId, t.labourEndFailed],
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
  const picks = material.lines.filter((line) => !isReturnLine(line));
  const returns = material.lines.filter(isReturnLine);
  const renderRow = (line: PanelMaterialLine) => (
    <PanelMaterialRow
      key={line.key}
      line={line}
      token={token}
      canEdit={canEdit}
      canManageReturns={canManageWerkstatt}
      t={t}
      busy={busyKey !== null}
      mappingOpen={mappingKey === line.key}
      onOpenMapping={() => setMappingKey(line.key)}
      onCloseMapping={() => setMappingKey(null)}
      onAssign={(articleId) => void assign(line, articleId)}
      onBook={(direction) => book(line, direction)}
      onReturn={(direction) => bookReturn(line, direction)}
      onUpdateManual={(body) => updateManual(line, body)}
      onRemoveManual={() => removeManual(line)}
    />
  );

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

      <MaterialToolbar
        panelId={panelId}
        canEdit={canEdit}
        addOpen={addOpen}
        t={t}
        settleSaves={settleSaves}
        onToggleAdd={() => setAddOpen((open) => !open)}
        onPdfRefused={setNotice}
      />

      {canEdit && addOpen && (
        <PanelMaterialAddForm
          token={token}
          t={t}
          busy={busyKey !== null}
          onAdd={addManual}
          onClose={() => setAddOpen(false)}
        />
      )}

      {notice && (
        <p className="sp-mat-notice" role="alert">
          {notice}
        </p>
      )}

      {picks.length === 0 ? (
        <p className="sp-mat-empty">{t.empty}</p>
      ) : (
        <ul className="sp-mat-rows" aria-label={t.listLabel}>
          {picks.map(renderRow)}
        </ul>
      )}

      {returns.length > 0 && (
        <ReturnsBlock t={t} canManage={canManageWerkstatt}>
          {returns.map(renderRow)}
        </ReturnsBlock>
      )}

      <MaterialFooter material={material} t={t} de={de} />

      <PanelLabourBlock
        material={material}
        t={t}
        language={language}
        currentUserId={currentUserId}
        canManageWerkstatt={canManageWerkstatt}
        busy={busyKey !== null}
        onEnd={endSession}
      />
    </div>
  );
}
