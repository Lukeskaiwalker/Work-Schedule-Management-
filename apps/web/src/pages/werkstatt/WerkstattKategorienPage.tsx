import { useCallback, useEffect, useMemo, useState } from "react";
import { useAppContext } from "../../context/AppContext";
import {
  CategoryFormModal,
  type CategoryFormPayload,
} from "../../components/werkstatt/CategoryFormModal";
import {
  LocationFormModal,
  type LocationFormPayload,
  type LocationKind,
  type LocationStatus,
  defaultStatusForKind,
  statusLabel,
  validStatusesForKind,
} from "../../components/werkstatt/LocationFormModal";
import { KebabMenu, type KebabMenuItem } from "../../components/werkstatt/KebabMenu";
import type { WerkstattCategory, WerkstattLocation } from "../../types/werkstatt";
import {
  archiveCategory as apiArchiveCategory,
  archiveLocation as apiArchiveLocation,
  createCategory,
  createLocation,
  listCategories,
  listLocations,
  unarchiveCategory,
  unarchiveLocation,
  updateCategory,
  updateLocation,
} from "../../utils/werkstattTaxonomyApi";

/**
 * WerkstattKategorienPage — Kategorien & Lagerorte. Ported from Paper 9EE-0.
 * Two columns: category tree (left) + physical location tree (right). Each
 * node is expandable; nodes with children render a chevron + sub-list.
 *
 * This screen was mock-backed for its whole life: it rendered a fixed set of
 * invented halls and categories and every mutation lived in local state. That
 * became actively misleading once machines started carrying a real
 * `current_location_id` — a drill would show "Werkstatt Regal A" while this
 * page, the place you go to manage storage, listed something else entirely and
 * offered no way to create the one you actually wanted.
 *
 * It now reads and writes the real endpoints. Two shape differences are worth
 * knowing about:
 *
 *   * The API is FLAT (`parent_id`), this UI is a TREE (halls own `shelves`,
 *     categories own `subcategories`). `buildCategoryTree` / `buildLocationTree`
 *     do that fold in one place.
 *   * Ids are numeric server-side and strings in the row components and modals.
 *     They are stringified at the boundary rather than churning every child
 *     component, and parsed back with `numericId` on the way out.
 */

/* ── View models: the tree shape the rows and modals expect ────────────── */

interface Category {
  id: string;
  name: string;
  article_count: number;
  subcategory_count: number;
  subcategories: ReadonlyArray<{ id: string; name: string; article_count: number }>;
  expanded: boolean;
  parent_id: string | null;
  notes: string;
  is_archived: boolean;
}

interface Location {
  id: string;
  name: string;
  sub: string;
  kind: LocationKind;
  icon: "hall" | "vehicle";
  article_count: number;
  status: LocationStatus;
  shelves: ReadonlyArray<{ id: string; name: string; article_count: number }>;
  expanded: boolean;
  parent_id: string | null;
  address: string;
  notes: string;
  is_archived: boolean;
}

/** String id (UI) → numeric id (API). */
function numericId(id: string): number {
  return Number(id);
}

function groupByParent<T extends { parent_id: number | null }>(rows: T[]): Map<number, T[]> {
  const byParent = new Map<number, T[]>();
  for (const row of rows) {
    if (row.parent_id === null) continue;
    const bucket = byParent.get(row.parent_id);
    if (bucket) bucket.push(row);
    else byParent.set(row.parent_id, [row]);
  }
  return byParent;
}

/**
 * Fold the flat category list into the two-level tree the UI draws.
 *
 * Archived rows are kept in the returned array (the Archive strip below the
 * tree needs them) but never appear as somebody's child — an archived
 * subcategory hanging under a live parent would look active.
 */
function buildCategoryTree(rows: WerkstattCategory[]): Category[] {
  const children = groupByParent(rows.filter((row) => !row.is_archived));
  return rows
    .filter((row) => row.parent_id === null || row.is_archived)
    .map((row) => {
      const subs = children.get(row.id) ?? [];
      return {
        id: String(row.id),
        name: row.name,
        article_count: row.article_count,
        subcategory_count: subs.length,
        subcategories: subs.map((sub) => ({
          id: String(sub.id),
          name: sub.name,
          article_count: sub.article_count,
        })),
        expanded: false,
        parent_id: row.parent_id === null ? null : String(row.parent_id),
        notes: row.notes ?? "",
        is_archived: row.is_archived,
      };
    });
}

