/**
 * `useBoardTerminals` (docs/PANEL_ENCLOSURE_R2.md §3.1, §6.7): the one place
 * SchaltplanPage derives the board's terminals, so the Klemmen tab, the
 * legend, the findings and the Schrank tab number the same X labels.
 *
 * A cabinet board is not `ready` until the catalogue index is there: the
 * skip set needs the zones, and numbers shown before it loads would shift
 * once it does ("Schrankkatalog wird geladen…"). A board without a cabinet
 * needs no catalogue at all.
 */
import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { useBoardTerminals } from "../hooks/useBoardTerminals";
import { emptyPlacement } from "../utils/enclosureTerminals";
import { deriveTerminals } from "../utils/schaltplanTerminals";
import type { CatalogIndex } from "../utils/enclosureCatalog";
import type { PanelDocument } from "../types/schaltplan";
import { FIXTURE_BOARDS, FIXTURE_INDEX, boardDocument } from "./enclosureFixtureBoards";

type Props = { doc: PanelDocument | null; index: CatalogIndex | null };

function render(initial: Props) {
  return renderHook(({ doc, index }: Props) => useBoardTerminals(doc, index), { initialProps: initial });
}

describe("useBoardTerminals", () => {
  it("has nothing without a document", () => {
    const { result } = render({ doc: null, index: FIXTURE_INDEX });
    expect(result.current).toEqual({ ready: false, terms: null, placement: null });
  });

  it("waits for the catalogue on a cabinet board, then places its terminals", () => {
    const doc = boardDocument("terminals_zb34s");
    const hook = render({ doc, index: null });
    expect(hook.result.current).toEqual({ ready: false, terms: null, placement: null });
    hook.rerender({ doc, index: FIXTURE_INDEX });
    const { ready, terms, placement } = hook.result.current;
    expect(ready).toBe(true);
    expect([...terms!.skip].sort()).toEqual(FIXTURE_BOARDS.terminals_zb34s.terminal_skip);
    expect(placement).toEqual(FIXTURE_BOARDS.terminals_zb34s.terminal_placement);
  });

  it("is ready at once on a board without a cabinet, catalogue or not", () => {
    const doc = { ...boardDocument("meter_dist_zb33s"), enclosure: null };
    const { result } = render({ doc, index: null });
    expect(result.current.ready).toBe(true);
    expect(result.current.terms!.skip.size).toBe(0);
    expect(result.current.terms!.groups).toEqual(deriveTerminals(doc));
    expect(result.current.placement).toEqual(emptyPlacement());
  });

  it("keeps the same objects while the document is the same", () => {
    const doc = boardDocument("terminals_rk_zb53s");
    const hook = render({ doc, index: FIXTURE_INDEX });
    const first = hook.result.current;
    hook.rerender({ doc, index: FIXTURE_INDEX });
    expect(hook.result.current).toBe(first);
    const edited = { ...doc };
    hook.rerender({ doc: edited, index: FIXTURE_INDEX });
    expect(hook.result.current.terms).not.toBe(first.terms);
    expect(hook.result.current.placement).toEqual(first.placement);
  });
});
