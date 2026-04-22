import type { Partner } from "../../types";
import { PartnerTradePill, tradePalette } from "./PartnerTradePill";

type Props = {
  partners: ReadonlyArray<Partner>;
  language: "de" | "en";
};

/**
 * Compact chip for task row listings. Shows the first partner as
 * "{icon} {name}" and collapses the rest into a "+N" overflow chip so the
 * chip never blows past ~180px of horizontal space.
 */
export function PartnerTaskChip({ partners, language }: Props) {
  if (!partners || partners.length === 0) return null;
  const first = partners[0];
  if (!first) return null;
  const palette = tradePalette(first.trade);
  const rest = partners.length - 1;
  const de = language === "de";
  const title = partners
    .map((partner) => `${partner.trade ?? (de ? "Partner" : "Partner")}: ${partner.name}`)
    .join("\n");
  return (
    <span className="partner-task-chip" style={{ backgroundColor: palette.bg, color: palette.fg }} title={title}>
      <span className="partner-task-chip-icon" aria-hidden="true">
        {palette.icon}
      </span>
      <span className="partner-task-chip-name">{first.name}</span>
      {rest > 0 && (
        <span className="partner-task-chip-overflow" aria-label={de ? `und ${rest} weitere` : `and ${rest} more`}>
          +{rest}
        </span>
      )}
    </span>
  );
}

export { PartnerTradePill };
