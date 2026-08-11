/**
 * Maschinen — the machine register.
 *
 * A machine differs from an article in one way that changes everything: it is
 * one object, not a count. "3 Akkuschrauber" cannot tell you which one is in
 * the Bulli, which failed its DGUV3, and who had the third one last. So each
 * physical machine carries its own number (M-0001, printed on the label stuck
 * to it), its own status, and its own custody log.
 *
 * FILTERING IS CLIENT-SIDE, on purpose, even though the endpoint supports every
 * filter as a query param:
 *   * the KPI counts have to describe ALL machines, not the current filter —
 *     re-fetching per filter would either lose the totals or cost a second
 *     round trip per keystroke,
 *   * a workshop has tens to low hundreds of machines, which is nothing,
 *   * search-as-you-type against a server is worse UX than the same search
 *     against an in-memory list.
 * The server-side filters remain the contract the mobile scanner uses, where
 * the client is on a phone on a building site and the list should not be.
 *
 * Sub-components (batteries, chargers) are NOT rows here. They belong to their
 * machine, travel with it, and appear under it in the detail view — listing
 * them at top level would triple the register and count one drill leaving the
 * building as three departures.
 */
import { useCallback, useEffect, useMemo, useState } from "react";

import { apiFetch } from "../../api/client";
import { useAppContext } from "../../context/AppContext";
import {
  CameraScannerSheet,
  type ScanOutcome,
} from "../../components/werkstatt/CameraScannerSheet";
import { MaschineBearbeitenModal } from "../../components/werkstatt/MaschineBearbeitenModal";
import { MaschineBuchenModal } from "../../components/werkstatt/MaschineBuchenModal";
import { MaschineDetailPanel } from "../../components/werkstatt/MaschineDetailPanel";
import { NeueMaschineModal } from "../../components/werkstatt/NeueMaschineModal";
import {
  formatMachineDate,
  machineStatusLabel,
  machineWhereabouts,
  MACHINE_STATUS_TONES,
  relativeDayLabel,
} from "../../components/werkstatt/machineStatus";
import type { ScanResolveResult, WerkstattLocation } from "../../types/werkstatt";
import type {
  Machine,
  MachineBookPayload,
  MachineCreatePayload,
  MachineInspectionPayload,
  MachineMovement,
  MachineReturnPayload,
  MachineUpdatePayload,
} from "../../types/werkstattMachines";
import {
  bookMachine,
  createMachine,
  getMachine,
  getMachineHistory,
  listMachines,
  printMachineLabel,
  printMachineLabels,
  recordInspection,
  returnMachine,
  updateMachine,
} from "../../utils/werkstattMachinesApi";

/** The saved views the tab opens with. */
type ViewKey = "all" | "verfuegbar" | "ausgegeben" | "overdue" | "inspection";

const VIEW_DEFS: ReadonlyArray<{ key: ViewKey; de: string; en: string }> = [
  { key: "all", de: "Alle", en: "All" },
  { key: "verfuegbar", de: "Verfügbar", en: "Available" },
  { key: "ausgegeben", de: "Unterwegs", en: "Out" },
  { key: "overdue", de: "Überfällig", en: "Overdue" },
  { key: "inspection", de: "Prüfung fällig", en: "Inspection due" },
];

function SearchIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="11" cy="11" r="6.3" stroke="#5C7895" strokeWidth="1.8" />
      <path d="m15.6 15.6 4 4" stroke="#5C7895" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

