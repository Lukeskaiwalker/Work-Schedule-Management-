import type { CSSProperties } from "react";

/**
 * Canonical trade → colour mapping. Known German trades get a dedicated
 * badge palette; unrecognised trades fall back to the neutral slate entry.
 *
 * Keep this in sync with `PartnerTaskChip` and the `.partner-trade-pill--*`
 * class variants in `styles.css`. The lookup is intentionally case-insensitive
 * so free-text entry ("elektro" / "Elektro" / "ELEKTRO") renders the same.
 */
export const TRADE_COLOR_MAP: Record<string, { bg: string; fg: string; icon: string }> = {
  elektro: { bg: "#FEF3C7", fg: "#92400E", icon: "\u26A1" },
  sanitär: { bg: "#DBEAFE", fg: "#1E40AF", icon: "\uD83D\uDEB0" },
  sanitaer: { bg: "#DBEAFE", fg: "#1E40AF", icon: "\uD83D\uDEB0" },
  maler: { bg: "#EDE9FE", fg: "#5B21B6", icon: "\uD83C\uDFA8" },
  dach: { bg: "#FED7AA", fg: "#9A3412", icon: "\uD83C\uDFE0" },
  fliesen: { bg: "#CCFBF1", fg: "#115E59", icon: "\u25A6" },
  gartenbau: { bg: "#D1FAE5", fg: "#065F46", icon: "\uD83C\uDF31" },
};

const FALLBACK_TRADE = { bg: "#F1F5F9", fg: "#475569", icon: "\uD83D\uDD27" };

export function tradePalette(trade: string | null | undefined): {
  bg: string;
  fg: string;
  icon: string;
} {
  if (!trade) return FALLBACK_TRADE;
  const key = trade.trim().toLowerCase();
  return TRADE_COLOR_MAP[key] ?? FALLBACK_TRADE;
}

type Props = {
  trade: string | null | undefined;
  /** When true, only the coloured dot/icon is shown — useful inside dense
   *  chips on task rows. Defaults to false (pill with trade label). */
  compact?: boolean;
  /** Optional fallback label shown when `trade` is null (e.g. "—"). */
  emptyLabel?: string;
  title?: string;
};

/**
 * Small pill "⚡ Elektro" coloured from the TRADE_COLOR_MAP.
 */
export function PartnerTradePill({ trade, compact = false, emptyLabel, title }: Props) {
  const palette = tradePalette(trade);
  const label = (trade ?? emptyLabel ?? "").trim();
  const style: CSSProperties = { backgroundColor: palette.bg, color: palette.fg };
  const className = compact ? "partner-trade-pill partner-trade-pill--compact" : "partner-trade-pill";
  return (
    <span className={className} style={style} title={title ?? label ?? undefined}>
      <span className="partner-trade-pill-icon" aria-hidden="true">
        {palette.icon}
      </span>
      {!compact && label && <span className="partner-trade-pill-label">{label}</span>}
    </span>
  );
}
