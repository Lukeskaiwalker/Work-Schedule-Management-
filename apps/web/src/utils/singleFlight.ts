/**
 * At most one run of an async refresh at a time.
 *
 * A page refresh is asked for from several places at once: the poll, a save
 * that wants the result of its save, an SSE event, a filter change. Started
 * independently they overlap — the same requests in flight twice, and whichever
 * answers last wins, which need not be the newest. Through this they don't.
 *
 * - `run()` starts now when idle. During a run it starts exactly one more
 *   right after it (however many callers ask) and hands every caller that
 *   follow-up, so a caller that just saved always gets data fetched after its
 *   save, and a burst of askers costs one extra refresh, not one each.
 * - `runIfIdle()` starts now when idle and otherwise rides along with the run
 *   in flight. For the poll: data being fetched right now is fresh enough, and
 *   queueing behind a slow server would turn the poll into a busy loop.
 *
 * A failed run rejects its own callers and leaves the flight idle.
 */
export type SingleFlight = {
  run: () => Promise<void>;
  runIfIdle: () => Promise<void>;
};

export function createSingleFlight(task: () => Promise<unknown>): SingleFlight {
  let current: Promise<void> | null = null;
  let followUp: Promise<void> | null = null;

  function start(): Promise<void> {
    // The task starts on a microtask, after `current` is set, so even a task
    // that throws synchronously goes through the bookkeeping below.
    const running: Promise<void> = Promise.resolve()
      .then(task)
      .then(() => undefined)
      .finally(() => {
        if (current === running) current = null;
      });
    current = running;
    return running;
  }

  function run(): Promise<void> {
    if (!current) return start();
    if (!followUp) {
      followUp = current
        .catch(() => undefined)
        .then(() => {
          followUp = null;
          return start();
        });
    }
    return followUp;
  }

  function runIfIdle(): Promise<void> {
    return followUp ?? current ?? start();
  }

  return { run, runIfIdle };
}
