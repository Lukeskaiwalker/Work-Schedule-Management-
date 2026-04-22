import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { useAppContext } from "../context/AppContext";
import { projectLocationAddress } from "../utils/projects";
import { formatServerDateTime } from "../utils/dates";
import { geocodeBatch, type GeoResult } from "../utils/geocode";
import { MAP_PIN_FILTERS, type MapPinFilter, type Project, type Language } from "../types";

const MAP_PIN_FILTER_LS_KEY = "smpl_map_pin_filter_hidden";
const ALL_PIN_FILTERS: readonly MapPinFilter[] = MAP_PIN_FILTERS;

/** Compute the pin-type bucket for a project — critical wins over status. */
function pinTypeOf(project: Project): MapPinFilter {
  if (project.is_critical) return "critical";
  const s = project.status.toLowerCase();
  if (s === "active" || s === "aktiv") return "active";
  if (s === "planning" || s === "planung") return "planning";
  if (s === "on_hold" || s === "on hold" || s === "pausiert") return "on_hold";
  if (s === "archived" || s === "archiviert") return "archived";
  // completed, unknown → "completed" bucket
  return "completed";
}

/** Pin color by project status — critical wins over any status color. */
function pinColor(project: Project): string {
  switch (pinTypeOf(project)) {
    case "critical": return "#DC2626";
    case "active":   return "#059669";
    case "planning": return "#2563EB";
    case "on_hold":  return "#D97706";
    case "archived": return "#9CA3AF";
    case "completed":
    default:         return "#6B7280";
  }
}

/** Read the saved set of HIDDEN pin types from localStorage. Returns an
 *  empty Set when no preference is stored (default = all visible). */
function readLocalHiddenPinTypes(): Set<MapPinFilter> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(MAP_PIN_FILTER_LS_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    const allowed = new Set<MapPinFilter>(ALL_PIN_FILTERS);
    const result = new Set<MapPinFilter>();
    for (const entry of parsed) {
      if (typeof entry === "string" && allowed.has(entry as MapPinFilter)) {
        result.add(entry as MapPinFilter);
      }
    }
    return result;
  } catch {
    return new Set();
  }
}

function writeLocalHiddenPinTypes(hidden: Set<MapPinFilter>): void {
  if (typeof window === "undefined") return;
  try {
    if (hidden.size === 0) {
      window.localStorage.removeItem(MAP_PIN_FILTER_LS_KEY);
      return;
    }
    window.localStorage.setItem(MAP_PIN_FILTER_LS_KEY, JSON.stringify(Array.from(hidden)));
  } catch {
    // localStorage can throw in private-mode / over-quota — the in-memory
    // state is still correct, so we silently skip persistence.
  }
}

function statusLabel(status: string, de: boolean): string {
  const s = status.toLowerCase();
  if (s === "active" || s === "aktiv") return de ? "Aktiv" : "Active";
  if (s === "planning" || s === "planung") return de ? "Planung" : "Planning";
  if (s === "on_hold" || s === "on hold" || s === "pausiert") return de ? "Pausiert" : "On hold";
  if (s === "completed" || s === "abgeschlossen") return de ? "Abgeschlossen" : "Completed";
  if (s === "archived" || s === "archiviert") return de ? "Archiviert" : "Archived";
  return status;
}

function createPinIcon(color: string): L.DivIcon {
  return L.divIcon({
    className: "map-page-pin",
    html: `<svg width="28" height="36" viewBox="0 0 28 36" fill="none"><path d="M14 0C6.27 0 0 6.27 0 14c0 10.5 14 22 14 22s14-11.5 14-22C28 6.27 21.73 0 14 0Z" fill="${color}"/><circle cx="14" cy="14" r="6" fill="#fff"/></svg>`,
    iconSize: [28, 36],
    iconAnchor: [14, 36],
    popupAnchor: [0, -36],
  });
}

