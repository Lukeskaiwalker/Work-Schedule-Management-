/**
 * The Protokoll tab asks the server for what it shows.
 *
 * Found in production on 2026-10-20: the tab loaded the newest 300 audit rows
 * once and filtered THOSE by period, category and text in the browser. With
 * 1292 rows in the last 90 days the newest 300 reached back only to
 * 2026-10-05, so "Letzte 90 Tage" silently showed less than a fortnight.
 *
 * What must hold:
 *  - the period, category and search text go to GET /admin/audit-logs, and
 *    the rows that come back are shown as they are — no second filter here;
 *  - the tab asks for one row more than it shows, and when that row exists it
 *    says the list is cut off and offers "Ältere anzeigen", which pages back
 *    by before_id with the same filters;
 *  - the category menu lists the whole log's categories, from the server;
 *  - a failed load says so instead of looking like an empty log;
 *  - an older answer never paints over a newer one;
 *  - times are the server's UTC, shown in local time;
 *  - the CSV export gets the same bounds and search text as the list.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { AppContext } from "../context/AppContext";
import { makeAppContextStub } from "./appContextStub";
import { AdminPage } from "../pages/AdminPage";
import { ApiError, apiFetch } from "../api/client";
import type { AuditLogEntry } from "../types";

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return { ...actual, apiFetch: vi.fn() };
});

const apiFetchMock = vi.mocked(apiFetch);

function entry(id: number, overrides: Partial<AuditLogEntry> = {}): AuditLogEntry {
  return {
    id,
    actor_user_id: null,
    category: "projects",
    action: "project.status_changed",
    target_type: "project",
    target_id: "2026-0001",
    details: null,
    created_at: "2026-10-09T14:05:00",
    ...overrides,
  };
}

/** `count` rows, newest first, ids counting down from `topId`. */
function page(count: number, topId: number): AuditLogEntry[] {
  return Array.from({ length: count }, (_, i) => entry(topId - i));
}

type ListAnswer = (params: URLSearchParams) => AuditLogEntry[] | Promise<AuditLogEntry[]>;

function serve(list: ListAnswer, categories: () => string[] = () => ["projects"]) {
  apiFetchMock.mockImplementation((async (path: string) => {
    const url = new URL(path, "http://smpl.test");
    if (url.pathname === "/admin/audit-logs/categories") return categories();
    if (url.pathname === "/admin/audit-logs") return list(url.searchParams);
    throw new Error(`unexpected request ${path}`);
  }) as never);
}

/** The query of every list request, in order. */
function listRequests(): URLSearchParams[] {
  return apiFetchMock.mock.calls
    .map(([path]) => new URL(String(path), "http://smpl.test"))
    .filter((url) => url.pathname === "/admin/audit-logs")
    .map((url) => url.searchParams);
}

function lastListRequest(): URLSearchParams | undefined {
  const requests = listRequests();
  return requests[requests.length - 1];
}

function renderProtokoll(overrides: Record<string, unknown> = {}) {
  const value = makeAppContextStub({
    overrides: {
      mainView: "admin",
      token: "test-token",
      language: "de",
      canViewAudit: true,
      activeAdminUsers: [],
      archivedAdminUsers: [],
      adminUsersById: new Map(),
      userPermissionOverrides: {},
      requiredHoursDrafts: {},
      vacationBalanceDrafts: {},
      ...overrides,
    },
  });
  return render(
    <AppContext.Provider value={value as never}>
      <AdminPage />
    </AppContext.Provider>,
  );
}

function rowCount(container: HTMLElement): number {
  return container.querySelectorAll(".admin-audit-row").length;
}

afterEach(() => {
  vi.useRealTimers();
  apiFetchMock.mockReset();
});

