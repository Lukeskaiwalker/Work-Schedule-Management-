/**
 * The Materialliste of one Verteiler: what the plan needs against what has
 * been booked. These pin the things that would otherwise fail quietly — a
 * line rendered out of the server's order, an extra scan not flagged, the
 * mapping control missing for the one person who may use it, a booking sent
 * with the wrong body, and a refused booking swallowed instead of shown.
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
}));

vi.mock("../utils/werkstattArticlesApi", () => ({ listArticles: vi.fn() }));

import {
  bookPanelMaterial,
  getPanelMaterial,
  setPanelMaterialMapping,
  unbookPanelMaterial,
} from "../utils/schaltplanApi";
import { listArticles } from "../utils/werkstattArticlesApi";

const getMock = vi.mocked(getPanelMaterial);
const bookMock = vi.mocked(bookPanelMaterial);
const unbookMock = vi.mocked(unbookPanelMaterial);
const mappingMock = vi.mocked(setPanelMaterialMapping);
const articlesMock = vi.mocked(listArticles);

const ARTICLE = {
  id: 218,
  article_number: "SP-0187",
  item_name: "WAGO 2003-7641 - TOPJOB S Durchgangsklemme",
  manufacturer: "WAGO",
  unit: "ST",
  internal_code: "SMPL-81JHYT",
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
  last_scanned_at: "2026-09-24T08:12:00",
};

const RCD: PanelMaterialLine = {
  key: "device:rcd:4p:40a",
  kind: "device",
  label: "FI-Schutzschalter 40 A",
  detail: "4-polig · 4 TE",
  planned: 2,
  scanned: 0,
  status: "open",
  article: null,
  article_source: null,
  last_scanned_at: null,
};

const TERMINAL: PanelMaterialLine = {
  key: "part:2003-7641",
  kind: "terminal",
  label: "WAGO 2003-7641",
  detail: "Durchgangsklemme 2,5 mm²",
  planned: 12,
  scanned: 12,
  status: "done",
  article: { ...ARTICLE, id: 219, article_number: "SP-0188" },
  article_source: "auto",
  last_scanned_at: "2026-09-24T08:12:00",
};

const OVER: PanelMaterialLine = {
  key: "part:2003-7642",
  kind: "terminal",
  label: "WAGO 2003-7642",
  detail: "Durchgangsklemme blau",
  planned: 2,
  scanned: 3,
  status: "over",
  article: { ...ARTICLE, id: 220, article_number: "SP-0189" },
  article_source: "auto",
  last_scanned_at: "2026-09-24T08:12:00",
};

const EXTRA: PanelMaterialLine = {
  key: "article:300",
  kind: "extra",
  label: "Hutschiene 35 mm",
  detail: "nicht geplant",
  planned: 0,
  scanned: 1,
  status: "unplanned",
  article: { ...ARTICLE, id: 300, article_number: "SP-0300", item_name: "Hutschiene 35 mm" },
  article_source: null,
  last_scanned_at: "2026-09-24T08:12:00",
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
    updated_at: "2026-09-24T08:00:00",
  },
  lines: [MCB, RCD, TERMINAL, OVER, EXTRA],
  planned_total: 24,
  scanned_total: 19,
  open_lines: 2,
  last_scanned_at: "2026-09-24T08:12:00",
};

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

// The label is the row's <b>; an extra line's article name repeats it.
const rowOf = (label: string) => within(screen.getByText(label, { selector: "b" }).closest("li") as HTMLElement);

describe("PanelMaterialList", () => {
  beforeEach(() => {
    getMock.mockReset();
    bookMock.mockReset();
    unbookMock.mockReset();
    mappingMock.mockReset();
    articlesMock.mockReset();
    getMock.mockResolvedValue(MATERIAL);
  });

  it("loads the panel's list and shows every line in the server's order", async () => {
    renderList();
    expect(screen.getByRole("status")).toHaveTextContent("Materialliste wird geladen…");

    expect(await screen.findByText("Leitungsschutzschalter (LS) B16")).toBeInTheDocument();
    expect(getMock).toHaveBeenCalledWith("t", 7);

    const labels = screen.getAllByRole("listitem").map((row) => row.querySelector("b")?.textContent);
    expect(labels).toEqual([
      "Leitungsschutzschalter (LS) B16",
      "FI-Schutzschalter 40 A",
      "WAGO 2003-7641",
      "WAGO 2003-7642",
      "Hutschiene 35 mm",
    ]);

    // scanned / planned, the article with its SP number, the auto hint.
    const mcb = rowOf("Leitungsschutzschalter (LS) B16");
    expect(mcb.getByText("3")).toBeInTheDocument();
    expect(mcb.getByText("/ 8")).toBeInTheDocument();
    expect(mcb.getByText("SP-0187")).toBeInTheDocument();
    expect(mcb.getByText("WAGO 2003-7641 - TOPJOB S Durchgangsklemme")).toBeInTheDocument();
    expect(mcb.queryByText("auto")).toBeNull();
    expect(rowOf("WAGO 2003-7641").getByText("auto")).toBeInTheDocument();

    // Header and footer.
    expect(screen.getByRole("heading", { name: "VT-0007 · ZV1 Zählerverteiler" })).toBeInTheDocument();
    expect(screen.getByText("Schulze · 381 Neubau Schulze")).toBeInTheDocument();
    expect(screen.getByText("19 / 24")).toBeInTheDocument();
    expect(screen.getByText("2 offen")).toBeInTheDocument();
  });

  it("marks done, over and unplanned lines", async () => {
    renderList();
    await screen.findByText("Leitungsschutzschalter (LS) B16");

    expect(rowOf("WAGO 2003-7641").getByRole("img", { name: "vollständig" })).toBeInTheDocument();
    expect(rowOf("WAGO 2003-7642").getByText("zu viel")).toBeInTheDocument();
    const extra = rowOf("Hutschiene 35 mm");
    expect(extra.getByText("nicht geplant", { selector: ".sp-mat-chip" })).toBeInTheDocument();
    // An extra line is an article already; nothing to map.
    expect(extra.queryByRole("button", { name: /Zuordnung/ })).toBeNull();
    expect(rowOf("Leitungsschutzschalter (LS) B16").queryByRole("img")).toBeNull();
  });

  it("hides the header on request", async () => {
    renderList({ hideHeader: true });
    await screen.findByText("Leitungsschutzschalter (LS) B16");
    expect(screen.queryByRole("heading")).toBeNull();
  });

  it("offers the mapping control for an unmapped line only to someone who may edit", async () => {
    const { unmount } = renderList();
    await screen.findByText("FI-Schutzschalter 40 A");
    const rcd = rowOf("FI-Schutzschalter 40 A");
    expect(rcd.getByText("Kein Lagerartikel zugeordnet")).toBeInTheDocument();
    expect(rcd.getByRole("button", { name: "Artikel zuordnen" })).toBeInTheDocument();
    // No article, nothing to book against.
    expect(rcd.queryByRole("button", { name: "+1" })).toBeNull();
    unmount();

    renderList({ canEdit: false });
    await screen.findByText("FI-Schutzschalter 40 A");
    expect(screen.queryByRole("button", { name: "Artikel zuordnen" })).toBeNull();
    expect(screen.queryByRole("button", { name: "+1" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Zuordnung entfernen" })).toBeNull();
  });

  it("books one piece on +1 with exactly the API's body, and shows the answer", async () => {
    const after: PanelMaterial = {
      ...MATERIAL,
      lines: MATERIAL.lines.map((line) => (line.key === MCB.key ? { ...line, scanned: 4 } : line)),
      scanned_total: 20,
    };
    bookMock.mockResolvedValueOnce(after);
    const { onChanged } = renderList();
    await screen.findByText("Leitungsschutzschalter (LS) B16");

    fireEvent.click(rowOf("Leitungsschutzschalter (LS) B16").getByRole("button", { name: "+1" }));

    expect(bookMock).toHaveBeenCalledWith("t", 7, { article_id: 218, quantity: 1 });
    expect(await screen.findByText("20 / 24")).toBeInTheDocument();
    expect(rowOf("Leitungsschutzschalter (LS) B16").getByText("4")).toBeInTheDocument();
    expect(onChanged).toHaveBeenCalledTimes(1);
    // Only one fetch: the booking's answer is the new list.
    expect(getMock).toHaveBeenCalledTimes(1);
  });

  it("takes one back on −1, and blocks every booking button while the request runs", async () => {
    let settle: (material: PanelMaterial) => void = () => undefined;
    unbookMock.mockReturnValueOnce(new Promise<PanelMaterial>((resolve) => { settle = resolve; }));
    renderList();
    await screen.findByText("Leitungsschutzschalter (LS) B16");

    fireEvent.click(rowOf("Leitungsschutzschalter (LS) B16").getByRole("button", { name: "−1" }));
    expect(unbookMock).toHaveBeenCalledWith("t", 7, { article_id: 218, quantity: 1 });
    // Another line's +1 waits too: two answers must not race into the list.
    expect(rowOf("WAGO 2003-7641").getByRole("button", { name: "+1" })).toBeDisabled();

    settle(MATERIAL);
    await waitFor(() => expect(rowOf("WAGO 2003-7641").getByRole("button", { name: "+1" })).toBeEnabled());
  });

  it("shows the server's sentence when a booking is refused", async () => {
    unbookMock.mockRejectedValueOnce(new Error("Nichts zum Zurücknehmen — für diesen Artikel ist nichts gebucht."));
    const { onChanged } = renderList();
    await screen.findByText("Leitungsschutzschalter (LS) B16");

    fireEvent.click(rowOf("Leitungsschutzschalter (LS) B16").getByRole("button", { name: "−1" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Nichts zum Zurücknehmen — für diesen Artikel ist nichts gebucht.",
    );
    expect(onChanged).not.toHaveBeenCalled();
    // The list is still there and usable.
    expect(rowOf("Leitungsschutzschalter (LS) B16").getByRole("button", { name: "+1" })).toBeEnabled();
  });

  it("disables the −1 button on a line with nothing booked", async () => {
    getMock.mockResolvedValue({
      ...MATERIAL,
      lines: MATERIAL.lines.map((line) => (line.key === MCB.key ? { ...line, scanned: 0 } : line)),
    });
    renderList();
    await screen.findByText("Leitungsschutzschalter (LS) B16");
    const mcb = rowOf("Leitungsschutzschalter (LS) B16");
    expect(mcb.getByRole("button", { name: "−1" })).toBeDisabled();
    expect(mcb.getByRole("button", { name: "+1" })).toBeEnabled();
  });

  it("assigns an article from the inline search, then reloads", async () => {
    articlesMock.mockResolvedValueOnce([
      {
        id: 301,
        article_number: "SP-0301",
        item_name: "Hager FI 40 A 30 mA",
        stock_available: 4,
      } as never,
    ]);
    mappingMock.mockResolvedValueOnce({ key: RCD.key, article: { ...ARTICLE, id: 301, article_number: "SP-0301" } });
    const mapped: PanelMaterial = {
      ...MATERIAL,
      lines: MATERIAL.lines.map((line) =>
        line.key === RCD.key
          ? { ...line, article: { ...ARTICLE, id: 301, article_number: "SP-0301", item_name: "Hager FI 40 A 30 mA" }, article_source: "mapping" as const }
          : line,
      ),
    };
    getMock.mockResolvedValueOnce(MATERIAL).mockResolvedValueOnce(mapped);
    const { onChanged } = renderList();
    await screen.findByText("FI-Schutzschalter 40 A");

    fireEvent.click(rowOf("FI-Schutzschalter 40 A").getByRole("button", { name: "Artikel zuordnen" }));
    const search = screen.getByRole("searchbox", { name: "Lagerartikel suchen" });
    fireEvent.change(search, { target: { value: "Hager" } });

    fireEvent.click(await screen.findByRole("button", { name: /SP-0301/ }));

    expect(articlesMock).toHaveBeenCalledWith("t", { q: "Hager", kind: "consumable", limit: 8 });
    expect(mappingMock).toHaveBeenCalledWith("t", { key: "device:rcd:4p:40a", article_id: 301 });
    // The search closes and the reloaded row carries the article.
    await waitFor(() => expect(screen.queryByRole("searchbox")).toBeNull());
    await waitFor(() =>
      expect(rowOf("FI-Schutzschalter 40 A").getByText("Hager FI 40 A 30 mA")).toBeInTheDocument(),
    );
    expect(rowOf("FI-Schutzschalter 40 A").getByText("SP-0301")).toBeInTheDocument();
    expect(getMock).toHaveBeenCalledTimes(2);
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("forgets a hand-made mapping, but offers no removal for an automatic match", async () => {
    mappingMock.mockResolvedValueOnce({ key: MCB.key, article: null });
    renderList();
    await screen.findByText("Leitungsschutzschalter (LS) B16");

    expect(rowOf("WAGO 2003-7641").queryByRole("button", { name: "Zuordnung entfernen" })).toBeNull();
    expect(rowOf("WAGO 2003-7641").getByRole("button", { name: "Zuordnung ändern" })).toBeInTheDocument();

    fireEvent.click(rowOf("Leitungsschutzschalter (LS) B16").getByRole("button", { name: "Zuordnung entfernen" }));
    expect(mappingMock).toHaveBeenCalledWith("t", { key: "device:mcb:1p:b16", article_id: null });
    await waitFor(() => expect(getMock).toHaveBeenCalledTimes(2));
  });

  it("says so when the list cannot be loaded, and retries on request", async () => {
    getMock.mockReset();
    getMock.mockRejectedValueOnce(new Error("")).mockResolvedValueOnce(MATERIAL);
    renderList();

    expect(await screen.findByRole("alert")).toHaveTextContent("Materialliste konnte nicht geladen werden.");
    fireEvent.click(screen.getByRole("button", { name: "Erneut versuchen" }));
    expect(await screen.findByText("Leitungsschutzschalter (LS) B16")).toBeInTheDocument();
  });

  it("reloads when the panel changes", async () => {
    const { rerender } = renderList();
    await screen.findByText("Leitungsschutzschalter (LS) B16");
    rerender(<PanelMaterialList token="t" panelId={9} canEdit language="de" />);
    await waitFor(() => expect(getMock).toHaveBeenLastCalledWith("t", 9));
  });
});
