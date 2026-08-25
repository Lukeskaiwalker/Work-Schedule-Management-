/**
 * The Stromkreisliste — the sheet that gets glued inside the panel door.
 *
 * Derived, never entered: every value here already exists on a device, so the
 * legend cannot drift from the drawing. That is the whole reason the editor
 * stores a structured document instead of a canvas.
 *
 * Two renderings of the same rows. Below 768 px each circuit becomes a card,
 * because a nine-column table on a phone is either a horizontal scroll nobody
 * finds or a 6 px font. The card keeps the same reading order: number, what it
 * feeds, then how it is protected and wired.
 */
import type { PanelLegendRow } from "../../types/schaltplan";

type Props = {
  rows: PanelLegendRow[];
};

export function LegendTable({ rows }: Props) {
  if (rows.length === 0) {
    return (
      <p className="sp-legend-empty">
        Noch keine Stromkreise. Sobald du Leitungsschutzschalter oder andere Abgänge einträgst,
        entsteht die Legende hier automatisch.
      </p>
    );
  }

  return (
    <>
      <table className="sp-legend-table">
        <thead>
          <tr>
            <th scope="col">Nr.</th>
            <th scope="col">BMK</th>
            <th scope="col">Verbraucher / Bezeichnung</th>
            <th scope="col">Raum</th>
            <th scope="col">Gerät</th>
            <th scope="col">Absicherung</th>
            <th scope="col">FI / RCD</th>
            <th scope="col">Leitung</th>
            <th scope="col">Ph.</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={`${row.circuit}-${row.designation}-${index}`}>
              <td className="sp-legend-nr">{row.circuit || "—"}</td>
              <td>{row.designation || "—"}</td>
              <td className="sp-legend-label">{row.label || "—"}</td>
              <td>{row.room || "—"}</td>
              <td>{row.device}</td>
              <td>{row.rating || "—"}</td>
              <td className={row.rcd === "—" ? "sp-legend-norcd" : undefined}>{row.rcd}</td>
              <td>{row.cable || "—"}</td>
              <td>{row.phase || "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <ul className="sp-legend-cards">
        {rows.map((row, index) => (
          <li key={`card-${row.circuit}-${index}`} className="sp-legend-card">
            <div className="sp-legend-card-head">
              <span className="sp-legend-card-nr">{row.circuit || "—"}</span>
              <div>
                <b>{row.label || "Ohne Bezeichnung"}</b>
                <small>{[row.room, row.designation].filter(Boolean).join(" · ") || "—"}</small>
              </div>
            </div>
            <dl className="sp-legend-card-grid">
              <div>
                <dt>Gerät</dt>
                <dd>{row.device}</dd>
              </div>
              <div>
                <dt>Absicherung</dt>
                <dd>{row.rating || "—"}</dd>
              </div>
              <div>
                <dt>FI / RCD</dt>
                <dd className={row.rcd === "—" ? "sp-legend-norcd" : undefined}>{row.rcd}</dd>
              </div>
              <div>
                <dt>Phase</dt>
                <dd>{row.phase || "—"}</dd>
              </div>
              <div className="sp-legend-card-wide">
                <dt>Leitung</dt>
                <dd>{row.cable || "—"}</dd>
              </div>
            </dl>
          </li>
        ))}
      </ul>
    </>
  );
}
