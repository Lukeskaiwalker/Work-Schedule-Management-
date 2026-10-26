/**
 * Verteilerpläne — draw a panel schematic and let the legend fall out of it.
 *
 * Construction-view only (see `navViews` in App.tsx): this is a field tool
 * for the person standing in front of an open board, not an office report.
 *
 * The page is a thin orchestrator. The domain lives in
 * `utils/schaltplanTopology.ts` (what the document means), the drawing in
 * `components/schaltplan/*`, and the edit buffer with its autosave in
 * `hooks/usePanelDocumentEditor.ts`; here we hold the scope, the open panel,
 * the selection and which sheet is up.
 *
 * The Schrank tab (docs/PANEL_ENCLOSURE.md §11) is its own component; the
 * page only decides when it opens (a board with a cabinet opens on it) and
 * loads the cabinet catalogue once something needs it. The board's WAGO
 * terminals are derived here once (`useBoardTerminals`, PANEL_ENCLOSURE_R2.md
 * §6.7) and handed to the Schrank tab, the Klemmen tab, the label sheet, the
 * legend and the findings, so they all number with the cabinet's skip set;
 * the Klemmen tab and the label sheet wait for the catalogue to do so.
 *
 * Fresh reads
 * -----------
 * The Materialliste, the Klemmen and plan PDFs, the label printer and a
 * copy are all made on the server from the SAVED board, while autosave waits
 * for a pause in typing. So each of them settles the saves first — a fitter
 * who adds a breaker and taps "Material" must see that breaker counted.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useAppContext } from "../context/AppContext";
import { usePendingPanelHandoff } from "../hooks/usePendingPanelHandoff";
import { DeviceInspector } from "../components/schaltplan/DeviceInspector";
import { DevicePalette } from "../components/schaltplan/DevicePalette";
import { LabelPrintDialog } from "../components/schaltplan/LabelPrintDialog";
import { PanelTypeLabelDialog } from "../components/schaltplan/PanelTypeLabelDialog";
import { LegendTable } from "../components/schaltplan/LegendTable";
import { NewPanelDialog, type NewPanelPayload } from "../components/schaltplan/NewPanelDialog";
import { PanelDataTab } from "../components/schaltplan/PanelDataTab";
import { PanelDiagram } from "../components/schaltplan/PanelDiagram";
import { PanelEditorHeader } from "../components/schaltplan/PanelEditorHeader";
import { PanelMaterialList } from "../components/schaltplan/PanelMaterialList";
import { PanelScopePicker } from "../components/schaltplan/PanelScopePicker";
import { RailEditor } from "../components/schaltplan/RailEditor";
import { RowTemplateSheet } from "../components/schaltplan/RowTemplateSheet";
import { TerminalList } from "../components/schaltplan/TerminalList";
import { useLabelPrinting } from "../components/schaltplan/useLabelPrinting";
import { usePanelControlBlock } from "../components/schaltplan/usePanelControlBlock";
import { useSchaltplanPalette } from "../components/schaltplan/useSchaltplanPalette";
import { useTypeLabelPrinting } from "../components/schaltplan/useTypeLabelPrinting";
import { EnclosureTab } from "../components/schaltplan/enclosure/EnclosureTab";
import type { TabSheet } from "../components/schaltplan/enclosure/EnclosureSheetHost";
import { useAufbauTerminalActions } from "../components/schaltplan/enclosure/useAufbauTerminalActions";
import {
  cabinetChoices,
  enclosureChipText,
  setAllTerminalsOnBoard,
  suppliedInfo,
  terminalBlockedZone,
  warnCount,
} from "../components/schaltplan/enclosure/enclosureEditorModel";
import { useBoardTerminals } from "../hooks/useBoardTerminals";
import { useEnclosureCatalog } from "../hooks/useEnclosureCatalog";
import { usePanelDocumentEditor } from "../hooks/usePanelDocumentEditor";
import { enclosureFindings } from "../utils/enclosureRules";
import { savedPdfClick } from "../utils/openAfterSave";
import { emptyDocument } from "../utils/schaltplanDevices";
import type { RowTemplateId } from "../utils/schaltplanDocumentOps";
import { NO_SKIP } from "../utils/schaltplanTerminalRules";
import { terminalCounts } from "../utils/schaltplanTerminals";
import { buildLegend, findDevice, neighbourDeviceId, validateDocument } from "../utils/schaltplanTopology";
import {
  createPanel,
  deletePanel as deletePanelRequest,
  duplicatePanel,
  getPanel,
  listPanels,
  listRecentPanels,
  panelPdfUrl,
  updatePanel,
} from "../utils/schaltplanApi";
import type { PanelDocument, PanelPlan, PanelPlanSummary } from "../types/schaltplan";
// Own sheet, not styles.css — see the header of that file.
import "../styles/schaltplan-terminals.css";

type EditorTab = "plan" | "schrank" | "aufbau" | "klemmen" | "material" | "legende" | "daten";

/** How many "Zuletzt bearbeitet" panels the search box offers. */
const RECENT_PANELS_LIMIT = 8;

