/**
 * The words on the Kalender-Abo card that are derived from data: which
 * calendar app fetched the link, and when.
 *
 * Kept apart from the component so the mapping can be pinned in a test
 * without rendering, and so the component file stays about states and
 * actions.
 */
import type { Language } from "../../types";
import { parseServerDateTime } from "../../utils/dates";

/** Longer raw agents are cut here — nobody reads a full browser UA on a profile card. */
const RAW_AGENT_MAX_CHARS = 48;

/**
 * A calendar app's User-Agent as a name a person recognises.
 *
 * Apple's calendar daemon identifies itself as "dataaccessd" (iPhone, iPad
 * and Mac alike); Google's importer and Microsoft's Exchange/Outlook fetchers
 * carry their brand. Brands are checked before the platform: the Outlook app
 * on an iPhone says "Outlook-iOS", and it is Outlook that polls, not the
 * system calendar. Anything else is shown as sent, shortened.
 */
export function friendlyFetchAgent(agent: string | null): string | null {
  const raw = (agent ?? "").trim();
  if (!raw) return null;
  const lower = raw.toLowerCase();
  if (lower.includes("google")) return "Google Kalender";
  if (lower.includes("outlook") || lower.includes("microsoft")) return "Outlook";
  if (/\bios\b/.test(lower) || lower.includes("dataaccessd")) return "iPhone/iPad-Kalender";
  if (raw.length <= RAW_AGENT_MAX_CHARS) return raw;
  return `${raw.slice(0, RAW_AGENT_MAX_CHARS - 1).trimEnd()}…`;
}

/**
 * "24.09.2026, 18:31" — two-digit day and month, no seconds. The server's
 * naive timestamps are UTC; `parseServerDateTime` pins that so the card shows
 * the user's local time.
 */
export function formatFetchedAt(value: string | null, language: Language): string {
  const parsed = parseServerDateTime(value);
  if (!parsed) return value ?? "";
  return parsed.toLocaleString(language === "de" ? "de-DE" : "en-US", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** "12 Abrufe", "1 Abruf". */
export function fetchCountLabel(count: number): string {
  return count === 1 ? "1 Abruf" : `${count} Abrufe`;
}
