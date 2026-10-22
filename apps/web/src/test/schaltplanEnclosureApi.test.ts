/**
 * The cabinet API calls (docs/PANEL_ENCLOSURE.md §7, §10.2): paths, methods
 * and bodies, and that the PDF is a cookie URL without a token in it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../api/client", () => ({ API_BASE: "/api", apiFetch: vi.fn() }));

import { apiFetch } from "../api/client";
import {
  aufbauPdfUrl,
  createCatalogEntry,
  getEnclosureCatalog,
  resetCatalogEntry,
  salvagePanelMaterial,
  setCatalogEntryArchived,
  unsalvagePanelMaterial,
  updateCatalogEntry,
} from "../utils/schaltplanEnclosureApi";
import type { CatalogEntryIn } from "../types/panelEnclosure";
import { MODULES } from "./enclosureTestCatalog";

const fetchMock = vi.mocked(apiFetch);

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({});
});

const body: CatalogEntryIn = { entry_type: "module", spec: MODULES.ZU37KS };

function call(index = 0) {
  const [path, token, init] = fetchMock.mock.calls[index];
  return { path, token, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined };
}

describe("schaltplanEnclosureApi", () => {
  it("reads the catalogue", async () => {
    await getEnclosureCatalog("t");
    expect(call()).toEqual({ path: "/schaltplan/enclosure-catalog", token: "t", method: "GET", body: undefined });
  });

  it("creates, updates, archives and resets entries by normalised code", async () => {
    await createCatalogEntry("t", body);
    await updateCatalogEntry("t", " zu37ks ", body);
    await setCatalogEntryArchived("t", "ZU37KS", true);
    await resetCatalogEntry("t", "ZU37KS");
    expect(call(0)).toMatchObject({ path: "/schaltplan/enclosure-catalog", method: "POST", body });
    expect(call(1)).toMatchObject({ path: "/schaltplan/enclosure-catalog/ZU37KS", method: "PUT", body });
    expect(call(2)).toMatchObject({ path: "/schaltplan/enclosure-catalog/ZU37KS", method: "PATCH", body: { archived: true } });
    expect(call(3)).toMatchObject({ path: "/schaltplan/enclosure-catalog/ZU37KS/override", method: "DELETE" });
  });

  it("escapes a code that is not URL-safe", async () => {
    await resetCatalogEntry("t", "A/B");
    expect(call().path).toBe("/schaltplan/enclosure-catalog/A%2FB/override");
  });

  it("books returns in and takes them back, one piece by default", async () => {
    await salvagePanelMaterial("t", 7, 218);
    await unsalvagePanelMaterial("t", 7, 218, 2);
    expect(call(0)).toEqual({ path: "/schaltplan/panels/7/material/salvage", token: "t", method: "POST", body: { article_id: 218, quantity: 1 } });
    expect(call(1)).toEqual({ path: "/schaltplan/panels/7/material/unsalvage", token: "t", method: "POST", body: { article_id: 218, quantity: 2 } });
  });

  it("points the Aufbau PDF at the cookie-authenticated route", () => {
    expect(aufbauPdfUrl(12)).toBe("/api/schaltplan/panels/12/aufbau/pdf");
  });
});
