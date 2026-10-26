/**
 * "Modul für Feld {n}" (docs/PANEL_ENCLOSURE.md §3.4, §10.2, §11).
 *
 * Sections in the order the fitter looks: what is on the shelf ("Im
 * Lager"), what this login built with lately ("Zuletzt verwendet"), then the
 * rest of the catalogue ("Hager univers Z"); managers also see Hager kits on
 * the shelf the catalogue does not know ("Im Lager, nicht im Katalog").
 * Modules for the other field height cannot go into this cabinet at all, so
 * they are hidden — but counted, so nobody hunts for a kit that "vanished".
 *
 * A module goes where the fitter tapped when it fits there, else to the top
 * of the free stretch they tapped in, else to the topmost place in the field
 * where it fits — in every field it spans, for a module wider than one.
 * One that fits nowhere says why ("passt hier nicht: …") and cannot be
 * tapped. With "Vorhandene Geräte übernehmen" (on by default) a pre-fitted
 * part takes over the matching device already on the board instead of
 * adding a second Hauptschalter, and the item says which ones ("Übernimmt:
 * …"). The switches live in the sheet's stack entry when the tab passes
 * them (`switches`), so a sheet opened on top and closed again leaves them
 * as the fitter set them.
 *
 * An item's facts are the stock count and, for a part that fills only some
 * of the field, its height ("150 mm hoch"); a full-field module's height is
 * the field's and every listed one shares it.
 *
 * "Modul suchen" (docs/PANEL_ENCLOSURE_R4.md §8.1) sits in the frame's
 * toolbar, so it stays in reach while 30–40 modules scroll under it. It only
 * filters: the model (fit, claims) is built once per document, the search
 * runs over it on a deferred copy of the query, so typing never waits for
 * `fitsAt`. The query rides in the stack entry like the switches.
 */