/** HTML-escape a string so it's safe to inject into a Leaflet popup template. */
function escapeHtmlAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Build the "Critical since … · Set by …" label for hover tooltips. */
function criticalTooltipText(
  project: Project,
  language: Language,
  userNameById: (id: number) => string,
): string {
  const sinceLabel = project.critical_since
    ? formatServerDateTime(project.critical_since, language)
    : "-";
  const byLabel = project.critical_set_by_user_id
    ? userNameById(project.critical_set_by_user_id)
    : "-";
  return language === "de"
    ? `Kritisch seit ${sinceLabel} · Gesetzt von ${byLabel}`
    : `Critical since ${sinceLabel} · Set by ${byLabel}`;
}

type ProjectPin = {
  project: Project;
  address: string;
  coords: GeoResult;
};

/** Cheap content-equality check so background polls don't re-trigger a full
 *  marker rebuild when the underlying data is unchanged. Only compares the
 *  fields that actually affect what's drawn on the map. */
function pinsEqual(a: readonly ProjectPin[], b: readonly ProjectPin[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i];
    const y = b[i];
    if (
      x.project.id !== y.project.id ||
      x.project.status !== y.project.status ||
      (x.project.is_critical ?? false) !== (y.project.is_critical ?? false) ||
      x.project.name !== y.project.name ||
      x.project.project_number !== y.project.project_number ||
      x.project.customer_name !== y.project.customer_name ||
      x.project.critical_since !== y.project.critical_since ||
      x.project.critical_set_by_user_id !== y.project.critical_set_by_user_id ||
      x.coords.lat !== y.coords.lat ||
      x.coords.lng !== y.coords.lng ||
      x.address !== y.address
    ) {
      return false;
    }
  }
  return true;
}

