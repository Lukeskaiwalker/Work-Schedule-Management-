/**
 * Duplikate prüfen — the review queue, and the confirmation in front of a
 * merge that cannot be undone.
 *
 * The finding has existed server-side since the Werkstatt shipped and nothing
 * ever rendered it, so the duplicates simply accumulated. What is pinned here
 * is the part a screen has to get right when the action is irreversible:
 *
 *   - the survivor is a CHOICE, defaulted sensibly (the side with an EAN),
 *     not an assumption about which side the server listed first;
 *   - the confirmation names both articles and says what moves and what is
 *     archived — "Fortfahren?" over a merge is how somebody loses the wrong
 *     article number;
 *   - "Kein Duplikat" is an answer too, and it is sent to the server so the
 *     next person is not asked the same question.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { DuplikateModal } from "../components/werkstatt/DuplikateModal";

type Call = { method: string; url: string; body: unknown };

function side(overrides: Record<string, unknown>) {
  return {
    id: 1,
    article_number: "SP-0007",
    item_name: "Schuko-Steckdose",
    ean: null,
    internal_code: null,
    unit: "Stk",
    stock_total: 4,
    stock_available: 4,
    category_name: "Installation",
    location_name: "Regal B2",
    supplier_numbers: [],
    is_serialized: false,
    ...overrides,
  };
}

const PAIR = {
  article_id: 1,
  article_name: "Schuko-Steckdose",
  article_number: "SP-0007",
  duplicate_id: 2,
  duplicate_name: "Schuko Steckdose weiss",
  duplicate_number: "SP-0012",
  score: 0.9,
  reason: "near-identical name, no EAN to distinguish them",
  reason_de: "fast gleicher Name, keine EAN zum Unterscheiden",
  pair_key: "1:2",
  left: side({ id: 1, article_number: "SP-0007", ean: "4012345678901", stock_total: 4 }),
  right: side({
    id: 2,
    article_number: "SP-0012",
    item_name: "Schuko Steckdose weiss",
    ean: null,
    stock_total: 9,
    stock_available: 9,
    supplier_numbers: ["4711"],
  }),
};

const MERGE_RESULT = {
  survivor_id: 1,
  merged_id: 2,
  supplier_links_moved: 2,
  supplier_links_skipped: 0,
  movements_moved: 3,
  order_lines_moved: 1,
  box_items_moved: 0,
  units_moved: 0,
  inventory_counts_moved: 0,
  task_materials_moved: 0,
  internal_code_moved: false,
  supplier_numbers_kept: [],
  fields_filled: ["ean"],
};

function stubApi(pairs: unknown[] = [PAIR]) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : null });
      const json = (payload: unknown, status = 200) =>
        new Response(JSON.stringify(payload), {
          status,
          headers: { "Content-Type": "application/json" },
        });
      if (url.includes("/articles/merge")) return json(MERGE_RESULT);
      if (url.includes("/duplicates/dismiss")) return new Response(null, { status: 204 });
      return json(pairs);
    }),
  );
  return calls;
}

function openModal() {
  const onMerged = vi.fn();
  const onError = vi.fn();
  const onClose = vi.fn();
  render(
    <DuplikateModal
      open
      language="en"
      token="test-token"
      onClose={onClose}
      onMerged={onMerged}
      onError={onError}
    />,
  );
  return { onMerged, onError, onClose };
}

describe("Duplikate prüfen", () => {
  beforeEach(() => vi.unstubAllGlobals());

  it("shows both sides with the facts the decision needs", async () => {
    stubApi();
    openModal();

    await screen.findByText("fast gleicher Name, keine EAN zum Unterscheiden");
    expect(screen.getByText(/SP-0007 · Schuko-Steckdose/)).toBeInTheDocument();
    expect(screen.getByText("EAN 4012345678901")).toBeInTheDocument();
    expect(screen.getByText("9 / 9 Stk")).toBeInTheDocument();
    expect(screen.getByText(/Supplier no.: 4711/)).toBeInTheDocument();
  });

  it("defaults the survivor to the side that has an EAN", async () => {
    // The EAN is what makes an article findable by scanning; keeping the side
    // without one would make the survivor unscannable and silently lose the
    // identifier a merge is supposed to consolidate.
    stubApi();
    openModal();

    await screen.findByText(/SP-0007 · Schuko-Steckdose/);
    const radios = screen.getAllByRole("radio") as HTMLInputElement[];
    expect(radios[0].checked).toBe(true);
    expect(radios[1].checked).toBe(false);
  });

  it("spells out what a merge does before doing it", async () => {
    const calls = stubApi();
    const { onMerged } = openModal();

    await screen.findByText(/SP-0007 · Schuko-Steckdose/);
    fireEvent.click(screen.getByRole("button", { name: "Merge" }));

    const confirm = await screen.findByRole("alertdialog", { name: "Merge articles" });
    expect(confirm).toHaveTextContent("SP-0012");
    expect(confirm).toHaveTextContent("SP-0007");
    expect(confirm).toHaveTextContent("This cannot be undone.");
    expect(confirm).toHaveTextContent(/its label will from now on resolve to SP-0007/i);
    // Nothing has been sent yet.
    expect(calls.some((call) => call.url.includes("/articles/merge"))).toBe(false);

    fireEvent.click(within(confirm).getByRole("button", { name: "Merge" }));
    await waitFor(() => expect(onMerged).toHaveBeenCalled());

    const merge = calls.find((call) => call.url.includes("/articles/merge"));
    expect(merge?.body).toEqual({ survivor_id: 1, duplicate_id: 2 });
    // The toast reports what actually moved, not a generic success.
    expect(onMerged.mock.calls[0][0]).toContain("3");
  });

  it("merges into the side the person picked, not the one listed first", async () => {
    const calls = stubApi();
    openModal();

    await screen.findByText(/SP-0012 · Schuko Steckdose weiss/);
    fireEvent.click(screen.getAllByRole("radio")[1]);
    fireEvent.click(screen.getByRole("button", { name: "Merge" }));
    const confirm = await screen.findByRole("alertdialog", { name: "Merge articles" });
    fireEvent.click(within(confirm).getByRole("button", { name: "Merge" }));

    await waitFor(() =>
      expect(calls.find((call) => call.url.includes("/articles/merge"))?.body).toEqual({
        survivor_id: 2,
        duplicate_id: 1,
      }),
    );
  });

  it("remembers 'not a duplicate' on the server, not in the browser", async () => {
    // A judgement kept client-side would ask the next person the same
    // question, which is how a review queue becomes the screen nobody opens.
    const calls = stubApi();
    openModal();

    await screen.findByText(/SP-0007 · Schuko-Steckdose/);
    fireEvent.click(screen.getByRole("button", { name: "Not a duplicate" }));

    await waitFor(() =>
      expect(calls.some((call) => call.url.includes("/duplicates/dismiss"))).toBe(true),
    );
    const dismiss = calls.find((call) => call.url.includes("/duplicates/dismiss"));
    expect(dismiss?.method).toBe("POST");
    expect(dismiss?.body).toEqual({ article_id: 1, duplicate_id: 2 });
    await waitFor(() =>
      expect(screen.queryByText(/SP-0007 · Schuko-Steckdose/)).toBeNull(),
    );
  });

  it("keeps the server's refusal on screen instead of a generic failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const json = (payload: unknown, status = 200) =>
          new Response(JSON.stringify(payload), {
            status,
            headers: { "Content-Type": "application/json" },
          });
        if (url.includes("/articles/merge")) {
          return json(
            { detail: "„Schuko-Steckdose“ ist archiviert — bitte zuerst reaktivieren." },
            400,
          );
        }
        void init;
        return json([PAIR]);
      }),
    );
    openModal();

    await screen.findByText(/SP-0007 · Schuko-Steckdose/);
    fireEvent.click(screen.getByRole("button", { name: "Merge" }));
    const confirm = await screen.findByRole("alertdialog", { name: "Merge articles" });
    fireEvent.click(within(confirm).getByRole("button", { name: "Merge" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("archiviert");
  });

  it("backing out of the confirmation keeps the queue open", async () => {
    /* The confirmation used to be a CHILD of the queue's backdrop, so its own
     * backdrop click cleared the confirmation and then bubbled: tapping the
     * dim area to back out of a merge closed the whole review list and lost
     * every survivor choice in it — at exactly the moment somebody was being
     * careful rather than fast. */
    stubApi();
    const { onClose } = openModal();

    await screen.findByText(/SP-0007 · Schuko-Steckdose/);
    fireEvent.click(screen.getByRole("button", { name: "Merge" }));
    const confirm = await screen.findByRole("alertdialog", { name: "Merge articles" });

    fireEvent.click(confirm.parentElement as HTMLElement);

    await waitFor(() =>
      expect(screen.queryByRole("alertdialog", { name: "Merge articles" })).toBeNull(),
    );
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Review duplicates" })).toBeInTheDocument();
  });

  it("names the supplier numbers the survivor's own link had to absorb", async () => {
    /* A link row is unique per (article, supplier), so 26191 cannot travel as
     * its own row when the survivor already has 26190 with that wholesaler. It
     * used to be deleted outright while the dialog promised in writing that
     * supplier article numbers move across, and the toast never mentioned it. */
    const { mergeSummary } = await import("../utils/werkstattDuplicatesApi");
    const summary = mergeSummary(
      { ...MERGE_RESULT, supplier_numbers_kept: ["26191"] } as never,
      true,
    );
    expect(summary).toContain("26191");
  });

  it("says in the confirmation what happens to a number that cannot move", async () => {
    stubApi();
    openModal();
    await screen.findByText(/SP-0007 · Schuko-Steckdose/);
    fireEvent.click(screen.getByRole("button", { name: "Merge" }));

    const confirm = await screen.findByRole("alertdialog", { name: "Merge articles" });
    expect(confirm).toHaveTextContent(/recorded on the same supplier link rather than dropped/i);
  });

  it("says plainly when there is nothing to review", async () => {
    stubApi([]);
    openModal();

    expect(await screen.findByText(/No duplicates found/)).toBeInTheDocument();
  });
});
