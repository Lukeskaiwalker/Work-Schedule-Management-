/**
 * The §14a sheet (docs/PANEL_ENCLOSURE_R4.md §8.2): the Steuersignal-
 * Klemmleiste in the first meter field from the left, opened from the field
 * bar's "§14a-Klemmen", a tap on the block in the drawing, or the finding's
 * "§14a-Klemmleiste anlegen".
 *
 * Four states (`controlSheetState`): no meter field (where the block would
 * go) · no block yet ("anlegen") · removed ("wieder anlegen") · the block —
 * its drawing at 5 px/mm with the markers at their print size, one row per
 * terminal (name, wire colour, remove), "+ Klemme", the standard reset, the
 * rail, wire, tube and length per wire, the facts the derivation decides,
 * and the footer: "Aderbeschriftung drucken" (also read-only) and "§14a-
 * Klemmleiste entfernen". Destructive steps are asked in place.
 *
 * Every change is an op (`enclosureOpsControlBlock.ts`) handed to `onOp`;
 * a name field keeps what is being typed while it has focus, because the
 * stored label is trimmed (a space typed between two words would vanish).
 */
import { useId, useMemo, useState, type ReactNode } from "react";

import { ControlBlockSvg } from "./ControlBlockSvg";
import { ConfirmStrip, SheetFrame, SheetSection } from "./EnclosureSheetFrame";
import { LengthField } from "./LengthField";
import { controlSheetState, type ControlSheetState } from "./controlBlockLayout";
import type { RunEnclosureOp } from "./useSheetStack";
import type { CatalogIndex } from "../../../utils/enclosureCatalog";
import { CONTROL_LABEL_MAX, MAX_CONTROL_TERMINALS, WIRE_COLOURS, wireColourLabel } from "../../../utils/enclosureControlBlock";
import { formatMmText } from "../../../utils/enclosureGeometry";
import {
  CONTROL_TERMINALS_FULL,
  CONTROL_TERMINAL_LAST,
  addControlBlock,
  addControlTerminal,
  removeControlBlock,
  removeControlTerminal,
  renameControlTerminal,
  resetControlBlock,
  restoreControlBlock,
  setControlBlockRail,
  setControlLabelMaterial,
  setControlTerminalColour,
  setControlWire,
  setControlWireLength,
} from "../../../utils/enclosureOpsControlBlock";
import { controlLabelFits } from "../../../utils/schaltplanStrip";
import type { ControlBlock, ControlTerminal, TubeMaterialId, WireColour, WireMm2 } from "../../../types/panelEnclosure";
import type { PanelDocument } from "../../../types/schaltplan";
import "../../../styles/schaltplan-enclosure-control.css";

export const CONTROL_SHEET_TITLE = "§14a-Klemmleiste";
export const CONTROL_SUBTITLE = "Steuersignal-Klemmleiste (BDEW / VDE-AR-N 4100)";
export const NO_CARRIER_TEXT = "Kein Zählerfeld im Schrank — die §14a-Klemmleiste sitzt im ersten Zählerfeld von links.";
export const ABSENT_TEXT = "Noch keine §14a-Klemmleiste.";
export const ABSENT_READ_ONLY_TEXT = "Keine §14a-Klemmleiste geplant.";
export const OFF_TEXT = "§14a-Klemmleiste entfernt — sie steht nicht auf der Materialliste.";
export const CREATE_LABEL = "§14a-Klemmleiste anlegen";
export const LABEL_TOO_LONG = "Zu lang für die senkrechte Beschriftung — kürzer schreiben.";
const RESET_QUESTION = "Bezeichnungen und Farben auf die sechs Standardklemmen zurücksetzen?";
const REMOVE_QUESTION = "§14a-Klemmleiste und ihre Materialzeilen entfernen?";
const TERMINAL_RANGE = "2002-1671: 0,25–4 mm²; manche Netzbetreiber verlangen 0,14–1,5 mm² — TAB prüfen.";
const SUPPLY_FACT = "Versorgung der Klemmleiste: aus dem gemessenen Bereich (nicht automatisch geplant)";