const TAB_LABELS: Record<EditorTab, string> = {
  plan: "Plan",
  schrank: "Schrank",
  aufbau: "Aufbau",
  klemmen: "Klemmen",
  material: "Material",
  legende: "Legende",
  daten: "Daten",
};

/** Tabs whose content, PDF or print the server makes from the saved board. */
const SERVER_TABS: ReadonlySet<EditorTab> = new Set<EditorTab>(["klemmen", "material"]);

const MATERIAL_HINT =
  "Geplant aus dem Verteilerplan oder von Hand ergänzt · gescannt an der Regal-Station oder hier gebucht";

const COPY_NOT_SAVED =
  "Nicht kopiert: Die Änderungen konnten nicht gespeichert werden — die Kopie hätte den alten Stand.";

/** A board with a cabinet opens on Schrank (§11); others on Plan. */
const openingTab = (document: PanelDocument): EditorTab => (document.enclosure ? "schrank" : "plan");

/**
 * Refresh only the counters the picker card shows. Spreading the whole
 * detail response would push `document`, `legend` and `findings` into the
 * summary list — payload the picker never reads, held per panel.
 */
function withSavedCounters(row: PanelPlanSummary, saved: PanelPlan): PanelPlanSummary {
  return {
    ...row,
    revision: saved.revision,
    status: saved.status,
    device_count: saved.device_count,
    circuit_count: saved.circuit_count,
    rcd_count: saved.rcd_count,
    used_slots: saved.used_slots,
    total_slots: saved.total_slots,
    row_count: saved.row_count,
    updated_at: saved.updated_at,
    updated_by_name: saved.updated_by_name,
  };
}

