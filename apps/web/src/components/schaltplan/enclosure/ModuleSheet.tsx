/**
 * One field module (docs/PANEL_ENCLOSURE.md §2.1, §10.2, §11): where it
 * sits, what came pre-fitted and what was taken out, its meter places, its
 * name — and removing it.
 *
 * Every button is one op with no dragging (gloves, D16). A move that does
 * not fit is disabled and its reason is written under the buttons — not in a
 * title: a workshop tablet shows no tooltip, and a disabled button takes no
 * tap, so text on screen is the only way the fitter learns *why*. At an edge
 * the reason names the edge ("Schon im ersten Feld."), not the fit rule.
 * "entfernt → ins Lager" is the part's state, not a
 * booking: the Materialliste turns it into a return line the Werkstatt
 * books (D6). Catalogue facts nobody has checked yet ("ungeprüft") are said
 * next to the part, so nobody orders a Hauptschalter on a guess.
 */
import { useId, useState } from "react";

import { ConfirmStrip, SheetFrame, SheetSection, UnverifiedBadge } from "./EnclosureSheetFrame";
import { formatPle, moduleRails, modulesInOrder, snapshotStale } from "./sheetModel";
import { fitsAt, meterPlaceCount, meterZones, moduleArticle, type CatalogIndex } from "../../../utils/enclosureCatalog";
import { fittingRemoved, moduleFittings } from "../../../utils/enclosureLayout";
import {
  METER_LABEL_MAX,
  METER_NUMBER_MAX,
  MODULE_LABEL_MAX,
  moveModule,
  refreshModuleSnapshot,
  removeModule,
  SAME_SIZE_ONLY,
  setFittingRemoved,
  setMeter,
  setModuleLabel,
  swapModules,
} from "../../../utils/enclosureOps";
import type { EditDocument, RunEnclosureOp } from "./useSheetStack";
import type { EnclosureFitting, EnclosureModule, ModuleSpec } from "../../../types/panelEnclosure";
import type { PanelDocument } from "../../../types/schaltplan";

const REMOVE_QUESTION =
  "Modul entfernen? Vorbestückte Geräte gehen mit; Reihen mit eigenen Geräten bleiben als „Nicht im Schrank“ im Plan.";
const REFRESH_LABEL = "Katalog geändert — Vorbestückung neu übernehmen";

type Props = {
  document: PanelDocument;
  index: CatalogIndex;
  moduleId: string;
  readOnly: boolean;
  /** Draft board: only then may the snapshot be refreshed (§3.5 rule 4). */
  draft: boolean;
  onOp: RunEnclosureOp;
  onEdit: EditDocument;
  /** Open one of the module's rails (RailSheet). Without it the rail list is not shown. */
  onOpenRail?: (moduleId: string, railKey: string) => void;
  /** The module is gone — the tab drops this sheet. Defaults to `onClose`. */
  onRemoved?: () => void;
  onBack?: () => void;
  onClose: () => void;
};

type Shared = { document: PanelDocument; index: CatalogIndex; module: EnclosureModule; readOnly: boolean; onOp: RunEnclosureOp };

// ── Position and swap ────────────────────────────────────────────────────────

type MoveKey = "left" | "right" | "up" | "down";
type Move = { key: MoveKey; label: string; to: { field: number; unit: number } };

/** At an edge, the edge — "Ragt über das letzte Feld hinaus." would not tell the fitter much on "Feld ←". */
const EDGE_TEXT: Readonly<Record<MoveKey, string>> = {
  left: "Schon im ersten Feld.",
  right: "Schon im letzten Feld.",
  up: "Schon ganz oben.",
  down: "Schon ganz unten.",
};

function atEdge(document: PanelDocument, index: CatalogIndex, module: EnclosureModule, key: MoveKey): boolean {
  const cabinet = document.enclosure ? index.enclosure(document.enclosure.code) : null;
  const spec = index.module(module.code);
  if (!cabinet || !spec) return false;
  if (key === "left") return module.field <= 0;
  if (key === "right") return module.field + spec.width_fields >= cabinet.fields;
  if (key === "up") return module.unit <= 0;
  return module.unit + spec.height_units >= cabinet.units_per_field;
}

