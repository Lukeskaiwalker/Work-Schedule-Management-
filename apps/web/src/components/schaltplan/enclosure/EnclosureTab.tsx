/**
 * The Schrank tab (docs/PANEL_ENCLOSURE.md §11, §12): the cabinet front as
 * the installer's working view.
 *
 *  - No cabinet yet: what a cabinet is here, and "Schrank wählen".
 *  - With one: the toolbar (Offen / Geschlossen / 3D, zoom, Reihen ordnen,
 *    Aufbau als PDF), the field bar — the module entry point at every zoom,
 *    56 px buttons — the drawing with its one tap rule, and the findings.
 *  - One sheet stack for everything that opens from here, one backdrop.
 *
 * Nothing in here edits the board directly: sheets hand cabinet ops to
 * `useEnclosureOpRunner` (refusal said, re-feeding confirmed, pins
 * announced), plain edits go through the editor's `mutate`, and device
 * edits through the editor's device ops — so every change autosaves, and
 * the Plan, Aufbau and Materialliste read the same board.
 *
 * 3D is a lazy chunk behind its own boundary (`Enclosure3DPane`): a chunk
 * that fails to load, or a GPU that throws, stays inside this tab. When a
 * retry cannot help (a deploy removed the chunk), "Seite neu laden" saves
 * first and reloads only once the saves landed (`reloadAfterSave`).
 *
 * On a board the viewer may not edit, the drawing has no free-unit targets
 * (`onPickSlot` absent), but rails and modules still open to be read.
 *
 * Device drag (docs/PANEL_ENCLOSURE_R2.md §6): in the Offen view of an
 * editable board a device (a group head with its circuits) is dragged onto
 * a rail; "Auf andere Hutschiene…" runs the same `dropDevice` after closing
 * the sheets. Both go through `useDropUndo`: one edit per drop, the note
 * at the bottom, one-step Rückgängig. The field's two terminal rails
 * (`terminalRailKeys`) refuse device drops.
 *
 * WAGO terminals (R2 §7, §8): the board's one derivation (`boardTerminals`
 * from the page, else the tab's own `useBoardTerminals`) feeds the drawing
 * (strips, reserved rails), the findings and their actions, the field bar's
 * "Klemmen Feld {n}" and the close-up sheet. Strip moves, the order reset
 * and every "Vorschlag ausführen" go through `useTerminalActions`: the op
 * runner's pins and confirmation, then the same note and Rückgängig.
 */
import { useCallback, useEffect, useMemo, useState } from "react";

import { DropNote } from "./DropNote";
import { describeDrop } from "./dropNoteText";
import { Enclosure3DPane, type Enclosure3DLoader } from "./Enclosure3DBoundary";
import { EnclosureFieldBar } from "./EnclosureFieldBar";
import { EnclosureFindings } from "./EnclosureFindings";
import { EnclosureFrontSvg } from "./EnclosureFrontSvg";
import { cabinetLine } from "./EnclosurePickerSheet";
import { EnclosureSheetHost, type TabSheet, type TerminalSheetContext } from "./EnclosureSheetHost";
import { EnclosureToolbar, type EnclosureViewMode } from "./EnclosureToolbar";
import { rowsInPhysicalOrder } from "./enclosureEditorModel";
import { deviceDragSource, stripDragSource, type DeviceDragSource, type DeviceDrop, type StripDragSource, type StripDrop } from "./enclosureDropTargets";
import { ENCLOSURE_ZOOM_STEPS, clampZoomStep, initialZoomStep } from "./enclosureFrontLayout";
import { useDropUndo } from "./useDropUndo";
import { useEnclosureOpRunner, type RegroupRequest } from "./useEnclosureOpRunner";
import { useSheetStack } from "./useSheetStack";
import { useTerminalActions, type TerminalActionsArgs } from "./useTerminalActions";
import { useBoardTerminals, type BoardTerminalsState } from "../../../hooks/useBoardTerminals";
import type { EnclosureCatalogState } from "../../../hooks/useEnclosureCatalog";
import type { PanelDocumentEditor } from "../../../hooks/usePanelDocumentEditor";
import type { CatalogIndex } from "../../../utils/enclosureCatalog";
import { buildEnclosureScene } from "../../../utils/enclosureGeometry";
import { orderRowsPhysically } from "../../../utils/enclosureOps";
import { dropDevice, type DropTarget } from "../../../utils/enclosureOpsDrag";
import { enclosureFindings } from "../../../utils/enclosureRules";
import { terminalCloseup } from "../../../utils/enclosureTerminalCloseup";
import { terminalSuggestions } from "../../../utils/enclosureTerminalSuggest";
import { terminalRailKeys, type BoardTerminals } from "../../../utils/enclosureTerminals";
import { reloadAfterSave, savedPdfClick } from "../../../utils/openAfterSave";
import { aufbauPdfUrl } from "../../../utils/schaltplanEnclosureApi";
import type { EnclosureSpec, TerminalPlacement, TerminalSuggestion } from "../../../types/panelEnclosure";
import type { PanelDocument, PanelFinding, PanelPlan } from "../../../types/schaltplan";
import "../../../styles/schaltplan-enclosure-tab.css";

