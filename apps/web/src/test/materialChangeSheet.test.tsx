/**
 * The quick flow "Material gewechselt" (docs/LABEL_PRINTER_CALIBRATION.md
 * §7.4, §7.5, §7.7), clicked through against a fake API.
 *
 * What must hold: the steps come in the printer's order and each [Weiter]
 * waits for its condition; nothing that feeds paper is called before the feed
 * dialog is confirmed, and the stop instruction is visible before anything
 * moves; a silent printer leads to the calibration-button method without
 * polling; the material switch re-judges the existing measurement without a
 * second auto-sense; only [Trotzdem speichern] saves a deviating result; the
 * lock banner's time comes from `since`, never from the server's message.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { apiFetch } from "../api/client";
import { MaterialChangeSheet } from "../components/labelPrinter/MaterialChangeSheet";
import { CALIBRATION_TIMING } from "../components/labelPrinter/useCalibrationSession";
import { AppContext } from "../context/AppContext";
import { FEED_STOP_HINT } from "../utils/labelCalibration";
import { makeAppContextStub } from "./appContextStub";
import { W, apiError, createFakeLabelApi, verdictFixture, type FakeLabelApi } from "./fixtures/fakeLabelPrinterApi";

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return { ...actual, apiFetch: vi.fn() };
});

const apiFetchMock = vi.mocked(apiFetch);
const AUTOSENSE = `POST ${W}/session/:sid/autosense`;
const POLL = `POST ${W}/session/:sid/poll`;
const VERIFY = `POST ${W}/session/:sid/verify`;
const ACTIVATE = `POST ${W}/session/:sid/activate`;
const SAVE = `POST ${W}/session/:sid/save`;
const DELETE = `DELETE ${W}/session/:sid`;

let fake: FakeLabelApi;
const env = (globalThis as unknown as { process: { env: Record<string, string | undefined> } }).process.env;
const previousTz = env.TZ;

beforeAll(() => {
  env.TZ = "Europe/Berlin";
  CALIBRATION_TIMING.pollIntervalMs = 5;
});
afterAll(() => {
  if (previousTz === undefined) delete env.TZ;
  else env.TZ = previousTz;
  CALIBRATION_TIMING.pollIntervalMs = 1500;
});
beforeEach(() => {
  fake = createFakeLabelApi();
  apiFetchMock.mockReset();
  apiFetchMock.mockImplementation((path, token, init) => fake.handle(path, token, init) as Promise<never>);
});
afterEach(() => vi.restoreAllMocks());

function renderSheet(props: { preselectId?: string | null } = {}) {
  const onClose = vi.fn();
  const setNotice = vi.fn();
  const context = makeAppContextStub({ overrides: { setNotice } });
  const view = render(
    <AppContext.Provider value={context as never}>
      <MaterialChangeSheet onClose={onClose} preselectId={props.preselectId} />
    </AppContext.Provider>,
  );
  return { ...view, onClose, setNotice };
}

const click = (name: string | RegExp) => fireEvent.click(screen.getByRole("button", { name }));

async function toStep2(materialName = /Typenschilder 99 × 44/) {
  fireEvent.click(await screen.findByRole("radio", { name: materialName }));
  click("Weiter");
  await screen.findByText("Sensor stellen und Material einlegen");
}

function tickAll() {
  for (const box of screen.getAllByRole("checkbox")) fireEvent.click(box);
}

async function toStep3() {
  tickAll();
  click("Weiter – Material ist eingelegt");
  await screen.findByText("Einstellungen übertragen");
}

async function toStep4() {
  click("Übertragen");
  await screen.findByText(/Drucker meldet/);
  click("Weiter");
  await screen.findByRole("button", { name: "Einmessen starten" });
}

async function startSensing() {
  click("Einmessen starten");
  click("Einziehen lassen");
}

describe("quick flow order and gating", () => {
  it("walks the five steps in order and saves a match", async () => {
    const { onClose, setNotice } = renderSheet();
    expect(await screen.findByText("Schritt 1 von 5")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Weiter" })).toBeDisabled();
    await toStep2();
    expect(screen.getByText("Schritt 2 von 5")).toBeInTheDocument();
    await toStep3();
    expect(fake.bodies(ACTIVATE)).toEqual([{ material_id: "wago-210-804" }]);
    expect(screen.getByRole("button", { name: "Weiter" })).toBeDisabled();
    await toStep4();
    await startSensing();
    expect(await screen.findByText("Ergebnis")).toBeInTheDocument();
    expect(screen.getByText("Schritt 5 von 5")).toBeInTheDocument();
    click("Speichern");
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(fake.bodies(SAVE)).toEqual([{ notes: "", accept_verdict: false, pattern: null }]);
    expect(setNotice).toHaveBeenCalledWith("Gespeichert – „Typenschilder 99 × 44 (silber)“ ist eingemessen.");
  });

  it("enables [Weiter] in step 2 only when all six boxes are ticked", async () => {
    renderSheet();
    await toStep2();
    const boxes = screen.getAllByRole("checkbox");
    expect(boxes).toHaveLength(6);
    const next = screen.getByRole("button", { name: "Weiter – Material ist eingelegt" });
    boxes.slice(0, 5).forEach((box) => fireEvent.click(box));
    expect(next).toBeDisabled();
    fireEvent.click(boxes[5]);
    expect(next).toBeEnabled();
  });

  it("shows the lid hint under item 6 as information, not as a checkbox", async () => {
    renderSheet();
    await toStep2();
    const hint = screen.getByText(/Beim Schließen des Deckels kann der Drucker selbst einmessen/);
    expect(hint.closest("label")).toBeNull();
    expect(within(hint.closest("li") as HTMLElement).getByRole("checkbox")).toBeInTheDocument();
    expect(within(hint.closest("li") as HTMLElement).getByText("Deckel ist geschlossen")).toBeInTheDocument();
  });

  it("names the target reading and helps with the current one, without gating or sending", async () => {
    const { container } = renderSheet();
    await toStep2();
    expect(screen.getByText("Zeiger ▲▼ auf 3,4 der Skala – ca. 4 mm rechts der Mitte")).toBeInTheDocument();
    const callsBefore = fake.calls.length;
    const input = screen.getByLabelText("Zeiger steht jetzt auf …");
    fireEvent.change(input, { target: { value: "2,9" } });
    expect(screen.getByText("≈ 5 mm nach rechts schieben")).toBeInTheDocument();
    expect(container.ownerDocument.querySelector(".lc-actual")).not.toBeNull();
    fireEvent.change(input, { target: { value: "7" } });
    expect(screen.getByText("Bitte einen Wert zwischen 0,5 und 5,5 eingeben")).toBeInTheDocument();
    expect(container.ownerDocument.querySelector(".lc-actual")).toBeNull();
    expect(fake.calls.length).toBe(callsBefore);
    expect(screen.getByRole("button", { name: "Weiter – Material ist eingelegt" })).toBeDisabled();
    tickAll();
    expect(screen.getByRole("button", { name: "Weiter – Material ist eingelegt" })).toBeEnabled();
  });
});

describe("feeding paper", () => {
  it("calls nothing that feeds before the dialog is confirmed, and Abbrechen sends nothing", async () => {
    renderSheet();
    await toStep2();
    await toStep3();
    await toStep4();
    expect(screen.getByText(`⚠ ${FEED_STOP_HINT}`)).toBeInTheDocument();
    click("Einmessen starten");
    const dialog = screen.getByRole("dialog", { name: "Material wird eingezogen" });
    expect(within(dialog).getByText(`⚠ ${FEED_STOP_HINT}`)).toBeInTheDocument();
    expect(within(dialog).getByText(/voraussichtlich 2–3 Etiketten/)).toBeInTheDocument();
    expect(fake.count(AUTOSENSE)).toBe(0);
    expect(within(dialog).getByRole("button", { name: "Abbrechen" })).toHaveFocus();
    fireEvent.click(within(dialog).getByRole("button", { name: "Abbrechen" }));
    expect(fake.count(AUTOSENSE)).toBe(0);
    click("Drucker reagiert nicht? Mit der Kalibriertaste einmessen");
    const buttonDialog = screen.getByRole("dialog", { name: "Einmessen mit der Kalibriertaste" });
    expect(within(buttonDialog).getByText(`⚠ ${FEED_STOP_HINT}`)).toBeInTheDocument();
    fireEvent.click(within(buttonDialog).getByRole("button", { name: "Abbrechen" }));
    expect(fake.count(AUTOSENSE)).toBe(0);
  });

  it("shows the expected cost and the poll message while polling, then verifies on done", async () => {
    let polls = 0;
    fake.on(POLL, () => {
      polls += 1;
      if (polls < 3) {
        return { phase: "sensing", answered: true, code: "60", code_text: "Verarbeitet Daten", message: polls === 2 ? "Dauert länger als erwartet – läuft Material durch, Deckel öffnen (der Drucker stoppt dann vermutlich)." : "", saw_busy: true, elapsed_s: 16, session: fake.session() };
      }
      fake.state.phase = "sensed";
      return { phase: "done", answered: true, code: "00", code_text: "Bereit", message: "", saw_busy: true, elapsed_s: 18, session: fake.session() };
    });
    let releaseVerify: () => void = () => undefined;
    const verifyGate = new Promise<void>((resolve) => (releaseVerify = resolve));
    fake.on(VERIFY, async () => {
      await verifyGate;
      fake.state.phase = "judged";
      return verdictFixture(fake.session());
    });
    renderSheet();
    await toStep2();
    await toStep3();
    await toStep4();
    await startSensing();
    expect(await screen.findByText(/erwartet: voraussichtlich 2–3 Etiketten/)).toBeInTheDocument();
    expect(await screen.findByText(/Dauert länger als erwartet/)).toBeInTheDocument();
    await waitFor(() => expect(fake.count(VERIFY)).toBe(1));
    const pollsAtDone = fake.count(POLL);
    expect(pollsAtDone).toBe(3);
    await act(async () => releaseVerify());
    expect(await screen.findByText("Ergebnis")).toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(fake.count(POLL)).toBe(pollsAtDone);
  });

  it("falls back to the calibration button when the printer gives no status", async () => {
    fake.on(AUTOSENSE, (body) => {
      if (body.method === "command") {
        throw apiError(409, {
          code: "no_status_reply",
          message: "Drucker antwortet nicht auf Statusabfragen – stattdessen die Kalibriertaste auf der Rückseite verwenden",
        });
      }
      fake.state.phase = "sensing";
      fake.state.sensed = true;
      return { printer: "p", method: "button", cost_hint: "x", status_answered: false, presense: null, session: fake.session() };
    });
    renderSheet();
    await toStep2();
    await toStep3();
    await toStep4();
    await startSensing();
    expect(await screen.findByText(/Drucker antwortet nicht auf Statusabfragen/)).toBeInTheDocument();
    const link = screen.getByRole("button", { name: "Drucker reagiert nicht? Mit der Kalibriertaste einmessen" });
    expect(link).toHaveClass("lc-link-btn--highlight");
    fireEvent.click(link);
    click("Los");
    expect(await screen.findByText("Jetzt die Kalibriertaste auf der Rückseite des Druckers 1 Sekunde gedrückt halten.")).toBeInTheDocument();
    expect(fake.bodies(AUTOSENSE)).toEqual([
      { confirm_feed: true, method: "command" },
      { confirm_feed: true, method: "button" },
    ]);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(fake.count(POLL)).toBe(0);
    click("Ergebnis abfragen");
    await waitFor(() => expect(fake.count(VERIFY)).toBe(1));
    expect(await screen.findByText("Ergebnis")).toBeInTheDocument();
  });
});

describe("verdict offers", () => {
  it("switches material and re-judges the measurement without sensing again", async () => {
    fake.verdict((s) =>
      verdictFixture(s, {
        verdict: "other_material",
        title: "Anderes Material gemessen",
        detail: "Gemessen 53 mm Teilung – passt zu „Typenschilder 50 × 25 (silber)“ (WAGO 210-812). Ist ein anderes Material eingelegt?",
        offers: ["switch_material", "resense"],
        suggested_material_ids: ["wago-210-812"],
      }),
    );
    renderSheet();
    await toStep2();
    await toStep3();
    await toStep4();
    await startSensing();
    expect(await screen.findByText("Anderes Material gemessen")).toBeInTheDocument();
    fake.verdict((s) => verdictFixture(s, { material_id: "wago-210-812", from_latch: true }));
    click("Auf „Typenschilder 50 × 25 (silber)“ umstellen");
    await screen.findByText("Sensor stellen und Material einlegen");
    expect(fake.bodies(ACTIVATE).slice(-1)[0]).toEqual({ material_id: "wago-210-812" });
    expect(screen.getByText("Zeiger ▲▼ auf 3,4 der Skala – ca. 4 mm rechts der Mitte")).toBeInTheDocument();
    await toStep3();
    expect(fake.bodies(ACTIVATE)).toHaveLength(3);
    click("Übertragen");
    await screen.findByText(/Drucker meldet/);
    click("Weiter");
    expect(await screen.findByText(/Gemessen wurde bereits – SMPL bewertet die Messung jetzt für „Typenschilder 50 × 25 \(silber\)“/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Einmessen starten" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Kalibriertaste/ })).toBeNull();
    expect(screen.getByText("Schritt 4 von 5")).toBeInTheDocument();
    click("Ergebnis prüfen");
    expect(await screen.findByText("Ergebnis")).toBeInTheDocument();
    expect(fake.count(AUTOSENSE)).toBe(1);
    expect(fake.count(VERIFY)).toBe(2);
  });

  it("leaves switch mode on [Sensor prüfen und erneut einmessen]", async () => {
    fake.verdict((s) =>
      verdictFixture(s, { verdict: "other_material", title: "Anderes Material gemessen", offers: ["switch_material", "resense"], suggested_material_ids: ["wago-210-812"] }),
    );
    renderSheet();
    await toStep2();
    await toStep3();
    await toStep4();
    await startSensing();
    await screen.findByText("Anderes Material gemessen");
    click("Auf „Typenschilder 50 × 25 (silber)“ umstellen");
    await screen.findByText("Sensor stellen und Material einlegen");
    await toStep3();
    click("Übertragen");
    await screen.findByText(/Drucker meldet/);
    click("Weiter");
    await screen.findByRole("button", { name: "Ergebnis prüfen" });
    click("Ergebnis prüfen");
    await screen.findByText("Anderes Material gemessen");
    click("Sensor prüfen und erneut einmessen");
    await screen.findByText("Sensor stellen und Material einlegen");
    await toStep3();
    click("Übertragen");
    await screen.findByText(/Drucker meldet/);
    click("Weiter");
    expect(await screen.findByRole("button", { name: "Einmessen starten" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Ergebnis prüfen" })).toBeNull();
  });

  it("offers a fresh start after a button-method run and [Sensor prüfen und erneut einmessen]", async () => {
    fake.on(AUTOSENSE, (body) => {
      fake.state.phase = "sensing";
      fake.state.sensed = true;
      return { printer: "p", method: body.method, cost_hint: "x", status_answered: false, presense: null, session: fake.session() };
    });
    fake.verdict((s) => verdictFixture(s, { verdict: "no_gap", title: "Keine Etikettenspalte erkannt", offers: ["resense"] }));
    renderSheet();
    await toStep2();
    await toStep3();
    await toStep4();
    click("Drucker reagiert nicht? Mit der Kalibriertaste einmessen");
    click("Los");
    fireEvent.click(await screen.findByRole("button", { name: "Ergebnis abfragen" }));
    await screen.findByText("Keine Etikettenspalte erkannt");
    click("Sensor prüfen und erneut einmessen");
    await screen.findByText("Sensor stellen und Material einlegen");
    await toStep3();
    await toStep4();
    expect(screen.queryByText(/Jetzt die Kalibriertaste/)).toBeNull();
  });

  it("saves a deviating result only through [Trotzdem speichern]", async () => {
    fake.verdict((s) => verdictFixture(s, { verdict: "mismatch", title: "Messung passt nicht zum Profil", offers: ["resense", "accept_anyway"] }));
    const { onClose, setNotice } = renderSheet();
    await toStep2();
    await toStep3();
    await toStep4();
    await startSensing();
    await screen.findByText("Messung passt nicht zum Profil");
    expect(screen.queryByRole("button", { name: "Speichern" })).toBeNull();
    click("Trotzdem speichern");
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(fake.bodies(SAVE)).toEqual([{ notes: "", accept_verdict: true, pattern: null }]);
    expect(setNotice).toHaveBeenCalledWith("Gespeichert – Ergebnis ohne Bestätigung.");
  });
});

describe("session edges", () => {
  it("builds the lock banner from `since`, not from the server's message", async () => {
    fake.on(`POST ${W}/session`, () => {
      throw apiError(409, {
        code: "session_locked",
        message: "Der Etikettendrucker wird gerade von Max Monteur eingerichtet (seit 11:11)",
        holder_name: "Max Monteur",
        since: "2026-10-20T07:05:00Z",
        mode: "quick",
      });
    });
    renderSheet({ preselectId: "wago-210-804" });
    await screen.findByText("Schritt 1 von 5");
    click("Weiter");
    expect(await screen.findByText("Der Etikettendrucker wird gerade von Max Monteur eingerichtet (seit 09:05).")).toBeInTheDocument();
    expect(screen.queryByText(/11:11/)).toBeNull();
    expect(screen.getByRole("button", { name: "Weiter" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Einrichtung übernehmen" })).toBeInTheDocument();
  });

  it("shows only the not-configured text and starts no session", async () => {
    fake = createFakeLabelApi({ overview: { configured: false } });
    renderSheet();
    expect(await screen.findByText("Kein Etikettendrucker konfiguriert")).toBeInTheDocument();
    expect(screen.queryByText("Welches Material ist eingelegt?")).toBeNull();
    expect(screen.queryByRole("radio")).toBeNull();
    expect(fake.count(`POST ${W}/session`)).toBe(0);
  });

  it("asks before cancelling once settings were transferred, and names them", async () => {
    const { onClose } = renderSheet();
    await toStep2();
    await toStep3();
    click("Übertragen");
    await screen.findByText(/Drucker meldet/);
    click("Abbrechen");
    const dialog = screen.getByRole("dialog", { name: "Einrichtung abbrechen?" });
    expect(within(dialog).getByText(/die Einstellungen wurden an den Drucker übertragen\. Das Einmessen fehlt noch\./)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Einrichtung beenden" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(fake.count(DELETE)).toBe(1);
  });

  it("keeps the lock while the printer still senses: the cancel dialog shows the stop hint and ending waits", async () => {
    let finished = false;
    fake.on(POLL, () => {
      if (!finished) {
        return { phase: "sensing", answered: true, code: "50", code_text: "Misst", message: "", saw_busy: true, elapsed_s: 3, session: fake.session() };
      }
      fake.state.phase = "sensed";
      return { phase: "done", answered: true, code: "00", code_text: "Bereit", message: "", saw_busy: true, elapsed_s: 9, session: fake.session() };
    });
    const { onClose } = renderSheet();
    await toStep2();
    await toStep3();
    await toStep4();
    await startSensing();
    await screen.findByText(/Drucker misst/);
    click("Abbrechen");
    const dialog = () => screen.getByRole("dialog", { name: "Einrichtung abbrechen?" });
    expect(within(dialog()).getByText(`⚠ ${FEED_STOP_HINT}`)).toBeInTheDocument();
    expect(within(dialog()).getByText("⚠ Der Drucker misst gerade und kann dabei noch Material einziehen.")).toBeInTheDocument();
    const end = within(dialog()).getByRole("button", { name: "Einrichtung beenden" });
    expect(end).toBeDisabled();
    expect(end).toHaveAccessibleDescription(/sobald das Einmessen abgeschlossen ist/);
    fireEvent.click(end);
    expect(fake.count(DELETE)).toBe(0);
    expect(onClose).not.toHaveBeenCalled();
    finished = true;
    await waitFor(() => expect(within(dialog()).getByRole("button", { name: "Einrichtung beenden" })).toBeEnabled());
    expect(within(dialog()).queryByText(`⚠ ${FEED_STOP_HINT}`)).toBeNull();
    fireEvent.click(within(dialog()).getByRole("button", { name: "Einrichtung beenden" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(fake.count(DELETE)).toBe(1);
  });

  it("lets a silent printer's button run be ended, with the stop hint in the dialog", async () => {
    fake.on(AUTOSENSE, (body) => {
      fake.state.phase = "sensing";
      fake.state.sensed = true;
      return { printer: "p", method: body.method, cost_hint: "x", status_answered: false, presense: null, session: fake.session() };
    });
    const { onClose } = renderSheet();
    await toStep2();
    await toStep3();
    await toStep4();
    click("Drucker reagiert nicht? Mit der Kalibriertaste einmessen");
    click("Los");
    await screen.findByText(/Jetzt die Kalibriertaste/);
    click("Abbrechen");
    const dialog = screen.getByRole("dialog", { name: "Einrichtung abbrechen?" });
    expect(within(dialog).getByText(`⚠ ${FEED_STOP_HINT}`)).toBeInTheDocument();
    // Nothing is polled here, so nothing would ever unlock the button: it stays usable.
    fireEvent.click(within(dialog).getByRole("button", { name: "Einrichtung beenden" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(fake.count(DELETE)).toBe(1);
  });

  it("releases a session whose start answers only after Abbrechen and unmount", async () => {
    let answerStart: () => void = () => undefined;
    fake.on(`POST ${W}/session`, async (body) => {
      await new Promise<void>((resolve) => (answerStart = resolve));
      fake.state.material_id = body.material_id;
      return fake.session();
    });
    const { onClose, unmount } = renderSheet({ preselectId: "wago-210-804" });
    await screen.findByText("Schritt 1 von 5");
    click("Weiter");
    await waitFor(() => expect(fake.count(`POST ${W}/session`)).toBe(1));
    click("Abbrechen");
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    unmount();
    await act(async () => answerStart());
    await waitFor(() => expect(fake.count(DELETE)).toBe(1));
    expect(fake.calls.filter((call) => call.key === DELETE)[0]?.path).toBe(`${W}/session/sid-1`);
  });

  it("does not move on to step 2 when Abbrechen came before the start answered", async () => {
    let answerStart: () => void = () => undefined;
    fake.on(`POST ${W}/session`, async (body) => {
      await new Promise<void>((resolve) => (answerStart = resolve));
      fake.state.material_id = body.material_id;
      return fake.session();
    });
    // The parent keeps the sheet mounted a moment longer than onClose.
    renderSheet({ preselectId: "wago-210-804" });
    await screen.findByText("Schritt 1 von 5");
    click("Weiter");
    await waitFor(() => expect(fake.count(`POST ${W}/session`)).toBe(1));
    click("Abbrechen");
    await act(async () => answerStart());
    await waitFor(() => expect(fake.count(DELETE)).toBe(1));
    expect(screen.queryByText("Sensor stellen und Material einlegen")).toBeNull();
    expect(fake.count(`POST ${W}/session/:sid/heartbeat`)).toBe(0);
  });

  it("ends the session on unmount after save, and a failing DELETE raises nothing", async () => {
    fake.on(DELETE, () => {
      throw apiError(500, "boom");
    });
    const { onClose, unmount } = renderSheet();
    await toStep2();
    await toStep3();
    await toStep4();
    await startSensing();
    await screen.findByText("Ergebnis");
    click("Speichern");
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    unmount();
    await waitFor(() => expect(fake.count(DELETE)).toBe(1));
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
});
