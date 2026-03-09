import { WEATHER_DESCRIPTION_DE_LABELS } from "../constants";
import type { Language } from "../types";

export function weatherDescriptionLabel(description: string | null | undefined, language: Language) {
  const raw = String(description ?? "").trim();
  if (!raw) return "";
  if (language !== "de") return raw;
  const normalized = raw.toLowerCase();
  const direct = WEATHER_DESCRIPTION_DE_LABELS[normalized];
  if (direct) return direct;
  return raw
    .split(/\s+/)
    .map((part) => {
      const leading = part.match(/^[^a-zA-Z0-9]+/)?.[0] ?? "";
      const trailing = part.match(/[^a-zA-Z0-9]+$/)?.[0] ?? "";
      const core = part.replace(/^[^a-zA-Z0-9]+|[^a-zA-Z0-9]+$/g, "");
      if (!core) return part;
      const translated = WEATHER_DESCRIPTION_DE_LABELS[core.toLowerCase()] ?? core;
      return `${leading}${translated}${trailing}`;
    })
    .filter((part) => part.trim().length > 0)
    .join(" ");
}
