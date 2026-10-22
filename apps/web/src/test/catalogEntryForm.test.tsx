/**
 * One catalogue entry in the admin (docs/PANEL_ENCLOSURE.md §3.5, §9 Slice
 * F, §11): the metadata as plain fields, the admin's accessories with a
 * quantity (owner decision), the structure as "Aufbau (JSON, für
 * Fortgeschrittene)" and a live preview drawn by the real geometry. The form
 * only builds the body; the admin sends it. Refusals the server would give
 * anyway (bad JSON, a dropped key, a frozen size) are shown before sending.
 *
 * Invented data only.
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";

import { CatalogEntryForm, type CatalogEntryFormProps } from "../components/schaltplan/enclosure/CatalogEntryForm";
import { blankDraft, draftFromSpec } from "../components/schaltplan/enclosure/catalogEntryDraft";
import { MODULES, testCatalog } from "./enclosureTestCatalog";
import type { CatalogEntryIn, ModuleSpec } from "../types/panelEnclosure";

const TEMPLATES = [...testCatalog().modules, ...testCatalog().enclosures];

function renderForm(overrides: Partial<CatalogEntryFormProps> = {}) {
  const onSubmit = vi.fn<(body: CatalogEntryIn) => void>();
  const onCancel = vi.fn();
  const props: CatalogEntryFormProps = {
    mode: "edit",
    initialDraft: draftFromSpec("module", MODULES.ZU37KS),
    original: MODULES.ZU37KS,
    usedByPlans: 0,
    templates: TEMPLATES,
    busy: false,
    error: null,
    onSubmit,
    onCancel,
    ...overrides,
  };
  const view = render(<CatalogEntryForm {...props} />);
  return { ...view, onSubmit, onCancel, props };
}

const details = () => within(screen.getByRole("region", { name: "Angaben" }));
const submitted = (mock: ReturnType<typeof renderForm>["onSubmit"]) => mock.mock.calls[0][0];

describe("CatalogEntryForm", () => {
  it("shows the §11 fields, the JSON editor and a preview", () => {
    renderForm();
    for (const label of ["Artikelnummer", "Bezeichnung", "Familie", "Feldhöhe", "Breite (Felder)", "Höhe (Raster à 150 mm)", "Notiz", "Quelle (https-Link)"]) {
      expect(details().getByLabelText(label)).toBeTruthy();
    }
    expect(details().getByRole("checkbox", { name: "geprüft" })).toBeTruthy();
    expect(screen.getByLabelText("Aufbau (JSON, für Fortgeschrittene)")).toBeTruthy();
    const preview = screen.getByRole("region", { name: "Vorschau" });
    expect(within(preview).getByRole("img")).toBeTruthy();
  });

  it("a changed name is in the body; everything else stays as stored", () => {
    const { onSubmit } = renderForm();
    fireEvent.change(details().getByLabelText("Bezeichnung"), { target: { value: "Verteilerfeld, 7 Reihen" } });
    fireEvent.click(screen.getByRole("button", { name: "Speichern" }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(submitted(onSubmit)).toEqual({ entry_type: "module", spec: { ...MODULES.ZU37KS, name: "Verteilerfeld, 7 Reihen" } });
  });

  it("bad JSON: said under the editor, the preview cannot draw, nothing is sent", () => {
    const { onSubmit } = renderForm();
    const editor = screen.getByLabelText("Aufbau (JSON, für Fortgeschrittene)");
    fireEvent.change(editor, { target: { value: "{ \"zones\": [" } });
    expect(editor.getAttribute("aria-invalid")).toBe("true");
    expect(within(screen.getByRole("region", { name: "Vorschau" })).getByText(/Vorschau nicht möglich/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Speichern" }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toMatch(/kein gültiges JSON/);
  });

  it("the preview follows the height as it is typed", () => {
    renderForm({ usedByPlans: 0 });
    const preview = () => within(screen.getByRole("region", { name: "Vorschau" })).getByRole("img");
    expect(preview().getAttribute("aria-label")).toBe("Schrank 300 × 1100 mm, offen");
    fireEvent.change(details().getByLabelText("Höhe (Raster à 150 mm)"), { target: { value: "6" } });
    expect(preview().getAttribute("aria-label")).toBe("Schrank 300 × 950 mm, offen");
  });

  it("accessories: added by the admin with a quantity", () => {
    const { onSubmit } = renderForm();
    fireEvent.click(screen.getByRole("button", { name: "+ Zubehör" }));
    const row = within(screen.getByRole("group", { name: "Zubehör 1" }));
    fireEvent.change(row.getByLabelText("Artikelnummer"), { target: { value: "ZZ99X1" } });
    fireEvent.change(row.getByLabelText("Bezeichnung"), { target: { value: "Feldverbinder (erfunden)" } });
    fireEvent.click(row.getByRole("button", { name: "Menge erhöhen" }));
    fireEvent.click(row.getByRole("button", { name: "Menge erhöhen" }));
    expect((row.getByLabelText("Menge") as HTMLInputElement).value).toBe("3");
    fireEvent.click(row.getByRole("button", { name: "Menge verringern" }));
    fireEvent.click(screen.getByRole("button", { name: "Speichern" }));
    expect((submitted(onSubmit).spec as ModuleSpec).accessories).toEqual([
      { article_no: "ZZ99X1", label: "Feldverbinder (erfunden)", qty: 2, verified: true },
    ]);
  });

  it("an accessory can be taken off again", () => {
    const withOne = { ...draftFromSpec("module", MODULES.ZU37KS), accessories: [{ article_no: "ZZ99X1", label: "Verbinder", qty: 1, verified: true }] };
    const { onSubmit } = renderForm({ initialDraft: withOne });
    fireEvent.click(within(screen.getByRole("group", { name: "Zubehör 1" })).getByRole("button", { name: "Zubehör 1 entfernen" }));
    expect(screen.queryByRole("group", { name: "Zubehör 1" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Speichern" }));
    expect((submitted(onSubmit).spec as ModuleSpec).accessories).toEqual([]);
  });

  it("a used code: size, family and field height are locked, and it says how often it is used", () => {
    renderForm({ usedByPlans: 3 });
    expect(screen.getByText("In 3 Plänen verwendet")).toBeTruthy();
    for (const label of ["Familie", "Feldhöhe", "Breite (Felder)", "Höhe (Raster à 150 mm)"]) {
      expect((details().getByLabelText(label) as HTMLSelectElement).disabled).toBe(true);
    }
    expect((details().getByLabelText("Code") as HTMLInputElement).disabled).toBe(true);
    expect((details().getByLabelText("Bezeichnung") as HTMLInputElement).disabled).toBe(false);
  });

  it("an edit that drops a rail key is refused in the server's words", () => {
    const { onSubmit } = renderForm();
    const editor = screen.getByLabelText("Aufbau (JSON, für Fortgeschrittene)") as HTMLTextAreaElement;
    const aufbau = JSON.parse(editor.value) as Pick<ModuleSpec, "zones">;
    const zones = aufbau.zones.map((zone) => ({ ...zone, rails: zone.rails.filter((rail) => rail.key !== "r7") }));
    fireEvent.change(editor, { target: { value: JSON.stringify({ ...aufbau, zones }) } });
    fireEvent.click(screen.getByRole("button", { name: "Speichern" }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toBe("Schlüssel „r7“ bleibt — ausmustern statt löschen oder umbenennen.");
  });

  it("the server's refusal is shown as is", () => {
    renderForm({ error: "Aufbau ungültig: zones[0].rails[0].ple — muss zwischen 1 und 24 liegen" });
    expect(screen.getByRole("alert").textContent).toBe("Aufbau ungültig: zones[0].rails[0].ple — muss zwischen 1 und 24 liegen");
  });

  it("busy: the save button waits", () => {
    renderForm({ busy: true });
    const button = screen.getByRole("button", { name: "Speichert…" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it("Abbrechen", () => {
    const { onCancel } = renderForm();
    fireEvent.click(screen.getByRole("button", { name: "Abbrechen" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  describe("creating", () => {
    const create = (overrides: Partial<CatalogEntryFormProps> = {}) =>
      renderForm({ mode: "create", initialDraft: blankDraft("module"), original: null, ...overrides });

    it("'Vorlage: wie …' copies a module of the same type", () => {
      create();
      const select = screen.getByLabelText("Vorlage: wie …") as HTMLSelectElement;
      const options = Array.from(select.options).map((option) => option.value);
      expect(options).toContain("ZU37KS");
      expect(options).not.toContain("ZB33S"); // a cabinet is no template for a module
      fireEvent.change(select, { target: { value: "ZH3EH16" } });
      expect((details().getByLabelText("Familie") as HTMLSelectElement).value).toBe("meter_ehz");
      const editor = screen.getByLabelText("Aufbau (JSON, für Fortgeschrittene)") as HTMLTextAreaElement;
      expect(JSON.parse(editor.value).fittings.map((fitting: { key: string }) => fitting.key)).toContain("hs");
    });

    it("code, article and name typed, then Anlegen", () => {
      const { onSubmit } = create();
      fireEvent.change(details().getByLabelText("Code"), { target: { value: "zx37test" } });
      fireEvent.change(details().getByLabelText("Artikelnummer"), { target: { value: "ZX37TEST" } });
      fireEvent.change(details().getByLabelText("Bezeichnung"), { target: { value: "Testfeld (erfunden)" } });
      fireEvent.click(screen.getByRole("button", { name: "Anlegen" }));
      const body = submitted(onSubmit);
      expect(body.entry_type).toBe("module");
      expect(body.spec).toMatchObject({ code: "ZX37TEST", article_no: "ZX37TEST", name: "Testfeld (erfunden)", verified: false });
    });

    it("a missing name is said before sending", () => {
      const { onSubmit } = create();
      fireEvent.change(details().getByLabelText("Code"), { target: { value: "ZX37TEST" } });
      fireEvent.change(details().getByLabelText("Artikelnummer"), { target: { value: "ZX37TEST" } });
      fireEvent.click(screen.getByRole("button", { name: "Anlegen" }));
      expect(onSubmit).not.toHaveBeenCalled();
      expect(screen.getByRole("alert").textContent).toMatch(/Bezeichnung/);
    });

    it("switching to Schrank swaps the fields and the Aufbau", () => {
      create();
      const group = within(screen.getByRole("group", { name: "Eintragstyp" }));
      fireEvent.click(group.getByRole("button", { name: "Schrank" }));
      expect(group.getByRole("button", { name: "Schrank" }).getAttribute("aria-pressed")).toBe("true");
      expect(details().queryByLabelText("Familie")).toBeNull();
      const editor = screen.getByLabelText("Aufbau (JSON, für Fortgeschrittene)") as HTMLTextAreaElement;
      expect(JSON.parse(editor.value)).toHaveProperty("units_per_field");
      const options = Array.from((screen.getByLabelText("Vorlage: wie …") as HTMLSelectElement).options).map((option) => option.value);
      expect(options).toContain("ZB33S");
    });

    it("no type switch when editing", () => {
      renderForm();
      expect(screen.queryByRole("group", { name: "Eintragstyp" })).toBeNull();
      expect(screen.queryByLabelText("Vorlage: wie …")).toBeNull();
    });
  });
});
