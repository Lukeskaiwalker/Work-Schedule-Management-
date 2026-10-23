/**
 * "Reihenklemmen · Feld {n}" — the close-up sheet of the Schrank tab
 * (docs/PANEL_ENCLOSURE_R2.md §7.2, §7.4, R11–R13).
 *
 * Top → bottom:
 *  - banners: a stored split that no longer fits ("Reihenfolge
 *    zurücksetzen"), and per terminal rail that still carries devices the
 *    reserved-rail warning with "Vorschlag ausführen" (the vacate),
 *    "Geräte bearbeiten" (its RailSheet) and "Platzhalter entfernen";
 *  - the drawing (`TerminalCloseupSvg`): both rails, every text fitted by
 *    the shared rule — a tap on a terminal shows its texts in full below;
 *  - the strip tools for the selected strip: "Nach links", "Nach rechts",
 *    "Auf Hutschiene 1/2", "Reihenfolge zurücksetzen" (a stored order only).
 *    A whole strip moves (owner, 2026-10-22); the terminals inside a Leiste
 *    follow the breakers' order;
 *  - "Ohne Platz": the strips that fit neither rail, the finding's sentence
 *    and its action;
 *  - one card per strip, as on the Klemmen tab (the tapped terminal's row
 *    highlighted), and the legend's two assumptions.
 *
 * The sheet edits nothing itself: moves, the reset and the suggestions go
 * back to the tab, which runs them with the one-step Rückgängig.
 */
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";

import { SheetFrame, SheetSection } from "./EnclosureSheetFrame";
import { TerminalCloseupSvg } from "./TerminalCloseupSvg";
import { closeupLayout, type CloseupLayout, type ItemLayout } from "./terminalCloseupLayout";
import { TerminalStripCard } from "../TerminalGroupCard";
import type { CatalogIndex } from "../../../utils/enclosureCatalog";
import { formatMmText } from "../../../utils/enclosureGeometry";
import { stripMoveOverMm, type StripTarget } from "../../../utils/enclosureOpsTerminals";
import type { BoardTerminals } from "../../../utils/enclosureTerminals";
import type { TerminalGroup, TerminalStrip } from "../../../utils/schaltplanTerminals";
import type { TerminalCloseup, TerminalPlacement, TerminalSuggestion } from "../../../types/panelEnclosure";
import type { PanelDocument, PanelFinding } from "../../../types/schaltplan";
import "../../../styles/schaltplan-enclosure-terminals.css";

export const RESERVED_RAIL_TEXT = "Diese Hutschiene ist für Reihenklemmen reserviert — Geräte tiefer setzen.";
export const CLOSEUP_LEGEND = "Beschriftung oben gezeichnet (WAGO: Mitte/seitlich) · Abschlussplatte rechts angenommen";
const orderIgnoredText = (field: number) => `Feld ${field}: Die manuelle Aufteilung der Klemmleisten passt nicht mehr — automatisch verteilt.`;
const emptyText = (field: number) => `Noch keine Reihenklemmen in Feld ${field} — Stromkreise mit „Reihenklemme“ erscheinen hier.`;

export interface TerminalCloseupSheetProps {
  document: PanelDocument;
  index: CatalogIndex;
  terms: BoardTerminals;
  closeup: TerminalCloseup;
  placement: TerminalPlacement;
  suggestions: readonly TerminalSuggestion[];
  findings: readonly PanelFinding[];
  readOnly: boolean;
  selectedStripId: string | null;
  onSelectStrip: (stripId: string | null) => void;
  onMove: (stripId: string, target: StripTarget) => void;
  onReset: (field: number) => void;
  onRunSuggestion: (suggestion: TerminalSuggestion) => void;
  onOpenRail: (moduleId: string, railKey: string, deviceId: string | null) => void;
  onBack?: () => void;
  onClose: () => void;
}

type Props = TerminalCloseupSheetProps;

function Button({ label, onClick, disabled = false, primary = false }: { label: string; onClick: () => void; disabled?: boolean; primary?: boolean }) {
  return (
    <button type="button" className={`sp-btn${primary ? " sp-btn--primary" : ""} sp-encl-target`} disabled={disabled} onClick={onClick}>
      {label}
    </button>
  );
}

function OrderBanner({ closeup, readOnly, onReset }: Pick<Props, "closeup" | "readOnly" | "onReset">) {
  if (closeup.order !== "ignored") return null;
  return (
    <div className="sp-term-banner" role="note">
      <p>{orderIgnoredText(closeup.field + 1)}</p>
      {readOnly ? null : <Button label="Reihenfolge zurücksetzen" onClick={() => onReset(closeup.field)} />}
    </div>
  );
}

