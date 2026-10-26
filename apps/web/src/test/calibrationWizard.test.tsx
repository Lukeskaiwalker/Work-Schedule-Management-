/**
 * The full wizard "Material einrichten" (docs/LABEL_PRINTER_CALIBRATION.md
 * §7.6), against a fake API that refuses stale revisions.
 *
 * What must hold: six steps; every PUT carries the newest configuration
 * revision seen anywhere — including the one `activate` returns, so a wizard
 * opened on a non-active material does not trip over its own activation; the
 * subject follows the session after a material switch; the measuring pattern
 * only prints through the feed dialog and is not offered for multi-lane
 * stock; the offset correction is the contract's formula, clamped to the
 * material's limits; German server errors reach the screen verbatim.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { apiFetch } from "../api/client";
import { CalibrationWizard } from "../components/labelPrinter/CalibrationWizard";
import { CALIBRATION_TIMING } from "../components/labelPrinter/useCalibrationSession";
import { AppContext } from "../context/AppContext";
import type { LabelPrinterSettings } from "../types/labelPrinter";
import { makeAppContextStub } from "./appContextStub";
import { A, W, apiError, createFakeLabelApi, verdictFixture, type FakeLabelApi } from "./fixtures/fakeLabelPrinterApi";
import { settingsFixture } from "./fixtures/labelPrinterMaterials";

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return { ...actual, apiFetch: vi.fn() };
});

const apiFetchMock = vi.mocked(apiFetch);
const PUT_MATERIAL = `PUT ${A}/materials/:id`;
const PATTERN = `POST ${W}/session/:sid/pattern`;
const SAVE = `POST ${W}/session/:sid/save`;
const REVISION = 5;

let fake: FakeLabelApi;

beforeAll(() => {
  CALIBRATION_TIMING.pollIntervalMs = 5;
});
afterAll(() => {
  CALIBRATION_TIMING.pollIntervalMs = 1500;
});
beforeEach(() => {
  fake = createFakeLabelApi({ mode: "full" });
  // Like the server: a PUT with anything but the current revision is stale.
  fake.on(PUT_MATERIAL, (body) => {
    if (body.revision !== fake.state.revision) {
      throw apiError(409, { code: "stale_revision", message: "Einstellungen wurden inzwischen geändert – bitte neu laden", revision: fake.state.revision });
    }
    fake.state.revision += 1;
    const next: LabelPrinterSettings = { ...fake.settings, revision: fake.state.revision };
    fake.setSettings(next);
    return next;
  });
  apiFetchMock.mockReset();
  apiFetchMock.mockImplementation((path, token, init) => fake.handle(path, token, init) as Promise<never>);
});

function renderWizard(materialId = "wago-210-804", settings = settingsFixture({ revision: REVISION })) {
  const onClose = vi.fn();
  const setNotice = vi.fn();
  const context = makeAppContextStub({ overrides: { setNotice } });
  render(
    <AppContext.Provider value={context as never}>
      <CalibrationWizard materialId={materialId} settings={settings} onSettings={() => undefined} onClose={onClose} />
    </AppContext.Provider>,
  );
  return { onClose, setNotice };
}

const click = (name: string | RegExp) => fireEvent.click(screen.getByRole("button", { name }));

/** Step 1 → 2, optionally changing the gap so step 2 really PUTs. */
async function throughStep2(changeGap: boolean) {
  await screen.findByText("Schritt 1 von 6");
  click("Weiter");
  await screen.findByText("Schritt 2 von 6");
  if (changeGap) fireEvent.change(screen.getByLabelText(/^Spalt \(mm\)/), { target: { value: "2,5" } });
  click("Speichern und weiter");
  await screen.findByText("Schritt 3 von 6");
}

async function throughStep3() {
  for (const box of screen.getAllByRole("checkbox")) fireEvent.click(box);
  click("Weiter – Material ist eingelegt");
  await screen.findByText("Schritt 4 von 6");
}

const clickWhenThere = async (name: string) => fireEvent.click(await screen.findByRole("button", { name }));

async function senseToVerdict() {
  click("Übertragen");
  await clickWhenThere("Einmessen starten");
  click("Einziehen lassen");
  await waitFor(() => expect(document.querySelector(".lc-verdict")).not.toBeNull());
}

