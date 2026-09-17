import { useCallback, useEffect, useMemo, useState } from "react";
import { useAppContext } from "../../context/AppContext";
import { BedarfBulkBar } from "../../components/werkstatt/bedarfe/BedarfBulkBar";
import { BedarfOrderModal } from "../../components/werkstatt/bedarfe/BedarfOrderModal";
import { BedarfProjectGroup } from "../../components/werkstatt/bedarfe/BedarfProjectGroup";
import { BedarfToolbar } from "../../components/werkstatt/bedarfe/BedarfToolbar";
import { KatalogZuordnenModal } from "../../components/werkstatt/bedarfe/KatalogZuordnenModal";
import {
  NeuerBedarfModal,
  type NeuerBedarfSubmit,
} from "../../components/werkstatt/bedarfe/NeuerBedarfModal";
import { useBedarfeData } from "../../hooks/useBedarfeData";
import { useBedarfeFilters } from "../../hooks/useBedarfeFilters";
import { useBedarfeSelection } from "../../hooks/useBedarfeSelection";
import { useCollapsedGroups } from "../../hooks/useCollapsedGroups";
import "../../styles/bedarfe.css";
import type { MaterialNeedStatus } from "../../types";
import type {
  MaterialNeedOrderResult,
  MaterialNeedPatch,
  MaterialNeedRow,
} from "../../types/materialNeeds";
import type { WerkstattSupplier } from "../../types/werkstatt";
import { canOrderNeed, needSkipReason } from "../../utils/bedarfeOrdering";
import { needSkipSummary, normalizeMaterialNeedStatus } from "../../utils/materials";
import { formatProjectTitleParts } from "../../utils/projects";
import {
  bulkDeleteNeeds,
  bulkUpdateNeeds,
  createNeed,
  createOrderFromNeeds,
  deleteNeed,
  updateNeed,
} from "../../utils/werkstattBedarfeApi";
import { listSuppliers } from "../../utils/werkstattSuppliersApi";

const COLLAPSED_STORAGE_KEY = "smpl.bedarfe.collapsedProjects";

/**
 * Werkstatt › Projekt-Bedarfe — what is missing, where, and can it be bought.
 *
 * The screen this replaces was one flat list with a cycling status pill: no
 * filters, no search, no multi-select, no way to correct a quantity, and no
 * route from "we need this" to an actual order. Working through ten sites of
 * eight items meant eighty individual clicks, and every one of those items
 * was then retyped into the wholesaler's basket by hand.
 *
 * So the page owns its data (server-side filters), groups by building site,
 * edits in place, and hands a selection to `POST /werkstatt/bedarfe/
 * create-order`, which drafts one order per supplier.
 */