/** Same fold for locations. A hall's children are its shelves. */
function buildLocationTree(rows: WerkstattLocation[]): Location[] {
  const children = groupByParent(rows.filter((row) => !row.is_archived));
  const byId = new Map(rows.map((row) => [row.id, row]));

  return rows
    .filter((row) => row.location_type !== "shelf" || row.is_archived)
    .map((row) => {
      const shelves = children.get(row.id) ?? [];
      const parent = row.parent_id === null ? null : byId.get(row.parent_id);
      return {
        id: String(row.id),
        name: row.name,
        // The secondary line: where a shelf lives, or the street address of a
        // hall / site / van.
        sub:
          row.location_type === "shelf"
            ? parent
              ? `In ${parent.name}`
              : ""
            : row.address ?? "",
        kind: row.location_type,
        icon: row.location_type === "vehicle" ? "vehicle" : "hall",
        article_count: row.article_count,
        status: row.status ?? defaultStatusForKind(row.location_type),
        shelves: shelves.map((shelf) => ({
          id: String(shelf.id),
          name: shelf.name,
          article_count: shelf.article_count,
        })),
        expanded: false,
        parent_id: row.parent_id === null ? null : String(row.parent_id),
        address: row.address ?? "",
        notes: row.notes ?? "",
        is_archived: row.is_archived,
      };
    });
}

/* ── Page ────────────────────────────────────────────────────────────── */

