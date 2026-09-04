/**
 * Registering a machine whose TYPE does not exist yet.
 *
 * The report: "the add button is always grey". Every gate in the dialog was
 * correct — it greys until an article is chosen — but for a brand-new tool
 * model the article search finds nothing, and the only way on was to leave,
 * create the article elsewhere (the hint pointed at the wrong tab), and come
 * back. Production showed zero create attempts in six hours: nobody ever got
 * the button enabled.
 *
 * These pin the way out: the dialog creates the type inline and selects it,
 * the disabled button says what is missing, and a user without the article
 * right is told where to go instead of being shown a button that would 403.
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NeueMaschineModal } from "../components/werkstatt/NeueMaschineModal";

const CREATED = {
  id: 501,
  article_number: "SP-0501",
  item_name: "Hilti TE 6-A22",
  manufacturer: null,
  category_name: null,
};

/** GET /werkstatt/articles?q= finds nothing; POST /werkstatt/articles creates. */
function stubApi() {
  const calls: Array<{ method: string; url: string; body: unknown }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : null });
      const payload = method === "POST" && url.endsWith("/werkstatt/articles") ? CREATED : [];
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
  return calls;
}

function open(extra: Partial<Parameters<typeof NeueMaschineModal>[0]> = {}) {
  return render(
    <NeueMaschineModal
      open
      language="en"
      token="test-token"
      parentCandidates={[]}
      blueprintCandidates={[]}
      locations={[]}
      onClose={() => undefined}
      onConfirm={() => undefined}
      {...extra}
    />,
  );
}

describe("NeueMaschineModal — a type that does not exist yet", () => {
  it("says why the button is disabled instead of just greying it", () => {
    stubApi();
    open();
    expect(screen.getByRole("button", { name: "Create" })).toBeDisabled();
    expect(screen.getByText("Pick a type first.")).toBeInTheDocument();
  });

  it("creates the type inline and enables the button", async () => {
    const calls = stubApi();
    open({ canCreateType: true });

    fireEvent.change(screen.getByPlaceholderText(/article number or manufacturer/i), {
      target: { value: "Hilti TE 6-A22" },
    });
    // The search is debounced and finds nothing, which is the dead end.
    const createType = await screen.findByRole("button", {
      name: "Create “Hilti TE 6-A22” as a new type",
    });
    fireEvent.click(createType);

    await waitFor(() => expect(screen.getByRole("button", { name: "Create" })).toBeEnabled());
    expect(screen.queryByText("Pick a type first.")).not.toBeInTheDocument();
    // The chosen type is the one just created, with nothing but a name sent.
    expect(screen.getByText("Hilti TE 6-A22")).toBeInTheDocument();
    const post = calls.find((c) => c.method === "POST");
    expect(post?.body).toEqual({ item_name: "Hilti TE 6-A22" });
  });

  it("points a user without the article right somewhere useful", async () => {
    stubApi();
    open({ canCreateType: false });
    fireEvent.change(screen.getByPlaceholderText(/article number or manufacturer/i), {
      target: { value: "Hilti TE 6-A22" },
    });
    await screen.findByText(/Create it under Workshop/);
    expect(screen.queryByRole("button", { name: /as a new type/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create" })).toBeDisabled();
  });
});
