/**
 * The sessions card: what a Pi session row says about itself, where an import
 * goes, and that the one action calls back with the row it was clicked on.
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import {
  IMPORT_TARGET_NEW,
  StationSessionsCard,
  type StationSessionsCardProps,
} from "../components/station/StationSessionsCard";
import { createStationT } from "../components/station/stationText";
import type { StationSession } from "../utils/stationApi";

const NOW = Date.parse("2026-09-17T12:00:00Z");

const REGAL: StationSession = {
  name: "regal",
  started_at: "2026-09-10T08:00:00Z",
  status: "open",
  articles: 3,
  total_qty: 5,
  total_scans: 5,
  last_counted_at: "2026-09-17T11:55:00Z",
  imported_at: null,
  imported_session_id: null,
};

const DEFAULT_SESSION: StationSession = {
  ...REGAL,
  name: "default",
  articles: 12,
  total_qty: 40,
  total_scans: 41,
  imported_at: "2026-09-16T09:30:00",
  imported_session_id: 42,
};

function renderCard(overrides: Partial<StationSessionsCardProps> = {}) {
  const props: StationSessionsCardProps = {
    t: createStationT(true),
    de: true,
    now: NOW,
    sessions: [REGAL, DEFAULT_SESSION],
    sessionState: "ready",
    sessionError: null,
    importingName: null,
    importFeedback: null,
    openInventories: [
      { id: 42, name: "Inventur Q3", status: "open", counted_articles: 12 },
      { id: 43, name: "Nachzählung Halle 1", status: "open", counted_articles: 0 },
    ],
    importTarget: IMPORT_TARGET_NEW,
    onImportTargetChange: vi.fn(),
    onReload: vi.fn(),
    onImport: vi.fn(),
    ...overrides,
  };
  render(<StationSessionsCard {...props} />);
  return props;
}

describe("StationSessionsCard", () => {
  it("marks an imported row with its stamp and offers to import it again", () => {
    renderCard();
    expect(screen.getByText(/Übernommen ·/)).toBeInTheDocument();
    expect(screen.getByText(/Inventur #42/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Erneut übernehmen" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Übernehmen" })).toBeInTheDocument();
    // The numbers are the row, not decoration.
    expect(screen.getByText("40")).toBeInTheDocument();
    expect(screen.getByText("41")).toBeInTheDocument();
  });

  it("lets the admin pick an open inventory as the target, new being the default", () => {
    const props = renderCard();
    const select = screen.getByLabelText("Ziel-Inventur") as HTMLSelectElement;
    expect(select.value).toBe("new");
    const labels = Array.from(select.options).map((o) => o.textContent);
    expect(labels[0]).toMatch(/Neue Inventur anlegen/);
    expect(labels).toContainEqual(expect.stringContaining("Inventur Q3"));
    expect(labels).toContainEqual(expect.stringContaining("Nachzählung Halle 1"));

    fireEvent.change(select, { target: { value: "43" } });
    expect(props.onImportTargetChange).toHaveBeenCalledWith(43);
    fireEvent.change(select, { target: { value: "new" } });
    expect(props.onImportTargetChange).toHaveBeenCalledWith("new");
  });

  it("says under the default that an imported session continues its inventory", () => {
    renderCard();
    const labels = Array.from((screen.getByLabelText("Ziel-Inventur") as HTMLSelectElement).options).map(
      (o) => o.textContent,
    );
    expect(labels[0]).toMatch(/Neue Inventur anlegen — bzw\. die offene Inventur dieser Sitzung fortführen/);
    const hint = screen.getByText(/führen mit dieser Auswahl ihre bisherige Inventur fort/);
    expect(hint.textContent).toContain("„default“");
    expect(hint.textContent).not.toContain("„regal“");
  });

  it("drops the hint when an explicit target is chosen or nothing was imported yet", () => {
    renderCard({ importTarget: 43 });
    expect(screen.queryByText(/bisherige Inventur fort/)).toBeNull();
  });

  it("shows no hint while every listed session is still unimported", () => {
    renderCard({ sessions: [REGAL] });
    expect(screen.queryByText(/bisherige Inventur fort/)).toBeNull();
  });

  it("calls back with the row that was clicked", () => {
    const props = renderCard();
    fireEvent.click(screen.getByRole("button", { name: "Übernehmen" }));
    expect(props.onImport).toHaveBeenCalledWith(REGAL);
  });

  it("blocks every row and the target select while one import runs", () => {
    renderCard({ importingName: "regal" });
    const buttons = screen.getAllByRole("button", { name: /übernehmen|Übernimmt…/i });
    expect(buttons.length).toBe(2);
    expect(buttons.every((b) => (b as HTMLButtonElement).disabled)).toBe(true);
    expect(screen.getByRole("button", { name: "Übernimmt…" })).toBeInTheDocument();
    expect(screen.getByLabelText("Ziel-Inventur")).toBeDisabled();
  });

  it("explains the shared 'default' session when it is listed", () => {
    renderCard();
    expect(screen.getByText(/„default“ sammelt alles/)).toBeInTheDocument();
  });

  it("renders a dead Pi as a sentence with a reload button, not a spinner", () => {
    const props = renderCard({
      sessions: [],
      sessionState: "error",
      sessionError: "Die Station antwortet nicht. Läuft der Agent auf dem Pi?",
    });
    expect(screen.getByText("Die Station antwortet nicht. Läuft der Agent auf dem Pi?")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Aktualisieren" }));
    expect(props.onReload).toHaveBeenCalled();
    expect(screen.queryByLabelText("Ziel-Inventur")).toBeNull();
  });

  it("says so when the Pi has recorded nothing", () => {
    renderCard({ sessions: [], sessionState: "ready" });
    expect(screen.getByText("Die Station hat noch nichts aufgezeichnet.")).toBeInTheDocument();
  });
});
