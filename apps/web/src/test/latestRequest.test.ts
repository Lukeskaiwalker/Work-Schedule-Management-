/**
 * The overview (view=my_all) and Meine Aufgaben (view=my) write different row
 * sets into the one `tasks` state. A slow overview fetch must not land its
 * done rows on the list after the list's own, later fetch already answered —
 * that is exactly the race the sequence exists for.
 */
import { describe, expect, it } from "vitest";
import { createRequestSequence } from "../utils/latestRequest";

describe("createRequestSequence", () => {
  it("issuing a ticket makes every earlier ticket stale", () => {
    const sequence = createRequestSequence();
    const first = sequence.issue();
    expect(sequence.isCurrent(first)).toBe(true);
    const second = sequence.issue();
    expect(sequence.isCurrent(first)).toBe(false);
    expect(sequence.isCurrent(second)).toBe(true);
    // A ticket nobody issued is never current.
    expect(sequence.isCurrent(0)).toBe(false);
  });

  it("lets only the newest response write, whatever order they resolve in", async () => {
    // Overview fetch issued first and slow; list fetch issued second and fast.
    const sequence = createRequestSequence();
    const writes: string[] = [];
    let releaseOverview: () => void = () => undefined;
    const overviewAnswered = new Promise<void>((resolve) => {
      releaseOverview = resolve;
    });

    async function load(view: string, answered: Promise<void>) {
      const ticket = sequence.issue();
      await answered;
      if (!sequence.isCurrent(ticket)) return;
      writes.push(view);
    }

    const slowOverview = load("my_all", overviewAnswered);
    const fastList = load("my", Promise.resolve());
    await fastList;
    releaseOverview();
    await slowOverview;

    expect(writes).toEqual(["my"]);
  });

  it("is transparent for sequential awaits: each request completes before the next ticket exists", async () => {
    const sequence = createRequestSequence();
    const writes: string[] = [];
    for (const view of ["my", "my_all", "projects_overview"]) {
      const ticket = sequence.issue();
      await Promise.resolve();
      if (sequence.isCurrent(ticket)) writes.push(view);
    }
    expect(writes).toEqual(["my", "my_all", "projects_overview"]);
  });
});
