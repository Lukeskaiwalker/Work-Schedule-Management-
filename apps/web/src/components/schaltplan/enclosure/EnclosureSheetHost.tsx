/**
 * The Schrank tab's sheet stack on screen (docs/PANEL_ENCLOSURE.md §11):
 * the top sheet only, behind the stack's one backdrop. Which sheet opens
 * which is decided here, in one place:
 *
 *   field bar / drawing → Modul · Modul wählen · Hutschiene
 *   Modul wählen        → (placed) Modul, in its place
 *   Modul               → Hutschiene
 *   Hutschiene          → Gerät (inspector) · Gerät hinzufügen (palette)
 *   Gerät               → Hutschiene wählen → (Wohin auf …?) → drop: all sheets close, the drop note shows
 *   field bar / drawing → Reihenklemmen · Feld {n} (close-up) → Hutschiene ("Geräte bearbeiten")
 *   Hutschiene (reserved) → Reihenklemmen · Feld {n}
 *   Modul wählen        → Schrankkatalog (managers; prefilled for a shelf article)
 *   field bar / drawing / finding → §14a-Klemmleiste → (Aderbeschriftung drucken: all sheets close, the label dialog opens)
 *   any op that re-feeds a circuit → Stromkreise ändern ihre Einspeisung
 *
 * ‹, Escape and the backdrop go back one step (`stack.back`: one sheet, or
 * the catalogue admin's form back to its list), × closes the stack — except
 * the inspector, palette and rail picker, whose × returns to the sheet
 * they were opened from: closing the inspector gives the rail back. The
 * module picker's switches and search ride in its stack entry, so a sheet
 * opened on top of the picker and closed again leaves them as they were.
 */
import { ControlBlockSheet } from "./ControlBlockSheet";
import { EnclosureCatalogAdmin } from "./EnclosureCatalogAdmin";
import { EnclosurePickerSheet } from "./EnclosurePickerSheet";
import { SheetBackdrop, SheetFrame } from "./EnclosureSheetFrame";
import { ModulePickerSheet } from "./ModulePickerSheet";
import { ModuleSheet } from "./ModuleSheet";
import { RailPickerSheet } from "./RailPickerSheet";
import { RailSheet } from "./RailSheet";
import { RegroupConfirm } from "./RegroupConfirm";
import { TerminalCloseupSheet } from "./TerminalCloseupSheet";
import { findingKey, type FindingAction } from "./EnclosureFindings";
import { suppliedInfo, terminalBlockedZone } from "./enclosureEditorModel";
import { DEFAULT_PICKER_SWITCHES, type EditDocument, type EnclosureSheet, type RunEnclosureOp, type SheetStack } from "./useSheetStack";
import { DeviceInspector } from "../DeviceInspector";
import { DevicePalette } from "../DevicePalette";
import type { PanelDocumentEditor } from "../../../hooks/usePanelDocumentEditor";
import type { CatalogIndex } from "../../../utils/enclosureCatalog";
import { reservedRailKey, type DropTarget } from "../../../utils/enclosureOpsDrag";
import type { StripTarget } from "../../../utils/enclosureOpsTerminals";
import type { BoardTerminals } from "../../../utils/enclosureTerminals";
import { NO_SKIP } from "../../../utils/schaltplanTerminalRules";
import { findDevice, neighbourDeviceId } from "../../../utils/schaltplanTopology";
import type { EnclosureCatalog, TerminalCloseup, TerminalPlacement, TerminalSuggestion, UncataloguedArticle } from "../../../types/panelEnclosure";
import type { PanelDocument, PanelFinding } from "../../../types/schaltplan";

/**
 * The tab's sheets: `EnclosureSheet`, with the catalogue admin carrying the
 * shelf article "Eintrag anlegen" was tapped on (null = the plain list).
 */
export type TabSheet = Exclude<EnclosureSheet, { kind: "catalog-admin" }> | { kind: "catalog-admin"; create: UncataloguedArticle | null };

export type DeviceEdits = Pick<PanelDocumentEditor, "patchDevice" | "removeDevice" | "duplicateDevice" | "moveDevice" | "editTerminalLabel">;

/** What the terminal close-up and the reserved rails need from the tab (docs/PANEL_ENCLOSURE_R2.md §7.2, §7.4). */
export interface TerminalSheetContext {
  terms: BoardTerminals;
  placement: TerminalPlacement;
  /** The close-up of every field with terminal rails; [] while no close-up is open. */
  closeups: readonly TerminalCloseup[];
  suggestions: readonly TerminalSuggestion[];
  findings: readonly PanelFinding[];
  /** The findings' actions, by `${rule}|${scope}`. */
  actions: ReadonlyMap<string, FindingAction>;
  onMoveStrip: (stripId: string, target: StripTarget) => void;
  onResetOrder: (field: number) => void;
  onRunSuggestion: (suggestion: TerminalSuggestion) => void;
}

