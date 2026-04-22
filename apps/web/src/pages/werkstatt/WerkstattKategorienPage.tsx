import { useMemo, useState } from "react";
import { useAppContext } from "../../context/AppContext";
import {
  MOCK_CATEGORIES,
  MOCK_LOCATIONS,
  type MockCategory,
  type MockLocation,
} from "../../components/werkstatt/mockData";
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

/**
 * WerkstattKategorienPage — Kategorien & Lagerorte. Ported from Paper 9EE-0.
 * Two columns: category tree (left) + physical location tree (right). Each
 * node is expandable; nodes with children render a chevron + sub-list.
 *
 * Full create / edit / archive: the "+ Neue Kategorie" and "+ Neuer Lagerort"
 * header buttons open form modals; the pencil (✎) on every row opens edit
 * mode. Archive fires from inside the edit modal and from the kebab (…).
 *
 * All mutations are local state today; backend endpoints exist at
 *   POST/PATCH/DELETE /api/werkstatt/categories
 *   POST/PATCH/DELETE /api/werkstatt/locations
 * and get threaded through AppContext when the BE wiring round happens.
 */

/* ── Local mutable state types (superset of the read-only MOCK_* types) ─ */

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

function seedCategories(): Category[] {
  return MOCK_CATEGORIES.map((c: MockCategory) => ({
    id: c.id,
    name: c.name,
    article_count: c.article_count,
    subcategory_count: c.subcategory_count,
    subcategories: c.subcategories,
    expanded: c.expanded,
    parent_id: null,
    notes: "",
    is_archived: false,
  }));
}

function seedLocations(): Location[] {
  return MOCK_LOCATIONS.map((l: MockLocation) => ({
    id: l.id,
    name: l.name,
    sub: l.sub,
    kind: l.icon === "hall" ? "hall" : "vehicle",
    icon: l.icon,
    article_count: l.article_count,
    status: l.status,
    shelves: l.shelves,
    expanded: l.expanded,
    parent_id: null,
    address: "",
    notes: "",
    is_archived: false,
  }));
}

/* ── Page ────────────────────────────────────────────────────────────── */

