/**
 * The "Notizen" card of the customer page — the project's feed, moved.
 * What must hold: the card fetches the customer's first page on mount and
 * shows it newest first with author and time; posting sends the trimmed
 * body to POST /customers/{id}/notes and fetches the first page again;
 * Ctrl+Enter posts; an empty feed says so; the remove control shows only
 * on own notes or for a manager, and a confirmed click is a DELETE;
 * "Ältere anzeigen" appears only after a full page and fetches with
 * before_id; a failed first page is shown with a retry.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { AppContext } from "../context/AppContext";
import { makeAppContextStub } from "./appContextStub";
import { CustomerNotesCard } from "../components/customers/CustomerNotesCard";
import { CUSTOMER_NOTES_PAGE } from "../utils/customersApi";
import { apiFetch } from "../api/client";
import { formatServerDateTime } from "../utils/dates";
import type { CustomerNote } from "../types";

vi.mock("../api/client", () => ({ apiFetch: vi.fn() }));

const apiFetchMock = vi.mocked(apiFetch);

const CUSTOMER_ID = 7;
const TOKEN = "test-token";
const ME = { id: 1, email: "me@example.com", role: "employee", display_name: "Ich" };
const NOTES_PATH = `/customers/${CUSTOMER_ID}/notes`;
const FIRST_PAGE_PATH = `${NOTES_PATH}?limit=${CUSTOMER_NOTES_PAGE}`;

function note(
  id: number,
  body: string,
  author: { id: number | null; name: string | null },
  created_at: string,
): CustomerNote {
  return { id, customer_id: CUSTOMER_ID, author_user_id: author.id, author_name: author.name, body, created_at };
}

const ANNA = { id: 2, name: "Anna" };
const MINE = { id: ME.id, name: ME.display_name };
const NOBODY = { id: null, name: null };

const NEWER = note(12, "Zähler getauscht.\nRückruf am Montag.", ANNA, "2026-09-18T09:30:00");
const OLDER = note(11, "Ruft nur vormittags an.", NOBODY, "2026-09-01T08:00:00");

function fullPage(): CustomerNote[] {
  // ids 40 … 21: a page exactly as long as the server hands out.
  return Array.from({ length: CUSTOMER_NOTES_PAGE }, (_, index) =>
    note(40 - index, `Notiz ${40 - index}`, ANNA, `2026-09-${String(18 - Math.floor(index / 4)).padStart(2, "0")}T10:00:00`),
  );
}

type Routes = Record<string, () => unknown>;

function routeApi(routes: Routes) {
  apiFetchMock.mockImplementation((async (path: string) => {
    const route = routes[path];
    if (!route) throw new Error(`unexpected apiFetch: ${path}`);
    return route();
  }) as typeof apiFetch);
}

function callsTo(path: string): number {
  return apiFetchMock.mock.calls.filter(([calledPath]) => calledPath === path).length;
}

function renderCard(overrides: Record<string, unknown> = {}) {
  const spies = { setNotice: vi.fn(), setError: vi.fn() };
  const context = makeAppContextStub({
    overrides: { user: ME, canCreateProject: false, ...spies, ...overrides },
  });
  render(
    <AppContext.Provider value={context as never}>
      <CustomerNotesCard customerId={CUSTOMER_ID} />
    </AppContext.Provider>,
  );
  return spies;
}

/** The first page holds `notes`; posts and deletes are accepted. */
function feedOf(notes: () => CustomerNote[], extra: Routes = {}) {
  routeApi({
    [FIRST_PAGE_PATH]: notes,
    [NOTES_PATH]: () => ({ id: 99 }),
    ...extra,
  });
}

function composer(): HTMLTextAreaElement {
  return screen.getByRole("textbox", { name: "Neue Notiz" }) as HTMLTextAreaElement;
}

function rows(): HTMLElement[] {
  return screen.getAllByRole("listitem");
}

function heading(): HTMLElement {
  return screen.getByRole("heading", { level: 3, name: /^Notizen/ });
}

beforeEach(() => {
  apiFetchMock.mockReset();
  vi.restoreAllMocks();
});

