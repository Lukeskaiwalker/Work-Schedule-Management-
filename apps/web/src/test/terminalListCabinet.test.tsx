/**
 * The Klemmen tab and the Klemmen label sheet on a board with a cabinet
 * (docs/PANEL_ENCLOSURE_R2.md §3.1, §5.1, §6.7, slice W4b).
 *
 * Both take the page's one `useBoardTerminals` answer: the groups derived
 * WITH the cabinet's skip set (no WAGO on AAR, NAR, RfZ or APZ rails), and
 * the placement, whose end plates join the Stückliste. Until the cabinet
 * catalogue is there they say so instead of showing X numbers that would
 * shift once it lands — and without the page's answer a cabinet board is
 * never derived without the skip set. The board is the shared fixture's
 * `terminals_zb34s`; every name in it is invented — the repo is public.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";

import { LabelPrintDialog } from "../components/schaltplan/LabelPrintDialog";
import { TerminalList } from "../components/schaltplan/TerminalList";
import { boardTerminalsState, type BoardTerminalsState } from "../hooks/useBoardTerminals";
import { boardDocument, FIXTURE_INDEX } from "./enclosureFixtureBoards";

const LOADING = "Schrankkatalog wird geladen…";
const NOT_READY: BoardTerminalsState = { ready: false, terms: null, placement: null };

const cabinetBoard = () => boardDocument("terminals_zb34s");

function renderList(boardTerminals: BoardTerminalsState | undefined, document = cabinetBoard()) {
  const onSetAllTerminals = vi.fn();
  render(
    <TerminalList
      document={document}
      boardTerminals={boardTerminals}
      readOnly={false}
      onSetAllTerminals={onSetAllTerminals}
      onPrint={vi.fn()}
      pdfHref="/api/schaltplan/panels/7/pdf?terminals_only=true"
    />,
  );
  return { onSetAllTerminals };
}

/** "Artikel | Bezeichnung | Anzahl | Breite" of every Stückliste row. */
function bomRows(): string[][] {
  const bom = screen.getByRole("region", { name: "Stückliste Reihenklemmen" });
  return within(bom)
    .getAllByRole("row")
    .slice(1)
    .map((row) => within(row).getAllByRole("cell").map((cell) => cell.textContent ?? ""));
}

describe("TerminalList on a cabinet board", () => {
  it("adds the placement's end plates to the Stückliste, in part order", () => {
    const document = cabinetBoard();
    renderList(boardTerminalsState(document, FIXTURE_INDEX), document);
    const rows = bomRows();
    expect(rows.map((row) => row[0])).toEqual([
      "WAGO 2003-7641",
      "WAGO 2003-7692",
      "WAGO 2009-305",
      "WAGO 2016-7601",
      "WAGO 2016-7604",
      "WAGO 2016-7607",
      "WAGO 2016-7691",
      "WAGO 2016-7714",
    ]);
    expect(rows.find((row) => row[0] === "WAGO 2003-7692")).toEqual(["WAGO 2003-7692", "Abschluss- und Zwischenplatte, 0,8 mm, orange", "3", "0,8 mm"]);
    expect(rows.find((row) => row[0] === "WAGO 2016-7691")).toEqual(["WAGO 2016-7691", "Abschlussplatte, 1 mm, grau", "1", "1 mm"]);
  });

  it("numbers without the AAR circuit: twelve strips, and it is no Abgang of the bulk switch", () => {
    const document = cabinetBoard();
    renderList(boardTerminalsState(document, FIXTURE_INDEX), document);
    const summary = screen.getByText(/Klemmenleisten \(X1–X12\)/);
    expect(summary.textContent).toMatch(/· 90 von 90 Abgängen$/);
    expect(screen.getByRole("region", { name: /^X1 · FI F1 · / })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Alle Abgänge mit Reihenklemme" })).toBeDisabled();
  });

  it("gives the AAR circuit no hint of its own: without a terminal it heads no Klemmenleiste", () => {
    const document = cabinetBoard();
    renderList(boardTerminalsState(document, FIXTURE_INDEX), document);
    expect(screen.queryByText(/ohne FI — Einspeiseklemme nicht abgeleitet/)).toBeNull();
  });

  it("waits for the cabinet catalogue: no numbers, no print, no bulk switch", () => {
    renderList(NOT_READY);
    expect(screen.getByRole("status")).toHaveTextContent(LOADING);
    expect(screen.queryByText(/Klemmenleisten/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Klemmen-Etiketten drucken" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Alle ohne" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Stückliste Reihenklemmen" })).toBeNull();
  });

  it("never derives a cabinet board without the skip set when the page passes nothing", () => {
    renderList(undefined);
    expect(screen.getByRole("status")).toHaveTextContent(LOADING);
  });
});

describe("LabelPrintDialog (Reihenklemmen) on a cabinet board", () => {
  function renderDialog(pick: (document: ReturnType<typeof cabinetBoard>) => BoardTerminalsState | undefined) {
    const document = cabinetBoard();
    render(
      <LabelPrintDialog
        open
        mode="reihenklemmen"
        document={document}
        boardTerminals={pick(document)}
        initialRowIds={["dev-f1:leiste"]}
        busy={false}
        onPrint={vi.fn()}
        onClose={vi.fn()}
      />,
    );
  }

  it("lists the strips the Klemmen tab numbers, the AAR circuit left out", () => {
    renderDialog((document) => boardTerminalsState(document, FIXTURE_INDEX));
    const list = screen.getByRole("list", { name: "Klemmenleisten" });
    const boxes = within(list).getAllByRole("checkbox");
    expect(boxes).toHaveLength(12);
    expect(boxes[0]).toHaveAccessibleName(/^X1 · FI F1 · /);
    expect(boxes[0]).toBeChecked();
    expect(screen.getByRole("button", { name: "Drucken" })).toBeEnabled();
  });

  it("waits for the cabinet catalogue, with Drucken off", () => {
    renderDialog(() => NOT_READY);
    expect(screen.getByRole("status")).toHaveTextContent(LOADING);
    expect(screen.queryByRole("list", { name: "Klemmenleisten" })).toBeNull();
    expect(screen.getByRole("button", { name: "Drucken" })).toBeDisabled();
  });

  it("waits as well when the page passes nothing for a cabinet board", () => {
    renderDialog(() => undefined);
    expect(screen.getByRole("status")).toHaveTextContent(LOADING);
  });
});