const TUBES: readonly { id: TubeMaterialId; label: string; part: string }[] = [
  { id: "wago-211-502", label: "WAGO 211-502 (Ø 4,8 · 1–2,5 mm²)", part: "211-502" },
  { id: "wago-211-501", label: "WAGO 211-501 (Ø 3,2 · 0,75–1 mm²)", part: "211-501" },
];
const WIRES: readonly WireMm2[] = [1.5, 2.5];
/** The narrow tube takes 0,75–1 mm² only. */
const NARROW_TUBE_MAX_MM2 = 1;

export interface ControlBlockSheetProps {
  document: PanelDocument;
  index: CatalogIndex;
  readOnly: boolean;
  onOp: RunEnclosureOp;
  onBack?: () => void;
  onClose: () => void;
  /** "Aderbeschriftung drucken": the host closes the stack and opens the label dialog; absent = no button. */
  onPrintWires?: () => void;
}

type Present = Extract<ControlSheetState, { kind: "present" }>;
type EditProps = { block: ControlBlock; readOnly: boolean; onOp: RunEnclosureOp };

// ── Terminal rows ────────────────────────────────────────────────────────────

interface RowProps {
  terminal: ControlTerminal;
  /** 1-based, left → right. */
  position: number;
  /** The last terminal: it cannot go (the whole block can). */
  onlyOne: boolean;
  lastHintId: string;
  readOnly: boolean;
  onOp: RunEnclosureOp;
}

function TerminalRow({ terminal, position, onlyOne, lastHintId, readOnly, onOp }: RowProps) {
  // What is being typed, while the field has focus; the stored label is trimmed.
  const [draft, setDraft] = useState<string | null>(null);
  const tooLongId = useId();
  const fits = controlLabelFits(terminal.label);
  return (
    <li className="sp-encl-control-row">
      <span className="sp-encl-control-pos" aria-hidden="true">
        {position}
      </span>
      <input
        type="text"
        className="sp-encl-control-input"
        aria-label={`Bezeichnung Klemme ${position}`}
        aria-describedby={fits ? undefined : tooLongId}
        value={draft ?? terminal.label}
        maxLength={CONTROL_LABEL_MAX}
        autoComplete="off"
        disabled={readOnly}
        onChange={(event) => {
          const value = event.target.value;
          setDraft(value);
          onOp((current) => renameControlTerminal(current, terminal.id, value));
        }}
        onBlur={() => setDraft(null)}
      />
      <select
        className="sp-encl-control-select"
        aria-label={`Aderfarbe Klemme ${position}`}
        value={terminal.color}
        disabled={readOnly}
        onChange={(event) => onOp((current) => setControlTerminalColour(current, terminal.id, event.target.value as WireColour))}
      >
        {WIRE_COLOURS.map((colour) => (
          <option key={colour} value={colour}>
            {wireColourLabel(colour)}
          </option>
        ))}
      </select>
      {readOnly ? null : (
        <button
          type="button"
          className="sp-btn sp-encl-target"
          aria-label={`Klemme ${position} „${terminal.label}“ entfernen`}
          aria-describedby={onlyOne ? lastHintId : undefined}
          disabled={onlyOne}
          onClick={() => onOp((current) => removeControlTerminal(current, terminal.id))}
        >
          Entfernen
        </button>
      )}
      {fits ? null : (
        <small id={tooLongId} className="sp-encl-control-warn sp-encl-control-row-note">
          {LABEL_TOO_LONG}
        </small>
      )}
    </li>
  );
}