export interface EnclosureTabProps {
  /** For the catalogue admin's writes (managers). */
  token: string | null;
  panel: PanelPlan;
  editor: PanelDocumentEditor;
  catalog: EnclosureCatalogState;
  readOnly: boolean;
  onNotice: (message: string) => void;
  onError: (message: string) => void;
  /** Tests inject the 3D chunk; the app imports `Enclosure3DView` lazily. */
  load3D?: Enclosure3DLoader;
  /** Tests inject the page reload; the app reloads the window. */
  reloadPage?: () => void;
  /**
   * A sheet to open on arrival — the other tabs' inspector hands "Auf andere
   * Hutschiene…" over this way, since a row outside the cabinet is not drawn
   * here. `onSheetOpened` reports it shown, so it opens once.
   */
  openSheet?: TabSheet | null;
  onSheetOpened?: () => void;
  /**
   * The page's one `useBoardTerminals` answer (docs/PANEL_ENCLOSURE_R2.md
   * §6.7, §12.2), so the tab numbers the X labels as the legend and the
   * print do. Without it the tab derives its own (memoised by document).
   */
  boardTerminals?: BoardTerminalsState;
}

const NO_RAILS: ReadonlySet<string> = new Set();
const NO_SUGGESTIONS: readonly TerminalSuggestion[] = Object.freeze([]);
const NO_FINDINGS: readonly PanelFinding[] = Object.freeze([]);

/** What the tab reads of the board's WAGO terminals, derived once per document. */
interface TabTerminals {
  terms: BoardTerminals | null;
  placement: TerminalPlacement | null;
  /** The terminal rails, `"moduleId:railKey"`: no device drops, a tap opens the close-up. */
  reserved: ReadonlySet<string>;
  findings: readonly PanelFinding[];
  /** The findings' suggestions; none on a read-only board. */
  suggestions: readonly TerminalSuggestion[];
  /** Per field with terminal rails: how many strips have no place (the field bar). */
  fields: readonly { field: number; unplaced: number }[];
}

function useTabTerminals(document: PanelDocument | null, index: CatalogIndex | null, passed: BoardTerminalsState | undefined, readOnly: boolean): TabTerminals {
  const own = useBoardTerminals(passed ? null : document, passed ? null : index);
  const { terms, placement } = passed ?? own;
  const reserved = useMemo(() => (document?.enclosure && index ? terminalRailKeys(document, index) : NO_RAILS), [document, index]);
  const findings = useMemo(
    () => (document && index ? enclosureFindings(document, index, terms && placement ? { terms, placement } : undefined) : NO_FINDINGS),
    [document, index, terms, placement],
  );
  const suggestions = useMemo(
    () => (!readOnly && document?.enclosure && index && terms && placement ? terminalSuggestions(document, index, terms, placement) : NO_SUGGESTIONS),
    [readOnly, document, index, terms, placement],
  );
  const fields = useMemo(() => (placement?.fields ?? []).map((field) => ({ field: field.field, unplaced: field.unplaced.length })), [placement]);
  return { terms, placement, reserved, findings, suggestions, fields };
}

interface TerminalUiArgs extends Omit<TerminalActionsArgs, "suggestions"> {
  terminals: TabTerminals;
  entries: readonly TabSheet[];
  resetSheets: (entry?: TabSheet) => void;
}

/**
 * The terminal actions and what the close-up needs: strip moves and every
 * "Vorschlag ausführen" (`useTerminalActions`, with the note's Rückgängig),
 * the close-up of each field (derived only while one is open), the strip
 * drag's source, and the way into the close-up.
 */
