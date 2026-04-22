/**
 * AvailabilityBadge — shared availability pill used by the Inventar row
 * (Desktop FE) and the Artikel-Detail header (Mobile FE).
 *
 * Visual variants (all pill-shaped, bilingual via the `de` prop):
 *   ┌──────────────────────────────┐
 *   │ green  — "Verfügbar · N"      │  stockAvailable > 0
 *   │ amber  — "Wieder ab 28. Apr"  │  stockAvailable === 0 && nextExpected set
 *   │ red    — "Nicht verfügbar"    │  stockAvailable === 0 && no ETA
 *   └──────────────────────────────┘
 *
 * Uses the same colour tokens as `.werkstatt-stock-pill--low/out` so it
 * composes visually with the surrounding Werkstatt surface.
 *
 * Immutable props, no internal state, no side effects — safe to drop into
 * any list row or detail header.
 */
export interface AvailabilityBadgeProps {
  /** ISO timestamp of the next pending/confirmed order-line delivery, if any. */
  nextExpectedDeliveryAt: string | null;
  /** Current on-hand count minus reservations — what a user can pick up today. */
  stockAvailable: number;
  /** Render German labels when true, English otherwise. */
  de: boolean;
  /** Optional override for the unit noun shown after the count ("Stk", "Paar"). */
  unit?: string | null;
}

type BadgeTone = "available" | "eta" | "unavailable";

interface ResolvedBadge {
  tone: BadgeTone;
  label: string;
}

/**
 * Format an ISO date into a compact German-style day + month label
 * ("28. Apr") or an English short label ("Apr 28"). Returns null if the
 * input is not a parseable date.
 */
function formatShortDate(iso: string, de: boolean): string | null {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return null;
  const locale = de ? "de-DE" : "en-US";
  return parsed.toLocaleDateString(locale, {
    day: "numeric",
    month: "short",
  });
}

function resolveBadge(
  stockAvailable: number,
  nextExpectedDeliveryAt: string | null,
  unit: string | null | undefined,
  de: boolean,
): ResolvedBadge {
  if (stockAvailable > 0) {
    const unitSuffix = unit ? ` ${unit}` : "";
    return {
      tone: "available",
      label: de
        ? `Verfügbar · ${stockAvailable}${unitSuffix}`
        : `Available · ${stockAvailable}${unitSuffix}`,
    };
  }

  if (nextExpectedDeliveryAt) {
    const shortDate = formatShortDate(nextExpectedDeliveryAt, de);
    if (shortDate) {
      return {
        tone: "eta",
        label: de
          ? `Wieder verfügbar ab ${shortDate}`
          : `Available again from ${shortDate}`,
      };
    }
  }

  return {
    tone: "unavailable",
    label: de ? "Nicht verfügbar" : "Unavailable",
  };
}

export function AvailabilityBadge({
  nextExpectedDeliveryAt,
  stockAvailable,
  de,
  unit = null,
}: AvailabilityBadgeProps) {
  const { tone, label } = resolveBadge(
    stockAvailable,
    nextExpectedDeliveryAt,
    unit,
    de,
  );

  return (
    <span
      className={`werkstatt-availability-badge werkstatt-availability-badge--${tone}`}
    >
      <span
        className={`werkstatt-availability-dot werkstatt-availability-dot--${tone}`}
        aria-hidden="true"
      />
      {label}
    </span>
  );
}
