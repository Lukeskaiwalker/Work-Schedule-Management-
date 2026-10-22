/**
 * The catalogue admin's form model (docs/PANEL_ENCLOSURE.md §3.1, §3.5, §7,
 * §11): metadata fields the admin types, accessories with a quantity, and
 * the rest of the spec as "Aufbau (JSON, für Fortgeschrittene)". The form
 * merges them into one `CatalogEntryIn`; the server stays the judge, but the
 * checks that would only cost a round trip (bad JSON, a key the edit drops,
 * a frozen size on a used code, 32 KB) answer here, in the server's words.
 *
 * Invented data only — the repo is public.
 */
import { describe, expect, it } from "vitest";

import {
  ENTRY_MAX_BYTES,
  applyTemplate,
  blankDraft,
  changeRuleError,
  draftFromSpec,
  draftFromUncatalogued,
  entryFromDraft,
  metadataKeys,
  specFromDraft,
  type CatalogDraft,
} from "../components/schaltplan/enclosure/catalogEntryDraft";
import { CABINETS, MODULES, testCatalog } from "./enclosureTestCatalog";
import type { ModuleSpec, UncataloguedArticle } from "../types/panelEnclosure";

const ZH3EH16 = MODULES.ZH3EH16;
const ZU37KS = MODULES.ZU37KS;

function ok(draft: CatalogDraft, options?: Parameters<typeof entryFromDraft>[1]) {
  const result = entryFromDraft(draft, options);
  if (!result.ok) throw new Error(result.error);
  return result.body;
}

describe("draftFromSpec / entryFromDraft", () => {
  it("round-trips a module spec through fields and Aufbau unchanged", () => {
    const draft = draftFromSpec("module", ZH3EH16);
    const body = ok(draft);
    expect(body.entry_type).toBe("module");
    expect(body.spec).toEqual(ZH3EH16);
  });

  it("round-trips a cabinet spec", () => {
    const body = ok(draftFromSpec("enclosure", CABINETS.ZB33S));
    expect(body).toEqual({ entry_type: "enclosure", spec: CABINETS.ZB33S });
  });

  it("keeps the metadata out of the Aufbau JSON", () => {
    const draft = draftFromSpec("module", ZH3EH16);
    const aufbau = JSON.parse(draft.aufbau) as Record<string, unknown>;
    for (const key of metadataKeys("module")) expect(aufbau).not.toHaveProperty(key);
    expect(aufbau).toHaveProperty("zones");
    expect(aufbau).toHaveProperty("fittings");
    expect(draft.family).toBe("meter_ehz");
    expect(draft.height_units).toBe(7);
    expect(draft.unverified).toBe("Feldaufbau angenommen");
  });

  it("a field edit lands in the spec; the code is normalised", () => {
    const draft = { ...draftFromSpec("module", ZU37KS), code: " zu37ks ", name: "Verteilerfeld 7 Reihen", note: "Werkstatt-Notiz" };
    const body = ok(draft);
    expect(body.spec.code).toBe("ZU37KS");
    expect(body.spec.name).toBe("Verteilerfeld 7 Reihen");
    expect(body.spec.note).toBe("Werkstatt-Notiz");
  });

  it("one unverified line per non-empty line, trimmed", () => {
    const draft = { ...draftFromSpec("module", ZU37KS), verified: false, unverified: "  Reihenzahl angenommen \n\n Tiefe geschätzt" };
    expect(ok(draft).spec.unverified).toEqual(["Reihenzahl angenommen", "Tiefe geschätzt"]);
  });

  it("an empty source is null, a trimmed https link is kept", () => {
    expect(ok({ ...draftFromSpec("module", ZU37KS), source_url: "   " }).spec.source_url).toBeNull();
    expect(ok({ ...draftFromSpec("module", ZU37KS), source_url: " https://example.org/zu37ks " }).spec.source_url).toBe(
      "https://example.org/zu37ks",
    );
  });

  it("accessories carry their quantity; blank rows are dropped", () => {
    const draft: CatalogDraft = {
      ...draftFromSpec("module", ZU37KS),
      accessories: [
        { article_no: "ZZ99X1", label: "Feldverbinder (erfunden)", qty: 2, verified: true },
        { article_no: " ", label: "", qty: 1, verified: true },
      ],
    };
    expect(ok(draft).spec.accessories).toEqual([{ article_no: "ZZ99X1", label: "Feldverbinder (erfunden)", qty: 2, verified: true }]);
  });
});