function useTerminalUi(args: TerminalUiArgs) {
  const { terminals, entries, resetSheets, ...rest } = args;
  const { document, index } = rest;
  const { terms, placement, suggestions, findings } = terminals;
  const { actions, moveStrip, resetOrder, runSuggestion } = useTerminalActions({ ...rest, suggestions });
  const closeupOpen = entries.some((entry) => entry.kind === "terminals");
  const closeups = useMemo(
    () => (closeupOpen && document && index && terms && placement ? terminalCloseup(document, index, terms, placement) : []),
    [closeupOpen, document, index, terms, placement],
  );
  const sheet = useMemo<TerminalSheetContext | null>(
    () =>
      terms && placement
        ? { terms, placement, closeups, suggestions, findings, actions, onMoveStrip: moveStrip, onResetOrder: resetOrder, onRunSuggestion: runSuggestion }
        : null,
    [terms, placement, closeups, suggestions, findings, actions, moveStrip, resetOrder, runSuggestion],
  );
  const stripSource = useMemo(
    () => (document && index && placement ? (stripId: string) => stripDragSource(document, index, placement, stripId) : undefined),
    [document, index, placement],
  );
  const openTerminals = useCallback((field: number, stripId: string | null) => resetSheets({ kind: "terminals", field, stripId }), [resetSheets]);
  const dropStrip = useCallback((stripId: string, drop: StripDrop) => moveStrip(stripId, { field: drop.field, rail: drop.rail, at: drop.at }), [moveStrip]);
  return { actions, sheet, stripSource, openTerminals, dropStrip };
}

/** What the drawing marks for the sheets that are open: the rail, the device, the module. */
function drawingFocus(entries: readonly TabSheet[]) {
  let activeRail: { moduleId: string; railKey: string } | null = null;
  let highlightDeviceId: string | null = null;
  let selectedModuleId: string | null = null;
  for (const entry of entries) {
    if (entry.kind === "module") selectedModuleId = entry.moduleId;
    if (entry.kind === "rail") {
      activeRail = { moduleId: entry.moduleId, railKey: entry.railKey };
      selectedModuleId = entry.moduleId;
      highlightDeviceId = entry.deviceId;
    }
    if (entry.kind === "inspector") highlightDeviceId = entry.deviceId;
  }
  return { activeRail, highlightDeviceId, selectedModuleId };
}

function CatalogNotReady({ state }: { state: EnclosureCatalogState }) {
  if (state.error) {
    return (
      <div className="sp-encl-tab-state" role="alert">
        <p>{state.error}</p>
        <button type="button" className="sp-btn sp-encl-target" onClick={() => void state.reload()}>
          Erneut laden
        </button>
      </div>
    );
  }
  return (
    <p className="sp-encl-tab-state" role="status">
      Schrankkatalog wird geladen…
    </p>
  );
}

function EmptyState({ readOnly, onChoose }: { readOnly: boolean; onChoose: () => void }) {
  return (
    <div className="sp-encl-tab-empty">
      <p className="sp-encl-tab-empty-title">Noch kein Schrank geplant.</p>
      <p>Hager univers Z, 1100 oder 1400 mm hoch, 2 bis 5 Felder.</p>
      {readOnly ? null : (
        <button type="button" className="sp-btn sp-btn--primary sp-encl-target" onClick={onChoose}>
          Schrank wählen
        </button>
      )}
    </div>
  );
}

function CabinetHead({ code, cabinet, readOnly, onChoose }: { code: string; cabinet: EnclosureSpec | null; readOnly: boolean; onChoose: () => void }) {
  return (
    <header className="sp-encl-tab-head">
      <div className="sp-encl-tab-cabinet">
        <b>{cabinet ? cabinetLine(cabinet) : code}</b>
        {cabinet ? null : <small>Unbekannter Schrankcode</small>}
      </div>
      {readOnly ? null : (
        <button type="button" className="sp-btn sp-encl-target" onClick={onChoose}>
          Schrank wählen
        </button>
      )}
    </header>
  );
}

/** Open a sheet another tab handed over, once, and report it shown. */
function useHandedSheet(reset: (entry?: TabSheet) => void, sheet: TabSheet | null | undefined, onOpened: (() => void) | undefined) {
  useEffect(() => {
    if (!sheet) return;
    reset(sheet);
    onOpened?.();
  }, [sheet, reset, onOpened]);
}

