/**
 * The Reihenklemmen half of the print sheet: the strip list and the preview.
 * `LabelPrintDialog` owns the sheet, the state and the buttons; this file
 * only knows how a strip reads as a checkbox row and what it looks like
 * printed — derived from `utils/schaltplanTerminals.ts`, the same rules the
 * server prints with. A Leiste is drawn at the board font size with a
 * divider on every boundary, exactly like the BMK strip; a Block is the
 * owner's 60 mm blueprint with its three rows.
 *
 * The §14a block strip (docs/PANEL_ENCLOSURE_R4.md §9.1) is the list's last
 * row whenever the board has a block: its labels run across the strip at
 * its own size, so it is drawn larger and says which way it goes in. A
 * label too long for the 5,2 mm terminal disables the row — that strip is
 * never sent, the server would refuse it.
 */
import { useId } from "react";

import { BlockSvg, StripSvg, VERTICAL_PX_PER_MM, layoutSegments, previewFontPx } from "./StripSvg";
import {
  CONTROL_STRIP_ID,
  klemmenStripIds,
  labelTooLongDetail,
  type ControlStripItem,
} from "../../utils/schaltplanControlStrip";
import {
  CONTROL_SEGMENT_MM,
  STRIP_LEAD_MM,
  formatFontMm,
  formatMm,
  type BoardFontSize,
} from "../../utils/schaltplanStrip";
import type { TerminalPart } from "../../utils/schaltplanTerminalRules";
import {
  STRIP_KIND_BLOCK,
  terminalStrips,
  type TerminalGroup,
  type TerminalStrip,
  type TerminalStripItem,
} from "../../utils/schaltplanTerminals";

/** The only stock a terminal marker fits: the 11 mm strip — one per Leiste, one 60 mm piece per Block. */
export const TERMINAL_MATERIAL = {
  id: "wago-2009-110",
  label: "WAGO 2009-110",
  hint: "11 mm Endlosstreifen — ein Streifen je Klemmenleiste, ein 60-mm-Stück je Block, in den WAGO-Beschriftungsträger einschieben",
} as const;

function terminalCountLabel(count: number): string {
  return count === 1 ? "1 Klemme" : `${count} Klemmen`;
}

/**
 * The strip row's second line: "Block · 60 mm" for a Block, "6 Klemmen ·
 * 1 ohne Beschriftung · 32,8 mm" for a Leiste (no length when nothing on
 * it has a text).
 */
export function stripMeta(strip: TerminalStrip, item: TerminalStripItem | undefined): string {
  if (strip.kind === STRIP_KIND_BLOCK) {
    return `Block · ${formatMm(item?.lengthMm ?? 0)} mm`;
  }
  const markers = strip.terminals.filter((terminal) => terminal.marker).length;
  const labelled = item?.segments.length ?? 0;
  const parts = [terminalCountLabel(strip.terminals.length)];
  if (markers - labelled > 0) parts.push(`${markers - labelled} ohne Beschriftung`);
  if (item) parts.push(`${formatMm(item.lengthMm)} mm`);
  return parts.join(" · ");
}

/** Total strip the printer feeds for one piece: lead + printed length + lead. */
export function stripTotal(item: TerminalStripItem): number {
  return STRIP_LEAD_MM + item.lengthMm + STRIP_LEAD_MM;
}

/** Markers printed on a piece: the Leiste's segments, the Block's cells. */
function printedMarkers(item: TerminalStripItem): number {
  return item.kind === STRIP_KIND_BLOCK ? item.cells.length : item.segments.length;
}

/** The §14a row's second line: "6 Klemmen · senkrecht · 31,2 mm". */
export function controlStripMeta(control: ControlStripItem): string {
  return `${terminalCountLabel(control.partCount)} · senkrecht · ${formatMm(control.lengthMm)} mm`;
}

/**
 * The preview's one-line total. `skipped` is the selection's count from
 * `terminalStrips`, not a sum over the strips: a ticked Leiste with no text
 * at all has no strip, and its terminals would otherwise vanish from the line.
 * `control` is the ticked §14a strip: it adds its piece, its blanks and its
 * own size (" · §14a: 3,0 mm"); without a Leiste or Block ticked the board
 * size is left out, because nothing would print at it.
 */
