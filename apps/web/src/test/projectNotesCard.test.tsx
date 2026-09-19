/**
 * The "Interne Notizen" card of the project overview. What must hold: the
 * feed shows newest first with author and time; posting sends the trimmed
 * body to POST /projects/{id}/notes and reloads the overview; Ctrl+Enter
 * posts; an empty feed says so; the remove control shows only on own notes
 * or for a manager, and a confirmed click is a DELETE; "Ältere anzeigen"
 * appears only after a full page and fetches with before_id.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { AppContext } from "../context/AppContext";
import { makeAppContextStub } from "./appContextStub";
import { NOTES_PAGE, ProjectNotesCard } from "../components/project/ProjectNotesCard";
import { apiFetch } from "../api/client";
import { formatServerDateTime } from "../utils/dates";
import type { ProjectNote } from "../types";

vi.mock("../api/client", () => ({ apiFetch: vi.fn() }));

const apiFetchMock = vi.mocked(apiFetch);

const PROJECT_ID = 42;
const TOKEN = "test-token";
const ME = { id: 1, email: "me@example.com", role: "employee", display_name: "Ich" };
const NOTES_PATH = `/projects/${PROJECT_ID}/notes`;

function note(
  id: number,
  body: string,
  author: { id: number | null; name: string | null },
  created_at: string,
): ProjectNote {
  return { id, project_id: PROJECT_ID, author_user_id: author.id, author_name: author.name, body, created_at };
}

const ANNA = { id: 2, name: "Anna" };
const MINE = { id: ME.id, name: ME.display_name };
const NOBODY = { id: null, name: null };

const NEWER = note(12, "Zähler getauscht.\nRückruf am Montag.", ANNA, "2026-09-18T09:30:00");
const OLDER = note(11, "Alte Notiz aus dem Textfeld", NOBODY, "2026-09-01T08:00:00");

function fullPage(): ProjectNote[] {
  // ids 40 … 21: a page exactly as long as the server hands out.
  return Array.from({ length: NOTES_PAGE }, (_, index) =>
    note(40 - index, `Notiz ${40 - index}`, ANNA, `2026-09-${String(18 - Math.floor(index / 4)).padStart(2, "0")}T10:00:00`),
  );
}

function renderCard(notes: ProjectNote[], overrides: Record<string, unknown> = {}) {
  const spies = {
    loadProjectOverview: vi.fn(async () => undefined),
    setNotice: vi.fn(),
    setError: vi.fn(),
  };
  const context = makeAppContextStub({
    overrides: {
      user: ME,
      activeProjectId: PROJECT_ID,
      projectOverviewDetails: { notes },
      canCreateProject: false,
      ...spies,
      ...overrides,
    },
  });
  render(
    <AppContext.Provider value={context as never}>
      <ProjectNotesCard />
    </AppContext.Provider>,
  );
  return spies;
}

function composer(): HTMLTextAreaElement {
  return screen.getByRole("textbox", { name: "Neue Notiz" }) as HTMLTextAreaElement;
}

function rows(): HTMLElement[] {
  return screen.getAllByRole("listitem");
}

beforeEach(() => {
  apiFetchMock.mockReset();
  apiFetchMock.mockResolvedValue(undefined as never);
  vi.restoreAllMocks();
});

describe("ProjectNotesCard", () => {
  it("renders newest first with author and time, and a dash where nobody signed", () => {
    renderCard([NEWER, OLDER]);

    expect(screen.getByRole("heading", { name: /Interne Notizen/ })).toHaveTextContent("2");
    const [first, second] = rows();
    expect(within(first).getByText("Anna")).toBeInTheDocument();
    expect(within(first).getByText(formatServerDateTime(NEWER.created_at, "de"))).toBeInTheDocument();
    expect(within(first).getByText(/Zähler getauscht/)).toBeInTheDocument();
    expect(within(second).getByText("—")).toBeInTheDocument();
    expect(within(second).getByText(formatServerDateTime(OLDER.created_at, "de"))).toBeInTheDocument();
    // Line breaks survive as typed: the body is rendered in one block, not split.
    expect(within(first).getByText(/Zähler getauscht/).textContent).toBe(NEWER.body);
  });

  it("shows the empty state when there are no notes", () => {
    renderCard([]);
    expect(screen.getByText("Noch keine Notizen — die erste hier posten.")).toBeInTheDocument();
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Posten" })).toBeDisabled();
  });

  it("posts the trimmed body and reloads the overview", async () => {
    const { loadProjectOverview, setNotice } = renderCard([OLDER]);

    fireEvent.change(composer(), { target: { value: "  Hallo Welt  \n" } });
    const post = screen.getByRole("button", { name: "Posten" });
    expect(post).toBeEnabled();
    fireEvent.click(post);

    await waitFor(() => expect(loadProjectOverview).toHaveBeenCalledWith(PROJECT_ID));
    expect(apiFetchMock).toHaveBeenCalledWith(NOTES_PATH, TOKEN, {
      method: "POST",
      body: JSON.stringify({ body: "Hallo Welt" }),
    });
    expect(setNotice).toHaveBeenCalledWith("Notiz gepostet");
    expect(composer().value).toBe("");
  });

  it("posts on Ctrl+Enter and on Cmd+Enter, never on a plain Enter", async () => {
    const { loadProjectOverview } = renderCard([]);

    fireEvent.change(composer(), { target: { value: "Kurz" } });
    fireEvent.keyDown(composer(), { key: "Enter" });
    expect(apiFetchMock).not.toHaveBeenCalled();

    fireEvent.keyDown(composer(), { key: "Enter", ctrlKey: true });
    await waitFor(() => expect(loadProjectOverview).toHaveBeenCalledTimes(1));
    expect(apiFetchMock).toHaveBeenLastCalledWith(NOTES_PATH, TOKEN, {
      method: "POST",
      body: JSON.stringify({ body: "Kurz" }),
    });

    fireEvent.change(composer(), { target: { value: "Nochmal" } });
    fireEvent.keyDown(composer(), { key: "Enter", metaKey: true });
    await waitFor(() => expect(loadProjectOverview).toHaveBeenCalledTimes(2));
  });

  it("keeps the text in the composer when the post fails", async () => {
    apiFetchMock.mockRejectedValueOnce(new Error("Project access denied"));
    const { loadProjectOverview, setError } = renderCard([]);

    fireEvent.change(composer(), { target: { value: "Bleibt stehen" } });
    fireEvent.click(screen.getByRole("button", { name: "Posten" }));

    await waitFor(() => expect(setError).toHaveBeenCalledWith("Project access denied"));
    expect(composer().value).toBe("Bleibt stehen");
    expect(loadProjectOverview).not.toHaveBeenCalled();
  });

  it("offers removal only on own notes, or on every note for a manager", () => {
    const theirs = note(13, "Fremde Notiz", ANNA, "2026-09-18T11:00:00");
    const mine = note(14, "Eigene Notiz", MINE, "2026-09-18T12:00:00");

    renderCard([mine, theirs, OLDER]);
    const [mineRow, theirsRow, orphanRow] = rows();
    expect(within(mineRow).getByRole("button", { name: "Notiz löschen" })).toBeInTheDocument();
    expect(within(theirsRow).queryByRole("button", { name: "Notiz löschen" })).not.toBeInTheDocument();
    expect(within(orphanRow).queryByRole("button", { name: "Notiz löschen" })).not.toBeInTheDocument();
  });

  it("lets a manager remove any note, the orphaned first one included", () => {
    const theirs = note(13, "Fremde Notiz", ANNA, "2026-09-18T11:00:00");
    renderCard([theirs, OLDER], { canCreateProject: true });
    expect(screen.getAllByRole("button", { name: "Notiz löschen" })).toHaveLength(2);
  });

  it("deletes after confirmation and reloads; a cancelled confirm sends nothing", async () => {
    const mine = note(14, "Eigene Notiz", MINE, "2026-09-18T12:00:00");
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    const { loadProjectOverview, setNotice } = renderCard([mine]);

    fireEvent.click(screen.getByRole("button", { name: "Notiz löschen" }));
    expect(confirmSpy).toHaveBeenCalledWith("Diese Notiz löschen?");
    expect(apiFetchMock).not.toHaveBeenCalled();

    confirmSpy.mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: "Notiz löschen" }));
    await waitFor(() => expect(loadProjectOverview).toHaveBeenCalledWith(PROJECT_ID));
    expect(apiFetchMock).toHaveBeenCalledWith(`${NOTES_PATH}/14`, TOKEN, { method: "DELETE" });
    expect(setNotice).toHaveBeenCalledWith("Notiz gelöscht");
  });

  it("shows 'Ältere anzeigen' only after a full page and fetches with before_id", async () => {
    const page = fullPage();
    const olderPage = [
      note(20, "Notiz 20", ANNA, "2026-09-10T10:00:00"),
      note(19, "Notiz 19", ANNA, "2026-09-09T10:00:00"),
    ];
    apiFetchMock.mockResolvedValueOnce(olderPage as never);
    renderCard(page);

    expect(rows()).toHaveLength(NOTES_PAGE);
    expect(screen.getByRole("heading", { name: /Interne Notizen/ })).toHaveTextContent(`${NOTES_PAGE}+`);
    fireEvent.click(screen.getByRole("button", { name: "Ältere anzeigen" }));

    await waitFor(() => expect(rows()).toHaveLength(NOTES_PAGE + 2));
    expect(apiFetchMock).toHaveBeenCalledWith(`${NOTES_PATH}?limit=${NOTES_PAGE}&before_id=21`, TOKEN);
    expect(rows()[NOTES_PAGE + 1]).toHaveTextContent("Notiz 19");
    // The older page was short, so the feed is at its end.
    expect(screen.queryByRole("button", { name: "Ältere anzeigen" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /Interne Notizen/ })).toHaveTextContent(`${NOTES_PAGE + 2}`);
  });

  it("does not offer older notes when the first page was short", () => {
    renderCard([NEWER, OLDER]);
    expect(screen.queryByRole("button", { name: "Ältere anzeigen" })).not.toBeInTheDocument();
  });
});