export function SchaltplanPage() {
  const {
    token,
    language,
    user,
    customers,
    searchCustomers,
    projects,
    openCustomerModal,
    setNotice,
    setError,
  } = useAppContext();

  const canEdit = Boolean(user?.effective_permissions?.includes("reports:create"));
  const readOnly = !canEdit;

  const [customerId, setCustomerId] = useState<number | null>(null);
  const [projectId, setProjectId] = useState<number | null>(null);
  const [panels, setPanels] = useState<PanelPlanSummary[]>([]);
  const [panelsLoading, setPanelsLoading] = useState(false);
  // The panels touched most recently, across every customer — what the
  // search box offers before anything is typed.
  const [recentPanels, setRecentPanels] = useState<PanelPlanSummary[]>([]);

  const [panel, setPanel] = useState<PanelPlan | null>(null);
  const [tab, setTab] = useState<EditorTab>("plan");
  // A Material/Klemmen tap waiting for the save; only the latest tap counts.
  const [tabWait, setTabWait] = useState(false);
  const tabRequest = useRef(0);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string | null>(null);
  const typeLabel = useTypeLabelPrinting({ panel, token, setNotice, setError });
  const [templateSheetOpen, setTemplateSheetOpen] = useState(false);
  const [newPanelOpen, setNewPanelOpen] = useState(false);
  // A sheet the Schrank tab opens on arrival ("Auf andere Hutschiene…" from this page's inspector).
  const [schrankSheet, setSchrankSheet] = useState<TabSheet | null>(null);
  const [creating, setCreating] = useState(false);

  // ── Loading ──────────────────────────────────────────────────────────────

  const reloadPanels = useCallback(
    async (isStale?: () => boolean) => {
      if (customerId == null) {
        setPanels([]);
        return;
      }
      setPanelsLoading(true);
      try {
        const rows = await listPanels(token, { customerId, projectId });
        if (isStale?.()) return;
        setPanels(rows);
      } catch {
        if (isStale?.()) return;
        // An empty list after a failed fetch reads as "nothing documented
        // here", which would send someone off to re-survey a board that is
        // already on file. Say so instead.
        setPanels([]);
        setError("Verteilerpläne konnten nicht geladen werden.");
      } finally {
        if (!isStale?.()) setPanelsLoading(false);
      }
    },
    [customerId, projectId, token, setError],
  );

  useEffect(() => {
    let stale = false;
    void reloadPanels(() => stale);
    return () => {
      stale = true;
    };
  }, [reloadPanels]);

  /**
   * Refresh "Zuletzt bearbeitet". Quiet on failure: the list is a shortcut,
   * and the last good one is better than an error over the search box.
   */
  const reloadRecent = useCallback(async () => {
    try {
      setRecentPanels(await listRecentPanels(token, RECENT_PANELS_LIMIT));
    } catch {
      // Keep whatever was shown before.
    }
  }, [token]);

  useEffect(() => {
    void reloadRecent();
  }, [reloadRecent]);

  // ── Editor ───────────────────────────────────────────────────────────────

  /**
   * A save landed. Only for the panel still open: an answer for a panel left
   * meanwhile must not swap the header back to it.
   */
  const handleSaved = useCallback(
    (saved: PanelPlan) => {
      setPanel((current) => (current && current.id === saved.id ? saved : current));
      setPanels((current) => current.map((row) => (row.id === saved.id ? withSavedCounters(row, saved) : row)));
      // A save moves this panel to the top of "Zuletzt bearbeitet".
      void reloadRecent();
    },
    [reloadRecent],
  );

  const editor = usePanelDocumentEditor({ token, readOnly, onSaved: handleSaved, setError });
  const { document, load: loadDocument, settleSaves } = editor;

  const labels = useLabelPrinting({ panel, token, setNotice, setError, beforePrint: settleSaves });

  // The cabinet catalogue, fetched once something needs it — a board with a
  // cabinet, the Schrank tab, the new-board dialog — and kept from then on.
  const needsCatalog = Boolean(document?.enclosure) || tab === "schrank" || newPanelOpen;
  const [catalogWanted, setCatalogWanted] = useState(false);
  useEffect(() => {
    if (needsCatalog) setCatalogWanted(true);
  }, [needsCatalog]);
  const enclosureCatalog = useEnclosureCatalog(needsCatalog || catalogWanted ? token : null);
  const enclosureIndex = enclosureCatalog.index;
  // A cabinet board whose catalogue did not load: Aufbau and Klemmen say so and offer "Erneut laden".
  const catalogFailed = Boolean(document?.enclosure) && !enclosureIndex && Boolean(enclosureCatalog.error);
  // "+ Gerät" on a row, or on an empty cabinet rail of the Aufbau tab (R2 §9).
  const palette = useSchaltplanPalette({ document, index: enclosureIndex, editor, onAdded: setSelectedDeviceId, setNotice, setError });

  const showTab = useCallback((next: EditorTab) => {
    tabRequest.current += 1;
    setTabWait(false);
    setTab(next);
  }, []);

  const saveIsClean = editor.saveState === "clean";
  const selectTab = useCallback(
    async (next: EditorTab) => {
      if (!SERVER_TABS.has(next) || saveIsClean) {
        showTab(next);
        return;
      }
      tabRequest.current += 1;
      const request = tabRequest.current;
      setTabWait(true);
      await settleSaves();
      // A later tap won. A failed save still switches: its error is on
      // screen already, and keeping the fitter off the tab helps nobody.
      if (request === tabRequest.current) showTab(next);
    },
    [saveIsClean, settleSaves, showTab],
  );

  // The hook hands back a fresh object every render; only its callbacks are
  // stable. Depending on `labels` itself would recreate openPanel on every
  // render and defeat the memo for any effect that lists it.
  const { reset: resetLabels } = labels;
  const openPanel = useCallback(
    async (panelId: number) => {
      try {
        const loaded = await getPanel(token, panelId);
        setPanel(loaded);
        loadDocument({ panelId: loaded.id, document: loaded.document });
        setSelectedDeviceId(null);
        resetLabels();
        showTab(openingTab(loaded.document));
      } catch {
        setError("Der Verteilerplan konnte nicht geöffnet werden.");
      }
    },
    [token, setError, resetLabels, loadDocument, showTab],
  );

  const closePanel = useCallback(() => {
    setPanel(null);
    loadDocument(null);
  }, [loadDocument]);

  /**
   * A "Zuletzt bearbeitet" pick: scope the picker to the panel's customer and
   * project, then open it straight away. `getPanel` does not depend on the
   * customer's list, so the editor is up before that list has even loaded.
   */
  const pickRecent = useCallback(
    (recent: PanelPlanSummary) => {
      setCustomerId(recent.customer_id);
      setProjectId(recent.project_id);
      void openPanel(recent.id);
    },
    [openPanel],
  );
  // A „Zuletzt bearbeitete Verteiler“ row on the start page opens its panel here.
  usePendingPanelHandoff(pickRecent, panel?.id ?? null);

  // ── Device operations (selection and sheets; the edits live in the hook) ─

  const removeDevice = (deviceId: string) => {
    editor.removeDevice(deviceId);
    setSelectedDeviceId(null);
  };

  /**
   * Copy the device into the next slot. The numbering rules live in
   * `schaltplanDocumentOps`; here only the selection moves onto the copy, so
   * the next tap is already on the thing that needs a new name.
   */
  const duplicateDevice = (deviceId: string) => {
    const copyId = editor.duplicateDevice(deviceId);
    if (copyId) setSelectedDeviceId(copyId);
  };

  const addRowFromTemplate = (templateId: RowTemplateId) => {
    editor.addRowFromTemplate(templateId);
    setTemplateSheetOpen(false);
  };

  // ── Panel-level operations ───────────────────────────────────────────────

  const savePanelMeta = useCallback(
    async (patch: Parameters<typeof updatePanel>[2]) => {
      if (!panel) return;
      try {
        const saved = await updatePanel(token, panel.id, patch);
        setPanel(saved);
        void reloadPanels();
        void reloadRecent();
      } catch (error) {
        setError(
          error instanceof Error && error.message
            ? error.message
            : "Der Verteiler konnte nicht gespeichert werden.",
        );
      }
    },
    [panel, token, reloadPanels, reloadRecent, setError],
  );

  const handleCreate = useCallback(
    async (payload: NewPanelPayload) => {
      if (customerId == null) return;
      setCreating(true);
      try {
        const created = await createPanel(token, {
          customer_id: customerId,
          project_id: projectId,
          name: payload.name,
          designation: payload.designation,
          panel_type: payload.panel_type,
          location: payload.location || null,
          fed_from_panel_id: payload.fed_from_panel_id,
          document: emptyDocument({ enclosureCode: payload.enclosure_code }),
        });
        setNewPanelOpen(false);
        setPanel(created);
        loadDocument({ panelId: created.id, document: created.document });
        // A new board without a cabinet starts where its rows are entered.
        showTab(created.document.enclosure ? "schrank" : "aufbau");
        void reloadPanels();
        void reloadRecent();
      } catch (error) {
        setError(
          error instanceof Error && error.message
            ? error.message
            : "Der Verteiler konnte nicht angelegt werden.",
        );
      } finally {
        setCreating(false);
      }
    },
    [customerId, projectId, token, reloadPanels, reloadRecent, setError, loadDocument, showTab],
  );

  /** The server copies the SAVED document, so what was just typed goes first. */
  const duplicateCurrentPanel = useCallback(async () => {
    if (!panel) return;
    if (!(await settleSaves())) {
      setError(COPY_NOT_SAVED);
      return;
    }
    try {
      const copy = await duplicatePanel(token, panel.id);
      setPanel(copy);
      loadDocument({ panelId: copy.id, document: copy.document });
      setNotice(`Kopie „${copy.designation}“ angelegt.`);
      void reloadPanels();
      void reloadRecent();
    } catch {
      setError("Die Kopie konnte nicht angelegt werden.");
    }
  }, [panel, token, settleSaves, loadDocument, reloadPanels, reloadRecent, setNotice, setError]);

  const deleteCurrentPanel = useCallback(async () => {
    if (!panel) return;
    try {
      await deletePanelRequest(token, panel.id);
      closePanel();
      setNotice("Verteilerplan gelöscht.");
      void reloadPanels();
      void reloadRecent();
    } catch {
      setError("Der Verteilerplan konnte nicht gelöscht werden.");
    }
  }, [panel, token, closePanel, reloadPanels, reloadRecent, setNotice, setError]);

  // ── Derived ──────────────────────────────────────────────────────────────

  // Once per document (R2 §6.7): the skip set leaves AAR/NAR/RfZ/APZ circuits without terminals everywhere alike.
  const boardTerms = useBoardTerminals(document, enclosureIndex);
  const skip = boardTerms.terms?.skip ?? NO_SKIP;
  const legend = useMemo(() => (document ? buildLegend(document, skip) : []), [document, skip]);
  const findings = useMemo(() => (document ? validateDocument(document, skip) : []), [document, skip]);
  const terminalGroups = boardTerms.terms?.groups ?? [];
  const terminalCount = terminalCounts(terminalGroups).terminals;
  // The §14a block's prints and the Daten tab's infeed hint (docs/PANEL_ENCLOSURE_R4.md §8.5, §9).
  const control = usePanelControlBlock({ document, index: enclosureIndex, groups: terminalGroups, wantHint: tab === "daten", openLabels: labels.open });
  const warnings = findings.filter((finding) => finding.level === "warn");
  // The cabinet's own findings are listed on the Schrank tab; the banner sums their warnings in one chip.
  const cabinetFindings = useMemo(() => {
    if (!document?.enclosure || !enclosureIndex) return [];
    const { terms, placement } = boardTerms;
    return enclosureFindings(document, enclosureIndex, terms && placement ? { terms, placement } : undefined);
  }, [document, enclosureIndex, boardTerms]);
  // A reserved rail's row on the Aufbau tab runs its finding's suggestion, with the drop note's Rückgängig.
  const aufbauTerminals = useAufbauTerminalActions({
    document, index: enclosureIndex, boardTerminals: boardTerms, readOnly, mutate: editor.mutate, onError: setError, onNotice: setNotice,
  });
  const cabinetWarnings = warnCount(cabinetFindings);
  const suppliedBanner = document && enclosureIndex ? suppliedInfo(document, enclosureIndex, selectedDeviceId) : null;
  // A row outside the cabinet is not drawn on Schrank, so its devices reach a rail from here.
  const moveToRail =
    document?.enclosure && enclosureIndex && !readOnly && selectedDeviceId
      ? () => {
          setSchrankSheet({ kind: "rail-picker", deviceId: selectedDeviceId });
          setSelectedDeviceId(null);
          showTab("schrank");
        }
      : undefined;
  const selectedDevice = document ? findDevice(document, selectedDeviceId) : null;
  // Previous/next inside the sheet walks the board in physical order — row
  // by row, left to right — which is the order a worker reads a rail. The
  // sheet stays open; only the selection moves.
  const previousDeviceId = document ? neighbourDeviceId(document, selectedDeviceId, -1) : null;
  const nextDeviceId = document ? neighbourDeviceId(document, selectedDeviceId, 1) : null;
  const navigateDevice = (direction: -1 | 1) => {
    const target = direction < 0 ? previousDeviceId : nextDeviceId;
    if (target) setSelectedDeviceId(target);
  };
  const customerName = customers.find((customer) => customer.id === customerId)?.name ?? "";
  const projectLabel = (() => {
    const project = projects.find((entry) => entry.id === projectId);
    return project ? `${project.project_number} · ${project.name}` : null;
  })();

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <div className="sp-page">
      <header className="sp-page-head">
        <div>
          <span className="sp-eyebrow">Baustelle</span>
          <h2 className="sp-title">Verteilerpläne</h2>
          <p className="sp-subtitle">
            Haupt- und Unterverteiler mit allen Geräten erfassen — Schaltplan und Legende entstehen
            automatisch daraus.
          </p>
        </div>
      </header>

      <PanelScopePicker
        language={language === "de" ? "de" : "en"}
        customers={customers}
        projects={projects}
        customerId={customerId}
        projectId={projectId}
        onCustomerChange={(nextId) => {
          setCustomerId(nextId);
          setProjectId(null);
          closePanel();
        }}
        onProjectChange={(nextId) => {
          setProjectId(nextId);
          closePanel();
        }}
        onRequestCreateCustomer={(prefillName) =>
          openCustomerModal({
            prefillName,
            onSaved: (customer) => setCustomerId(customer.id),
          })
        }
        searchCustomers={searchCustomers}
        panels={panels}
        activePanelId={panel?.id ?? null}
        onSelectPanel={(panelId) => void openPanel(panelId)}
        onNewPanel={() => setNewPanelOpen(true)}
        canEdit={canEdit}
        loading={panelsLoading}
        recentPanels={recentPanels}
        onPickRecent={pickRecent}
      />

      {panel && document && (
        <section className="sp-editor">
          <PanelEditorHeader
            panel={panel}
            saveState={editor.saveState}
            canEdit={canEdit}
            labelsPrinting={labels.printing}
            typeLabelPrinting={typeLabel.printing}
            settleSaves={settleSaves}
            onError={setError}
            onOpenBmkLabels={() => labels.open(document.rows.map((row) => row.id))}
            onOpenTypeLabel={typeLabel.open}
            onToggleStatus={() => void savePanelMeta({ status: panel.status === "final" ? "draft" : "final" })}
            onDuplicate={() => void duplicateCurrentPanel()}
          />

          {(warnings.length > 0 || cabinetWarnings > 0) && (
            <div className="sp-warnings" role="status">
              <b>Prüfen:</b>
              {warnings.length > 0 && (
                <ul>
                  {warnings.slice(0, 4).map((finding, index) => (
                    <li key={index}>{finding.message}</li>
                  ))}
                </ul>
              )}
              {cabinetWarnings > 0 && (
                <button type="button" className="sp-warnings-chip" onClick={() => void selectTab("schrank")}>
                  {enclosureChipText(cabinetWarnings)}
                </button>
              )}
            </div>
          )}

          <nav className="sp-tabs" role="tablist" aria-label="Ansicht">
            {(Object.keys(TAB_LABELS) as EditorTab[]).map((key) => (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={tab === key}
                className={tab === key ? "sp-tab sp-tab--active" : "sp-tab"}
                onClick={() => void selectTab(key)}
              >
                {TAB_LABELS[key]}
                {key === "legende" && legend.length > 0 && (
                  <span className="sp-count">{legend.length}</span>
                )}
                {key === "klemmen" && terminalCount > 0 && <span className="sp-count">{terminalCount}</span>}
              </button>
            ))}
          </nav>

          {tabWait && (
            <p className="sp-scope-hint" role="status">
              Speichert…
            </p>
          )}

          {tab === "plan" && (
            <PanelDiagram
              document={document}
              selectedDeviceId={selectedDeviceId}
              onSelect={setSelectedDeviceId}
              fedFrom={panel.fed_from_designation}
              designation={panel.designation}
            />
          )}

          {tab === "schrank" && (
            <EnclosureTab
              key={panel.id}
              token={token}
              panel={panel}
              editor={editor}
              catalog={enclosureCatalog}
              readOnly={readOnly}
              onNotice={setNotice}
              onError={setError}
              openSheet={schrankSheet}
              onSheetOpened={() => setSchrankSheet(null)}
              boardTerminals={boardTerms}
              onPrintWires={control.printWires}
            />
          )}

          {(tab === "aufbau" || tab === "klemmen") && catalogFailed && (
            <div className="sp-encl-tab-state" role="alert">
              <p>Schrankkatalog konnte nicht geladen werden.</p>
              <button type="button" className="sp-btn sp-encl-target" onClick={() => void enclosureCatalog.reload()}>
                Erneut laden
              </button>
            </div>
          )}

          {tab === "aufbau" && (
            <RailEditor
              onPrintRowLabels={(rowId) => labels.open([rowId])}
              document={document}
              index={enclosureIndex}
              selectedDeviceId={selectedDeviceId}
              readOnly={readOnly}
              onSelectDevice={setSelectedDeviceId}
              onAddDevice={palette.openRow}
              onAddDeviceToRail={palette.openRail}
              findings={cabinetFindings}
              findingActions={aufbauTerminals.actions}
              onAddRowFromTemplate={() => setTemplateSheetOpen(true)}
              onAddRow={editor.addRow}
              onRemoveRow={editor.removeRow}
              onRenameRow={editor.renameRow}
              onChangeSlots={editor.changeSlots}
            />
          )}

          {tab === "klemmen" && !catalogFailed && (
            <TerminalList
              document={document}
              boardTerminals={boardTerms}
              readOnly={readOnly}
              onSetAllTerminals={(flag) => editor.mutate((current) => setAllTerminalsOnBoard(current, enclosureIndex, flag))}
              onPrint={control.printKlemmen}
              hasControlStrip={control.hasControlStrip}
              onPrintWires={control.printWires}
              pdfHref={panelPdfUrl(panel.id, { terminalsOnly: true })}
              onPdfClick={savedPdfClick(panelPdfUrl(panel.id, { terminalsOnly: true }), settleSaves, setError, "Klemmenliste")}
              printing={labels.printing}
            />
          )}

          {tab === "material" && (
            <div className="sp-material">
              <p className="sp-scope-hint">{MATERIAL_HINT}</p>
              {/* Keyed on the revision: a save that lands while the list is
                  open re-derives it, instead of showing the board before. */}
              <PanelMaterialList
                key={panel.revision}
                token={token}
                panelId={panel.id}
                canEdit={canEdit}
                language={language}
                hideHeader
                currentUserId={user?.id ?? null}
                canManageWerkstatt={(user?.effective_permissions ?? []).includes("werkstatt:manage")}
                settleSaves={settleSaves}
              />
            </div>
          )}

          {tab === "legende" && (
            <div className="sp-legend">
              <LegendTable rows={legend} />
            </div>
          )}

          {tab === "daten" && (
            <PanelDataTab
              panel={panel}
              document={document}
              panels={panels}
              readOnly={readOnly}
              canEdit={canEdit}
              onPatchSupply={editor.patchSupply}
              onSaveMeta={savePanelMeta}
              onDelete={deleteCurrentPanel}
              infeedHint={control.infeedHint}
            />
          )}
        </section>
      )}

      <DevicePalette document={document} {...palette.sheet} />
      {palette.confirm}
      {tab === "aufbau" && aufbauTerminals.overlay}

      <RowTemplateSheet
        open={templateSheetOpen}
        onPick={addRowFromTemplate}
        onClose={() => setTemplateSheetOpen(false)}
      />

      {/* The Schrank tab opens its own inspector inside its sheet stack. */}
      {document && tab !== "schrank" && (
        <DeviceInspector
          device={selectedDevice}
          document={document}
          suppliedBy={suppliedBanner}
          onMoveToRail={moveToRail}
          terminalBlockedZone={terminalBlockedZone(document, enclosureIndex, skip, selectedDeviceId)}
          readOnly={readOnly}
          onChange={(patch) => selectedDevice && editor.patchDevice(selectedDevice.id, patch)}
          onEditTerminalLabel={editor.editTerminalLabel}
          onDelete={() => selectedDevice && removeDevice(selectedDevice.id)}
          onDuplicate={() => selectedDevice && duplicateDevice(selectedDevice.id)}
          onMove={(direction) => selectedDevice && editor.moveDevice(selectedDevice.id, direction)}
          onClose={() => setSelectedDeviceId(null)}
          hasPrevious={previousDeviceId !== null}
          hasNext={nextDeviceId !== null}
          onNavigate={navigateDevice}
        />
      )}

      {document && (
        <LabelPrintDialog
          open={labels.dialog.open}
          mode={labels.dialog.mode}
          document={document}
          boardTerminals={boardTerms}
          initialRowIds={labels.dialog.ids}
          busy={labels.printing}
          readOnly={readOnly}
          onEditTerminalLabel={editor.editTerminalLabel}
          onPrint={(ids, materialId, options) => void labels.print(ids, materialId, options)}
          onClose={labels.close}
        />
      )}

      {panel && (
        <PanelTypeLabelDialog
          open={typeLabel.dialogOpen}
          panelId={panel.id}
          busy={typeLabel.printing}
          onPrint={(body) => void typeLabel.print(body)}
          onClose={typeLabel.close}
        />
      )}

      {newPanelOpen && customerId != null && (
        <NewPanelDialog
          customerName={customerName}
          projectLabel={projectLabel}
          existing={panels}
          busy={creating}
          cabinets={cabinetChoices(enclosureCatalog.catalog, enclosureIndex)}
          onCancel={() => setNewPanelOpen(false)}
          onCreate={handleCreate}
        />
      )}
    </div>
  );
}