export function WerkstattBedarfePage() {
  const {
    mainView,
    language,
    werkstattTab,
    token,
    user,
    activeProjects,
    setActiveProjectId,
    setProjectTab,
    setProjectBackView,
    setMainView,
    setWerkstattTab,
    setNotice,
    setError,
  } = useAppContext();

  const de = language === "de";
  const active = mainView === "werkstatt" && werkstattTab === "bedarfe";

  const filterState = useBedarfeFilters();
  const groupFolding = useCollapsedGroups(COLLAPSED_STORAGE_KEY);
  const [suppliers, setSuppliers] = useState<WerkstattSupplier[]>([]);
  const [busyIds, setBusyIds] = useState<ReadonlySet<number>>(() => new Set<number>());
  const [bulkBusy, setBulkBusy] = useState(false);

  const [orderModalOpen, setOrderModalOpen] = useState(false);
  const [orderResult, setOrderResult] = useState<MaterialNeedOrderResult | null>(null);
  // The rows the confirmation was built from. The result panel names the
  // skipped ones, and by the time it renders the selection is already cleared
  // (and the list reloaded) — without this snapshot it could only print ids,
  // which is exactly the row the buyer has to go and do something about.
  const [confirmedRows, setConfirmedRows] = useState<readonly MaterialNeedRow[]>([]);
  const [orderError, setOrderError] = useState<string | null>(null);
  const [newOpen, setNewOpen] = useState(false);
  const [newError, setNewError] = useState<string | null>(null);
  const [newBusy, setNewBusy] = useState(false);
  const [linkRow, setLinkRow] = useState<MaterialNeedRow | null>(null);

  const { rows, loading, error, reload, applyRow, applyRows, removeRows } = useBedarfeData(
    token,
    active,
    filterState.filters,
  );
  const selection = useBedarfeSelection();

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    void listSuppliers(token)
      .then((found) => {
        if (!cancelled) setSuppliers(found);
      })
      .catch(() => {
        // The filter simply stays on "alle" — not worth interrupting the page.
        if (!cancelled) setSuppliers([]);
      });
    return () => {
      cancelled = true;
    };
  }, [active, token]);

  // A selection may not outlive the rows it names: filters change, another
  // person deletes a row, a reload drops it.
  useEffect(() => {
    selection.retain(rows.map((row) => row.id));
  }, [rows, selection]);

  const groups = useMemo(() => {
    const byProject = new Map<
      number,
      { projectId: number; projectNumber: string; projectTitle: string; rows: MaterialNeedRow[] }
    >();
    for (const row of rows) {
      const existing = byProject.get(row.project_id);
      if (existing) {
        existing.rows = [...existing.rows, row];
        continue;
      }
      const parts = formatProjectTitleParts(
        row.project_number,
        row.customer_name ?? null,
        row.project_name,
        row.project_id,
      );
      byProject.set(row.project_id, {
        projectId: row.project_id,
        projectNumber: row.project_number,
        projectTitle: parts.subtitle ?? parts.title,
        rows: [row],
      });
    }
    return Array.from(byProject.values()).sort((a, b) =>
      a.projectNumber.localeCompare(b.projectNumber, undefined, { numeric: true }),
    );
  }, [rows]);

  const counts = useMemo(() => {
    let open = 0;
    let orderable = 0;
    let ordered = 0;
    for (const row of rows) {
      const status = normalizeMaterialNeedStatus(row.status);
      if (status === "order") open += 1;
      if (status === "ordered") ordered += 1;
      if (row.orderable && status === "order") orderable += 1;
    }
    return { open, orderable, ordered };
  }, [rows]);

  const selectedRows = useMemo(
    () => rows.filter((row) => selection.selected.has(row.id)),
    [rows, selection.selected],
  );
  // Exactly what the confirmation modal will list, so the count on the button
  // and the positions in the dialog can never disagree.
  const orderableSelected = selectedRows.filter(canOrderNeed).length;
  // Why the rest would not go: the bulk bar says so per reason rather than
  // blaming "ohne Katalog-Artikel" for a row that is simply already ordered.
  const selectedSkipReasons = useMemo(
    () =>
      selectedRows
        .map(needSkipReason)
        .filter((reason): reason is NonNullable<typeof reason> => reason !== null),
    [selectedRows],
  );
  const canCreateOrder = (user?.effective_permissions ?? []).includes("werkstatt:manage");

  const markBusy = useCallback((id: number, busy: boolean) => {
    setBusyIds((current) => {
      const next = new Set(current);
      if (busy) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  const failed = useCallback(
    (err: unknown, fallback: string) => {
      setError(err instanceof Error && err.message ? err.message : fallback);
    },
    [setError],
  );

  const patchRow = useCallback(
    async (id: number, patch: MaterialNeedPatch) => {
      markBusy(id, true);
      try {
        applyRow(await updateNeed(token, id, patch));
      } catch (err) {
        failed(err, de ? "Bedarf konnte nicht gespeichert werden." : "Could not save the need.");
        reload();
      } finally {
        markBusy(id, false);
      }
    },
    [applyRow, de, failed, markBusy, reload, token],
  );

  const removeRow = useCallback(
    async (row: MaterialNeedRow) => {
      const confirmed = window.confirm(
        de ? `„${row.item}" löschen?` : `Delete "${row.item}"?`,
      );
      if (!confirmed) return;
      markBusy(row.id, true);
      try {
        await deleteNeed(token, row.id);
        removeRows([row.id]);
        setNotice(de ? "Bedarf gelöscht" : "Need deleted");
      } catch (err) {
        failed(err, de ? "Bedarf konnte nicht gelöscht werden." : "Could not delete the need.");
      } finally {
        markBusy(row.id, false);
      }
    },
    [de, failed, markBusy, removeRows, setNotice, token],
  );

  async function runBulkStatus(status: MaterialNeedStatus) {
    const ids = selectedRows.map((row) => row.id);
    if (ids.length === 0) return;
    setBulkBusy(true);
    try {
      const updated = await bulkUpdateNeeds(token, ids, { status });
      applyRows(updated);
      setNotice(
        de ? `${updated.length} Bedarfe aktualisiert` : `${updated.length} needs updated`,
      );
      // A status the current filter excludes must not leave ghosts behind.
      reload();
    } catch (err) {
      failed(err, de ? "Massenänderung fehlgeschlagen." : "The bulk change failed.");
    } finally {
      setBulkBusy(false);
    }
  }

  async function runBulkDelete() {
    const ids = selectedRows.map((row) => row.id);
    if (ids.length === 0) return;
    const confirmed = window.confirm(
      de ? `${ids.length} Bedarfe löschen?` : `Delete ${ids.length} needs?`,
    );
    if (!confirmed) return;
    setBulkBusy(true);
    try {
      const { deleted } = await bulkDeleteNeeds(token, ids);
      removeRows(ids);
      selection.clear();
      setNotice(de ? `${deleted} Bedarfe gelöscht` : `${deleted} needs deleted`);
    } catch (err) {
      failed(err, de ? "Löschen fehlgeschlagen." : "Deleting failed.");
    } finally {
      setBulkBusy(false);
    }
  }

  async function confirmOrder(input: {
    supplierId: number | null;
    orderId: number | null;
    title: string | null;
  }) {
    setBulkBusy(true);
    setOrderError(null);
    const rowsInFlight = selectedRows;
    try {
      const result = await createOrderFromNeeds(token, {
        need_ids: rowsInFlight.map((row) => row.id),
        supplier_id: input.supplierId,
        order_id: input.orderId,
        title: input.title,
      });
      setConfirmedRows(rowsInFlight);
      setOrderResult(result);
      selection.clear();
      reload();
      if (result.orders.length === 0) {
        // Nothing was bought. The server skips rows the browser cannot see
        // ahead (an archived supplier, a second person who ordered the same
        // selection seconds earlier), and a green "… erstellt (0 Positionen)"
        // with a blank order number is how that goes unnoticed.
        const why = needSkipSummary(
          result.skipped.map((entry) => entry.reason),
          language,
        );
        const count = result.skipped.length;
        setError(
          de
            ? `Keine Bestellung erstellt – ${count === 1 ? "die Zeile wurde" : `alle ${count} Zeilen wurden`} übersprungen${why ? ` (${why})` : ""}`
            : `No order created – ${count === 1 ? "the row was" : `all ${count} rows were`} skipped${why ? ` (${why})` : ""}`,
        );
      } else {
        setNotice(
          de
            ? `${result.orders.map((order) => order.order_number).join(", ")} erstellt (${result.added.length} Positionen)`
            : `${result.orders.map((order) => order.order_number).join(", ")} created (${result.added.length} lines)`,
        );
      }
    } catch (err) {
      setOrderError(
        err instanceof Error && err.message
          ? err.message
          : de
            ? "Bestellung konnte nicht erstellt werden."
            : "The order could not be created.",
      );
    } finally {
      setBulkBusy(false);
    }
  }

  async function submitNewNeed(input: NeuerBedarfSubmit) {
    setNewBusy(true);
    setNewError(null);
    try {
      await createNeed(token, input);
      setNewOpen(false);
      reload();
      setNotice(de ? "Bedarf angelegt" : "Need created");
    } catch (err) {
      setNewError(
        err instanceof Error && err.message
          ? err.message
          : de
            ? "Bedarf konnte nicht angelegt werden."
            : "The need could not be created.",
      );
    } finally {
      setNewBusy(false);
    }
  }

  function openProject(id: number) {
    setActiveProjectId(id);
    setProjectTab("overview");
    setProjectBackView(null);
    setMainView("project");
  }

  const allCollapsed =
    groups.length > 0 && groups.every((group) => groupFolding.isCollapsed(group.projectId));

  if (!active) return null;

  return (
    <section className="werkstatt-tab-page bedarfe-page">
      <header className="werkstatt-sub-head">
        <div className="werkstatt-sub-head-text">
          <span className="werkstatt-sub-breadcrumb">
            {de ? "WERKSTATT › PROJEKT-BEDARFE" : "WORKSHOP › PROJECT NEEDS"}
          </span>
          <h1 className="werkstatt-sub-title">{de ? "Materialbedarf" : "Material needs"}</h1>
          <p className="werkstatt-sub-subtitle">
            {de
              ? `${counts.open} offen · ${counts.orderable} bestellbar · ${counts.ordered} bestellt`
              : `${counts.open} open · ${counts.orderable} orderable · ${counts.ordered} ordered`}
          </p>
        </div>
        <div className="werkstatt-sub-actions">
          <button
            type="button"
            className="werkstatt-action-btn werkstatt-action-btn--primary"
            onClick={() => {
              setNewError(null);
              setNewOpen(true);
            }}
          >
            {de ? "+ Bedarf" : "+ Need"}
          </button>
          <button type="button" className="werkstatt-action-btn" onClick={reload}>
            {de ? "Aktualisieren" : "Refresh"}
          </button>
          <button
            type="button"
            className="werkstatt-action-btn"
            onClick={() =>
              groupFolding.setAll(
                groups.map((group) => group.projectId),
                !allCollapsed,
              )
            }
          >
            {allCollapsed
              ? de
                ? "Alle ausklappen"
                : "Expand all"
              : de
                ? "Alle einklappen"
                : "Collapse all"}
          </button>
        </div>
      </header>

      <BedarfToolbar
        language={language}
        query={filterState.queryInput}
        onQueryChange={filterState.setQueryInput}
        statuses={filterState.statuses}
        onToggleStatus={filterState.toggleStatus}
        includeCompleted={filterState.includeCompleted}
        onToggleIncludeCompleted={filterState.setIncludeCompleted}
        orderableOnly={filterState.orderableOnly}
        onToggleOrderableOnly={filterState.setOrderableOnly}
        projectId={filterState.projectId}
        onProjectChange={filterState.setProjectId}
        projects={activeProjects}
        supplierId={filterState.supplierId}
        onSupplierChange={filterState.setSupplierId}
        suppliers={suppliers}
        onResetFilters={filterState.reset}
        hasActiveFilters={filterState.hasActiveFilters}
      />

      <div className="werkstatt-card bedarfe-list">
        {error && <p className="bedarfe-hint bedarfe-hint--warn">{error}</p>}
        {loading && rows.length === 0 && (
          <p className="bedarfe-empty muted">{de ? "Lädt…" : "Loading…"}</p>
        )}
        {!loading && groups.length === 0 && (
          <p className="bedarfe-empty muted">
            {filterState.hasActiveFilters
              ? de
                ? "Keine Bedarfe passen zu den Filtern."
                : "No needs match the filters."
              : de
                ? "Kein offener Materialbedarf gefunden."
                : "No open material needs found."}
          </p>
        )}
        {groups.map((group) => (
          <BedarfProjectGroup
            key={`bedarfe-group-${group.projectId}`}
            projectId={group.projectId}
            projectNumber={group.projectNumber}
            projectTitle={group.projectTitle}
            rows={group.rows}
            language={language}
            collapsed={groupFolding.isCollapsed(group.projectId)}
            onToggleCollapsed={groupFolding.toggle}
            onOpenProject={openProject}
            selected={selection.selected}
            busyIds={busyIds}
            onToggleSelect={selection.toggle}
            onSetGroupSelected={selection.setGroup}
            onPatch={(id, patch) => void patchRow(id, patch)}
            onDelete={(row) => void removeRow(row)}
            onLinkCatalog={setLinkRow}
            onOpenOrder={() => setWerkstattTab("orders")}
          />
        ))}
      </div>

      <BedarfBulkBar
        language={language}
        count={selection.count}
        orderableCount={orderableSelected}
        skipReasons={selectedSkipReasons}
        canCreateOrder={canCreateOrder}
        busy={bulkBusy}
        onSetStatus={(status) => void runBulkStatus(status)}
        onCreateOrder={() => {
          setOrderResult(null);
          setConfirmedRows([]);
          setOrderError(null);
          setOrderModalOpen(true);
        }}
        onDelete={() => void runBulkDelete()}
        onClear={selection.clear}
      />

      <BedarfOrderModal
        open={orderModalOpen}
        language={language}
        token={token}
        rows={orderResult ? confirmedRows : selectedRows}
        busy={bulkBusy}
        result={orderResult}
        error={orderError}
        onConfirm={(input) => void confirmOrder(input)}
        onClose={() => {
          setOrderModalOpen(false);
          setOrderResult(null);
          setConfirmedRows([]);
          setOrderError(null);
        }}
        onOpenOrders={() => {
          setOrderModalOpen(false);
          setOrderResult(null);
          setWerkstattTab("orders");
        }}
      />

      <NeuerBedarfModal
        open={newOpen}
        language={language}
        token={token}
        projects={activeProjects}
        defaultProjectId={filterState.projectId}
        busy={newBusy}
        error={newError}
        onSubmit={(input) => void submitNewNeed(input)}
        onClose={() => setNewOpen(false)}
      />

      <KatalogZuordnenModal
        row={linkRow}
        language={language}
        token={token}
        busy={linkRow != null && busyIds.has(linkRow.id)}
        onPick={(row, item) => {
          setLinkRow(null);
          void patchRow(row.id, { material_catalog_item_id: item.id });
        }}
        onUnlink={(row) => {
          setLinkRow(null);
          void patchRow(row.id, { material_catalog_item_id: null });
        }}
        onClose={() => setLinkRow(null)}
      />
    </section>
  );
}
