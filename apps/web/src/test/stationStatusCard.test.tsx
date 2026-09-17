/**
 * The status card: the hardware rows come from the normalised `hardware`
 * (so they can never say "nicht verbunden" while the heartbeat says
 * otherwise), the address row admits when there is none, and the inline
 * edit round-trips through its callbacks.
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import {
  StationStatusCard,
  type StationStatusCardProps,
} from "../components/station/StationStatusCard";
import { createStationT } from "../components/station/stationText";
import type { Station } from "../utils/stationApi";

const NOW = Date.parse("2026-09-17T12:00:00Z");

const PI: Station = {
  id: 1,
  name: "Werkstatt Pi",
  location: "Werkstatt, Regalwand",
  status: "online",
  agent_version: "1.1.0",
  uptime_seconds: 3 * 3600 + 5 * 60,
  host: "192.168.2.235",
  port: 8765,
  agent_url_override: null,
  last_seen_at: "2026-09-17T11:59:00",
  paired_at: "2026-09-08T10:00:00",
  paired_by_name: "Luca Schmidt",
  hardware: {
    printer_connected: true,
    printer_model: "Brother PT-P710BT",
    media_width_mm: 12,
    printer_error: null,
    scanner_present: true,
    scanner_name: "/dev/input/event3",
    simulated: false,
  },
  session_count: 2,
  pending_count: 1,
  agent_error: null,
};

function renderCard(overrides: Partial<StationStatusCardProps> = {}) {
  const props: StationStatusCardProps = {
    t: createStationT(true),
    de: true,
    now: NOW,
    stations: [PI],
    retired: [],
    showInactive: false,
    onShowInactiveChange: vi.fn(),
    listState: "ready",
    listError: null,
    selected: PI,
    selectedId: PI.id,
    onSelect: vi.fn(),
    actionBusy: null,
    actionFeedback: null,
    restartArmed: false,
    onArmRestart: vi.fn(),
    onTestPrint: vi.fn(),
    onRecheck: vi.fn(),
    onRestart: vi.fn(),
    onUnpair: vi.fn(),
    edit: { editing: false, draft: { name: "", location: "", agentUrl: "" }, busy: false, error: null },
    onEditStart: vi.fn(),
    onEditChange: vi.fn(),
    onEditCancel: vi.fn(),
    onEditSave: vi.fn(),
    ...overrides,
  };
  render(<StationStatusCard {...props} />);
  return props;
}

describe("StationStatusCard", () => {
  it("renders the hardware rows from the normalised hardware", () => {
    renderCard();
    expect(screen.getByText("Brother PT-P710BT · verbunden · Band 12 mm")).toBeInTheDocument();
    expect(screen.getByText("/dev/input/event3 · erkannt")).toBeInTheDocument();
    expect(screen.getByText("192.168.2.235:8765")).toBeInTheDocument();
    expect(screen.getByText(/Luca Schmidt/)).toBeInTheDocument();
    expect(screen.getByText("3 Std 5 Min")).toBeInTheDocument();
  });

  it("shows the printer's own reason when it is unplugged, and a separate agent error", () => {
    renderCard({
      selected: {
        ...PI,
        hardware: { ...PI.hardware!, printer_connected: false, printer_error: "printer not found on USB (04f9:20af)" },
        agent_error: "Die Station antwortet nicht. Läuft der Agent auf dem Pi?",
      },
    });
    expect(screen.getByText("printer not found on USB (04f9:20af)")).toBeInTheDocument();
    expect(screen.getByText("Die Station antwortet nicht. Läuft der Agent auf dem Pi?")).toBeInTheDocument();
  });

  it("admits when the API has no address, and marks a manual override", () => {
    renderCard({ selected: { ...PI, host: null, port: null } });
    expect(screen.getByText("Adresse unbekannt — Agent auf dem Pi aktualisieren")).toBeInTheDocument();

    renderCard({ selected: { ...PI, agent_url_override: "http://10.0.0.5:9000" } });
    expect(screen.getByText("http://10.0.0.5:9000 (manuell)")).toBeInTheDocument();
  });

  it("opens the inline edit from the action bar", () => {
    const props = renderCard();
    fireEvent.click(screen.getByRole("button", { name: "Bearbeiten" }));
    expect(props.onEditStart).toHaveBeenCalled();
  });

  it("round-trips the edit form through its callbacks and hides the actions meanwhile", () => {
    const editing = renderCard({
      edit: {
        editing: true,
        draft: { name: "Werkstatt Pi", location: "Werkstatt, Regalwand", agentUrl: "" },
        busy: false,
        error: null,
      },
    });
    const name = screen.getByLabelText("Name") as HTMLInputElement;
    expect(name.value).toBe("Werkstatt Pi");
    fireEvent.change(screen.getByLabelText("Agent-Adresse (optional)"), {
      target: { value: "http://192.168.2.235:8765" },
    });
    expect(editing.onEditChange).toHaveBeenCalledWith("agentUrl", "http://192.168.2.235:8765");
    fireEvent.click(screen.getByRole("button", { name: "Speichern" }));
    expect(editing.onEditSave).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Abbrechen" }));
    expect(editing.onEditCancel).toHaveBeenCalled();
    // While editing, the one-shot actions step aside.
    expect(screen.queryByRole("button", { name: "Testetikett drucken" })).toBeNull();
  });

  it("shows the API's refusal next to the form", () => {
    renderCard({
      edit: {
        editing: true,
        draft: { name: "Werkstatt Pi", location: "", agentUrl: "http://8.8.8.8:1" },
        busy: false,
        error: "Agent-Adresse muss eine private IP-Adresse oder ein *.local-Name sein.",
      },
    });
    expect(
      screen.getByText("Agent-Adresse muss eine private IP-Adresse oder ein *.local-Name sein."),
    ).toBeInTheDocument();
  });

  it("offers the audit toggle and calls back when it is switched", () => {
    const props = renderCard();
    const toggle = screen.getByLabelText("Entkoppelte anzeigen") as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    fireEvent.click(toggle);
    expect(props.onShowInactiveChange).toHaveBeenCalledWith(true);
    expect(screen.queryByText("Entkoppelte Stationen")).toBeNull();
  });

  it("lists retired rows greyed with their reason, outside the switcher", () => {
    const second: Station = { ...PI, id: 2, name: "Lager Pi" };
    const revoked: Station = {
      ...PI,
      id: 3,
      name: "Alter Pi",
      status: "offline",
      revoked_at: "2026-09-10T08:00:00",
      expires_at: null,
      active: false,
    };
    const expired: Station = {
      ...PI,
      id: 4,
      name: "Messe-Pi",
      status: "offline",
      revoked_at: null,
      expires_at: "2026-09-01T00:00:00",
      active: false,
    };
    renderCard({ stations: [PI, second], retired: [revoked, expired], showInactive: true });
    expect(screen.getByText("Entkoppelte Stationen")).toBeInTheDocument();
    const revokedRow = screen.getByText("Alter Pi").closest("li")!;
    expect(revokedRow).toHaveClass("pi-station-retired-row");
    expect(revokedRow.textContent).toMatch(/Entkoppelt · /);
    expect(revokedRow.textContent).toMatch(/Gekoppelt /);
    expect(screen.getByText("Messe-Pi").closest("li")!.textContent).toMatch(/Abgelaufen · /);
    // The switcher offers the two live stations and nothing retired.
    const switcher = screen.getAllByRole("button", { pressed: false }).concat(
      screen.getAllByRole("button", { pressed: true }),
    );
    expect(switcher.map((b) => b.textContent)).not.toContainEqual(expect.stringContaining("Alter Pi"));
    expect(screen.queryByRole("button", { name: /Alter Pi|Messe-Pi/ })).toBeNull();
    expect(screen.getByText(/nur durch erneutes Koppeln/)).toBeInTheDocument();
  });

  it("says so when the toggle is on and nothing was ever retired", () => {
    renderCard({ showInactive: true });
    expect(screen.getByText("Keine entkoppelten Stationen.")).toBeInTheDocument();
  });

  it("arms the restart behind a confirmation and reports the action in flight", () => {
    const props = renderCard();
    fireEvent.click(screen.getByRole("button", { name: "Agent neu starten" }));
    expect(props.onArmRestart).toHaveBeenCalledWith(true);

    renderCard({ restartArmed: true, actionBusy: "restart" });
    expect(screen.getByRole("button", { name: "Startet neu…" })).toBeDisabled();
    expect(screen.getByText(/Wirklich neu starten/)).toBeInTheDocument();
  });
});
