/**
 * The Materialliste of a board with a cabinet (docs/PANEL_ENCLOSURE.md §6):
 * the cabinet and its modules are lines like any other, and a part taken out
 * of a pre-fitted module is a RETURN — it goes back on the shelf, so it is
 * never among the picks, never booked with the consumption buttons, and only
 * the Werkstatt (`werkstatt:manage`) books it "Ins Lager" or takes it back.
 *
 * Pinned here because each of these fails quietly: a removed line with a
 * "+1" button books a part INTO the board that went the other way; a return
 * button for an employee raises stock without a part in hand; an orphan line
 * without "Zurücknehmen" makes a return impossible to undo; a PDF link that
 * does not wait for the saves prints the list of a second ago.
 *
 * All data is invented.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { PanelMaterialList, type PanelMaterialListProps } from "../components/schaltplan/PanelMaterialList";
import type { PanelMaterial, PanelMaterialArticle, PanelMaterialLine } from "../types/schaltplan";

vi.mock("../utils/schaltplanApi", () => ({
  getPanelMaterial: vi.fn(),
  bookPanelMaterial: vi.fn(),
  unbookPanelMaterial: vi.fn(),
  setPanelMaterialMapping: vi.fn(),
  addPanelMaterialManual: vi.fn(),
  updatePanelMaterialManual: vi.fn(),
  deletePanelMaterialManual: vi.fn(),
  endPanelWorkSession: vi.fn(),
  panelMaterialPdfUrl: (panelId: number) => `/api/schaltplan/panels/${panelId}/material/pdf`,
}));

vi.mock("../utils/schaltplanEnclosureApi", () => ({
  salvagePanelMaterial: vi.fn(),
  unsalvagePanelMaterial: vi.fn(),
}));

vi.mock("../utils/werkstattArticlesApi", () => ({ listArticles: vi.fn() }));

import { bookPanelMaterial, getPanelMaterial, unbookPanelMaterial } from "../utils/schaltplanApi";
import { salvagePanelMaterial, unsalvagePanelMaterial } from "../utils/schaltplanEnclosureApi";

const getMock = vi.mocked(getPanelMaterial);
const bookMock = vi.mocked(bookPanelMaterial);
const unbookMock = vi.mocked(unbookPanelMaterial);
const salvageMock = vi.mocked(salvagePanelMaterial);
const unsalvageMock = vi.mocked(unsalvagePanelMaterial);

const HINT = "Ins Lager bucht die Werkstatt.";
const RETURNS_TITLE = "Aus Modulen entfernt → ins Lager";

function article(id: number, number: string, name: string): PanelMaterialArticle {
  return { id, article_number: number, item_name: name, manufacturer: "Hager", unit: "ST", internal_code: null, stock_available: 4 };
}

const CABINET: PanelMaterialLine = {
  key: "enclosure:ZB33S",
  kind: "enclosure",
  label: "Zählerschrank univers Z, 3 Felder",
  detail: "Hager ZB33S · 1100 × 800 × 205 mm · 3 Felder",
  planned: 1,
  scanned: 0,
  status: "open",
  article: article(501, "SP-0501", "Hager ZB33S Zählerschrank"),
  article_source: "auto",
  last_scanned_at: null,
};

const MODULE: PanelMaterialLine = {
  key: "module:ZU37KS",
  kind: "enclosure",
  label: "Verteilerfeld 3 Reihen",
  detail: "Hager ZU37KS · 1 Feld · 450 mm",
  planned: 2,
  scanned: 0,
  status: "open",
  article: null,
  article_source: null,
  last_scanned_at: null,
};

const MCB: PanelMaterialLine = {
  key: "device:mcb:1p:b16",
  kind: "device",
  label: "Leitungsschutzschalter (LS) B16",
  detail: "1-polig · 1 TE",
  planned: 8,
  scanned: 2,
  status: "open",
  article: article(218, "SP-0218", "LS-Schalter B16 1-polig"),
  article_source: "mapping",
  last_scanned_at: "2026-10-21T08:12:00",
};

const REMOVED_HS: PanelMaterialLine = {
  key: "removed:ZH3EH16:hs",
  kind: "removed",
  label: "Hauptschalter",
  detail: "aus Modul entfernt → ins Lager · ZH3EH16",
  planned: 1,
  scanned: 0,
  status: "open",
  article: article(611, "SP-0611", "Hauptschalter 3-polig 63 A"),
  article_source: "auto",
  last_scanned_at: null,
};

const REMOVED_NO_ARTICLE: PanelMaterialLine = {
  key: "removed:ZH3EH16:hlak",
  kind: "removed",
  label: "Hauptleitungsabzweigklemme",
  detail: "aus Modul entfernt → ins Lager · ZH3EH16",
  planned: 1,
  scanned: 0,
  status: "open",
  article: null,
  article_source: null,
  last_scanned_at: null,
};

const ORPHAN: PanelMaterialLine = {
  key: "salvage:512",
  kind: "removed",
  label: "Sammelschiene 5-polig Beispiel",
  detail: "eingelagert, im Plan nicht mehr als entfernt geführt",
  planned: 0,
  scanned: 1,
  status: "unplanned",
  article: article(512, "SP-0512", "Sammelschiene 5-polig Beispiel"),
  article_source: null,
  last_scanned_at: "2026-10-21T09:00:00",
};

const EXTRA: PanelMaterialLine = {
  key: "article:300",
  kind: "extra",
  label: "Hutschiene 35 mm",
  detail: "nicht geplant",
  planned: 0,
  scanned: 1,
  status: "unplanned",
  article: article(300, "SP-0300", "Hutschiene 35 mm"),
  article_source: null,
  last_scanned_at: "2026-10-21T08:12:00",
};

function material(lines: PanelMaterialLine[], returnsOpen = 2): PanelMaterial {
  return {
    panel: {
      id: 7,
      panel_number: "VT-0042",
      designation: "ZS1",
      name: "Zählerschrank Beispiel",
      panel_type: "meter",
      status: "draft",
      customer_id: 3,
      customer_name: "Familie Beispiel",
      project_id: null,
      project_number: null,
      project_name: null,
      updated_at: "2026-10-21T08:00:00",
    },
    lines,
    planned_total: 11,
    scanned_total: 3,
    open_lines: 3,
    returns_open: returnsOpen,
    last_scanned_at: "2026-10-21T08:12:00",
  };
}

const FULL = material([CABINET, MODULE, MCB, REMOVED_HS, REMOVED_NO_ARTICLE, ORPHAN, EXTRA]);

function renderList(overrides: Partial<PanelMaterialListProps> = {}) {
  const props: PanelMaterialListProps = {
    token: "t",
    panelId: 7,
    canEdit: true,
    language: "de",
    onChanged: vi.fn(),
    canManageWerkstatt: true,
    ...overrides,
  };
  return { ...props, ...render(<PanelMaterialList {...props} />) };
}

const rowOf = (label: string) => within(screen.getByText(label, { selector: "b" }).closest("li") as HTMLElement);

function labelsIn(list: HTMLElement): string[] {
  return within(list)
    .getAllByRole("listitem")
    .map((item) => item.querySelector("b")?.textContent ?? "");
}

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.clearAllMocks();
  getMock.mockResolvedValue(FULL);
});

afterEach(() => vi.unstubAllGlobals());

describe("Materialliste — the cabinet and the parts going back", () => {
  it("lists the cabinet and modules with the picks, and the returns in their own block after them", async () => {
    renderList();
    const picks = await screen.findByRole("list", { name: "Materialliste" });
    expect(labelsIn(picks)).toEqual([CABINET.label, MODULE.label, MCB.label, EXTRA.label]);

    const returns = screen.getByRole("list", { name: RETURNS_TITLE });
    expect(labelsIn(returns)).toEqual([REMOVED_HS.label, REMOVED_NO_ARTICLE.label, ORPHAN.label]);
    expect(screen.getByRole("heading", { name: RETURNS_TITLE })).toBeInTheDocument();

    // The server's detail stands as it is, and the line says which way the part goes.
    const hs = rowOf(REMOVED_HS.label);
    expect(hs.getByText(REMOVED_HS.detail)).toBeInTheDocument();
    expect(hs.getByText("Rücklauf ins Lager −1")).toBeInTheDocument();
    expect(hs.getByText("offen")).toBeInTheDocument();
    // Never the consumption buttons: a return is not a pick.
    expect(hs.queryByRole("button", { name: "+1" })).toBeNull();
    expect(hs.queryByRole("button", { name: "−1" })).toBeNull();
    expect(rowOf(ORPHAN.label).getByText("Rücklauf ins Lager −1")).toBeInTheDocument();
  });

  it("books a cabinet line like a device line, with the consumption buttons", async () => {
    bookMock.mockResolvedValueOnce(FULL);
    renderList();
    const cabinet = (await screen.findByText(CABINET.label, { selector: "b" })).closest("li") as HTMLElement;
    fireEvent.click(within(cabinet).getByRole("button", { name: "+1" }));
    await waitFor(() => expect(bookMock).toHaveBeenCalledWith("t", 7, { article_id: 501, quantity: 1 }));
    expect(salvageMock).not.toHaveBeenCalled();
  });

  it("books a removed part back into stock with Ins Lager and shows it eingelagert", async () => {
    const stored = material([CABINET, MODULE, MCB, { ...REMOVED_HS, scanned: 1, status: "done" }, ORPHAN, EXTRA], 0);
    salvageMock.mockResolvedValueOnce(stored);
    const { onChanged } = renderList();
    await screen.findByText(REMOVED_HS.label, { selector: "b" });
    const hs = rowOf(REMOVED_HS.label);
    // Nothing booked yet: nothing to take back.
    expect(hs.getByRole("button", { name: "Zurücknehmen" })).toBeDisabled();

    fireEvent.click(hs.getByRole("button", { name: "Ins Lager" }));

    await waitFor(() => expect(salvageMock).toHaveBeenCalledWith("t", 7, 611, 1));
    await waitFor(() => expect(rowOf(REMOVED_HS.label).getByText("eingelagert")).toBeInTheDocument());
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(bookMock).not.toHaveBeenCalled();
    // All of it is back: no more "Ins Lager" for this line, but it can be taken back.
    expect(rowOf(REMOVED_HS.label).getByRole("button", { name: "Ins Lager" })).toBeDisabled();
    expect(rowOf(REMOVED_HS.label).getByRole("button", { name: "Zurücknehmen" })).toBeEnabled();
  });

  it("takes a return back from an orphan line, which offers nothing to book in", async () => {
    unsalvageMock.mockResolvedValueOnce(material([CABINET, MODULE, MCB, REMOVED_HS, EXTRA]));
    renderList();
    await screen.findByText(ORPHAN.label, { selector: "b" });
    const orphan = rowOf(ORPHAN.label);
    expect(orphan.getByText("zu viel eingelagert")).toBeInTheDocument();
    expect(orphan.queryByRole("button", { name: "Ins Lager" })).toBeNull();
    // The server never maps a `salvage:` key: no assignment offered.
    expect(orphan.queryByRole("button", { name: "Zuordnung ändern" })).toBeNull();

    fireEvent.click(orphan.getByRole("button", { name: "Zurücknehmen" }));

    await waitFor(() => expect(unsalvageMock).toHaveBeenCalledWith("t", 7, 512, 1));
    await waitFor(() => expect(screen.queryByText(ORPHAN.label, { selector: "b" })).toBeNull());
    expect(unbookMock).not.toHaveBeenCalled();
  });

  it("keeps the return buttons disabled without werkstatt:manage and says who books them", async () => {
    getMock.mockResolvedValue(material([MCB, { ...REMOVED_HS, scanned: 1, planned: 2 }, REMOVED_NO_ARTICLE, ORPHAN]));
    renderList({ canManageWerkstatt: false });
    await screen.findByText(REMOVED_HS.label, { selector: "b" });

    expect(screen.getByText(HINT)).toBeInTheDocument();
    const hs = rowOf(REMOVED_HS.label);
    const toStock = hs.getByRole("button", { name: "Ins Lager" });
    const takeBack = hs.getByRole("button", { name: "Zurücknehmen" });
    expect(toStock).toBeDisabled();
    expect(takeBack).toBeDisabled();
    expect(toStock).toHaveAttribute("title", HINT);
    fireEvent.click(toStock);
    fireEvent.click(takeBack);
    expect(salvageMock).not.toHaveBeenCalled();
    expect(unsalvageMock).not.toHaveBeenCalled();
    expect(rowOf(ORPHAN.label).getByRole("button", { name: "Zurücknehmen" })).toBeDisabled();

    // Mapping a `removed:` key is the Werkstatt's too (the server answers 403).
    expect(rowOf(REMOVED_NO_ARTICLE.label).queryByRole("button", { name: "Artikel zuordnen" })).toBeNull();
    expect(hs.queryByRole("button", { name: "Zuordnung ändern" })).toBeNull();
    // Device lines keep their reports:create rights.
    expect(rowOf(MCB.label).getByRole("button", { name: "Zuordnung ändern" })).toBeInTheDocument();
  });

  it("lets the Werkstatt assign an article to a removed line that has none", async () => {
    renderList();
    await screen.findByText(REMOVED_NO_ARTICLE.label, { selector: "b" });
    const hlak = rowOf(REMOVED_NO_ARTICLE.label);
    expect(hlak.getByText("Kein Lagerartikel zugeordnet")).toBeInTheDocument();
    expect(hlak.getByRole("button", { name: "Artikel zuordnen" })).toBeInTheDocument();
    // No article, nothing to book.
    expect(hlak.queryByRole("button", { name: "Ins Lager" })).toBeNull();
    expect(screen.queryByText(HINT)).toBeNull();
  });

  it("books returns for the Werkstatt without reports:create, but leaves the mapping to who has both", async () => {
    salvageMock.mockResolvedValueOnce(FULL);
    renderList({ canEdit: false, canManageWerkstatt: true });
    await screen.findByText(REMOVED_HS.label, { selector: "b" });
    // The mapping route needs reports:create first (and werkstatt:manage for `removed:`).
    expect(rowOf(REMOVED_NO_ARTICLE.label).queryByRole("button", { name: "Artikel zuordnen" })).toBeNull();
    expect(screen.queryByText(HINT)).toBeNull();

    fireEvent.click(rowOf(REMOVED_HS.label).getByRole("button", { name: "Ins Lager" }));
    await waitFor(() => expect(salvageMock).toHaveBeenCalledWith("t", 7, 611, 1));
  });

  it("shows a refused return in the server's words", async () => {
    salvageMock.mockRejectedValueOnce(new Error("Mehr als aus Modulen entfernt — offen sind noch 0."));
    const { onChanged } = renderList();
    await screen.findByText(REMOVED_HS.label, { selector: "b" });
    fireEvent.click(rowOf(REMOVED_HS.label).getByRole("button", { name: "Ins Lager" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Mehr als aus Modulen entfernt — offen sind noch 0.");
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("counts the open returns in the footer, apart from the picking totals", async () => {
    const { unmount } = renderList();
    expect(await screen.findByText("2 × ins Lager offen")).toBeInTheDocument();
    expect(screen.getByText("3 / 11")).toBeInTheDocument();
    unmount();

    getMock.mockResolvedValue(material([MCB], 0));
    renderList();
    await screen.findByText(MCB.label, { selector: "b" });
    expect(screen.queryByText(/ins Lager offen/)).toBeNull();
    expect(screen.queryByRole("list", { name: RETURNS_TITLE })).toBeNull();
  });

  it("speaks English on the Werkstatt page", async () => {
    renderList({ language: "en" });
    await screen.findByText(REMOVED_HS.label, { selector: "b" });
    const hs = rowOf(REMOVED_HS.label);
    expect(hs.getByRole("button", { name: "To stock" })).toBeEnabled();
    expect(hs.getByText("Return to stock −1")).toBeInTheDocument();
    expect(screen.getByText("2 × to return to stock")).toBeInTheDocument();
  });
});

describe("Materialliste PDF — opens once the board is saved", () => {
  function fakeWindow() {
    return { opener: {} as unknown, location: { href: "" }, close: vi.fn() };
  }

  it("opens the window inside the tap and points it at the PDF after the saves settled", async () => {
    const win = fakeWindow();
    const open = vi.fn(() => win);
    vi.stubGlobal("open", open);
    const settle = deferred<boolean>();
    renderList({ settleSaves: () => settle.promise });
    const link = await screen.findByRole("link", { name: "Als PDF" });
    // The in-app viewer must not open it before the saves (OWN_OPENER_PROPS).
    expect(link).toHaveAttribute("data-own-opener");
    expect(link).toHaveAttribute("href", "/api/schaltplan/panels/7/material/pdf");

    fireEvent.click(link);
    expect(open).toHaveBeenCalledTimes(1);
    expect(win.location.href).toBe("");

    await act(async () => settle.resolve(true));
    await waitFor(() => expect(win.location.href).toBe("/api/schaltplan/panels/7/material/pdf"));
  });

  it("closes the window again and says why when the saves did not land", async () => {
    const win = fakeWindow();
    vi.stubGlobal("open", vi.fn(() => win));
    renderList({ settleSaves: async () => false });
    fireEvent.click(await screen.findByRole("link", { name: "Als PDF" }));

    await waitFor(() => expect(win.close).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole("alert")).toHaveTextContent(/^PDF nicht geöffnet/);
  });

  it("opens straight away where no editor is waiting to save (the Werkstatt page)", async () => {
    const win = fakeWindow();
    vi.stubGlobal("open", vi.fn(() => win));
    renderList();
    fireEvent.click(await screen.findByRole("link", { name: "Als PDF" }));
    await waitFor(() => expect(win.location.href).toBe("/api/schaltplan/panels/7/material/pdf"));
  });
});
