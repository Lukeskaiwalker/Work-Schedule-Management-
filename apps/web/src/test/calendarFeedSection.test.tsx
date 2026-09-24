/**
 * The "Kalender-Abo" card on the profile page.
 *
 * What must hold: the card asks the API for the user's subscription on
 * mount; without one it explains the feature and "Kalender-Abo einrichten"
 * creates it; with one it shows the webcal link as a button, the https link
 * in a copyable field, when a calendar app last fetched it (with a friendly
 * name for the app) and how often; "Link neu erzeugen" asks first and then
 * rotates; "Abo entfernen" asks first, deletes and falls back to the empty
 * state; a failed first load is shown with a retry.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AppContext } from "../context/AppContext";
import { makeAppContextStub } from "./appContextStub";
import { CalendarFeedSection } from "../components/profile/CalendarFeedSection";
import { friendlyFetchAgent } from "../components/profile/calendarFeedText";
import {
  createCalendarFeed,
  deleteCalendarFeed,
  getCalendarFeed,
  type CalendarFeed,
} from "../utils/calendarFeedApi";

vi.mock("../utils/calendarFeedApi", () => ({
  getCalendarFeed: vi.fn(),
  createCalendarFeed: vi.fn(),
  deleteCalendarFeed: vi.fn(),
}));

const getMock = vi.mocked(getCalendarFeed);
const createMock = vi.mocked(createCalendarFeed);
const deleteMock = vi.mocked(deleteCalendarFeed);

const TOKEN = "test-token";
const HTTPS_URL = "https://smpl.example/api/calendar/smpl_cal_abc/feed.ics";
const WEBCAL_URL = "webcal://smpl.example/api/calendar/smpl_cal_abc/feed.ics";

const FEED: CalendarFeed = {
  url: HTTPS_URL,
  webcal_url: WEBCAL_URL,
  created_at: "2026-09-24T18:00:00",
  last_fetched_at: "2026-09-24T18:31:00",
  last_fetch_agent: "iOS/26.0 (24A123) dataaccessd/1.0",
  fetch_count: 12,
};

const ROTATED: CalendarFeed = {
  ...FEED,
  url: "https://smpl.example/api/calendar/smpl_cal_new/feed.ics",
  webcal_url: "webcal://smpl.example/api/calendar/smpl_cal_new/feed.ics",
  last_fetched_at: null,
  last_fetch_agent: null,
  fetch_count: 0,
};

function renderCard() {
  const spies = { setNotice: vi.fn(), setError: vi.fn() };
  const context = makeAppContextStub({ overrides: { token: TOKEN, ...spies } });
  render(
    <AppContext.Provider value={context as never}>
      <CalendarFeedSection />
    </AppContext.Provider>,
  );
  return spies;
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function linkField(): HTMLInputElement {
  return screen.getByLabelText("Abo-Link (https)") as HTMLInputElement;
}

describe("CalendarFeedSection", () => {
  beforeEach(() => {
    getMock.mockReset();
    createMock.mockReset();
    deleteMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    Reflect.deleteProperty(navigator, "clipboard");
  });

  it("explains the feature without a subscription and creates one from the button", async () => {
    getMock.mockResolvedValue(null);
    createMock.mockResolvedValue(FEED);
    renderCard();

    expect(await screen.findByText(/Deine Aufgaben, Urlaub und Berufsschule als Abo-Kalender/)).toBeInTheDocument();
    expect(screen.getByText(/nichts muss von Hand eingetragen werden/)).toBeInTheDocument();
    expect(getMock).toHaveBeenCalledWith(TOKEN);
    expect(screen.queryByRole("link", { name: "Im Kalender öffnen" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Kalender-Abo einrichten" }));
    expect(createMock).toHaveBeenCalledWith(TOKEN);

    expect(await screen.findByRole("link", { name: "Im Kalender öffnen" })).toHaveAttribute("href", WEBCAL_URL);
    expect(screen.queryByRole("button", { name: "Kalender-Abo einrichten" })).not.toBeInTheDocument();
  });

  it("shows the links, the last fetch with a friendly app name and the fetch count", async () => {
    getMock.mockResolvedValue(FEED);
    renderCard();

    expect(await screen.findByRole("link", { name: "Im Kalender öffnen" })).toHaveAttribute("href", WEBCAL_URL);
    expect(linkField().value).toBe(HTTPS_URL);
    expect(linkField()).toHaveAttribute("readonly");

    const status = screen.getByText(/Zuletzt abgerufen/);
    expect(status.textContent).toMatch(
      /^Zuletzt abgerufen: \d{2}\.\d{2}\.2026, \d{2}:\d{2} · iPhone\/iPad-Kalender · 12 Abrufe$/,
    );
    expect(screen.getByRole("heading", { name: "Kalender-Abo" })).toBeInTheDocument();
    expect(screen.getByText(/Wer ihn hat, sieht deine Termine — nicht weitergeben\./)).toBeInTheDocument();
  });

  it("says so when no calendar app has fetched the link yet", async () => {
    getMock.mockResolvedValue({ ...FEED, last_fetched_at: null, last_fetch_agent: null, fetch_count: 0 });
    renderCard();

    expect(await screen.findByText("Noch nicht abgerufen — den Link im Kalender eintragen.")).toBeInTheDocument();
    expect(screen.queryByText(/Abrufe/)).not.toBeInTheDocument();
  });

  it("counts a single fetch in the singular", async () => {
    getMock.mockResolvedValue({ ...FEED, fetch_count: 1 });
    renderCard();

    expect((await screen.findByText(/Zuletzt abgerufen/)).textContent).toMatch(/· 1 Abruf$/);
  });

  it("offers the three how-tos behind a collapsed summary", async () => {
    getMock.mockResolvedValue(FEED);
    renderCard();
    await screen.findByRole("link", { name: "Im Kalender öffnen" });

    const details = screen.getByText("So richtest du es ein").closest("details");
    expect(details).not.toBeNull();
    expect(details).not.toHaveAttribute("open");
    expect(screen.getByText("iPhone / iPad")).toBeInTheDocument();
    expect(screen.getByText("Google Kalender")).toBeInTheDocument();
    expect(screen.getByText("Outlook")).toBeInTheDocument();
    expect(screen.getByText(/etwa alle 12–24 Stunden/)).toBeInTheDocument();
  });

  it("rotates the link only after the user confirmed, then shows the new one", async () => {
    getMock.mockResolvedValue(FEED);
    createMock.mockResolvedValue(ROTATED);
    const confirmSpy = vi.fn<(message?: string) => boolean>(() => false);
    vi.stubGlobal("confirm", confirmSpy);
    renderCard();
    await screen.findByRole("link", { name: "Im Kalender öffnen" });

    fireEvent.click(screen.getByRole("button", { name: "Link neu erzeugen" }));
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(String(confirmSpy.mock.calls[0]?.[0])).toMatch(/bisherige Link/);
    expect(createMock).not.toHaveBeenCalled();
    expect(linkField().value).toBe(HTTPS_URL);

    confirmSpy.mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: "Link neu erzeugen" }));
    expect(createMock).toHaveBeenCalledWith(TOKEN);

    await waitFor(() => expect(linkField().value).toBe(ROTATED.url));
    expect(screen.getByRole("link", { name: "Im Kalender öffnen" })).toHaveAttribute("href", ROTATED.webcal_url);
    expect(screen.getByText("Noch nicht abgerufen — den Link im Kalender eintragen.")).toBeInTheDocument();
  });

  it("removes the subscription after confirmation and returns to the empty state", async () => {
    getMock.mockResolvedValue(FEED);
    deleteMock.mockResolvedValue(undefined);
    const confirmSpy = vi.fn<(message?: string) => boolean>(() => false);
    vi.stubGlobal("confirm", confirmSpy);
    renderCard();
    await screen.findByRole("link", { name: "Im Kalender öffnen" });

    fireEvent.click(screen.getByRole("button", { name: "Abo entfernen" }));
    expect(deleteMock).not.toHaveBeenCalled();

    confirmSpy.mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: "Abo entfernen" }));
    expect(deleteMock).toHaveBeenCalledWith(TOKEN);

    expect(await screen.findByRole("button", { name: "Kalender-Abo einrichten" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Im Kalender öffnen" })).not.toBeInTheDocument();
  });

  it("copies the https link to the clipboard", async () => {
    getMock.mockResolvedValue(FEED);
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    renderCard();
    await screen.findByRole("link", { name: "Im Kalender öffnen" });

    fireEvent.click(screen.getByRole("button", { name: "Link kopieren" }));
    expect(writeText).toHaveBeenCalledWith(HTTPS_URL);
    expect(await screen.findByRole("button", { name: "Kopiert" })).toBeInTheDocument();
  });

  it("shows a failed load with a retry that asks again", async () => {
    getMock.mockRejectedValueOnce(new Error("Verbindung unterbrochen")).mockResolvedValueOnce(FEED);
    renderCard();

    expect(await screen.findByText("Verbindung unterbrochen")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Erneut versuchen" }));
    expect(getMock).toHaveBeenCalledTimes(2);
    expect(await screen.findByRole("link", { name: "Im Kalender öffnen" })).toBeInTheDocument();
  });

  it("keeps the subscription on screen when rotating fails and reports why", async () => {
    getMock.mockResolvedValue(FEED);
    createMock.mockRejectedValue(new Error("Server nicht erreichbar"));
    vi.stubGlobal("confirm", vi.fn(() => true));
    renderCard();
    await screen.findByRole("link", { name: "Im Kalender öffnen" });

    fireEvent.click(screen.getByRole("button", { name: "Link neu erzeugen" }));
    await flush();

    expect(screen.getByText("Server nicht erreichbar")).toBeInTheDocument();
    expect(linkField().value).toBe(HTTPS_URL);
  });
});

describe("friendlyFetchAgent", () => {
  it("names the common calendar apps and truncates the rest", () => {
    expect(friendlyFetchAgent("iOS/26.0 (24A123) dataaccessd/1.0")).toBe("iPhone/iPad-Kalender");
    expect(friendlyFetchAgent("dataaccessd/1.0 (Mac OS X)")).toBe("iPhone/iPad-Kalender");
    expect(friendlyFetchAgent("Google-Calendar-Importer")).toBe("Google Kalender");
    expect(friendlyFetchAgent("Microsoft Exchange/15.20")).toBe("Outlook");
    expect(friendlyFetchAgent("Outlook-iOS/2.0")).toBe("Outlook");
    expect(friendlyFetchAgent("Thunderbird/128.0")).toBe("Thunderbird/128.0");
    const browser = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130";
    const shortened = friendlyFetchAgent(browser);
    expect(shortened).toBe("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537…");
    expect(shortened!.length).toBeLessThanOrEqual(48);
    expect(friendlyFetchAgent(null)).toBeNull();
    expect(friendlyFetchAgent("   ")).toBeNull();
  });
});