describe("CustomerNotesCard", () => {
  it("fetches the first page and renders newest first with author and time, a dash where nobody signed", async () => {
    feedOf(() => [NEWER, OLDER]);
    renderCard();
    expect(screen.getByRole("status")).toHaveTextContent("Notizen werden geladen…");

    await screen.findByText(/Zähler getauscht/);
    expect(apiFetchMock).toHaveBeenCalledWith(FIRST_PAGE_PATH, TOKEN);
    expect(heading()).toHaveTextContent("2");
    const [first, second] = rows();
    expect(within(first).getByText("Anna")).toBeInTheDocument();
    expect(within(first).getByText(formatServerDateTime(NEWER.created_at, "de"))).toBeInTheDocument();
    expect(within(second).getByText("—")).toBeInTheDocument();
    expect(within(second).getByText("Ruft nur vormittags an.")).toBeInTheDocument();
    // Line breaks survive as typed: the body is rendered in one block, not split.
    expect(within(first).getByText(/Zähler getauscht/).textContent).toBe(NEWER.body);
  });

  it("shows the empty state when there are no notes", async () => {
    feedOf(() => []);
    renderCard();
    await screen.findByText("Noch keine Notizen — die erste hier posten.");
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Posten" })).toBeDisabled();
  });

  it("posts the trimmed body and fetches the first page again", async () => {
    let feed = [OLDER];
    feedOf(() => feed);
    const { setNotice } = renderCard();
    await screen.findByText("Ruft nur vormittags an.");

    fireEvent.change(composer(), { target: { value: "  Hallo Welt  \n" } });
    const post = screen.getByRole("button", { name: "Posten" });
    expect(post).toBeEnabled();
    feed = [note(13, "Hallo Welt", MINE, "2026-09-19T10:00:00"), OLDER];
    fireEvent.click(post);

    await screen.findByText("Hallo Welt");
    expect(apiFetchMock).toHaveBeenCalledWith(NOTES_PATH, TOKEN, {
      method: "POST",
      body: JSON.stringify({ body: "Hallo Welt" }),
    });
    expect(callsTo(FIRST_PAGE_PATH)).toBe(2);
    expect(setNotice).toHaveBeenCalledWith("Notiz gepostet");
    expect(composer().value).toBe("");
    expect(heading()).toHaveTextContent("2");
  });

  it("posts on Ctrl+Enter and on Cmd+Enter, never on a plain Enter", async () => {
    feedOf(() => []);
    renderCard();
    await screen.findByText("Noch keine Notizen — die erste hier posten.");

    fireEvent.change(composer(), { target: { value: "Kurz" } });
    fireEvent.keyDown(composer(), { key: "Enter" });
    expect(callsTo(NOTES_PATH)).toBe(0);

    fireEvent.keyDown(composer(), { key: "Enter", ctrlKey: true });
    await waitFor(() => expect(callsTo(NOTES_PATH)).toBe(1));
    expect(apiFetchMock).toHaveBeenCalledWith(NOTES_PATH, TOKEN, {
      method: "POST",
      body: JSON.stringify({ body: "Kurz" }),
    });

    fireEvent.change(composer(), { target: { value: "Nochmal" } });
    fireEvent.keyDown(composer(), { key: "Enter", metaKey: true });
    await waitFor(() => expect(callsTo(NOTES_PATH)).toBe(2));
  });

  it("keeps the text in the composer when the post fails", async () => {
    feedOf(() => [], {
      [NOTES_PATH]: () => {
        throw new Error("Customer access denied");
      },
    });
    const { setError } = renderCard();
    await screen.findByText("Noch keine Notizen — die erste hier posten.");

    fireEvent.change(composer(), { target: { value: "Bleibt stehen" } });
    fireEvent.click(screen.getByRole("button", { name: "Posten" }));

    await waitFor(() => expect(setError).toHaveBeenCalledWith("Customer access denied"));
    expect(composer().value).toBe("Bleibt stehen");
    expect(callsTo(FIRST_PAGE_PATH)).toBe(1);
  });

  it("offers removal only on own notes, or on every note for a manager", async () => {
    const theirs = note(13, "Fremde Notiz", ANNA, "2026-09-18T11:00:00");
    const mine = note(14, "Eigene Notiz", MINE, "2026-09-18T12:00:00");
    feedOf(() => [mine, theirs, OLDER]);
    renderCard();
    await screen.findByText("Eigene Notiz");

    const [mineRow, theirsRow, orphanRow] = rows();
    expect(within(mineRow).getByRole("button", { name: "Notiz löschen" })).toBeInTheDocument();
    expect(within(theirsRow).queryByRole("button", { name: "Notiz löschen" })).not.toBeInTheDocument();
    expect(within(orphanRow).queryByRole("button", { name: "Notiz löschen" })).not.toBeInTheDocument();
  });

  it("lets a manager remove any note, the orphaned first one included", async () => {
    const theirs = note(13, "Fremde Notiz", ANNA, "2026-09-18T11:00:00");
    feedOf(() => [theirs, OLDER]);
    renderCard({ canCreateProject: true });
    await screen.findByText("Fremde Notiz");
    expect(screen.getAllByRole("button", { name: "Notiz löschen" })).toHaveLength(2);
  });

  it("deletes after confirmation and fetches afresh; a cancelled confirm sends nothing", async () => {
    const mine = note(14, "Eigene Notiz", MINE, "2026-09-18T12:00:00");
    let feed = [mine, OLDER];
    feedOf(() => feed, { [`${NOTES_PATH}/14`]: () => undefined });
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    const { setNotice } = renderCard();
    await screen.findByText("Eigene Notiz");

    fireEvent.click(screen.getByRole("button", { name: "Notiz löschen" }));
    expect(confirmSpy).toHaveBeenCalledWith("Diese Notiz löschen?");
    expect(callsTo(`${NOTES_PATH}/14`)).toBe(0);

    confirmSpy.mockReturnValue(true);
    feed = [OLDER];
    fireEvent.click(screen.getByRole("button", { name: "Notiz löschen" }));
    await waitFor(() => expect(screen.queryByText("Eigene Notiz")).not.toBeInTheDocument());
    expect(apiFetchMock).toHaveBeenCalledWith(`${NOTES_PATH}/14`, TOKEN, { method: "DELETE" });
    expect(callsTo(FIRST_PAGE_PATH)).toBe(2);
    expect(setNotice).toHaveBeenCalledWith("Notiz gelöscht");
    expect(heading()).toHaveTextContent("1");
  });

  it("shows 'Ältere anzeigen' only after a full page and fetches with before_id", async () => {
    const olderPage = [
      note(20, "Notiz 20", ANNA, "2026-09-10T10:00:00"),
      note(19, "Notiz 19", ANNA, "2026-09-09T10:00:00"),
    ];
    feedOf(fullPage, { [`${FIRST_PAGE_PATH}&before_id=21`]: () => olderPage });
    renderCard();
    await screen.findByText("Notiz 40");

    expect(rows()).toHaveLength(CUSTOMER_NOTES_PAGE);
    expect(heading()).toHaveTextContent(`${CUSTOMER_NOTES_PAGE}+`);
    fireEvent.click(screen.getByRole("button", { name: "Ältere anzeigen" }));

    await waitFor(() => expect(rows()).toHaveLength(CUSTOMER_NOTES_PAGE + 2));
    expect(apiFetchMock).toHaveBeenCalledWith(`${FIRST_PAGE_PATH}&before_id=21`, TOKEN);
    expect(rows()[CUSTOMER_NOTES_PAGE + 1]).toHaveTextContent("Notiz 19");
    // The older page was short, so the feed is at its end.
    expect(screen.queryByRole("button", { name: "Ältere anzeigen" })).not.toBeInTheDocument();
    expect(heading()).toHaveTextContent(`${CUSTOMER_NOTES_PAGE + 2}`);
  });

  it("does not offer older notes when the first page was short", async () => {
    feedOf(() => [NEWER, OLDER]);
    renderCard();
    await screen.findByText(/Zähler getauscht/);
    expect(screen.queryByRole("button", { name: "Ältere anzeigen" })).not.toBeInTheDocument();
  });

  it("shows a failed first page in the API's words and fetches again on retry", async () => {
    let fails = true;
    feedOf(() => {
      if (fails) throw new Error("Nicht erreichbar");
      return [OLDER];
    });
    renderCard();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Notizen konnten nicht geladen werden.");
    expect(alert).toHaveTextContent("Nicht erreichbar");

    fails = false;
    fireEvent.click(within(alert).getByRole("button", { name: "Erneut versuchen" }));
    await screen.findByText("Ruft nur vormittags an.");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(callsTo(FIRST_PAGE_PATH)).toBe(2);
  });
});
