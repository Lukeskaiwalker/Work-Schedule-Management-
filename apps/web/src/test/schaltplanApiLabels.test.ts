/**
 * The label print request as it leaves the browser. The server reads a
 * missing `strip_ids` as "every strip" and `[]` as "none"; the Aderbeschriftung
 * (R4 §9.2) has its own target, and anything the hook does not name must
 * stay a BMK print rather than turn into one of the others.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { apiFetch } from "../api/client";
import { printPanelLabels } from "../utils/schaltplanApi";

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return { ...actual, apiFetch: vi.fn() };
});

const apiFetchMock = vi.mocked(apiFetch);

function sentBody(): unknown {
  const [, , init] = apiFetchMock.mock.calls[0] as [string, string | null, RequestInit];
  return JSON.parse(String(init.body));
}

describe("printPanelLabels", () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    apiFetchMock.mockResolvedValue({});
  });

  it("sends the Aderbeschriftung with its target, its one id and the tube", async () => {
    await printPanelLabels("t", 7, { target: "adern", stripIds: ["control:wires"], materialId: "wago-211-502" });
    expect(apiFetchMock.mock.calls[0][0]).toBe("/schaltplan/panels/7/labels");
    expect(sentBody()).toEqual({ target: "adern", strip_ids: ["control:wires"], material_id: "wago-211-502" });
  });

  it("sends the §14a strip among the Reihenklemmen strip ids", async () => {
    await printPanelLabels("t", 7, {
      target: "reihenklemmen",
      stripIds: ["f1:leiste", "control:block"],
      materialId: "wago-2009-110",
    });
    expect(sentBody()).toEqual({
      target: "reihenklemmen",
      strip_ids: ["f1:leiste", "control:block"],
      material_id: "wago-2009-110",
    });
  });

  it("keeps a BMK print a BMK print", async () => {
    await printPanelLabels("t", 7, { rowIds: ["r1"], materialId: "wago-2009-110" });
    expect(sentBody()).toEqual({ target: "bmk", row_ids: ["r1"], material_id: "wago-2009-110" });
  });
});
