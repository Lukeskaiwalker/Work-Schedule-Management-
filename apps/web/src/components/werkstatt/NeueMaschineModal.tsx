/**
 * NeueMaschineModal — register one physical machine against a catalogue article.
 *
 * The article is the *type* ("Akkuschrauber GSR 18V-55"); the machine is the
 * object on the shelf. Registering the fourth identical drill therefore starts
 * by finding the article, not by re-typing its name — and the machine number
 * (M-0001) is allocated by the server, never entered here, because it is the
 * one thing that must be unique workshop-wide.
 *
 * `parent_unit_id` is what turns this dialog into "add a battery to that drill":
 * the same form, with the machine it belongs to selected.
 */
import { useEffect, useMemo, useState } from "react";

import { apiFetch } from "../../api/client";
import type { Language } from "../../types";
import type { WerkstattLocation } from "../../types/werkstatt";
import type { Machine, MachineCreatePayload } from "../../types/werkstattMachines";
import { localDateTimeInputToIso } from "../../utils/dates";

/** The slice of GET /werkstatt/articles this dialog needs. */
type ArticleHit = {
  id: number;
  article_number: string;
  item_name: string;
  manufacturer: string | null;
  category_name: string | null;
};

/** How the user is telling us what this machine IS. */
type CreateMode = "blueprint" | "article";

/** One already-registered type, offered as a template. */
type Blueprint = {
  article_id: number;
  article_name: string;
  manufacturer: string | null;
  /** How many of this type already exist — "Makita Akku 5Ah (3)". */
  count: number;
  /** The unit its settings are copied from: the most recently registered one. */
  source: Machine;
};

export interface NeueMaschineModalProps {
  open: boolean;
  language: Language;
  token: string | null;
  /** Candidate parents — top-level machines only; components cannot nest. */
  parentCandidates: ReadonlyArray<Machine>;
  /**
   * Everything already in the register, INCLUDING components — the fourth
   * battery is a blueprint of the first battery, which is somebody's component.
   */
  blueprintCandidates: ReadonlyArray<Machine>;
  locations: ReadonlyArray<WerkstattLocation>;
  /** Pre-selects a parent, so "Komponente hinzufügen" lands on a filled form. */
  initialParentId?: number | null;
  /** Pre-selects a blueprint, so "Weitere anlegen" lands on a filled form. */
  initialBlueprintArticleId?: number | null;
  busy?: boolean;
  /**
   * Whether this user may create a catalogue article from inside the dialog.
   * Article creation is a `werkstatt:manage` right; machine creation is not,
   * so the two can differ. When false, the dead end below at least says
   * where to go instead of leaving a grey button with no reason on it.
   */
  canCreateType?: boolean;
  onClose: () => void;
  onConfirm: (payload: MachineCreatePayload, options: { printLabel: boolean }) => void;
}

/** Today as a `date` input value, in the user's own timezone. */
function todayInput(): string {
  const now = new Date();
  const offset = now.getTimezoneOffset();
  return new Date(now.getTime() - offset * 60_000).toISOString().slice(0, 10);
}