export interface EnclosureSheetHostProps {
  stack: SheetStack<TabSheet>;
  /** For the catalogue admin's writes. */
  token: string | null;
  document: PanelDocument;
  catalog: EnclosureCatalog;
  index: CatalogIndex;
  /** Draft board: ModuleSheet may refresh a snapshot. */
  draft: boolean;
  readOnly: boolean;
  runOp: RunEnclosureOp;
  onEdit: EditDocument;
  devices: DeviceEdits;
  onReloadCatalog: () => Promise<void>;
  /** "Auf andere Hutschiene…" picked a rail and a place: the tab runs the drop (note, Rückgängig). */
  onDropDevice: (deviceId: string, target: DropTarget) => void;
  /** Rails reserved for WAGO terminals, offered disabled in the rail picker and marked in RailSheet. */
  reservedRails?: ReadonlySet<string>;
  /** The terminal close-up's data; without it the close-up says it has none. */
  terminals?: TerminalSheetContext | null;
  /** The page's label dialog in mode `adern` (R4 §9.2); the host closes the stack first. Absent = no print button. */
  onPrintWires?: () => void;
}

const NO_RAILS: ReadonlySet<string> = new Set();

type Shared = EnclosureSheetHostProps & { onBack?: () => void };

function InspectorSheet({ deviceId, ...props }: Shared & { deviceId: string }) {
  const { stack, document, index, readOnly, devices, terminals } = props;
  const device = findDevice(document, deviceId);
  if (!device) {
    return (
      <SheetFrame title="Gerät" onBack={props.onBack} onClose={stack.pop}>
        <p className="sp-encl-empty">Dieses Gerät ist nicht mehr im Plan.</p>
      </SheetFrame>
    );
  }
  const previous = neighbourDeviceId(document, deviceId, -1);
  const next = neighbourDeviceId(document, deviceId, 1);
  const walkTo = (target: string | null) => target && stack.replaceTop({ kind: "inspector", deviceId: target });
  return (
    <DeviceInspector
      embedded
      device={device}
      document={document}
      readOnly={readOnly}
      suppliedBy={suppliedInfo(document, index, deviceId)}
      terminalBlockedZone={terminalBlockedZone(document, index, terminals?.terms.skip ?? NO_SKIP, deviceId)}
      onChange={(patch) => devices.patchDevice(deviceId, patch)}
      onEditTerminalLabel={devices.editTerminalLabel}
      onDelete={() => {
        devices.removeDevice(deviceId);
        stack.pop();
      }}
      onDuplicate={() => walkTo(devices.duplicateDevice(deviceId))}
      onMove={(direction) => devices.moveDevice(deviceId, direction)}
      onMoveToRail={() => stack.push({ kind: "rail-picker", deviceId })}
      onClose={stack.pop}
      hasPrevious={previous !== null}
      hasNext={next !== null}
      onNavigate={(direction) => walkTo(direction < 0 ? previous : next)}
    />
  );
}

function TopSheet(props: Shared & { sheet: TabSheet }) {
  const { sheet, stack, document, catalog, index, readOnly, runOp, onEdit, onBack, draft } = props;
  const common = { document, index, readOnly, onOp: runOp, onBack, onClose: stack.close };
  switch (sheet.kind) {
    case "enclosure-picker":
      return <EnclosurePickerSheet {...common} catalog={catalog} onEdit={onEdit} onChosen={stack.pop} />;
    case "module-picker":
      return (
        <ModulePickerSheet
          {...common}
          catalog={catalog}
          field={sheet.field}
          unit={sheet.unit}
          switches={sheet.switches ?? DEFAULT_PICKER_SWITCHES}
          onSwitchesChange={(switches) => stack.replaceTop({ ...sheet, switches })}
          query={sheet.query ?? ""}
          onQueryChange={(query) => stack.replaceTop({ ...sheet, query })}
          onPlaced={(moduleId) => stack.replaceTop({ kind: "module", moduleId })}
          onManageCatalog={() => stack.push({ kind: "catalog-admin", create: null })}
          onCreateEntry={(item) => stack.push({ kind: "catalog-admin", create: item })}
        />
      );
    case "module":
      return (
        <ModuleSheet
          {...common}
          moduleId={sheet.moduleId}
          draft={draft}
          onEdit={onEdit}
          onOpenRail={(moduleId, railKey) => stack.push({ kind: "rail", moduleId, railKey, deviceId: null })}
          onRemoved={() => stack.removeWhere((entry) => sheetModuleId(entry) === sheet.moduleId)}
        />
      );
    case "rail":
      return <RailSheetEntry {...props} sheet={sheet} />;
    case "terminals":
      return <TerminalsSheet {...props} sheet={sheet} />;
    case "inspector":
      return <InspectorSheet {...props} deviceId={sheet.deviceId} />;
    case "palette":
      return (
        <DevicePalette
          open
          embedded
          document={document}
          targetRowLabel={sheet.request.label}
          onPick={(kind) => {
            // Pop first: `pick` may push the new device's inspector.
            stack.pop();
            sheet.request.pick(kind);
          }}
          onClose={stack.pop}
        />
      );
    case "rail-picker":
      return (
        <RailPickerSheet
          document={document}
          index={index}
          readOnly={readOnly}
          deviceId={sheet.deviceId}
          onDrop={(target) => props.onDropDevice(sheet.deviceId, target)}
          reserved={props.reservedRails}
          setBackHandler={stack.setBackHandler}
          onBack={onBack}
          onClose={stack.pop}
        />
      );
    case "regroup":
      return (
        <RegroupConfirm
          regrouped={sheet.regrouped}
          before={sheet.before}
          after={sheet.after}
          onConfirm={() => {
            stack.pop();
            sheet.apply();
          }}
          onCancel={stack.pop}
        />
      );
    case "control-block":
      return <ControlBlockSheet {...common} onPrintWires={printWires(stack, props.onPrintWires)} />;
    case "catalog-admin":
      return (
        <EnclosureCatalogAdmin
          token={props.token}
          catalog={catalog}
          create={sheet.create}
          onChanged={props.onReloadCatalog}
          onBack={onBack}
          onClose={stack.close}
          setBackHandler={stack.setBackHandler}
        />
      );
  }
}