import { useDeferredValue, useId, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from "react";

import { SheetFrame, SheetSection, UnverifiedBadge } from "./EnclosureSheetFrame";
import {
  hiddenHint,
  moduleHaystack,
  noMatchText,
  searchPicker,
  searchStatus,
  uncataloguedHaystack,
  type HiddenModule,
} from "./modulePickerSearch";
import { fieldHeightMm, fitsAt, freeRuns, type CatalogIndex } from "../../../utils/enclosureCatalog";
import { linkedRows } from "../../../utils/enclosureLayout";
import { placeModule, previewClaims } from "../../../utils/enclosureOps";
import { deviceLabel } from "../../../utils/schaltplanDevices";
import { DEFAULT_PICKER_SWITCHES, type PickerSwitches, type RunEnclosureOp } from "./useSheetStack";
import type { CatalogEntry, EnclosureCatalog, ModuleSpec, UncataloguedArticle } from "../../../types/panelEnclosure";
import type { PanelDevice, PanelDocument } from "../../../types/schaltplan";
import type { SearchHaystack } from "../../../utils/searchNormalize";

type Props = {
  document: PanelDocument;
  catalog: EnclosureCatalog;
  index: CatalogIndex;
  /** 0-based field. */
  field: number;
  /** The unit tapped in the drawing; null from the field bar. */
  unit: number | null;
  readOnly: boolean;
  onOp: RunEnclosureOp;
  /** The switches, when the caller keeps them (the tab: in the stack entry). Without both, the sheet keeps its own. */
  switches?: PickerSwitches;
  onSwitchesChange?: (next: PickerSwitches) => void;
  /** "Modul suchen", kept like the switches: without both, the sheet keeps its own. */
  query?: string;
  onQueryChange?: (next: string) => void;
  /** The module landed — the tab usually opens its ModuleSheet. */
  onPlaced?: (moduleId: string) => void;
  /** "Katalog verwalten" (managers): push the catalogue admin onto the stack. */
  onManageCatalog?: () => void;
  /** "Eintrag anlegen" for a shelf article the catalogue lacks (managers). */
  onCreateEntry?: (item: UncataloguedArticle) => void;
  onBack?: () => void;
  onClose: () => void;
};

type SectionKey = "stock" | "recent" | "catalog";
const SECTION_TITLES: Readonly<Record<SectionKey, string>> = {
  stock: "Im Lager",
  recent: "Zuletzt verwendet",
  catalog: "Hager univers Z",
};

interface PickerItem {
  entry: CatalogEntry<ModuleSpec>;
  spec: ModuleSpec;
  /** Where it would go; null = fits nowhere in this field. */
  unit: number | null;
  refusal: string | null;
  claims: string[];
  adopts: boolean;
  haystack: SearchHaystack;
}

interface PickerModel {
  sections: { key: SectionKey; items: PickerItem[] }[];
  /** The other field height's modules: counted (and searched), never listed. */
  hidden: HiddenModule[];
}

function sectionOf(entry: CatalogEntry<ModuleSpec>): SectionKey {
  if (entry.stock_available > 0) return "stock";
  return entry.recent_count > 0 ? "recent" : "catalog";
}

const range = (from: number, count: number) => Array.from({ length: Math.max(0, count) }, (_, offset) => from + offset);

/**
 * Where the module goes: the tapped unit, else the units of the free run the
 * tap fell in (top first), else every unit of the field top → bottom — which
 * finds the top of the first run that fits, and, for a module wider than one
 * field, a lower unit where every field it spans is free. Refused with the
 * reason of the roomiest free run.
 */
function target(document: PanelDocument, index: CatalogIndex, code: string, field: number, unit: number | null) {
  const cabinet = document.enclosure ? index.enclosure(document.enclosure.code) : null;
  const runs = freeRuns(document, index, field);
  const tapped = unit === null ? undefined : runs.find((run) => unit >= run.unit && unit < run.unit + run.units);
  const candidates = [
    ...(unit === null ? [] : [unit]),
    ...(tapped ? range(tapped.unit, tapped.units) : []),
    ...range(0, cabinet?.units_per_field ?? 0),
  ];
  const fit = candidates.find((candidate) => fitsAt(document, index, code, field, candidate) === null);
  if (fit !== undefined) return { unit: fit, refusal: null };
  const roomiest = runs.reduce<{ unit: number; units: number } | null>((best, run) => (best && best.units >= run.units ? best : run), null);
  return { unit: null, refusal: fitsAt(document, index, code, field, roomiest?.unit ?? unit ?? 0) };
}

const nameOf = (device: PanelDevice) => device.designation.trim() || device.label.trim();

/** "Q1 (Hauptschalter)", "P1 → Zählerplatz". */
function claimNames(document: PanelDocument, index: CatalogIndex, code: string): string[] {
  const claims = previewClaims(document, index, code);
  const byId = new Map(document.rows.flatMap((row) => row.devices).map((device) => [device.id, device] as const));
  const parts = claims.deviceIds.flatMap((id) => {
    const device = byId.get(id);
    if (!device) return [];
    const kind = deviceLabel(device.kind, document);
    return [nameOf(device) ? `${nameOf(device)} (${kind})` : kind];
  });
  const meters = claims.meterDeviceIds.flatMap((id) => {
    const device = byId.get(id);
    return device ? [`${nameOf(device) || "Zähler"} → Zählerplatz`] : [];
  });
  return [...parts, ...meters];
}

const hasDistributionRails = (spec: ModuleSpec) =>
  spec.zones.some((zone) => (zone.type === "VT" || zone.type === "VF") && zone.rails.some((rail) => !rail.retired));

function pickerModel(document: PanelDocument, catalog: EnclosureCatalog, index: CatalogIndex, field: number, unit: number | null): PickerModel {
  const cabinet = document.enclosure ? index.enclosure(document.enclosure.code) : null;
  if (!cabinet) return { sections: [], hidden: [] };
  const height = fieldHeightMm(cabinet);
  const hidden: HiddenModule[] = [];
  const buckets: Record<SectionKey, PickerItem[]> = { stock: [], recent: [], catalog: [] };
  for (const entry of catalog.modules ?? []) {
    const spec = index.module(entry.code);
    if (!spec || entry.archived) continue;
    const haystack = moduleHaystack(spec, entry.article);
    if (spec.field_height_mm !== null && spec.field_height_mm !== height) {
      hidden.push({ height: spec.field_height_mm, haystack });
      continue;
    }
    const place = target(document, index, spec.code, field, unit);
    buckets[sectionOf(entry)].push({
      entry,
      spec,
      ...place,
      claims: claimNames(document, index, spec.code),
      adopts: hasDistributionRails(spec),
      haystack,
    });
  }
  const sections = (Object.keys(SECTION_TITLES) as SectionKey[])
    .map((key) => ({ key, items: buckets[key] }))
    .filter((section) => section.items.length > 0);
  return { sections, hidden };
}

/** Rows outside the cabinet that hold devices — what "Vorhandene Reihen übernehmen" would hang onto rails. */
function outsideRowCount(document: PanelDocument, index: CatalogIndex): number {
  const links = linkedRows(document, index);
  return document.rows.filter((row) => !links.has(row.id) && row.devices.length > 0).length;
}

type ItemProps = { item: PickerItem; unitMm: number; claim: boolean; readOnly: boolean; onPick: (item: PickerItem) => void };

function ModuleItem({ item, unitMm, claim, readOnly, onPick }: ItemProps) {
  const { entry, spec, refusal, claims } = item;
  // A full-field module is as tall as the field (other heights are hidden): only a part says its height.
  const height = spec.field_height_mm === null ? `${spec.height_units * unitMm} mm hoch` : "";
  const facts = [height, entry.stock_available > 0 ? `${entry.stock_available} im Lager` : ""];
  const claimText = claim && claims.length > 0 ? `Übernimmt: ${claims.join(", ")}` : "";
  const refusalText = refusal ? `passt hier nicht: ${refusal}` : "";
  // One spoken line with pauses; the visual parts would run together ("ZU37KSModul …").
  const spoken = [spec.code, spec.name, ...facts, spec.verified ? "" : "ungeprüft", claimText, refusalText].filter(Boolean).join(", ");
  return (
    <button
      type="button"
      className={["sp-palette-item", "sp-encl-item", refusal ? "sp-encl-item--refused" : ""].filter(Boolean).join(" ")}
      disabled={readOnly || item.unit === null}
      aria-label={spoken}
      onClick={() => onPick(item)}
    >
      <span className="sp-palette-text">
        <b>{spec.code}</b>
        <small>{spec.name}</small>
        <small>{facts.filter(Boolean).join(" · ")}</small>
        {claimText ? <small className="sp-encl-item-claims">{claimText}</small> : null}
        {refusalText ? <small className="sp-encl-item-refusal">{refusalText}</small> : null}
      </span>
      {spec.verified ? null : <UnverifiedBadge />}
    </button>
  );
}

function Uncatalogued({ items, onCreateEntry }: { items: UncataloguedArticle[]; onCreateEntry?: (item: UncataloguedArticle) => void }) {
  return (
    <SheetSection title="Im Lager, nicht im Katalog">
      <ul className="sp-encl-list">
        {items.map((item) => (
          <li key={item.article.id} className="sp-encl-list-row">
            <span className="sp-palette-text">
              <b>{item.article.item_name}</b>
              <small>
                {item.code_guess} · {item.article.stock_available} im Lager
              </small>
            </span>
            {onCreateEntry ? (
              <button type="button" className="sp-btn sp-encl-target" onClick={() => onCreateEntry(item)}>
                Eintrag anlegen
              </button>
            ) : null}
          </li>
        ))}
      </ul>
    </SheetSection>
  );
}

function Switch({ label, checked, disabled, onChange }: { label: string; checked: boolean; disabled: boolean; onChange: (next: boolean) => void }) {
  return (
    <label className="sp-check sp-encl-target">
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />
      <span className="sp-check-text">{label}</span>
    </label>
  );
}

/** The caller's value when it keeps it (the tab: in the stack entry), else the sheet's own. */
function useKept<T>(kept: T | undefined, onChange: ((next: T) => void) | undefined, initial: T) {
  const [own, setOwn] = useState<T>(initial);
  const controlled = kept !== undefined && onChange !== undefined;
  const value = controlled ? kept : own;
  const set = (next: T) => (controlled ? onChange(next) : setOwn(next));
  return [value, set] as const;
}

function useSwitches(switches: PickerSwitches | undefined, onChange: ((next: PickerSwitches) => void) | undefined) {
  const [value, setValue] = useKept(switches, onChange, DEFAULT_PICKER_SWITCHES);
  return [value, (patch: Partial<PickerSwitches>) => setValue({ ...value, ...patch })] as const;
}

type SearchProps = { query: string; status: string; inputRef: RefObject<HTMLInputElement>; onChange: (next: string) => void; onClear: () => void };

/** Enter puts the keyboard away: there is no form to submit, and the list already shows the hits. */
function blurOnEnter(event: KeyboardEvent<HTMLInputElement>) {
  if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
  event.preventDefault();
  event.currentTarget.blur();
}

function SearchBox({ query, status, inputRef, onChange, onClear }: SearchProps) {
  const id = useId();
  return (
    <div className="sp-encl-search" role="search">
      <div className="sp-encl-search-head">
        <label className="sp-field-label" htmlFor={id}>
          Modul suchen
        </label>
        <span role="status" className="sp-encl-search-status">
          {status}
        </span>
      </div>
      <div className="sp-encl-search-row">
        <input
          ref={inputRef}
          id={id}
          type="search"
          value={query}
          placeholder="Code, Bezeichnung oder Artikelnummer"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="none"
          spellCheck={false}
          enterKeyHint="search"
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={blurOnEnter}
        />
        {query ? (
          <button type="button" className="sp-encl-search-clear" aria-label="Suche löschen" onClick={onClear}>
            ×
          </button>
        ) : null}
      </div>
    </div>
  );
}

function NoMatch({ query, onClear }: { query: string; onClear: () => void }) {
  return (
    <div className="sp-encl-search-empty">
      <p className="sp-encl-empty">{noMatchText(query)}</p>
      <button type="button" className="sp-btn sp-encl-target" onClick={onClear}>
        Suche löschen
      </button>
    </div>
  );
}

export function ModulePickerSheet(props: Props) {
  const { document, catalog, index, field, unit, readOnly, onOp, onPlaced, onManageCatalog, onCreateEntry, onBack, onClose } = props;
  const [{ claim, adopt }, setSwitches] = useSwitches(props.switches, props.onSwitchesChange);
  const [query, setQuery] = useKept(props.query, props.onQueryChange, "");
  const deferredQuery = useDeferredValue(query);
  const inputRef = useRef<HTMLInputElement>(null);
  const model = useMemo(() => pickerModel(document, catalog, index, field, unit), [document, catalog, index, field, unit]);
  const outside = useMemo(() => outsideRowCount(document, index), [document, index]);
  const cabinet = document.enclosure ? index.enclosure(document.enclosure.code) : null;
  const unitMm = cabinet?.unit_mm ?? 150;
  const manager = catalog.can_manage === true;
  const uncatalogued = catalog.uncatalogued;
  const shelf = useMemo(
    () => (manager ? (uncatalogued ?? []).map((item) => ({ item, haystack: uncataloguedHaystack(item) })) : []),
    [manager, uncatalogued],
  );
  const view = useMemo(() => searchPicker({ sections: model.sections, hidden: model.hidden, shelf }, deferredQuery), [model, shelf, deferredQuery]);
  const clearSearch = () => {
    setQuery("");
    inputRef.current?.focus();
  };

  const pick = (item: PickerItem) => {
    if (item.unit === null) return;
    const args = { code: item.spec.code, field, unit: item.unit, claim, adoptRows: adopt && item.adopts };
    onOp(
      (current, idx) => placeModule(current, idx, args),
      (result) => {
        if (result.moduleId) onPlaced?.(result.moduleId);
      },
    );
  };

  return (
    <SheetFrame
      title={`Modul für Feld ${field + 1}`}
      subtitle={cabinet ? cabinet.code : undefined}
      onBack={onBack}
      onClose={onClose}
      toolbar={
        cabinet ? (
          <SearchBox query={query} status={searchStatus(view.searching, view.count)} inputRef={inputRef} onChange={setQuery} onClear={clearSearch} />
        ) : undefined
      }
    >
      {!cabinet ? <p className="sp-encl-empty">Noch kein Schrank geplant.</p> : null}
      {cabinet ? (
        <div className="sp-encl-switches">
          <Switch label="Vorhandene Geräte übernehmen" checked={claim} disabled={readOnly} onChange={(next) => setSwitches({ claim: next })} />
          {outside > 0 ? (
            <Switch
              label={`Vorhandene Reihen übernehmen (${outside})`}
              checked={adopt}
              disabled={readOnly}
              onChange={(next) => setSwitches({ adopt: next })}
            />
          ) : null}
        </div>
      ) : null}
      {view.searching && view.count === 0 ? <NoMatch query={deferredQuery} onClear={clearSearch} /> : null}
      {view.sections.map((section) => (
        <SheetSection key={section.key} title={SECTION_TITLES[section.key]}>
          <div className="sp-palette-grid">
            {section.items.map((item) => (
              <ModuleItem key={item.spec.code} item={item} unitMm={unitMm} claim={claim} readOnly={readOnly} onPick={pick} />
            ))}
          </div>
        </SheetSection>
      ))}
      {view.hidden.map((hidden) => (
        <p key={hidden.height} className="sp-encl-hint">
          {hiddenHint(hidden, view.searching)}
        </p>
      ))}
      {view.shelf.length > 0 ? <Uncatalogued items={view.shelf.map((entry) => entry.item)} onCreateEntry={onCreateEntry} /> : null}
      {manager && onManageCatalog ? (
        <button type="button" className="sp-btn sp-btn--ghost sp-encl-target" onClick={onManageCatalog}>
          Katalog verwalten
        </button>
      ) : null}
    </SheetFrame>
  );
}
