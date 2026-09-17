/**
 * Closing the settlement dialog is a decision, not an error message.
 *
 * `completeTask` is published on the app context, and its rejection used to be
 * the raw sentinel `Error("material-remainder-cancelled")` — translated only
 * by the two callers inside App.tsx. The first page to call `ctx.completeTask`
 * and show `err.message` would have put that literal string in front of the
 * workshop every time somebody closed the dialog.
 */
import { describe, expect, it, vi } from "vitest";

import {
  REMAINDER_CANCELLED,
  completeQuietly,
  isRemainderCancelled,
} from "../utils/taskCompletion";

describe("completeQuietly", () => {
  it("resolves when the person closed the dialog", async () => {
    const run = vi.fn(async () => {
      throw new Error(REMAINDER_CANCELLED);
    });
    await expect(completeQuietly(run)).resolves.toBeUndefined();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("still rejects on a real failure, with the message worth showing", async () => {
    const run = vi.fn(async () => {
      throw new Error("Task was changed in the meantime");
    });
    await expect(completeQuietly(run)).rejects.toThrow("Task was changed in the meantime");
  });

  it("passes a successful completion straight through", async () => {
    await expect(completeQuietly(async () => "Rest bleibt in K3")).resolves.toBeUndefined();
  });
});

describe("isRemainderCancelled", () => {
  it("recognises the sentinel, and nothing else", () => {
    expect(isRemainderCancelled(new Error(REMAINDER_CANCELLED))).toBe(true);
    expect(isRemainderCancelled(new Error("HTTP 409"))).toBe(false);
  });

  it("survives a non-Error rejection", () => {
    // `apiFetch` rejects with an ApiError, but a cancelled fetch or a stray
    // string reaches the same catch — none of them may crash the branch.
    expect(isRemainderCancelled({ message: REMAINDER_CANCELLED })).toBe(true);
    expect(isRemainderCancelled(null)).toBe(false);
    expect(isRemainderCancelled("boom")).toBe(false);
  });
});