function TerminalRows({ block, readOnly, onOp }: EditProps) {
  const [confirmReset, setConfirmReset] = useState(false);
  const lastHintId = useId();
  const fullHintId = useId();
  const count = block.terminals.length;
  const full = count >= MAX_CONTROL_TERMINALS;
  return (
    <SheetSection title="Klemmen">
      <ol className="sp-encl-control-rows">
        {block.terminals.map((terminal, i) => (
          <TerminalRow
            key={terminal.id}
            terminal={terminal}
            position={i + 1}
            onlyOne={count <= 1}
            lastHintId={lastHintId}
            readOnly={readOnly}
            onOp={onOp}
          />
        ))}
      </ol>
      {!readOnly && count <= 1 ? (
        <p id={lastHintId} className="sp-encl-hint">
          {CONTROL_TERMINAL_LAST}
        </p>
      ) : null}
      {readOnly ? null : (
        <div className="sp-encl-control-actions">
          <button
            type="button"
            className="sp-btn sp-encl-target"
            disabled={full}
            aria-describedby={full ? fullHintId : undefined}
            onClick={() => onOp((current) => addControlTerminal(current))}
          >
            + Klemme
          </button>
          {confirmReset ? null : (
            <button type="button" className="sp-btn sp-encl-target" onClick={() => setConfirmReset(true)}>
              Standard wiederherstellen
            </button>
          )}
        </div>
      )}
      {!readOnly && full ? (
        <p id={fullHintId} className="sp-encl-hint">
          {CONTROL_TERMINALS_FULL}
        </p>
      ) : null}
      {!readOnly && confirmReset ? (
        <ConfirmStrip
          question={RESET_QUESTION}
          confirmLabel="Ja, zurücksetzen"
          onConfirm={() => {
            setConfirmReset(false);
            onOp((current) => resetControlBlock(current));
          }}
          onCancel={() => setConfirmReset(false)}
        />
      ) : null}
    </SheetSection>
  );
}

// ── Rail, wire, tube, length ─────────────────────────────────────────────────

function Wiring({ state, readOnly, onOp }: { state: Present; readOnly: boolean; onOp: RunEnclosureOp }) {
  const { block } = state;
  const narrow = block.label_material === "wago-211-501" && block.wire_mm2 > NARROW_TUBE_MAX_MM2;
  const measured = state.measuredM === null ? "aus der Zeichnung" : `≈ ${formatMmText(state.measuredM)} m aus der Zeichnung`;
  return (
    <SheetSection title="Leitungen">
      <div className="sp-encl-control-settings">
        <label className="sp-field">
          <span className="sp-field-label">Hutschiene</span>
          <select value={block.rail ?? ""} disabled={readOnly} onChange={(event) => onOp((current) => setControlBlockRail(current, event.target.value || null))}>
            <option value="">Automatisch</option>
            {state.rails.map((rail) => (
              <option key={rail.key} value={rail.key}>
                {rail.title}
              </option>
            ))}
          </select>
        </label>
        <label className="sp-field">
          <span className="sp-field-label">Leitung</span>
          <select value={String(block.wire_mm2)} disabled={readOnly} onChange={(event) => onOp((current) => setControlWire(current, Number(event.target.value) as WireMm2))}>
            {WIRES.map((mm2) => (
              <option key={mm2} value={String(mm2)}>{`${formatMmText(mm2)} mm²`}</option>
            ))}
          </select>
        </label>
        <label className="sp-field">
          <span className="sp-field-label">Schrumpfschlauch</span>
          <select
            value={block.label_material}
            disabled={readOnly}
            onChange={(event) => onOp((current) => setControlLabelMaterial(current, event.target.value as TubeMaterialId))}
          >
            {TUBES.map((tube) => (
              <option key={tube.id} value={tube.id}>
                {tube.label}
              </option>
            ))}
          </select>
        </label>
        <LengthField
          label="Länge je Ader"
          value={block.wire_length_m}
          placeholder={measured}
          disabled={readOnly}
          onCommit={(metres) => onOp((current) => setControlWireLength(current, metres))}
        />
      </div>
      {narrow ? <p className="sp-encl-control-warn">{`211-501 passt nur auf 0,75–1 mm² — für ${formatMmText(block.wire_mm2)} mm² 211-502 wählen.`}</p> : null}
    </SheetSection>
  );
}

function targetFact(state: Present): string {
  const { target } = state;
  if (!target) return "Ziel fehlt";
  return target.name === "APZ" ? `Ziel: APZ (Feld ${target.field + 1})` : `Ziel: RfZ über dem Zähler (Feld ${target.field + 1})`;
}