/** Why a move is off; null when it fits. */
function moveRefusal(document: PanelDocument, index: CatalogIndex, module: EnclosureModule, move: Move): string | null {
  const reason = fitsAt(document, index, module.code, move.to.field, move.to.unit, module.id);
  if (reason === null) return null;
  return atEdge(document, index, module, move.key) ? EDGE_TEXT[move.key] : reason;
}

function Position({ document, index, module, readOnly, onOp }: Shared) {
  const [swapOpen, setSwapOpen] = useState(false);
  const reasonId = useId();
  const moves: Move[] = [
    { key: "left", label: "Feld ←", to: { field: module.field - 1, unit: module.unit } },
    { key: "right", label: "Feld →", to: { field: module.field + 1, unit: module.unit } },
    { key: "up", label: "Nach oben", to: { field: module.field, unit: module.unit - 1 } },
    { key: "down", label: "Nach unten", to: { field: module.field, unit: module.unit + 1 } },
  ];
  // Read-only, every button is off for that reason alone; nothing to explain per move.
  const refusals = moves.map((move) => ({ ...move, reason: readOnly ? null : moveRefusal(document, index, module, move) }));
  const own = index.module(module.code);
  const partners = modulesInOrder(document).filter((other) => {
    const spec = index.module(other.code);
    return other.id !== module.id && !!own && !!spec && spec.width_fields === own.width_fields && spec.height_units === own.height_units;
  });
  const swapRefused = !readOnly && partners.length === 0;
  return (
    <SheetSection title="Position">
      <div className="sp-encl-button-grid">
        {refusals.map(({ key, label, to, reason }) => (
          <button
            key={key}
            type="button"
            className="sp-btn sp-encl-target"
            disabled={readOnly || reason !== null}
            aria-describedby={reason ? `${reasonId}-${key}` : undefined}
            onClick={() => onOp((current, idx) => moveModule(current, idx, module.id, to))}
          >
            {label}
          </button>
        ))}
      </div>
      {refusals.some((move) => move.reason) ? (
        <ul className="sp-encl-reasons">
          {refusals.map(({ key, label, reason }) =>
            reason ? (
              <li key={key}>
                <b>{label}</b> <span id={`${reasonId}-${key}`}>{reason}</span>
              </li>
            ) : null,
          )}
        </ul>
      ) : null}
      <button
        type="button"
        className="sp-btn sp-encl-target"
        disabled={readOnly || partners.length === 0}
        aria-describedby={swapRefused ? `${reasonId}-swap` : undefined}
        aria-expanded={swapOpen}
        onClick={() => setSwapOpen((open) => !open)}
      >
        Mit Modul tauschen…
      </button>
      {swapRefused ? (
        <p id={`${reasonId}-swap`} className="sp-encl-reason">
          {SAME_SIZE_ONLY}
        </p>
      ) : null}
      {swapOpen && !readOnly ? (
        <div className="sp-palette-grid">
          {partners.map((other) => (
            <button
              key={other.id}
              type="button"
              className="sp-palette-item sp-encl-item"
              onClick={() => {
                setSwapOpen(false);
                onOp((current, idx) => swapModules(current, idx, module.id, other.id));
              }}
            >
              <span className="sp-palette-text">
                <b>{`Feld ${other.field + 1} · ${moduleArticle(other, index)}`}</b>
                {other.label ? <small>{other.label}</small> : null}
              </span>
            </button>
          ))}
        </div>
      ) : null}
    </SheetSection>
  );
}

// ── Pre-fitted parts ─────────────────────────────────────────────────────────

function fittingState(document: PanelDocument, module: EnclosureModule, fitting: EnclosureFitting): string {
  if (!fitting.removable) return "fest verbaut";
  return fittingRemoved(document, module, fitting) ? "entfernt → ins Lager" : "verbaut";
}

