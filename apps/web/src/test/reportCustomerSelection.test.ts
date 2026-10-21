/**
 * What a customer pick in the Baustellenbericht writes into the report.
 *
 * The combobox's server check can offer a customer the directory does not
 * hold yet (created in another browser since the list loaded). The pick then
 * carries the row itself; looked up in `customers` instead, it came back empty
 * and the report kept only the name — no address, no contact — as if it had
 * been typed.
 */
import { describe, expect, it } from "vitest";

import { EMPTY_REPORT_DRAFT } from "../constants";
import type { ReportDraft } from "../types";
import { pickedReportCustomer, reportDraftWithCustomer } from "../utils/reportCustomer";
import { MUSTERMANN_ID, customerRow, productionLikeCustomers } from "./fixtures/customerServer";

const ERIKA = customerRow(MUSTERMANN_ID, "Mustermann, Erika", {
  address: "Musterweg 1, 12345 Musterstadt",
  contact_person: "Erika Mustermann",
  email: "erika@example.com",
  phone: null,
});
const WITHOUT_ERIKA = productionLikeCustomers(222).filter((row) => row.id !== MUSTERMANN_ID);

describe("pickedReportCustomer", () => {
  it("takes the picked row when the list does not hold the customer", () => {
    expect(pickedReportCustomer(MUSTERMANN_ID, ERIKA, WITHOUT_ERIKA)).toBe(ERIKA);
  });

  it("falls back to the list without a picked row", () => {
    expect(pickedReportCustomer(5, undefined, WITHOUT_ERIKA)?.name).toBe("Kunde 0005");
  });

  it("ignores a picked row that is not the chosen customer", () => {
    expect(pickedReportCustomer(5, ERIKA, WITHOUT_ERIKA)?.id).toBe(5);
  });

  it("is nobody for free text", () => {
    expect(pickedReportCustomer(null, ERIKA, WITHOUT_ERIKA)).toBeNull();
  });
});

describe("reportDraftWithCustomer", () => {
  const typed: ReportDraft = {
    ...EMPTY_REPORT_DRAFT,
    customer: "Muster",
    customer_address: "Baustraße 9",
    customer_phone: "0987 654321",
  };

  it("fills the master data from a linked customer, keeping what the customer lacks", () => {
    expect(reportDraftWithCustomer(typed, ERIKA, "Mustermann, Erika")).toEqual({
      ...typed,
      customer: "Mustermann, Erika",
      customer_address: "Musterweg 1, 12345 Musterstadt",
      customer_contact: "Erika Mustermann",
      customer_email: "erika@example.com",
      customer_phone: "0987 654321",
    });
  });

  it("sets only the name for free text, so a typed address survives", () => {
    expect(reportDraftWithCustomer(typed, null, "Musterfrau")).toEqual({ ...typed, customer: "Musterfrau" });
  });

  it("returns a new draft and leaves the old one alone", () => {
    const before = { ...typed };
    const next = reportDraftWithCustomer(typed, ERIKA, "Mustermann, Erika");
    expect(next).not.toBe(typed);
    expect(typed).toEqual(before);
  });
});
