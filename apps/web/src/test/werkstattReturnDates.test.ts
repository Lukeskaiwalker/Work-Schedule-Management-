/**
 * The expected-return chips.
 *
 * The Friday chip used to read the literal string "Freitag, 19. Apr" from the
 * design mock — a date that was wrong every week of the year but one, and that
 * nothing ever sent anywhere. Now it names a real date and that date is what
 * reaches `expected_return_at` on the checkout, so the two can never drift
 * apart again.
 */
import { describe, expect, it } from "vitest";
import {
  expectedReturnIso,
  resolveExpectedReturn,
  returnOptionLabel,
} from "../utils/werkstattReturnDates";

/** Wednesday, 16 September 2026, mid-morning. */
const WEDNESDAY = new Date(2026, 8, 16, 9, 30);

describe("resolveExpectedReturn", () => {
  it("puts tonight at close of day, not at the current time", () => {
    const due = resolveExpectedReturn("tonight", WEDNESDAY);
    expect(due?.getDate()).toBe(16);
    expect(due?.getHours()).toBe(18);
  });

  it("moves tomorrow one day on", () => {
    expect(resolveExpectedReturn("tomorrow", WEDNESDAY)?.getDate()).toBe(17);
  });

  it("finds the coming Friday", () => {
    expect(resolveExpectedReturn("friday", WEDNESDAY)?.getDate()).toBe(18);
  });

  it("reads Friday as today when today is Friday", () => {
    const friday = new Date(2026, 8, 18, 9, 30);
    expect(resolveExpectedReturn("friday", friday)?.getDate()).toBe(18);
  });

  it("promises no date for the chip that has no picker behind it", () => {
    // Inventing one would be a return deadline nobody agreed to.
    expect(resolveExpectedReturn("custom", WEDNESDAY)).toBeNull();
    expect(expectedReturnIso("custom", WEDNESDAY)).toBeNull();
    expect(expectedReturnIso(null, WEDNESDAY)).toBeNull();
  });

  it("sends an ISO timestamp for the chips that do name one", () => {
    expect(expectedReturnIso("tomorrow", WEDNESDAY)).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe("returnOptionLabel", () => {
  it("names the actual coming Friday instead of a frozen one", () => {
    const label = returnOptionLabel("friday", true, WEDNESDAY);
    expect(label).toContain("18");
    expect(label).not.toContain("19. Apr");
  });
});