function uncheckedNote(spec: ModuleSpec | null, key: string): string | null {
  const fitting = spec?.fittings.find((candidate) => candidate.key === key);
  if (!fitting || fitting.verified) return null;
  return fitting.note.trim() ? `ungeprüft: ${fitting.note.trim()}` : "ungeprüft";
}

function Fittings({ document, index, module, readOnly, onOp }: Shared) {
  const fittings = moduleFittings(module, index);
  const spec = index.module(module.code);
  if (fittings.length === 0) return null;
  return (
    <SheetSection title="Vorbestückt">
      <ul className="sp-encl-list">
        {fittings.map((fitting) => {
          const removed = fitting.removable && fittingRemoved(document, module, fitting);
          const note = uncheckedNote(spec, fitting.key);
          return (
            <li key={fitting.key} className="sp-encl-list-row" aria-label={fitting.label}>
              <span className="sp-palette-text">
                <b>{fitting.label}</b>
                <small className={removed ? "sp-encl-state sp-encl-state--removed" : "sp-encl-state"}>
                  {fittingState(document, module, fitting)}
                  {fitting.article_no ? ` · ${fitting.article_no}` : ""}
                </small>
                {note ? <small className="sp-encl-note">{note}</small> : null}
              </span>
              {fitting.removable && !readOnly ? (
                <button
                  type="button"
                  className={removed ? "sp-btn sp-encl-target" : "sp-btn sp-btn--danger sp-encl-target"}
                  aria-label={removed ? `${fitting.label} wieder einbauen` : `${fitting.label} entfernen`}
                  onClick={() => onOp((current, idx) => setFittingRemoved(current, idx, module.id, fitting.key, !removed))}
                >
                  {removed ? "Wieder einbauen" : "Entfernen"}
                </button>
              ) : null}
            </li>
          );
        })}
      </ul>
    </SheetSection>
  );
}

// ── Meter places ─────────────────────────────────────────────────────────────

type MeterProps = { module: EnclosureModule; place: number; readOnly: boolean; onEdit: EditDocument };

function MeterPlace({ module, place, readOnly, onEdit }: MeterProps) {
  const meter = (module.meters ?? []).find((entry) => entry.place === place) ?? null;
  const edit = (patch: { number?: string; label?: string } | null) => onEdit((current) => setMeter(current, module.id, place, patch));
  return (
    <div className="sp-encl-sheet-meter" role="group" aria-label={`Zählerplatz ${place + 1}`}>
      <span className="sp-field-label">Zählerplatz {place + 1}</span>
      <div className="sp-encl-segmented">
        <button type="button" className="sp-btn sp-encl-target" aria-pressed={meter !== null} disabled={readOnly} onClick={() => !meter && edit({})}>
          belegt
        </button>
        <button type="button" className="sp-btn sp-encl-target" aria-pressed={meter === null} disabled={readOnly} onClick={() => meter && edit(null)}>
          frei (Blindabdeckung)
        </button>
      </div>
      {meter ? (
        <div className="sp-field-grid">
          <label className="sp-field">
            <span className="sp-field-label">Zählernummer</span>
            <input
              type="text"
              value={meter.number}
              maxLength={METER_NUMBER_MAX}
              disabled={readOnly}
              onChange={(event) => edit({ number: event.target.value })}
            />
          </label>
          <label className="sp-field">
            <span className="sp-field-label">Bezeichnung (z. B. WE 1)</span>
            <input
              type="text"
              value={meter.label}
              maxLength={METER_LABEL_MAX}
              disabled={readOnly}
              onChange={(event) => edit({ label: event.target.value })}
            />
          </label>
        </div>
      ) : null}
    </div>
  );
}

