import type { Language } from "../types";

/**
 * A user's role as people read it — the one name per role the whole app uses.
 *
 * The sidebar, the profile, the team calendar and the worker picker used to
 * print the stored key ("employee", "ceo") and the admin centre and the team
 * tab each kept a map of their own that disagreed on the Geschäftsführung.
 * The keys are the API's role values and never change; only the label does.
 * (Chat role groups say it in the plural — see `roleOptionLabel`.)
 */
export const ROLE_KEYS = ["admin", "ceo", "accountant", "planning", "employee", "external"] as const;

const ROLE_LABELS: Record<(typeof ROLE_KEYS)[number], { de: string; en: string }> = {
  admin: { de: "Admin", en: "Admin" },
  ceo: { de: "Geschäftsführung", en: "CEO" },
  accountant: { de: "Buchhaltung", en: "Accountant" },
  planning: { de: "Planung", en: "Planning" },
  employee: { de: "Mitarbeiter", en: "Employee" },
  // A subcontractor's login for the partner portal.
  external: { de: "Partner", en: "Partner" },
};

export function isKnownRole(role: string | null | undefined): boolean {
  const key = String(role ?? "").trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(ROLE_LABELS, key);
}

/** "Mitarbeiter" for "employee"; an unknown role shows as stored, none as a dash. */
export function roleLabel(role: string | null | undefined, language: Language): string {
  const raw = String(role ?? "").trim();
  if (!raw) return "—";
  const key = raw.toLowerCase();
  if (!isKnownRole(key)) return raw;
  const entry = ROLE_LABELS[key as (typeof ROLE_KEYS)[number]];
  return language === "de" ? entry.de : entry.en;
}