describe("entryFromDraft refusals (German, before the round trip)", () => {
  const base = () => draftFromSpec("module", ZU37KS);

  it("bad JSON", () => {
    const result = entryFromDraft({ ...base(), aufbau: "{ zones: [" });
    expect(result).toEqual({ ok: false, error: expect.stringContaining("kein gültiges JSON") });
  });

  it("JSON that is no object", () => {
    expect(entryFromDraft({ ...base(), aufbau: "[]" })).toEqual({ ok: false, error: expect.stringContaining("muss ein Objekt sein") });
    expect(entryFromDraft({ ...base(), aufbau: "null" })).toEqual({ ok: false, error: expect.stringContaining("muss ein Objekt sein") });
  });

  it("a form field typed into the JSON as well", () => {
    const aufbau = JSON.stringify({ ...JSON.parse(base().aufbau), name: "doppelt" });
    expect(entryFromDraft({ ...base(), aufbau })).toEqual({ ok: false, error: expect.stringContaining("„name“") });
  });

  it("missing code, article number or name", () => {
    expect(entryFromDraft({ ...base(), code: "" })).toEqual({ ok: false, error: expect.stringContaining("Code") });
    expect(entryFromDraft({ ...base(), code: "z!" })).toEqual({ ok: false, error: expect.stringContaining("Code") });
    expect(entryFromDraft({ ...base(), article_no: " " })).toEqual({ ok: false, error: expect.stringContaining("Artikelnummer") });
    expect(entryFromDraft({ ...base(), name: "" })).toEqual({ ok: false, error: expect.stringContaining("Bezeichnung") });
  });

  it("ungeprüft without saying what", () => {
    expect(entryFromDraft({ ...base(), verified: false, unverified: " \n " })).toEqual({
      ok: false,
      error: expect.stringContaining("ungeprüft"),
    });
  });

  it("a source that is no https link", () => {
    expect(entryFromDraft({ ...base(), source_url: "javascript:alert(1)" })).toEqual({ ok: false, error: expect.stringContaining("https") });
    expect(entryFromDraft({ ...base(), source_url: "http://example.org" })).toEqual({ ok: false, error: expect.stringContaining("https") });
  });

  it("an accessory with only half its data, or a quantity out of range", () => {
    const half = { ...base(), accessories: [{ article_no: "ZZ99X1", label: "", qty: 1, verified: true }] };
    expect(entryFromDraft(half)).toEqual({ ok: false, error: expect.stringContaining("Zubehör 1") });
    const many = { ...base(), accessories: [{ article_no: "ZZ99X1", label: "Verbinder", qty: 100, verified: true }] };
    expect(entryFromDraft(many)).toEqual({ ok: false, error: expect.stringContaining("Zubehör 1") });
  });

  it("over 32 KB, with the server's sentence", () => {
    const note = "x".repeat(ENTRY_MAX_BYTES);
    const aufbau = JSON.stringify({ ...JSON.parse(base().aufbau), padding: note });
    expect(entryFromDraft({ ...base(), aufbau })).toEqual({ ok: false, error: "Eintrag zu groß (max. 32 KB)." });
  });

  it("an edit that drops a rail key, or changes a fitting's kind (§3.5 rule 1)", () => {
    const spec = JSON.parse(draftFromSpec("module", ZH3EH16).aufbau) as ModuleSpec;
    const zones = spec.zones.map((zone) => (zone.key === "aar" ? { ...zone, rails: zone.rails.filter((rail) => rail.key !== "aar2") } : zone));
    const dropped = { ...draftFromSpec("module", ZH3EH16), aufbau: JSON.stringify({ ...spec, zones }) };
    expect(entryFromDraft(dropped, { original: ZH3EH16, usedByPlans: 0 })).toEqual({
      ok: false,
      error: "Schlüssel „aar2“ bleibt — ausmustern statt löschen oder umbenennen.",
    });
    expect(entryFromDraft(dropped).ok).toBe(true); // creating: nothing binds yet
  });
});

