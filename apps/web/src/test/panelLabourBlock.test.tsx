/**
 * The Arbeitszeit block under a board's Materialliste.
 *
 * What must hold: one position per person with DECIMAL hours (this block is
 * read like a Nachkalkulation); a running session is shown as "läuft seit"
 * and NOT counted; one running far too long is marked as a likely forgotten
 * clock-out; the "Beenden" control appears for your own running session, for
 * somebody else's only with werkstatt:manage, and submits the end time the
 * person entered; with no hours yet the block says how to book them.
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { PanelLabourBlock } from "../components/schaltplan/PanelLabourBlock";
import { canEndRunning, formatLabourHours, isStale } from "../components/schaltplan/panelLabour";
import { materialTexts } from "../components/schaltplan/panelMaterialTexts";
import type { PanelLabourLine, PanelMaterial } from "../types/schaltplan";

const NOW = new Date(2026, 9, 5, 16, 0, 0); // 5 Oct 2026, 16:00 local

function material(labour: PanelLabourLine[], minutes: number): PanelMaterial {
  return {
    panel: { id: 7, panel_number: "VT-0007" } as PanelMaterial["panel"],
    lines: [],
    planned_total: 0,
    scanned_total: 0,
    open_lines: 0,
    last_scanned_at: null,
    labour,
    labour_minutes: minutes,
    labour_running: labour.filter((line) => line.running_since !== null).length,
  };
}

const MAX_DONE: PanelLabourLine = {
  user_id: 4, name: "Max Monteur", minutes: 150, sessions: 2, running_since: null, running_session_id: null,
};

/** Local wall-clock time as the server would send it: naive UTC. */
function serverStamp(local: Date): string {
  return local.toISOString().replace("Z", "");
}

function lisaRunningSince(local: Date): PanelLabourLine {
  return {
    user_id: 9, name: "Lisa Lehrling", minutes: 0, sessions: 0,
    running_since: serverStamp(local), running_session_id: 55,
  };
}

function renderBlock(props: Partial<Parameters<typeof PanelLabourBlock>[0]> & { material: PanelMaterial }) {
  const onEnd = vi.fn();
  render(
    <PanelLabourBlock
      t={materialTexts("de")}
      language="de"
      busy={false}
      onEnd={onEnd}
      now={NOW}
      {...props}
    />,
  );
  return onEnd;
}

describe("the arithmetic", () => {
  it("writes hours decimally, as a Nachkalkulation does", () => {
    expect(formatLabourHours(150, "de")).toBe("2,50 h");
    expect(formatLabourHours(125, "de")).toBe("2,08 h");
    expect(formatLabourHours(150, "en")).toBe("2.50 h");
    expect(formatLabourHours(0, "de")).toBe("0,00 h");
    expect(formatLabourHours(Number.NaN, "de")).toBe("0,00 h");
  });

  it("calls a session running past twelve hours stale", () => {
    expect(isStale(serverStamp(new Date(2026, 9, 5, 15, 0)), NOW)).toBe(false);
    expect(isStale(serverStamp(new Date(2026, 9, 4, 15, 0)), NOW)).toBe(true);
  });

  it("lets you end your own session, anybody's only with werkstatt:manage", () => {
    const lisa = lisaRunningSince(new Date(2026, 9, 5, 14, 2));
    expect(canEndRunning(lisa, 9, false)).toBe(true);
    expect(canEndRunning(lisa, 4, false)).toBe(false);
    expect(canEndRunning(lisa, 4, true)).toBe(true);
    expect(canEndRunning(MAX_DONE, 4, true)).toBe(false); // nothing running
  });
});