/** Per terminal rail with devices or placeholders on its row: the warning and what to do about it. */
function RailBanners(props: Props) {
  const { closeup, placement, suggestions, findings, readOnly, onRunSuggestion, onOpenRail } = props;
  const placed = placement.fields.find((field) => field.field === closeup.field);
  return (
    <>
      {closeup.rails.map((rail, at) => {
        const rowId = placed?.rails[at]?.rowId ?? null;
        if (!rowId) return null;
        const vacate = suggestions.find((s) => s.kind === "relink_rows" && s.scopes.includes(rowId));
        const placeholders = suggestions.find((s) => s.kind === "remove_placeholders" && s.scopes.includes(rowId));
        if (rail.devices.length === 0 && !placeholders) return null;
        const notes = findings.filter((finding) => finding.scope === rowId && (finding.rule === "encl.terminal_rail_devices" || finding.rule === "encl.terminal_placeholders"));
        return (
          <div key={`${rail.moduleId}:${rail.railKey}`} className="sp-term-banner sp-term-banner--warn" role="note">
            <b>{rail.title}</b>
            {rail.devices.length > 0 ? <p>{RESERVED_RAIL_TEXT}</p> : null}
            {notes.map((finding) => (
              <small key={finding.rule}>{finding.message}</small>
            ))}
            {readOnly ? null : (
              <div className="sp-term-banner-actions">
                {vacate ? <Button primary label="Vorschlag ausführen" onClick={() => onRunSuggestion(vacate)} /> : null}
                {rail.devices.length > 0 ? <Button label="Geräte bearbeiten" onClick={() => onOpenRail(rail.moduleId, rail.railKey, null)} /> : null}
                {placeholders ? <Button label="Platzhalter entfernen" onClick={() => onRunSuggestion(placeholders)} /> : null}
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}

/** Where the strip is: its rail (−1 without place) and its index there. */
function stripPlace(layout: CloseupLayout, closeup: TerminalCloseup, stripId: string): { rail: number; at: number; lists: string[][] } {
  const lists = layout.rails.map((rail) => rail.strips.map((strip) => strip.stripId));
  const rail = lists.findIndex((ids) => ids.includes(stripId));
  if (rail >= 0) return { rail, at: lists[rail].indexOf(stripId), lists };
  return { rail: closeup.unplaced.some((strip) => strip.stripId === stripId) ? -1 : -2, at: -1, lists };
}

function StripTools({ props, layout }: { props: Props; layout: CloseupLayout }) {
  const { closeup, selectedStripId, onMove, onReset } = props;
  const field = closeup.field;
  const place = selectedStripId ? stripPlace(layout, closeup, selectedStripId) : null;
  const move = (rail: 0 | 1, at: number) => selectedStripId && onMove(selectedStripId, { field, rail, at });
  const railCount = layout.rails.length;
  const end = (rail: number) => place?.lists[rail]?.length ?? 0;
  const inRail = place !== null && place.rail >= 0;
  return (
    <div className="sp-term-tools" role="group" aria-label="Klemmleiste verschieben">
      {place && place.rail >= -1 ? (
        <>
          {inRail ? (
            <>
              <Button label="Nach links" disabled={place.at <= 0} onClick={() => move(place.rail as 0 | 1, place.at - 1)} />
              <Button label="Nach rechts" disabled={place.at >= end(place.rail) - 1} onClick={() => move(place.rail as 0 | 1, place.at + 1)} />
            </>
          ) : null}
          {place.rail !== 0 ? <Button label="Auf Hutschiene 1" onClick={() => move(0, end(0))} /> : null}
          {place.rail !== 1 && railCount > 1 ? <Button label="Auf Hutschiene 2" onClick={() => move(1, place.rail === 0 ? 0 : end(1))} /> : null}
        </>
      ) : (
        <p className="sp-term-hint">Klemmleiste antippen, um sie zu verschieben.</p>
      )}
      {closeup.order === "manual" ? <Button label="Reihenfolge zurücksetzen" onClick={() => onReset(field)} /> : null}
    </div>
  );
}

function Detail({ item }: { item: ItemLayout }) {
  const { xLabel, partNo, marker, levels, forText, cable } = item.item;
  return (
    <section className="sp-term-detail" aria-label={`Klemme ${xLabel}.${item.position}`}>
      <dl>
        <dt>Klemme</dt>
        <dd>{`${xLabel}.${item.position} · ${partNo}`}</dd>
        <dt>Beschriftung</dt>
        <dd>{marker || "—"}</dd>
        <dt>Leiter</dt>
        <dd>{levels.length > 0 ? levels.join(" · ") : "—"}</dd>
        <dt>für</dt>
        <dd>{forText || "—"}</dd>
        <dt>Leitung</dt>
        <dd>{cable || "—"}</dd>
      </dl>
    </section>
  );
}

function Unplaced({ props }: { props: Props }) {
  const { closeup, suggestions, findings, readOnly, selectedStripId, onSelectStrip, onRunSuggestion } = props;
  if (closeup.unplaced.length === 0) return null;
  const sentence = findings.find((finding) => finding.rule === "encl.terminals_overflow" && finding.message.startsWith(`Feld ${closeup.field + 1}:`));
  const move = suggestions.find((s) => s.kind === "move_group" && s.field === closeup.field);
  return (
    <SheetSection title="Ohne Platz" className="sp-term-unplaced">
      <ul className="sp-term-unplaced-list">
        {closeup.unplaced.map((strip) => (
          <li key={strip.stripId}>
            <button
              type="button"
              className="sp-btn sp-encl-target sp-term-unplaced-strip"
              aria-pressed={strip.stripId === selectedStripId}
              onClick={() => onSelectStrip(strip.stripId)}
            >
              <b>{strip.title}</b> <small>{`${formatMmText(strip.widthMm)} mm`}</small>
            </button>
          </li>
        ))}
      </ul>
      {sentence ? <p className="sp-term-sentence">{sentence.message}</p> : null}
      {move && !readOnly ? <Button primary label="Vorschlag ausführen" onClick={() => onRunSuggestion(move)} /> : null}
    </SheetSection>
  );
}

/** The cards of the field's strips, rail 1, rail 2, then without place; the tapped terminal's row marked. */
function StripCards({ props, layout, item }: { props: Props; layout: CloseupLayout; item: ItemLayout | null }) {
  const { terms, document, closeup, selectedStripId } = props;
  const box = useRef<HTMLDivElement>(null);
  const byId = useMemo(() => {
    const map = new Map<string, { group: TerminalGroup; strip: TerminalStrip }>();
    for (const group of terms.groups) for (const strip of group.strips) map.set(strip.stripId, { group, strip });
    return map;
  }, [terms]);
  const ids = [...layout.rails.flatMap((rail) => rail.strips.map((strip) => strip.stripId)), ...closeup.unplaced.map((strip) => strip.stripId)];
  useLayoutEffect(() => {
    const root = box.current;
    if (!root || !item?.item.stripId || item.position < 1) return undefined;
    const card = Array.from(root.querySelectorAll("[data-strip]")).find((element) => element.getAttribute("data-strip") === item.item.stripId);
    const rows = card ? [card.querySelectorAll("tbody tr")[item.position - 1], card.querySelectorAll(".sp-terminal-row")[item.position - 1]] : [];
    const marked = rows.filter((element): element is Element => element !== undefined);
    marked.forEach((element) => element.classList.add("is-selected"));
    return () => marked.forEach((element) => element.classList.remove("is-selected"));
  }, [item]);
  return (
    <div className="sp-term-cards" ref={box}>
      {ids.map((id) => {
        const entry = byId.get(id);
        if (!entry) return null;
        return (
          <div key={id} className={`sp-term-card${id === selectedStripId ? " is-selected" : ""}`} data-strip={id}>
            <TerminalStripCard group={entry.group} strip={entry.strip} document={document} />
          </div>
        );
      })}
    </div>
  );
}

export function TerminalCloseupSheet(props: Props) {
  const { document, index, terms, closeup, placement, readOnly, selectedStripId, onSelectStrip, onMove, onBack, onClose } = props;
  const [itemKey, setItemKey] = useState<string | null>(null);
  const layout = useMemo(() => closeupLayout(closeup), [closeup]);
  const measure = useCallback(
    (stripId: string, rail: 0 | 1, at: number) => stripMoveOverMm(document, index, stripId, { field: closeup.field, rail, at }, { terms, placement }),
    [document, index, closeup.field, terms, placement],
  );
  const item = itemKey ? layout.rails.flatMap((rail) => rail.items).find((entry) => entry.key === itemKey) ?? null : null;
  const hasStrips = layout.rails.some((rail) => rail.strips.length > 0) || closeup.unplaced.length > 0;
  const drawn = layout.rails.some((rail) => rail.items.length > 0 || rail.devices.length > 0);
  const n = closeup.field + 1;

  return (
    <SheetFrame title={`Reihenklemmen · Feld ${n}`} onBack={onBack} onClose={onClose} className="sp-term-sheet">
      <OrderBanner closeup={closeup} readOnly={readOnly} onReset={props.onReset} />
      <RailBanners {...props} />
      {hasStrips ? null : <p className="sp-encl-empty">{emptyText(n)}</p>}
      {drawn ? (
        <TerminalCloseupSvg
          closeup={closeup}
          layout={layout}
          readOnly={readOnly}
          selectedStripId={selectedStripId}
          selectedItemKey={itemKey}
          onSelectStrip={(stripId) => onSelectStrip(stripId)}
          onSelectItem={(key, stripId) => {
            setItemKey(key);
            if (stripId) onSelectStrip(stripId);
          }}
          onMoveStrip={readOnly ? undefined : onMove}
          measure={measure}
        />
      ) : null}
      {readOnly || !hasStrips ? null : <StripTools props={props} layout={layout} />}
      {item ? <Detail item={item} /> : null}
      <Unplaced props={props} />
      <StripCards props={props} layout={layout} item={item} />
      <p className="sp-term-legend">{CLOSEUP_LEGEND}</p>
    </SheetFrame>
  );
}
