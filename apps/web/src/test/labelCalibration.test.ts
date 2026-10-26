/**
 * The pure helpers behind the label-printer calibration screens
 * (docs/LABEL_PRINTER_CALIBRATION.md §7.2, §7.4, §7.8, §4.11).
 *
 * They carry everything a person reads off the screen and then does with
 * their hands — where the sensor pointer goes, how far to push it, what the
 * guides are set to, by how much the print offset changes — so a wrong sign
 * or a dropped decimal here is a wrong physical instruction, not a typo.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ApiError } from "../api/client";
import type { LabelMaterial, PatternGeometry } from "../types/labelPrinter";
import {
  FEED_STOP_HINT,
  apiErrorCode,
  apiErrorDetail,
  calibrationChip,
  checklistItems,
  diagramDescription,
  formatLocalTime,
  formatMmDe,
  formatScaleDe,
  formatSignedMmDe,
  guideText,
  offsetCorrections,
  parseScaleInput,
  scaleFromRuler,
  scaleShiftText,
  sensorTrack,
  targetOffsetMm,
  targetText,
  visibleHints,
  webWidthMm,
} from "../utils/labelCalibration";
import { M2009, M211, M804, M805, M812, M824 } from "./fixtures/labelPrinterMaterials";

const DIECUT_804: PatternGeometry = {
  kind: "diecut",
  width_mm: 44,
  length_mm: 99,
  inset_mm: 2,
  line_mm: 0.25,
  letters: true,
  ruler_from_mm: 10,
  ruler_to_mm: 90,
  side_line_inset_mm: null,
  bar_inset_mm: null,
  feed_measurable: true,
  across_measurable: false,
};

const CONT_2009: PatternGeometry = {
  kind: "continuous",
  width_mm: 11,
  length_mm: 40,
  inset_mm: 1,
  line_mm: 0.25,
  letters: true,
  ruler_from_mm: null,
  ruler_to_mm: null,
  side_line_inset_mm: 1,
  bar_inset_mm: 3,
  feed_measurable: false,
  across_measurable: true,
};

const NO_INPUT = { lead: null, trail: null, left: null, right: null, rulerMeasured: null };

function at(material: LabelMaterial, sensor_scale: number): LabelMaterial {
  return { ...material, sensor_scale };
}

describe("number formatting", () => {
  it("writes millimetres with a decimal comma and a real minus", () => {
    expect(formatMmDe(11)).toBe("11");
    expect(formatMmDe(3.5)).toBe("3,5");
    expect(formatMmDe(-2.5)).toBe("−2,5");
    expect(formatMmDe(-0.04)).toBe("0");
    expect(formatSignedMmDe(0.4)).toBe("+0,4");
    expect(formatSignedMmDe(-1.26)).toBe("−1,3");
  });

  it("writes scale readings with one decimal and drops a trailing ,0", () => {
    expect(formatScaleDe(3.4)).toBe("3,4");
    expect(formatScaleDe(3)).toBe("3");
  });

  it("parses a scale reading typed with comma or point, rounding to one decimal", () => {
    expect(parseScaleInput("3,4")).toBe(3.4);
    expect(parseScaleInput("3.4")).toBe(3.4);
    expect(parseScaleInput("3,44")).toBe(3.4);
    expect(parseScaleInput(" 2,9 ")).toBe(2.9);
    expect(parseScaleInput("5,6")).toBeNull();
    expect(parseScaleInput("0,4")).toBeNull();
    expect(parseScaleInput("abc")).toBeNull();
    expect(parseScaleInput("")).toBeNull();
  });
});

describe("web and guides", () => {
  it("knows the liner width, or adds up the lanes", () => {
    expect(webWidthMm(M805)).toBe(34);
    expect(webWidthMm(M804)).toBe(44);
    const unknownLiner = { ...M805, web: { ...M805.web, liner_width_mm: null } };
    expect(webWidthMm(unknownLiner)).toBe(31);
  });

  it("says how to set the guides per material", () => {
    expect(guideText(M804)).toBe("Materialführungen ganz öffnen");
    expect(guideText(M2009)).toBe(
      "Materialführungen auf 1 mm + 11 mm + 1 mm stellen – das Material darf nicht klemmen",
    );
    expect(guideText(M805)).toBe(
      "Materialführungen an den Trägerrand anlegen – Trägerbreite ≈ 34 mm (geschätzt), je 1 mm Luft",
    );
  });
});

describe("sensor position", () => {
  it("turns the reading into millimetres from the centre line", () => {
    expect(targetOffsetMm(M804)).toBe(4);
    expect(targetOffsetMm(M2009)).toBe(0);
    expect(targetOffsetMm(at(M804, 2.5))).toBe(-5);
  });

  it("names the target reading and its side", () => {
    expect(targetText(M804)).toBe("Zeiger ▲▼ auf 3,4 der Skala – ca. 4 mm rechts der Mitte");
    expect(targetText(M2009)).toBe("Zeiger ▲▼ auf 3 der Skala – Mitte der Materialbahn");
    expect(targetText(2.5)).toBe("Zeiger ▲▼ auf 2,5 der Skala – ca. 5 mm links der Mitte");
  });

  it("says how far to push the carriage from where it stands", () => {
    expect(scaleShiftText(2.9, 3.4)).toBe("≈ 5 mm nach rechts schieben");
    expect(scaleShiftText(3.8, 3.4)).toBe("≈ 4 mm nach links schieben");
    expect(scaleShiftText(3.4, 3.4)).toBe("Zeiger steht richtig");
  });

  it("describes the diagram for screen readers, with the current reading when given", () => {
    expect(diagramDescription(M804, "loaded", null)).toBe(
      "Sensor-Zeiger auf 3,4 der Skala, etwa 4 mm rechts der Mitte; Etiketten 44 mm breit, Spalt 3 mm; Materialführung ganz offen.",
    );
    expect(diagramDescription(M804, "sensor", 2.9)).toContain(
      "; Zeiger steht jetzt auf 2,9 – etwa 5 mm nach rechts schieben",
    );
  });
});

describe("hints and checklist", () => {
  it("drops web hints once measured and position hints once the reading is overridden", () => {
    const measured = { ...M805, web: { ...M805.web, source: "measured" as const } };
    expect(visibleHints(measured).some((hint) => hint.topic === "web")).toBe(false);
    expect(visibleHints(M805).some((hint) => hint.topic === "web")).toBe(true);
    const overridden = { ...M804, overridden_fields: ["sensor_scale"] };
    expect(visibleHints(overridden).some((hint) => hint.topic === "sensor_position")).toBe(false);
    expect(visibleHints(M804).some((hint) => hint.topic === "sensor_position")).toBe(true);
  });

  it("orders the checklist roller → sensor → roll → guides → ribbon → lid", () => {
    const items = checklistItems(M804);
    expect(items.map((item) => item.key)).toEqual(["roller", "sensor", "roll", "guides", "ribbon", "lid"]);
    expect(items[0].text).toBe("Andruckwalze 258-5006 (schwarz, glatt) ist eingesetzt");
    expect(items[1].text).toBe("Sensor-Schlitten verschieben, bis der Zeiger auf 3,4 der Skala zeigt");
    expect(checklistItems(M2009)[1].text).toBe(
      "Sensor-Schlitten verschieben, bis der Zeiger auf 3 der Skala zeigt",
    );
    expect(items[5].info).toContain("Beim Schließen des Deckels kann der Drucker selbst einmessen");
    expect(checklistItems(M2009)[2].text).toContain("Externen Abroller hinter den Drucker stellen");
  });
});

describe("offsetCorrections", () => {
  it("corrects the feed offset from A alone", () => {
    const result = offsetCorrections(M804, DIECUT_804, { ...NO_INPUT, lead: 2.4 });
    expect(result.xOffset).toMatchObject({ from: 2, to: 1.6, clamped: false });
    expect(result.across).toBeNull();
  });

  it("uses B only for a length check, never for the offset", () => {
    const result = offsetCorrections(M804, DIECUT_804, { ...NO_INPUT, lead: 2.4, trail: 3.6 });
    expect(result.xOffset?.to).toBe(1.6);
    expect(result.infos.join("\n")).toContain(
      "Länge: Druckbild 2 mm kürzer als erwartet – Längen-/Maßstabsabweichung, wird nicht als Versatz übernommen",
    );
  });

  it("corrects across from L, or from L and R, when the guides fit", () => {
    const fit = { ...M812, guide: "fit" as const };
    const geometry = { ...DIECUT_804, across_measurable: true };
    expect(offsetCorrections(fit, geometry, { ...NO_INPUT, left: 2.5 }).across).toMatchObject({ to: 0.5 });
    const both = offsetCorrections(fit, geometry, { ...NO_INPUT, left: 2.6, right: 1.8 });
    expect(both.across).toMatchObject({ to: 0.4 });
    expect(both.infos).toEqual([]);
    const wide = offsetCorrections(fit, geometry, { ...NO_INPUT, left: 2.6, right: 2.4 });
    expect(wide.infos.join("\n")).toContain("Breite weicht um 1 mm ab – Profilbreite prüfen");
  });

  it("gives no across correction with the guides fully open", () => {
    const result = offsetCorrections(M804, DIECUT_804, { ...NO_INPUT, left: 3, right: 1 });
    expect(result.across).toBeNull();
    expect(result.infos.join("\n")).toContain(
      "Seitliche Lage bei ganz offener Führung nicht festgelegt – kein Korrekturwert (L − R = 2 mm)",
    );
  });

  it("corrects only across on continuous stock", () => {
    const result = offsetCorrections(M2009, CONT_2009, { ...NO_INPUT, lead: 5, left: 1.1, right: 0.9 });
    expect(result.xOffset).toBeNull();
    expect(result.across).toMatchObject({ from: 0, to: 0.1 });
  });

  it("clamps a correction to the material's offset limits and says so", () => {
    const result = offsetCorrections(M804, DIECUT_804, { ...NO_INPUT, lead: 7 });
    expect(result.xOffset).toMatchObject({ raw: -3, to: -2, clamped: true });
    expect(result.infos.join("\n")).toContain(
      "Korrektur −3 mm liegt außerhalb des möglichen Bereichs (−2 … 10 mm) – übernommen wird −2 mm. Material, Sensorposition und Führungen prüfen.",
    );
  });

  it("reports the ruler scale as information only", () => {
    // The ruler's 80 mm are 945 dots at 300 dpi: a printer true to it reads 80,0.
    expect(scaleFromRuler(80, 80)).toBe(11.81);
    expect(scaleFromRuler(80, 81.3)).toBe(11.62);
    const result = offsetCorrections(M804, DIECUT_804, { ...NO_INPUT, rulerMeasured: 81.3 });
    expect(result.infos.join("\n")).toContain("Maßstab ≈ 11,62 Punkte je mm (SMPL rechnet mit 11,81)");
  });
});

describe("sensorTrack", () => {
  it("matches the contract's expectations for the builtins (always information)", () => {
    const cases: Array<[LabelMaterial, string]> = [
      [M804, "alternating"],
      [M824, "alternating"],
      [M812, "alternating"],
      [M805, "alternating"],
      [M211, "continuous"],
      [M2009, "continuous"],
      [at(M805, 3), "edge"],
      [at(M211, 3.4), "off_material"],
      [at(M2009, 3.4), "continuous"],
    ];
    for (const [material, kind] of cases) {
      const track = sensorTrack(material);
      expect(track.kind, `${material.id} @ ${material.sensor_scale}`).toBe(kind);
      expect(track.severity).toBe("info");
    }
  });

  it("qualifies the text for open guides and estimated sizes", () => {
    expect(sensorTrack(M804).text).toBe(
      "Falls das Material mittig läuft: Etikett und Spalt laufen abwechselnd unter dem Sensor durch",
    );
    expect(sensorTrack(M805).text).toBe(
      "Etikett und Spalt laufen abwechselnd unter dem Sensor durch (Maße geschätzt)",
    );
    // A liner wider than the lanes leaves a margin the spot can sit on.
    const linerOnly = { ...M805, web: { ...M805.web, liner_width_mm: 40 }, sensor_scale: 4.8 };
    expect(sensorTrack(linerOnly).kind).toBe("liner_only");
    const mark = { ...M812, media_type: "mark" as const, mark_width_mm: 4 };
    expect(sensorTrack(mark).kind).toBe("mark_track");
  });
});

describe("calibrationChip", () => {
  const record = {
    kind: "quick" as const,
    at: "2026-10-20T09:12:00Z",
    by_name: "Erika Muster",
    verdict: "match" as const,
    fresh: true,
    accepted: false,
    stale: false,
    measured_length_mm: 97,
    measured_gap_mm: 2.5,
    notes: "",
  };

  it("names the state of the last calibration, never as checked", () => {
    expect(calibrationChip(null).text).toBe("Nicht eingemessen");
    expect(calibrationChip({ ...record, stale: true }).text).toBe("Profil seit Messung geändert");
    expect(calibrationChip(record).text).toBe("Eingemessen 20.10.2026");
    expect(calibrationChip({ ...record, kind: "full" }).text).toBe("Kalibriert 20.10.2026");
    expect(calibrationChip({ ...record, verdict: "mismatch", accepted: true }).text).toBe(
      "Gespeichert mit Abweichung 20.10.2026",
    );
    expect(calibrationChip({ ...record, verdict: "unchecked", accepted: true }).text).toBe(
      "Ungeprüft gespeichert 20.10.2026",
    );
    expect(calibrationChip({ ...record, verdict: "no_result", accepted: true }).text).toBe(
      "Ungeprüft gespeichert 20.10.2026",
    );
  });
});

describe("times and errors", () => {
  const env = (globalThis as unknown as { process: { env: Record<string, string | undefined> } }).process
    .env;
  let previousTz: string | undefined;
  beforeAll(() => {
    previousTz = env.TZ;
    env.TZ = "Europe/Berlin";
  });
  afterAll(() => {
    if (previousTz === undefined) delete env.TZ;
    else env.TZ = previousTz;
  });

  it("formats an ISO UTC time as local HH:MM", () => {
    expect(formatLocalTime("2026-10-20T07:05:00Z")).toBe("09:05");
    expect(formatLocalTime("2026-12-20T07:05:00Z")).toBe("08:05");
  });

  it("reads the code and dict detail of an API error, and nothing from a string detail", () => {
    const locked = new ApiError("Der Etikettendrucker wird gerade …", 409, {
      code: "session_locked",
      message: "Der Etikettendrucker wird gerade …",
      holder_name: "Max",
      since: "2026-10-20T07:05:00Z",
    });
    expect(apiErrorCode(locked)).toBe("session_locked");
    expect(apiErrorDetail(locked)?.holder_name).toBe("Max");
    const plain = new ApiError("Unbekanntes Material: x", 400, "Unbekanntes Material: x");
    expect(apiErrorCode(plain)).toBeNull();
    expect(apiErrorDetail(plain)).toBeNull();
    expect(apiErrorCode(new Error("boom"))).toBeNull();
  });

  it("keeps the stop instruction word for word", () => {
    expect(FEED_STOP_HINT).toBe(
      "Läuft zu viel Material durch: Deckel öffnen – der Drucker stoppt (nicht am Drucker geprüft).",
    );
  });
});
