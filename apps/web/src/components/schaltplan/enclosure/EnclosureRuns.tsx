/**
 * The cabinet preparation's leads in the 2D drawing, open view only
 * (docs/PANEL_ENCLOSURE_R4.md §5): dashed, in screen px at every zoom.
 *
 * Drawn in two passes around the box labels (`EnclosureFrontSvg`): the lines
 * after the boxes and before every box label — whose halo then keeps the
 * meter number, the BMK, the rail name and "§14a" readable where a lead ends
 * on them — and the run labels last, each placed by `runLabelSpot` off the
 * box labels and inside the drawing.
 */
import type { PrepRun, PrepRunKind } from "../../../types/panelEnclosure";
import { SMALL_FONT_PX } from "./enclosureFrontLayout";
import type { RunLabelSpot } from "./enclosureRunLabels";

/** Dash and gap per lead, screen px: supply thin ink, network teal, control violet. */
export const RUN_DASH_PX: Readonly<Record<PrepRunKind, readonly [number, number]>> = {
  supply: [2, 2],
  network: [4, 3],
  control: [6, 4],
};
const RUN_WIDTH_PX: Readonly<Record<PrepRunKind, number>> = { supply: 1, network: 1.5, control: 1.5 };
const RUN_LABEL_HALO_PX = 3;

/** The leads' lines, in run order. */
export function RunLines({ runs, zoom }: { runs: readonly PrepRun[]; zoom: number }) {
  return (
    <g className="sp-encl-runs">
      {runs.map((run, i) => {
        const [dash, gap] = RUN_DASH_PX[run.kind];
        return (
          <g key={`${run.kind}:${i}`} data-run={run.kind} className={`sp-encl-run sp-encl-run--${run.kind}`}>
            <polyline
              className="sp-encl-run-line"
              points={run.points.map(([px, py]) => `${px},${py}`).join(" ")}
              strokeWidth={RUN_WIDTH_PX[run.kind] / zoom}
              strokeDasharray={`${dash / zoom} ${gap / zoom}`}
            />
          </g>
        );
      })}
    </g>
  );
}

/** The leads' labels at their spots (`runLabelSpots`), on a halo, drawn last. */
export function RunLabels({ runs, spots, zoom }: { runs: readonly PrepRun[]; spots: readonly (RunLabelSpot | null)[]; zoom: number }) {
  return (
    <g className="sp-encl-run-labels">
      {runs.map((run, i) => {
        const spot = spots[i];
        if (!spot) return null;
        return (
          <text
            key={`${run.kind}:${i}`}
            data-run-label={run.kind}
            className={`sp-encl-run-label sp-encl-run-label--${run.kind}`}
            x={spot.x}
            y={spot.y + spot.baseline}
            textAnchor="middle"
            fontSize={SMALL_FONT_PX / zoom}
            strokeWidth={RUN_LABEL_HALO_PX / zoom}
            transform={spot.vertical ? `rotate(-90 ${spot.x} ${spot.y})` : undefined}
          >
            {run.label}
          </text>
        );
      })}
    </g>
  );
}
