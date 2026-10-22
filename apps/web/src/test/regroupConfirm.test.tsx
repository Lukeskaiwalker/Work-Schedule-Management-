/**
 * No silent re-feeding (docs/PANEL_ENCLOSURE.md D4, §2.4, §11): an op whose
 * circuits change their feed and cannot be pinned is shown before it
 * applies — "{bmk}: {from} → {to}", "Einspeisung" for no head — and runs
 * only on "Trotzdem ausführen". Pinned circuits get the toast copy.
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { pinnedToast, regroupLines, RegroupConfirm } from "../components/schaltplan/enclosure/RegroupConfirm";
import { board, dev, row } from "./enclosureTestCatalog";

function boards() {
  const hs = dev("hauptschalter", { id: "q1", designation: "Q1" });
  const fi = dev("rcd", { id: "f1", designation: "F1" });
  const ls = dev("mcb", { id: "c1", designation: "F1.1", circuit: "1" });
  const plain = dev("mcb", { id: "c2", designation: "", label: "Steckdosen Küche" });
  const before = board([row("a", [hs, fi, ls, plain])]);
  const after = board([row("a", [ls, plain, hs])]);
  return { before, after };
}

describe("RegroupConfirm", () => {
  it("names every circuit with its old and new feed", () => {
    const { before, after } = boards();
    const lines = regroupLines(
      [
        { deviceId: "c1", from: "f1", to: "" },
        { deviceId: "c2", from: "", to: "q1" },
      ],
      before,
      after,
    );
    expect(lines).toEqual(["F1.1: F1 → Einspeisung", "Steckdosen Küche: Einspeisung → Q1"]);
  });

  it("falls back to the kind for a device without BMK or label, and to the id for a head in neither board", () => {
    const fi = dev("rcd", { id: "f1", designation: "" });
    const before = board([row("a", [fi, dev("mcb", { id: "c9", designation: "", label: "" })])]);
    const after = board([row("a", [])]);
    expect(regroupLines([{ deviceId: "c9", from: "f1", to: "zz" }], before, after)).toEqual(["Leitungsschutzschalter: FI → zz"]);
  });

  it("asks first and runs only on Trotzdem ausführen", () => {
    const { before, after } = boards();
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <RegroupConfirm
        regrouped={[{ deviceId: "c1", from: "f1", to: "" }]}
        before={before}
        after={after}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );
    const dialog = screen.getByRole("alertdialog", { name: "Stromkreise ändern ihre Einspeisung" });
    expect(dialog).toHaveTextContent("F1.1: F1 → Einspeisung");
    fireEvent.click(screen.getByRole("button", { name: "Abbrechen" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Trotzdem ausführen" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("× cancels too", () => {
    const { before, after } = boards();
    const onCancel = vi.fn();
    render(<RegroupConfirm regrouped={[]} before={before} after={after} onConfirm={vi.fn()} onCancel={onCancel} />);
    fireEvent.click(screen.getByRole("button", { name: "Schließen" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

describe("pinnedToast", () => {
  it("uses the §11 copy", () => {
    expect(pinnedToast(3)).toBe("3 Stromkreis(e) behalten ihre Einspeisung — fest eingetragen.");
  });
});