export function terminalSummary(
  strips: readonly TerminalStripItem[],
  board: BoardFontSize,
  skipped: number,
  control: ControlStripItem | null = null,
): string {
  if (strips.length === 0 && !control) {
    return skipped > 0 ? `Nichts zu drucken · ${skipped} ohne Beschriftung` : "Keine Klemmenleiste ausgewählt.";
  }
  const pieces = strips.length + (control ? 1 : 0);
  const ownMarkers = control ? control.partCount - control.blankCount : 0;
  const ownTotal = control ? controlStripTotal(control) : 0;
  const labelled = strips.reduce((sum, strip) => sum + printedMarkers(strip), 0) + ownMarkers;
  const total = strips.reduce((sum, strip) => sum + stripTotal(strip), 0) + ownTotal;
  const unmarked = skipped + (control ? control.blankCount : 0);
  const font = strips.length > 0 ? ` · Schriftgröße: ${formatFontMm(board.sizeDots)} mm` : "";
  const own = control ? ` · §14a: ${formatFontMm(control.sizeDots)} mm` : "";
  const tail = unmarked > 0 ? ` · ${unmarked} ohne Beschriftung` : "";
  return `${pieces} Streifen · ${labelled} Klemmen · ${formatMm(total)} mm Material${font}${own}${tail}`;
}

/** Strip the printer feeds for the §14a piece: lead + 5,2 mm per terminal + lead. */
function controlStripTotal(control: ControlStripItem): number {
  return STRIP_LEAD_MM + control.lengthMm + STRIP_LEAD_MM;
}

/** Every strip of the board in order — the list's rows and the "Alle" set. */
export function boardStrips(groups: readonly TerminalGroup[]): TerminalStrip[] {
  return groups.flatMap((group) => group.strips);
}

type ListProps = {
  groups: readonly TerminalGroup[];
  /** The board's §14a strip — the list's last row; null without a block. */
  control?: ControlStripItem | null;
  selectedIds: readonly string[];
  onToggle: (stripId: string) => void;
  onToggleAll: () => void;
};

type ControlRowProps = {
  control: ControlStripItem;
  selectedIds: readonly string[];
  onToggle: (stripId: string) => void;
};

/** The §14a row: ticked like the others, disabled with the reason when a label cannot be printed. */
function ControlStripRow({ control, selectedIds, onToggle }: ControlRowProps) {
  const reasonId = useId();
  const refused = control.tooLong !== null;
  const checked = !refused && selectedIds.includes(CONTROL_STRIP_ID);
  return (
    <li className={checked ? "sp-label-row sp-label-row--on" : "sp-label-row"}>
      <label className="sp-label-row-main">
        <input
          type="checkbox"
          checked={checked}
          disabled={refused}
          onChange={() => onToggle(CONTROL_STRIP_ID)}
          aria-label={`${control.title} drucken`}
          aria-describedby={refused ? reasonId : undefined}
        />
        <span className="sp-label-row-text">
          <b>{control.title}</b>
          <small>{controlStripMeta(control)}</small>
          {control.tooLong !== null && (
            <small id={reasonId} className="sp-field-hint">
              {labelTooLongDetail(control.tooLong)}
            </small>
          )}
        </span>
      </label>
    </li>
  );
}

export function TerminalStripList({ groups, control = null, selectedIds, onToggle, onToggleAll }: ListProps) {
  const strips = boardStrips(groups);
  const every = klemmenStripIds(groups, control);
  const allSelected = every.length > 0 && every.every((id) => selectedIds.includes(id));
  const itemsById = new Map(terminalStrips(groups).strips.map((item) => [item.stripId, item] as const));
  return (
    <div className="sp-field">
      <div className="sp-label-rows-head">
        <span className="sp-field-label">Klemmenleisten</span>
        <button type="button" className="sp-label-toggle" onClick={onToggleAll} disabled={every.length === 0}>
          {allSelected ? "Keine" : "Alle"}
        </button>
      </div>
      {strips.length === 0 && !control ? (
        <p className="sp-label-empty">
          Noch keine Reihenklemmen — im Gerätedialog „Reihenklemme am Abgang“ setzen oder auf dem Klemmen-Tab
          alle auf einmal.
        </p>
      ) : (
        <ul className="sp-label-rows" aria-label="Klemmenleisten">
          {strips.map((strip) => {
            const checked = selectedIds.includes(strip.stripId);
            return (
              <li key={strip.stripId} className={checked ? "sp-label-row sp-label-row--on" : "sp-label-row"}>
                <label className="sp-label-row-main">
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => onToggle(strip.stripId)}
                    aria-label={`${strip.title} drucken`}
                  />
                  <span className="sp-label-row-text">
                    <b>{strip.title}</b>
                    <small>{stripMeta(strip, itemsById.get(strip.stripId))}</small>
                  </span>
                </label>
              </li>
            );
          })}
          {control && <ControlStripRow control={control} selectedIds={selectedIds} onToggle={onToggle} />}
        </ul>
      )}
    </div>
  );
}

