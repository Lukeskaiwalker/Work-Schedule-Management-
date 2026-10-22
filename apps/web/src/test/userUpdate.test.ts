/**
 * Taking a user update from the server without losing what only /auth/me says.
 *
 * `effective_permissions` and `can_update_recent_own_time_entries` are only in
 * `UserMeOut`. Until the API fix (docs/DASHBOARD.md §4.4) the preference PATCH,
 * the profile PATCH and the 2FA disable answered the plain `UserOut`, and
 * `setUser(updated)` then wiped the permissions: the sidebar lost every
 * permission-gated entry until the next reload. The server answers the full
 * shape now; `mergeUserUpdate` keeps the client safe from any route that does
 * not (an older API during a staged deploy, a route added later).
 */
import { describe, expect, it } from "vitest";
import type { User } from "../types";
import { mergeUserUpdate } from "../utils/userUpdate";

function user(overrides: Partial<User> = {}): User {
  return {
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
    ...overrides,
  };
}

describe("mergeUserUpdate", () => {
  it("keeps the permissions it had when the update lacks them", () => {
    const prev = user({ effective_permissions: ["time:clock", "tasks:view_own"], can_update_recent_own_time_entries: true });
    const { effective_permissions: _p, can_update_recent_own_time_entries: _c, ...plain } = prev;
    const next = { ...plain, full_name: "Mara Neu" } as User;

    const merged = mergeUserUpdate(prev, next);

    expect(merged.effective_permissions).toEqual(["time:clock", "tasks:view_own"]);
    expect(merged.can_update_recent_own_time_entries).toBe(true);
    // Everything the update does say wins.
    expect(merged.full_name).toBe("Mara Neu");
  });

  it("takes the update's permissions when it has them, an empty list included", () => {
    const prev = user({ effective_permissions: ["time:clock"], can_update_recent_own_time_entries: true });
    const withNew = user({ effective_permissions: ["time:clock", "projects:view"], can_update_recent_own_time_entries: false });
    expect(mergeUserUpdate(prev, withNew).effective_permissions).toEqual(["time:clock", "projects:view"]);
    expect(mergeUserUpdate(prev, withNew).can_update_recent_own_time_entries).toBe(false);

    // A withdrawn permission set is an answer, not a gap: keeping the old one
    // would show entries the server now refuses.
    const withdrawn = user({ effective_permissions: [], can_update_recent_own_time_entries: false });
    expect(mergeUserUpdate(prev, withdrawn).effective_permissions).toEqual([]);
  });

  it("takes the update as it is when there is nothing to keep", () => {
    const next = user({ full_name: "Mara Neu" });
    expect(mergeUserUpdate(null, next)).toEqual(next);
  });

  it("never carries one account's permissions over to another", () => {
    const prev = user({ id: 7, effective_permissions: ["permissions:manage"], can_update_recent_own_time_entries: true });
    const other = user({ id: 8, email: "tom.muster@example.com" });
    const merged = mergeUserUpdate(prev, other);
    expect(merged.effective_permissions).toBeUndefined();
    expect(merged.can_update_recent_own_time_entries).toBeUndefined();
  });

  it("returns a new object and changes neither input", () => {
    const prev = user({ effective_permissions: ["time:clock"] });
    const next = user({ full_name: "Mara Neu" });
    const prevBefore = structuredClone(prev);
    const nextBefore = structuredClone(next);

    const merged = mergeUserUpdate(prev, next);

    expect(merged).not.toBe(prev);
    expect(merged).not.toBe(next);
    expect(prev).toEqual(prevBefore);
    expect(next).toEqual(nextBefore);
  });
});
