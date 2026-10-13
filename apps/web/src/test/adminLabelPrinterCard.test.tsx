/**
 * The admin card "Etikettendrucker (Werkstatt)" (docs/LABEL_PRINTER_CALIBRATION.md
 * §7.9, §7.10).
 *
 * What must hold: choosing the loaded material is one PATCH with the revision
 * and sends nothing to the printer — it offers the quick flow instead; the
 * printer status is queried only on [Status abfragen], never on page load
 * (whether queries are harmless is test T0b); each row opens the quick flow,
 * the wizard or the profile form; the staff switch is one PUT; the profile
 * form takes a sensor reading with a decimal comma.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { apiFetch } from "../api/client";
import { AdminLabelPrinterCard } from "../components/admin/AdminLabelPrinterCard";
import { AppContext } from "../context/AppContext";
import { makeAppContextStub } from "./appContextStub";
import { A, W, createFakeLabelApi, type FakeLabelApi } from "./fixtures/fakeLabelPrinterApi";
import { BUILTINS, M804 } from "./fixtures/labelPrinterMaterials";

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return { ...actual, apiFetch: vi.fn() };
});

const apiFetchMock = vi.mocked(apiFetch);
let fake: FakeLabelApi;

beforeEach(() => {
  const calibrated = {
    ...M804,
    calibration: {
      kind: "quick" as const,
      at: "2026-10-20T09:12:00Z",
      by_name: "Luca Schmidt",
      verdict: "match" as const,
      fresh: true,
      accepted: false,
      stale: false,
      measured_length_mm: 97,
      measured_gap_mm: 2.5,
      notes: "",
    },
  };
  fake = createFakeLabelApi({ settings: { materials: [calibrated, ...BUILTINS.slice(1)] } });
  apiFetchMock.mockReset();
  apiFetchMock.mockImplementation((path, token, init) => fake.handle(path, token, init) as Promise<never>);
});

function renderCard() {
  const context = makeAppContextStub();
  render(
    <AppContext.Provider value={context as never}>
      <AdminLabelPrinterCard />
    </AppContext.Provider>,
  );
}

async function row(name: string): Promise<HTMLElement> {
  return (await screen.findByText(name)).closest("li") as HTMLElement;
}

const nonSettingsCalls = () => fake.calls.filter((call) => call.key !== `GET ${A}`);

describe("AdminLabelPrinterCard", () => {
  it("selects a material with one PATCH and sends nothing to the printer", async () => {
    renderCard();
    const target = await row("Typenschilder 50 × 25 (silber)");
    fireEvent.click(within(target).getByRole("radio"));
    await screen.findByText(/Rolle gewechselt\?/);
    expect(fake.bodies(`PATCH ${A}`)).toEqual([{ active_material_id: "wago-210-812", revision: 5 }]);
    expect(fake.calls.some((call) => call.key.startsWith(`POST ${W}`))).toBe(false);
    expect(nonSettingsCalls().map((call) => call.key)).toEqual([`PATCH ${A}`]);
    expect(screen.getByRole("button", { name: "Material gewechselt …" })).toBeInTheDocument();
  });

  it("renders the calibration chips and the loading line", async () => {
    renderCard();
    const r804 = await row("Typenschilder 99 × 44 (silber)");
    expect(within(r804).getByText("Eingemessen 20.10.2026")).toBeInTheDocument();
    expect(within(r804).getByText("Walze 258-5006 · Rollenhalter innen · Sensor auf 3,4 der Skala")).toBeInTheDocument();
    const strip = await row("Beschriftungsstreifen 11 mm (TopJob, Endlos)");
    expect(within(strip).getByText("Nicht eingemessen")).toBeInTheDocument();
    expect(within(strip).getByText(/Abroller extern · Sensor auf 3 der Skala/)).toBeInTheDocument();
  });

  it("queries the printer status only on [Status abfragen]", async () => {
    renderCard();
    await row("Typenschilder 99 × 44 (silber)");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fake.count(`GET ${W}/status?full=true`)).toBe(0);
    fireEvent.click(screen.getByRole("button", { name: "Status abfragen" }));
    expect(await screen.findByText(/● Bereit · Sensor unbekannt/)).toBeInTheDocument();
    expect(fake.count(`GET ${W}/status?full=true`)).toBe(1);
  });

  it("opens the quick flow, the wizard and the form from a row", async () => {
    renderCard();
    const r804 = await row("Typenschilder 99 × 44 (silber)");
    fireEvent.click(within(r804).getByRole("button", { name: "Material gewechselt" }));
    const sheet = await screen.findByRole("dialog", { name: "Material gewechselt" });
    expect(await within(sheet).findByRole("radio", { name: /Typenschilder 99 × 44/ })).toBeChecked();
    fireEvent.click(within(sheet).getByRole("button", { name: "Abbrechen" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Material gewechselt" })).toBeNull());

    fireEvent.click(within(await row("Typenschilder 99 × 44 (silber)")).getByRole("button", { name: "Einrichten" }));
    expect(await screen.findByRole("dialog", { name: "Material einrichten: Typenschilder 99 × 44 (silber)" })).toBeInTheDocument();
    await waitFor(() => expect(fake.bodies(`POST ${W}/session`)).toEqual([{ mode: "full", material_id: "wago-210-804" }]));
    fireEvent.click(screen.getByRole("button", { name: "Abbrechen" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /Material einrichten/ })).toBeNull());

    fireEvent.click(within(await row("Typenschilder 99 × 44 (silber)")).getByRole("button", { name: "Bearbeiten" }));
    expect(await screen.findByRole("dialog", { name: "Material bearbeiten: Typenschilder 99 × 44 (silber)" })).toBeInTheDocument();
  });

  it("switches the staff release with one PUT carrying the revision", async () => {
    renderCard();
    const box = await screen.findByRole("checkbox", { name: "Schnellablauf „Material gewechselt“ für die Werkstatt freigeben" });
    expect(box).not.toBeChecked();
    expect(screen.getByText(/Erst freigeben, wenn die Praxistests T0b, T1, T2 und T5 Ergebnisse haben/)).toBeInTheDocument();
    fireEvent.click(box);
    await waitFor(() => expect(box).toBeChecked());
    expect(fake.bodies(`PUT ${A}/printer`)).toEqual([{ revision: 5, label_calibration_staff_enabled: true }]);
  });

  it("tags an overridden builtin field and resets it through reset_fields", async () => {
    fake.setSettings({
      ...fake.settings,
      materials: fake.settings.materials.map((m) =>
        m.id === "wago-210-804" ? { ...m, x_offset_mm: 1.6, overridden_fields: ["x_offset_mm"] } : m,
      ),
    });
    renderCard();
    fireEvent.click(within(await row("Typenschilder 99 × 44 (silber)")).getByRole("button", { name: "Bearbeiten" }));
    const form = await screen.findByRole("dialog", { name: /Material bearbeiten/ });
    expect(within(form).getAllByText("angepasst")).toHaveLength(1);
    fireEvent.click(within(form).getByRole("button", { name: "Standard" }));
    expect(within(form).getByText("wird zurückgesetzt")).toBeInTheDocument();
    fireEvent.click(within(form).getByRole("button", { name: "Speichern" }));
    await waitFor(() => expect(fake.bodies(`PUT ${A}/materials/:id`)).toEqual([{ revision: 5, reset_fields: ["x_offset_mm"] }]));
  });

  it("edits the sensor in the profile form: no-sensor hint and a reading with a comma", async () => {
    renderCard();
    fireEvent.click(within(await row("Typenschilder 99 × 44 (silber)")).getByRole("button", { name: "Bearbeiten" }));
    const form = await screen.findByRole("dialog", { name: /Material bearbeiten/ });
    expect(within(form).queryByText(/Drucker erkennt dann vermutlich auch das Materialende nicht/)).toBeNull();
    fireEvent.click(within(form).getByRole("radio", { name: "Kein Sensor (nur Endlos)" }));
    expect(within(form).getByText(/Drucker erkennt dann vermutlich auch das Materialende nicht \(nicht am Drucker geprüft\)\./)).toBeInTheDocument();
    fireEvent.click(within(form).getByRole("radio", { name: "Durchlicht" }));

    const scale = within(form).getByLabelText("Sensorposition (Skala 1–5, eine Nachkommastelle)");
    expect(scale).toHaveAttribute("inputmode", "decimal");
    expect(within(form).getByText("3 = Mitte der Materialbahn, 1 Teilstrich = 1 mm")).toBeInTheDocument();
    fireEvent.change(scale, { target: { value: "3,6" } });
    expect(within(form).getByText("Zeiger ▲▼ auf 3,6 der Skala – ca. 6 mm rechts der Mitte")).toBeInTheDocument();
    fireEvent.click(within(form).getByRole("button", { name: "Speichern" }));
    await waitFor(() => expect(fake.bodies(`PUT ${A}/materials/:id`)).toEqual([{ revision: 5, sensor_scale: 3.6 }]));
    expect(fake.calls.find((call) => call.key === `PUT ${A}/materials/:id`)?.path).toBe(`${A}/materials/wago-210-804`);
  });
});