export function MapPage() {
  const {
    mainView,
    language,
    projects,
    setMainView,
    setActiveProjectId,
    setProjectTab,
    userNameById,
    user,
    saveUserPreference,
  } = useAppContext();

  const [search, setSearch] = useState("");
  const [geocoding, setGeocoding] = useState(false);
  const [geocodeProgress, setGeocodeProgress] = useState({ done: 0, total: 0 });
  const [pins, setPins] = useState<ProjectPin[]>([]);

  // Pin-type filter: blacklist of HIDDEN types. Empty set = all visible
  // (the default). Stored this way so that any new pin types introduced
  // later are automatically visible for existing users.
  // localStorage is read synchronously on mount so there's no flash of
  // unfiltered pins; the server preference is then synced once per user.
  const [hiddenTypes, setHiddenTypes] = useState<Set<MapPinFilter>>(() =>
    readLocalHiddenPinTypes(),
  );
  // Guard so the server-side pref is only applied once per user id — any
  // later edits by the user are pushed to the server, not overwritten by
  // an echo of the saved value.
  const syncedPrefForUserRef = useRef<number | null>(null);

  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapInstanceRef = useRef<L.Map | null>(null);
  const markersRef = useRef<L.LayerGroup | null>(null);
  // Remember the set of pin coordinates we last fitted so we only auto-fit
  // when the actual footprint changes — not when popup labels change.
  const fittedFingerprintRef = useRef<string | null>(null);
  // `userNameById` is a plain function recreated on every parent render.
  // Stash it in a ref so the marker effect's dep array stays stable and
  // doesn't rebuild markers (closing open popups) on unrelated re-renders.
  const userNameByIdRef = useRef(userNameById);
  userNameByIdRef.current = userNameById;

  const de = language === "de";

  // Sync the server-side preference into local state exactly once per user.
  // Server is the source of truth; localStorage is only there to avoid the
  // flash of unfiltered pins before the user object loads.
  useEffect(() => {
    if (!user) return;
    if (syncedPrefForUserRef.current === user.id) return;
    syncedPrefForUserRef.current = user.id;
    const saved = user.preferences?.map_pin_filter_hidden;
    const allowed = new Set<MapPinFilter>(ALL_PIN_FILTERS);
    const next = new Set<MapPinFilter>();
    if (Array.isArray(saved)) {
      for (const entry of saved) {
        if (allowed.has(entry)) next.add(entry);
      }
    }
    setHiddenTypes(next);
    writeLocalHiddenPinTypes(next);
  }, [user]);

  // Toggle a single pin type's visibility. Persist to localStorage
  // immediately, then fire-and-forget to the server (failure is non-fatal
  // and handled silently by saveUserPreference).
  const togglePinType = useCallback(
    (type: MapPinFilter) => {
      setHiddenTypes((prev) => {
        const next = new Set(prev);
        if (next.has(type)) next.delete(type);
        else next.add(type);
        writeLocalHiddenPinTypes(next);
        void saveUserPreference("map_pin_filter_hidden", Array.from(next));
        return next;
      });
    },
    [saveUserPreference],
  );

  // "Show all" reset — clear both local and server preference.
  const resetPinFilter = useCallback(() => {
    setHiddenTypes(new Set());
    writeLocalHiddenPinTypes(new Set());
    void saveUserPreference("map_pin_filter_hidden", []);
  }, [saveUserPreference]);

  const allVisible = hiddenTypes.size === 0;

  // Projects with addresses
  const projectsWithAddresses = useMemo(
    () =>
      projects
        .map((p) => ({ project: p, address: projectLocationAddress(p) }))
        .filter((entry) => entry.address.length > 0),
    [projects],
  );

  // Geocode all project addresses
  useEffect(() => {
    if (mainView !== "projects_map") return;
    if (projectsWithAddresses.length === 0) return;

    let cancelled = false;
    const addresses = projectsWithAddresses.map((e) => e.address);

    setGeocoding(true);
    geocodeBatch(addresses, (done, total) => {
      if (!cancelled) setGeocodeProgress({ done, total });
    }).then((results) => {
      if (cancelled) return;
      const newPins: ProjectPin[] = [];
      for (const entry of projectsWithAddresses) {
        const coords = results.get(entry.address);
        if (coords) {
          newPins.push({ project: entry.project, address: entry.address, coords });
        }
      }
      // Background polling replaces `projects` with a fresh array reference
      // every few seconds even when content is unchanged, which would tear
      // down and rebuild every marker (closing open popups). Only push new
      // pins into state when something that affects the marker view actually
      // changed — project id, coords, status (pin color), or critical flag.
      setPins((prev) => (pinsEqual(prev, newPins) ? prev : newPins));
      setGeocoding(false);
    });

    return () => {
      cancelled = true;
    };
  }, [mainView, projectsWithAddresses]);

  // Initialize Leaflet map
  useEffect(() => {
    if (mainView !== "projects_map") return;
    if (!mapContainerRef.current) return;
    if (mapInstanceRef.current) return; // already initialized

    const map = L.map(mapContainerRef.current, {
      center: [51.1657, 10.4515], // Center of Germany
      zoom: 6,
      zoomControl: true,
    });

    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      maxZoom: 19,
    }).addTo(map);

    markersRef.current = L.layerGroup().addTo(map);
    mapInstanceRef.current = map;

    // Cleanup on unmount
    return () => {
      map.remove();
      mapInstanceRef.current = null;
      markersRef.current = null;
    };
  }, [mainView]);

  // Pins visible after applying the hidden-types blacklist. Derived separately
  // from the raw `pins` state so filter changes don't re-trigger geocoding.
  const visiblePins = useMemo(
    () => pins.filter((p) => !hiddenTypes.has(pinTypeOf(p.project))),
    [pins, hiddenTypes],
  );

  // Update markers when the visible-pin set changes
  useEffect(() => {
    const map = mapInstanceRef.current;
    const layerGroup = markersRef.current;
    if (!map || !layerGroup) return;

    layerGroup.clearLayers();

    for (const pin of visiblePins) {
      const color = pinColor(pin.project);
      const icon = createPinIcon(color);
      const marker = L.marker([pin.coords.lat, pin.coords.lng], { icon });

      const criticalHtml = pin.project.is_critical
        ? `<div class="map-page-popup-critical" title="${escapeHtmlAttr(
            criticalTooltipText(pin.project, language, userNameByIdRef.current),
          )}">⚠ ${de ? "Kritisch" : "Critical"}</div>`
        : "";

      const popupContent = `
        <div class="map-page-popup">
          <div class="map-page-popup-number">${pin.project.project_number}</div>
          <div class="map-page-popup-name">${pin.project.name}</div>
          ${pin.project.customer_name ? `<div class="map-page-popup-customer">${pin.project.customer_name}</div>` : ""}
          ${criticalHtml}
          <div class="map-page-popup-status" style="color: ${color};">● ${statusLabel(pin.project.status, de)}</div>
          <div class="map-page-popup-address">${pin.address}</div>
        </div>
      `;

      marker.bindPopup(popupContent, { className: "map-page-leaflet-popup" });
      marker.bindTooltip(
        `<b>${pin.project.project_number}</b> — ${pin.project.name}`,
        { direction: "top", offset: [0, -36] },
      );

      marker.on("click", () => {
        marker.openPopup();
      });

      layerGroup.addLayer(marker);
    }

    // Only auto-fit bounds when the actual pin footprint changes (new pins
    // added/removed, or filter toggled to reveal/hide a bucket). Re-fitting
    // on every popup rebuild would yank the map back to initial view
    // whenever `language` changes or the context re-renders — breaking
    // pan/zoom.
    if (visiblePins.length > 0) {
      const fingerprint = visiblePins
        .map((p) => `${p.project.id}:${p.coords.lat.toFixed(5)},${p.coords.lng.toFixed(5)}`)
        .sort()
        .join("|");
      if (fittedFingerprintRef.current !== fingerprint) {
        const bounds = L.latLngBounds(visiblePins.map((p) => [p.coords.lat, p.coords.lng]));
        map.fitBounds(bounds, { padding: [40, 40], maxZoom: 14 });
        fittedFingerprintRef.current = fingerprint;
      }
    } else {
      fittedFingerprintRef.current = null;
    }
  }, [visiblePins, de, language]);

  // Search + zoom handler
  const handleSearchSelect = useCallback(
    (project: Project) => {
      const pin = pins.find((p) => p.project.id === project.id);
      if (pin && mapInstanceRef.current) {
        mapInstanceRef.current.setView([pin.coords.lat, pin.coords.lng], 15, { animate: true });
        // Open the popup for this pin
        markersRef.current?.eachLayer((layer) => {
          const marker = layer as L.Marker;
          const pos = marker.getLatLng();
          if (
            Math.abs(pos.lat - pin.coords.lat) < 0.0001 &&
            Math.abs(pos.lng - pin.coords.lng) < 0.0001
          ) {
            marker.openPopup();
          }
        });
      }
      setSearch("");
    },
    [pins],
  );

  // Navigate to project on popup click
  useEffect(() => {
    const container = mapContainerRef.current;
    if (!container) return;
    function handlePopupClick(e: MouseEvent) {
      const target = e.target as HTMLElement;
      const btn = target.closest(".map-page-popup-open");
      if (!btn) return;
      const projectId = btn.getAttribute("data-project-id");
      if (!projectId) return;
      setActiveProjectId(Number(projectId));
      setProjectTab("overview");
      setMainView("project");
    }
    container.addEventListener("click", handlePopupClick);
    return () => container.removeEventListener("click", handlePopupClick);
  }, [setActiveProjectId, setMainView, setProjectTab]);

  if (mainView !== "projects_map") return null;

  // Search filtering — match project number, name, customer, or address
  const q = search.trim().toLowerCase();
  const filteredProjects = q
    ? projects.filter((p) => {
        const address = projectLocationAddress(p).toLowerCase();
        return (
          p.project_number.toLowerCase().includes(q) ||
          p.name.toLowerCase().includes(q) ||
          (p.customer_name ?? "").toLowerCase().includes(q) ||
          address.includes(q)
        );
      })
    : [];

  return (
    <div className="map-page">
      <div className="map-page-toolbar">
        <h1 className="map-page-title">{de ? "Projektkarte" : "Project Map"}</h1>
        <div className="map-page-search-wrap">
          <input
            type="search"
            className="map-page-search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={de ? "Projekt suchen…" : "Search projects…"}
          />
          {q && filteredProjects.length > 0 && (
            <div className="map-page-search-results">
              {filteredProjects.slice(0, 8).map((p) => {
                const hasPin = pins.some((pin) => pin.project.id === p.id);
                const address = projectLocationAddress(p);
                return (
                  <button
                    key={p.id}
                    type="button"
                    className="map-page-search-item"
                    onClick={() => handleSearchSelect(p)}
                    disabled={!hasPin}
                  >
                    <span className="map-page-search-item-number">{p.project_number}</span>
                    <span className="map-page-search-item-main">
                      <span className="map-page-search-item-name">{p.name}</span>
                      {address && (
                        <span className="map-page-search-item-address">{address}</span>
                      )}
                    </span>
                    <span
                      className="map-page-search-item-dot"
                      style={{ backgroundColor: pinColor(p) }}
                    />
                    {!hasPin && (
                      <small className="map-page-search-item-no-loc">
                        {de ? "Kein Standort" : "No location"}
                      </small>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>
        {geocoding && (
          <span className="map-page-geocoding">
            {de ? "Adressen werden geladen…" : "Loading addresses…"}{" "}
            {geocodeProgress.total > 0 && `(${geocodeProgress.done}/${geocodeProgress.total})`}
          </span>
        )}
        <span className="map-page-pin-count">
          {visiblePins.length} / {projects.length}{" "}
          {de ? "Projekte auf Karte" : "projects on map"}
          {!allVisible && (
            <span className="map-page-pin-count-filtered">
              {" · "}
              {de ? "gefiltert" : "filtered"}
            </span>
          )}
        </span>
      </div>

      <div className="map-page-container" ref={mapContainerRef} />

      {/* Clickable legend — each item toggles the visibility of its pin type.
          The blacklist is saved to localStorage + /auth/me/preferences so it
          survives reloads and follows the user across devices. */}
      <div className="map-page-legend">
        {LEGEND_ITEMS.map(({ type, color, labelDe, labelEn }) => {
          const hidden = hiddenTypes.has(type);
          return (
            <button
              key={type}
              type="button"
              className={`map-page-legend-item map-page-legend-item--toggle${hidden ? " is-off" : ""}`}
              onClick={() => togglePinType(type)}
              aria-pressed={!hidden}
              title={
                hidden
                  ? de ? "Einblenden" : "Show"
                  : de ? "Ausblenden" : "Hide"
              }
            >
              <span className="map-page-legend-dot" style={{ backgroundColor: color }} />
              {de ? labelDe : labelEn}
            </button>
          );
        })}
        {!allVisible && (
          <button
            type="button"
            className="map-page-legend-reset"
            onClick={resetPinFilter}
          >
            {de ? "Alle anzeigen" : "Show all"}
          </button>
        )}
      </div>
    </div>
  );
}

const LEGEND_ITEMS: ReadonlyArray<{
  type: MapPinFilter;
  color: string;
  labelDe: string;
  labelEn: string;
}> = [
  { type: "critical",  color: "#DC2626", labelDe: "Kritisch",      labelEn: "Critical" },
  { type: "active",    color: "#059669", labelDe: "Aktiv",         labelEn: "Active" },
  { type: "planning",  color: "#2563EB", labelDe: "Planung",       labelEn: "Planning" },
  { type: "on_hold",   color: "#D97706", labelDe: "Pausiert",      labelEn: "On hold" },
  { type: "completed", color: "#6B7280", labelDe: "Abgeschlossen", labelEn: "Completed" },
  { type: "archived",  color: "#9CA3AF", labelDe: "Archiviert",    labelEn: "Archived" },
];