export function WerkstattMaschinenPage() {
  const {
    mainView,
    werkstattTab,
    language,
    token,
    user,
    assignableUsers,
    activeWerkstattMachineId,
    setActiveWerkstattMachineId,
    setError,
    setNotice,
  } = useAppContext();
  const de = language === "de";
  const isActiveTab = mainView === "werkstatt" && werkstattTab === "maschinen";

  const [machines, setMachines] = useState<Machine[]>([]);
  const [locations, setLocations] = useState<WerkstattLocation[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);

  const [search, setSearch] = useState("");
  const [view, setView] = useState<ViewKey>("all");

  const [selected, setSelected] = useState<Machine | null>(null);
  const [history, setHistory] = useState<MachineMovement[]>([]);

  const [bookOpen, setBookOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [createParentId, setCreateParentId] = useState<number | null>(null);
  const [createBlueprintArticleId, setCreateBlueprintArticleId] = useState<number | null>(null);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  /**
   * Klein-label print queue. Collected here (session-local, survives view
   * switches within the tab) because one 99×44 sheet holds four DIFFERENT
   * quarter labels — the queue is how four small machines share a sheet.
   */
  const [printQueue, setPrintQueue] = useState<Machine[]>([]);
  /**
   * Every unit including components, for the "copy an existing one" picker.
   *
   * The list view deliberately hides components, but a spare battery is
   * blueprinted from a battery — which is somebody's component. Using
   * `machines` here would offer drills and saws while hiding exactly the
   * consumable-ish units you re-register most often.
   */
  const [blueprintCandidates, setBlueprintCandidates] = useState<Machine[]>([]);

  /**
   * Mirrors the server gate exactly, including the umbrella: each action is
   * allowed by its own narrow grant OR by `werkstatt:manage`. Getting this
   * wrong in either direction is bad — a hidden button someone is entitled to
   * press, or a visible one that answers 403.
   *
   * `?? false` rather than the banner's `?? true` stub, for that second reason.
   */
  const permissions = user?.effective_permissions ?? [];
  const canManageWerkstatt = permissions.includes("werkstatt:manage");
  const canCreate = canManageWerkstatt || permissions.includes("werkstatt:machines_create");
  const canEdit = canManageWerkstatt || permissions.includes("werkstatt:machines_edit");

  const reportError = useCallback(
    (err: unknown) => setError(err instanceof Error ? err.message : String(err)),
    [setError],
  );

  const loadMachines = useCallback(async () => {
    setLoading(true);
    try {
      const [topLevel, everything] = await Promise.all([
        listMachines(token),
        listMachines(token, { include_components: true }),
      ]);
      setMachines(topLevel);
      setBlueprintCandidates(everything);
    } catch (err: unknown) {
      reportError(err);
    } finally {
      setLoading(false);
    }
  }, [token, reportError]);

  const loadLocations = useCallback(async () => {
    try {
      setLocations(await apiFetch<WerkstattLocation[]>("/werkstatt/locations", token));
    } catch {
      // A missing location list degrades the pickers to "unchanged" but must not
      // block the register itself, which is the thing people came for.
      setLocations([]);
    }
  }, [token]);

  useEffect(() => {
    if (!isActiveTab) return;
    void loadMachines();
    void loadLocations();
  }, [isActiveTab, loadMachines, loadLocations]);

  /** Load one machine plus its log into the detail view. */
  const openMachine = useCallback(
    async (id: number) => {
      try {
        const [machine, log] = await Promise.all([
          getMachine(token, id),
          getMachineHistory(token, id),
        ]);
        setSelected(machine);
        setHistory(log);
      } catch (err: unknown) {
        reportError(err);
      }
    },
    [token, reportError],
  );

  // Handoff from the scanner: it resolved a label into a machine and asked for
  // this page. Consumed once and cleared, so coming back to the list later does
  // not silently jump into the same detail view again.
  //
  // Must sit BELOW `openMachine` — naming it in the dependency array above its
  // own `const` is a temporal-dead-zone crash, not just a lint warning.
  useEffect(() => {
    if (!isActiveTab || activeWerkstattMachineId == null) return;
    const wanted = activeWerkstattMachineId;
    setActiveWerkstattMachineId(null);
    void openMachine(wanted);
  }, [isActiveTab, activeWerkstattMachineId, setActiveWerkstattMachineId, openMachine]);

  /**
   * Camera scan from the register (tablet at the bench, or a phone in the
   * workshop). Goes through the same `/scan/resolve` cascade as the fullscreen
   * mobile scanner, so a label means the same thing on every surface — then
   * opens the machine rather than booking it, because here the user is looking
   * something up, not standing at the door with it.
   */
  const handleCameraScan = useCallback(
    async (code: string): Promise<ScanOutcome> => {
      try {
        const result = await apiFetch<ScanResolveResult>(
          `/werkstatt/scan/resolve?code=${encodeURIComponent(code)}`,
          token,
        );
        if (result.kind !== "machine") {
          return {
            ok: false,
            label: de ? `Keine Maschine: ${code}` : `Not a machine: ${code}`,
          };
        }
        setCameraOpen(false);
        await openMachine(result.machine.id);
        return { ok: true, label: `${result.machine.unit_number}` };
      } catch (err: unknown) {
        reportError(err);
        return { ok: false, label: de ? "Fehler" : "Failed" };
      }
    },
    [token, de, openMachine, reportError],
  );

  const counts = useMemo(() => {
    return {
      total: machines.length,
      available: machines.filter((m) => m.status === "verfuegbar").length,
      out: machines.filter((m) => m.status === "ausgegeben").length,
      overdue: machines.filter((m) => m.is_overdue).length,
      inspection: machines.filter((m) => m.inspection_overdue).length,
    };
  }, [machines]);

  const rows = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return machines.filter((machine) => {
      if (view === "verfuegbar" && machine.status !== "verfuegbar") return false;
      if (view === "ausgegeben" && machine.status !== "ausgegeben") return false;
      if (view === "overdue" && !machine.is_overdue) return false;
      if (view === "inspection" && !machine.inspection_overdue) return false;
      if (!needle) return true;
      // Same fields the server searches, so switching a filter to the server
      // later cannot change which rows match.
      return (
        machine.unit_number.toLowerCase().includes(needle) ||
        (machine.serial_number ?? "").toLowerCase().includes(needle) ||
        (machine.article_name ?? "").toLowerCase().includes(needle) ||
        (machine.manufacturer ?? "").toLowerCase().includes(needle)
      );
    });
  }, [machines, search, view]);

  /**
   * Run a mutation, then refresh both the list and (if open) the detail view.
   *
   * Every write here cascades or changes a derived flag — booking a drill moves
   * its battery, a failed inspection moves the status — so re-reading is the
   * only honest way to show the result. Optimistic patching would have to
   * re-implement the cascade rules in the browser.
   *
   * An action may return the id it wants left on screen. Without that, the
   * refresh below would always re-open whatever was selected when the action
   * started — so creating a standalone machine while a detail view is open
   * would bounce the user straight back to the old machine.
   */
  const runMutation = useCallback(
    async (action: () => Promise<number | void>) => {
      setBusy(true);
      try {
        const requested = await action();
        await loadMachines();
        const target = typeof requested === "number" ? requested : selected?.id;
        if (target != null) await openMachine(target);
      } catch (err: unknown) {
        reportError(err);
      } finally {
        setBusy(false);
      }
    },
    [loadMachines, openMachine, selected, reportError],
  );

  const handleBook = useCallback(
    (payload: MachineBookPayload) => {
      if (!selected) return;
      void runMutation(async () => {
        const changed = await bookMachine(token, selected.id, payload);
        setBookOpen(false);
        setNotice(
          changed.length > 1
            ? de
              ? `${selected.unit_number} ausgegeben — inkl. ${changed.length - 1} Komponente(n)`
              : `${selected.unit_number} checked out — including ${changed.length - 1} component(s)`
            : de
              ? `${selected.unit_number} ausgegeben`
              : `${selected.unit_number} checked out`,
        );
      });
    },
    [selected, token, runMutation, setNotice, de],
  );

  const handleReturn = useCallback(
    (payload: MachineReturnPayload) => {
      if (!selected) return;
      void runMutation(async () => {
        const changed = await returnMachine(token, selected.id, payload);
        setNotice(
          changed.length > 1
            ? de
              ? `${selected.unit_number} zurück — inkl. ${changed.length - 1} Komponente(n)`
              : `${selected.unit_number} returned — including ${changed.length - 1} component(s)`
            : de
              ? `${selected.unit_number} zurückgebucht`
              : `${selected.unit_number} returned`,
        );
      });
    },
    [selected, token, runMutation, setNotice, de],
  );

  const handleInspection = useCallback(
    (payload: MachineInspectionPayload) => {
      if (!selected) return;
      void runMutation(async () => {
        await recordInspection(token, selected.id, payload);
        setNotice(
          payload.passed === false
            ? de
              ? "Prüfung nicht bestanden — Maschine auf „Defekt“ gesetzt"
              : "Inspection failed — machine set to broken"
            : de
              ? "Prüfung eingetragen"
              : "Inspection recorded",
        );
      });
    },
    [selected, token, runMutation, setNotice, de],
  );

  /**
   * Not a mutation: printing changes nothing about the machine, so there is
   * no list refresh — only the shared busy flag so the button cannot
   * double-fire while a job is on the wire.
   */
  const handlePrintLabel = useCallback(() => {
    if (!selected) return;
    void (async () => {
      setBusy(true);
      try {
        await printMachineLabel(token, selected.id);
        setNotice(
          de
            ? `Etikett für ${selected.unit_number} wird gedruckt`
            : `Printing label for ${selected.unit_number}`,
        );
      } catch (err: unknown) {
        reportError(err);
      } finally {
        setBusy(false);
      }
    })();
  }, [selected, token, setNotice, de, reportError]);

  const queueLabel = useCallback(() => {
    if (!selected) return;
    const machine = selected;
    setPrintQueue((queue) => (queue.length >= 40 ? queue : [...queue, machine]));
    setNotice(
      de
        ? `${machine.unit_number} zur Druckliste hinzugefügt`
        : `${machine.unit_number} added to the print queue`,
    );
  }, [selected, setNotice, de]);

  const printQueueNow = useCallback(() => {
    if (printQueue.length === 0) return;
    void (async () => {
      setBusy(true);
      try {
        const result = await printMachineLabels(token, {
          items: printQueue.map((machine) => ({
            unit_id: machine.id,
            format: "klein" as const,
          })),
        });
        setNotice(
          de
            ? `${result.labels} Etikett(en) auf ${result.sheets} Bogen gedruckt — an den Schnittlinien trennen`
            : `${result.labels} label(s) printed on ${result.sheets} sheet(s) — cut along the dashed lines`,
        );
        setPrintQueue([]);
      } catch (err: unknown) {
        reportError(err);
      } finally {
        setBusy(false);
      }
    })();
  }, [printQueue, token, setNotice, de, reportError]);

  const handleCreate = useCallback(
    (payload: MachineCreatePayload, options: { printLabel: boolean }) => {
      void runMutation(async () => {
        const created = await createMachine(token, payload);
        setCreateOpen(false);

        // Printing must never lose the machine. It is already registered by
        // this point, and a printer that is off or unreachable is a normal
        // Tuesday — so a failed print is reported as its own problem rather
        // than surfacing as "creating the machine failed".
        let printed = false;
        let printError: string | null = null;
        if (options.printLabel) {
          try {
            await printMachineLabel(token, created.id);
            printed = true;
          } catch (err: unknown) {
            printError = err instanceof Error ? err.message : String(err);
          }
        }

        if (printError) {
          reportError(
            de
              ? `${created.unit_number} angelegt — Etikett konnte nicht gedruckt werden: ${printError}`
              : `${created.unit_number} created — the label could not be printed: ${printError}`,
          );
        } else {
          setNotice(
            printed
              ? de
                ? `Maschine ${created.unit_number} angelegt · Etikett gedruckt`
                : `Machine ${created.unit_number} created · label printed`
              : de
                ? `Maschine ${created.unit_number} angelegt`
                : `Machine ${created.unit_number} created`,
          );
        }
        // A new component belongs to the machine already on screen, so stay
        // there; a new standalone machine is what the user now wants to look
        // at, so ask the refresh to land on it.
        return payload.parent_unit_id == null ? created.id : undefined;
      });
    },
    [token, runMutation, setNotice, reportError, de],
  );

  const handleEdit = useCallback(
    (patch: MachineUpdatePayload) => {
      if (!selected) return;
      // An empty patch means the user opened the dialog and changed nothing.
      // Sending it would write an audit entry for a non-event.
      if (Object.keys(patch).length === 0) {
        setEditOpen(false);
        return;
      }
      void runMutation(async () => {
        await updateMachine(token, selected.id, patch);
        setEditOpen(false);
        setNotice(
          de ? `${selected.unit_number} gespeichert` : `${selected.unit_number} saved`,
        );
      });
    },
    [selected, token, runMutation, setNotice, de],
  );

  if (!isActiveTab) return null;

  /* Floating in both views: the queue is filled from detail screens but
     printed whenever the batch feels complete — often back on the list. */
  const printQueueBar = printQueue.length > 0 && (
    <div className="werkstatt-print-queue" role="region" aria-label="Druckliste">
      <div className="werkstatt-print-queue-head">
        <b>{de ? "Druckliste" : "Print queue"}</b>
        <span className="werkstatt-print-queue-count">
          {printQueue.length} {de ? "Klein-Etikett(en)" : "small label(s)"} ·{" "}
          {Math.ceil(printQueue.length / 4)} {de ? "Bogen" : "sheet(s)"}
        </span>
      </div>
      <div className="werkstatt-print-queue-chips">
        {printQueue.map((machine, index) => (
          <button
            key={`${machine.id}-${index}`}
            type="button"
            className="werkstatt-print-queue-chip"
            title={de ? "Aus Druckliste entfernen" : "Remove from queue"}
            onClick={() =>
              setPrintQueue((queue) => queue.filter((_, i) => i !== index))
            }
          >
            {machine.unit_number} ×
          </button>
        ))}
      </div>
      <div className="werkstatt-print-queue-actions">
        <button
          type="button"
          className="werkstatt-card-action"
          disabled={busy}
          onClick={() => setPrintQueue([])}
        >
          {de ? "Leeren" : "Clear"}
        </button>
        <button
          type="button"
          className="werkstatt-action-btn werkstatt-action-btn--primary"
          disabled={busy}
          onClick={printQueueNow}
        >
          {de ? "Drucken" : "Print"}
        </button>
      </div>
    </div>
  );

  /* ── Detail view ─────────────────────────────────────────────────────── */

  if (selected) {
    return (
      <>
        <MaschineDetailPanel
          machine={selected}
          history={history}
          language={language}
          users={assignableUsers}
          locations={locations}
          canCreate={canCreate}
          canEdit={canEdit}
          busy={busy}
          onBack={() => {
            setSelected(null);
            setHistory([]);
            void loadMachines();
          }}
          onBook={() => setBookOpen(true)}
          onEdit={() => {
            void loadLocations();
            setEditOpen(true);
          }}
          onAddAnother={() => {
            setCreateParentId(null);
            setCreateBlueprintArticleId(selected.article_id);
            setCreateOpen(true);
          }}
          onReturn={handleReturn}
          onInspect={handleInspection}
          onPrintLabel={handlePrintLabel}
          onQueueLabel={queueLabel}
          onAddComponent={() => {
            setCreateParentId(selected.id);
            setCreateBlueprintArticleId(null);
            setCreateOpen(true);
          }}
          onOpenComponent={(component) => void openMachine(component.id)}
        />

        {printQueueBar}

        <MaschineBuchenModal
          open={bookOpen}
          language={language}
          machine={selected}
          users={assignableUsers}
          locations={locations}
          currentUserId={user?.id ?? null}
          busy={busy}
          onClose={() => setBookOpen(false)}
          onConfirm={handleBook}
        />

        <MaschineBearbeitenModal
          open={editOpen}
          language={language}
          machine={selected}
          parentCandidates={machines}
          locations={locations}
          busy={busy}
          onClose={() => setEditOpen(false)}
          onConfirm={handleEdit}
        />

        <NeueMaschineModal
          open={createOpen}
          language={language}
          token={token}
          parentCandidates={machines}
          blueprintCandidates={blueprintCandidates}
          locations={locations}
          initialParentId={createParentId}
          initialBlueprintArticleId={createBlueprintArticleId}
          busy={busy}
          onClose={() => setCreateOpen(false)}
          onConfirm={handleCreate}
        />
      </>
    );
  }

  /* ── List view ───────────────────────────────────────────────────────── */

  return (
    <section className="werkstatt-tab-page werkstatt-machines-page">
      <header className="werkstatt-sub-head">
        <div className="werkstatt-sub-head-text">
          <span className="werkstatt-sub-breadcrumb">
            {de ? "WERKSTATT › MASCHINEN" : "WORKSHOP › MACHINES"}
          </span>
          <h1 className="werkstatt-sub-title">{de ? "Maschinen" : "Machines"}</h1>
          <p className="werkstatt-sub-subtitle">
            {de
              ? "Jede Maschine einzeln erfasst — mit eigener Nummer, Standort und Prüfzyklus"
              : "Every machine tracked individually — own number, location and inspection cycle"}
          </p>
        </div>
        <div className="werkstatt-sub-actions">
          {/* Available to everyone: scanning is how field staff find a machine,
              and it is read-only until they choose an action. The decoder is
              only downloaded once this is tapped. */}
          <button
            type="button"
            className="werkstatt-action-btn"
            onClick={() => setCameraOpen(true)}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path
                d="M4 8.5h3l1.5-2.5h7L17 8.5h3v10H4v-10Z"
                stroke="currentColor"
                strokeWidth="1.7"
                strokeLinejoin="round"
              />
              <circle cx="12" cy="13" r="3.2" stroke="currentColor" strokeWidth="1.7" />
            </svg>
            {de ? "Scannen" : "Scan"}
          </button>
          {canCreate && (
            <button
              type="button"
              className="werkstatt-action-btn werkstatt-action-btn--primary"
              onClick={() => {
                setCreateParentId(null);
                setCreateBlueprintArticleId(null);
                setCreateOpen(true);
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
              {de ? "Neue Maschine" : "New machine"}
            </button>
          )}
        </div>
      </header>

      <div className="werkstatt-kpi-strip">
        <div className="werkstatt-kpi werkstatt-kpi--neutral">
          <span className="werkstatt-kpi-label">{de ? "ERFASST" : "REGISTERED"}</span>
          <div className="werkstatt-kpi-value-row">
            <span className="werkstatt-kpi-value">{counts.total}</span>
            <span className="werkstatt-kpi-subtitle">{de ? "Maschinen" : "machines"}</span>
          </div>
        </div>
        <div className="werkstatt-kpi werkstatt-kpi--info">
          <span className="werkstatt-kpi-label">{de ? "VERFÜGBAR" : "AVAILABLE"}</span>
          <div className="werkstatt-kpi-value-row">
            <span className="werkstatt-kpi-value">{counts.available}</span>
            <span className="werkstatt-kpi-subtitle">{de ? "im Haus" : "in house"}</span>
          </div>
        </div>
        <div className="werkstatt-kpi werkstatt-kpi--warning">
          <span className="werkstatt-kpi-label">{de ? "UNTERWEGS" : "OUT"}</span>
          <div className="werkstatt-kpi-value-row">
            <span className="werkstatt-kpi-value">{counts.out}</span>
            <span className="werkstatt-kpi-subtitle">
              {counts.overdue > 0
                ? de
                  ? `${counts.overdue} überfällig`
                  : `${counts.overdue} overdue`
                : de
                  ? "alle im Plan"
                  : "all on time"}
            </span>
          </div>
        </div>
        <div className="werkstatt-kpi werkstatt-kpi--danger">
          <span className="werkstatt-kpi-label">{de ? "PRÜFUNG FÄLLIG" : "INSPECTION DUE"}</span>
          <div className="werkstatt-kpi-value-row">
            <span className="werkstatt-kpi-value">{counts.inspection}</span>
            <span className="werkstatt-kpi-subtitle">DGUV3</span>
          </div>
        </div>
      </div>

      <div className="werkstatt-filter-bar">
        <div className="werkstatt-search">
          <SearchIcon />
          <input
            type="text"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={
              de
                ? "Maschinen-Nr., Seriennummer, Name oder Hersteller…"
                : "Machine no., serial, name or manufacturer…"
            }
          />
        </div>
        <div className="werkstatt-segmented werkstatt-segmented--fill" role="tablist">
          {VIEW_DEFS.map((def) => {
            const count =
              def.key === "all"
                ? counts.total
                : def.key === "verfuegbar"
                  ? counts.available
                  : def.key === "ausgegeben"
                    ? counts.out
                    : def.key === "overdue"
                      ? counts.overdue
                      : counts.inspection;
            return (
              <button
                key={def.key}
                type="button"
                role="tab"
                aria-selected={view === def.key}
                className={`werkstatt-segmented-btn${
                  view === def.key ? " werkstatt-segmented-btn--active" : ""
                }`}
                onClick={() => setView(def.key)}
              >
                {(de ? def.de : def.en)} · {count}
              </button>
            );
          })}
        </div>
      </div>

      <div className="werkstatt-table-card">
        <div className="werkstatt-table-head werkstatt-table-head--machines" role="row">
          <span className="werkstatt-col">{de ? "NR." : "NO."}</span>
          <span className="werkstatt-col">{de ? "MASCHINE" : "MACHINE"}</span>
          <span className="werkstatt-col">{de ? "STATUS" : "STATUS"}</span>
          <span className="werkstatt-col">{de ? "BEI" : "WITH"}</span>
          <span className="werkstatt-col">{de ? "ZURÜCK" : "BACK BY"}</span>
          <span className="werkstatt-col">{de ? "PRÜFUNG" : "INSPECTION"}</span>
          <span className="werkstatt-col werkstatt-col-actions" />
        </div>

        <ul className="werkstatt-table-body">
          {rows.map((machine) => (
            <li
              key={machine.id}
              className="werkstatt-row werkstatt-row--machines werkstatt-row--clickable"
              role="row"
              onClick={() => void openMachine(machine.id)}
            >
              <span className="werkstatt-col werkstatt-col-mono werkstatt-machine-number">
                {machine.unit_number}
              </span>
              <span className="werkstatt-col">
                <span className="werkstatt-row-main">
                  <b className="werkstatt-row-name">
                    {machine.article_name ?? (de ? "Unbekannter Artikel" : "Unknown article")}
                  </b>
                  <small className="werkstatt-row-meta">
                    {machine.manufacturer ?? ""}
                    {machine.serial_number
                      ? `${machine.manufacturer ? " · " : ""}SN ${machine.serial_number}`
                      : ""}
                  </small>
                  {/* Rides along with the name so it survives the phone
                      breakpoint, where the "Zurück" and "Prüfung" columns are
                      dropped. Without it an overdue machine looks identical to
                      a healthy one on the screen most likely to be used in the
                      workshop — which defeats the point of tracking DGUV3. */}
                  {(machine.is_overdue || machine.inspection_overdue) && (
                    <span className="werkstatt-machine-row-flags">
                      {machine.is_overdue && (
                        <span className="werkstatt-machine-row-flag">
                          {de ? "überfällig" : "overdue"}
                        </span>
                      )}
                      {machine.inspection_overdue && (
                        <span className="werkstatt-machine-row-flag werkstatt-machine-row-flag--inspection">
                          {de ? "Prüfung fällig" : "inspection due"}
                        </span>
                      )}
                    </span>
                  )}
                </span>
              </span>
              <span className="werkstatt-col">
                <span
                  className={`werkstatt-machine-pill werkstatt-machine-pill--${
                    MACHINE_STATUS_TONES[machine.status]
                  }`}
                >
                  <span className="werkstatt-machine-pill-dot" aria-hidden="true" />
                  {machineStatusLabel(machine.status, language)}
                </span>
              </span>
              <span className="werkstatt-col">{machineWhereabouts(machine, language)}</span>
              <span
                className={`werkstatt-col${
                  machine.is_overdue ? " werkstatt-machine-fact--late" : ""
                }`}
              >
                {machine.status === "ausgegeben"
                  ? machine.booked_until
                    ? (relativeDayLabel(machine.booked_until, language) ??
                      formatMachineDate(machine.booked_until, language))
                    : de
                      ? "offen"
                      : "open"
                  : "—"}
              </span>
              <span
                className={`werkstatt-col${
                  machine.inspection_overdue ? " werkstatt-machine-fact--late" : ""
                }`}
              >
                {machine.inspection_required
                  ? formatMachineDate(machine.next_inspection_due_at, language)
                  : "—"}
              </span>
              <span className="werkstatt-col werkstatt-col-actions" aria-hidden="true">
                ›
              </span>
            </li>
          ))}

          {rows.length === 0 && (
            <li className="werkstatt-row werkstatt-row--empty muted">
              {loading
                ? de
                  ? "Lade Maschinen…"
                  : "Loading machines…"
                : machines.length === 0
                  ? de
                    ? "Noch keine Maschinen erfasst."
                    : "No machines registered yet."
                  : de
                    ? "Keine Maschinen für die aktuelle Auswahl."
                    : "No machines match the current filter."}
            </li>
          )}
        </ul>
      </div>

      <NeueMaschineModal
        open={createOpen}
        language={language}
        token={token}
        parentCandidates={machines}
        blueprintCandidates={blueprintCandidates}
        locations={locations}
        initialParentId={createParentId}
        initialBlueprintArticleId={createBlueprintArticleId}
        busy={busy}
        onClose={() => setCreateOpen(false)}
        onConfirm={handleCreate}
      />

      <CameraScannerSheet
        open={cameraOpen}
        language={language}
        onClose={() => setCameraOpen(false)}
        onScan={handleCameraScan}
      />

      {printQueueBar}
    </section>
  );
}
