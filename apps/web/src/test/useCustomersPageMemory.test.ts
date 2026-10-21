/**
 * The Kunden page's memory in App: kept across navigation, gone with the user.
 *
 * It holds a search somebody typed and the customer rows that answered it.
 * Both belong to the person who is signed in: after a sign-out the next person
 * at the same browser (a shared office PC) must not open the Kunden page onto
 * somebody else's search and its results.
 */
import { describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";

import { useCustomersPageMemory } from "../hooks/useCustomersPageMemory";
import { customerRow } from "./fixtures/customerServer";

const ANSWER = { query: "Muster", filter: "all" as const, rows: [customerRow(1, "Mustermann, Erika")] };

function remember(result: { current: ReturnType<typeof useCustomersPageMemory> }) {
  act(() => {
    result.current.setCustomersSearch("Muster");
    result.current.setCustomersArchiveFilter("all");
    result.current.customersSearchCache.write(ANSWER);
  });
}

describe("useCustomersPageMemory", () => {
  it("starts empty: no search, active customers, no remembered answer", () => {
    const { result } = renderHook(() => useCustomersPageMemory(1));
    expect(result.current.customersSearch).toBe("");
    expect(result.current.customersArchiveFilter).toBe("active");
    expect(result.current.customersSearchCache.read()).toBeNull();
  });

  it("keeps the search, the filter and the answer while the same user stays signed in", () => {
    const { result, rerender } = renderHook(({ userId }) => useCustomersPageMemory(userId), {
      initialProps: { userId: 1 as number | null },
    });
    const cache = result.current.customersSearchCache;
    remember(result);
    rerender({ userId: 1 });

    expect(result.current.customersSearch).toBe("Muster");
    expect(result.current.customersArchiveFilter).toBe("all");
    // One cache for the session: the page reads it on mount, a new one each render would always be empty.
    expect(result.current.customersSearchCache).toBe(cache);
    expect(cache.read()).toEqual(ANSWER);
  });

  it("forgets all of it on sign-out", () => {
    const { result, rerender } = renderHook(({ userId }) => useCustomersPageMemory(userId), {
      initialProps: { userId: 1 as number | null },
    });
    remember(result);
    rerender({ userId: null });

    expect(result.current.customersSearch).toBe("");
    expect(result.current.customersArchiveFilter).toBe("active");
    expect(result.current.customersSearchCache.read()).toBeNull();
  });

  it("forgets all of it when another user takes over", () => {
    const { result, rerender } = renderHook(({ userId }) => useCustomersPageMemory(userId), {
      initialProps: { userId: 1 as number | null },
    });
    remember(result);
    rerender({ userId: 2 });

    expect(result.current.customersSearch).toBe("");
    expect(result.current.customersArchiveFilter).toBe("active");
    expect(result.current.customersSearchCache.read()).toBeNull();
  });
});
