/**
 * The amount field in the two Werkstatt stock dialogs.
 *
 * The workshop's report: "when we want to change the amount of stock we have,
 * the default number is set to 200 which is a bit much and we are not allowed
 * to type a number, only pressing + or − will change the number". Both halves
 * were literally true — `useState<number>(200)` from the design mock, and a
 * read-only <span> between the two buttons. Counting 240 metres of cable onto
 * a shelf meant 240 taps on a tablet.
 *
 * So these pin the typing behaviour that replaced it. The awkward one is
 * emptiness: clearing the field to retype it must leave it EMPTY, because a
 * field that snaps to 0 on the first backspace cannot be retyped at all — you
 * end up appending to a zero. Empty is therefore a legal intermediate state
 * that commits on blur, and while it lasts nothing is bookable and the preview
 * shows no figure rather than a made-up one.
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { BestandAnpassenModal } from "../components/werkstatt/BestandAnpassenModal";
import { EntnehmenModal } from "../components/werkstatt/EntnehmenModal";

/** 12 owned, 9 on the shelf, 3 out with a colleague. */
const ARTICLE = {
  item_name: "Bohrer SDS-Plus 8mm",
  article_number: "SP-0042",
  category_name: "Werkzeug",
  stock_total: 12,
  stock_available: 9,
  unit: "Stk",
};

function renderAdjust(overrides: Record<string, unknown> = {}) {
  const onConfirm = vi.fn();
  const view = render(
    <BestandAnpassenModal
      open
      language="en"
      article={ARTICLE}
      onClose={() => undefined}
      onConfirm={onConfirm}
      {...overrides}
    />,
  );
  return { ...view, onConfirm };
}

const amountField = () =>
  screen.getByRole("textbox", { name: "Amount" }) as HTMLInputElement;
const reasonField = () => screen.getByRole("textbox", { name: /Reason \/ reference/ });
const newTotal = (container: HTMLElement) =>
  container.querySelector(".werkstatt-new-stock-pill b")?.textContent;
/** "8 on shelf + 3 out" — the pill's arithmetic, shown only when the field
 *  above it holds a shelf count rather than a total. */
const totalSplit = (container: HTMLElement) =>
  container.querySelector(".werkstatt-new-stock-pill-split")?.textContent ?? null;
const shelfField = () =>
  screen.getByRole("textbox", { name: "Counted on shelf" }) as HTMLInputElement;
const signGlyph = (container: HTMLElement) =>
  container.querySelector(".werkstatt-stepper-sign")?.textContent;
const saveButton = () => screen.getByRole("button", { name: "Save adjustment" });

describe("Bestand anpassen — the amount is typable", () => {
  it("opens on 1, not on the mock's 200", () => {
    renderAdjust();
    expect(amountField().value).toBe("1");
  });

  it("accepts a typed number and follows it in the preview", () => {
    const { container } = renderAdjust();
    fireEvent.change(amountField(), { target: { value: "25" } });
    expect(amountField().value).toBe("25");
    expect(signGlyph(container)).toBe("+");
    expect(newTotal(container)).toBe("37 Stk");
  });

  it("ignores anything that is not a digit, so no minus can be typed in", () => {
    renderAdjust();
    fireEvent.change(amountField(), { target: { value: "-4e2" } });
    expect(amountField().value).toBe("42");
  });

  it("may be left empty mid-retype instead of snapping to zero", () => {
    const { container } = renderAdjust();
    fireEvent.change(amountField(), { target: { value: "" } });
    expect(amountField().value).toBe("");
    // No amount entered → no invented total, and nothing to book.
    expect(newTotal(container)).toBe("—");
    expect(saveButton()).toBeDisabled();
  });

  it("commits the seed when an empty field is blurred", () => {
    renderAdjust();
    fireEvent.change(amountField(), { target: { value: "" } });
    fireEvent.blur(amountField());
    expect(amountField().value).toBe("1");
  });

  it("clamps on blur rather than while typing", () => {
    renderAdjust();
    fireEvent.click(screen.getByRole("radio", { name: /Loss \/ defect/ }));
    const field = screen.getByRole("textbox", { name: "Amount" }) as HTMLInputElement;
    // 50 survives the keystroke — capping "5" to a ceiling mid-word makes the
    // field fight the user…
    fireEvent.change(field, { target: { value: "50" } });
    expect(field.value).toBe("50");
    // …and is cut back to what is actually on the shelf when they leave it.
    fireEvent.blur(field);
    expect(field.value).toBe("9");
  });

  it("keeps the stepper buttons working, bounded by the same limits", () => {
    renderAdjust();
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    expect(amountField().value).toBe("3");
    fireEvent.click(screen.getByRole("button", { name: "Less" }));
    expect(amountField().value).toBe("2");
  });
});