export function NeueMaschineModal({
  open,
  language,
  token,
  canCreateType = false,
  parentCandidates,
  blueprintCandidates,
  locations,
  initialParentId = null,
  initialBlueprintArticleId = null,
  busy = false,
  onClose,
  onConfirm,
}: NeueMaschineModalProps) {
  const de = language === "de";

  const [mode, setMode] = useState<CreateMode>("blueprint");
  const [blueprintArticleId, setBlueprintArticleId] = useState<number | null>(null);
  const [search, setSearch] = useState("");
  const [hits, setHits] = useState<ArticleHit[]>([]);
  const [article, setArticle] = useState<ArticleHit | null>(null);
  const [serial, setSerial] = useState("");
  const [parentId, setParentId] = useState<number | null>(initialParentId);
  const [locationId, setLocationId] = useState<number | null>(null);
  const [inspectionRequired, setInspectionRequired] = useState(false);
  // Inline type creation. Separate from `busy` (which the page owns for the
  // machine POST): this one is the dialog's own request and must not disable
  // the page's other actions.
  const [creatingType, setCreatingType] = useState(false);
  const [createTypeError, setCreateTypeError] = useState<string>("");
  const [intervalDays, setIntervalDays] = useState("365");
  const [lastInspected, setLastInspected] = useState("");
  const [purchased, setPurchased] = useState("");
  const [notes, setNotes] = useState("");
  const [printLabel, setPrintLabel] = useState(true);

  /**
   * One entry per type already in the register, newest unit first.
   *
   * Grouped by ARTICLE rather than listed per machine, because "we already have
   * a Makita 5Ah" is a statement about the type. Showing five identical rows
   * for five identical batteries would make the user choose between things that
   * are, for this purpose, the same.
   */
  const blueprints = useMemo<Blueprint[]>(() => {
    const byArticle = new Map<number, Blueprint>();
    for (const machine of blueprintCandidates) {
      const existing = byArticle.get(machine.article_id);
      if (existing) {
        existing.count += 1;
        // Keep the most recently registered unit as the settings source: it is
        // the one most likely to reflect how this type is handled today.
        if (machine.created_at > existing.source.created_at) existing.source = machine;
        continue;
      }
      byArticle.set(machine.article_id, {
        article_id: machine.article_id,
        article_name: machine.article_name ?? (de ? "Unbekannter Artikel" : "Unknown article"),
        manufacturer: machine.manufacturer,
        count: 1,
        source: machine,
      });
    }
    return [...byArticle.values()].sort((a, b) => a.article_name.localeCompare(b.article_name));
  }, [blueprintCandidates, de]);

  const selectedBlueprint = useMemo(
    () => blueprints.find((b) => b.article_id === blueprintArticleId) ?? null,
    [blueprints, blueprintArticleId],
  );

  useEffect(() => {
    if (!open) return;
    // Blueprint is the default whenever there is anything to copy — registering
    // the fourth identical battery is far more common than introducing a type
    // the workshop has never owned.
    setMode(blueprintCandidates.length > 0 ? "blueprint" : "article");
    setBlueprintArticleId(initialBlueprintArticleId);
    setSearch("");
    setHits([]);
    setArticle(null);
    setSerial("");
    setParentId(initialParentId);
    setLocationId(null);
    setInspectionRequired(false);
    setIntervalDays("365");
    setLastInspected("");
    setPurchased("");
    setNotes("");
    setPrintLabel(true);
  }, [open, initialParentId, initialBlueprintArticleId, blueprintCandidates.length]);

  /**
   * Adopt the blueprint's settings.
   *
   * Copies what is true of the TYPE — inspection cycle, where this kind lives —
   * and never what is true of the individual: not the serial, not the notes,
   * and emphatically not `last_inspected_at`. A battery unboxed this morning
   * has not been DGUV3-tested just because its older sibling was.
   */
  useEffect(() => {
    if (!open || mode !== "blueprint" || !selectedBlueprint) return;
    const { source } = selectedBlueprint;
    setInspectionRequired(source.inspection_required);
    setIntervalDays(
      source.inspection_interval_days != null ? String(source.inspection_interval_days) : "365",
    );
    setLocationId(source.current_location_id);
  }, [open, mode, selectedBlueprint]);

  // Debounced article lookup. Skipped once an article is chosen — the field is
  // then showing that choice, not a query.
  useEffect(() => {
    if (!open || article || !search.trim()) {
      setHits([]);
      return;
    }
    const handle = window.setTimeout(async () => {
      try {
        setHits(
          await apiFetch<ArticleHit[]>(
            `/werkstatt/articles?q=${encodeURIComponent(search.trim())}&limit=20`,
            token,
          ),
        );
      } catch {
        // A failed lookup shows as "no matches"; the page-level error banner
        // would be wrong here because nothing the user did has failed yet.
        setHits([]);
      }
    }, 250);
    return () => window.clearTimeout(handle);
  }, [open, search, article, token]);

  const liveLocations = useMemo(
    () => locations.filter((location) => !location.is_archived),
    [locations],
  );

  if (!open) return null;

  const parsedInterval = Number.parseInt(intervalDays, 10);
  const intervalInvalid =
    inspectionRequired &&
    (!Number.isFinite(parsedInterval) || parsedInterval < 1 || parsedInterval > 3650);

  /** Whichever way the type was chosen, this is the article we will post. */
  const resolvedArticleId =
    mode === "blueprint" ? selectedBlueprint?.article_id ?? null : article?.id ?? null;
  const canSubmit = resolvedArticleId !== null && !intervalInvalid && !busy;

  /**
   * Create the catalogue article for a type that does not exist yet, then
   * select it — so registering a brand-new tool model is one flow.
   *
   * This was the dead end behind "the add button is always grey": a machine
   * must reference an article, the search found nothing for a new model, and
   * the only way on was to leave, create the article elsewhere, and come back.
   * The hint even sent people to the wrong tab ("Katalog" is the supplier
   * catalogue). Nothing but a name is needed here — creating the machine
   * against it marks the article serialised itself.
   */
  async function createTypeFromSearch() {
    const name = search.trim();
    if (!name || creatingType || !canCreateType) return;
    setCreatingType(true);
    setCreateTypeError("");
    try {
      const created = await apiFetch<ArticleHit & { category_name?: string | null }>(
        "/werkstatt/articles",
        token,
        { method: "POST", body: JSON.stringify({ item_name: name }) },
      );
      setArticle({
        id: created.id,
        article_number: created.article_number,
        item_name: created.item_name,
        manufacturer: created.manufacturer ?? null,
        category_name: created.category_name ?? null,
      });
      setSearch("");
    } catch (err) {
      const status = (err as { status?: number })?.status;
      setCreateTypeError(
        status === 403
          ? de
            ? "Keine Berechtigung, Artikel anzulegen."
            : "Not allowed to create articles."
          : err instanceof Error && err.message
            ? err.message
            : de
              ? "Artikel konnte nicht angelegt werden."
              : "The article could not be created.",
      );
    } finally {
      setCreatingType(false);
    }
  }

  function submit() {
    if (resolvedArticleId === null || !canSubmit) return;
    onConfirm(
      {
        article_id: resolvedArticleId,
        serial_number: serial.trim() || null,
        parent_unit_id: parentId,
        current_location_id: locationId,
        // Left undefined when unchecked so the article's own DGUV3 defaults
        // still apply — the service falls back to them, and sending `false`
        // here would silently opt every new drill out of the inspection its
        // type requires.
        inspection_required: inspectionRequired ? true : undefined,
        inspection_interval_days: inspectionRequired ? parsedInterval : undefined,
        last_inspected_at: lastInspected
          ? localDateTimeInputToIso(`${lastInspected}T12:00`)
          : null,
        purchased_at: purchased ? localDateTimeInputToIso(`${purchased}T12:00`) : null,
        notes: notes.trim() || null,
      },
      { printLabel },
    );
  }

  return (
    <div className="werkstatt-modal-backdrop" role="presentation" onClick={onClose}>
      <div
        className="werkstatt-modal"
        role="dialog"
        aria-modal="true"
        aria-label={de ? "Neue Maschine" : "New machine"}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="werkstatt-modal-head">
          <div>
            <span className="werkstatt-sub-breadcrumb">
              {de ? "WERKSTATT › MASCHINEN" : "WORKSHOP › MACHINES"}
            </span>
            <h2 className="werkstatt-modal-title">
              {parentId === null
                ? de
                  ? "Neue Maschine"
                  : "New machine"
                : de
                  ? "Komponente hinzufügen"
                  : "Add component"}
            </h2>
          </div>
          <button
            type="button"
            className="werkstatt-modal-close"
            onClick={onClose}
            aria-label={de ? "Schließen" : "Close"}
          >
            ✕
          </button>
        </header>

        <div className="werkstatt-modal-body werkstatt-modal-body--stacked">
          {/* Only offered when there is something to copy. On an empty
              register the toggle would be a dead control. */}
          {blueprints.length > 0 && (
            <div className="werkstatt-field">
              <span className="werkstatt-field-label">{de ? "Typ wählen" : "Choose a type"}</span>
              <div className="werkstatt-segmented werkstatt-segmented--fill" role="tablist">
                <button
                  type="button"
                  role="tab"
                  aria-selected={mode === "blueprint"}
                  className={`werkstatt-segmented-btn${
                    mode === "blueprint" ? " werkstatt-segmented-btn--active" : ""
                  }`}
                  onClick={() => setMode("blueprint")}
                >
                  {de ? "Vorhandene als Vorlage" : "Copy an existing one"}
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={mode === "article"}
                  className={`werkstatt-segmented-btn${
                    mode === "article" ? " werkstatt-segmented-btn--active" : ""
                  }`}
                  onClick={() => setMode("article")}
                >
                  {de ? "Neuer Typ aus Katalog" : "New type from catalogue"}
                </button>
              </div>
            </div>
          )}

          {mode === "blueprint" && blueprints.length > 0 && (
            <div className="werkstatt-field">
              <span className="werkstatt-field-label">
                {de ? "Vorlage" : "Blueprint"}
              </span>
              <ul className="werkstatt-machine-hits werkstatt-blueprint-list">
                {blueprints.map((blueprint) => {
                  const active = blueprint.article_id === blueprintArticleId;
                  return (
                    <li key={blueprint.article_id}>
                      <button
                        type="button"
                        className={`werkstatt-machine-hit werkstatt-blueprint${
                          active ? " werkstatt-blueprint--active" : ""
                        }`}
                        onClick={() => setBlueprintArticleId(blueprint.article_id)}
                      >
                        <span className="werkstatt-machine-hit-name">
                          {blueprint.article_name}
                        </span>
                        <span className="werkstatt-machine-hit-meta">
                          {blueprint.manufacturer ? `${blueprint.manufacturer} · ` : ""}
                          {de
                            ? `${blueprint.count} bereits erfasst`
                            : `${blueprint.count} already registered`}
                          {blueprint.source.inspection_required
                            ? ` · DGUV3 ${blueprint.source.inspection_interval_days ?? "?"} ${
                                de ? "Tage" : "days"
                              }`
                            : ""}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
              {selectedBlueprint && (
                <span className="werkstatt-field-hint">
                  {de
                    ? "Prüfzyklus und Lagerort werden übernommen. Nummer wird vergeben — nur die Seriennummer fehlt noch."
                    : "Inspection cycle and location are copied. The number is assigned — only the serial is still needed."}
                </span>
              )}
            </div>
          )}

          {/* Conditionally RENDERED, not `hidden` — the attribute loses to this
              element's `display: flex`, so the catalogue search stayed visible
              underneath the blueprint list. */}
          {(mode === "article" || blueprints.length === 0) && (
          <div className="werkstatt-field">
            <span className="werkstatt-field-label">
              {de ? "Artikel (Typ)" : "Article (type)"}
            </span>
            {article ? (
              <div className="werkstatt-machine-picked">
                <span className="werkstatt-machine-picked-main">
                  <b>{article.item_name}</b>
                  <small>
                    {article.article_number}
                    {article.manufacturer ? ` · ${article.manufacturer}` : ""}
                  </small>
                </span>
                <button
                  type="button"
                  className="werkstatt-card-action"
                  onClick={() => {
                    setArticle(null);
                    setSearch("");
                  }}
                >
                  {de ? "Ändern" : "Change"}
                </button>
              </div>
            ) : (
              <>
                <input
                  type="text"
                  className="werkstatt-field-input"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder={
                    de
                      ? "Name, Artikelnummer oder Hersteller…"
                      : "Name, article number or manufacturer…"
                  }
                  autoFocus
                />
                {hits.length > 0 && (
                  <ul className="werkstatt-machine-hits">
                    {hits.map((hit) => (
                      <li key={hit.id}>
                        <button
                          type="button"
                          className="werkstatt-machine-hit"
                          onClick={() => setArticle(hit)}
                        >
                          <span className="werkstatt-machine-hit-name">{hit.item_name}</span>
                          <span className="werkstatt-machine-hit-meta">
                            {hit.article_number}
                            {hit.manufacturer ? ` · ${hit.manufacturer}` : ""}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                {search.trim() && hits.length === 0 && (
                  <div className="werkstatt-machine-no-type">
                    <p className="werkstatt-field-hint">
                      {de
                        ? "Kein Artikel gefunden. Eine Maschine braucht einen Artikel als Typ."
                        : "No article found. A machine needs an article as its type."}
                    </p>
                    {canCreateType ? (
                      <button
                        type="button"
                        className="werkstatt-card-action"
                        disabled={creatingType}
                        onClick={() => void createTypeFromSearch()}
                      >
                        {creatingType
                          ? de
                            ? "Wird angelegt…"
                            : "Creating…"
                          : de
                            ? `„${search.trim()}“ als neuen Typ anlegen`
                            : `Create “${search.trim()}” as a new type`}
                      </button>
                    ) : (
                      <p className="werkstatt-field-hint">
                        {de
                          ? "Unter Werkstatt → Bestand → „Neuer Artikel“ anlegen, dann hier auswählen."
                          : "Create it under Workshop → Stock → “New item”, then pick it here."}
                      </p>
                    )}
                    {createTypeError && (
                      <p className="werkstatt-field-hint werkstatt-machine-hint--warn" role="alert">
                        {createTypeError}
                      </p>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
          )}

          <div className="werkstatt-modal-form-split">
            <label className="werkstatt-field werkstatt-field--grow">
              <span className="werkstatt-field-label">
                {de ? "Seriennummer" : "Serial number"}
              </span>
              <input
                type="text"
                className="werkstatt-field-input"
                value={serial}
                onChange={(event) => setSerial(event.target.value)}
                placeholder={de ? "vom Typenschild" : "from the nameplate"}
                // In blueprint mode this is the ONE thing that distinguishes
                // the new unit from the ones it was copied from, so it takes
                // the focus rather than the type picker.
                autoFocus={mode === "blueprint" && selectedBlueprint !== null}
              />
            </label>

            <label className="werkstatt-field werkstatt-field--grow">
              <span className="werkstatt-field-label">
                {de ? "Gehört zu (optional)" : "Belongs to (optional)"}
              </span>
              <select
                className="werkstatt-field-select"
                value={parentId ?? ""}
                onChange={(event) =>
                  setParentId(event.target.value ? Number(event.target.value) : null)
                }
              >
                <option value="">
                  {de ? "— eigenständige Maschine —" : "— standalone machine —"}
                </option>
                {parentCandidates.map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {candidate.unit_number} · {candidate.article_name ?? ""}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="werkstatt-modal-form-split">
            <label className="werkstatt-field werkstatt-field--grow">
              <span className="werkstatt-field-label">{de ? "Lagerort" : "Location"}</span>
              <select
                className="werkstatt-field-select"
                value={locationId ?? ""}
                onChange={(event) =>
                  setLocationId(event.target.value ? Number(event.target.value) : null)
                }
              >
                <option value="">{de ? "— keiner —" : "— none —"}</option>
                {liveLocations.map((location) => (
                  <option key={location.id} value={location.id}>
                    {location.name}
                  </option>
                ))}
              </select>
            </label>

            <label className="werkstatt-field werkstatt-field--grow">
              <span className="werkstatt-field-label">
                {de ? "Angeschafft am" : "Purchased on"}
              </span>
              <input
                type="date"
                className="werkstatt-field-input"
                value={purchased}
                max={todayInput()}
                onChange={(event) => setPurchased(event.target.value)}
              />
            </label>
          </div>

          <label className="werkstatt-machine-check">
            <input
              type="checkbox"
              checked={inspectionRequired}
              onChange={(event) => setInspectionRequired(event.target.checked)}
            />
            <span>
              {de
                ? "Wiederkehrende Prüfung (DGUV3 / BG-Prüfung)"
                : "Recurring inspection (DGUV3)"}
            </span>
          </label>

          {inspectionRequired && (
            <div className="werkstatt-modal-form-split">
              <label className="werkstatt-field werkstatt-field--grow">
                <span className="werkstatt-field-label">
                  {de ? "Intervall (Tage)" : "Interval (days)"}
                </span>
                <input
                  type="number"
                  className="werkstatt-field-input"
                  min={1}
                  max={3650}
                  value={intervalDays}
                  onChange={(event) => setIntervalDays(event.target.value)}
                />
                {intervalInvalid && (
                  <span className="werkstatt-field-hint werkstatt-machine-hint--warn">
                    {de ? "1 bis 3650 Tage." : "1 to 3650 days."}
                  </span>
                )}
              </label>
              <label className="werkstatt-field werkstatt-field--grow">
                <span className="werkstatt-field-label">
                  {de ? "Zuletzt geprüft am" : "Last inspected on"}
                </span>
                <input
                  type="date"
                  className="werkstatt-field-input"
                  value={lastInspected}
                  max={todayInput()}
                  onChange={(event) => setLastInspected(event.target.value)}
                />
                <span className="werkstatt-field-hint">
                  {de
                    ? "Ohne Datum wird erst die nächste eingetragene Prüfung fällig gestellt."
                    : "Without a date, the due date starts at the next recorded inspection."}
                </span>
              </label>
            </div>
          )}

          <label className="werkstatt-field">
            <span className="werkstatt-field-label">{de ? "Notiz" : "Note"}</span>
            <textarea
              className="werkstatt-field-textarea"
              rows={2}
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
            />
          </label>

          {/* The machine is not usable in the workshop until its number is
              physically on it, so printing is part of registering rather than
              a separate errand somebody remembers later. */}
          <label className="werkstatt-machine-check">
            <input
              type="checkbox"
              checked={printLabel}
              onChange={(event) => setPrintLabel(event.target.checked)}
            />
            <span>
              {de
                ? "Etikett direkt drucken"
                : "Print the label straight away"}
            </span>
          </label>
        </div>

        <footer className="werkstatt-modal-foot werkstatt-modal-foot--right">
          <div className="werkstatt-modal-foot-actions">
            <button type="button" className="werkstatt-action-btn" onClick={onClose}>
              {de ? "Abbrechen" : "Cancel"}
            </button>
            <button
              type="button"
              className="werkstatt-action-btn werkstatt-action-btn--primary"
              onClick={submit}
              disabled={!canSubmit}
            >
              {busy ? (de ? "Speichere…" : "Saving…") : de ? "Anlegen" : "Create"}
            </button>
          </div>
          {/* A disabled button with no reason reads as broken — that was the
              report, verbatim. Name the one thing still missing. */}
          {!canSubmit && !busy && (
            <p className="werkstatt-field-hint werkstatt-machine-submit-reason">
              {resolvedArticleId === null
                ? mode === "blueprint"
                  ? de
                    ? "Bitte zuerst eine Vorlage auswählen."
                    : "Pick a blueprint first."
                  : de
                    ? "Bitte zuerst einen Typ auswählen."
                    : "Pick a type first."
                : de
                  ? "Prüfintervall: 1 bis 3650 Tage."
                  : "Inspection interval: 1 to 3650 days."}
            </p>
          )}
        </footer>
      </div>
    </div>
  );
}