export function EnclosureTab(props: EnclosureTabProps) {
  const { token, panel, editor, catalog: catalogState, readOnly, onNotice, onError, load3D, reloadPage, openSheet, onSheetOpened } = props;
  const { document, mutate, settleSaves } = editor;
  const { catalog, index } = catalogState;
  const stack = useSheetStack<TabSheet>();
  const [view, setView] = useState<EnclosureViewMode>("open");
  const [zoomStep, setZoomStep] = useState(0);
  const { push } = stack;
  useHandedSheet(stack.reset, openSheet, onSheetOpened);
  const confirmRegroup = useCallback((request: RegroupRequest) => push({ kind: "regroup", ...request }), [push]);
  const runOp = useEnclosureOpRunner({ document, index, mutate, confirmRegroup, onError, onNotice });
  const terminals = useTabTerminals(document, index, props.boardTerminals, readOnly);
  const { placement, reserved } = terminals;
  const scene = useMemo(
    () => (document && index ? buildEnclosureScene(document, index, view === "closed" ? "closed" : "open", placement ?? undefined) : null),
    [document, index, view, placement],
  );
  const focus = useMemo(() => drawingFocus(stack.entries), [stack.entries]);
  const pdfHref = aufbauPdfUrl(panel.id);
  const onPdfClick = useMemo(() => savedPdfClick(pdfHref, settleSaves, onError, "Aufbau"), [pdfHref, settleSaves, onError]);
  const onReloadPage = useCallback(() => void reloadAfterSave(settleSaves, onError, reloadPage), [settleSaves, onError, reloadPage]);
  const drops = useDropUndo({ document, mutate });
  const { run: runDrop } = drops;
  const moveDevice = useCallback(
    (deviceId: string, target: DropTarget) => {
      if (!index) return;
      runDrop(
        (current) => dropDevice(current, index, deviceId, target, { reserved: terminalRailKeys(current, index) }),
        (before, after) => describeDrop(before, after, index, deviceId),
      );
    },
    [index, runDrop],
  );
  const dragSource = useMemo(() => (document && index ? (deviceId: string) => deviceDragSource(document, index, deviceId) : undefined), [document, index]);
  const { close: closeSheets } = stack;
  const dropFromPicker = useCallback(
    (deviceId: string, target: DropTarget) => {
      closeSheets();
      moveDevice(deviceId, target);
    },
    [closeSheets, moveDevice],
  );
  const terminalUi = useTerminalUi({
    document, index, terminals, readOnly, drops, mutate, confirmRegroup, onError, onNotice, entries: stack.entries, resetSheets: stack.reset,
  });

  if (!document) return null;
  if (!catalog || !index) return <CatalogNotReady state={catalogState} />;

  const host = (
    <EnclosureSheetHost
      stack={stack}
      token={token}
      document={document}
      catalog={catalog}
      index={index}
      draft={panel.status === "draft"}
      readOnly={readOnly}
      runOp={runOp}
      onEdit={mutate}
      devices={editor}
      onReloadCatalog={catalogState.reload}
      onDropDevice={dropFromPicker}
      reservedRails={reserved}
      terminals={terminalUi.sheet}
    />
  );
  const note = <DropNote note={drops.note} onUndo={drops.undo} onDismiss={drops.dismiss} />;
  const chooseCabinet = () => stack.reset({ kind: "enclosure-picker" });

  if (!document.enclosure) {
    return (
      <div className="sp-encl-tab">
        <EmptyState readOnly={readOnly} onChoose={chooseCabinet} />
        {host}
      </div>
    );
  }

  const cabinet = index.enclosure(document.enclosure.code);
  return (
    <div className="sp-encl-tab">
      <CabinetHead code={document.enclosure.code} cabinet={cabinet} readOnly={readOnly} onChoose={chooseCabinet} />
      <EnclosureToolbar
        view={view}
        onViewChange={setView}
        zoomStep={zoomStep}
        onZoomStepChange={(step) => setZoomStep(clampZoomStep(step))}
        onOrderRows={readOnly ? null : () => runOp((current, idx) => orderRowsPhysically(current, idx))}
        rowsInOrder={rowsInPhysicalOrder(document, index)}
        pdfHref={pdfHref}
        onPdfClick={onPdfClick}
      />
      <EnclosureFieldBar
        document={document}
        index={index}
        readOnly={readOnly}
        selectedModuleId={focus.selectedModuleId}
        onOpenModule={(moduleId) => stack.reset({ kind: "module", moduleId })}
        onAddModule={(field) => stack.reset({ kind: "module-picker", field, unit: null })}
        terminals={terminals.fields}
        onOpenTerminals={(field) => terminalUi.openTerminals(field, null)}
      />
      <EnclosureDrawing
        document={document}
        scene={scene}
        view={view}
        zoomStep={zoomStep}
        unitMm={cabinet?.unit_mm}
        readOnly={readOnly}
        focus={focus}
        load3D={load3D}
        onReloadPage={onReloadPage}
        onView={setView}
        onZoomStep={setZoomStep}
        onOpen={(sheet) => stack.reset(sheet)}
        onMoveDevice={readOnly ? undefined : (deviceId, drop) => moveDevice(deviceId, drop)}
        dragSource={readOnly ? undefined : dragSource}
        terminals={{
          placement,
          reserved,
          onOpen: terminalUi.openTerminals,
          onMoveStrip: readOnly ? undefined : terminalUi.dropStrip,
          stripSource: readOnly ? undefined : terminalUi.stripSource,
        }}
      />
      <EnclosureFindings findings={terminals.findings} actions={terminalUi.actions} />
      {host}
      {note}
    </div>
  );
}

