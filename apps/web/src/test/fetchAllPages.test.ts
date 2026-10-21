/**
 * The page loop under the customer list, on its own.
 *
 * Its one job is to return either the complete list or nothing: a list that
 * silently stops early is exactly how 22 customers disappeared from every
 * picker. So the ceiling throws, and a failure on any page propagates.
 */
import { describe, expect, it, vi } from "vitest";

import { fetchAllPages } from "../utils/fetchAllPages";

type Row = { id: number };

function rows(from: number, count: number): Row[] {
  return Array.from({ length: count }, (_, index) => ({ id: from + index }));
}

describe("fetchAllPages", () => {
  it("walks the offsets until a short page", async () => {
    const fetchPage = vi.fn(async (offset: number, limit: number) => rows(offset, offset < 4 ? limit : 1));

    const result = await fetchAllPages(fetchPage, { pageSize: 2, maxPages: 10 });

    expect(result.map((row) => row.id)).toEqual([0, 1, 2, 3, 4]);
    expect(fetchPage.mock.calls).toEqual([
      [0, 2],
      [2, 2],
      [4, 2],
    ]);
  });

  it("throws at the ceiling instead of returning what it has so far", async () => {
    const fetchPage = vi.fn(async (offset: number, limit: number) => rows(offset, limit));

    await expect(fetchAllPages(fetchPage, { pageSize: 2, maxPages: 3 })).rejects.toThrow(/nicht vollständig/);
    expect(fetchPage).toHaveBeenCalledTimes(3);
  });

  it("passes a failing page on", async () => {
    const fetchPage = vi
      .fn()
      .mockResolvedValueOnce(rows(0, 2))
      .mockRejectedValueOnce(new Error("Bad Gateway"));

    await expect(fetchAllPages(fetchPage, { pageSize: 2, maxPages: 10 })).rejects.toThrow("Bad Gateway");
  });

  it("keeps the first copy of a row that two pages both carry", async () => {
    const fetchPage = vi
      .fn()
      .mockResolvedValueOnce([{ id: 1 }, { id: 2 }])
      .mockResolvedValueOnce([{ id: 2 }, { id: 3 }])
      .mockResolvedValueOnce([]);

    const result = await fetchAllPages<Row>(fetchPage, { pageSize: 2, maxPages: 10 });

    expect(result).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
  });
});