export function WerkstattKategorienPage() {
  const { mainView, language, werkstattTab, token, setNotice, setError, setWerkstattTab } =
    useAppContext();

  const [categoryRows, setCategoryRows] = useState<WerkstattCategory[]>([]);
  const [locationRows, setLocationRows] = useState<WerkstattLocation[]>([]);
  const [showArchivedCats, setShowArchivedCats] = useState(false);
  const [showArchivedLocs, setShowArchivedLocs] = useState(false);

  // Archived rows are fetched alongside the live ones so the Archive strip can
  // render (and restore) without a second round trip on every toggle.
  const categories = useMemo(() => buildCategoryTree(categoryRows), [categoryRows]);
  const locations = useMemo(() => buildLocationTree(locationRows), [locationRows]);

  const [expandedCats, setExpandedCats] = useState<ReadonlySet<string>>(new Set());
  const [expandedLocs, setExpandedLocs] = useState<ReadonlySet<string>>(new Set());

  const isActiveTab = mainView === "werkstatt" && werkstattTab === "kategorien";

  const reportError = useCallback(
    (err: unknown) => setError(err instanceof Error ? err.message : String(err)),
    [setError],
  );

  const reload = useCallback(async () => {
    try {
      const [cats, locs] = await Promise.all([
        listCategories(token, true),
        listLocations(token, true),
      ]);
      setCategoryRows(cats);
      setLocationRows(locs);
    } catch (err: unknown) {
      reportError(err);
    }
  }, [token, reportError]);

  useEffect(() => {
    if (!isActiveTab) return;
    void reload();
  }, [isActiveTab, reload]);

  /**
   * Run a mutation, then re-read. Both trees are derived from server state
   * (article counts, shelf membership, sort order), so patching locally would
   * mean re-deriving all of it in the browser and getting it subtly wrong.
   */
  const mutate = useCallback(
    async (action: () => Promise<void>) => {
      try {
        await action();
        await reload();
      } catch (err: unknown) {
        reportError(err);
      }
    },
    [reload, reportError],
  );

  // Modal state.
  const [categoryModal, setCategoryModal] = useState<
    | { mode: "create" }
    | { mode: "edit"; categoryId: string }
    | null
  >(null);
  const [locationModal, setLocationModal] = useState<
    | { mode: "create" }
    | { mode: "edit"; locationId: string }
    | null
  >(null);

  const de = language === "de";

  const visibleCategories = useMemo(
    () => categories.filter((c) => !c.is_archived),
    [categories],
  );
  const archivedCategories = useMemo(
    () => categories.filter((c) => c.is_archived),
    [categories],
  );
  const visibleLocations = useMemo(
    () => locations.filter((l) => !l.is_archived),
    [locations],
  );
  const archivedLocations = useMemo(
    () => locations.filter((l) => l.is_archived),
    [locations],
  );

  const hallOptions = useMemo(
    () =>
      visibleLocations
        .filter((l) => l.kind === "hall")
        .map((l) => ({ id: l.id, name: l.name })),
    [visibleLocations],
  );

  const topLevelCategoryOptions = useMemo(
    () =>
      visibleCategories
        .filter((c) => c.parent_id === null)
        .map((c) => ({ id: c.id, name: c.name })),
    [visibleCategories],
  );

  if (!isActiveTab) return null;

  /* ── Handlers ──────────────────────────────────────────────────── */

  function toggleCat(id: string) {
    setExpandedCats((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleLoc(id: string) {
    setExpandedLocs((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function saveCategory(payload: CategoryFormPayload) {
    const parentId = payload.parent_id === null ? null : numericId(payload.parent_id);
    void mutate(async () => {
      if (payload.id === null) {
        await createCategory(token, {
          name: payload.name,
          parent_id: parentId,
          notes: payload.notes || null,
        });
        setNotice(de ? `Kategorie „${payload.name}“ angelegt` : `Category "${payload.name}" created`);
      } else {
        await updateCategory(token, numericId(payload.id), {
          name: payload.name,
          parent_id: parentId,
          notes: payload.notes || null,
        });
        setNotice(
          de ? `Kategorie „${payload.name}“ aktualisiert` : `Category "${payload.name}" updated`,
        );
      }
      setCategoryModal(null);
    });
  }

  function archiveCategory(id: string) {
    const cat = categories.find((c) => c.id === id);
    if (!cat) return;
    if (!window.confirm(
      de
        ? `Kategorie "${cat.name}" archivieren? Zugeordnete Artikel bleiben erhalten.`
        : `Archive category "${cat.name}"? Linked items stay.`,
    )) return;
    void mutate(async () => {
      await apiArchiveCategory(token, numericId(id));
      setShowArchivedCats(true); // make sure user sees where it went
      setNotice(
        de
          ? `Kategorie "${cat.name}" archiviert — unten im Archiv sichtbar`
          : `Category "${cat.name}" archived — visible in Archive below`,
      );
      setCategoryModal(null);
    });
  }

  function restoreCategory(id: string) {
    const cat = categories.find((c) => c.id === id);
    if (!cat) return;
    void mutate(async () => {
      await unarchiveCategory(token, numericId(id));
      setNotice(
        de ? `Kategorie "${cat.name}" wiederhergestellt` : `Category "${cat.name}" restored`,
      );
    });
  }

  function duplicateCategory(id: string) {
    const cat = categories.find((c) => c.id === id);
    if (!cat) return;
    const name = `${cat.name} ${de ? "(Kopie)" : "(copy)"}`;
    void mutate(async () => {
      // Copies the definition, never the contents: article counts belong to the
      // articles, and a duplicate that claimed them would double the inventory.
      await createCategory(token, {
        name,
        parent_id: cat.parent_id === null ? null : numericId(cat.parent_id),
        notes: cat.notes || null,
      });
      setNotice(
        de
          ? `Kategorie "${cat.name}" dupliziert als "${name}"`
          : `Duplicated "${cat.name}" → "${name}"`,
      );
    });
  }

  function showCategoryItems(cat: Category) {
    // Jump to the Inventar tab. The FE-side category filter isn't wired to
    // read a pre-selected category yet; flag it in the notice so the user
    // knows what to do until the wiring lands.
    setWerkstattTab("inventar");
    setNotice(
      de
        ? `Inventar geöffnet — filtere nach "${cat.name}" (Kategorie-Filter folgt)`
        : `Inventory opened — filter by "${cat.name}" (category filter pending)`,
    );
    // TODO(werkstatt): pass ?category_id=<id> into the inventar filter state
  }

  function saveLocation(payload: LocationFormPayload) {
    const parentId = payload.parent_id === null ? null : numericId(payload.parent_id);
    // A shelf has no status of its own — it is open exactly when its hall is.
    const status = payload.kind === "shelf" ? null : payload.status;

    void mutate(async () => {
      if (payload.id === null) {
        await createLocation(token, {
          name: payload.name,
          location_type: payload.kind,
          parent_id: parentId,
          address: payload.address || null,
          status,
          notes: payload.notes || null,
        });
        // Auto-expand the hall so a new shelf is visible where it landed
        // instead of hidden inside a collapsed parent.
        if (payload.kind === "shelf" && payload.parent_id !== null) {
          const parent = payload.parent_id;
          setExpandedLocs((prev) => new Set(prev).add(parent));
        }
        setNotice(
          de ? `Lagerort „${payload.name}“ angelegt` : `Location "${payload.name}" created`,
        );
      } else {
        await updateLocation(token, numericId(payload.id), {
          name: payload.name,
          location_type: payload.kind,
          parent_id: parentId,
          address: payload.address || null,
          status,
          notes: payload.notes || null,
        });
        setNotice(
          de ? `Lagerort „${payload.name}“ aktualisiert` : `Location "${payload.name}" updated`,
        );
      }
      setLocationModal(null);
    });
  }

  /** Click the pill on a row → cycle to the next valid status for the kind.
   *  Useful for the vehicle ↔ workshop toggle that drivers do all day. */
  function cycleLocationStatus(id: string) {
    const loc = locations.find((l) => l.id === id);
    if (!loc) return;
    const options = validStatusesForKind(loc.kind);
    if (options.length < 2) return;
    const next = options[(options.indexOf(loc.status) + 1) % options.length];
    void mutate(async () => {
      await updateLocation(token, numericId(id), { status: next });
      setNotice(
        de
          ? `Status von "${loc.name}" → ${statusLabel(next, true)}`
          : `Status of "${loc.name}" → ${statusLabel(next, false)}`,
      );
    });
  }

  function archiveLocation(id: string) {
    const loc = locations.find((l) => l.id === id);
    if (!loc) return;
    if (!window.confirm(
      de
        ? `Lagerort "${loc.name}" archivieren? Artikel bleiben sichtbar, aber ohne Lagerzuordnung.`
        : `Archive location "${loc.name}"? Items stay visible but lose their storage assignment.`,
    )) return;
    void mutate(async () => {
      await apiArchiveLocation(token, numericId(id));
      setShowArchivedLocs(true);
      setNotice(
        de
          ? `Lagerort "${loc.name}" archiviert — unten im Archiv sichtbar`
          : `Location "${loc.name}" archived — visible in Archive below`,
      );
      setLocationModal(null);
    });
  }

  function restoreLocation(id: string) {
    const loc = locations.find((l) => l.id === id);
    if (!loc) return;
    void mutate(async () => {
      await unarchiveLocation(token, numericId(id));
      setNotice(
        de ? `Lagerort "${loc.name}" wiederhergestellt` : `Location "${loc.name}" restored`,
      );
    });
  }

  function duplicateLocation(id: string) {
    const loc = locations.find((l) => l.id === id);
    if (!loc) return;
    const name = `${loc.name} ${de ? "(Kopie)" : "(copy)"}`;
    void mutate(async () => {
      // The place, not its contents or its shelves — those are their own rows.
      await createLocation(token, {
        name,
        location_type: loc.kind,
        parent_id: loc.parent_id === null ? null : numericId(loc.parent_id),
        address: loc.address || null,
        status: loc.kind === "shelf" ? null : loc.status,
        notes: loc.notes || null,
      });
      setNotice(
        de
          ? `Lagerort "${loc.name}" dupliziert als "${name}"`
          : `Duplicated "${loc.name}" → "${name}"`,
      );
    });
  }

  function showLocationItems(loc: Location) {
    setWerkstattTab("inventar");
    setNotice(
      de
        ? `Inventar geöffnet — filtere nach "${loc.name}" (Lagerort-Filter folgt)`
        : `Inventory opened — filter by "${loc.name}" (location filter pending)`,
    );
    // TODO(werkstatt): pass ?location_id=<id> into the inventar filter state
  }

  /* ── Modal payload builders (form initial values) ──────────────── */

  const categoryInitial: CategoryFormPayload = (() => {
    if (!categoryModal) return { id: null, name: "", parent_id: null, notes: "" };
    if (categoryModal.mode === "create") {
      return { id: null, name: "", parent_id: null, notes: "" };
    }
    const cat = categories.find((c) => c.id === categoryModal.categoryId);
    if (!cat) return { id: null, name: "", parent_id: null, notes: "" };
    return {
      id: cat.id,
      name: cat.name,
      parent_id: cat.parent_id,
      notes: cat.notes,
    };
  })();

  const locationInitial: LocationFormPayload = (() => {
    const blank: LocationFormPayload = {
      id: null,
      name: "",
      kind: "hall",
      status: defaultStatusForKind("hall"),
      parent_id: null,
      address: "",
      notes: "",
    };
    if (!locationModal) return blank;
    if (locationModal.mode === "create") return blank;
    const loc = locations.find((l) => l.id === locationModal.locationId);
    if (!loc) return blank;
    return {
      id: loc.id,
      name: loc.name,
      kind: loc.kind,
      status: loc.status,
      parent_id: loc.parent_id,
      address: loc.address,
      notes: loc.notes,
    };
  })();

  /* ── Render ────────────────────────────────────────────────────── */

  const categoryHeadline = de
    ? `${visibleCategories.length} Kategorien · ${visibleCategories.reduce((sum, c) => sum + c.subcategory_count, 0)} Unterkategorien`
    : `${visibleCategories.length} categories · ${visibleCategories.reduce((sum, c) => sum + c.subcategory_count, 0)} subcategories`;

  const hallCount = visibleLocations.filter((l) => l.kind === "hall").length;
  const vehicleCount = visibleLocations.filter((l) => l.kind === "vehicle").length;
  const shelfCount = visibleLocations.reduce((sum, l) => sum + l.shelves.length, 0);
  const locationHeadline = de
    ? `${hallCount} Hallen · ${shelfCount} Regale · ${vehicleCount} Fahrzeuge`
    : `${hallCount} halls · ${shelfCount} shelves · ${vehicleCount} vehicles`;

  return (
    <section className="werkstatt-tab-page">
      <header className="werkstatt-sub-head">
        <div className="werkstatt-sub-head-text">
          <span className="werkstatt-sub-breadcrumb">
            {de ? "WERKSTATT › TAXONOMIE" : "WORKSHOP › TAXONOMY"}
          </span>
          <h1 className="werkstatt-sub-title">
            {de ? "Kategorien & Lagerorte" : "Categories & locations"}
          </h1>
          <p className="werkstatt-sub-subtitle">
            {de
              ? "Strukturiere deine Werkstatt: Kategorien ordnen Artikel, Lagerorte zeigen wo sie zu finden sind."
              : "Structure your workshop: categories organise items, locations show where to find them."}
          </p>
        </div>
      </header>

      <div className="werkstatt-two-col">
        <section className="werkstatt-card werkstatt-tree-card">
          <header className="werkstatt-card-head">
            <div className="werkstatt-card-title-block">
              <h3 className="werkstatt-card-title">{de ? "Kategorien" : "Categories"}</h3>
              <span className="werkstatt-card-subtitle">{categoryHeadline}</span>
            </div>
            <button
              type="button"
              className="werkstatt-action-btn"
              onClick={() => setCategoryModal({ mode: "create" })}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
              {de ? "Neue Kategorie" : "New category"}
            </button>
          </header>

          <ul className="werkstatt-tree">
            {visibleCategories.map((cat) => (
              <CategoryRow
                key={cat.id}
                cat={cat}
                expanded={expandedCats.has(cat.id)}
                onToggle={() => toggleCat(cat.id)}
                menuItems={buildCategoryMenu(cat, de, {
                  edit: () => setCategoryModal({ mode: "edit", categoryId: cat.id }),
                  duplicate: () => duplicateCategory(cat.id),
                  showItems: () => showCategoryItems(cat),
                  archive: () => archiveCategory(cat.id),
                })}
                onEdit={() => setCategoryModal({ mode: "edit", categoryId: cat.id })}
                de={de}
              />
            ))}
            {visibleCategories.length === 0 && (
              <li className="werkstatt-tree-empty muted">
                {de ? "Noch keine Kategorien. Lege die erste an." : "No categories yet. Create the first one."}
              </li>
            )}
          </ul>

          {archivedCategories.length > 0 && (
            <div className="werkstatt-archive-section">
              <button
                type="button"
                className="werkstatt-archive-toggle"
                aria-expanded={showArchivedCats}
                onClick={() => setShowArchivedCats((prev) => !prev)}
              >
                <span aria-hidden="true">{showArchivedCats ? "▾" : "▸"}</span>
                {de
                  ? `Archiv (${archivedCategories.length})`
                  : `Archive (${archivedCategories.length})`}
              </button>
              {showArchivedCats && (
                <ul className="werkstatt-tree werkstatt-tree--archived">
                  {archivedCategories.map((cat) => (
                    <ArchivedCategoryRow
                      key={cat.id}
                      cat={cat}
                      onRestore={() => restoreCategory(cat.id)}
                      de={de}
                    />
                  ))}
                </ul>
              )}
            </div>
          )}
        </section>

        <section className="werkstatt-card werkstatt-tree-card">
          <header className="werkstatt-card-head">
            <div className="werkstatt-card-title-block">
              <h3 className="werkstatt-card-title">{de ? "Lagerorte" : "Locations"}</h3>
              <span className="werkstatt-card-subtitle">{locationHeadline}</span>
            </div>
            <button
              type="button"
              className="werkstatt-action-btn"
              onClick={() => setLocationModal({ mode: "create" })}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
              {de ? "Neuer Lagerort" : "New location"}
            </button>
          </header>

          <ul className="werkstatt-tree">
            {visibleLocations.map((loc) => (
              <LocationRow
                key={loc.id}
                loc={loc}
                expanded={expandedLocs.has(loc.id)}
                onToggle={() => toggleLoc(loc.id)}
                menuItems={buildLocationMenu(loc, de, {
                  edit: () => setLocationModal({ mode: "edit", locationId: loc.id }),
                  duplicate: () => duplicateLocation(loc.id),
                  showItems: () => showLocationItems(loc),
                  archive: () => archiveLocation(loc.id),
                })}
                onEdit={() => setLocationModal({ mode: "edit", locationId: loc.id })}
                onCycleStatus={() => cycleLocationStatus(loc.id)}
                de={de}
              />
            ))}
            {visibleLocations.length === 0 && (
              <li className="werkstatt-tree-empty muted">
                {de ? "Noch keine Lagerorte. Lege den ersten an." : "No locations yet. Create the first one."}
              </li>
            )}
          </ul>

          {archivedLocations.length > 0 && (
            <div className="werkstatt-archive-section">
              <button
                type="button"
                className="werkstatt-archive-toggle"
                aria-expanded={showArchivedLocs}
                onClick={() => setShowArchivedLocs((prev) => !prev)}
              >
                <span aria-hidden="true">{showArchivedLocs ? "▾" : "▸"}</span>
                {de
                  ? `Archiv (${archivedLocations.length})`
                  : `Archive (${archivedLocations.length})`}
              </button>
              {showArchivedLocs && (
                <ul className="werkstatt-tree werkstatt-tree--archived">
                  {archivedLocations.map((loc) => (
                    <ArchivedLocationRow
                      key={loc.id}
                      loc={loc}
                      onRestore={() => restoreLocation(loc.id)}
                      de={de}
                    />
                  ))}
                </ul>
              )}
            </div>
          )}
        </section>
      </div>

      <CategoryFormModal
        open={categoryModal !== null}
        mode={categoryModal?.mode ?? "create"}
        initial={categoryInitial}
        topLevelOptions={topLevelCategoryOptions}
        language={language}
        onClose={() => setCategoryModal(null)}
        onSave={saveCategory}
        onArchive={
          categoryModal?.mode === "edit"
            ? () => archiveCategory(categoryModal.categoryId)
            : undefined
        }
      />

      <LocationFormModal
        open={locationModal !== null}
        mode={locationModal?.mode ?? "create"}
        initial={locationInitial}
        parentOptions={hallOptions}
        language={language}
        onClose={() => setLocationModal(null)}
        onSave={saveLocation}
        onArchive={
          locationModal?.mode === "edit"
            ? () => archiveLocation(locationModal.locationId)
            : undefined
        }
      />
    </section>
  );
}

/* ── Row components ────────────────────────────────────────────────── */

function CategoryRow({
  cat,
  expanded,
  onToggle,
  onEdit,
  menuItems,
  de,
}: {
  cat: Category;
  expanded: boolean;
  onToggle: () => void;
  onEdit: () => void;
  menuItems: ReadonlyArray<KebabMenuItem>;
  de: boolean;
}) {
  const hasChildren = cat.subcategories.length > 0;
  const sub = de
    ? `${cat.article_count} Artikel · ${cat.subcategory_count} Unterkategorien`
    : `${cat.article_count} items · ${cat.subcategory_count} subcategories`;
  return (
    <li className="werkstatt-tree-item">
      <button
        type="button"
        className="werkstatt-tree-row"
        onClick={onToggle}
        aria-expanded={expanded}
      >
        <span className="werkstatt-tree-chevron" aria-hidden="true">
          {hasChildren ? (expanded ? "▾" : "▸") : "·"}
        </span>
        <span className="werkstatt-tree-icon werkstatt-tree-icon--folder" aria-hidden="true">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
            <path
              d="M3.5 7.5a1.8 1.8 0 0 1 1.8-1.8h3.9l1.8 2.1h7.7a1.8 1.8 0 0 1 1.8 1.8v8.6a1.8 1.8 0 0 1-1.8 1.8H5.3a1.8 1.8 0 0 1-1.8-1.8V7.5Z"
              stroke="currentColor"
              strokeWidth="1.6"
            />
          </svg>
        </span>
        <span className="werkstatt-tree-main">
          <b className="werkstatt-tree-name">{cat.name}</b>
          <small className="werkstatt-tree-meta">{sub}</small>
        </span>
        <span className="werkstatt-tree-trailing">
          <button
            type="button"
            className="werkstatt-row-overflow"
            aria-label={de ? "Bearbeiten" : "Edit"}
            title={de ? "Bearbeiten" : "Edit"}
            onClick={(event) => {
              event.stopPropagation();
              onEdit();
            }}
          >
            ✎
          </button>
          <KebabMenu
            items={menuItems}
            ariaLabel={de ? "Mehr Aktionen" : "More actions"}
          />
        </span>
      </button>
      {expanded && hasChildren && (
        <ul className="werkstatt-tree-children">
          {cat.subcategories.map((sub_) => (
            <li key={sub_.id} className="werkstatt-tree-child">
              <span className="werkstatt-tree-child-dot" aria-hidden="true" />
              <span className="werkstatt-tree-child-name">{sub_.name}</span>
              <span className="werkstatt-tree-child-count">
                {sub_.article_count} {de ? "Artikel" : "items"}
              </span>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

function LocationRow({
  loc,
  expanded,
  onToggle,
  onEdit,
  menuItems,
  onCycleStatus,
  de,
}: {
  loc: Location;
  expanded: boolean;
  onToggle: () => void;
  onEdit: () => void;
  menuItems: ReadonlyArray<KebabMenuItem>;
  onCycleStatus: () => void;
  de: boolean;
}) {
  const canCycle = validStatusesForKind(loc.kind).length >= 2;
  const hasChildren = loc.shelves.length > 0;
  return (
    <li className="werkstatt-tree-item">
      <button
        type="button"
        className="werkstatt-tree-row"
        onClick={onToggle}
        aria-expanded={expanded}
      >
        <span className="werkstatt-tree-chevron" aria-hidden="true">
          {hasChildren ? (expanded ? "▾" : "▸") : "·"}
        </span>
        <span
          className={`werkstatt-tree-icon werkstatt-tree-icon--${loc.icon}`}
          aria-hidden="true"
        >
          {loc.icon === "hall" ? (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
              <path
                d="M4 10.5 12 5l8 5.5V19a1 1 0 0 1-1 1h-4v-6h-6v6H5a1 1 0 0 1-1-1v-8.5Z"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinejoin="round"
              />
            </svg>
          ) : (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
              <path
                d="M3 8h11v9H3zM14 11h4l3 3v3h-7z"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinejoin="round"
              />
              <circle cx="7.5" cy="18" r="1.6" stroke="currentColor" strokeWidth="1.6" />
              <circle cx="17" cy="18" r="1.6" stroke="currentColor" strokeWidth="1.6" />
            </svg>
          )}
        </span>
        <span className="werkstatt-tree-main">
          <b className="werkstatt-tree-name">{loc.name}</b>
          <small className="werkstatt-tree-meta">{loc.sub}</small>
        </span>
        <span className="werkstatt-tree-trailing">
          {canCycle ? (
            <button
              type="button"
              className={`werkstatt-loc-badge werkstatt-loc-badge--${loc.status} werkstatt-loc-badge--clickable`}
              title={de ? "Status wechseln" : "Toggle status"}
              onClick={(event) => {
                event.stopPropagation();
                onCycleStatus();
              }}
            >
              <span className="werkstatt-loc-badge-dot" aria-hidden="true" />
              {statusLabel(loc.status, de)}
            </button>
          ) : (
            <span className={`werkstatt-loc-badge werkstatt-loc-badge--${loc.status}`}>
              <span className="werkstatt-loc-badge-dot" aria-hidden="true" />
              {statusLabel(loc.status, de)}
            </span>
          )}
          <button
            type="button"
            className="werkstatt-row-overflow"
            aria-label={de ? "Bearbeiten" : "Edit"}
            title={de ? "Bearbeiten" : "Edit"}
            onClick={(event) => {
              event.stopPropagation();
              onEdit();
            }}
          >
            ✎
          </button>
          <KebabMenu
            items={menuItems}
            ariaLabel={de ? "Mehr Aktionen" : "More actions"}
          />
        </span>
      </button>
      {expanded && hasChildren && (
        <ul className="werkstatt-tree-children">
          {loc.shelves.map((shelf) => (
            <li key={shelf.id} className="werkstatt-tree-child">
              <span className="werkstatt-tree-child-icon" aria-hidden="true">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                  <path d="M4 6h16M4 12h16M4 18h16" stroke="currentColor" strokeWidth="1.6" />
                </svg>
              </span>
              <span className="werkstatt-tree-child-name">{shelf.name}</span>
              <span className="werkstatt-tree-child-count">
                {shelf.article_count} {de ? "Artikel" : "items"}
              </span>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

/* ── Menu builders (kept with the page so i18n strings are local) ─── */

function buildCategoryMenu(
  cat: Category,
  de: boolean,
  actions: { edit: () => void; duplicate: () => void; showItems: () => void; archive: () => void },
): ReadonlyArray<KebabMenuItem> {
  return [
    {
      key: "edit",
      icon: "✎",
      label: de ? "Bearbeiten" : "Edit",
      onSelect: actions.edit,
    },
    {
      key: "duplicate",
      icon: "⎘",
      label: de ? "Duplizieren" : "Duplicate",
      onSelect: actions.duplicate,
    },
    {
      key: "show-items",
      icon: "📦",
      label: de
        ? `Artikel anzeigen (${cat.article_count})`
        : `Show items (${cat.article_count})`,
      onSelect: actions.showItems,
      disabled: cat.article_count === 0,
    },
    {
      key: "archive",
      icon: "🗄",
      label: de ? "Archivieren" : "Archive",
      danger: true,
      onSelect: actions.archive,
    },
  ];
}

function buildLocationMenu(
  loc: Location,
  de: boolean,
  actions: { edit: () => void; duplicate: () => void; showItems: () => void; archive: () => void },
): ReadonlyArray<KebabMenuItem> {
  return [
    {
      key: "edit",
      icon: "✎",
      label: de ? "Bearbeiten" : "Edit",
      onSelect: actions.edit,
    },
    {
      key: "duplicate",
      icon: "⎘",
      label: de ? "Duplizieren" : "Duplicate",
      onSelect: actions.duplicate,
    },
    {
      key: "show-items",
      icon: "📦",
      label: de
        ? `Artikel anzeigen (${loc.article_count})`
        : `Show items (${loc.article_count})`,
      onSelect: actions.showItems,
      disabled: loc.article_count === 0,
    },
    {
      key: "archive",
      icon: "🗄",
      label: de ? "Archivieren" : "Archive",
      danger: true,
      onSelect: actions.archive,
    },
  ];
}

/* ── Archived row components (thin — label + Restore) ──────────────── */

function ArchivedCategoryRow({
  cat,
  onRestore,
  de,
}: {
  cat: Category;
  onRestore: () => void;
  de: boolean;
}) {
  return (
    <li className="werkstatt-tree-item werkstatt-tree-item--archived">
      <div className="werkstatt-tree-row werkstatt-tree-row--static">
        <span className="werkstatt-tree-chevron" aria-hidden="true">·</span>
        <span className="werkstatt-tree-icon werkstatt-tree-icon--folder" aria-hidden="true">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
            <path
              d="M3.5 7.5a1.8 1.8 0 0 1 1.8-1.8h3.9l1.8 2.1h7.7a1.8 1.8 0 0 1 1.8 1.8v8.6a1.8 1.8 0 0 1-1.8 1.8H5.3a1.8 1.8 0 0 1-1.8-1.8V7.5Z"
              stroke="currentColor"
              strokeWidth="1.6"
            />
          </svg>
        </span>
        <span className="werkstatt-tree-main">
          <b className="werkstatt-tree-name">{cat.name}</b>
          <small className="werkstatt-tree-meta">
            {de ? "archiviert" : "archived"} · {cat.article_count} {de ? "Artikel" : "items"}
          </small>
        </span>
        <span className="werkstatt-tree-trailing">
          <button
            type="button"
            className="werkstatt-action-btn werkstatt-action-btn--small"
            onClick={onRestore}
          >
            {de ? "Wiederherstellen" : "Restore"}
          </button>
        </span>
      </div>
    </li>
  );
}

function ArchivedLocationRow({
  loc,
  onRestore,
  de,
}: {
  loc: Location;
  onRestore: () => void;
  de: boolean;
}) {
  return (
    <li className="werkstatt-tree-item werkstatt-tree-item--archived">
      <div className="werkstatt-tree-row werkstatt-tree-row--static">
        <span className="werkstatt-tree-chevron" aria-hidden="true">·</span>
        <span
          className={`werkstatt-tree-icon werkstatt-tree-icon--${loc.icon}`}
          aria-hidden="true"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
            <path
              d="M4 10.5 12 5l8 5.5V19a1 1 0 0 1-1 1h-4v-6h-6v6H5a1 1 0 0 1-1-1v-8.5Z"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinejoin="round"
            />
          </svg>
        </span>
        <span className="werkstatt-tree-main">
          <b className="werkstatt-tree-name">{loc.name}</b>
          <small className="werkstatt-tree-meta">
            {de ? "archiviert" : "archived"} · {loc.article_count} {de ? "Artikel" : "items"}
          </small>
        </span>
        <span className="werkstatt-tree-trailing">
          <button
            type="button"
            className="werkstatt-action-btn werkstatt-action-btn--small"
            onClick={onRestore}
          >
            {de ? "Wiederherstellen" : "Restore"}
          </button>
        </span>
      </div>
    </li>
  );
}
