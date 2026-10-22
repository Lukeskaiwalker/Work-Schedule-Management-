/**
 * Turning 2FA off must not cost the user their permissions on screen.
 *
 * `POST /auth/me/mfa/disable` answered the plain `UserOut` (no
 * `effective_permissions`), and the profile card handed that straight to
 * `setUser`: every permission-gated sidebar entry vanished until the next
 * reload. The API answers `UserMeOut` now (docs/DASHBOARD.md §4.4); the card
 * also merges, so a route that answers less can never wipe them again.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { AppContext } from "../context/AppContext";
import { makeAppContextStub } from "./appContextStub";
import { TwoFactorSection } from "../components/profile/TwoFactorSection";
import type { User } from "../types";

const SIGNED_IN: User = {
  id: 7,
  email: "mara.beispiel@example.com",
  full_name: "Mara Beispiel",
  display_name: "Mara Beispiel",
  role: "employee",
  is_active: true,
  required_daily_hours: 8,
  vacation_days_per_year: 30,
  vacation_days_available: 30,
  vacation_days_carryover: 0,
  vacation_days_total_remaining: 30,
  preferences: {},
  mfa_enabled: true,
  effective_permissions: ["time:clock", "projects:view"],
  can_update_recent_own_time_entries: true,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("TwoFactorSection disable", () => {
  it("keeps the permissions when the server's answer lacks them", async () => {
    // What the old route sent back: the account, minus the /me-only fields.
    const { effective_permissions: _p, can_update_recent_own_time_entries: _c, ...plain } = SIGNED_IN;
    const answer = { ...plain, mfa_enabled: false };
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify(answer), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const setUser = vi.fn();
    const context = makeAppContextStub({ overrides: { user: SIGNED_IN, setUser } });

    render(
      <AppContext.Provider value={context as never}>
        <TwoFactorSection />
      </AppContext.Provider>,
    );
    fireEvent.change(screen.getByLabelText("Aktuelles Passwort"), { target: { value: "beispiel-passwort" } });
    fireEvent.change(screen.getByLabelText("Code"), { target: { value: "123456" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Deaktivieren" }));
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("/api/auth/me/mfa/disable");
    expect(setUser).toHaveBeenCalledTimes(1);
    const stored = setUser.mock.calls[0]?.[0] as User;
    expect(stored.mfa_enabled).toBe(false);
    expect(stored.effective_permissions).toEqual(["time:clock", "projects:view"]);
    expect(stored.can_update_recent_own_time_entries).toBe(true);
  });
});
