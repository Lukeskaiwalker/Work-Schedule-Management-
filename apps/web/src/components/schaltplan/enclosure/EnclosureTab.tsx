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
 */
import { useCallback, useEffect, useMemo, useState } from "react";

import { Enclosure3DPane, type Enclosure3DLoader } from "./Enclosure3DBoundary";
import { EnclosureFieldBar } from "./EnclosureFieldBar";
import { EnclosureFindings } from "./EnclosureFindings";
import { EnclosureFrontSvg } from "./EnclosureFrontSvg";
import { cabinetLine } from "./EnclosurePickerSheet";
import { EnclosureSheetHost, type TabSheet } from "./EnclosureSheetHost";
import { EnclosureToolbar, type EnclosureViewMode } from "./EnclosureToolbar";
import { rowsInPhysicalOrder } from "./enclosureEditorModel";
import { ENCLOSURE_ZOOM_STEPS, clampZoomStep, initialZoomStep } from "./enclosureFrontLayout";
import { useEnclosureOpRunner } from "./useEnclosureOpRunner";
import { useSheetStack } from "./useSheetStack";
import type { EnclosureCatalogState } from "../../../hooks/useEnclosureCatalog";
import type { PanelDocumentEditor } from "../../../hooks/usePanelDocumentEditor";
import { buildEnclosureScene } from "../../../utils/enclosureGeometry";
import { orderRowsPhysically } from "../../../utils/enclosureOps";
import { enclosureFindings } from "../../../utils/enclosureRules";
import { reloadAfterSave, savedPdfClick } from "../../../utils/openAfterSave";
import { aufbauPdfUrl } from "../../../utils/schaltplanEnclosureApi";
import type { EnclosureSpec } from "../../../types/panelEnclosure";
import type { PanelDocument, PanelPlan } from "../../../types/schaltplan";
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
  const runOp = useEnclosureOpRunner({
    document,
    index,
    mutate,
    confirmRegroup: (request) => push({ kind: "regroup", ...request }),
    onError,
    onNotice,
  });
  const scene = useMemo(
    () => (document && index ? buildEnclosureScene(document, index, view === "closed" ? "closed" : "open") : null),
    [document, index, view],
  );
  const findings = useMemo(() => (document && index ? enclosureFindings(document, index) : []), [document, index]);
  const focus = useMemo(() => drawingFocus(stack.entries), [stack.entries]);
  const pdfHref = aufbauPdfUrl(panel.id);
  const onPdfClick = useMemo(() => savedPdfClick(pdfHref, settleSaves, onError, "Aufbau"), [pdfHref, settleSaves, onError]);
  const onReloadPage = useCallback(() => void reloadAfterSave(settleSaves, onError, reloadPage), [settleSaves, onError, reloadPage]);

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
    />
  );
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
      />
      <EnclosureFindings findings={findings} />
      {host}
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
};

/** The 2D front (open or closed) or the 3D pane; a cabinet code the catalogue lacks has no picture. */
function EnclosureDrawing({ document, scene, view, zoomStep, unitMm, readOnly, focus, load3D, onReloadPage, onView, onZoomStep, onOpen }: DrawingProps) {
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
    />
  );
}
