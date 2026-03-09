import type { Language, CompactNameParts } from "../types";

export function initialsFromName(name: string, fallback: string) {
  const parts = (name || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (parts.length === 0) return fallback;
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
}

export function splitCompactNameParts(name: string): CompactNameParts {
  const parts = (name || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (parts.length === 0) return { first: "", lastInitial: "" };
  const first = parts[0];
  const last = parts.length > 1 ? parts[parts.length - 1] : "";
  return { first, lastInitial: last ? last[0].toUpperCase() : "" };
}

export function compactNameLabel(name: string, withLastInitial: boolean): string {
  const parts = splitCompactNameParts(name);
  if (!parts.first) return "";
  if (withLastInitial && parts.lastInitial) return `${parts.first} ${parts.lastInitial}.`;
  return parts.first;
}

export function buildCompactUserNameMap(entries: Array<{ id: number; name: string }>): Map<number, string> {
  const distinctEntries = new Map<number, string>();
  entries.forEach(({ id, name }) => {
    if (!distinctEntries.has(id)) {
      distinctEntries.set(id, name);
    }
  });

  const firstNameCounts = new Map<string, number>();
  const partsByUserId = new Map<number, CompactNameParts>();
  distinctEntries.forEach((name, userId) => {
    const parts = splitCompactNameParts(name);
    partsByUserId.set(userId, parts);
    if (!parts.first) return;
    const key = parts.first.toLowerCase();
    firstNameCounts.set(key, (firstNameCounts.get(key) ?? 0) + 1);
  });

  const result = new Map<number, string>();
  distinctEntries.forEach((name, userId) => {
    const parts = partsByUserId.get(userId);
    if (!parts || !parts.first) {
      result.set(userId, name.trim() || `#${userId}`);
      return;
    }
    const duplicateFirstName = (firstNameCounts.get(parts.first.toLowerCase()) ?? 0) > 1;
    result.set(userId, compactNameLabel(name, duplicateFirstName));
  });
  return result;
}

export function preferredDisplayName(entry: { display_name?: string | null; full_name?: string | null }): string {
  return String(entry.display_name ?? entry.full_name ?? "").trim();
}
