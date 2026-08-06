/**
 * ConstructionBoxPicker — pick the Baustellenkiste a task uses.
 *
 * Prop-driven and context-free (same shape as CustomerCombobox) because three
 * different task forms mount it, each with its own state slice.
 *
 * Grouping is computed server-side (`box.group`) so all three forms order and
 * label identically:
 *   customer — already this customer's crate, including one already on site
 *   free     — sitting unclaimed in the workshop rack
 *   other    — at a different customer; search-only, never offered by default
 *
 * Picking a box here is a pure association. It does NOT hand the crate over,
 * and it never moves stock — that stays a deliberate action in the Werkstatt.
 */
import type { SelectableConstructionBox } from "../../types";
import { boxOptionLabel } from "../../utils/boxes";

type Props = {
  language: string;
  boxes: SelectableConstructionBox[];
  loading: boolean;
  /** False when the task has no resolvable customer yet (no project picked). */
  customerResolved: boolean;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
};

const GROUP_LABELS: Record<string, { de: string; en: string }> = {
  customer: { de: "Kisten dieses Kunden", en: "Boxes for this customer" },
  free: { de: "Freie Kisten (Werkstattregal)", en: "Free boxes (workshop rack)" },
  other: { de: "Andere Kunden", en: "Other customers" },
};

const GROUP_ORDER = ["customer", "free", "other"] as const;

export function ConstructionBoxPicker({
  language,
  boxes,
  loading,
  customerResolved,
  value,
  onChange,
  disabled = false,
}: Props) {
  const de = language === "de";

  return (
    <div className="task-modal-box-picker">
      <select
        className="task-modal-input"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled}
      >
        <option value="">{de ? "Keine Kiste" : "No box"}</option>
        {GROUP_ORDER.map((group) => {
          const rows = boxes.filter((box) => box.group === group);
          if (rows.length === 0) return null;
          return (
            <optgroup
              key={`box-group-${group}`}
              label={de ? GROUP_LABELS[group].de : GROUP_LABELS[group].en}
            >
              {rows.map((box) => (
                <option key={`box-option-${box.id}`} value={String(box.id)}>
                  {boxOptionLabel(box, de)}
                </option>
              ))}
            </optgroup>
          );
        })}
      </select>

      {!customerResolved && (
        <small className="task-modal-box-hint">
          {de
            ? "Kein Kunde zugeordnet — es werden alle freien Kisten angezeigt."
            : "No customer linked — showing all free boxes."}
        </small>
      )}
      {!loading && boxes.length === 0 && (
        <small className="task-modal-box-hint">
          {de ? "Keine Kisten verfügbar." : "No boxes available."}
        </small>
      )}
    </div>
  );
}