describe("the block", () => {
  it("lists each person with their hours and the total", () => {
    renderBlock({ material: material([MAX_DONE], 150) });
    expect(screen.getByText("Arbeitszeit")).toBeTruthy();
    expect(screen.getByText("Max Monteur")).toBeTruthy();
    expect(screen.getAllByText("2,50 h")).toHaveLength(2); // the line and the total
    expect(screen.getByText("2 Einsätze")).toBeTruthy();
  });

  it("shows a running session but does not count it", () => {
    renderBlock({ material: material([MAX_DONE, lisaRunningSince(new Date(2026, 9, 5, 14, 2))], 150) });
    expect(screen.getByText(/läuft seit 14:02/)).toBeTruthy();
    // Lisa's line shows no hours of her own yet; the total is still Max's.
    expect(screen.getByText("0,00 h")).toBeTruthy();
  });

  it("marks a session that has run since yesterday as probably forgotten", () => {
    renderBlock({ material: material([lisaRunningSince(new Date(2026, 9, 4, 15, 0))], 0) });
    expect(screen.getByText("Ausstempeln vergessen?")).toBeTruthy();
  });

  it("offers Beenden on your own running session and submits the time you enter", () => {
    const onEnd = renderBlock({
      material: material([lisaRunningSince(new Date(2026, 9, 5, 14, 2))], 0),
      currentUserId: 9,
    });
    fireEvent.click(screen.getByRole("button", { name: "Beenden" }));
    const input = document.querySelector('input[type="datetime-local"]') as HTMLInputElement;
    // Between the start and now: the picker offers nothing the server would refuse.
    expect(input.min).toBe("2026-10-05T14:02");
    expect(input.max).toBe("2026-10-05T16:00");
    fireEvent.change(input, { target: { value: "2026-10-05T15:30" } });
    fireEvent.click(screen.getByRole("button", { name: "Speichern" }));

    expect(onEnd).toHaveBeenCalledTimes(1);
    const [sessionId, endedAt] = onEnd.mock.calls[0];
    expect(sessionId).toBe(55);
    expect(new Date(endedAt).getTime()).toBe(new Date(2026, 9, 5, 15, 30).getTime());
  });

  it("makes you enter the end of a stale session instead of offering now", () => {
    const onEnd = renderBlock({
      material: material([lisaRunningSince(new Date(2026, 9, 4, 15, 0))], 0),
      currentUserId: 9,
    });
    fireEvent.click(screen.getByRole("button", { name: "Beenden" }));
    const input = document.querySelector('input[type="datetime-local"]') as HTMLInputElement;
    // "Now" would book 25 hours for a session forgotten yesterday afternoon.
    expect(input.value).toBe("");
    expect(input.required).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Speichern" }));
    expect(onEnd).not.toHaveBeenCalled();
    // And not only because the browser honours `required`: a submit that gets
    // past validation still must not send null, which the server reads as now.
    fireEvent.submit(input.form as HTMLFormElement);
    expect(onEnd).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: "2026-10-04T17:30" } });
    fireEvent.click(screen.getByRole("button", { name: "Speichern" }));
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(new Date(onEnd.mock.calls[0][1]).getTime()).toBe(new Date(2026, 9, 4, 17, 30).getTime());
  });

  it("hides Beenden on a colleague's session without werkstatt:manage", () => {
    renderBlock({ material: material([lisaRunningSince(new Date(2026, 9, 5, 14, 2))], 0), currentUserId: 4 });
    expect(screen.queryByRole("button", { name: "Beenden" })).toBeNull();
  });

  it("offers it on a colleague's session with werkstatt:manage", () => {
    renderBlock({
      material: material([lisaRunningSince(new Date(2026, 9, 5, 14, 2))], 0),
      currentUserId: 4,
      canManageWerkstatt: true,
    });
    expect(screen.getByRole("button", { name: "Beenden" })).toBeTruthy();
  });

  it("explains how hours get there when there are none", () => {
    renderBlock({ material: material([], 0) });
    expect(screen.getByText(/den Verteiler scannen, dann den eigenen Ausweis/)).toBeTruthy();
  });

  it("treats a server that sends no labour fields as no hours", () => {
    const old = material([], 0);
    delete old.labour;
    delete old.labour_minutes;
    renderBlock({ material: old });
    expect(screen.getByText(/den Verteiler scannen/)).toBeTruthy();
  });
});
