/**
 * "Automatisch ergänzt" under the cabinet findings (docs/PANEL_ENCLOSURE_R4.md
 * §8.4) and the Daten tab's infeed hint (§8.5): one 56 px row per derived
 * item — "{qty} × {art} {label}" or "{qty} m {label}", the reason, "ungeprüft"
 * for what the drawing guessed — the override selects of supply, infeed,
 * joints and network (plus the network length), a switched-off item struck
 * through with "Wieder automatisch", and nothing at all without items.
 * Invented boards only — the repo is public.
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";

import { EnclosurePrepList } from "../components/schaltplan/enclosure/EnclosurePrepList";
import { infeedHint, overrideKeyOf, prepItemLine } from "../components/schaltplan/enclosure/prepListModel";
import { defaultControlBlock } from "../utils/enclosureControlBlock";
import { cabinetPrep } from "../utils/enclosurePrep";
import type { CabinetPrep, EnclosureModule, PrepOverrides } from "../types/panelEnclosure";
import type { PanelDocument } from "../types/schaltplan";
import { board, INDEX } from "./enclosureTestCatalog";

const mod = (id: string, code: string, field: number): EnclosureModule => ({
  id, code, field, unit: 0, label: "", rails: {}, fittings: null, removed_fittings: [], meters: [],
});

function cabinetBoard(options: { prep?: Partial<PrepOverrides>; incoming?: string; fuse?: string; system?: "TN-S" | "TN-C-S" } = {}): PanelDocument {
  const doc = board([], {
    code: "ZB33S",
    modules: [mod("m1", "ZH3EH16", 0), mod("m2", "ZH3EL27", 1), mod("m3", "ZU37VT5APZ2", 2)],
  });
  const prep = options.prep ? { supply: "auto", infeed: "auto", joints: "auto", network: "auto", network_m: null, ...options.prep } : undefined;
  return {
    ...doc,
    supply: { ...doc.supply, incoming: options.incoming ?? "", fuse: options.fuse ?? "", system: options.system ?? "TN-S" },
    enclosure: { ...doc.enclosure!, control_block: defaultControlBlock(), ...(prep ? { prep: prep as PrepOverrides } : {}) },
  };
}

const prepOf = (doc: PanelDocument): CabinetPrep => cabinetPrep(doc, INDEX)!;

function setup(prep: CabinetPrep | null, readOnly = false) {
  const onOverride = vi.fn();
  const view = render(<EnclosurePrepList prep={prep} readOnly={readOnly} onOverride={onOverride} />);
  return { ...view, onOverride };
}

const itemFor = (key: string) => screen.getAllByRole("listitem").find((item) => item.getAttribute("data-key") === key)!;
const optionTexts = (select: HTMLElement) => within(select).getAllByRole("option").map((option) => option.textContent);

describe("EnclosurePrepList", () => {
  it("lists every derived item under its heading, in the derivation's order", () => {
    const prep = prepOf(cabinetBoard());
    setup(prep);
    expect(screen.getByRole("heading", { name: "Automatisch ergänzt" })).toBeInTheDocument();
    const list = screen.getByRole("list", { name: "Automatisch ergänzt" });
    expect(within(list).getAllByRole("listitem").map((item) => item.getAttribute("data-key"))).toEqual(prep.items.map((item) => item.key));
  });

  it("writes qty × article label, the article bold, the reason small; metres without an article", () => {
    const prep = prepOf(cabinetBoard());
    setup(prep);
    const joints = prep.items.find((item) => item.key === "accessory:ZZ55SAVE")!;
    const row = itemFor(joints.key);
    expect(row.querySelector(".sp-encl-prep-line")?.textContent).toBe(`1 × ZZ55SAVE ${joints.label}`);
    expect(within(row).getByText("ZZ55SAVE").tagName).toBe("B");
    expect(within(row).getByText(joints.reason).tagName).toBe("SMALL");
    const wire = prep.items.find((item) => item.unit === "m")!;
    expect(itemFor(wire.key).querySelector(".sp-encl-prep-line")?.textContent).toBe(`${wire.qty} m ${wire.label}`);
    expect(prepItemLine(wire)).toEqual({ qty: `${wire.qty} m`, articleNo: null, label: wire.label });
  });

  it("flags only what the drawing guessed", () => {
    const prep = prepOf(cabinetBoard());
    setup(prep);
    for (const item of prep.items) {
      const badge = within(itemFor(item.key)).queryByText("ungeprüft");
      if (item.verified) expect(badge).toBeNull();
      else expect(badge).toHaveAttribute("title", "Aus der Zeichnung abgeleitet — vor dem Einbau prüfen");
    }
  });

  it("offers the overrides of supply, infeed, joints and network, and hands the choice over", () => {
    const { onOverride } = setup(prepOf(cabinetBoard()));
    const supply = screen.getByRole("combobox", { name: "Spannungsversorgung" });
    expect(optionTexts(supply)).toEqual(["Automatisch", "SABO", "LS 6 A", "Sicherungsbox", "Nicht ergänzen"]);
    expect(optionTexts(screen.getByRole("combobox", { name: "Einspeisung" }))).toEqual(["Automatisch", "K96ESA5", "Sammelschienenklemmen", "Nicht ergänzen"]);
    expect(optionTexts(screen.getByRole("combobox", { name: "Sammelschienenverbinder" }))).toEqual(["Automatisch", "Nicht ergänzen"]);
    expect(optionTexts(screen.getByRole("combobox", { name: "Netzwerkleitung" }))).toEqual(["Automatisch", "Nicht ergänzen"]);
    fireEvent.change(supply, { target: { value: "LS" } });
    expect(onOverride).toHaveBeenCalledWith("supply", "LS");
    fireEvent.change(screen.getByRole("combobox", { name: "Einspeisung" }), { target: { value: "clamps" } });
    expect(onOverride).toHaveBeenCalledWith("infeed", "clamps");
  });

  it("takes the network lead's length by the sheet's rule", () => {
    const { onOverride } = setup(prepOf(cabinetBoard()));
    const length = screen.getByRole("textbox", { name: "Länge" });
    expect(length).toHaveAttribute("inputMode", "decimal");
    fireEvent.change(length, { target: { value: "2,5" } });
    fireEvent.blur(length);
    expect(onOverride).toHaveBeenCalledWith("network_m", 2.5);
    fireEvent.change(length, { target: { value: "99" } });
    fireEvent.blur(length);
    expect(onOverride).toHaveBeenCalledTimes(1);
    expect(length).toHaveAccessibleDescription("Länge 0,5 bis 20 m — leer lassen für die Länge aus der Zeichnung.");
  });

  it("strikes a switched-off item through and brings it back", () => {
    const prep = prepOf(cabinetBoard({ prep: { joints: "off" } }));
    const { onOverride } = setup(prep);
    const row = itemFor("accessory:ZZ55SAVE");
    expect(row).toHaveClass("is-suppressed");
    expect(within(row).getByText("manuell abgewählt")).toBeInTheDocument();
    expect(within(row).queryByRole("combobox")).toBeNull();
    fireEvent.click(within(row).getByRole("button", { name: "Wieder automatisch" }));
    expect(onOverride).toHaveBeenCalledWith("joints", "auto");
  });

  it("disables every choice on a read-only board", () => {
    setup(prepOf(cabinetBoard({ prep: { network: "off" } })), true);
    for (const select of screen.getAllByRole("combobox")) expect(select).toBeDisabled();
    expect(screen.getByRole("button", { name: "Wieder automatisch" })).toBeDisabled();
  });

  it("is not there without items", () => {
    const { container } = setup(null);
    expect(container).toBeEmptyDOMElement();
    setup({ items: [], runs: [], infeed: null, overrides: { supply: "auto", infeed: "auto", joints: "auto", network: "auto", network_m: null } });
    expect(screen.queryByRole("list", { name: "Automatisch ergänzt" })).toBeNull();
  });
});

describe("overrideKeyOf", () => {
  it("maps each overridable item to its key and leaves the rest alone", () => {
    const prep = prepOf(cabinetBoard());
    const keys = prep.items.map((item) => [item.key, overrideKeyOf(item)]);
    // eHZ, 1100 mm, APZ low in field 3, one field between: Hager's table says WAN100.
    expect(keys.filter(([, key]) => key !== null)).toEqual([
      ["accessory:ZY3N2SA", "supply"],
      ["accessory:K96ESA5", "infeed"],
      ["accessory:ZZ55SAVE", "joints"],
      ["accessory:ZZ45WAN100", "network"],
    ]);
    expect(keys.filter(([key]) => String(key).startsWith("part:")).every(([, key]) => key === null)).toBe(true);
  });
});

describe("infeedHint (§8.5)", () => {
  it("says what was recognised and what it led to", () => {
    expect(infeedHint(prepOf(cabinetBoard({ incoming: "NYY-J 5x16 mm²" })), "")).toBe("Querschnitt erkannt: 16 mm² → Einspeiseadapter K96ESA5");
    expect(infeedHint(prepOf(cabinetBoard({ incoming: "NYY-J 5x50 mm²" })), "")).toBe("Querschnitt erkannt: 50 mm² → 5 × Sammelschienenklemme K96F");
    expect(infeedHint(prepOf(cabinetBoard({ incoming: "NAYY-J 4x50" })), "")).toBe("Querschnitt erkannt: 50 mm² Al → 4 × Sammelschienenklemme K96N");
    expect(infeedHint(prepOf(cabinetBoard({ incoming: "" })), "")).toBe("Kein Querschnitt erkannt → Einspeiseadapter K96ESA5 angenommen");
  });

  it("adds the fuse check for the adapter behind more than 100 A", () => {
    expect(infeedHint(prepOf(cabinetBoard({ incoming: "NYY-J 5x16" })), "NH 125 A")).toBe(
      "Querschnitt erkannt: 16 mm² → Einspeiseadapter K96ESA5 · Vorsicherung über 100 A prüfen",
    );
    expect(infeedHint(prepOf(cabinetBoard({ incoming: "NYY-J 5x16" })), "NH 63 A")).toBe("Querschnitt erkannt: 16 mm² → Einspeiseadapter K96ESA5");
  });

  it("is null without a prep or without a main busbar", () => {
    expect(infeedHint(null, "")).toBeNull();
    const plain = board([], { code: "ZB33S", modules: [mod("m3", "ZU37VT5APZ2", 2)] });
    expect(infeedHint(prepOf(plain), "")).toBeNull();
  });
});
