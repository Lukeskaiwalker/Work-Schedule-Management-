/**
 * Only the newest request may write.
 *
 * `tasks` in App.tsx is one state that several views fill with different row
 * sets: the overview loads my_all (done rows of the last 30 days included),
 * Meine Aufgaben loads my (open only), a project tab loads its own list. Two
 * fetches in flight resolve in any order, and without a guard the OLDER one
 * lands last — a slow overview response would put ERLEDIGT rows on a list
 * that never loads them, until the next refresh happened to fix it.
 *
 * Each request takes a ticket before it starts; issuing a ticket invalidates
 * every earlier one, so a response checks its ticket and drops itself when a
 * newer request has been issued meanwhile. Sequential `await`s are unaffected:
 * each completes before the next ticket exists.
 */
export type RequestSequence = {
  /** Take the next ticket. Every ticket issued before it is now stale. */
  issue: () => number;
  /** True while no newer ticket has been issued. */
  isCurrent: (ticket: number) => boolean;
};

export function createRequestSequence(): RequestSequence {
  let latest = 0;
  return {
    issue: () => {
      latest += 1;
      return latest;
    },
    isCurrent: (ticket) => ticket === latest,
  };
}
