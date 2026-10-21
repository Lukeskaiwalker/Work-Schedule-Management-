/**
 * The customer combobox's leading group: rows a page may show above the
 * customers while nothing is typed (the Schaltplan page's "Zuletzt
 * bearbeitet" panels). The combobox is shared with every other form, so the
 * first thing pinned is that without the prop nothing changes; then that
 * the rows vanish the moment the user searches, and that the keyboard walks
 * one list — leading rows, customers, the create action.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

import { CustomerCombobox, CUSTOMER_REMOTE_SEARCH_DEBOUNCE_MS } from "../components/customers/CustomerCombobox";
import type { CustomerListItem } from "../types";

const CUSTOMERS = [
  { id: 1, name: "Schulze", address: "Hauptstraße 1", active_project_count: 2 },
  { id: 2, name: "Meyer", address: null, active_project_count: 0 },
] as unknown as CustomerListItem[];

function leading(onPick = vi.fn()) {
  return {
    title: "Zuletzt bearbeitet",
    items: [
      { id: "7", primary: "VT-0007 · UV1 Unterverteiler Keller", secondary: "Schulze · 381", hint: "vor 2 Std." },
      { id: "9", primary: "VT-0009 · HV Hauptverteiler", secondary: "Meyer" },
    ],
    onPick,
  };
}

type Props = Parameters<typeof CustomerCombobox>[0];

function renderBox(overrides: Partial<Props> = {}) {
  const props: Props = {
    language: "de",
    customers: CUSTOMERS,
    value: { customerId: null, customerName: "" },
    onChange: vi.fn(),
    onRequestCreate: vi.fn(),
    ...overrides,
  };
  render(<CustomerCombobox {...props} />);
  const input = screen.getByRole("combobox");
  return { ...props, input };
}

describe("CustomerCombobox — leading items", () => {
  it("changes nothing without the prop", () => {
    const { input, onChange } = renderBox();
    fireEvent.focus(input);
    expect(screen.queryByText("Kunden")).toBeNull();
    expect(screen.queryByText("Zuletzt bearbeitet")).toBeNull();
    expect(screen.getAllByRole("option")).toHaveLength(2);

    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith({ customerId: 1, customerName: "Schulze" }, expect.objectContaining({ id: 1 }));
  });

  it("shows the group above the customers only while the query is empty", () => {
    const { input } = renderBox({ leadingItems: leading() });
    fireEvent.focus(input);

    expect(screen.getByText("Zuletzt bearbeitet")).toBeInTheDocument();
    expect(screen.getByText("Kunden")).toBeInTheDocument();
    expect(screen.getByText("VT-0007 · UV1 Unterverteiler Keller")).toBeInTheDocument();
    expect(screen.getByText("Schulze · 381")).toBeInTheDocument();
    expect(screen.getByText("vor 2 Std.")).toBeInTheDocument();
    // Leading rows first, then the customers.
    const options = screen.getAllByRole("option").map((row) => row.textContent);
    expect(options[0]).toContain("VT-0007");
    expect(options[1]).toContain("VT-0009");
    expect(options[2]).toContain("Schulze");
    expect(options[3]).toContain("Meyer");

    fireEvent.change(input, { target: { value: "Sch" } });
    expect(screen.queryByText("Zuletzt bearbeitet")).toBeNull();
    expect(screen.queryByText("Kunden")).toBeNull();
    expect(screen.queryByText("VT-0007 · UV1 Unterverteiler Keller")).toBeNull();
    expect(screen.getByText("Schulze")).toBeInTheDocument();

    fireEvent.change(input, { target: { value: "" } });
    expect(screen.getByText("Zuletzt bearbeitet")).toBeInTheDocument();
  });

  it("shows nothing extra for an empty leading list", () => {
    const { input } = renderBox({ leadingItems: { ...leading(), items: [] } });
    fireEvent.focus(input);
    expect(screen.queryByText("Zuletzt bearbeitet")).toBeNull();
    expect(screen.queryByText("Kunden")).toBeNull();
  });

  it("fires onPick on click, and closes without touching the customer", () => {
    const onPick = vi.fn();
    const { input, onChange } = renderBox({ leadingItems: leading(onPick) });
    fireEvent.focus(input);

    fireEvent.mouseDown(screen.getByText("VT-0007 · UV1 Unterverteiler Keller"));

    expect(onPick).toHaveBeenCalledWith("7");
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("fires onPick on Enter after ArrowDown, and walks on into the customers", () => {
    const onPick = vi.fn();
    const { input, onChange } = renderBox({ leadingItems: leading(onPick) });
    fireEvent.focus(input);

    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(screen.getByText("VT-0009 · HV Hauptverteiler").closest("li")).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onPick).toHaveBeenCalledWith("9");
    expect(onChange).not.toHaveBeenCalled();

    // Reopen: two steps down is the first customer.
    fireEvent.focus(input);
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(screen.getByText("Schulze").closest("li")).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith({ customerId: 1, customerName: "Schulze" }, expect.objectContaining({ id: 1 }));
    expect(onPick).toHaveBeenCalledTimes(1);
  });

  it("wraps ArrowUp from the first leading row to the last customer", () => {
    const { input } = renderBox({ leadingItems: leading() });
    fireEvent.focus(input);
    fireEvent.keyDown(input, { key: "ArrowUp" });
    // "Meyer" is also a leading row's secondary line; the customer row names it in bold.
    expect(screen.getByText("Meyer", { selector: ".customer-combobox-option-name" }).closest("li")).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });
});

// ── The customer the list does not hold ───────────────────────────────────
//
// Until 2026-10 the shared list stopped at the server's 200-row default, so
// customer 210 ("Mustermann, Erika" here) was simply absent: typing her name on the
// Kisten page offered a "+ Neuen Kunden anlegen" row that did nothing, and in
// the project form the same row created her a second time. The list is
// complete now; these pin the combobox's own guard rails for a customer it
// still does not hold (created elsewhere since it loaded).

const MUSTERMANN = {
  id: 210,
  name: "Mustermann, Erika",
  address: "Musterweg 1, 12345 Musterstadt",
  active_project_count: 1,
} as unknown as CustomerListItem;

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  let reject: (reason: unknown) => void = () => {};
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const CREATE_ROW = /Neuen Kunden anlegen/;

describe("CustomerCombobox — creating is the caller's choice", () => {
  it("offers no create row without onRequestCreate, and says nothing matched", () => {
    const { input } = renderBox({ onRequestCreate: undefined });
    fireEvent.change(input, { target: { value: "Mustermann" } });

    expect(screen.queryByText(CREATE_ROW)).toBeNull();
    expect(screen.getByText("Keine Kunden gefunden.")).toBeInTheDocument();
  });

  it("does nothing on Enter when there is nothing to pick or create", () => {
    const { input, onChange } = renderBox({ onRequestCreate: undefined });
    fireEvent.change(input, { target: { value: "Mustermann" } });
    vi.mocked(onChange).mockClear();

    fireEvent.keyDown(input, { key: "Enter" });

    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByText("Keine Kunden gefunden.")).toBeInTheDocument();
  });
});

describe("CustomerCombobox — a picked customer the list does not hold", () => {
  it("shows the name it was given and still offers to remove it", () => {
    const { input, onChange } = renderBox({ value: { customerId: MUSTERMANN.id, customerName: MUSTERMANN.name } });

    expect(input).toHaveValue("Mustermann, Erika");
    fireEvent.click(screen.getByRole("button", { name: "Kunde entfernen" }));
    expect(onChange).toHaveBeenCalledWith({ customerId: null, customerName: "" });
  });
});

describe("CustomerCombobox — the server check", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  async function elapse(ms: number) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  }

  it("lists a hit the local list lacks, and picking it hands back the customer", async () => {
    const searchRemote = vi.fn(async (_query: string) => [MUSTERMANN]);
    const { input, onChange } = renderBox({ searchRemote });

    fireEvent.change(input, { target: { value: "Mustermann" } });
    await elapse(CUSTOMER_REMOTE_SEARCH_DEBOUNCE_MS);

    expect(searchRemote).toHaveBeenCalledWith("Mustermann");
    fireEvent.mouseDown(screen.getByText("Mustermann, Erika"));
    const calls = vi.mocked(onChange).mock.calls;
    const [value, picked] = calls[calls.length - 1];
    expect(value).toEqual({ customerId: 210, customerName: "Mustermann, Erika" });
    expect(picked).toMatchObject({ id: 210, address: "Musterweg 1, 12345 Musterstadt" });
    expect(input).toHaveValue("Mustermann, Erika");
  });

  it("asks once the typing pauses, not on every key", async () => {
    const searchRemote = vi.fn(async (_query: string) => [] as CustomerListItem[]);
    const { input } = renderBox({ searchRemote });

    fireEvent.change(input, { target: { value: "To" } });
    await elapse(100);
    fireEvent.change(input, { target: { value: "Must" } });
    await elapse(CUSTOMER_REMOTE_SEARCH_DEBOUNCE_MS);

    expect(searchRemote.mock.calls).toEqual([["Must"]]);
  });

  it("offers to create only after the server has found no such customer", async () => {
    const answer = deferred<CustomerListItem[]>();
    const searchRemote = vi.fn((_query: string) => answer.promise);
    const { input } = renderBox({ searchRemote });

    fireEvent.change(input, { target: { value: "Neumann Elektro" } });
    expect(screen.queryByText(CREATE_ROW)).toBeNull();

    await elapse(CUSTOMER_REMOTE_SEARCH_DEBOUNCE_MS);
    expect(searchRemote).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(CREATE_ROW)).toBeNull();
    expect(screen.getByText("Kundenstamm wird durchsucht…")).toBeInTheDocument();

    await act(async () => answer.resolve([]));
    expect(screen.getByText(CREATE_ROW)).toBeInTheDocument();
    expect(screen.queryByText("Kundenstamm wird durchsucht…")).toBeNull();
  });

  it("offers no create row when the server knows the exact name", async () => {
    const searchRemote = vi.fn(async (_query: string) => [MUSTERMANN]);
    const { input } = renderBox({ searchRemote });

    fireEvent.change(input, { target: { value: "mustermann, erika" } });
    await elapse(CUSTOMER_REMOTE_SEARCH_DEBOUNCE_MS);

    expect(screen.getByText("Mustermann, Erika")).toBeInTheDocument();
    expect(screen.queryByText(CREATE_ROW)).toBeNull();
  });

  it("offers no create row when the check fails", async () => {
    const searchRemote = vi.fn(async (_query: string): Promise<CustomerListItem[]> => {
      throw new Error("Bad Gateway");
    });
    const { input } = renderBox({ searchRemote });

    fireEvent.change(input, { target: { value: "Neumann Elektro" } });
    await elapse(CUSTOMER_REMOTE_SEARCH_DEBOUNCE_MS);

    expect(screen.queryByText(CREATE_ROW)).toBeNull();
    expect(screen.getByText(/Kundenstamm konnte nicht geprüft werden/)).toBeInTheDocument();
  });

  it("ignores a late answer to an older query", async () => {
    const older = deferred<CustomerListItem[]>();
    const newer = deferred<CustomerListItem[]>();
    const searchRemote = vi
      .fn<(query: string) => Promise<CustomerListItem[]>>()
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(newer.promise);
    const { input } = renderBox({ searchRemote });

    fireEvent.change(input, { target: { value: "Must" } });
    await elapse(CUSTOMER_REMOTE_SEARCH_DEBOUNCE_MS);
    fireEvent.change(input, { target: { value: "Neumann" } });
    await elapse(CUSTOMER_REMOTE_SEARCH_DEBOUNCE_MS);
    expect(searchRemote.mock.calls).toEqual([["Must"], ["Neumann"]]);

    await act(async () => newer.resolve([]));
    expect(screen.getByText(CREATE_ROW)).toBeInTheDocument();

    await act(async () => older.resolve([MUSTERMANN]));
    expect(screen.queryByText("Mustermann, Erika")).toBeNull();
    expect(screen.getByText(CREATE_ROW)).toBeInTheDocument();
  });
});

describe("CustomerCombobox — the parent takes the selection away", () => {
  // "Erneut öffnen" on a returned crate clears its customer on the server, and
  // the Kisten card hands the combobox {customerId: null, customerName: ""}
  // while it stays mounted. The text used to stay, with no ✕ and a dead
  // "Packen & zuweisen" button behind it.
  it("empties the field instead of keeping the last customer's name", () => {
    const props: Props = {
      language: "de",
      customers: CUSTOMERS,
      value: { customerId: 1, customerName: "Schulze" },
      onChange: vi.fn(),
    };
    const { rerender } = render(<CustomerCombobox {...props} />);
    const input = screen.getByRole("combobox");
    expect(input).toHaveValue("Schulze");

    rerender(<CustomerCombobox {...props} value={{ customerId: null, customerName: "" }} />);

    expect(input).toHaveValue("");
    expect(screen.queryByRole("button", { name: "Kunde entfernen" })).toBeNull();
  });

  it("also for a customer the list does not hold", () => {
    const props: Props = {
      language: "de",
      customers: CUSTOMERS,
      value: { customerId: MUSTERMANN.id, customerName: MUSTERMANN.name },
      onChange: vi.fn(),
    };
    const { rerender } = render(<CustomerCombobox {...props} />);
    const input = screen.getByRole("combobox");

    rerender(<CustomerCombobox {...props} value={{ customerId: null, customerName: "" }} />);

    expect(input).toHaveValue("");
  });

  it("keeps what the user is typing", () => {
    const { input } = renderBox({ value: { customerId: null, customerName: "" } });
    fireEvent.change(input, { target: { value: "Schul" } });
    expect(input).toHaveValue("Schul");
  });
});

describe("CustomerCombobox — the server check, edge cases", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  async function elapse(ms: number) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  }

  it("puts the server's exact-name hit first, so Enter picks it over a near miss", async () => {
    // Created in another browser since this list loaded; the list holds only
    // a namesake whose name merely contains the typed one.
    const namesake = { id: 3, name: "Mustermann, Erika-Sophie", address: null, active_project_count: 0 } as unknown as CustomerListItem;
    const searchRemote = vi.fn(async (_query: string) => [MUSTERMANN, namesake]);
    const { input, onChange } = renderBox({ customers: [...CUSTOMERS, namesake], searchRemote });

    fireEvent.change(input, { target: { value: "Mustermann, Erika" } });
    await elapse(CUSTOMER_REMOTE_SEARCH_DEBOUNCE_MS);
    const options = screen.getAllByRole("option").map((row) => row.textContent ?? "");
    expect(options[0]).toContain("Mustermann, Erika");
    expect(options[0]).not.toContain("Erika-Sophie");

    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).toHaveBeenLastCalledWith(
      { customerId: MUSTERMANN.id, customerName: "Mustermann, Erika" },
      expect.objectContaining({ id: MUSTERMANN.id }),
    );
  });

  it("says the check failed, not that nobody exists, where it cannot create", async () => {
    const searchRemote = vi.fn(async (_query: string): Promise<CustomerListItem[]> => {
      throw new Error("Bad Gateway");
    });
    const { input } = renderBox({ onRequestCreate: undefined, searchRemote });

    fireEvent.change(input, { target: { value: "Neumann Elektro" } });
    await elapse(CUSTOMER_REMOTE_SEARCH_DEBOUNCE_MS);

    expect(screen.queryByText("Keine Kunden gefunden.")).toBeNull();
    expect(screen.getByText("Kundenstamm konnte nicht durchsucht werden.")).toBeInTheDocument();
    expect(screen.queryByText(CREATE_ROW)).toBeNull();
  });

  it("drops a late answer for text the user typed past and deleted again", async () => {
    // Type, pause (answered), one more letter, pause (asked), Backspace before
    // that answer comes: the late answer must not replace the current one.
    const first = deferred<CustomerListItem[]>();
    const second = deferred<CustomerListItem[]>();
    const searchRemote = vi
      .fn<(query: string) => Promise<CustomerListItem[]>>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const { input } = renderBox({ searchRemote });

    fireEvent.change(input, { target: { value: "Must" } });
    await elapse(CUSTOMER_REMOTE_SEARCH_DEBOUNCE_MS);
    await act(async () => first.resolve([MUSTERMANN]));
    fireEvent.change(input, { target: { value: "Muste" } });
    await elapse(CUSTOMER_REMOTE_SEARCH_DEBOUNCE_MS);
    fireEvent.change(input, { target: { value: "Must" } });
    expect(searchRemote.mock.calls).toEqual([["Must"], ["Muste"]]);

    await act(async () => second.resolve([]));
    await elapse(5_000);

    expect(screen.getByText("Mustermann, Erika")).toBeInTheDocument();
    expect(screen.queryByText("Kundenstamm wird durchsucht…")).toBeNull();
    expect(screen.getByText(CREATE_ROW)).toBeInTheDocument();
  });
});
