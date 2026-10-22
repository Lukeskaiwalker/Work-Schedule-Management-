/**
 * The session-cached cabinet catalogue (docs/PANEL_ENCLOSURE.md §10.2):
 * one request per login however many boards mount it, StrictMode included;
 * `reload()` fetches again; a failed reload keeps what was there (an empty
 * picker would read as "no such module"); signed out fetches nothing.
 */
import { StrictMode, type ReactNode } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../utils/schaltplanEnclosureApi", () => ({ getEnclosureCatalog: vi.fn() }));

import { resetEnclosureCatalogCache, useEnclosureCatalog } from "../hooks/useEnclosureCatalog";
import { getEnclosureCatalog } from "../utils/schaltplanEnclosureApi";
import { testCatalog } from "./enclosureTestCatalog";

const fetchMock = vi.mocked(getEnclosureCatalog);
const strict = ({ children }: { children: ReactNode }) => <StrictMode>{children}</StrictMode>;

beforeEach(() => {
  resetEnclosureCatalogCache();
  fetchMock.mockReset();
});

describe("useEnclosureCatalog", () => {
  it("loads once, shares the answer and builds the index", async () => {
    fetchMock.mockResolvedValue(testCatalog());
    const first = renderHook(() => useEnclosureCatalog("t"), { wrapper: strict });
    expect(first.result.current.loading).toBe(true);
    await waitFor(() => expect(first.result.current.loading).toBe(false));
    expect(first.result.current.index?.module("ZU37KS")?.code).toBe("ZU37KS");
    const second = renderHook(() => useEnclosureCatalog("t"));
    expect(second.result.current.loading).toBe(false);
    expect(second.result.current.catalog).toBe(first.result.current.catalog);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reload fetches again and a failed reload keeps the catalogue", async () => {
    const catalog = testCatalog();
    fetchMock.mockResolvedValueOnce(catalog).mockRejectedValueOnce(new Error("Netzwerkfehler"));
    const { result } = renderHook(() => useEnclosureCatalog("t"));
    await waitFor(() => expect(result.current.catalog).toBe(catalog));
    await act(() => result.current.reload());
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.current.catalog).toBe(catalog);
    expect(result.current.error).toBe("Netzwerkfehler");
    expect(result.current.loading).toBe(false);
  });

  it("fetches nothing while signed out and again for another login", async () => {
    fetchMock.mockResolvedValue(testCatalog());
    const { result, rerender } = renderHook(({ token }) => useEnclosureCatalog(token), { initialProps: { token: null as string | null } });
    expect(result.current).toMatchObject({ catalog: null, index: null, loading: false });
    expect(fetchMock).not.toHaveBeenCalled();
    rerender({ token: "a" });
    await waitFor(() => expect(result.current.catalog).not.toBeNull());
    rerender({ token: "b" });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock.mock.calls.map(([token]) => token)).toEqual(["a", "b"]);
  });
});
