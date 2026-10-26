/**
 * The Werkstatt page's entry to "Material gewechselt" gates itself
 * (docs/LABEL_PRINTER_CALIBRATION.md §7.11): no permission → nothing rendered
 * and nothing fetched; staff see it only once an admin released the quick
 * flow; admins always; no printer address → shown but disabled with the
 * reason in its title.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { apiFetch } from "../api/client";
import { LabelPrinterQuickEntry } from "../components/labelPrinter/LabelPrinterQuickEntry";
import { AppContext } from "../context/AppContext";
import type { LabelPrinterOverview } from "../types/labelPrinter";
import { makeAppContextStub } from "./appContextStub";
import { overviewFixture } from "./fixtures/labelPrinterMaterials";

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return { ...actual, apiFetch: vi.fn() };
});

const apiFetchMock = vi.mocked(apiFetch);

function serve(overview: Partial<LabelPrinterOverview>) {
  apiFetchMock.mockImplementation(async (path: string) => {
    if (path === "/werkstatt/label-printer") return overviewFixture(overview);
    throw new Error(`unexpected ${path}`);
  });
}

function renderEntry(permissions: string[]) {
  const context = makeAppContextStub({
    overrides: { user: { id: 3, email: "m@example.com", role: "employee", effective_permissions: permissions } },
  });
  return render(
    <AppContext.Provider value={context as never}>
      <LabelPrinterQuickEntry />
    </AppContext.Provider>,
  );
}

const overviewCalls = () => apiFetchMock.mock.calls.filter(([path]) => path === "/werkstatt/label-printer").length;

beforeEach(() => {
  apiFetchMock.mockReset();
});

describe("LabelPrinterQuickEntry", () => {
  it("renders and fetches nothing without either permission", async () => {
    serve({});
    const { container } = renderEntry(["werkstatt:machines_create"]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(container).toBeEmptyDOMElement();
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it("stays hidden for staff while the quick flow is not released", async () => {
    serve({ can_full: false, staff_enabled: false });
    const { container } = renderEntry(["werkstatt:manage"]);
    await waitFor(() => expect(overviewCalls()).toBe(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(container).toBeEmptyDOMElement();
  });

  it("shows for staff once released", async () => {
    serve({ can_full: false, staff_enabled: true });
    renderEntry(["werkstatt:manage"]);
    expect(await screen.findByRole("button", { name: /Etikettendrucker/ })).toBeEnabled();
  });

  it("shows for admins before the release", async () => {
    serve({ can_full: true, staff_enabled: false });
    renderEntry(["settings:manage"]);
    const button = await screen.findByRole("button", { name: /Etikettendrucker/ });
    expect(button).toHaveAttribute("title", "WAGO-Etikettendrucker: Material gewechselt");
  });

  it("is disabled with the reason when no printer is configured", async () => {
    serve({ configured: false });
    renderEntry(["settings:manage"]);
    const button = await screen.findByRole("button", { name: /Etikettendrucker/ });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("title", "Kein Etikettendrucker konfiguriert");
  });

  it("opens the sheet", async () => {
    serve({});
    renderEntry(["settings:manage"]);
    fireEvent.click(await screen.findByRole("button", { name: /Etikettendrucker/ }));
    expect(await screen.findByRole("dialog", { name: "Material gewechselt" })).toBeInTheDocument();
    expect(await screen.findByText("Welches Material ist eingelegt?")).toBeInTheDocument();
  });
});
