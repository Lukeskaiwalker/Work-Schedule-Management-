/**
 * The field bar above the cabinet drawing (docs/PANEL_ENCLOSURE.md §11): the
 * module entry point at every zoom. One ≥ 56 px button per module, "Feld
 * {n} · {art}", and "+ Modul in Feld {n}" for every field that still has a
 * free unit — never on a read-only board.
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";

import { EnclosureFieldBar } from "../components/schaltplan/enclosure/EnclosureFieldBar";
import type { PanelDocument } from "../types/schaltplan";
import { renderBoard } from "./enclosureRenderBoard";
import { board, INDEX } from "./enclosureTestCatalog";

function setup(document: PanelDocument = renderBoard(), readOnly = false, selectedModuleId: string | null = null) {
  const onOpenModule = vi.fn();
  const onAddModule = vi.fn();
  const view = render(
    <EnclosureFieldBar
      document={document}
      index={INDEX}
      onOpenModule={onOpenModule}
      onAddModule={onAddModule}
      readOnly={readOnly}
      selectedModuleId={selectedModuleId}
    />,
  );
  return { ...view, onOpenModule, onAddModule };
}

const buttonTitles = () => screen.getAllByRole("button").map((button) => button.querySelector(".sp-encl-fieldbar-title")?.textContent);

describe("EnclosureFieldBar", () => {
  it("has one button per module, field by field, and an add button where a field has room", () => {
    setup();
    expect(buttonTitles()).toEqual([
      "Feld 1 · ZH3EH16",
      "Feld 2 · ZU37KS",
      "Feld 3 · ZH3EL22",
      "Feld 4 · ZU62A",
      "+ Modul in Feld 4",
      "+ Modul in Feld 5",
    ]);
  });

  it("opens the module, or the picker for the field", () => {
    const { onOpenModule, onAddModule } = setup();
    fireEvent.click(screen.getByRole("button", { name: /^Feld 2 · ZU37KS/ }));
    expect(onOpenModule).toHaveBeenCalledWith("m2");
    fireEvent.click(screen.getByRole("button", { name: /^\+ Modul in Feld 5/ }));
    expect(onAddModule).toHaveBeenCalledWith(4);
  });

  it("names the module under its button: its label, else what kind of field it is", () => {
    setup();
    expect(within(screen.getByRole("button", { name: /^Feld 1 · ZH3EH16/ })).getByText("Allgemein")).toBeInTheDocument();
    expect(within(screen.getByRole("button", { name: /^Feld 2 · ZU37KS/ })).getByText("Verteilerfeld")).toBeInTheDocument();
  });

  it("groups the buttons per field", () => {
    setup();
    const groups = screen.getAllByRole("group");
    expect(groups.map((group) => group.getAttribute("aria-label"))).toEqual(["Feld 1", "Feld 2", "Feld 3", "Feld 4", "Feld 5"]);
  });

  it("shows a module whose code does not resolve, so it can still be moved or removed", () => {
    const doc = board([], { code: "ZB32S", modules: [{ id: "x", code: "zz404", field: 0, unit: 0, label: "", rails: {}, fittings: null, removed_fittings: [], meters: [] }] });
    const { onOpenModule } = setup(doc);
    const button = screen.getByRole("button", { name: /^Feld 1 · ZZ404/ });
    expect(within(button).getByText("Code unbekannt")).toBeInTheDocument();
    fireEvent.click(button);
    expect(onOpenModule).toHaveBeenCalledWith("x");
  });

  it("offers every field of an empty cabinet", () => {
    setup(board([], { code: "ZB33S", modules: [] }));
    expect(buttonTitles()).toEqual(["+ Modul in Feld 1", "+ Modul in Feld 2", "+ Modul in Feld 3"]);
  });

  it("marks the open module", () => {
    setup(renderBoard(), false, "m3");
    expect(screen.getByRole("button", { name: /^Feld 3 · ZH3EL22/ })).toHaveAttribute("aria-current", "true");
    expect(screen.getByRole("button", { name: /^Feld 2 · ZU37KS/ })).not.toHaveAttribute("aria-current");
  });

  it("read-only: modules still open, nothing can be added", () => {
    const { onOpenModule } = setup(renderBoard(), true);
    expect(screen.queryByRole("button", { name: /\+ Modul/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /^Feld 1 · ZH3EH16/ }));
    expect(onOpenModule).toHaveBeenCalledWith("m1");
  });

  it("renders nothing without a cabinet", () => {
    const { container } = setup(board([]));
    expect(container).toBeEmptyDOMElement();
  });
});