function RailSheetEntry(props: Shared & { sheet: Extract<TabSheet, { kind: "rail" }> }) {
  const { sheet, stack, document, index, readOnly, runOp, onEdit, onBack, terminals } = props;
  const reserved = (props.reservedRails ?? NO_RAILS).has(reservedRailKey(sheet.moduleId, sheet.railKey));
  const field = reserved ? terminals?.placement.fields.find((entry) => entry.rails.some((rail) => rail.moduleId === sheet.moduleId && rail.railKey === sheet.railKey)) : undefined;
  const rowId = field?.rails.find((rail) => rail.moduleId === sheet.moduleId && rail.railKey === sheet.railKey)?.rowId ?? null;
  return (
    <RailSheet
      document={document}
      index={index}
      readOnly={readOnly}
      onOp={runOp}
      onBack={onBack}
      onClose={stack.close}
      moduleId={sheet.moduleId}
      railKey={sheet.railKey}
      highlightDeviceId={sheet.deviceId}
      onEdit={onEdit}
      onOpenDevice={(deviceId) => stack.push({ kind: "inspector", deviceId })}
      onChooseDevice={(request) => stack.push({ kind: "palette", request })}
      reserved={reserved}
      reservedAction={rowId ? terminals?.actions.get(findingKey("encl.terminal_rail_devices", rowId)) ?? null : null}
      onOpenTerminals={field ? () => stack.push({ kind: "terminals", field: field.field, stripId: null }) : undefined}
    />
  );
}

function TerminalsSheet(props: Shared & { sheet: Extract<TabSheet, { kind: "terminals" }> }) {
  const { sheet, stack, document, index, readOnly, onBack, terminals } = props;
  const closeup = terminals?.closeups.find((entry) => entry.field === sheet.field) ?? null;
  if (!terminals || !closeup) {
    return (
      <SheetFrame title={`Reihenklemmen · Feld ${sheet.field + 1}`} onBack={onBack} onClose={stack.close}>
        <p className="sp-encl-empty">{`Feld ${sheet.field + 1} hat keine Hutschienen für Reihenklemmen.`}</p>
      </SheetFrame>
    );
  }
  return (
    <TerminalCloseupSheet
      document={document}
      index={index}
      terms={terminals.terms}
      closeup={closeup}
      placement={terminals.placement}
      suggestions={terminals.suggestions}
      findings={terminals.findings}
      readOnly={readOnly}
      selectedStripId={sheet.stripId}
      onSelectStrip={(stripId) => stack.replaceTop({ ...sheet, stripId })}
      onMove={terminals.onMoveStrip}
      onReset={terminals.onResetOrder}
      onRunSuggestion={terminals.onRunSuggestion}
      onOpenRail={(moduleId, railKey, deviceId) => stack.push({ kind: "rail", moduleId, railKey, deviceId })}
      onBack={onBack}
      onClose={stack.close}
    />
  );
}

/** "Aderbeschriftung drucken": the sheets close, then the page's label dialog opens over the tab. */
function printWires(stack: SheetStack<TabSheet>, open: (() => void) | undefined): (() => void) | undefined {
  if (!open) return undefined;
  return () => {
    stack.close();
    open();
  };
}

/** The module a sheet is about, so removing that module can drop every sheet on it. */
export function sheetModuleId(entry: TabSheet): string | null {
  return entry.kind === "module" || entry.kind === "rail" ? entry.moduleId : null;
}

export function EnclosureSheetHost({ stack, ...rest }: EnclosureSheetHostProps) {
  const top = stack.top;
  if (!top) return null;
  return (
    <>
      <SheetBackdrop onDismiss={stack.back} />
      <TopSheet {...rest} stack={stack} sheet={top} onBack={stack.depth > 1 ? stack.back : undefined} />
    </>
  );
}