export function WerkstattKategorienPage() {
  const { mainView, language, werkstattTab, setNotice, setWerkstattTab } = useAppContext();

  const [categories, setCategories] = useState<Category[]>(seedCategories);
  const [locations, setLocations] = useState<Location[]>(seedLocations);
  const [showArchivedCats, setShowArchivedCats] = useState(false);
  const [showArchivedLocs, setShowArchivedLocs] = useState(false);

  const [expandedCats, setExpandedCats] = useState<ReadonlySet<string>>(() => {
    const initial = new Set<string>();
    for (const cat of MOCK_CATEGORIES) if (cat.expanded) initial.add(cat.id);
    return initial;
  });
  const [expandedLocs, setExpandedLocs] = useState<ReadonlySet<string>>(() => {
    const initial = new Set<string>();
    for (const loc of MOCK_LOCATIONS) if (loc.expanded) initial.add(loc.id);
    return initial;
  });

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

  if (mainView !== "werkstatt" || werkstattTab !== "kategorien") return null;

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

  function nextId(prefix: string): string {
    // Simple client-side id — BE will assign real IDs on create.
    return `${prefix}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1000)}`;
  }

  function saveCategory(payload: CategoryFormPayload) {
    if (payload.id === null) {
      // Create
      const created: Category = {
        id: nextId("c"),
        name: payload.name,
        article_count: 0,
        subcategory_count: 0,
        subcategories: [],
        expanded: false,
        parent_id: payload.parent_id,
        notes: payload.notes,
        is_archived: false,
      };
      setCategories((prev) => [...prev, created]);
      setNotice(
        de
          ? `Kategorie "${payload.name}" angelegt (API folgt)`
          : `Category "${payload.name}" created (API pending)`,
      );
      // TODO(werkstatt): POST /api/werkstatt/categories
    } else {
      // Edit
      const id = payload.id;
      setCategories((prev) =>
        prev.map((c) =>
          c.id === id
            ? { ...c, name: payload.name, parent_id: payload.parent_id, notes: payload.notes }
            : c,
        ),
      );
      setNotice(
        de
          ? `Kategorie "${payload.name}" aktualisiert (API folgt)`
          : `Category "${payload.name}" updated (API pending)`,
      );
      // TODO(werkstatt): PATCH /api/werkstatt/categories/{id}
    }
    setCategoryModal(null);
  }

  function archiveCategory(id: string) {
    const cat = categories.find((c) => c.id === id);
    if (!cat) return;
    if (!window.confirm(
      de
        ? `Kategorie "${cat.name}" archivieren? Zugeordnete Artikel bleiben erhalten.`
        : `Archive category "${cat.name}"? Linked items stay.`,
    )) return;
    setCategories((prev) =>
      prev.map((c) => (c.id === id ? { ...c, is_archived: true } : c)),
    );
    setShowArchivedCats(true); // make sure user sees where it went
    setNotice(
      de
        ? `Kategorie "${cat.name}" archiviert — unten im Archiv sichtbar`
        : `Category "${cat.name}" archived — visible in Archive below`,
    );
    setCategoryModal(null);
    // TODO(werkstatt): DELETE /api/werkstatt/categories/{id}
  }

  function restoreCategory(id: string) {
    const cat = categories.find((c) => c.id === id);
    if (!cat) return;
    setCategories((prev) =>
      prev.map((c) => (c.id === id ? { ...c, is_archived: false } : c)),
    );
    setNotice(
      de
        ? `Kategorie "${cat.name}" wiederhergestellt (API folgt)`
        : `Category "${cat.name}" restored (API pending)`,
    );
    // TODO(werkstatt): PATCH /api/werkstatt/categories/{id} { is_archived: false }
  }

  function duplicateCategory(id: string) {
    const cat = categories.find((c) => c.id === id);
    if (!cat) return;
    const created: Category = {
      ...cat,
      id: nextId("c"),
      name: `${cat.name} ${de ? "(Kopie)" : "(copy)"}`,
      article_count: 0,
      subcategory_count: 0,
      subcategories: [],
      is_archived: false,
    };
    setCategories((prev) => [...prev, created]);
    setNotice(
      de
        ? `Kategorie "${cat.name}" dupliziert als "${created.name}"`
        : `Duplicated "${cat.name}" → "${created.name}"`,
    );
    // TODO(werkstatt): POST /api/werkstatt/categories { ...source, name: +(Kopie) }
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
    const iconFor = (kind: LocationKind): "hall" | "vehicle" =>
      kind === "vehicle" ? "vehicle" : "hall";
    const subFor = (p: LocationFormPayload): string => {
      if (p.kind === "shelf") {
        const parent = locations.find((l) => l.id === p.parent_id);
        return parent ? `In ${parent.name}` : "";
      }
      return p.address || "";
    };

    if (payload.id === null) {
      // Shelves are children of a hall — push into the parent's shelves array.
      // Every other kind is a top-level row.
      if (payload.kind === "shelf" && payload.parent_id !== null) {
        const shelfId = nextId("s");
        const parentId = payload.parent_id;
        setLocations((prev) =>
          prev.map((loc) =>
            loc.id === parentId
              ? {
                  ...loc,
                  shelves: [
                    ...loc.shelves,
                    { id: shelfId, name: payload.name, article_count: 0 },
                  ],
                }
              : loc,
          ),
        );
        // Auto-expand the parent so the new shelf is visible immediately.
        setExpandedLocs((prev) => {
          const next = new Set(prev);
          next.add(parentId);
          return next;
        });
        setNotice(
          de
            ? `Regal "${payload.name}" zu Halle angelegt (API folgt)`
            : `Shelf "${payload.name}" added to hall (API pending)`,
        );
        // TODO(werkstatt): POST /api/werkstatt/locations { parent_id, location_type: "shelf" }
        setLocationModal(null);
        return;
      }

      const created: Location = {
        id: nextId("l"),
        name: payload.name,
        sub: subFor(payload),
        kind: payload.kind,
        icon: iconFor(payload.kind),
        article_count: 0,
        status: payload.status,
        shelves: [],
        expanded: false,
        parent_id: payload.parent_id,
        address: payload.address,
        notes: payload.notes,
        is_archived: false,
      };
      setLocations((prev) => [...prev, created]);
      setNotice(
        de
          ? `Lagerort "${payload.name}" angelegt (API folgt)`
          : `Location "${payload.name}" created (API pending)`,
      );
      // TODO(werkstatt): POST /api/werkstatt/locations
    } else {
      const id = payload.id;
      setLocations((prev) =>
        prev.map((l) =>
          l.id === id
            ? {
                ...l,
                name: payload.name,
                kind: payload.kind,
                icon: iconFor(payload.kind),
                status: payload.status,
                parent_id: payload.parent_id,
                address: payload.address,
                notes: payload.notes,
                sub: subFor(payload),
              }
            : l,
        ),
      );
      setNotice(
        de
          ? `Lagerort "${payload.name}" aktualisiert (API folgt)`
          : `Location "${payload.name}" updated (API pending)`,
      );
      // TODO(werkstatt): PATCH /api/werkstatt/locations/{id}
    }
    setLocationModal(null);
  }

  /** Click the pill on a row → cycle to the next valid status for the kind.
   *  Useful for the vehicle ↔ workshop toggle that drivers do all day. */
  function cycleLocationStatus(id: string) {
    setLocations((prev) =>
      prev.map((l) => {
        if (l.id !== id) return l;
        const options = validStatusesForKind(l.kind);
        if (options.length < 2) return l;
        const idx = options.indexOf(l.status);
        const next = options[(idx + 1) % options.length];
        return { ...l, status: next };
      }),
    );
    const loc = locations.find((l) => l.id === id);
    if (loc) {
      const options = validStatusesForKind(loc.kind);
      if (options.length < 2) return;
      const idx = options.indexOf(loc.status);
      const next = options[(idx + 1) % options.length];
      setNotice(
        de
          ? `Status von "${loc.name}" → ${statusLabel(next, true)} (API folgt)`
          : `Status of "${loc.name}" → ${statusLabel(next, false)} (API pending)`,
      );
      // TODO(werkstatt): PATCH /api/werkstatt/locations/{id} { status: next }
    }
  }

  function archiveLocation(id: string) {
    const loc = locations.find((l) => l.id === id);
    if (!loc) return;
    if (!window.confirm(
      de
        ? `Lagerort "${loc.name}" archivieren? Artikel bleiben sichtbar, aber ohne Lagerzuordnung.`
        : `Archive location "${loc.name}"? Items stay visible but lose their storage assignment.`,
    )) return;
    setLocations((prev) =>
      prev.map((l) => (l.id === id ? { ...l, is_archived: true } : l)),
    );
    setShowArchivedLocs(true);
    setNotice(
      de
        ? `Lagerort "${loc.name}" archiviert — unten im Archiv sichtbar`
        : `Location "${loc.name}" archived — visible in Archive below`,
    );
    setLocationModal(null);
    // TODO(werkstatt): DELETE /api/werkstatt/locations/{id}
  }

  function restoreLocation(id: string) {
    const loc = locations.find((l) => l.id === id);
    if (!loc) return;
    setLocations((prev) =>
      prev.map((l) => (l.id === id ? { ...l, is_archived: false } : l)),
    );
    setNotice(
      de
        ? `Lagerort "${loc.name}" wiederhergestellt (API folgt)`
        : `Location "${loc.name}" restored (API pending)`,
    );
    // TODO(werkstatt): PATCH /api/werkstatt/locations/{id} { is_archived: false }
  }

  function duplicateLocation(id: string) {
    const loc = locations.find((l) => l.id === id);
    if (!loc) return;
    const created: Location = {
      ...loc,
      id: nextId("l"),
      name: `${loc.name} ${de ? "(Kopie)" : "(copy)"}`,
      article_count: 0,
      shelves: [],
      is_archived: false,
    };
    setLocations((prev) => [...prev, created]);
    setNotice(
      de
        ? `Lagerort "${loc.name}" dupliziert als "${created.name}"`
        : `Duplicated "${loc.name}" → "${created.name}"`,
    );
    // TODO(werkstatt): POST /api/werkstatt/locations { ...source, name: +(Kopie) }
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
