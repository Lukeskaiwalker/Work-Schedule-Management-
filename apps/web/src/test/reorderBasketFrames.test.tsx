/**
 * What Werkstatt › Nachbestellen shows on the frame nobody waits for.
 *
 * Both reorder screens stay mounted and only self-gate on `active`, so tapping
 * the tab re-renders them BEFORE the load effect runs — React flushes passive
 * effects after paint. With `loading` initialised to false and `groups` to [],
 * that frame rendered "Nichts nachzubestellen. / 0 Artikel unter
 * Mindestbestand" over a list not a single byte of which had been requested.
 *
 * A `findBy*` assertion cannot see this: it waits, and by then the truth has
 * arrived. So this test records EVERY committed frame and asserts that none of
 * them presented an answer the hook did not have.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";

import { AppContext } from "../context/AppContext";
import { makeAppContextStub } from "./appContextStub";
import { useReorderBasket } from "../hooks/useReorderBasket";
import type { ReorderSuggestionGroup } from "../utils/werkstattReorderApi";

vi.mock("../utils/werkstattReorderApi", () => ({
  listReorderSuggestions: vi.fn(),
  submitReorder: vi.fn(),
}));

import { listReorderSuggestions } from "../utils/werkstattReorderApi";

const listMock = vi.mocked(listReorderSuggestions);

interface Frame {
  loading: boolean;
  groupCount: number;
  loadError: string | null;
  lineCount: number;
}

/** `Array.prototype.at` is outside this project's lib target. */
function lastFrame(frames: Frame[]): Frame {
  const frame = frames[frames.length - 1];
  if (!frame) throw new Error("no frame was committed");
  return frame;
}

/** Records what the hook said on every commit — no DOM, no waiting. */
function Probe({ active, frames }: { active: boolean; frames: Frame[] }) {
  const basket = useReorderBasket(active);
  frames.push({
    loading: basket.loading,
    groupCount: basket.groups.length,
    loadError: basket.loadError,
    lineCount: basket.totals.lineCount,
  });
  return null;
}

function wrap(active: boolean, frames: Frame[]) {
  const context = makeAppContextStub({
    overrides: { mainView: "werkstatt", werkstattTab: "nachbestellen", language: "de", token: "t" },
  });
  return (
    <AppContext.Provider value={context as never}>
      <Probe active={active} frames={frames} />
    </AppContext.Provider>
  );
}

const GROUP: ReorderSuggestionGroup = {
  supplier_id: 7,
  supplier_name: "Unielektro Fulda GmbH",
  supplier_short_name: "Unielektro",
  default_lead_time_days: 2,
  subtotal_cents: 12000,
  currency: "EUR",
  lines: [
    {
      article_id: 101,
      article_number: "SP-1001",
      article_name: "NYM-J 5x6",
      image_url: null,
      stock_available: 0,
      stock_min: 50,
      suggested_quantity: 100,
      unit: "m",
      unit_price_cents: 120,
      line_total_cents: 12000,
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("useReorderBasket, frame by frame", () => {
  it("claims nothing while the tab opens and the request is still pending", async () => {
    let answer: (groups: ReorderSuggestionGroup[]) => void = () => undefined;
    listMock.mockImplementation(
      () =>
        new Promise<ReorderSuggestionGroup[]>((resolve) => {
          answer = resolve;
        }),
    );

    const frames: Frame[] = [];
    const { rerender } = render(wrap(false, frames));
    frames.length = 0; // only the frames of the visit itself matter

    // The buyer taps Werkstatt › Nachbestellen.
    rerender(wrap(true, frames));

    expect(frames.length).toBeGreaterThan(0);
    for (const frame of frames) {
      // "not loading, no error, no groups" is the page's reassuring empty
      // state — it may not appear before an answer has arrived.
      expect(frame).toMatchObject({ loading: true, groupCount: 0, lineCount: 0 });
      expect(frame.loadError).toBeNull();
    }

    await act(async () => {
      answer([GROUP]);
    });
    expect(lastFrame(frames)).toEqual({
      loading: false,
      groupCount: 1,
      loadError: null,
      lineCount: 1,
    });
  });

  it("does not present the previous visit's list as current on re-entry", async () => {
    listMock.mockResolvedValue([GROUP]);
    const frames: Frame[] = [];
    const { rerender } = render(wrap(true, frames));
    await act(async () => undefined);
    expect(lastFrame(frames).groupCount).toBe(1);

    // Off to another tab, and back — the effect re-fetches either way.
    rerender(wrap(false, frames));
    frames.length = 0;
    rerender(wrap(true, frames));

    // The list may be shown again once it has been re-read; until then the
    // screen says it is reading, never that the old numbers are today's.
    expect(frames.every((frame) => frame.loading)).toBe(true);
    await act(async () => undefined);
    expect(lastFrame(frames)).toMatchObject({ loading: false, groupCount: 1 });
  });

  it("shows the failure instead of an empty list, and stops claiming to load", async () => {
    listMock.mockRejectedValue(new Error("Verbindung unterbrochen"));
    const frames: Frame[] = [];
    render(wrap(true, frames));
    await act(async () => undefined);

    expect(lastFrame(frames)).toEqual({
      loading: false,
      groupCount: 0,
      loadError: "Verbindung unterbrochen",
      lineCount: 0,
    });
  });
});
