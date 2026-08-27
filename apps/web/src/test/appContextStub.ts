/**
 * A stand-in for the app context, good enough to render a page.
 *
 * `AppContextValue` has several hundred members — every page's data, every
 * setter, every handler. Writing that out by hand would be a second copy of
 * the app to maintain, and it would rot the first time somebody added a field.
 *
 * So it is a Proxy that answers any property with something harmless, chosen
 * from the name. The point is not fidelity: it is that a page can mount and
 * run its hooks without exploding on `undefined.map`. Anything a specific test
 * genuinely cares about is passed in `overrides` and wins over the guesses.
 */

const NOOP = () => undefined;

/**
 * Keys whose value is read as a list.
 *
 * Suffix first, then the bare plural. The suffix list exists because the
 * plural rule alone gets both kinds of answer wrong: `officeTaskStatusOptions`
 * is a list whose name contains "Status", and `reportsWindow` is a list that
 * does not end in "s" at all. Excluding on a substring match was what broke
 * the first of those, so the singular exclusions are anchored to the end.
 */
const COLLECTION_SUFFIX = /(Options|List|Rows|Items|Entries|Window|Ids|Map)$/;
const NOT_A_PLURAL = /(status|address|progress|success|class|focus|Loading|Access)$/i;

function looksLikeCollection(key: string): boolean {
  if (COLLECTION_SUFFIX.test(key)) return true;
  return /s$/.test(key) && !NOT_A_PLURAL.test(key) && !/^is[A-Z]/.test(key);
}

function guess(key: string): unknown {
  // Setters and handlers: called, never read.
  if (/^(set|on|handle|open|close|toggle|submit|save|delete|remove|add|create|refresh|reload|load|send|start|stop|cancel|confirm|apply|clear|reset|select|update|print|export|import)[A-Z]/.test(key)) {
    return NOOP;
  }
  if (/^(is|has|can|should|show|use)[A-Z]/.test(key) || /(Open|Loading|Enabled|Disabled|Visible|Busy|Pending|Dirty|Valid)$/.test(key)) {
    return false;
  }
  // Numbers BEFORE collections: "gaugeNetHours" ends in "s", so the plural
  // rule claims it first and hands back an array that formatHours cannot
  // use. Specific suffixes have to beat the generic plural.
  // Anything arithmetic or formatted as a number. `formatHours(undefined)`
  // throws inside a helper, several frames from the page that passed it.
  if (/(Count|Total|Index|Page|Limit|Offset|Hours|Minutes|Seconds|Amount|Sum|Qty|Quantity|Percent|Balance)$/.test(key)) {
    return 0;
  }
  // Form/draft state is read field-by-field, and those fields have shapes of
  // their own: `schoolAbsenceForm.recurrence_weekdays.includes(...)` needs two
  // levels, not one. Returning another guessing proxy means nested reads get
  // the same treatment, lazily and to any depth, instead of this file growing
  // a case per form field.
  if (/(Form|Draft|Payload|Settings|Config|Prefs)$/.test(key)) return guessingProxy();
  if (looksLikeCollection(key)) return [];
  if (/(Ref)$/.test(key)) return { current: null };
  // A real Date only where the page calls Date methods on it — a month cursor
  // is stepped and compared. Everything else date-shaped is an ISO string in
  // this app (`due_date`, `created_at`), and it is usually rendered directly:
  // handing back a Date object there fails with "Objects are not valid as a
  // React child", which looks like a page bug and is not one.
  if (/Cursor$/.test(key)) return new Date("2026-08-27T12:00:00Z");
  if (/(Date|At)$/.test(key)) return "2026-08-27T12:00:00Z";
  // Everything else reads as "absent", which most render paths already handle
  // because these fields are legitimately empty before data loads.
  return undefined;
}

/**
 * An object that answers every property with a guess, and remembers it.
 *
 * The remembering matters more than it looks: a fresh `[]` on every read makes
 * every useMemo and useEffect dependency compare unequal, so effects re-run
 * forever and the test hangs rather than fails.
 */
function guessingProxy(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const cache = new Map<string, unknown>();
  return new Proxy({} as Record<string, unknown>, {
    get(_target, prop) {
      if (typeof prop !== "string") return undefined;
      if (prop in overrides) return overrides[prop];
      if (!cache.has(prop)) cache.set(prop, guess(prop));
      return cache.get(prop);
    },
    has: () => true,
  });
}


export interface StubOptions {
  /** Explicit values. Always win over the guesses. */
  overrides?: Record<string, unknown>;
}

export function makeAppContextStub(options: StubOptions = {}): unknown {
  const overrides = {
    // Sensible for every page: a logged-in German admin with no data yet.
    language: "de",
    token: "test-token",
    user: { id: 1, email: "test@example.com", role: "admin", display_name: "Test" },
    now: new Date("2026-08-27T12:00:00Z"),
    setError: NOOP,
    setNotice: NOOP,
    ...options.overrides,
  } as Record<string, unknown>;

  return guessingProxy(overrides);
}
