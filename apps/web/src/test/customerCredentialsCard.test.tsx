/**
 * The "Zugangsdaten" card of the customer page — the credential vault.
 * What must hold: the card fetches the customer's credentials on mount and
 * lists them as given, each with a category chip, the label, the username
 * with a copy button, the url as a link only when it is one, the notes,
 * and a masked password where one is stored ("kein Passwort hinterlegt"
 * where none is); an empty vault says so; Anzeigen fetches the secret,
 * shows it in a box with a countdown and hides it again after 30 s or on
 * Ausblenden, a refused reveal shows the API's words; the composer POSTs
 * the typed fields (the secret only when typed) and refuses an empty
 * label without a request; Bearbeiten opens the form seeded with the row
 * and PATCHes only what changed — the password untouched unless typed or
 * removed; Löschen asks first and then DELETEs, a refusal is shown; a
 * failed first load is shown with a retry.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { AppContext } from "../context/AppContext";
import { makeAppContextStub } from "./appContextStub";
import { CustomerCredentialsCard } from "../components/customers/CustomerCredentialsCard";
import {
  createCustomerCredential,
  deleteCustomerCredential,
  listCustomerCredentials,
  revealCustomerCredential,
  updateCustomerCredential,
} from "../utils/customersApi";
import { formatServerDateTime } from "../utils/dates";
import type { CustomerCredential } from "../types";

vi.mock("../utils/customersApi", () => ({
  listCustomerCredentials: vi.fn(),
  createCustomerCredential: vi.fn(),
  updateCustomerCredential: vi.fn(),
  deleteCustomerCredential: vi.fn(),
  revealCustomerCredential: vi.fn(),
}));

const listMock = vi.mocked(listCustomerCredentials);
const createMock = vi.mocked(createCustomerCredential);
const updateMock = vi.mocked(updateCustomerCredential);
const deleteMock = vi.mocked(deleteCustomerCredential);
const revealMock = vi.mocked(revealCustomerCredential);

const CUSTOMER_ID = 7;
const TOKEN = "test-token";
const ME = { id: 1, email: "me@example.com", role: "employee", display_name: "Ich" };
const EMPTY_TEXT = "Noch keine Zugangsdaten hinterlegt.";
const MASK = "••••••••";

function credential(id: number, overrides: Partial<CustomerCredential> = {}): CustomerCredential {
  return {
    id,
    customer_id: CUSTOMER_ID,
    label: `Zugang ${id}`,
    category: "other",
    username: null,
    url: null,
    notes: null,
    has_secret: false,
    created_at: "2026-09-24T18:00:00",
    updated_at: "2026-09-24T18:00:00",
    created_by_name: null,
    updated_by_name: null,
    last_revealed_at: null,
    last_revealed_by_name: null,
    ...overrides,
  };
}

const INVERTER = credential(5, {
  label: "Wechselrichter SMA Sunny Boy",
  category: "inverter",
  username: "installer",
  url: "http://192.168.178.40",
  notes: "Passwort steht auch auf dem Aufkleber",
  has_secret: true,
  created_by_name: "Luca Schmidt",
  last_revealed_at: "2026-09-24T18:05:00",
  last_revealed_by_name: "Anna",
});
const PORTAL = credential(6, {
  label: "SMA Sunny Portal",
  category: "portal",
  username: "mueller@example.com",
  url: "sunnyportal.com",
  has_secret: false,
  created_by_name: "Anna",
});
const ROUTER = credential(8, {
  label: "Fritz!Box",
  category: "router",
  url: "Aufkleber unten am Gerät",
  has_secret: true,
});

function renderCard(overrides: Record<string, unknown> = {}) {
  const spies = { setNotice: vi.fn(), setError: vi.fn() };
  const context = makeAppContextStub({
    overrides: { user: ME, ...spies, ...overrides },
  });
  render(
    <AppContext.Provider value={context as never}>
      <CustomerCredentialsCard customerId={CUSTOMER_ID} language="de" />
    </AppContext.Provider>,
  );
  return spies;
}

function rows(): HTMLElement[] {
  return screen.getAllByRole("listitem");
}

function rowNamed(label: string): HTMLElement {
  const row = rows().find((item) => within(item).queryByText(label) !== null);
  if (!row) throw new Error(`no row labelled ${label}`);
  return row;
}

function field(name: string): HTMLInputElement {
  return screen.getByLabelText(name) as HTMLInputElement;
}

/** Flush the resolved API promise and React's state under fake timers. */
async function flush() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  listMock.mockResolvedValue([INVERTER, PORTAL, ROUTER]);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("CustomerCredentialsCard", () => {
  it("fetches the vault and lists rows with chip, label, username, link, notes and masked password", async () => {
    renderCard();
    expect(screen.getByRole("heading", { level: 3, name: "Zugangsdaten" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Zugangsdaten werden geladen…");

    await screen.findByText("Wechselrichter SMA Sunny Boy");
    expect(listMock).toHaveBeenCalledWith(TOKEN, CUSTOMER_ID);
    expect(rows()).toHaveLength(3);

    const inverter = rowNamed("Wechselrichter SMA Sunny Boy");
    expect(within(inverter).getByText("Wechselrichter")).toHaveClass("customer-credentials-chip--inverter");
    expect(within(inverter).getByText("installer")).toBeInTheDocument();
    expect(within(inverter).getByRole("button", { name: "Benutzername kopieren" })).toBeInTheDocument();
    const link = within(inverter).getByRole("link", { name: "http://192.168.178.40" });
    expect(link).toHaveAttribute("href", "http://192.168.178.40");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(within(inverter).getByText("Passwort steht auch auf dem Aufkleber")).toBeInTheDocument();
    expect(within(inverter).getByText(MASK)).toBeInTheDocument();
    expect(within(inverter).getByRole("button", { name: "Anzeigen" })).toBeInTheDocument();
    const revealed = formatServerDateTime(INVERTER.last_revealed_at, "de");
    expect(within(inverter).getByText(`angelegt von Luca Schmidt · zuletzt angezeigt ${revealed} von Anna`)).toBeInTheDocument();

    // A bare host is still a link — with the scheme supplied; no password
    // says so instead of masking nothing.
    const portal = rowNamed("SMA Sunny Portal");
    expect(within(portal).getByText("Portal")).toHaveClass("customer-credentials-chip--portal");
    expect(within(portal).getByRole("link", { name: "sunnyportal.com" })).toHaveAttribute("href", "http://sunnyportal.com");
    expect(within(portal).getByText("kein Passwort hinterlegt")).toBeInTheDocument();
    expect(within(portal).queryByRole("button", { name: "Anzeigen" })).not.toBeInTheDocument();
    expect(within(portal).getByText("angelegt von Anna")).toBeInTheDocument();

    // Text that is no address stays text: nothing to click, nothing to inject.
    const router = rowNamed("Fritz!Box");
    expect(within(router).getByText("Router")).toBeInTheDocument();
    expect(within(router).getByText("Aufkleber unten am Gerät")).toBeInTheDocument();
    expect(within(router).queryByRole("link")).not.toBeInTheDocument();
    expect(within(router).queryByRole("button", { name: "Benutzername kopieren" })).not.toBeInTheDocument();

    expect(screen.queryByText(EMPTY_TEXT)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "+ Zugang" })).toBeInTheDocument();
  });

  it("says so when nothing is stored yet", async () => {
    listMock.mockResolvedValue([]);
    renderCard();
    await screen.findByText(EMPTY_TEXT);
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "+ Zugang" })).toBeInTheDocument();
  });

  it("copies the username to the clipboard and says so", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const { setNotice } = renderCard();
    await screen.findByText("installer");

    fireEvent.click(within(rowNamed("Wechselrichter SMA Sunny Boy")).getByRole("button", { name: "Benutzername kopieren" }));
    await waitFor(() => expect(setNotice).toHaveBeenCalledWith("Kopiert"));
    expect(writeText).toHaveBeenCalledWith("installer");
  });

  it("reveals the password on Anzeigen, counts down and hides it again after 30 s", async () => {
    revealMock.mockResolvedValue({ secret: "s3cret!", revealed_at: "2026-09-24T19:00:00" });
    const { setError } = renderCard();
    await screen.findByText("Wechselrichter SMA Sunny Boy");
    vi.useFakeTimers();

    const inverter = rowNamed("Wechselrichter SMA Sunny Boy");
    fireEvent.click(within(inverter).getByRole("button", { name: "Anzeigen" }));
    await flush();
    expect(revealMock).toHaveBeenCalledWith(TOKEN, CUSTOMER_ID, INVERTER.id);
    expect(within(inverter).getByText("s3cret!")).toHaveClass("customer-credentials-secret");
    expect(within(inverter).queryByText(MASK)).not.toBeInTheDocument();
    expect(within(inverter).getByText("noch 30 s")).toBeInTheDocument();
    expect(within(inverter).getByRole("button", { name: "Passwort kopieren" })).toBeInTheDocument();
    // The footer already tells of this reveal: the server logged it.
    const revealed = formatServerDateTime("2026-09-24T19:00:00", "de");
    expect(within(inverter).getByText(`angelegt von Luca Schmidt · zuletzt angezeigt ${revealed} von Ich`)).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(29_000);
    });
    expect(within(inverter).getByText("s3cret!")).toBeInTheDocument();
    expect(within(inverter).getByText("noch 1 s")).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(within(inverter).queryByText("s3cret!")).not.toBeInTheDocument();
    expect(within(inverter).getByText(MASK)).toBeInTheDocument();
    expect(within(inverter).getByRole("button", { name: "Anzeigen" })).toBeInTheDocument();
    expect(setError).not.toHaveBeenCalled();
  });

  it("hides the password on Ausblenden and shows the API's words when a reveal is refused", async () => {
    revealMock.mockResolvedValueOnce({ secret: "s3cret!", revealed_at: "2026-09-24T19:00:00" });
    revealMock.mockRejectedValueOnce(new Error("Kein Passwort hinterlegt"));
    const { setError } = renderCard();
    await screen.findByText("Wechselrichter SMA Sunny Boy");

    const inverter = rowNamed("Wechselrichter SMA Sunny Boy");
    fireEvent.click(within(inverter).getByRole("button", { name: "Anzeigen" }));
    await within(inverter).findByText("s3cret!");
    fireEvent.click(within(inverter).getByRole("button", { name: "Ausblenden" }));
    expect(within(inverter).queryByText("s3cret!")).not.toBeInTheDocument();
    expect(within(inverter).getByText(MASK)).toBeInTheDocument();

    const router = rowNamed("Fritz!Box");
    fireEvent.click(within(router).getByRole("button", { name: "Anzeigen" }));
    await waitFor(() => expect(setError).toHaveBeenCalledWith("Kein Passwort hinterlegt"));
    expect(within(router).getByText(MASK)).toBeInTheDocument();
  });

  it("creates an entry from the composer with the typed fields and lists it in label order", async () => {
    listMock.mockResolvedValue([INVERTER]);
    const created = credential(9, {
      label: "Wallbox go-e",
      category: "wallbox",
      username: "admin",
      url: "http://192.168.178.50",
      notes: "hinten am Gerät",
      has_secret: true,
      created_by_name: "Ich",
    });
    createMock.mockResolvedValue(created);
    const { setNotice, setError } = renderCard();
    await screen.findByText("Wechselrichter SMA Sunny Boy");

    fireEvent.click(screen.getByRole("button", { name: "+ Zugang" }));
    // One way in at a time: the header's button gives way to the composer.
    expect(screen.queryByRole("button", { name: "+ Zugang" })).not.toBeInTheDocument();

    // An empty label is refused before any request.
    fireEvent.click(screen.getByRole("button", { name: "Speichern" }));
    expect(setError).toHaveBeenCalledWith("Bitte eine Bezeichnung eintragen");
    expect(createMock).not.toHaveBeenCalled();

    fireEvent.change(field("Bezeichnung"), { target: { value: "  Wallbox go-e  " } });
    fireEvent.change(field("Kategorie"), { target: { value: "wallbox" } });
    fireEvent.change(field("Benutzername"), { target: { value: "admin" } });
    const password = field("Passwort");
    expect(password.type).toBe("password");
    fireEvent.change(password, { target: { value: "geheim" } });
    fireEvent.click(screen.getByRole("button", { name: "Passwort anzeigen" }));
    expect(field("Passwort").type).toBe("text");
    fireEvent.change(field("URL"), { target: { value: "http://192.168.178.50" } });
    fireEvent.change(field("Notizen"), { target: { value: "hinten am Gerät" } });
    fireEvent.click(screen.getByRole("button", { name: "Speichern" }));

    await screen.findByText("Wallbox go-e");
    expect(createMock).toHaveBeenCalledWith(TOKEN, CUSTOMER_ID, {
      label: "Wallbox go-e",
      category: "wallbox",
      username: "admin",
      url: "http://192.168.178.50",
      notes: "hinten am Gerät",
      secret: "geheim",
    });
    expect(rows().map((row) => row.querySelector(".customer-credentials-label")?.textContent)).toEqual([
      "Wallbox go-e",
      "Wechselrichter SMA Sunny Boy",
    ]);
    expect(within(rowNamed("Wallbox go-e")).getByText("Wallbox")).toBeInTheDocument();
    expect(setNotice).toHaveBeenCalledWith("Zugangsdaten gespeichert");
    expect(screen.queryByLabelText("Bezeichnung")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "+ Zugang" })).toBeInTheDocument();
    // The list was not fetched again: the answer was folded in.
    expect(listMock).toHaveBeenCalledTimes(1);
  });

  it("posts without a secret when none is typed and keeps the form when the post fails", async () => {
    listMock.mockResolvedValue([]);
    createMock.mockRejectedValueOnce(new Error("Nicht erreichbar"));
    const { setError, setNotice } = renderCard();
    await screen.findByText(EMPTY_TEXT);

    fireEvent.click(screen.getByRole("button", { name: "+ Zugang" }));
    fireEvent.change(field("Bezeichnung"), { target: { value: "Kundenportal" } });
    fireEvent.click(screen.getByRole("button", { name: "Speichern" }));

    await waitFor(() => expect(setError).toHaveBeenCalledWith("Nicht erreichbar"));
    expect(createMock).toHaveBeenCalledWith(TOKEN, CUSTOMER_ID, {
      label: "Kundenportal",
      category: "other",
      username: null,
      url: null,
      notes: null,
    });
    expect(field("Bezeichnung").value).toBe("Kundenportal");
    expect(setNotice).not.toHaveBeenCalled();
  });

  it("opens Bearbeiten seeded with the row and PATCHes only what changed, the password untouched", async () => {
    updateMock.mockResolvedValue({ ...INVERTER, username: "admin" });
    const { setNotice } = renderCard();
    await screen.findByText("Wechselrichter SMA Sunny Boy");

    fireEvent.click(within(rowNamed("Wechselrichter SMA Sunny Boy")).getByRole("button", { name: "Bearbeiten" }));
    expect(field("Bezeichnung")).toHaveValue("Wechselrichter SMA Sunny Boy");
    expect(field("Kategorie")).toHaveValue("inverter");
    expect(field("Benutzername")).toHaveValue("installer");
    expect(field("URL")).toHaveValue("http://192.168.178.40");
    expect(field("Notizen")).toHaveValue("Passwort steht auch auf dem Aufkleber");
    expect(field("Passwort")).toHaveValue("");
    expect(field("Passwort")).toHaveAttribute("placeholder", "unverändert lassen");

    fireEvent.click(screen.getByRole("button", { name: "Abbrechen" }));
    expect(screen.queryByLabelText("Bezeichnung")).not.toBeInTheDocument();
    expect(updateMock).not.toHaveBeenCalled();

    fireEvent.click(within(rowNamed("Wechselrichter SMA Sunny Boy")).getByRole("button", { name: "Bearbeiten" }));
    fireEvent.change(field("Benutzername"), { target: { value: " admin " } });
    fireEvent.click(screen.getByRole("button", { name: "Speichern" }));

    await screen.findByText("admin");
    expect(updateMock).toHaveBeenCalledWith(TOKEN, CUSTOMER_ID, INVERTER.id, { username: "admin" });
    expect(rows()).toHaveLength(3);
    expect(setNotice).toHaveBeenCalledWith("Zugangsdaten gespeichert");
    expect(listMock).toHaveBeenCalledTimes(1);
  });

  it("sends an empty secret for Passwort entfernen and the new one when typed", async () => {
    updateMock.mockResolvedValueOnce({ ...INVERTER, has_secret: false });
    updateMock.mockResolvedValueOnce({ ...ROUTER, has_secret: true });
    renderCard();
    await screen.findByText("Wechselrichter SMA Sunny Boy");

    fireEvent.click(within(rowNamed("Wechselrichter SMA Sunny Boy")).getByRole("button", { name: "Bearbeiten" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Passwort entfernen" }));
    expect(field("Passwort")).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Speichern" }));
    await waitFor(() => expect(updateMock).toHaveBeenCalledWith(TOKEN, CUSTOMER_ID, INVERTER.id, { secret: "" }));
    expect(await within(rowNamed("Wechselrichter SMA Sunny Boy")).findByText("kein Passwort hinterlegt")).toBeInTheDocument();

    fireEvent.click(within(rowNamed("Fritz!Box")).getByRole("button", { name: "Bearbeiten" }));
    fireEvent.change(field("Passwort"), { target: { value: "neu" } });
    fireEvent.click(screen.getByRole("button", { name: "Speichern" }));
    await waitFor(() => expect(updateMock).toHaveBeenCalledWith(TOKEN, CUSTOMER_ID, ROUTER.id, { secret: "neu" }));
  });

  it("closes an unchanged edit without a request", async () => {
    renderCard();
    await screen.findByText("Wechselrichter SMA Sunny Boy");
    fireEvent.click(within(rowNamed("SMA Sunny Portal")).getByRole("button", { name: "Bearbeiten" }));
    fireEvent.click(screen.getByRole("button", { name: "Speichern" }));
    expect(screen.queryByLabelText("Bezeichnung")).not.toBeInTheDocument();
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("deletes after confirmation and drops the row; a cancelled confirm sends nothing; a refusal is shown", async () => {
    deleteMock.mockResolvedValueOnce(undefined);
    deleteMock.mockRejectedValueOnce(new Error("Nur wer den Zugang angelegt hat darf ihn löschen"));
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    const { setNotice, setError } = renderCard();
    await screen.findByText("Wechselrichter SMA Sunny Boy");

    fireEvent.click(within(rowNamed("Wechselrichter SMA Sunny Boy")).getByRole("button", { name: "Löschen" }));
    expect(confirmSpy).toHaveBeenCalledWith("Diese Zugangsdaten löschen?");
    expect(deleteMock).not.toHaveBeenCalled();

    confirmSpy.mockReturnValue(true);
    fireEvent.click(within(rowNamed("Wechselrichter SMA Sunny Boy")).getByRole("button", { name: "Löschen" }));
    await waitFor(() => expect(screen.queryByText("Wechselrichter SMA Sunny Boy")).not.toBeInTheDocument());
    expect(deleteMock).toHaveBeenCalledWith(TOKEN, CUSTOMER_ID, INVERTER.id);
    expect(rows()).toHaveLength(2);
    expect(setNotice).toHaveBeenCalledWith("Zugangsdaten gelöscht");

    fireEvent.click(within(rowNamed("SMA Sunny Portal")).getByRole("button", { name: "Löschen" }));
    await waitFor(() => expect(setError).toHaveBeenCalledWith("Nur wer den Zugang angelegt hat darf ihn löschen"));
    expect(rows()).toHaveLength(2);
    expect(listMock).toHaveBeenCalledTimes(1);
  });

  it("shows a failed load in the API's words and fetches again on retry", async () => {
    listMock.mockRejectedValueOnce(new Error("Nicht erreichbar"));
    listMock.mockResolvedValueOnce([PORTAL]);
    renderCard();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Zugangsdaten konnten nicht geladen werden.");
    expect(alert).toHaveTextContent("Nicht erreichbar");
    expect(screen.queryByRole("button", { name: "+ Zugang" })).not.toBeInTheDocument();

    fireEvent.click(within(alert).getByRole("button", { name: "Erneut versuchen" }));
    await screen.findByText("SMA Sunny Portal");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(listMock).toHaveBeenCalledTimes(2);
  });
});
