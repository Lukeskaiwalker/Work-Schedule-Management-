/**
 * "Automatisch ergänzt" under the cabinet findings (docs/PANEL_ENCLOSURE_R4.md
 * §8.4): what the cabinet preparation adds to the Materialliste on its own —
 * the Spannungsversorgung kit, the infeed, the busbar connectors, the network
 * lead, the §14a block with its wires and Lüsterklemme — in `cabinetPrep`'s
 * order, one 56 px row each: "{qty} × {art} {label}" (or "{qty} m {label}"),
 * the reason, and "ungeprüft" where the drawing guessed.
 *
 * Supply, infeed, connectors and network answer to a per-board override (a
 * VNB that wants the LS kit, a Werkstatt that brings its own lead): a compact
 * select, and the network lead's length. A group switched off stays listed,
 * struck through, with "Wieder automatisch". Hidden when nothing is derived.
 * The tab runs every choice as an op (`setPrepOverride`).
 */
import { UnverifiedBadge } from "./EnclosureSheetFrame";
import { LengthField } from "./LengthField";
import {
  MANUAL_OFF_TEXT,
  OVERRIDE_LABELS,
  OVERRIDE_OPTIONS,
  UNVERIFIED_PREP_TITLE,
  isManualOff,
  overrideKeyOf,
  prepItemLine,
  type OverrideKey,
} from "./prepListModel";
import type { PrepOverrideKey } from "../../../utils/enclosureOpsControlBlock";
import type { CabinetPrep, PrepItem } from "../../../types/panelEnclosure";
import "../../../styles/schaltplan-enclosure-control.css";

export const PREP_HEADING = "Automatisch ergänzt";

type OnOverride = (key: PrepOverrideKey, value: string | number | null) => void;

interface Props {
  prep: CabinetPrep | null;
  readOnly: boolean;
  onOverride: OnOverride;
}

function Controls({ item, overrideKey, networkM, readOnly, onOverride }: {
  item: PrepItem;
  overrideKey: OverrideKey;
  networkM: number | null;
  readOnly: boolean;
  onOverride: OnOverride;
}) {
  if (isManualOff(item)) {
    return (
      <div className="sp-encl-prep-controls">
        <button type="button" className="sp-btn sp-encl-target" disabled={readOnly} onClick={() => onOverride(overrideKey, "auto")}>
          Wieder automatisch
        </button>
      </div>
    );
  }
  return (
    <div className="sp-encl-prep-controls">
      <select
        aria-label={OVERRIDE_LABELS[overrideKey]}
        value={item.override ?? "auto"}
        disabled={readOnly}
        onChange={(event) => onOverride(overrideKey, event.target.value)}
      >
        {OVERRIDE_OPTIONS[overrideKey].map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      {overrideKey === "network" ? (
        <LengthField
          label="Länge"
          value={networkM}
          placeholder="automatisch"
          disabled={readOnly}
          onCommit={(metres) => onOverride("network_m", metres)}
        />
      ) : null}
    </div>
  );
}

function PrepRow({ item, networkM, readOnly, onOverride }: { item: PrepItem; networkM: number | null; readOnly: boolean; onOverride: OnOverride }) {
  const line = prepItemLine(item);
  const overrideKey = overrideKeyOf(item);
  return (
    <li className={`sp-encl-prep-item${item.suppressed ? " is-suppressed" : ""}`} data-key={item.key}>
      <div className="sp-encl-prep-text">
        <span className="sp-encl-prep-line">
          {`${line.qty} `}
          {line.articleNo ? (
            <>
              <b>{line.articleNo}</b>{" "}
            </>
          ) : null}
          {line.label}
        </span>
        <small>{item.reason}</small>
        {isManualOff(item) ? <span className="sp-encl-prep-off">{MANUAL_OFF_TEXT}</span> : null}
        {item.verified ? null : (
          <span>
            <UnverifiedBadge title={UNVERIFIED_PREP_TITLE} />
          </span>
        )}
      </div>
      {overrideKey ? <Controls item={item} overrideKey={overrideKey} networkM={networkM} readOnly={readOnly} onOverride={onOverride} /> : null}
    </li>
  );
}

export function EnclosurePrepList({ prep, readOnly, onOverride }: Props) {
  if (!prep || prep.items.length === 0) return null;
  return (
    <div className="sp-encl-prep">
      <h4>{PREP_HEADING}</h4>
      <ul className="sp-encl-prep-list" aria-label={PREP_HEADING}>
        {prep.items.map((item, i) => (
          <PrepRow key={`${item.key}#${i}`} item={item} networkM={prep.overrides.network_m} readOnly={readOnly} onOverride={onOverride} />
        ))}
      </ul>
    </div>
  );
}
