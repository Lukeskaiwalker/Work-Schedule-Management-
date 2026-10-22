/**
 * How the Schrank tab runs a cabinet op (docs/PANEL_ENCLOSURE.md D4, §2.4,
 * §11): a refusal is said and changes nothing; an op that would re-feed a
 * circuit waits for the confirmation; pinned circuits are announced; the
 * sheet's follow-up (`then`) runs only once the op really applied.
 * Invented boards only — the repo is public.
 */
import { describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

import { useEnclosureOpRunner, type RegroupRequest } from "../components/schaltplan/enclosure/useEnclosureOpRunner";
import type { EnclosureOp } from "../components/schaltplan/enclosure/useSheetStack";
import type { OpResult } from "../utils/enclosureOps";
import type { PanelDocument } from "../types/schaltplan";
import { board, INDEX, row } from "./enclosureTestCatalog";

const BEFORE = board([row("r1", [])]);

function relabel(label: string): (doc: PanelDocument) => PanelDocument {
  return (doc) => ({ ...doc, rows: doc.rows.map((candidate) => ({ ...candidate, label })) });
}

function setup(options: { readOnly?: boolean } = {}) {
  const state = { document: BEFORE };
  const mutate = vi.fn((recipe: (current: PanelDocument) => PanelDocument) => {
    if (options.readOnly) return;
    state.document = recipe(state.document);
  });
  const onError = vi.fn();
  const onNotice = vi.fn();
  const confirmRegroup = vi.fn<(request: RegroupRequest) => void>();
  const hook = renderHook(
    ({ document }) => useEnclosureOpRunner({ document, index: INDEX, mutate, confirmRegroup, onError, onNotice }),
    { initialProps: { document: BEFORE } },
  );
  return { state, mutate, onError, onNotice, confirmRegroup, hook };
}

const ok = (document: PanelDocument, extra: Partial<Extract<OpResult, { ok: true }>> = {}): OpResult => ({
  ok: true, document, pinned: [], regrouped: [], ...extra,
});

describe("useEnclosureOpRunner", () => {
  it("says a refusal and changes nothing", () => {
    const { mutate, onError, hook } = setup();
    const then = vi.fn();
    act(() => hook.result.current(() => ({ ok: false, error: "Hutschiene ist nicht leer." }), then));
    expect(onError).toHaveBeenCalledWith("Hutschiene ist nicht leer.");
    expect(mutate).not.toHaveBeenCalled();
    expect(then).not.toHaveBeenCalled();
  });

  it("applies through mutate and then follows up with the applied result", () => {
    const { state, onNotice, hook } = setup();
    const then = vi.fn();
    const op: EnclosureOp = (doc) => ok(relabel("F1 · NAR")(doc), { moduleId: "m1" });
    act(() => hook.result.current(op, then));
    expect(state.document.rows[0].label).toBe("F1 · NAR");
    expect(then).toHaveBeenCalledWith(expect.objectContaining({ ok: true, moduleId: "m1", document: state.document }));
    expect(onNotice).not.toHaveBeenCalled();
  });

  it("announces pinned circuits", () => {
    const { onNotice, hook } = setup();
    act(() => hook.result.current((doc) => ok(relabel("x")(doc), { pinned: ["a", "b"] })));
    expect(onNotice).toHaveBeenCalledWith("2 Stromkreis(e) behalten ihre Einspeisung — fest eingetragen.");
  });

  it("asks first when a circuit would change its feed, and applies only on confirm", () => {
    const { state, mutate, confirmRegroup, hook } = setup();
    const then = vi.fn();
    const regrouped = [{ deviceId: "ls1", from: "hs1", to: "" }];
    act(() => hook.result.current((doc) => ok(relabel("y")(doc), { regrouped }), then));
    expect(mutate).not.toHaveBeenCalled();
    expect(confirmRegroup).toHaveBeenCalledTimes(1);
    const request = confirmRegroup.mock.calls[0][0];
    expect(request.before).toBe(BEFORE);
    expect(request.after.rows[0].label).toBe("y");
    expect(request.regrouped).toEqual(regrouped);

    act(() => request.apply());
    expect(state.document.rows[0].label).toBe("y");
    expect(then).toHaveBeenCalledTimes(1);
  });

  it("re-runs the op on the board as it is when it applies", () => {
    const { state, mutate, hook } = setup();
    const op = vi.fn<EnclosureOp>((doc) => ok({ ...doc, rows: [...doc.rows, row(`r${doc.rows.length + 1}`, [])] }));
    state.document = relabel("edited meanwhile")(BEFORE);
    act(() => hook.result.current(op));
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(op).toHaveBeenCalledTimes(2);
    expect(state.document.rows.map((candidate) => candidate.label)).toEqual(["edited meanwhile", "r2"]);
  });

  it("does not follow up on a read-only board", () => {
    const { hook } = setup({ readOnly: true });
    const then = vi.fn();
    act(() => hook.result.current((doc) => ok(relabel("z")(doc)), then));
    expect(then).not.toHaveBeenCalled();
  });
});
