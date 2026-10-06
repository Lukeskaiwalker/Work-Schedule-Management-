/**
 * The "Stations-Ausweis" card on the profile page.
 *
 * What must hold: the card asks for the user's own badge on mount and shows
 * the person's name, the code and its DataMatrix; "Neuen Code erzeugen" asks
 * first -- the printed badge stops working -- and only then rotates; printing
 * prints this badge alone; a failed load is shown with a retry.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { AppContext } from "../context/AppContext";
import { makeAppContextStub } from "./appContextStub";
import { StationBadgeSection } from "../components/profile/StationBadgeSection";
import { PRINTING_CLASS } from "../components/profile/StationBadgeCard";
import { getMyStationBadge, rotateMyStationBadge, type StationBadge } from "../utils/stationBadgeApi";

vi.mock("../utils/stationBadgeApi", async (importOriginal) => {
  const real = await importOriginal<typeof import("../utils/stationBadgeApi")>();
  return { ...real, getMyStationBadge: vi.fn(), rotateMyStationBadge: vi.fn() };
});

const getMock = vi.mocked(getMyStationBadge);
const rotateMock = vi.mocked(rotateMyStationBadge);

const BADGE: StationBadge = {
  user_id: 4,
  user_name: "Max Monteur",
  code: "SMPL-P-7KQ2M9XH4R",
  created_at: "2026-10-05T18:00:00",
  last_used_at: null,
  use_count: 0,
};
const ROTATED: StationBadge = { ...BADGE, code: "SMPL-P-0000000AAA" };

function renderCard() {
  const spies = { setNotice: vi.fn(), setError: vi.fn() };
  const context = makeAppContextStub({ overrides: { token: "t", ...spies } });
  render(
    <AppContext.Provider value={context as never}>
      <StationBadgeSection />
    </AppContext.Provider>,
  );
  return spies;
}

/**
 * Wait for the badge, then query the card face only. The name and the code are
 * on the page twice -- the face, and the print sheet in its portal -- so an
 * unscoped getByText would find both.
 */
async function face() {
  await screen.findByRole("button", { name: "Neuen Code erzeugen" });
  return within(document.querySelector(".station-badge-face") as HTMLElement);
}

describe("StationBadgeSection", () => {
  beforeEach(() => {
    getMock.mockReset();
    rotateMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.body.className = "";
  });

  it("shows whose badge it is, the code, and draws it", async () => {
    getMock.mockResolvedValue(BADGE);
    renderCard();
    const card = await face();
    expect(card.getByText("Max Monteur")).toBeTruthy();
    expect(card.getByText("SMPL-P-7KQ2M9XH4R")).toBeTruthy();
    expect(card.getByText("Noch nie an einer Station gescannt.")).toBeTruthy();
    expect(getMock).toHaveBeenCalledWith("t");
    // The matrix arrives once the lazily imported encoder resolves.
    await waitFor(() => expect(card.getByRole("img", { name: "Stations-Ausweis von Max Monteur" }).tagName).toBe("svg"));
  });

  it("asks before minting a new code, and does nothing on cancel", async () => {
    getMock.mockResolvedValue(BADGE);
    renderCard();
    await face();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    fireEvent.click(screen.getByRole("button", { name: "Neuen Code erzeugen" }));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(rotateMock).not.toHaveBeenCalled();
  });

  it("rotates after confirming and shows the new code", async () => {
    getMock.mockResolvedValue(BADGE);
    rotateMock.mockResolvedValue(ROTATED);
    const spies = renderCard();
    const card = await face();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: "Neuen Code erzeugen" }));
    expect(await card.findByText("SMPL-P-0000000AAA")).toBeTruthy();
    expect(rotateMock).toHaveBeenCalledWith("t");
    // Gone everywhere, the print sheet included: printing now prints the new code.
    expect(screen.queryAllByText("SMPL-P-7KQ2M9XH4R")).toHaveLength(0);
    expect(spies.setNotice).toHaveBeenCalledWith(expect.stringContaining("alten Ausweis"));
  });

  it("prints this badge alone, then puts the page back", async () => {
    getMock.mockResolvedValue(BADGE);
    renderCard();
    await face();
    let duringPrint = { body: false, root: false, sheet: "" };
    vi.spyOn(window, "print").mockImplementation(() => {
      const root = document.querySelector(".station-badge-print-root");
      duringPrint = {
        body: document.body.classList.contains(PRINTING_CLASS),
        root: Boolean(root?.classList.contains("is-printing")),
        sheet: root?.textContent ?? "",
      };
      window.dispatchEvent(new Event("afterprint"));
    });
    fireEvent.click(screen.getByRole("button", { name: "Ausweis drucken" }));
    expect(duringPrint.body).toBe(true);
    expect(duringPrint.root).toBe(true);
    expect(duringPrint.sheet).toContain("Max Monteur");
    expect(duringPrint.sheet).toContain("SMPL-P-7KQ2M9XH4R");
    expect(document.body.classList.contains(PRINTING_CLASS)).toBe(false);
  });

  it("shows a failed load with a retry", async () => {
    getMock.mockRejectedValueOnce(new Error("Netzwerkfehler")).mockResolvedValueOnce(BADGE);
    renderCard();
    expect(await screen.findByText("Netzwerkfehler")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Erneut versuchen" }));
    expect((await face()).getByText("Max Monteur")).toBeTruthy();
    expect(getMock).toHaveBeenCalledTimes(2);
  });
});
