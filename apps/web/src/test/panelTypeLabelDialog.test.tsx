/**
 * The Schrank-Etikett sheet is the last look before a 99 × 44 type label
 * leaves the printer. These pin what would otherwise fail silently: a
 * preview that does not show what the server resolved, a Baujahr the server
 * would refuse, a print fired with the wrong stock loaded, and a request
 * body that is not exactly what the API expects.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { AppContext } from "../context/AppContext";
import { makeAppContextStub } from "./appContextStub";
import { PanelTypeLabelDialog } from "../components/schaltplan/PanelTypeLabelDialog";
import type { PanelTypeLabelInfo } from "../utils/schaltplanApi";

vi.mock("../api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/client")>()),
  apiFetch: vi.fn(),
}));

import { apiFetch } from "../api/client";

const apiMock = vi.mocked(apiFetch);

const INFO: PanelTypeLabelInfo = {
  customer: "Familie Schulze",
  project_number: "381",
  project_name: "Neubau Schulze",
  build_month: "09.2026",
  url: "https://smpl-energy.de",
  contact_lines: ["info@smpl-energy.de", "02302/ 2894980"],
  material: "Typenschilder 99 × 44 (silber)",
  material_ok: true,
};

type Props = Parameters<typeof PanelTypeLabelDialog>[0];

function withContext(props: Props) {
  const context = makeAppContextStub({ overrides: { token: "t" } });
  return (
    <AppContext.Provider value={context as never}>
      <PanelTypeLabelDialog {...props} />
    </AppContext.Provider>
  );
}

function renderDialog(overrides: Partial<Props> = {}) {
  const props: Props = {
    open: true,
    panelId: 7,
    busy: false,
    onPrint: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
  const view = render(withContext(props));
  return { ...props, ...view, rerenderWith: (next: Partial<Props>) => view.rerender(withContext({ ...props, ...next })) };
}

const printButton = () => screen.getByRole("button", { name: /Druck/ });
const baujahrField = () => screen.getByRole("textbox", { name: /Baujahr/ });
const anzahlField = () => screen.getByRole("spinbutton", { name: /Anzahl/ });

function setValue(field: HTMLElement, value: string) {
  fireEvent.change(field, { target: { value } });
}

describe("PanelTypeLabelDialog", () => {
  beforeEach(() => {
    apiMock.mockReset();
  });

  it("renders nothing while closed and asks the server for nothing", () => {
    const { container } = renderDialog({ open: false });
    expect(container).toBeEmptyDOMElement();
    expect(apiMock).not.toHaveBeenCalled();
  });

  it("fills the preview and the fields from the server's answer", async () => {
    apiMock.mockResolvedValueOnce(INFO);
    renderDialog();

    expect(await screen.findByText("Kunde: Familie Schulze")).toBeInTheDocument();
    expect(apiMock).toHaveBeenCalledWith("/schaltplan/panels/7/type-label", "t");
    expect(screen.getByText("Projekt: 381")).toBeInTheDocument();
    expect(screen.getByText("Baujahr: 09.2026")).toBeInTheDocument();
    expect(screen.getByText("info@smpl-energy.de")).toBeInTheDocument();
    expect(screen.getByText("02302/ 2894980")).toBeInTheDocument();
    expect(screen.getByText("Vorschau (schematisch)")).toBeInTheDocument();
    expect(screen.getByText("Material: Typenschilder 99 × 44 (silber)")).toBeInTheDocument();

    expect(baujahrField()).toHaveValue("09.2026");
    expect(anzahlField()).toHaveValue(1);
    expect(printButton()).toBeEnabled();

    // The images are the server's own renderings, addressed like the PDFs.
    expect(screen.getByRole("img", { name: "SMPL-Logo" })).toHaveAttribute("src", "/api/schaltplan/type-label/logo.png");
    expect(screen.getByRole("img", { name: /QR-Code/ })).toHaveAttribute("src", "/api/schaltplan/type-label/qr.svg");
  });

  it("shows a dash for a panel without a project", async () => {
    apiMock.mockResolvedValueOnce({ ...INFO, project_number: null, project_name: null });
    renderDialog();
    expect(await screen.findByText("Projekt: —")).toBeInTheDocument();
  });

  it("refuses a Baujahr the server would not accept, and follows a valid one live", async () => {
    apiMock.mockResolvedValueOnce(INFO);
    renderDialog();
    await screen.findByText("Kunde: Familie Schulze");

    setValue(baujahrField(), "13.2026");
    expect(screen.getByText(/Bitte als MM\.JJJJ eingeben/)).toBeInTheDocument();
    expect(printButton()).toBeDisabled();

    setValue(baujahrField(), "2026-09");
    expect(printButton()).toBeDisabled();

    setValue(baujahrField(), "10.2026");
    expect(screen.queryByText(/Bitte als MM\.JJJJ eingeben/)).toBeNull();
    expect(screen.getByText("Baujahr: 10.2026")).toBeInTheDocument();
    expect(printButton()).toBeEnabled();
  });

  it("refuses a copy count outside 1..10", async () => {
    apiMock.mockResolvedValueOnce(INFO);
    renderDialog();
    await screen.findByText("Kunde: Familie Schulze");

    for (const bad of ["0", "11", "", "2.5"]) {
      setValue(anzahlField(), bad);
      expect(printButton()).toBeDisabled();
    }
    setValue(anzahlField(), "2");
    expect(printButton()).toBeEnabled();
  });

  it("prints exactly the body the API expects", async () => {
    apiMock.mockResolvedValueOnce(INFO);
    const { onPrint } = renderDialog();
    await screen.findByText("Kunde: Familie Schulze");

    setValue(baujahrField(), "10.2026");
    setValue(anzahlField(), "3");
    fireEvent.click(printButton());

    expect(onPrint).toHaveBeenCalledTimes(1);
    expect(onPrint).toHaveBeenCalledWith({ build_month: "10.2026", copies: 3 });
  });

  it("blocks printing while the wrong stock is loaded", async () => {
    apiMock.mockResolvedValueOnce({ ...INFO, material: "Beschriftungsstreifen 2009-110", material_ok: false });
    const { onPrint } = renderDialog();
    await screen.findByText("Kunde: Familie Schulze");

    expect(
      screen.getByText(
        "Für das Schrank-Etikett muss ein 99 × 44 Etikett (WAGO 210-804) eingelegt sein — aktiv ist „Beschriftungsstreifen 2009-110“.",
      ),
    ).toBeInTheDocument();
    expect(printButton()).toBeDisabled();
    fireEvent.click(printButton());
    expect(onPrint).not.toHaveBeenCalled();
  });

  it("shows the server's sentence when loading fails, and retries on request", async () => {
    apiMock.mockRejectedValueOnce(new Error("Kein Etikettendrucker konfiguriert"));
    renderDialog();

    expect(await screen.findByRole("alert")).toHaveTextContent("Kein Etikettendrucker konfiguriert");
    expect(printButton()).toBeDisabled();

    apiMock.mockResolvedValueOnce(INFO);
    fireEvent.click(screen.getByRole("button", { name: "Erneut versuchen" }));

    expect(await screen.findByText("Kunde: Familie Schulze")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(apiMock).toHaveBeenCalledTimes(2);
  });

  it("falls back to a generic message when the failure carries none", async () => {
    apiMock.mockRejectedValueOnce(new Error(""));
    renderDialog();
    expect(await screen.findByRole("alert")).toHaveTextContent("Etikettendaten konnten nicht geladen werden");
  });

  it("says Drucke… and stays disabled while a print is running", async () => {
    apiMock.mockResolvedValueOnce(INFO);
    renderDialog({ busy: true });
    await screen.findByText("Kunde: Familie Schulze");
    expect(screen.getByRole("button", { name: "Drucke…" })).toBeDisabled();
  });

  it("closes from both Schließen buttons and the backdrop", async () => {
    apiMock.mockResolvedValueOnce(INFO);
    const { onClose } = renderDialog();
    await screen.findByText("Kunde: Familie Schulze");
    for (const button of screen.getAllByRole("button", { name: "Schließen" })) fireEvent.click(button);
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("asks the server again on every open, so the month and the stock are current", async () => {
    apiMock.mockResolvedValue(INFO);
    const { rerenderWith } = renderDialog();
    await screen.findByText("Kunde: Familie Schulze");
    setValue(baujahrField(), "01.2020");

    rerenderWith({ open: false });
    rerenderWith({ open: true });

    expect(await screen.findByText("Baujahr: 09.2026")).toBeInTheDocument();
    expect(apiMock).toHaveBeenCalledTimes(2);
  });
});
