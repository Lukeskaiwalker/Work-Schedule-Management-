/**
 * The Schrank tab's sheet stack on screen (docs/PANEL_ENCLOSURE.md §11):
 * the top sheet only, behind the stack's one backdrop. Which sheet opens
 * which is decided here, in one place:
 *
 *   field bar / drawing → Modul · Modul wählen · Hutschiene
 *   Modul wählen        → (placed) Modul, in its place
 *   Modul               → Hutschiene
 *   Hutschiene          → Gerät (inspector) · Gerät hinzufügen (palette)
 *   Gerät               → Hutschiene wählen
 *   Modul wählen        → Schrankkatalog (managers; prefilled for a shelf article)
 *   any op that re-feeds a circuit → Stromkreise ändern ihre Einspeisung
 *
 * ‹, Escape and the backdrop go back one step (`stack.back`: one sheet, or
 * the catalogue admin's form back to its list), × closes the stack — except
 * the inspector, palette and rail picker, whose × returns to the sheet
 * they were opened from: closing the inspector gives the rail back. The
 * module picker's switches ride in its stack entry, so a sheet opened on
 * top of the picker and closed again leaves them as they were.
 */
import { EnclosureCatalogAdmin } from "./EnclosureCatalogAdmin";
import { EnclosurePickerSheet } from "./EnclosurePickerSheet";
import { SheetBackdrop, SheetFrame } from "./EnclosureSheetFrame";
import { ModulePickerSheet } from "./ModulePickerSheet";
import { ModuleSheet } from "./ModuleSheet";
import { RailPickerSheet } from "./RailPickerSheet";
import { RailSheet } from "./RailSheet";
import { RegroupConfirm } from "./RegroupConfirm";
import { suppliedInfo } from "./enclosureEditorModel";
import { DEFAULT_PICKER_SWITCHES, type EditDocument, type EnclosureSheet, type RunEnclosureOp, type SheetStack } from "./useSheetStack";
import { DeviceInspector } from "../DeviceInspector";
import { DevicePalette } from "../DevicePalette";
import type { PanelDocumentEditor } from "../../../hooks/usePanelDocumentEditor";
import type { CatalogIndex } from "../../../utils/enclosureCatalog";
import { findDevice, neighbourDeviceId } from "../../../utils/schaltplanTopology";
import type { EnclosureCatalog, UncataloguedArticle } from "../../../types/panelEnclosure";
import type { PanelDocument } from "../../../types/schaltplan";

/**
 * The tab's sheets: `EnclosureSheet`, with the catalogue admin carrying the
 * shelf article "Eintrag anlegen" was tapped on (null = the plain list).
 */
export type TabSheet = Exclude<EnclosureSheet, { kind: "catalog-admin" }> | { kind: "catalog-admin"; create: UncataloguedArticle | null };

export type DeviceEdits = Pick<PanelDocumentEditor, "patchDevice" | "removeDevice" | "duplicateDevice" | "moveDevice" | "editTerminalLabel">;

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
}

type Shared = EnclosureSheetHostProps & { onBack?: () => void };

function InspectorSheet({ deviceId, ...props }: Shared & { deviceId: string }) {
  const { stack, document, index, readOnly, devices } = props;
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
      return (
        <RailSheet
          {...common}
          moduleId={sheet.moduleId}
          railKey={sheet.railKey}
          highlightDeviceId={sheet.deviceId}
          onEdit={onEdit}
          onOpenDevice={(deviceId) => stack.push({ kind: "inspector", deviceId })}
          onChooseDevice={(request) => stack.push({ kind: "palette", request })}
        />
      );
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
      return <RailPickerSheet {...common} deviceId={sheet.deviceId} onMoved={stack.pop} onClose={stack.pop} />;
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
