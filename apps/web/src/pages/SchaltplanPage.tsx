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
import { LegendTable } from "../components/schaltplan/LegendTable";
import { NewPanelDialog } from "../components/schaltplan/NewPanelDialog";
import { PanelDiagram } from "../components/schaltplan/PanelDiagram";
import { PanelScopePicker } from "../components/schaltplan/PanelScopePicker";
import { RailEditor } from "../components/schaltplan/RailEditor";
import {
  PANEL_TYPE_LABELS,
  SUPPLY_SYSTEMS,
  emptyDocument,
  makeDevice,
  newId,
  nextCircuitNumber,
} from "../utils/schaltplanDevices";
import { buildLegend, findDevice, validateDocument } from "../utils/schaltplanTopology";
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

type EditorTab = "plan" | "aufbau" | "legende" | "daten";
type SaveState = "clean" | "pending" | "saving" | "error";

const AUTOSAVE_DELAY_MS = 900;

const TAB_LABELS: Record<EditorTab, string> = {
  plan: "Plan",
  aufbau: "Aufbau",
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
  const [paletteRowId, setPaletteRowId] = useState<string | null>(null);
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

  const openPanel = useCallback(
    async (panelId: number) => {
      try {
        const loaded = await getPanel(token, panelId);
        setPanel(loaded);
        setDocument(loaded.document);
        setSelectedDeviceId(null);
        setSaveState("clean");
        setTab("plan");
      } catch {
        setError("Der Verteilerplan konnte nicht geöffnet werden.");
      }
    },
    [token, setError],
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

  // ── Derived ──────────────────────────────────────────────────────────────

  const legend = useMemo(() => (document ? buildLegend(document) : []), [document]);
  const findings = useMemo(() => (document ? validateDocument(document) : []), [document]);
  const warnings = findings.filter((finding) => finding.level === "warn");
  const selectedDevice = document ? findDevice(document, selectedDeviceId) : null;
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
              document={document}
              selectedDeviceId={selectedDeviceId}
              readOnly={readOnly}
              onSelectDevice={setSelectedDeviceId}
              onAddDevice={(rowId) => setPaletteRowId(rowId)}
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

          {tab === "legende" && (
            <div className="sp-legend">
              <LegendTable rows={legend} />
            </div>
          )}

          {tab === "daten" && (
            <div className="sp-data">
              <section className="sp-data-block">
                <h4>Einspeisung</h4>
                <div className="sp-field-grid">
                  <label className="sp-field">
                    <span className="sp-field-label">Netzform</span>
                    <select
                      value={document.supply.system}
                      disabled={readOnly}
                      onChange={(event) =>
                        patchSupply({ system: event.target.value as PanelSupply["system"] })
                      }
                    >
                      {SUPPLY_SYSTEMS.map((system) => (
                        <option key={system} value={system}>
                          {system}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="sp-field">
                    <span className="sp-field-label">Spannung</span>
                    <input
                      type="text"
                      value={document.supply.voltage}
                      disabled={readOnly}
                      onChange={(event) => patchSupply({ voltage: event.target.value })}
                    />
                  </label>
                  <label className="sp-field">
                    <span className="sp-field-label">Zuleitung</span>
                    <input
                      type="text"
                      value={document.supply.incoming}
                      disabled={readOnly}
                      placeholder="NYY-J 5x16 mm²"
                      onChange={(event) => patchSupply({ incoming: event.target.value })}
                    />
                  </label>
                  <label className="sp-field">
                    <span className="sp-field-label">Vorsicherung</span>
                    <input
                      type="text"
                      value={document.supply.fuse}
                      disabled={readOnly}
                      placeholder="NH 63 A"
                      onChange={(event) => patchSupply({ fuse: event.target.value })}
                    />
                  </label>
                  <label className="sp-field">
                    <span className="sp-field-label">Zählernummer</span>
                    <input
                      type="text"
                      value={document.supply.meter_number}
                      disabled={readOnly}
                      onChange={(event) => patchSupply({ meter_number: event.target.value })}
                    />
                  </label>
                </div>
              </section>

              <section className="sp-data-block">
                <h4>Verteiler</h4>
                <div className="sp-field-grid">
                  <label className="sp-field">
                    <span className="sp-field-label">Bezeichnung</span>
                    <input
                      type="text"
                      defaultValue={panel.designation}
                      disabled={readOnly}
                      onBlur={(event) => {
                        const value = event.target.value.trim();
                        if (value && value !== panel.designation) {
                          void savePanelMeta({ designation: value });
                        }
                      }}
                    />
                  </label>
                  <label className="sp-field">
                    <span className="sp-field-label">Name</span>
                    <input
                      type="text"
                      defaultValue={panel.name}
                      disabled={readOnly}
                      onBlur={(event) => {
                        const value = event.target.value.trim();
                        if (value && value !== panel.name) void savePanelMeta({ name: value });
                      }}
                    />
                  </label>
                  <label className="sp-field">
                    <span className="sp-field-label">Ort</span>
                    <input
                      type="text"
                      defaultValue={panel.location ?? ""}
                      disabled={readOnly}
                      onBlur={(event) => void savePanelMeta({ location: event.target.value.trim() })}
                    />
                  </label>
                  <label className="sp-field">
                    <span className="sp-field-label">Art</span>
                    <select
                      value={panel.panel_type}
                      disabled={readOnly}
                      onChange={(event) =>
                        void savePanelMeta({ panel_type: event.target.value as PanelType })
                      }
                    >
                      {(["main", "sub", "meter"] as PanelType[]).map((type) => (
                        <option key={type} value={type}>
                          {PANEL_TYPE_LABELS[type]}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="sp-field">
                    <span className="sp-field-label">Eingespeist von</span>
                    <select
                      value={panel.fed_from_panel_id ?? ""}
                      disabled={readOnly}
                      onChange={(event) =>
                        void savePanelMeta({
                          fed_from_panel_id: event.target.value ? Number(event.target.value) : null,
                        })
                      }
                    >
                      <option value="">Netz / Hausanschluss</option>
                      {panels
                        .filter((row) => row.id !== panel.id)
                        .map((row) => (
                          <option key={row.id} value={row.id}>
                            {row.designation} — {row.name}
                          </option>
                        ))}
                    </select>
                  </label>
                </div>
                <label className="sp-field">
                  <span className="sp-field-label">Notizen</span>
                  <textarea
                    rows={3}
                    defaultValue={panel.notes ?? ""}
                    disabled={readOnly}
                    onBlur={(event) => void savePanelMeta({ notes: event.target.value })}
                  />
                </label>
              </section>

              {canEdit && (
                <section className="sp-data-block sp-data-block--danger">
                  <h4>Verteiler löschen</h4>
                  <p>
                    Entfernt den Plan mit allen Stromkreisen. Nur der Ersteller oder die
                    Projektleitung kann das.
                  </p>
                  <button
                    type="button"
                    className="sp-btn sp-btn--danger"
                    onClick={async () => {
                      if (!window.confirm(`Verteiler „${panel.designation}“ wirklich löschen?`)) return;
                      try {
                        await deletePanelRequest(token, panel.id);
                        setPanel(null);
                        setDocument(null);
                        setNotice("Verteilerplan gelöscht.");
                        void reloadPanels();
                      } catch {
                        setError("Der Verteilerplan konnte nicht gelöscht werden.");
                      }
                    }}
                  >
                    Löschen
                  </button>
                </section>
              )}
            </div>
          )}
        </section>
      )}

      <DevicePalette
        open={paletteRowId != null}
        targetRowLabel={activeRowLabel}
        onPick={(kind) => paletteRowId && addDevice(paletteRowId, kind)}
        onClose={() => setPaletteRowId(null)}
      />

      {document && (
        <DeviceInspector
          device={selectedDevice}
          document={document}
          readOnly={readOnly}
          onChange={(patch) => selectedDevice && patchDevice(selectedDevice.id, patch)}
          onDelete={() => selectedDevice && removeDevice(selectedDevice.id)}
          onMove={(direction) => selectedDevice && moveDevice(selectedDevice.id, direction)}
          onClose={() => setSelectedDeviceId(null)}
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