function Facts({ state }: { state: Present }) {
  const tube = TUBES.find((entry) => entry.id === state.block.label_material) ?? TUBES[0];
  const facts = [
    targetFact(state),
    `Gegenstück: Lüsterklemme ${state.block.terminals.length}-polig`,
    SUPPLY_FACT,
    `Aderbeschriftung: WAGO ${tube.part}, jede Bezeichnung zweimal`,
    TERMINAL_RANGE,
  ];
  return (
    <ul className="sp-encl-control-facts" aria-label="Abgeleitet">
      {facts.map((fact) => (
        <li key={fact}>{fact}</li>
      ))}
    </ul>
  );
}

// ── The sheet ────────────────────────────────────────────────────────────────

function Footer({ readOnly, onOp, onPrintWires }: { readOnly: boolean; onOp: RunEnclosureOp; onPrintWires?: () => void }) {
  const [confirmRemove, setConfirmRemove] = useState(false);
  if (confirmRemove) {
    return (
      <ConfirmStrip
        question={REMOVE_QUESTION}
        confirmLabel="Ja, entfernen"
        onConfirm={() => {
          setConfirmRemove(false);
          onOp((current) => removeControlBlock(current));
        }}
        onCancel={() => setConfirmRemove(false)}
      />
    );
  }
  return (
    <div className="sp-encl-control-footer">
      {onPrintWires ? (
        <button type="button" className="sp-btn sp-btn--primary sp-encl-target" onClick={onPrintWires}>
          Aderbeschriftung drucken
        </button>
      ) : null}
      {readOnly ? null : (
        <button type="button" className="sp-btn sp-btn--danger sp-encl-target" onClick={() => setConfirmRemove(true)}>
          §14a-Klemmleiste entfernen
        </button>
      )}
    </div>
  );
}

function PresentSheet({ state, props }: { state: Present; props: ControlBlockSheetProps }) {
  const { readOnly, onOp, onBack, onClose, onPrintWires } = props;
  const footer = onPrintWires || !readOnly ? <Footer readOnly={readOnly} onOp={onOp} onPrintWires={onPrintWires} /> : undefined;
  return (
    <SheetFrame
      title={`${CONTROL_SHEET_TITLE} · Feld ${state.field + 1}`}
      subtitle={CONTROL_SUBTITLE}
      onBack={onBack}
      onClose={onClose}
      footer={footer}
      className="sp-encl-control-sheet"
    >
      <div className="sp-term-scroll sp-encl-control-scroll">
        <ControlBlockSvg terminals={state.block.terminals} />
      </div>
      <TerminalRows block={state.block} readOnly={readOnly} onOp={onOp} />
      <Wiring state={state} readOnly={readOnly} onOp={onOp} />
      <Facts state={state} />
    </SheetFrame>
  );
}

export function ControlBlockSheet(props: ControlBlockSheetProps) {
  const { document, index, readOnly, onOp, onBack, onClose } = props;
  const state = useMemo(() => controlSheetState(document, index), [document, index]);
  const frame = (children: ReactNode) => (
    <SheetFrame title={CONTROL_SHEET_TITLE} onBack={onBack} onClose={onClose} className="sp-encl-control-sheet">
      {children}
    </SheetFrame>
  );
  switch (state.kind) {
    case "no-carrier":
      return frame(<p className="sp-encl-empty">{NO_CARRIER_TEXT}</p>);
    case "absent":
      return frame(
        readOnly ? (
          <p className="sp-encl-empty">{ABSENT_READ_ONLY_TEXT}</p>
        ) : (
          <>
            <p className="sp-encl-empty">{ABSENT_TEXT}</p>
            <button type="button" className="sp-btn sp-btn--primary sp-encl-target" onClick={() => onOp((current) => addControlBlock(current))}>
              {CREATE_LABEL}
            </button>
          </>
        ),
      );
    case "off":
      return frame(
        <>
          <p className="sp-encl-empty">{OFF_TEXT}</p>
          {readOnly ? null : (
            <button type="button" className="sp-btn sp-btn--primary sp-encl-target" onClick={() => onOp((current) => restoreControlBlock(current))}>
              §14a-Klemmleiste wieder anlegen
            </button>
          )}
        </>,
      );
    case "present":
      return <PresentSheet state={state} props={props} />;
  }
}
