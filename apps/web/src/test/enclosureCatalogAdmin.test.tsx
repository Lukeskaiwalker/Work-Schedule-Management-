/**
 * "Schrankkatalog" (docs/PANEL_ENCLOSURE.md §3.3, §3.5, §7, §11): the
 * Werkstatt's list of cabinets and field modules — create, edit, archive,
 * restore, back to the Hager standard. Writes need `werkstatt:manage`, which
 * the server reports as `catalog.can_manage`; everybody else sees no admin
 * at all. Every write reloads the shared catalogue (`onChanged`) so the
 * pickers see it, and the list shows the result even when that reload fails.
 *
 * Invented data only.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

vi.mock("../utils/schaltplanEnclosureApi", () => ({
  createCatalogEntry: vi.fn(),
  updateCatalogEntry: vi.fn(),
  setCatalogEntryArchived: vi.fn(),
  resetCatalogEntry: vi.fn(),
}));

import { ApiError } from "../api/client";
import { EnclosureCatalogAdmin, type EnclosureCatalogAdminProps } from "../components/schaltplan/enclosure/EnclosureCatalogAdmin";
import { createCatalogEntry, resetCatalogEntry, setCatalogEntryArchived, updateCatalogEntry } from "../utils/schaltplanEnclosureApi";
import { MODULES, testCatalog } from "./enclosureTestCatalog";
import type { CatalogEntry, EnclosureCatalog, ModuleSpec, UncataloguedArticle } from "../types/panelEnclosure";

const createMock = vi.mocked(createCatalogEntry);
const updateMock = vi.mocked(updateCatalogEntry);
const archiveMock = vi.mocked(setCatalogEntryArchived);
const resetMock = vi.mocked(resetCatalogEntry);

const TOKEN = "test-token";
const DISCARD_QUESTION = "Eingaben verwerfen? Der Eintrag ist noch nicht gespeichert.";

function managerCatalog(): EnclosureCatalog {
  const base = testCatalog();
  const modules = base.modules.map((entry) => {
    if (entry.code === "ZH3EH16") return { ...entry, source: "override" as const, used_by_plans: 2, source_url: null };
    if (entry.code === "ZU37RK") return { ...entry, archived: true };
    if (entry.code === "ZU37KS") return { ...entry, used_by_plans: 1, stock_available: 4 };
    return entry;
  });
  const custom: CatalogEntry<ModuleSpec> = {
    ...base.modules[0],
    code: "ZX99KAPUTT",
    source: "custom",
    invalid: true,
    spec: null,
  };
  return { ...base, modules: [...modules, custom], can_manage: true };
}

function renderAdmin(overrides: Partial<EnclosureCatalogAdminProps> = {}) {
  const onChanged = vi.fn(async () => {});
  const onClose = vi.fn();
  const onBack = vi.fn();
  const props: EnclosureCatalogAdminProps = { token: TOKEN, catalog: managerCatalog(), onChanged, onClose, onBack, ...overrides };
  const view = render(<EnclosureCatalogAdmin {...props} />);
  return { ...view, onChanged, onClose, onBack, props };
}

const modules = () => within(screen.getByRole("region", { name: /^Module/ }));
const item = (code: string) => within(screen.getByRole("listitem", { name: new RegExp(`^${code}\\b`) }));

function written(entry: CatalogEntry, patch: Partial<CatalogEntry>): CatalogEntry {
  return { ...entry, ...patch } as CatalogEntry;
}

beforeEach(() => {
  createMock.mockReset();
  updateMock.mockReset();
  archiveMock.mockReset();
  resetMock.mockReset();
});

describe("EnclosureCatalogAdmin — list", () => {
  it("lists cabinets and modules with their state", () => {
    renderAdmin();
    expect(screen.getByRole("heading", { name: "Schrankkatalog" })).toBeTruthy();
    expect(screen.getByRole("region", { name: /^Schränke/ })).toBeTruthy();
    expect(item("ZH3EH16").getByText("ungeprüft")).toBeTruthy();
    expect(item("ZH3EH16").getByText(/angepasst/)).toBeTruthy();
    expect(item("ZH3EH16").getByText(/In 2 Plänen verwendet/)).toBeTruthy();
    expect(item("ZU37KS").getByText(/In 1 Plan verwendet/)).toBeTruthy();
    expect(item("ZU37KS").getByText(/4 im Lager/)).toBeTruthy();
    expect(item("ZU37KS").getByText(/Hager-Standard/)).toBeTruthy();
    expect(item("ZU37RK").getByText(/archiviert/)).toBeTruthy();
    expect(item("ZX99KAPUTT").getByText(/fehlerhaft/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Eintrag anlegen" })).toBeTruthy();
  });

  it("archived entries come last in their section", () => {
    renderAdmin();
    const codes = modules()
      .getAllByRole("listitem")
      .map((li) => li.getAttribute("aria-label")?.split(" ")[0]);
    expect(codes.indexOf("ZU37RK")).toBe(codes.length - 1);
  });

  it("only a changed built-in offers 'Auf Hager-Standard zurücksetzen'", () => {
    renderAdmin();
    expect(item("ZH3EH16").getByRole("button", { name: "Auf Hager-Standard zurücksetzen" })).toBeTruthy();
    expect(item("ZU37KS").queryByRole("button", { name: "Auf Hager-Standard zurücksetzen" })).toBeNull();
    expect(item("ZX99KAPUTT").queryByRole("button", { name: "Auf Hager-Standard zurücksetzen" })).toBeNull();
  });

  it("search narrows by code or name", () => {
    renderAdmin();
    fireEvent.change(screen.getByLabelText("Suchen"), { target: { value: "zu37" } });
    expect(screen.queryByRole("listitem", { name: /^ZH3EH16\b/ })).toBeNull();
    expect(screen.getByRole("listitem", { name: /^ZU37KS\b/ })).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Suchen"), { target: { value: "Modul ZH3EL2" } });
    expect(screen.getByRole("listitem", { name: /^ZH3EL22\b/ })).toBeTruthy();
    expect(screen.getByRole("listitem", { name: /^ZH3EL27\b/ })).toBeTruthy();
    expect(screen.queryByRole("listitem", { name: /^ZU37KS\b/ })).toBeNull();
  });

  it("a source link opens outside the app, without a referrer", () => {
    const catalog = managerCatalog();
    const modulesWithLink = catalog.modules.map((entry) =>
      entry.code === "ZU37KS" && entry.spec ? { ...entry, spec: { ...entry.spec, source_url: "https://example.org/zu37ks" } } : entry,
    );
    renderAdmin({ catalog: { ...catalog, modules: modulesWithLink } });
    const link = item("ZU37KS").getByRole("link", { name: "Quelle" });
    expect(link.getAttribute("href")).toBe("https://example.org/zu37ks");
    expect(link.getAttribute("rel")).toBe("noreferrer noopener");
    expect(link.getAttribute("target")).toBe("_blank");
  });

  it("‹ goes back down the stack, × closes", () => {
    const { onBack, onClose } = renderAdmin();
    fireEvent.click(screen.getByRole("button", { name: "Zurück" }));
    expect(onBack).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Schließen" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("EnclosureCatalogAdmin — without werkstatt:manage", () => {
  it("shows no admin, only who keeps the catalogue", () => {
    renderAdmin({ catalog: { ...managerCatalog(), can_manage: false } });
    expect(screen.getByText("Den Schrankkatalog pflegt die Werkstatt.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Eintrag anlegen" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Bearbeiten" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Archivieren" })).toBeNull();
    expect(screen.queryByRole("listitem")).toBeNull();
  });
});

describe("EnclosureCatalogAdmin — writes", () => {
  it("Archivieren: the call, the reload, the result in the list", async () => {
    const catalog = managerCatalog();
    const entry = catalog.modules.find((candidate) => candidate.code === "ZU37KS")!;
    archiveMock.mockResolvedValue(written(entry, { archived: true }));
    const { onChanged } = renderAdmin({ catalog });
    fireEvent.click(item("ZU37KS").getByRole("button", { name: "Archivieren" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("ZU37KS archiviert."));
    expect(archiveMock).toHaveBeenCalledWith(TOKEN, "ZU37KS", true);
    expect(onChanged).toHaveBeenCalledTimes(1);
    // The reload here changes nothing: the list still shows what was written.
    expect(item("ZU37KS").getByText(/archiviert/)).toBeTruthy();
    expect(item("ZU37KS").getByRole("button", { name: "Wiederherstellen" })).toBeTruthy();
  });

  it("Wiederherstellen", async () => {
    const catalog = managerCatalog();
    const entry = catalog.modules.find((candidate) => candidate.code === "ZU37RK")!;
    archiveMock.mockResolvedValue(written(entry, { archived: false }));
    renderAdmin({ catalog });
    fireEvent.click(item("ZU37RK").getByRole("button", { name: "Wiederherstellen" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("ZU37RK wiederhergestellt."));
    expect(archiveMock).toHaveBeenCalledWith(TOKEN, "ZU37RK", false);
  });

  it("Auf Hager-Standard zurücksetzen asks first", async () => {
    const catalog = managerCatalog();
    const entry = catalog.modules.find((candidate) => candidate.code === "ZH3EH16")!;
    resetMock.mockResolvedValue(written(entry, { source: "builtin" }));
    renderAdmin({ catalog });
    fireEvent.click(item("ZH3EH16").getByRole("button", { name: "Auf Hager-Standard zurücksetzen" }));
    expect(resetMock).not.toHaveBeenCalled();
    const confirm = within(screen.getByRole("group", { name: /Auf Hager-Standard zurücksetzen\?/ }));
    fireEvent.click(confirm.getByRole("button", { name: "Ja, zurücksetzen" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("ZH3EH16 auf Hager-Standard zurückgesetzt."));
    expect(resetMock).toHaveBeenCalledWith(TOKEN, "ZH3EH16");
    expect(item("ZH3EH16").getByText(/Hager-Standard/)).toBeTruthy();
  });

  it("a refused write says why and changes nothing", async () => {
    archiveMock.mockRejectedValue(new ApiError("Katalogeintrag nicht gefunden.", 404, "Katalogeintrag nicht gefunden."));
    const { onChanged } = renderAdmin();
    fireEvent.click(item("ZU37KS").getByRole("button", { name: "Archivieren" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("Katalogeintrag nicht gefunden."));
    expect(onChanged).not.toHaveBeenCalled();
    expect(item("ZU37KS").getByRole("button", { name: "Archivieren" })).toBeTruthy();
  });

  it("Eintrag anlegen → form → Anlegen → back on the list with the new entry", async () => {
    createMock.mockImplementation(async (_token, body) => ({
      ...testCatalog().modules[0],
      code: body.spec.code,
      source: "custom",
      spec: body.spec as ModuleSpec,
    }));
    const { onChanged } = renderAdmin();
    fireEvent.click(screen.getByRole("button", { name: "Eintrag anlegen" }));
    expect(screen.getByRole("heading", { name: "Eintrag anlegen" })).toBeTruthy();
    const details = within(screen.getByRole("region", { name: "Angaben" }));
    fireEvent.change(details.getByLabelText("Code"), { target: { value: "ZX37NEU" } });
    fireEvent.change(details.getByLabelText("Artikelnummer"), { target: { value: "ZX37NEU" } });
    fireEvent.change(details.getByLabelText("Bezeichnung"), { target: { value: "Neues Feld (erfunden)" } });
    fireEvent.click(screen.getByRole("button", { name: "Anlegen" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("ZX37NEU angelegt."));
    expect(createMock).toHaveBeenCalledWith(TOKEN, expect.objectContaining({ entry_type: "module", spec: expect.objectContaining({ code: "ZX37NEU" }) }));
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("heading", { name: "Schrankkatalog" })).toBeTruthy();
    expect(item("ZX37NEU").getByText(/eigener Eintrag/)).toBeTruthy();
  });

  it("a refused create stays in the form with the server's sentence", async () => {
    createMock.mockRejectedValue(new ApiError("Den Code ZU37KS gibt es schon.", 409, "Den Code ZU37KS gibt es schon."));
    renderAdmin();
    fireEvent.click(screen.getByRole("button", { name: "Eintrag anlegen" }));
    const details = within(screen.getByRole("region", { name: "Angaben" }));
    fireEvent.change(details.getByLabelText("Code"), { target: { value: "ZU37KS" } });
    fireEvent.change(details.getByLabelText("Artikelnummer"), { target: { value: "ZU37KS" } });
    fireEvent.change(details.getByLabelText("Bezeichnung"), { target: { value: "Doppelt" } });
    fireEvent.click(screen.getByRole("button", { name: "Anlegen" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("Den Code ZU37KS gibt es schon."));
    expect(screen.getByRole("heading", { name: "Eintrag anlegen" })).toBeTruthy();
    expect((details.getByLabelText("Bezeichnung") as HTMLInputElement).value).toBe("Doppelt");
  });

  it("Bearbeiten → Speichern sends the whole spec to the entry's code", async () => {
    const catalog = managerCatalog();
    const entry = catalog.modules.find((candidate) => candidate.code === "ZU37KS")!;
    updateMock.mockImplementation(async (_token, _code, body) => written(entry, { source: "override", spec: body.spec as ModuleSpec }));
    renderAdmin({ catalog });
    fireEvent.click(item("ZU37KS").getByRole("button", { name: "Bearbeiten" }));
    expect(screen.getByRole("heading", { name: "ZU37KS bearbeiten" })).toBeTruthy();
    expect(screen.getByText("In 1 Plan verwendet")).toBeTruthy();
    const details = within(screen.getByRole("region", { name: "Angaben" }));
    fireEvent.change(details.getByLabelText("Notiz"), { target: { value: "Am Gerät nachgemessen" } });
    fireEvent.click(screen.getByRole("button", { name: "Speichern" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("ZU37KS gespeichert."));
    expect(updateMock).toHaveBeenCalledWith(TOKEN, "ZU37KS", { entry_type: "module", spec: { ...MODULES.ZU37KS, note: "Am Gerät nachgemessen" } });
    expect(item("ZU37KS").getByText(/angepasst/)).toBeTruthy();
  });

  it("the form's ‹ returns to the list without saving", () => {
    const { onBack } = renderAdmin();
    fireEvent.click(item("ZU37KS").getByRole("button", { name: "Bearbeiten" }));
    fireEvent.click(screen.getByRole("button", { name: "Zurück" }));
    expect(onBack).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { name: "Schrankkatalog" })).toBeTruthy();
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("the form's ‹ asks before it drops what was typed, and keeps it on 'Weiter bearbeiten'", () => {
    renderAdmin();
    fireEvent.click(item("ZU37KS").getByRole("button", { name: "Bearbeiten" }));
    const details = within(screen.getByRole("region", { name: "Angaben" }));
    fireEvent.change(details.getByLabelText("Notiz"), { target: { value: "Noch nicht gespeichert" } });
    fireEvent.click(screen.getByRole("button", { name: "Zurück" }));
    const ask = screen.getByRole("group", { name: DISCARD_QUESTION });
    expect(screen.getByRole("heading", { name: "ZU37KS bearbeiten" })).toBeTruthy();
    fireEvent.click(within(ask).getByRole("button", { name: "Weiter bearbeiten" }));
    expect(screen.queryByRole("group", { name: DISCARD_QUESTION })).toBeNull();
    expect((details.getByLabelText("Notiz") as HTMLTextAreaElement | HTMLInputElement).value).toBe("Noch nicht gespeichert");

    fireEvent.click(screen.getByRole("button", { name: "Zurück" }));
    fireEvent.click(within(screen.getByRole("group", { name: DISCARD_QUESTION })).getByRole("button", { name: "Ja, verwerfen" }));
    expect(screen.getByRole("heading", { name: "Schrankkatalog" })).toBeTruthy();
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("× on a form with typed changes asks too, and closes only when confirmed", () => {
    const { onClose } = renderAdmin();
    fireEvent.click(screen.getByRole("button", { name: "Eintrag anlegen" }));
    fireEvent.change(within(screen.getByRole("region", { name: "Angaben" })).getByLabelText("Code"), { target: { value: "ZX37NEU" } });
    fireEvent.click(screen.getByRole("button", { name: "Schließen" }));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(within(screen.getByRole("group", { name: DISCARD_QUESTION })).getByRole("button", { name: "Ja, verwerfen" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("hands the stack its own way back while the form is open: the list, not the sheet below", () => {
    const setBackHandler = vi.fn();
    const { onBack } = renderAdmin({ setBackHandler });
    expect(setBackHandler).not.toHaveBeenCalledWith(expect.any(Function));
    fireEvent.click(item("ZU37KS").getByRole("button", { name: "Bearbeiten" }));
    const handlers = setBackHandler.mock.calls.map(([value]) => value).filter((value): value is () => void => typeof value === "function");
    const handler = handlers[handlers.length - 1];
    expect(handler).toBeTypeOf("function");
    act(() => handler());
    expect(screen.getByRole("heading", { name: "Schrankkatalog" })).toBeTruthy();
    expect(onBack).not.toHaveBeenCalled();
    expect(setBackHandler).toHaveBeenLastCalledWith(null);
  });

  it("an entry whose stored spec is broken is captured anew under its code", () => {
    renderAdmin();
    fireEvent.click(item("ZX99KAPUTT").getByRole("button", { name: "Bearbeiten" }));
    expect(screen.getByText(/Der gespeicherte Aufbau ist fehlerhaft/)).toBeTruthy();
    const details = within(screen.getByRole("region", { name: "Angaben" }));
    expect((details.getByLabelText("Code") as HTMLInputElement).value).toBe("ZX99KAPUTT");
  });

  it("opened for a shelf article the catalogue lacks: the form, prefilled", () => {
    const create: UncataloguedArticle = {
      article: { id: 9, article_number: "A-0009", item_name: "Hager ZX59XS Feld (erfunden)", manufacturer: "Hager", unit: "ST", internal_code: null, stock_available: 2 },
      code_guess: "ZX59XS",
    };
    renderAdmin({ create });
    expect(screen.getByRole("heading", { name: "Eintrag anlegen" })).toBeTruthy();
    const details = within(screen.getByRole("region", { name: "Angaben" }));
    expect((details.getByLabelText("Code") as HTMLInputElement).value).toBe("ZX59XS");
    expect((details.getByLabelText("Bezeichnung") as HTMLInputElement).value).toBe("Hager ZX59XS Feld (erfunden)");
  });

  it("one write at a time", async () => {
    let finish: (entry: CatalogEntry) => void = () => {};
    archiveMock.mockImplementation(() => new Promise((resolve) => (finish = resolve)));
    const catalog = managerCatalog();
    renderAdmin({ catalog });
    fireEvent.click(item("ZU37KS").getByRole("button", { name: "Archivieren" }));
    expect((item("ZU37KS").getByRole("button", { name: "Archivieren" }) as HTMLButtonElement).disabled).toBe(true);
    expect((item("ZH3EL22").getByRole("button", { name: "Bearbeiten" }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => finish(written(catalog.modules.find((entry) => entry.code === "ZU37KS")!, { archived: true })));
    await waitFor(() => expect((item("ZH3EL22").getByRole("button", { name: "Bearbeiten" }) as HTMLButtonElement).disabled).toBe(false));
  });
});