type DrawingProps = {
  document: PanelDocument;
  scene: ReturnType<typeof buildEnclosureScene>;
  view: EnclosureViewMode;
  zoomStep: number;
  unitMm: number | undefined;
  readOnly: boolean;
  focus: ReturnType<typeof drawingFocus>;
  load3D?: Enclosure3DLoader;
  onReloadPage: () => void;
  onView: (view: EnclosureViewMode) => void;
  onZoomStep: (step: number) => void;
  onOpen: (sheet: TabSheet) => void;
  /** Device drag (Offen view only; absent read-only). */
  onMoveDevice?: (deviceId: string, drop: DeviceDrop) => void;
  dragSource?: (deviceId: string) => DeviceDragSource | null;
  terminals: DrawingTerminals;
};

/** The drawing's WAGO terminals: strips and reserved rails, the close-up, and the strip drag. */
interface DrawingTerminals {
  placement: TerminalPlacement | null;
  reserved: ReadonlySet<string>;
  /** A tap on a reserved rail's band (`stripId` null) or on a strip. */
  onOpen: (field: number, stripId: string | null) => void;
  /** Strip drag (Offen view only; absent read-only). */
  onMoveStrip?: (stripId: string, drop: StripDrop) => void;
  stripSource?: (stripId: string) => StripDragSource | null;
}

/** The 2D front (open or closed) or the 3D pane; a cabinet code the catalogue lacks has no picture. */
function EnclosureDrawing(props: DrawingProps) {
  const { document, scene, view, zoomStep, unitMm, readOnly, focus, load3D, onReloadPage, onView, onZoomStep, onOpen, onMoveDevice, dragSource, terminals } = props;
  if (!scene) {
    return (
      <p className="sp-encl-tab-state">
        {`Schrank „${document.enclosure?.code ?? ""}“ ist im Katalog nicht bekannt — die Zeichnung fehlt. Mit „Schrank wählen“ einen bekannten Schrank setzen.`}
      </p>
    );
  }
  if (view === "3d") return <Enclosure3DPane scene={scene} onExit={() => onView("open")} load={load3D} onReloadPage={onReloadPage} />;
  return (
    <EnclosureFrontSvg
      scene={scene}
      zoom={ENCLOSURE_ZOOM_STEPS[clampZoomStep(zoomStep)]}
      highlightDeviceId={focus.highlightDeviceId}
      selectedModuleId={focus.selectedModuleId}
      activeRail={focus.activeRail}
      unitMm={unitMm}
      // Not the picture-only mode: a viewer still opens rails and modules to read. No slot targets, though.
      readOnly={false}
      onOpenRail={(moduleId, railKey, deviceId) => onOpen({ kind: "rail", moduleId, railKey, deviceId })}
      onOpenModule={(moduleId) => onOpen({ kind: "module", moduleId })}
      onPickSlot={readOnly ? undefined : (field, unit) => onOpen({ kind: "module-picker", field, unit })}
      onFitWidth={(px) => onZoomStep(initialZoomStep(scene.width, px))}
      onMoveDevice={view === "open" ? onMoveDevice : undefined}
      dragSource={dragSource}
      reservedRails={terminals.reserved}
      placement={terminals.placement}
      onOpenTerminals={terminals.onOpen}
      onMoveStrip={view === "open" ? terminals.onMoveStrip : undefined}
      stripSource={terminals.stripSource}
    />
  );
}
