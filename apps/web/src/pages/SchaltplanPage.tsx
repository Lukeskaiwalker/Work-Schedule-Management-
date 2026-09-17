/**
 * Verteilerpläne — draw a panel schematic and let the legend fall out of it.
 *
 * Construction-view only (see `navViews` in App.tsx): this is a field tool
 * for the person standing in front of an open board, not an office report.
 *
 * The page is a thin orchestrator. The domain lives in
 * `utils/schaltplanTopology.ts` (what the document means) and the drawing in
 * `components/schaltplan/*`; here we hold the selection, the edit buffer and
 * the autosave.
 *
 * Autosave, not a Save button
 * ---------------------------
 * Every edit lands in local state immediately and is flushed to the server
 * after a short idle. A worker up a ladder does not tap Save, and a lost
 * Verteiler is an hour of re-typing. The trade-off is that a failed flush
 * must be *visible*, so the status chip in the header reports "gespeichert /
 * speichert… / nicht gespeichert" rather than failing silently.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useAppContext } from "../context/AppContext";
import { DeviceInspector } from "../components/schaltplan/DeviceInspector";
import { DevicePalette } from "../components/schaltplan/DevicePalette";
import { LabelPrintDialog } from "../components/schaltplan/LabelPrintDialog";
import { LegendTable } from "../components/schaltplan/LegendTable";
import { NewPanelDialog } from "../components/schaltplan/NewPanelDialog";
import { PanelDataTab } from "../components/schaltplan/PanelDataTab";
import { PanelDiagram } from "../components/schaltplan/PanelDiagram";
import { PanelScopePicker } from "../components/schaltplan/PanelScopePicker";
import { RailEditor } from "../components/schaltplan/RailEditor";
import { RowTemplateSheet } from "../components/schaltplan/RowTemplateSheet";
import { TerminalList } from "../components/schaltplan/TerminalList";
import { useLabelPrinting } from "../components/schaltplan/useLabelPrinting";
import { PANEL_TYPE_LABELS, emptyDocument, makeDevice, newId, nextCircuitNumber } from "../utils/schaltplanDevices";
import {
  duplicateDevice as duplicateDeviceInDocument,
  rowFromTemplate,
  type RowTemplateId,
} from "../utils/schaltplanDocumentOps";
import { isTerminalEligible } from "../utils/schaltplanTerminalRules";
import { deriveTerminals, terminalCounts } from "../utils/schaltplanTerminals";
import { buildLegend, findDevice, neighbourDeviceId, validateDocument } from "../utils/schaltplanTopology";
import {
  createPanel,
  deletePanel as deletePanelRequest,
  duplicatePanel,
  getPanel,
  listPanels,
  panelPdfUrl,
  updatePanel,
} from "../utils/schaltplanApi";
import type {
  DeviceKind,
  PanelDevice,
  PanelDocument,
  PanelPlan,
  PanelPlanSummary,
  PanelSupply,
  PanelType,
} from "../types/schaltplan";
// Own sheet, not styles.css — see the header of that file.
import "../styles/schaltplan-terminals.css";

type EditorTab = "plan" | "aufbau" | "klemmen" | "legende" | "daten";
type SaveState = "clean" | "pending" | "saving" | "error";

const AUTOSAVE_DELAY_MS = 900;

const TAB_LABELS: Record<EditorTab, string> = {
  plan: "Plan",
  aufbau: "Aufbau",
  klemmen: "Klemmen",
  legende: "Legende",
  daten: "Daten",
};

export function SchaltplanPage() {
  const {
    token,
    language,
    user,
    customers,
    projects,
    openCustomerModal,
    setNotice,
    setError,
  } = useAppContext();

  const canEdit = Boolean(user?.effective_permissions?.includes("reports:create"));

  const [customerId, setCustomerId] = useState<number | null>(null);
  const [projectId, setProjectId] = useState<number | null>(null);
  const [panels, setPanels] = useState<PanelPlanSummary[]>([]);
  const [panelsLoading, setPanelsLoading] = useState(false);

  const [panel, setPanel] = useState<PanelPlan | null>(null);
  const [document, setDocument] = useState<PanelDocument | null>(null);
  const [tab, setTab] = useState<EditorTab>("plan");
  const [selectedDeviceId, setSelectedDeviceId] = useState<string | null>(null);
  const labels = useLabelPrinting({ panel, token, setNotice, setError });
  const [paletteRowId, setPaletteRowId] = useState<string | null>(null);
  const [templateSheetOpen, setTemplateSheetOpen] = useState(false);
  const [newPanelOpen, setNewPanelOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>("clean");

  const saveTimer = useRef<number | null>(null);
  const pendingDocument = useRef<PanelDocument | null>(null);

  const readOnly = !canEdit;

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

  // The hook hands back a fresh object every render; only its callbacks are
  // stable. Depending on `labels` itself would recreate openPanel on every
  // render and defeat the memo for any effect that lists it.
  const { reset: resetLabels } = labels;
  const openPanel = useCallback(
    async (panelId: number) => {
      try {
        const loaded = await getPanel(token, panelId);
        setPanel(loaded);
        setDocument(loaded.document);
        setSelectedDeviceId(null);
        resetLabels();
        setSaveState("clean");
        setTab("plan");
      } catch {
        setError("Der Verteilerplan konnte nicht geöffnet werden.");
      }
    },
    [token, setError, resetLabels],
  );

  // ── Autosave ─────────────────────────────────────────────────────────────

  const flush = useCallback(async () => {
    const target = pendingDocument.current;
    if (!panel || !target) return;
    pendingDocument.current = null;
    setSaveState("saving");
    try {
      const saved = await updatePanel(token, panel.id, { document: target });
      setPanel(saved);
      // The server is authoritative for the derived values (legend, findings,
      // revision) but NOT for the document — the user may have typed on while
      // the request was in flight, and overwriting `document` here would eat
      // those keystrokes.
      setSaveState(pendingDocument.current ? "pending" : "clean");
      // Refresh only the counters the card shows. Spreading the whole detail
      // response would push `document`, `legend` and `findings` into the
      // summary list — payload the picker never reads, held per panel.
      setPanels((current) =>
        current.map((row) =>
          row.id === saved.id
            ? {
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
              }
            : row,
        ),
      );
    } catch {
      setSaveState("error");
      setError("Änderungen konnten nicht gespeichert werden. Prüfe die Verbindung.");
    }
  }, [panel, token, setError]);

  const scheduleSave = useCallback(
    (next: PanelDocument) => {
      pendingDocument.current = next;
      setSaveState("pending");
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(() => {
        void flush();
      }, AUTOSAVE_DELAY_MS);
    },
    [flush],
  );

  // Flush on unmount and when the tab is hidden — a worker switching apps or
  // locking the tablet is the most common way an edit would otherwise be lost.
  useEffect(() => {
    const onHide = () => {
      if (window.document.visibilityState === "hidden" && pendingDocument.current) void flush();
    };
    window.document.addEventListener("visibilitychange", onHide);
    return () => {
      window.document.removeEventListener("visibilitychange", onHide);
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
      if (pendingDocument.current) void flush();
    };
  }, [flush]);

  /**
   * Apply an edit to the document and queue the save.
   *
   * Computed outside `setDocument` rather than inside an updater callback:
   * React double-invokes updaters in StrictMode, so scheduling the save from
   * in there queued every edit twice. Each caller mutates once per event
   * handler, so reading `document` from the closure is safe here — and it
   * keeps the state update a pure function of its input.
   */
  const mutate = useCallback(
    (recipe: (current: PanelDocument) => PanelDocument) => {
      if (readOnly || !document) return;
      const next = recipe(document);
      setDocument(next);
      scheduleSave(next);
    },
    [readOnly, document, scheduleSave],
  );

  // ── Document operations (all immutable) ──────────────────────────────────

  const addDevice = useCallback(
    (rowId: string, kind: DeviceKind) => {
      if (!document) return;
      const fresh = makeDevice(kind);
      // Breakers get the next free Stromkreis-Nr. straight away — it is the
      // field that is always filled in and the one nobody wants to look up.
      const device: PanelDevice =
        fresh.kind === "mcb" || fresh.kind === "rcbo"
          ? { ...fresh, circuit: nextCircuitNumber(document) }
          : fresh;

      mutate((current) => ({
        ...current,
        rows: current.rows.map((row) =>
          row.id === rowId ? { ...row, devices: [...row.devices, device] } : row,
        ),
      }));
      setPaletteRowId(null);
      // Straight into the inspector: adding a device is never the whole
      // intent — the next thing is always naming what it feeds.
      setSelectedDeviceId(device.id);
    },
    [document, mutate],
  );

  const patchDevice = useCallback(
    (deviceId: string, patch: Partial<PanelDevice>) => {
      mutate((current) => ({
        ...current,
        rows: current.rows.map((row) => ({
          ...row,
          devices: row.devices.map((device) =>
            device.id === deviceId ? { ...device, ...patch } : device,
          ),
        })),
      }));
    },
    [mutate],
  );

  const removeDevice = useCallback(
    (deviceId: string) => {
      mutate((current) => ({
        ...current,
        rows: current.rows.map((row) => ({
          ...row,
          devices: row.devices
            .filter((device) => device.id !== deviceId)
            // Anything that named the deleted device as its feed goes back to
            // positional derivation rather than being left pointing at a ghost.
            .map((device) =>
              device.parent_id === deviceId ? { ...device, parent_id: null } : device,
            ),
        })),
      }));
      setSelectedDeviceId(null);
    },
    [mutate],
  );

  /**
   * Copy the device into the next slot. The numbering rules live in
   * `schaltplanDocumentOps`; here only the selection moves onto the copy, so
   * the next tap is already on the thing that needs a new name.
   */
  const duplicateDevice = useCallback(
    (deviceId: string) => {
      if (readOnly || !document) return;
      const result = duplicateDeviceInDocument(document, deviceId);
      if (!result.deviceId) return;
      mutate(() => result.document);
      setSelectedDeviceId(result.deviceId);
    },
    [readOnly, document, mutate],
  );

  const addRowFromTemplate = useCallback(
    (templateId: RowTemplateId) => {
      mutate((current) => ({ ...current, rows: [...current.rows, rowFromTemplate(current, templateId)] }));
      setTemplateSheetOpen(false);
    },
    [mutate],
  );

  /**
   * Move a device one slot. At a rail's edge it hops to the neighbouring
   * rail, because "move left" should mean the same thing at position 0 as it
   * does anywhere else — order is continuous across the whole board, and so
   * is the protection grouping it drives.
   */
  const moveDevice = useCallback(
    (deviceId: string, direction: -1 | 1) => {
      mutate((current) => {
        const rowIndex = current.rows.findIndex((row) =>
          row.devices.some((device) => device.id === deviceId),
        );
        if (rowIndex < 0) return current;
        const row = current.rows[rowIndex];
        const index = row.devices.findIndex((device) => device.id === deviceId);
        const target = index + direction;

        if (target >= 0 && target < row.devices.length) {
          const devices = [...row.devices];
          [devices[index], devices[target]] = [devices[target], devices[index]];
          return {
            ...current,
            rows: current.rows.map((candidate, position) =>
              position === rowIndex ? { ...candidate, devices } : candidate,
            ),
          };
        }

        const neighbourIndex = rowIndex + direction;
        if (neighbourIndex < 0 || neighbourIndex >= current.rows.length) return current;
        const device = row.devices[index];
        const rows = current.rows.map((candidate, position) => {
          if (position === rowIndex) {
            return { ...candidate, devices: candidate.devices.filter((entry) => entry.id !== deviceId) };
          }
          if (position === neighbourIndex) {
            return {
              ...candidate,
              devices:
                direction === -1
                  ? [...candidate.devices, device]
                  : [device, ...candidate.devices],
            };
          }
          return candidate;
        });
        return { ...current, rows };
      });
    },
    [mutate],
  );

  const patchSupply = useCallback(
    (patch: Partial<PanelSupply>) => {
      mutate((current) => ({ ...current, supply: { ...current.supply, ...patch } }));
    },
    [mutate],
  );

  /**
   * Flag or clear "Reihenklemme am Abgang" on every eligible outgoing at
   * once. Only devices whose flag actually changes get a new object, so an
   * untouched breaker keeps its identity for React.
   */
  const setAllTerminals = useCallback(
    (flag: boolean) => {
      mutate((current) => ({
        ...current,
        rows: current.rows.map((row) => ({
          ...row,
          devices: row.devices.map((device) =>
            isTerminalEligible(device) && device.terminal_block !== flag ? { ...device, terminal_block: flag } : device,
          ),
        })),
      }));
    },
    [mutate],
  );

  // ── Panel-level operations ───────────────────────────────────────────────

  const savePanelMeta = useCallback(
    async (patch: Parameters<typeof updatePanel>[2]) => {
      if (!panel) return;
      try {
        const saved = await updatePanel(token, panel.id, patch);
        setPanel(saved);
        void reloadPanels();
      } catch (error) {
        setError(
          error instanceof Error && error.message
            ? error.message
            : "Der Verteiler konnte nicht gespeichert werden.",
        );
      }
    },
    [panel, token, reloadPanels, setError],
  );

  const handleCreate = useCallback(
    async (payload: {
      name: string;
      designation: string;
      panel_type: PanelType;
      location: string;
      fed_from_panel_id: number | null;
    }) => {
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
          document: emptyDocument(),
        });
        setNewPanelOpen(false);
        setPanel(created);
        setDocument(created.document);
        setTab("aufbau");
        setSaveState("clean");
        void reloadPanels();
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
    [customerId, projectId, token, reloadPanels, setError],
  );

  const deleteCurrentPanel = useCallback(async () => {
    if (!panel) return;
    try {
      await deletePanelRequest(token, panel.id);
      setPanel(null);
      setDocument(null);
      setNotice("Verteilerplan gelöscht.");
      void reloadPanels();
    } catch {
      setError("Der Verteilerplan konnte nicht gelöscht werden.");
    }
  }, [panel, token, reloadPanels, setNotice, setError]);

  // ── Derived ──────────────────────────────────────────────────────────────

  const legend = useMemo(() => (document ? buildLegend(document) : []), [document]);
  const findings = useMemo(() => (document ? validateDocument(document) : []), [document]);
  const terminalGroups = useMemo(() => (document ? deriveTerminals(document) : []), [document]);
  const terminalCount = terminalCounts(terminalGroups).terminals;
  const warnings = findings.filter((finding) => finding.level === "warn");
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
  const activeRowLabel =
    document?.rows.find((row) => row.id === paletteRowId)?.label ?? "Reihe";
  const customerName = customers.find((customer) => customer.id === customerId)?.name ?? "";
  const projectLabel = (() => {
    const project = projects.find((entry) => entry.id === projectId);
    return project ? `${project.project_number} · ${project.name}` : null;
  })();

  const saveLabel: Record<SaveState, string> = {
    clean: "Gespeichert",
    pending: "Änderungen…",
    saving: "Speichert…",
    error: "Nicht gespeichert",
  };

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
          setPanel(null);
          setDocument(null);
        }}
        onProjectChange={(nextId) => {
          setProjectId(nextId);
          setPanel(null);
          setDocument(null);
        }}
        onRequestCreateCustomer={(prefillName) =>
          openCustomerModal({
            prefillName,
            onSaved: (customer) => setCustomerId(customer.id),
          })
        }
        panels={panels}
        activePanelId={panel?.id ?? null}
        onSelectPanel={(panelId) => void openPanel(panelId)}
        onNewPanel={() => setNewPanelOpen(true)}
        canEdit={canEdit}
        loading={panelsLoading}
      />

      {panel && document && (
        <section className="sp-editor">
          <header className="sp-editor-head">
            <div className="sp-editor-identity">
              <span className={`sp-panel-badge sp-panel-badge--${panel.panel_type}`}>
                {panel.designation}
              </span>
              <div>
                <h3>{panel.name}</h3>
                <small>
                  {PANEL_TYPE_LABELS[panel.panel_type]}
                  {panel.location ? ` · ${panel.location}` : ""}
                  {panel.fed_from_designation ? ` · eingespeist von ${panel.fed_from_designation}` : ""}
                </small>
              </div>
            </div>

            <div className="sp-editor-actions">
              <span className={`sp-save sp-save--${saveState}`} role="status">
                {saveLabel[saveState]}
              </span>
              <a
                className="sp-btn"
                href={panelPdfUrl(panel.id)}
                target="_blank"
                rel="noreferrer"
              >
                Plan als PDF
              </a>
              <a
                className="sp-btn"
                href={panelPdfUrl(panel.id, { legendOnly: true })}
                target="_blank"
                rel="noreferrer"
              >
                Legende drucken
              </a>
              <button
                type="button"
                className="sp-btn"
                disabled={labels.printing}
                onClick={() => labels.open(document.rows.map((row) => row.id))}
                title="Ein Etikett je Betriebsmittelkennzeichen — Reihen und Material in der Vorschau wählen"
              >
                {labels.printing ? "Drucke…" : "BMK-Etiketten"}
              </button>
              {canEdit && (
                <button
                  type="button"
                  className="sp-btn"
                  onClick={() =>
                    void savePanelMeta({ status: panel.status === "final" ? "draft" : "final" })
                  }
                >
                  {panel.status === "final" ? "Auf Entwurf setzen" : "Als Bestand markieren"}
                </button>
              )}
              {canEdit && (
                <button
                  type="button"
                  className="sp-btn"
                  onClick={async () => {
                    try {
                      const copy = await duplicatePanel(token, panel.id);
                      setPanel(copy);
                      setDocument(copy.document);
                      setNotice(`Kopie „${copy.designation}“ angelegt.`);
                      void reloadPanels();
                    } catch {
                      setError("Die Kopie konnte nicht angelegt werden.");
                    }
                  }}
                >
                  Duplizieren
                </button>
              )}
            </div>
          </header>

          {warnings.length > 0 && (
            <div className="sp-warnings" role="status">
              <b>Prüfen:</b>
              <ul>
                {warnings.slice(0, 4).map((finding, index) => (
                  <li key={index}>{finding.message}</li>
                ))}
              </ul>
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
                onClick={() => setTab(key)}
              >
                {TAB_LABELS[key]}
                {key === "legende" && legend.length > 0 && (
                  <span className="sp-count">{legend.length}</span>
                )}
                {key === "klemmen" && terminalCount > 0 && <span className="sp-count">{terminalCount}</span>}
              </button>
            ))}
          </nav>

          {tab === "plan" && (
            <PanelDiagram
              document={document}
              selectedDeviceId={selectedDeviceId}
              onSelect={setSelectedDeviceId}
              fedFrom={panel.fed_from_designation}
              designation={panel.designation}
            />
          )}

          {tab === "aufbau" && (
            <RailEditor
              onPrintRowLabels={(rowId) => labels.open([rowId])}
              document={document}
              selectedDeviceId={selectedDeviceId}
              readOnly={readOnly}
              onSelectDevice={setSelectedDeviceId}
              onAddDevice={(rowId) => setPaletteRowId(rowId)}
              onAddRowFromTemplate={() => setTemplateSheetOpen(true)}
              onAddRow={() =>
                mutate((current) => ({
                  ...current,
                  rows: [
                    ...current.rows,
                    {
                      id: newId("row"),
                      label: `Reihe ${current.rows.length + 1}`,
                      slots: 12,
                      devices: [],
                    },
                  ],
                }))
              }
              onRemoveRow={(rowId) =>
                mutate((current) => ({
                  ...current,
                  rows: current.rows.filter((row) => row.id !== rowId),
                }))
              }
              onRenameRow={(rowId, label) =>
                mutate((current) => ({
                  ...current,
                  rows: current.rows.map((row) => (row.id === rowId ? { ...row, label } : row)),
                }))
              }
              onChangeSlots={(rowId, slots) =>
                mutate((current) => ({
                  ...current,
                  rows: current.rows.map((row) =>
                    row.id === rowId ? { ...row, slots: Math.max(1, Math.min(96, slots)) } : row,
                  ),
                }))
              }
            />
          )}

          {tab === "klemmen" && (
            <TerminalList
              document={document}
              readOnly={readOnly}
              onSetAllTerminals={setAllTerminals}
              onPrint={() =>
                labels.open(
                  terminalGroups.map((group) => group.groupId),
                  "reihenklemmen",
                )
              }
              pdfHref={panelPdfUrl(panel.id, { terminalsOnly: true })}
              printing={labels.printing}
            />
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
              onPatchSupply={patchSupply}
              onSaveMeta={savePanelMeta}
              onDelete={deleteCurrentPanel}
            />
          )}
        </section>
      )}

      <DevicePalette
        open={paletteRowId != null}
        targetRowLabel={activeRowLabel}
        onPick={(kind) => paletteRowId && addDevice(paletteRowId, kind)}
        onClose={() => setPaletteRowId(null)}
      />

      <RowTemplateSheet
        open={templateSheetOpen}
        onPick={addRowFromTemplate}
        onClose={() => setTemplateSheetOpen(false)}
      />

      {document && (
        <DeviceInspector
          device={selectedDevice}
          document={document}
          readOnly={readOnly}
          onChange={(patch) => selectedDevice && patchDevice(selectedDevice.id, patch)}
          onDelete={() => selectedDevice && removeDevice(selectedDevice.id)}
          onDuplicate={() => selectedDevice && duplicateDevice(selectedDevice.id)}
          onMove={(direction) => selectedDevice && moveDevice(selectedDevice.id, direction)}
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
          initialRowIds={labels.dialog.ids}
          busy={labels.printing}
          onPrint={(ids, materialId, options) => void labels.print(ids, materialId, options)}
          onClose={labels.close}
        />
      )}

      {newPanelOpen && customerId != null && (
        <NewPanelDialog
          customerName={customerName}
          projectLabel={projectLabel}
          existing={panels}
          busy={creating}
          onCancel={() => setNewPanelOpen(false)}
          onCreate={handleCreate}
        />
      )}
    </div>
  );
}