describe("Protokoll filters run on the server", () => {
  it("sends Letzte 90 Tage as a date range, asking for one row more than a page", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 9, 20, 10, 0, 0));
    serve(() => [entry(1)]);
    renderProtokoll();

    await waitFor(() => expect(listRequests()).toHaveLength(1));
    const first = listRequests()[0];
    expect(first.get("from")).toBeNull();
    expect(first.get("to")).toBeNull();
    expect(first.get("limit")).toBe("301");

    fireEvent.change(screen.getByDisplayValue("Gesamter Zeitraum"), { target: { value: "90d" } });

    await waitFor(() => expect(listRequests()).toHaveLength(2));
    const ninety = listRequests()[1];
    // Today and the 89 days before it, local midnight to local end of day.
    expect(ninety.get("from")).toBe(new Date(2026, 6, 23, 0, 0, 0, 0).toISOString());
    expect(ninety.get("to")).toBe(new Date(2026, 9, 20, 23, 59, 59, 999).toISOString());
    expect(ninety.get("limit")).toBe("301");
    expect(ninety.get("before_id")).toBeNull();
  });

  it("sends the category, the search text and a custom range, and shows the answer unfiltered", async () => {
    serve(
      // The server matched this row by its actor's name: the action does not
      // contain the search text, and it must be shown anyway.
      (params) => (params.get("q") ? [entry(9, { category: "wiki", action: "wiki.page_edit" })] : [entry(1)]),
      () => ["projects", "wiki"],
    );
    const { container } = renderProtokoll();
    await screen.findByRole("option", { name: "Wiki" });

    fireEvent.change(screen.getByDisplayValue("Alle Kategorien"), { target: { value: "wiki" } });
    fireEvent.change(screen.getByDisplayValue("Gesamter Zeitraum"), { target: { value: "custom" } });
    fireEvent.change(screen.getByLabelText("Von"), { target: { value: "2026-03-01" } });
    fireEvent.change(screen.getByLabelText("Bis"), { target: { value: "2026-03-31" } });
    fireEvent.change(screen.getByPlaceholderText("Ereignisse suchen…"), { target: { value: "Jana" } });

    await waitFor(() => expect(lastListRequest()?.get("q")).toBe("Jana"));
    const last = lastListRequest()!;
    expect(last.getAll("category")).toEqual(["wiki"]);
    expect(last.get("from")).toBe(new Date(2026, 2, 1, 0, 0, 0, 0).toISOString());
    expect(last.get("to")).toBe(new Date(2026, 2, 31, 23, 59, 59, 999).toISOString());

    await screen.findByText("wiki.page_edit");
    expect(rowCount(container)).toBe(1);
  });

  it("lists the whole log's categories, not only those on the loaded page", async () => {
    serve(() => [entry(1, { category: "projects" })], () => ["auth", "projects", "wiki"]);
    renderProtokoll();

    expect(await screen.findByRole("option", { name: "Wiki" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Anmeldung" })).toBeInTheDocument();
  });
});

describe("Protokoll paging", () => {
  it("says when the page is cut off and pages back by before_id with the same filters", async () => {
    serve((params) => (params.get("before_id") === "701" ? page(20, 700) : page(301, 1000)));
    const { container } = renderProtokoll();

    expect(await screen.findByText("300 Einträge angezeigt – ältere sind noch nicht geladen.")).toBeInTheDocument();
    expect(rowCount(container)).toBe(300);

    fireEvent.click(screen.getByRole("button", { name: "Ältere anzeigen" }));

    await waitFor(() => expect(rowCount(container)).toBe(320));
    const older = lastListRequest()!;
    // The cursor is the last row SHOWN, not the extra row that only said "more".
    expect(older.get("before_id")).toBe("701");
    expect(older.get("limit")).toBe("301");
    expect(screen.queryByText(/ältere sind noch nicht geladen/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Ältere anzeigen" })).not.toBeInTheDocument();
  });

  it("shows no note when everything fits on the page", async () => {
    serve(() => page(300, 1000));
    const { container } = renderProtokoll();

    await waitFor(() => expect(rowCount(container)).toBe(300));
    expect(screen.queryByText(/ältere sind noch nicht geladen/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Ältere anzeigen" })).not.toBeInTheDocument();
  });

  it("an older answer never paints over a newer one", async () => {
    let releaseFirst: (rows: AuditLogEntry[]) => void = () => undefined;
    serve((params) => {
      if (!params.get("from")) return new Promise<AuditLogEntry[]>((resolve) => (releaseFirst = resolve));
      return [entry(5, { action: "project.newer_answer" })];
    });
    renderProtokoll();
    await waitFor(() => expect(listRequests()).toHaveLength(1));

    fireEvent.change(screen.getByDisplayValue("Gesamter Zeitraum"), { target: { value: "7d" } });
    await screen.findByText("project.newer_answer");

    releaseFirst([entry(1, { action: "project.stale_answer" })]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByText("project.stale_answer")).not.toBeInTheDocument();
    expect(screen.getByText("project.newer_answer")).toBeInTheDocument();
  });
});

describe("Protokoll rows and errors", () => {
  it("says so when the log cannot be loaded, instead of looking empty", async () => {
    serve(() => {
      throw new ApiError("Keine Berechtigung", 403);
    });
    renderProtokoll();

    expect(await screen.findByText("Protokoll konnte nicht geladen werden: Keine Berechtigung")).toBeInTheDocument();
    expect(screen.queryByText("Keine Einträge gefunden.")).not.toBeInTheDocument();
  });

  it("shows the server's UTC time in local time", async () => {
    serve(() => [entry(1, { created_at: "2026-10-09T14:05:00" })]);
    renderProtokoll();

    const local = new Date(Date.UTC(2026, 9, 9, 14, 5)).toLocaleString("en-GB", {
      dateStyle: "short",
      timeStyle: "short",
    });
    expect(await screen.findByText(local)).toBeInTheDocument();
  });

  it("exports with the same bounds and search text the list was asked for", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 9, 20, 10, 0, 0));
    serve(() => [entry(1)]);
    const exportAuditLogsCsv = vi.fn();
    renderProtokoll({ exportAuditLogsCsv });

    fireEvent.change(screen.getByDisplayValue("Gesamter Zeitraum"), { target: { value: "7d" } });
    fireEvent.change(screen.getByPlaceholderText("Ereignisse suchen…"), { target: { value: " backup " } });
    fireEvent.click(screen.getByRole("button", { name: "CSV exportieren" }));

    expect(exportAuditLogsCsv).toHaveBeenCalledWith({
      fromIso: new Date(2026, 9, 14, 0, 0, 0, 0).toISOString(),
      toIso: new Date(2026, 9, 20, 23, 59, 59, 999).toISOString(),
      categories: undefined,
      query: "backup",
    });
  });
});