function Meters({ module, spec, readOnly, onEdit }: { module: EnclosureModule; spec: ModuleSpec | null; readOnly: boolean; onEdit: EditDocument }) {
  const count = meterPlaceCount(spec);
  if (!spec || count === 0) return null;
  const type = meterZones(spec)[0]?.meter_type === "3punkt" ? "3-Punkt" : "eHZ";
  return (
    <SheetSection title="Zählerplätze">
      <small className="sp-field-hint">{`${type} · ${count} ${count === 1 ? "Platz" : "Plätze"}`}</small>
      {Array.from({ length: count }, (_, place) => (
        <MeterPlace key={place} module={module} place={place} readOnly={readOnly} onEdit={onEdit} />
      ))}
    </SheetSection>
  );
}

// ── Rails ────────────────────────────────────────────────────────────────────

function Rails({ document, index, module, onOpenRail }: Omit<Shared, "readOnly" | "onOp"> & { onOpenRail: Props["onOpenRail"] }) {
  const rails = moduleRails(document, index, module);
  if (!onOpenRail || rails.length === 0) return null;
  return (
    <SheetSection title="Hutschienen">
      <div className="sp-palette-grid">
        {rails.map((rail) => (
          <button key={rail.railKey} type="button" className="sp-palette-item sp-encl-item" onClick={() => onOpenRail(module.id, rail.railKey)}>
            <span className="sp-palette-text">
              <b>{rail.row?.label || rail.title}</b>
              <small>{rail.row?.devices.length ? `${formatPle(rail.usedPle)} / ${rail.rail.ple} PLE` : `leer · ${rail.rail.ple} PLE`}</small>
            </span>
          </button>
        ))}
      </div>
    </SheetSection>
  );
}

// ── The sheet ────────────────────────────────────────────────────────────────

export function ModuleSheet(props: Props) {
  const { document, index, moduleId, readOnly, draft, onOp, onEdit, onOpenRail, onRemoved, onBack, onClose } = props;
  const [confirmRemove, setConfirmRemove] = useState(false);
  const module = (document.enclosure?.modules ?? []).find((candidate) => candidate.id === moduleId) ?? null;

  if (!module) {
    return (
      <SheetFrame title="Modul" onBack={onBack} onClose={onClose}>
        <p className="sp-encl-empty">Dieses Modul ist nicht mehr im Plan.</p>
      </SheetFrame>
    );
  }

  const spec = index.module(module.code);
  const shared: Shared = { document, index, module, readOnly, onOp };
  const remove = () => onOp((current, idx) => removeModule(current, idx, module.id), () => (onRemoved ?? onClose)());
  const subtitle = (
    <>
      {spec ? spec.name : "Unbekannter Katalogcode — nur als Platzhalter gezeigt."}
      {spec && !spec.verified ? <UnverifiedBadge /> : null}
    </>
  );

  return (
    <SheetFrame title={`Feld ${module.field + 1} · ${moduleArticle(module, index)}`} subtitle={subtitle} onBack={onBack} onClose={onClose}>
      <label className="sp-field">
        <span className="sp-field-label">Bezeichnung des Feldes</span>
        <input
          type="text"
          value={module.label ?? ""}
          maxLength={MODULE_LABEL_MAX}
          disabled={readOnly}
          onChange={(event) => onEdit((current) => setModuleLabel(current, module.id, event.target.value))}
        />
      </label>
      <Position {...shared} />
      <Rails document={document} index={index} module={module} onOpenRail={onOpenRail} />
      <Fittings {...shared} />
      {draft && !readOnly && snapshotStale(module, index) ? (
        <button
          type="button"
          className="sp-btn sp-encl-target"
          onClick={() => onOp((current, idx) => refreshModuleSnapshot(current, idx, module.id))}
        >
          {REFRESH_LABEL}
        </button>
      ) : null}
      <Meters module={module} spec={spec} readOnly={readOnly} onEdit={onEdit} />
      {readOnly ? null : confirmRemove ? (
        <ConfirmStrip question={REMOVE_QUESTION} confirmLabel="Ja, Modul entfernen" onConfirm={remove} onCancel={() => setConfirmRemove(false)} />
      ) : (
        <button type="button" className="sp-btn sp-btn--danger sp-encl-target" onClick={() => setConfirmRemove(true)}>
          Modul entfernen
        </button>
      )}
    </SheetFrame>
  );
}
