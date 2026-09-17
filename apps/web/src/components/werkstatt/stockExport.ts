/**
 * The Bestand list as a CSV of exactly what is on screen.
 *
 * The "Exportieren" button has been in the header since the page shipped and
 * did nothing at all — the same class of thing as the create dialog that saved
 * nothing, and on the same page. It exports the FILTERED rows rather than the
 * whole table on purpose: the button sits next to the filters, and a person who
 * has narrowed the list to "Niedrig · Halle 1" and presses Export means those.
 *
 * Semicolon-separated with a UTF-8 BOM, like the order export: that is what
 * German Excel opens without an import wizard, and a comma file shows one
 * column of gibberish to the person who needs it most.
 */
import { unitLabel } from "./unitLabel";

/** Excel needs the BOM to read UTF-8 at all; without it "Größe" arrives broken. */
export const CSV_BOM = "﻿";

export interface StockExportRow {
  article_no: string;
  item_name: string;
  sub_meta: string;
  category: string;
  location: string;
  stock_available: number;
  stock_total: number;
  unit: string | null;
}

/**
 * RFC 4180 quoting, applied to every cell rather than only to suspicious ones —
 * plus the guard that quoting does NOT give you.
 *
 * Excel strips the quotes on import and then evaluates a cell that begins with
 * `=`, `+`, `-` or `@` as a formula. That used to be theoretical here, because
 * `item_name` only ever came from staff typing or from a Datanorm import. It
 * is not any more: an article created at the rack takes its name from a
 * scraped webshop page that nobody reviews, so "the export is an active
 * document" is now one hostile product title away. A leading apostrophe is
 * what Excel itself uses to mean "this is text"; it costs one character in a
 * cell nobody reads and closes the whole class.
 */
const FORMULA_START = /^[=+\-@\t\r]/;

function cell(value: string | number): string {
  const text = String(value ?? "");
  const safe = FORMULA_START.test(text) ? `'${text}` : text;
  return `"${safe.replace(/"/g, '""')}"`;
}

export function stockRowsToCsv(rows: ReadonlyArray<StockExportRow>, de: boolean): string {
  const header = de
    ? ["Artikelnummer", "Bezeichnung", "Details", "Kategorie", "Lagerort", "Verfügbar", "Gesamt", "Einheit"]
    : ["Article number", "Item name", "Details", "Category", "Location", "Available", "Total", "Unit"];
  const lines = [header.map(cell).join(";")];
  for (const row of rows) {
    lines.push(
      [
        row.article_no,
        row.item_name,
        row.sub_meta,
        row.category,
        row.location,
        row.stock_available,
        row.stock_total,
        unitLabel(row.unit, de),
      ]
        .map(cell)
        .join(";"),
    );
  }
  // Trailing newline: some tools drop the last row without one.
  return `${lines.join("\r\n")}\r\n`;
}

/** `bestand-2026-09-17.csv` — dated, because a stock list is a snapshot. */
export function stockExportFilename(now: Date): string {
  const iso = now.toISOString().slice(0, 10);
  return `bestand-${iso}.csv`;
}
