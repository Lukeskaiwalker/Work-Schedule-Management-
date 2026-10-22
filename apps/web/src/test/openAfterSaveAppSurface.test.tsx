/**
 * The Verteilerplan PDF links on the app surfaces — the iOS shell and the
 * SPA installed to the home screen — where links to the API open in the
 * in-app viewer instead of a tab.
 *
 * That viewer is reached through a document-level CAPTURE listener
 * (`installNativeFileOpener`), which runs before React's own click handler.
 * Left alone it would fetch the PDF at once, before the editor's last edit
 * reached the server — the stale PDF `openAfterSave` exists to prevent. So
 * the PDF links carry the opt-out attribute, and their handler opens the
 * viewer itself once the saves have settled. In jsdom `IS_APP_SURFACE` is
 * false, hence the mocked shell flags here.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

vi.mock("../native/shell", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../native/shell")>()),
  IS_APP_SURFACE: true,
  IS_STANDALONE_PWA: true,
}));

import { PanelEditorHeader } from "../components/schaltplan/PanelEditorHeader";
import { TerminalList } from "../components/schaltplan/TerminalList";
import { installNativeFileOpener, setFileOpenHandler } from "../native/fileOpen";
import { PDF_NOT_SAVED } from "../utils/openAfterSave";
import { emptyDocument, makeDevice } from "../utils/schaltplanDevices";
import type { PanelDocument, PanelPlan } from "../types/schaltplan";

const PANEL = {
  id: 7, designation: "UV1", name: "Unterverteilung OG", panel_type: "sub", location: null,
  fed_from_designation: null, status: "draft",
} as unknown as PanelPlan;

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function renderHeader(settleSaves: () => Promise<boolean>, onError = vi.fn()) {
  render(
    <PanelEditorHeader
      panel={PANEL}
      saveState="pending"
      canEdit
      labelsPrinting={false}
      typeLabelPrinting={false}
      settleSaves={settleSaves}
      onError={onError}
      onOpenBmkLabels={vi.fn()}
      onOpenTypeLabel={vi.fn()}
      onToggleStatus={vi.fn()}
      onDuplicate={vi.fn()}
    />,
  );
  return onError;
}

function terminalBoard(): PanelDocument {
  return {
    ...emptyDocument(),
    rows: [{
      id: "r1", label: "Reihe 1", slots: 12,
      devices: [
        makeDevice("rcd", { id: "f1", designation: "F1" }),
        makeDevice("mcb", { id: "a", designation: "F1.1", circuit: "1", terminal_block: true }),
      ],
    }],
  };
}

installNativeFileOpener();

afterEach(() => setFileOpenHandler(null));

describe("PDF links on the app surfaces", () => {
  it("open the plan in the in-app viewer only once the saves have settled", async () => {
    const opened = vi.fn();
    setFileOpenHandler(opened);
    const settle = deferred<boolean>();
    const settleSaves = vi.fn(() => settle.promise);
    renderHeader(settleSaves);

    fireEvent.click(screen.getByRole("link", { name: "Plan als PDF" }));
    expect(settleSaves).toHaveBeenCalledTimes(1);
    expect(opened).not.toHaveBeenCalled();

    await act(async () => settle.resolve(true));
    expect(opened).toHaveBeenCalledTimes(1);
    expect(opened.mock.calls[0][0]).toMatchObject({ url: "/api/schaltplan/panels/7/pdf", intent: "view" });
  });

  it("open nothing and say why when the saves failed", async () => {
    const opened = vi.fn();
    setFileOpenHandler(opened);
    const onError = renderHeader(async () => false);

    fireEvent.click(screen.getByRole("link", { name: "Legende drucken" }));
    await act(async () => undefined);
    expect(opened).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(PDF_NOT_SAVED);
  });

  it("leave the Klemmenliste link to the viewer when no handler settles saves first", async () => {
    const opened = vi.fn();
    setFileOpenHandler(opened);
    render(
      <TerminalList document={terminalBoard()} readOnly={false} onSetAllTerminals={vi.fn()} onPrint={vi.fn()}
        pdfHref="/api/schaltplan/panels/7/pdf?terminals_only=true" />,
    );
    fireEvent.click(screen.getByRole("link", { name: "Klemmenliste als PDF" }));
    // No settling handler: the interceptor still opens it, as before.
    expect(opened).toHaveBeenCalledTimes(1);
  });

  it("wait for the saves on the Klemmenliste link when the page settles them", async () => {
    const opened = vi.fn();
    setFileOpenHandler(opened);
    const settle = deferred<boolean>();
    const { savedPdfClick } = await import("../utils/openAfterSave");
    const href = "/api/schaltplan/panels/7/pdf?terminals_only=true";
    render(
      <TerminalList document={terminalBoard()} readOnly={false} onSetAllTerminals={vi.fn()} onPrint={vi.fn()}
        pdfHref={href} onPdfClick={savedPdfClick(href, () => settle.promise, vi.fn(), "Klemmenliste als PDF")} />,
    );
    fireEvent.click(screen.getByRole("link", { name: "Klemmenliste als PDF" }));
    expect(opened).not.toHaveBeenCalled();
    await act(async () => settle.resolve(true));
    expect(opened.mock.calls[0][0]).toMatchObject({ url: href, name: "Klemmenliste als PDF", intent: "view" });
  });
});