type PreviewProps = {
  strips: readonly TerminalStripItem[];
  /** The ticked §14a strip, printable; drawn last. */
  control?: ControlStripItem | null;
  /** The selection's unmarked Leiste terminals, dropped strips included (see `terminalSummary`). */
  skipped: number;
  board: BoardFontSize;
  fontPx: number;
  unverified: readonly TerminalPart[];
};

function StripPiece({ item, fontPx }: { item: TerminalStripItem; fontPx: number }) {
  if (item.kind === STRIP_KIND_BLOCK) {
    return (
      <BlockSvg
        label={item.label}
        name={item.name}
        xLabel={item.xLabel}
        cells={layoutSegments(item.cells.map((cell, index) => ({ key: `${index}-${cell.text}`, ...cell })))}
        lengthMm={item.lengthMm}
      />
    );
  }
  return (
    <StripSvg
      label={item.label}
      segments={layoutSegments(item.segments.map((segment, index) => ({ key: `${index}-${segment.text}`, ...segment })))}
      lengthMm={item.lengthMm}
      fontPx={fontPx}
    />
  );
}

/** The §14a piece: every terminal's segment, labels across it, and which way it goes in. */
function ControlPiece({ control }: { control: ControlStripItem }) {
  const segments = layoutSegments(
    control.labels.map((text, index) => ({ key: `${index}-${text}`, text, widthMm: CONTROL_SEGMENT_MM })),
  );
  const first = control.labels.find((label) => label !== "");
  return (
    <div className="sp-strip-preview">
      <div className="sp-strip-head">
        <b>{control.title}</b>
        <small>
          {`${formatMm(controlStripTotal(control))} mm (${STRIP_LEAD_MM} + ${formatMm(control.lengthMm)} + ${STRIP_LEAD_MM})`}
        </small>
      </div>
      {first !== undefined && (
        <small className="sp-field-hint">
          {`Schrift liest von unten nach oben — so einsetzen, dass „${first}“ links steht.`}
        </small>
      )}
      <div className="sp-strip-scroll">
        <StripSvg
          vertical
          label={control.title}
          segments={segments}
          lengthMm={control.lengthMm}
          fontPx={previewFontPx(control.sizeDots, VERTICAL_PX_PER_MM)}
        />
      </div>
    </div>
  );
}

export function TerminalPreview({ strips, control = null, skipped, board, fontPx, unverified }: PreviewProps) {
  return (
    <section className="sp-label-preview" aria-label="Vorschau">
      <div className="sp-label-rows-head">
        <span className="sp-field-label">Vorschau</span>
        <small className="sp-label-summary">{terminalSummary(strips, board, skipped, control)}</small>
      </div>
      {unverified.length > 0 && (
        <p className="sp-label-warn" role="status">
          {`Breite nicht bestätigt: ${unverified.map((part) => part.partNo).join(", ")} — vor dem ersten Druck am Träger messen.`}
        </p>
      )}
      {board.overflowing.length > 0 && (
        <p className="sp-label-warn" role="status">
          {`Zu lang für die Klemme bei einheitlicher Größe: ${board.overflowing.join(", ")}`}
        </p>
      )}
      {strips.map((item) => (
        <div key={item.stripId} className="sp-strip-preview">
          <div className="sp-strip-head">
            <b>{item.label}</b>
            <small>
              {`${formatMm(stripTotal(item))} mm (${STRIP_LEAD_MM} + ${formatMm(item.lengthMm)} + ${STRIP_LEAD_MM})`}
            </small>
          </div>
          <div className="sp-strip-scroll">
            <StripPiece item={item} fontPx={fontPx} />
          </div>
        </div>
      ))}
      {control && <ControlPiece control={control} />}
    </section>
  );
}