describe("changeRuleError (§3.5)", () => {
  it("fitting kind changed", () => {
    const next: ModuleSpec = {
      ...ZH3EH16,
      fittings: ZH3EH16.fittings.map((fitting) => (fitting.key === "hs" && fitting.device ? { ...fitting, device: { ...fitting.device, kind: "rcd" } } : fitting)),
    };
    expect(changeRuleError("module", ZH3EH16, next, 0)).toBe("Schlüssel „hs“ bleibt — ausmustern statt löschen oder umbenennen.");
  });

  it("retiring a rail is allowed", () => {
    const next: ModuleSpec = {
      ...ZU37KS,
      zones: ZU37KS.zones.map((zone) => ({ ...zone, rails: zone.rails.map((rail) => (rail.key === "r7" ? { ...rail, retired: true } : rail)) })),
    };
    expect(changeRuleError("module", ZU37KS, next, 3)).toBeNull();
  });

  it("size, family and meter places are frozen while the code is used", () => {
    const taller: ModuleSpec = { ...ZU37KS, height_units: 6 };
    expect(changeRuleError("module", ZU37KS, taller, 2)).toBe(
      "In 2 Verteilerplänen verwendet — Größe, Familie und Zählerplätze bleiben. Als neuen Eintrag anlegen.",
    );
    expect(changeRuleError("module", ZU37KS, taller, 0)).toBeNull();
    const places: ModuleSpec = { ...ZH3EH16, zones: ZH3EH16.zones.map((zone) => (zone.type === "ZF" ? { ...zone, meter_places: 2 } : zone)) };
    expect(changeRuleError("module", ZH3EH16, places, 1)).toContain("In 1 Verteilerplänen verwendet");
  });

  it("positions, labels and article numbers stay editable on a used code", () => {
    const moved: ModuleSpec = {
      ...ZH3EH16,
      name: "Korrigiert",
      zones: ZH3EH16.zones.map((zone) => ({ ...zone, label: "neu", rails: zone.rails.map((rail) => ({ ...rail, ple: 11 })) })),
    };
    expect(changeRuleError("module", ZH3EH16, moved, 9)).toBeNull();
  });

  it("a cabinet's grid is frozen while used", () => {
    expect(changeRuleError("enclosure", CABINETS.ZB33S, { ...CABINETS.ZB33S, fields: 4 }, 1)).toContain("In 1 Verteilerplänen verwendet");
    expect(changeRuleError("enclosure", CABINETS.ZB33S, { ...CABINETS.ZB33S, door_leaves: 1 }, 1)).toBeNull();
  });
});

describe("new drafts", () => {
  it("a blank module is a valid spec once code, article and name are typed", () => {
    const draft = { ...blankDraft("module"), code: "ZX99TEST", article_no: "ZX99TEST", name: "Testfeld (erfunden)" };
    const body = ok(draft);
    expect(body.entry_type).toBe("module");
    const spec = body.spec as ModuleSpec;
    expect(spec.zones.length).toBeGreaterThan(0);
    expect(spec.verified).toBe(false);
    expect(spec.unverified.length).toBeGreaterThan(0);
  });

  it("a blank cabinet carries its grid in the Aufbau", () => {
    const draft = { ...blankDraft("enclosure"), code: "ZX33TEST", article_no: "ZX33TEST", name: "Testschrank (erfunden)" };
    const spec = ok(draft).spec as unknown as Record<string, unknown>;
    expect(spec.fields).toBeGreaterThan(0);
    expect(spec.units_per_field).toBeGreaterThan(0);
    expect(spec.mounting).toBe("surface");
  });

  it("a shelf article the catalogue lacks prefills code, article and name", () => {
    const item: UncataloguedArticle = {
      article: { id: 7, article_number: "A-0007", item_name: "Hager ZX37XS Verteilerfeld (erfunden)", manufacturer: "Hager", unit: "ST", internal_code: null, stock_available: 3 },
      code_guess: "ZX37XS",
    };
    const draft = draftFromUncatalogued(item);
    expect(draft).toMatchObject({ entryType: "module", code: "ZX37XS", article_no: "ZX37XS", name: "Hager ZX37XS Verteilerfeld (erfunden)" });
  });

  it("'Vorlage: wie …' copies the structure, keeps what was typed and marks it unchecked", () => {
    const template = testCatalog().modules.find((entry) => entry.code === "ZU37KS")!;
    const typed = { ...blankDraft("module"), code: "ZX37NEU", article_no: "ZX37NEU", name: "" };
    const draft = applyTemplate(typed, template);
    expect(draft.code).toBe("ZX37NEU");
    expect(draft.article_no).toBe("ZX37NEU");
    expect(draft.name).toBe(ZU37KS.name);
    expect(draft.verified).toBe(false);
    expect(draft.unverified.split("\n")[0]).toBe("Aufbau wie ZU37KS übernommen");
    expect(JSON.parse(draft.aufbau).zones).toEqual(ZU37KS.zones);
    const spec = ok(draft).spec as ModuleSpec;
    expect(spec.code).toBe("ZX37NEU");
    expect(spec.source_url).toBeNull();
  });

  it("specFromDraft merges even when the metadata is not complete yet (for the preview)", () => {
    const result = specFromDraft({ ...blankDraft("module"), code: "", name: "" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.spec).toHaveProperty("zones");
    expect(specFromDraft({ ...blankDraft("module"), aufbau: "{" }).ok).toBe(false);
  });
});
