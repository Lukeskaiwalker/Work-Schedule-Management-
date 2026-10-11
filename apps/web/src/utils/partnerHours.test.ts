import { describe, expect, it } from "vitest";
import { formatPartnerHours, partnerHoursAmount, partnerHoursDay, partnerHoursTotal } from "./partnerHours";

describe("partner hours in the office", () => {
  it("formats hours the German way", () => {
    expect(formatPartnerHours(8)).toBe("8 Std");
    expect(formatPartnerHours(7.5)).toBe("7,5 Std");
  });

  it("shows the crew only when there is more than one person", () => {
    expect(partnerHoursAmount({ workers: 1, hours: 6, total_hours: 6 })).toBe("6 Std");
    expect(partnerHoursAmount({ workers: 3, hours: 4, total_hours: 12 })).toBe("3 × 4 Std = 12 Std");
  });

  it("writes the day without a timezone shift", () => {
    expect(partnerHoursDay("2026-10-08")).toBe("08.10.2026");
  });

  it("adds up totals", () => {
    expect(partnerHoursTotal([{ total_hours: 15 }, { total_hours: 4.25 }])).toBe(19.25);
    expect(partnerHoursTotal([])).toBe(0);
  });
});
