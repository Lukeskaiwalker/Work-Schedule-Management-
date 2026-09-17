/**
 * Completing a task can be called off half-way, and that is not a failure.
 *
 * The "Was ist mit dem Rest passiert?" dialog sits inside an async chain with
 * two entry points, so "this person decided not to" has to survive all the way
 * up to the sentence on screen. It travels as a sentinel error — which is
 * exactly why it must never escape the app's own code: a page that renders
 * `err.message` would put `material-remainder-cancelled` in front of the
 * workshop.
 *
 * So the sentinel and the one place that swallows it live together here,
 * rather than as a string compared in four places in App.tsx.
 */

/** Thrown when somebody closes the settlement dialog instead of answering. */
export const REMAINDER_CANCELLED = "material-remainder-cancelled";

export function isRemainderCancelled(err: unknown): boolean {
  return err instanceof Error
    ? err.message === REMAINDER_CANCELLED
    : (err as { message?: unknown } | null)?.message === REMAINDER_CANCELLED;
}

/**
 * Run a completion, treating "closed the dialog" as a no-op.
 *
 * For callers that have nothing of their own to say about it — the completion
 * published on the app context is the one that matters: it is reached from
 * pages that know nothing about the dialog, and they may not be handed the
 * sentinel. Real failures still reject, with a message worth showing.
 */
export async function completeQuietly(run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch (err: unknown) {
    if (isRemainderCancelled(err)) return;
    throw err;
  }
}