async function toPatternStep(materialId?: string) {
  renderWizard(materialId);
  await throughStep2(false);
  await throughStep3();
  await senseToVerdict();
  await clickWhenThere("Weiter");
  await screen.findByText("Schritt 5 von 6");
}

async function printPattern() {
  click("Messmuster drucken");
  expect(fake.count(PATTERN)).toBe(0);
  click("Drucken");
  await screen.findByLabelText("Rand vorne (A)");
}

describe("CalibrationWizard", () => {
  it("has six steps and step 2 PUTs with the revision", async () => {
    renderWizard();
    await throughStep2(true);
    expect(fake.bodies(PUT_MATERIAL)).toEqual([{ revision: REVISION, gap_mm: 2.5 }]);
    await throughStep3();
    await senseToVerdict();
    await clickWhenThere("Weiter");
    expect(await screen.findByText("Schritt 5 von 6")).toBeInTheDocument();
    click("Überspringen");
    expect(await screen.findByText("Schritt 6 von 6")).toBeInTheDocument();
  });

  it("sends the revision activate returned when the wizard opens on a non-active material", async () => {
    renderWizard("wago-210-812");
    await throughStep2(true);
    expect(fake.state.revision).toBe(REVISION + 1);
    await throughStep3();
    expect(fake.state.revision).toBe(REVISION + 2);
    await senseToVerdict();
    await clickWhenThere("Weiter");
    await screen.findByText("Schritt 5 von 6");
    await printPattern();
    fireEvent.change(screen.getByLabelText("Rand vorne (A)"), { target: { value: "2,4" } });
    click("Übernehmen");
    expect(await screen.findByText("Gespeichert: Versatz Vorschub 1,6 mm")).toBeInTheDocument();
    const puts = fake.bodies(PUT_MATERIAL) as Array<{ revision: number }>;
    expect(puts.slice(-1)[0]).toEqual({ revision: REVISION + 2, x_offset_mm: 1.6 });
    expect(screen.queryByText(/bitte neu laden/)).toBeNull();
  });

  it("follows the session to the switched material: title and PUT target", async () => {
    fake.verdict((s) =>
      verdictFixture(s, { verdict: "other_material", title: "Anderes Material gemessen", offers: ["switch_material", "resense"], suggested_material_ids: ["wago-210-812"] }),
    );
    renderWizard();
    await throughStep2(false);
    await throughStep3();
    await senseToVerdict();
    await screen.findByText("Anderes Material gemessen");
    fake.verdict((s) => verdictFixture(s, { material_id: "wago-210-812" }));
    click("Auf „Typenschilder 50 × 25 (silber)“ umstellen");
    expect(await screen.findByRole("heading", { name: "Material einrichten: Typenschilder 50 × 25 (silber)" })).toBeInTheDocument();
    await screen.findByText("Schritt 3 von 6");
    await throughStep3();
    click("Übertragen");
    await clickWhenThere("Ergebnis prüfen");
    await clickWhenThere("Weiter");
    await screen.findByText("Schritt 5 von 6");
    await printPattern();
    fireEvent.change(screen.getByLabelText("Rand vorne (A)"), { target: { value: "2,4" } });
    click("Übernehmen");
    await screen.findByText(/Gespeichert: Versatz Vorschub/);
    const target = fake.calls.filter((call) => call.key === PUT_MATERIAL).slice(-1)[0];
    expect(target?.path).toBe(`${A}/materials/wago-210-812`);
  });

  it("prints the pattern only after the feed dialog and computes A, clamped to the limits", async () => {
    await toPatternStep();
    click("Messmuster drucken");
    const dialog = screen.getByRole("dialog", { name: "Messmuster drucken" });
    expect(within(dialog).getByText("SMPL druckt ein Messmuster auf „Typenschilder 99 × 44 (silber)“: 1 Etikett.")).toBeInTheDocument();
    expect(fake.count(PATTERN)).toBe(0);
    fireEvent.click(within(dialog).getByRole("button", { name: "Abbrechen" }));
    expect(fake.count(PATTERN)).toBe(0);
    await printPattern();
    expect(fake.bodies(PATTERN)).toEqual([{ confirm_feed: true }]);
    const lead = screen.getByLabelText("Rand vorne (A)");
    fireEvent.change(lead, { target: { value: "2,4" } });
    expect(screen.getByText("Versatz Vorschub: 2,0 → 1,6 mm")).toBeInTheDocument();
    fireEvent.change(lead, { target: { value: "7" } });
    expect(screen.getByText("Versatz Vorschub: 2,0 → −2,0 mm")).toBeInTheDocument();
    expect(screen.getByText(/Korrektur −3 mm liegt außerhalb des möglichen Bereichs \(−2 … 10 mm\)/)).toBeInTheDocument();
    click("Übernehmen");
    await screen.findByText(/Gespeichert: Versatz Vorschub −2 mm/);
    expect((fake.bodies(PUT_MATERIAL) as Array<Record<string, number>>).slice(-1)[0]?.x_offset_mm).toBe(-2);
    fireEvent.change(lead, { target: { value: "31" } });
    expect(screen.getByText("Bitte einen Wert zwischen 0 und 30 mm eingeben")).toBeInTheDocument();
  });

  it("offers no across correction with the guides fully open", async () => {
    await toPatternStep();
    await printPattern();
    fireEvent.change(screen.getByLabelText("Rand links (L)"), { target: { value: "3" } });
    fireEvent.change(screen.getByLabelText("Rand rechts (R, optional)"), { target: { value: "1" } });
    expect(screen.queryByText(/Versatz quer:/)).toBeNull();
    expect(screen.getByText(/Seitliche Lage bei ganz offener Führung nicht festgelegt – kein Korrekturwert \(L − R = 2 mm\)/)).toBeInTheDocument();
  });

  it("offers no pattern for 210-805", async () => {
    await toPatternStep("wago-210-805");
    expect(screen.getByText("Messmuster für mehrbahniges Material folgt nach dem Praxistest (T8).")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Messmuster drucken" })).toBeNull();
    click("Überspringen");
    await screen.findByText("Schritt 6 von 6");
    expect(screen.queryByRole("button", { name: "Probedruck" })).toBeNull();
    expect(fake.count(PATTERN)).toBe(0);
  });

  it("finishes by saving the record with the pattern measurements", async () => {
    await toPatternStep();
    await printPattern();
    fireEvent.change(screen.getByLabelText("Rand vorne (A)"), { target: { value: "2,4" } });
    click("Überspringen");
    await screen.findByText("Schritt 6 von 6");
    fireEvent.change(screen.getByLabelText("Notiz (optional, max. 200 Zeichen)"), { target: { value: "neue Rolle" } });
    expect(screen.getByLabelText("Notiz (optional, max. 200 Zeichen)")).toHaveAttribute("maxLength", "200");
    click("Speichern");
    await waitFor(() => expect(fake.count(SAVE)).toBe(1));
    expect(fake.bodies(SAVE)[0]).toEqual({
      notes: "neue Rolle",
      accept_verdict: false,
      pattern: { lead_mm: 2.4, trail_mm: null, left_mm: null, right_mm: null, ruler_nominal_mm: null, ruler_measured_mm: null },
    });
  });

  it("shows the reload message on a stale revision", async () => {
    await toPatternStep();
    await printPattern();
    // Someone else saved meanwhile.
    fake.state.revision += 3;
    fake.setSettings({ ...fake.settings, revision: fake.state.revision });
    fireEvent.change(screen.getByLabelText("Rand vorne (A)"), { target: { value: "2,4" } });
    click("Übernehmen");
    expect(await screen.findByText("Einstellungen wurden inzwischen geändert – bitte neu laden")).toBeInTheDocument();
    click("Neu laden");
    await waitFor(() => expect(screen.queryByText(/bitte neu laden/)).toBeNull());
    click("Übernehmen");
    expect(await screen.findByText("Gespeichert: Versatz Vorschub 1,6 mm")).toBeInTheDocument();
  });

  it("waits with [Einrichtung beenden] while the printer still senses", async () => {
    fake.on(`POST ${W}/session/:sid/poll`, () => ({
      phase: "sensing", answered: true, code: "50", code_text: "Misst", message: "", saw_busy: true, elapsed_s: 3, session: fake.session(),
    }));
    renderWizard();
    await throughStep2(false);
    await throughStep3();
    click("Übertragen");
    await clickWhenThere("Einmessen starten");
    click("Einziehen lassen");
    // The sense panel stays while the printer senses, stop hint included.
    await screen.findByText(/Drucker misst/);
    expect(screen.getByText(/Läuft zu viel Material durch: Deckel öffnen/)).toBeInTheDocument();
    click("Abbrechen");
    const dialog = screen.getByRole("dialog", { name: "Einrichtung abbrechen?" });
    expect(within(dialog).getByText(/Läuft zu viel Material durch: Deckel öffnen/)).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Einrichtung beenden" })).toBeDisabled();
    expect(fake.count(`DELETE ${W}/session/:sid`)).toBe(0);
  });

  it("reads the result without offering a second sense in between", async () => {
    // Physical test T2 (13.10.2026): on the real printer the result read
    // after the last poll takes seconds; meanwhile the panel fell back to an
    // enabled [Einmessen starten] — a second feed was one click away.
    let answerVerify: () => void = () => undefined;
    fake.on(`POST ${W}/session/:sid/verify`, async () => {
      await new Promise<void>((resolve) => (answerVerify = resolve));
      fake.state.phase = "judged";
      const verdict = verdictFixture(fake.session());
      fake.state.verdict = verdict.verdict;
      return { ...verdict, session: fake.session() };
    });
    renderWizard();
    await throughStep2(false);
    await throughStep3();
    click("Übertragen");
    await clickWhenThere("Einmessen starten");
    click("Einziehen lassen");
    expect(await screen.findByText(/Messergebnis wird gelesen/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Einmessen starten" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Kalibriertaste einmessen/ })).toBeNull();
    await act(async () => answerVerify());
    await waitFor(() => expect(document.querySelector(".lc-verdict")).not.toBeNull());
  });

  it("keeps [Ergebnis abfragen] reachable after a silent printer's button run", async () => {
    fake.on(`POST ${W}/session/:sid/autosense`, (body) => {
      fake.state.phase = "sensing";
      fake.state.sensed = true;
      return { printer: "p", method: body.method, cost_hint: "x", status_answered: false, presense: null, session: fake.session() };
    });
    renderWizard();
    await throughStep2(false);
    await throughStep3();
    click("Übertragen");
    await clickWhenThere("Drucker reagiert nicht? Mit der Kalibriertaste einmessen");
    click("Los");
    expect(await screen.findByText(/Jetzt die Kalibriertaste/)).toBeInTheDocument();
    await clickWhenThere("Ergebnis abfragen");
    await waitFor(() => expect(document.querySelector(".lc-verdict")).not.toBeNull());
  });

  it("releases the session it was still starting when the wizard is closed at once", async () => {
    let answerStart: () => void = () => undefined;
    fake.on(`POST ${W}/session`, async (body) => {
      await new Promise<void>((resolve) => (answerStart = resolve));
      fake.state.material_id = body.material_id;
      return fake.session();
    });
    const onClose = vi.fn();
    const view = render(
      <AppContext.Provider value={makeAppContextStub() as never}>
        <CalibrationWizard materialId="wago-210-804" settings={settingsFixture({ revision: REVISION })} onSettings={() => undefined} onClose={onClose} />
      </AppContext.Provider>,
    );
    await screen.findByText("Startet …");
    click("Abbrechen");
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    view.unmount();
    await act(async () => answerStart());
    await waitFor(() => expect(fake.count(`DELETE ${W}/session/:sid`)).toBe(1));
  });

  it("shows a German range error of the print values above the buttons", async () => {
    fake.on(PUT_MATERIAL, () => {
      throw apiError(422, { code: "invalid_material", message: "Typenschilder 99 × 44 (silber): Schwärzung muss zwischen 0 und 19 liegen" });
    });
    await toPatternStep();
    click("Überspringen");
    await screen.findByText("Schritt 6 von 6");
    fireEvent.change(screen.getByLabelText("Schwärzung (leer = Grundeinstellung 12)"), { target: { value: "25" } });
    expect(screen.getByText(/WAGO Smart Script warnt ab Schwärzung 12/)).toBeInTheDocument();
    click("Speichern");
    expect(await screen.findByText("Typenschilder 99 × 44 (silber): Schwärzung muss zwischen 0 und 19 liegen")).toBeInTheDocument();
    expect(fake.count(SAVE)).toBe(0);
  });
});
