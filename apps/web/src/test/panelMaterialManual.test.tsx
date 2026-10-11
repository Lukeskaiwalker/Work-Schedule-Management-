/**
 * Material added to a Verteiler by hand, and the list as a PDF (owner,
 * 2026-10-09: "I should be able to add material to a panel manually as well
 * in the list and export that list as a PDF").
 *
 * These pin what would otherwise fail quietly: the add form sending anything
 * but the API's exact body (a shelf article, or a free text when nothing was
 * picked), closing after one line when a fitter adds five, accepting a
 * quantity the server refuses; a manual row losing its mark, offering the
 * GLOBAL mapping (the server refuses it for manual keys), or its edit and
 * remove controls reaching people who may not book.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { PanelMaterialList, type PanelMaterialListProps } from "../components/schaltplan/PanelMaterialList";
import type { PanelMaterial, PanelMaterialLine } from "../types/schaltplan";

vi.mock("../utils/schaltplanApi", () => ({
  getPanelMaterial: vi.fn(),
  bookPanelMaterial: vi.fn(),
  unbookPanelMaterial: vi.fn(),
  setPanelMaterialMapping: vi.fn(),
  addPanelMaterialManual: vi.fn(),
  updatePanelMaterialManual: vi.fn(),
  deletePanelMaterialManual: vi.fn(),
  panelMaterialPdfUrl: (panelId: number) => `/api/schaltplan/panels/${panelId}/material/pdf`,
}));

vi.mock("../utils/werkstattArticlesApi", () => ({ listArticles: vi.fn() }));

import {
  addPanelMaterialManual,
  deletePanelMaterialManual,
  getPanelMaterial,
  updatePanelMaterialManual,
} from "../utils/schaltplanApi";
import { listArticles } from "../utils/werkstattArticlesApi";

const getMock = vi.mocked(getPanelMaterial);
const addMock = vi.mocked(addPanelMaterialManual);
const updateMock = vi.mocked(updatePanelMaterialManual);
const deleteMock = vi.mocked(deletePanelMaterialManual);
const articlesMock = vi.mocked(listArticles);

const ARTICLE = {
  id: 218,
  article_number: "SP-0187",
  item_name: "Hager MBN116 LS B16",
  manufacturer: "Hager",
  unit: "ST",
  internal_code: null,
  stock_available: 12,
};

const MCB: PanelMaterialLine = {
  key: "device:mcb:1p:b16",
  kind: "device",
  label: "Leitungsschutzschalter (LS) B16",
  detail: "1-polig · 1 TE",
  planned: 8,
  scanned: 3,
  status: "open",
  article: ARTICLE,
  article_source: "mapping",
  last_scanned_at: "2026-10-09T08:12:00",
};

const DUCT: PanelMaterialLine = {
  key: "manual:5",
  kind: "manual",
  label: "Verdrahtungskanal 40x60 grau",
  detail: "für Reihe 2",
  planned: 2,
  scanned: 0,
  status: "open",
  article: { ...ARTICLE, id: 400, article_number: "SP-0400", item_name: "Verdrahtungskanal 40x60 grau" },
  article_source: "manual",
  last_scanned_at: null,
  manual_id: 5,
  note: "für Reihe 2",
};

const TIES: PanelMaterialLine = {
  key: "manual:6",
  kind: "manual",
  label: "Kabelbinder schwarz",
  detail: "manuell",
  planned: 10,
  scanned: 0,
  status: "open",
  article: null,
  article_source: null,
  last_scanned_at: null,
  manual_id: 6,
  note: null,
};

const MATERIAL: PanelMaterial = {
  panel: {
    id: 7,
    panel_number: "VT-0007",
    designation: "ZV1",
    name: "Zählerverteiler",
    panel_type: "meter",
    status: "draft",
    customer_id: 3,
    customer_name: "Schulze",
    project_id: 244,
    project_number: "381",
    project_name: "Neubau Schulze",
    updated_at: "2026-10-09T08:00:00",
  },
  lines: [MCB, DUCT, TIES],
  planned_total: 20,
  scanned_total: 3,
  open_lines: 3,
  last_scanned_at: "2026-10-09T08:12:00",
};

function withLines(lines: PanelMaterialLine[]): PanelMaterial {
  return { ...MATERIAL, lines };
}

function renderList(overrides: Partial<PanelMaterialListProps> = {}) {
  const props: PanelMaterialListProps = {
    token: "t",
    panelId: 7,
    canEdit: true,
    language: "de",
    onChanged: vi.fn(),
    ...overrides,
  };
  return { ...props, ...render(<PanelMaterialList {...props} />) };
}

const rowOf = (label: string) => within(screen.getByText(label, { selector: "b" }).closest("li") as HTMLElement);

async function openAddForm() {
  fireEvent.click(await screen.findByRole("button", { name: "Material hinzufügen" }));
  return within(screen.getByRole("form", { name: "Material hinzufügen" }));
}

describe("PanelMaterialList — material added by hand", () => {
  beforeEach(() => {
    getMock.mockReset();
    addMock.mockReset();
    updateMock.mockReset();
    deleteMock.mockReset();
    articlesMock.mockReset();
    getMock.mockResolvedValue(MATERIAL);
    addMock.mockResolvedValue(MATERIAL);
    updateMock.mockResolvedValue(MATERIAL);
    deleteMock.mockResolvedValue(MATERIAL);
  });

  it("links the list as a PDF for everyone who sees it, and offers adding only to editors", async () => {
    const { unmount } = renderList();
    const pdf = await screen.findByRole("link", { name: "Als PDF" });
    expect(pdf).toHaveAttribute("href", "/api/schaltplan/panels/7/material/pdf");
    expect(pdf).toHaveAttribute("target", "_blank");
    expect(screen.getByRole("button", { name: "Material hinzufügen" })).toHaveAttribute("aria-expanded", "false");
    unmount();

    renderList({ canEdit: false });
    expect(await screen.findByRole("link", { name: "Als PDF" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Material hinzufügen" })).toBeNull();
    expect(rowOf("Kabelbinder schwarz").queryByRole("button", { name: "Ändern" })).toBeNull();
    expect(rowOf("Kabelbinder schwarz").queryByRole("button", { name: "Entfernen" })).toBeNull();
  });

  it("adds a shelf article with quantity and note, then stays open for the next line", async () => {
    articlesMock.mockResolvedValueOnce([
      { id: 401, article_number: "SP-0401", item_name: "Verdrahtungskanal 25x40", stock_available: 3 } as never,
    ]);
    const added: PanelMaterialLine = {
      ...DUCT,
      key: "manual:7",
      manual_id: 7,
      label: "Verdrahtungskanal 25x40",
      planned: 3,
      note: "Reihe 3",
      detail: "Reihe 3",
    };
    addMock.mockResolvedValueOnce(withLines([MCB, DUCT, TIES, added]));
    const { onChanged } = renderList();
    const form = await openAddForm();
    expect(screen.getByRole("button", { name: "Material hinzufügen" })).toHaveAttribute("aria-expanded", "true");

    fireEvent.change(form.getByRole("searchbox", { name: "Lagerartikel suchen oder Freitext" }), {
      target: { value: "Kanal" },
    });
    fireEvent.click(await form.findByRole("button", { name: /SP-0401/ }));
    expect(articlesMock).toHaveBeenCalledWith("t", { q: "Kanal", kind: "consumable", limit: 8 });
    // The pick replaces the search; "Andere Auswahl" brings it back.
    expect(form.queryByRole("searchbox")).toBeNull();
    expect(form.getByText("Verdrahtungskanal 25x40")).toBeInTheDocument();
    expect(form.getByRole("button", { name: "Andere Auswahl" })).toBeInTheDocument();

    fireEvent.change(form.getByRole("spinbutton", { name: "Menge" }), { target: { value: "3" } });
    fireEvent.change(form.getByRole("textbox", { name: "Notiz" }), { target: { value: " Reihe 3 " } });
    fireEvent.click(form.getByRole("button", { name: "Hinzufügen" }));

    expect(addMock).toHaveBeenCalledWith("t", 7, { article_id: 401, quantity: 3, note: "Reihe 3" });
    expect(await screen.findByText("„Verdrahtungskanal 25x40“ hinzugefügt.")).toBeInTheDocument();
    expect(rowOf("Verdrahtungskanal 25x40").getByText("/ 3")).toBeInTheDocument();
    expect(onChanged).toHaveBeenCalledTimes(1);
    // Still open, emptied, ready for the next one.
    const again = within(screen.getByRole("form", { name: "Material hinzufügen" }));
    expect(again.getByRole("searchbox", { name: "Lagerartikel suchen oder Freitext" })).toHaveValue("");
    expect(again.getByRole("spinbutton", { name: "Menge" })).toHaveValue(1);
    expect(again.getByRole("textbox", { name: "Notiz" })).toHaveValue("");
  });

  it("adds a free text when no article is picked", async () => {
    articlesMock.mockResolvedValue([]);
    addMock.mockResolvedValueOnce(MATERIAL);
    renderList();
    const form = await openAddForm();

    fireEvent.change(form.getByRole("searchbox", { name: "Lagerartikel suchen oder Freitext" }), {
      target: { value: "  Aderendhülsen 1,5 mm²  " },
    });
    expect(form.getByText("Ohne Auswahl wird „Aderendhülsen 1,5 mm²“ als Freitext übernommen.")).toBeInTheDocument();
    fireEvent.click(form.getByRole("button", { name: "Hinzufügen" }));

    expect(addMock).toHaveBeenCalledWith("t", 7, { label: "Aderendhülsen 1,5 mm²", quantity: 1 });
  });

  it("refuses to add nothing, or a quantity outside 1 to 9999", async () => {
    articlesMock.mockResolvedValue([]);
    renderList();
    const form = await openAddForm();
    const submit = form.getByRole("button", { name: "Hinzufügen" });
    expect(submit).toBeDisabled();

    fireEvent.change(form.getByRole("searchbox", { name: "Lagerartikel suchen oder Freitext" }), {
      target: { value: "Kabelbinder" },
    });
    expect(submit).toBeEnabled();
    const quantity = form.getByRole("spinbutton", { name: "Menge" });
    for (const bad of ["0", "10000", "", "2.5"]) {
      fireEvent.change(quantity, { target: { value: bad } });
      expect(submit).toBeDisabled();
    }
    fireEvent.change(quantity, { target: { value: "9999" } });
    expect(submit).toBeEnabled();
    fireEvent.submit(screen.getByRole("form", { name: "Material hinzufügen" }));
    expect(addMock).toHaveBeenCalledTimes(1);
  });

  it("marks a manual line, and offers no global mapping for it", async () => {
    renderList();
    await screen.findByText("Kabelbinder schwarz");

    const duct = rowOf("Verdrahtungskanal 40x60 grau");
    expect(duct.getByText("manuell", { selector: ".sp-mat-chip" })).toBeInTheDocument();
    expect(duct.getByText("für Reihe 2")).toBeInTheDocument();
    expect(duct.getByText("SP-0400")).toBeInTheDocument();
    expect(duct.queryByRole("button", { name: /Zuordnung|Artikel zuordnen/ })).toBeNull();
    // It names a shelf article, so it books like any other line.
    expect(duct.getByRole("button", { name: "+1" })).toBeInTheDocument();

    const ties = rowOf("Kabelbinder schwarz");
    // "manuell" once — the mark, not the server's fallback detail repeated.
    expect(ties.getAllByText("manuell")).toHaveLength(1);
    expect(ties.getByText("Freitext — kein Lagerartikel")).toBeInTheDocument();
    // Nothing can be scanned against it: its quantity, no "0 /" that never moves.
    expect(ties.getByText("—", { selector: ".sp-mat-qty-scanned" })).toBeInTheDocument();
    expect(ties.getByText("/ 10")).toBeInTheDocument();
    expect(ties.queryByRole("button", { name: "Artikel zuordnen" })).toBeNull();
    expect(ties.queryByRole("button", { name: "+1" })).toBeNull();
    // A planned line is not editable here: the plan owns it.
    expect(rowOf("Leitungsschutzschalter (LS) B16").queryByRole("button", { name: "Ändern" })).toBeNull();
  });

  it("changes the quantity and note of a manual line", async () => {
    updateMock.mockResolvedValueOnce(withLines([MCB, { ...DUCT, planned: 4, note: "Reihe 2 + 3", detail: "Reihe 2 + 3" }, TIES]));
    const { onChanged } = renderList();
    await screen.findByText("Verdrahtungskanal 40x60 grau", { selector: "b" });

    fireEvent.click(rowOf("Verdrahtungskanal 40x60 grau").getByRole("button", { name: "Ändern" }));
    const editor = within(screen.getByRole("form", { name: "Verdrahtungskanal 40x60 grau ändern" }));
    expect(editor.getByRole("spinbutton", { name: "Menge" })).toHaveValue(2);
    expect(editor.getByRole("textbox", { name: "Notiz" })).toHaveValue("für Reihe 2");

    fireEvent.change(editor.getByRole("spinbutton", { name: "Menge" }), { target: { value: "4" } });
    fireEvent.change(editor.getByRole("textbox", { name: "Notiz" }), { target: { value: "Reihe 2 + 3" } });
    fireEvent.click(editor.getByRole("button", { name: "Speichern" }));

    expect(updateMock).toHaveBeenCalledWith("t", 7, 5, { quantity: 4, note: "Reihe 2 + 3" });
    await waitFor(() => expect(screen.queryByRole("form", { name: /ändern/ })).toBeNull());
    expect(rowOf("Verdrahtungskanal 40x60 grau").getByText("/ 4")).toBeInTheDocument();
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("clears a note by saving it empty, and cancels without a request", async () => {
    updateMock.mockResolvedValueOnce(MATERIAL);
    renderList();
    await screen.findByText("Verdrahtungskanal 40x60 grau", { selector: "b" });

    fireEvent.click(rowOf("Verdrahtungskanal 40x60 grau").getByRole("button", { name: "Ändern" }));
    fireEvent.click(screen.getByRole("button", { name: "Abbrechen" }));
    expect(screen.queryByRole("form", { name: /ändern/ })).toBeNull();
    expect(updateMock).not.toHaveBeenCalled();

    fireEvent.click(rowOf("Verdrahtungskanal 40x60 grau").getByRole("button", { name: "Ändern" }));
    const editor = within(screen.getByRole("form", { name: "Verdrahtungskanal 40x60 grau ändern" }));
    fireEvent.change(editor.getByRole("textbox", { name: "Notiz" }), { target: { value: "   " } });
    fireEvent.click(editor.getByRole("button", { name: "Speichern" }));
    expect(updateMock).toHaveBeenCalledWith("t", 7, 5, { quantity: 2, note: "" });
  });

  it("removes a manual line", async () => {
    deleteMock.mockResolvedValueOnce(withLines([MCB, DUCT]));
    const { onChanged } = renderList();
    await screen.findByText("Kabelbinder schwarz");

    fireEvent.click(rowOf("Kabelbinder schwarz").getByRole("button", { name: "Entfernen" }));

    expect(deleteMock).toHaveBeenCalledWith("t", 7, 6);
    await waitFor(() => expect(screen.queryByText("Kabelbinder schwarz")).toBeNull());
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("shows the server's sentence when adding fails, and keeps what was typed", async () => {
    articlesMock.mockResolvedValue([]);
    addMock.mockRejectedValueOnce(new Error("Artikel ist archiviert."));
    renderList();
    const form = await openAddForm();
    fireEvent.change(form.getByRole("searchbox", { name: "Lagerartikel suchen oder Freitext" }), {
      target: { value: "Kabelbinder" },
    });
    fireEvent.click(form.getByRole("button", { name: "Hinzufügen" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Artikel ist archiviert.");
    expect(form.getByRole("searchbox", { name: "Lagerartikel suchen oder Freitext" })).toHaveValue("Kabelbinder");
  });
});
