/**
 * Taking a user update from the server without losing what only /auth/me says.
 *
 * `effective_permissions` and `can_update_recent_own_time_entries` exist only
 * in the API's `UserMeOut`. Routes that answered the plain `UserOut` (the
 * preference PATCH, the profile PATCH, the 2FA disable — fixed server-side,
 * docs/DASHBOARD.md §4.4) made `setUser(updated)` wipe the permissions, and
 * every permission-gated entry vanished until the next reload. Every caller
 * that stores a user the server sent back goes through this, so a route that
 * answers less (an older API mid-deploy, one added later) cannot do it again.
 *
 * Tested in src/test/userUpdate.test.ts.
 */
import type { User } from "../types";

export function mergeUserUpdate(prev: User | null, next: User): User {
  // Another account's permissions are never "what we knew": a mismatch takes
  // the update as it stands.
  if (!prev || prev.id !== next.id) return { ...next };
  return {
    ...next,
    // Missing means "not said", so keep ours. An empty list is an answer
    // (permissions withdrawn) and wins.
    effective_permissions: next.effective_permissions ?? prev.effective_permissions,
    can_update_recent_own_time_entries:
      next.can_update_recent_own_time_entries ?? prev.can_update_recent_own_time_entries,
  };
}
