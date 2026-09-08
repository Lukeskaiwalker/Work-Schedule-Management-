/**
 * The editor surfaces for duplicate + rail templates.
 *
 * `schaltplanDocumentOps.test.ts` proves the numbering; this proves the
 * buttons exist, fire the right callback, and disappear in read-only mode —
 * the two ways a wired-but-unreachable feature ships.
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { DeviceInspector } from "../components/schaltplan/DeviceInspector";
import { RailEditor } from "../components/schaltplan/RailEditor";
import { RowTemplateSheet } from "../components/schaltplan/RowTemplateSheet";
import { emptyDocument, makeDevice } from "../utils/schaltplanDevices";
import { ROW_TEMPLATES } from "../utils/schaltplanDocumentOps";

function boardWithOneBreaker() {
  const breaker = makeDevice("mcb", { id: "c1", designation: "F1.1", circuit: "1", label: "Licht" });
  const document = {
    ...emptyDocument(),
    rows: [{ id: "r1", label: "Reihe 1", slots: 12, devices: [breaker] }],
  };
  return { document, breaker };
}

const noop = () => undefined;

describe("DeviceInspector — Duplizieren", () => {
  it("offers a duplicate action that fires the callback", () => {
    const { document, breaker } = boardWithOneBreaker();
    const onDuplicate = vi.fn();
    render(
      <DeviceInspector
        device={breaker}
        document={document}
        readOnly={false}
        onChange={noop}
        onDelete={noop}
        onDuplicate={onDuplicate}
        onMove={noop}
        onClose={noop}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /duplizieren/i }));
    expect(onDuplicate).toHaveBeenCalledTimes(1);
  });

  it("hides it in read-only mode", () => {
    const { document, breaker } = boardWithOneBreaker();
    render(
      <DeviceInspector
        device={breaker}
        document={document}
        readOnly
        onChange={noop}
        onDelete={noop}
        onDuplicate={noop}
        onMove={noop}
        onClose={noop}
      />,
    );
    expect(screen.queryByRole("button", { name: /duplizieren/i })).toBeNull();
  });
});

describe("RailEditor — Reihe aus Vorlage", () => {
  it("opens the template chooser next to the plain add-row button", () => {
    const { document } = boardWithOneBreaker();
    const onAddRowFromTemplate = vi.fn();
    render(
      <RailEditor
        document={document}
        selectedDeviceId={null}
        readOnly={false}
        onSelectDevice={noop}
        onAddDevice={noop}
        onAddRow={noop}
        onAddRowFromTemplate={onAddRowFromTemplate}
        onRemoveRow={noop}
        onRenameRow={noop}
        onChangeSlots={noop}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /reihe aus vorlage/i }));
    expect(onAddRowFromTemplate).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: /reihe hinzufügen/i })).toBeInTheDocument();
  });

  it("shows neither add button when read-only", () => {
    const { document } = boardWithOneBreaker();
    render(
      <RailEditor
        document={document}
        selectedDeviceId={null}
        readOnly
        onSelectDevice={noop}
        onAddDevice={noop}
        onAddRow={noop}
        onAddRowFromTemplate={noop}
        onRemoveRow={noop}
        onRenameRow={noop}
        onChangeSlots={noop}
      />,
    );
    expect(screen.queryByRole("button", { name: /reihe aus vorlage/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /reihe hinzufügen/i })).toBeNull();
  });
});

describe("RowTemplateSheet", () => {
  it("lists every template and reports the picked id", () => {
    const onPick = vi.fn();
    render(<RowTemplateSheet open onPick={onPick} onClose={noop} />);
    for (const template of ROW_TEMPLATES) {
      expect(screen.getByText(template.label)).toBeInTheDocument();
    }
    fireEvent.click(screen.getByRole("button", { name: /1 FI \+ 6 LS/ }));
    expect(onPick).toHaveBeenCalledWith("rcd-6mcb");
  });

  it("renders nothing while closed", () => {
    const { container } = render(<RowTemplateSheet open={false} onPick={noop} onClose={noop} />);
    expect(container).toBeEmptyDOMElement();
  });
});