describe("Bestand anpassen — the stock-take counts the SHELF", () => {
  /* The stock-corruption path this whole block exists for: someone stands at
   * the shelf with a clipboard and can count exactly one thing — what is lying
   * there. Of this article's 12, three are in a colleague's van. They count 9.
   * If the field means "new total", the system books −3 and writes off three
   * drills that are out on a job. So the field asks for the shelf, says what
   * it is adding back, and sends the sum. */

  it("asks for the shelf, and says what does not count", () => {
    renderAdjust();
    fireEvent.click(screen.getByRole("radio", { name: /Inventory adjust/ }));
    expect(shelfField()).toBeInTheDocument();
    expect(
      screen.getByText(/\+3 Stk out \/ in repair do not count/),
    ).toBeInTheDocument();
  });

  it("re-seeds to what the system thinks is on the shelf", () => {
    // 7 typed as "seven arrived" must not survive into "seven are lying
    // there" — same digits, opposite meaning, no visible change. And the seed
    // is 9 (the shelf), not 12 (the total).
    renderAdjust();
    fireEvent.change(amountField(), { target: { value: "7" } });
    fireEvent.click(screen.getByRole("radio", { name: /Inventory adjust/ }));
    expect(shelfField().value).toBe("9");
  });

  it("adds the van back before it shows a total", () => {
    const { container } = renderAdjust();
    fireEvent.click(screen.getByRole("radio", { name: /Inventory adjust/ }));
    fireEvent.change(shelfField(), { target: { value: "8" } });
    expect(signGlyph(container)).toBe("=");
    // One piece really is missing off the shelf. Three are on a van.
    expect(newTotal(container)).toBe("11 Stk");
    expect(totalSplit(container)).toBe("8 on shelf + 3 out");
  });

  it("will not book a count that agrees with the shelf", () => {
    renderAdjust();
    fireEvent.click(screen.getByRole("radio", { name: /Inventory adjust/ }));
    fireEvent.change(reasonField(), { target: { value: "Inventur 2026" } });
    // Seeded at 9, which is what the system already believes is there.
    expect(saveButton()).toBeDisabled();
  });

  it("counts an empty shelf without writing off what is out", () => {
    // The old field floored at 3 because it held the TOTAL. This one holds the
    // shelf, so 0 is a legitimate count — and the article still owns 3.
    const { container } = renderAdjust();
    fireEvent.click(screen.getByRole("radio", { name: /Inventory adjust/ }));
    const field = shelfField();
    fireEvent.change(field, { target: { value: "0" } });
    fireEvent.blur(field);
    expect(field.value).toBe("0");
    expect(newTotal(container)).toBe("3 Stk");
  });

  it("hands over the shelf count AND the total it implies", () => {
    const { onConfirm } = renderAdjust();
    fireEvent.click(screen.getByRole("radio", { name: /Inventory adjust/ }));
    fireEvent.change(shelfField(), { target: { value: "8" } });
    fireEvent.change(reasonField(), { target: { value: "Inventur 2026" } });
    fireEvent.click(saveButton());
    // `amount` is what was counted; `new_total` is what goes to the endpoint
    // as `target_total`. Sending the 8 as a target would book −4.
    expect(onConfirm).toHaveBeenCalledWith({
      kind: "inventory",
      amount: 8,
      delta: -1,
      new_total: 11,
      reason: "Inventur 2026",
    });
  });

  it("keeps the plain wording when the shelf IS the total", () => {
    // Nothing out, so there is nothing to explain: one number, one meaning.
    const { container } = renderAdjust({
      article: { ...ARTICLE, stock_total: 12, stock_available: 12 },
    });
    fireEvent.click(screen.getByRole("radio", { name: /Inventory adjust/ }));
    const field = screen.getByRole("textbox", { name: "New total stock" }) as HTMLInputElement;
    expect(field.value).toBe("12");
    fireEvent.change(field, { target: { value: "8" } });
    expect(newTotal(container)).toBe("8 Stk");
    expect(totalSplit(container)).toBeNull();
  });
});

