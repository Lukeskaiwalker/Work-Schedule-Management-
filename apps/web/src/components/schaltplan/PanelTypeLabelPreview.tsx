/**
 * Schematic preview of the Schrank-Etikett — the silver 99 × 44 mm type
 * label (WAGO 210-804) stuck on the finished panel.
 *
 * The real layout is rendered server-side from the owner's blueprint; this
 * box only mirrors its proportions so the electrician sees what the fields
 * will say before the label leaves the printer. Logo and QR code are the
 * server's own renderings (`typeLabelLogoUrl` / `typeLabelQrUrl`), so the
 * only thing that differs from the print is the font. Positions live in
 * `styles.css` (`.sp-type-label*`), as percentages of the label.
 */
import { typeLabelLogoUrl, typeLabelQrUrl } from "../../utils/schaltplanApi";

type Props = {
  customer: string;
  projectNumber: string | null;
  buildMonth: string;
  contactLines: string[];
};

/** What the Projekt line shows for a panel without a project. */
const NO_PROJECT = "—";

export function PanelTypeLabelPreview({ customer, projectNumber, buildMonth, contactLines }: Props) {
  return (
    <div className="sp-type-label" aria-label="Vorschau Schrank-Etikett">
      <img className="sp-type-label-logo" src={typeLabelLogoUrl()} alt="SMPL-Logo" />
      <img className="sp-type-label-qr" src={typeLabelQrUrl()} alt="QR-Code smpl-energy.de" />
      <div className="sp-type-label-lines">
        <div>{`Kunde: ${customer}`}</div>
        <div>{`Projekt: ${projectNumber ?? NO_PROJECT}`}</div>
        <div>{`Baujahr: ${buildMonth}`}</div>
      </div>
      <div className="sp-type-label-contact">
        {contactLines.map((line, index) => (
          <div key={`${index}-${line}`}>{line}</div>
        ))}
      </div>
    </div>
  );
}