describe("Bestand anpassen — the bounds are enforced, not just computed", () => {
  it("blocks Save on a typed overshoot, and says what the limit is", () => {
    // Blur does not always fire first: tapping Save straight from the field
    // submitted the 50 that the blur clamp was supposed to catch.
    renderAdjust();
    fireEvent.click(screen.getByRole("radio", { name: /Loss \/ defect/ }));
    fireEvent.change(screen.getByRole("textbox", { name: "Amount" }), {
      target: { value: "50" },
    });
    fireEvent.change(reasonField(), { target: { value: "Bruch" } });
    expect(saveButton()).toBeDisabled();
    expect(
      screen.getByText("Only 9 Stk on the shelf — no more can be written off."),
    ).toBeInTheDocument();
  });

  it("opens a write-off at zero when nothing is on the shelf", () => {
    // Every piece is out on a job. The seed used to be 1 against a ceiling of
    // 0: a dialog that opens invalid, with Save enabled and a 400 waiting.
    renderAdjust({ article: { ...ARTICLE, stock_total: 4, stock_available: 0 } });
    fireEvent.click(screen.getByRole("radio", { name: /Loss \/ defect/ }));
    expect((screen.getByRole("textbox", { name: "Amount" }) as HTMLInputElement).value).toBe("0");
    fireEvent.change(reasonField(), { target: { value: "Bruch" } });
    expect(saveButton()).toBeDisabled();
  });

  it("never previews a negative shelf", () => {
    const { container } = renderAdjust();
    fireEvent.click(screen.getByRole("radio", { name: /Loss \/ defect/ }));
    fireEvent.change(screen.getByRole("textbox", { name: "Amount" }), {
      target: { value: "500" },
    });
    // The workshop can end up holding nothing. It cannot end up holding −488.
    expect(newTotal(container)).toBe("0 Stk");
  });
});

describe("Bestand anpassen — what reaches the caller", () => {
  it("hands over a positive amount plus the preview it showed", () => {
    const { onConfirm } = renderAdjust();
    fireEvent.change(amountField(), { target: { value: "5" } });
    fireEvent.change(reasonField(), {
      target: { value: "LS-2024-0157" },
    });
    fireEvent.click(saveButton());
    // Amount stays positive — the kind carries the direction, because that is
    // what the endpoint wants.
    expect(onConfirm).toHaveBeenCalledWith({
      kind: "intake",
      amount: 5,
      delta: 5,
      new_total: 17,
      reason: "LS-2024-0157",
    });
  });

  it("enforces the reason the asterisk promises is required", () => {
    const { onConfirm } = renderAdjust();
    expect(saveButton()).toBeDisabled();
    fireEvent.change(reasonField(), {
      target: { value: "   " },
    });
    expect(saveButton()).toBeDisabled();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("cannot be tapped twice into a double booking", () => {
    const { onConfirm } = renderAdjust({ submitting: true });
    fireEvent.change(reasonField(), {
      target: { value: "LS-2024-0157" },
    });
    expect(screen.getByRole("button", { name: "Booking…" })).toBeDisabled();
    expect(onConfirm).not.toHaveBeenCalled();
  });
});

describe("Entnehmen — the quantity is capped at what is on the shelf", () => {
  function renderCheckout(overrides: Record<string, unknown> = {}) {
    const onConfirm = vi.fn();
    const view = render(
      <EntnehmenModal
        open
        language="en"
        article={{
          item_name: ARTICLE.item_name,
          article_number: ARTICLE.article_number,
          location_name: "Regal B2",
          stock_available: 3,
          stock_total: 12,
        }}
        projects={[]}
        onClose={() => undefined}
        onConfirm={onConfirm}
        {...overrides}
      />,
    );
    return { ...view, onConfirm };
  }

  it("clamps a typed quantity to available on blur", () => {
    renderCheckout();
    const field = screen.getByRole("textbox", { name: "Quantity" }) as HTMLInputElement;
    fireEvent.change(field, { target: { value: "9" } });
    fireEvent.blur(field);
    expect(field.value).toBe("3");
  });

  it("refuses to confirm more than is available while it is still typed", () => {
    renderCheckout();
    fireEvent.change(screen.getByRole("textbox", { name: "Quantity" }), {
      target: { value: "9" },
    });
    expect(screen.getByRole("button", { name: /Confirm checkout/ })).toBeDisabled();
    expect(screen.getByText("Only 3 available.")).toBeInTheDocument();
  });

  it("stops the + button at available", () => {
    renderCheckout();
    const more = screen.getByRole("button", { name: "More" });
    fireEvent.click(more);
    fireEvent.click(more);
    expect((screen.getByRole("textbox", { name: "Quantity" }) as HTMLInputElement).value).toBe("3");
    expect(more).toBeDisabled();
  });

  it("offers nothing to confirm when the shelf is empty", () => {
    renderCheckout({
      article: {
        item_name: ARTICLE.item_name,
        article_number: ARTICLE.article_number,
        location_name: null,
        stock_available: 0,
        stock_total: 4,
      },
    });
    expect(screen.getByRole("button", { name: /Confirm checkout/ })).toBeDisabled();
  });
});
