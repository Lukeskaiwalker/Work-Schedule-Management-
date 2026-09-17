/**
 * "Was ist mit dem Rest passiert?" — asked once, when a task is completed and
 * its crate did not come back empty.
 *
 * The question is real work, not a confirmation: until now the leftovers were
 * silently booked back onto the shelf and the crate was wiped, which is only
 * one of the three things a workshop does with them. The other two — leave the
 * rest packed for the same customer, or move it into a fresh crate — had no
 * way of being expressed at all.
 *
 * Deliberately NOT shown for every completion. The client reads
 * GET /tasks/{id}/material-settlement first and only opens this when
 * `needs_decision` is true, so ticking off an ordinary task stays one click.
 *
 * The ledger is the same whichever card is chosen (used is written off, the
 * rest comes back into the workshop); what differs is which crate the rest
 * sits in afterwards. That is why the hints below talk about crates and not
 * about stock.
 */
import { useEffect, useState } from "react";

import type {
  MaterialRemainderChoice,
  MaterialRemainderDisposition,
  MaterialSettlementPreview,
} from "../../types/taskSettlement";
import "../../styles/boxes.css";

type Props = {
  preview: MaterialSettlementPreview;
  language: string;
  onCancel: () => void;
  onConfirm: (choice: MaterialRemainderChoice) => void;
};

/** "Rest K3 – Musterbau GmbH" — what the new crate is called unless renamed. */
export function defaultNewBoxLabel(preview: MaterialSettlementPreview): string {
  const box = preview.box;
  if (!box) return "";
  return box.customer_name ? `Rest ${box.box_number} – ${box.customer_name}` : `Rest ${box.box_number}`;
}

const OPTIONS: MaterialRemainderDisposition[] = ["same_box", "new_box", "shelf"];

export function MaterialRemainderDialog({ preview, language, onCancel, onConfirm }: Props) {
  const de = language === "de";
  const box = preview.box;
  const [disposition, setDisposition] = useState<MaterialRemainderDisposition>("same_box");
  const [newBoxLabel, setNewBoxLabel] = useState(() => defaultNewBoxLabel(preview));

  // A second completion in the same session gets the new crate's own suggested
  // name, not the previous one's.
  useEffect(() => {
    setNewBoxLabel(defaultNewBoxLabel(preview));
    setDisposition("same_box");
  }, [preview]);

  if (!box) return null;

  const trimmedLabel = newBoxLabel.trim();
  const blocked = disposition === "new_box" && trimmedLabel.length === 0;
  const boxName = `${box.box_number} – ${box.label}`;
  const optionText: Record<MaterialRemainderDisposition, { title: string; hint: string }> = {
    same_box: {
      title: de ? "Zurück in dieselbe Kiste" : "Back into the same box",
      hint: de
        ? `${box.box_number} bleibt ${box.customer_name ?? "dem Kunden"} zugewiesen und steht gepackt im Regal.`
        : `${box.box_number} stays assigned to ${box.customer_name ?? "the customer"} and waits packed on the rack.`,
    },
    new_box: {
      title: de ? "In eine neue Kiste" : "Into a new box",
      hint: de
        ? `${box.box_number} wird frei, der Rest zieht in eine neue Kiste für denselben Kunden.`
        : `${box.box_number} is freed; the rest moves into a new box for the same customer.`,
    },
    shelf: {
      title: de ? "Zurück ins Lagerregal" : "Back to the storage racks",
      hint: de
        ? `Der Rest wird eingelagert, ${box.box_number} wird geleert.`
        : `The rest is stored away and ${box.box_number} is emptied.`,
    },
  };

  return (
    <div className="modal-backdrop" role="presentation" onClick={onCancel}>
      <section
        className="card modal-card boxes-remainder-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="material-remainder-title"
        onClick={(event) => event.stopPropagation()}
      >
        <h3 id="material-remainder-title">
          {de ? "Was ist mit dem Rest passiert?" : "What happened to the rest?"}
        </h3>
        <p className="muted boxes-remainder-sub">
          {de
            ? `Aus ${boxName}${box.customer_name ? ` (${box.customer_name})` : ""} wurden nicht alle Positionen verbraucht.`
            : `Not everything from ${boxName}${box.customer_name ? ` (${box.customer_name})` : ""} was used up.`}
        </p>

        {preview.handover_pending && (
          <p className="boxes-remainder-note">
            {de
              ? "Die Übergabe dieser Kiste wurde nie gebucht – sie wird beim Abschluss nachgebucht."
              : "This box was never booked out — the handover is recorded on completion."}
          </p>
        )}

        <div className="boxes-remainder-table-wrap">
          <table className="boxes-remainder-table">
            <thead>
              <tr>
                <th scope="col">{de ? "Artikel" : "Item"}</th>
                <th scope="col">{de ? "Gepackt" : "Packed"}</th>
                <th scope="col">{de ? "Verbraucht" : "Used"}</th>
                <th scope="col">{de ? "Rest" : "Left"}</th>
              </tr>
            </thead>
            <tbody>
              {preview.lines.map((line) => (
                <tr key={`remainder-line-${line.id}`}>
                  <td>
                    {line.item_name}
                    {line.unit ? <small className="muted"> {line.unit}</small> : null}
                  </td>
                  <td>{line.quantity}</td>
                  {/* A reported zero and "nobody said" are different facts and
                      must not render the same way. */}
                  <td>{line.quantity_used ?? "–"}</td>
                  <td className={line.remainder > 0 ? "boxes-remainder-left" : undefined}>
                    {line.remainder}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="boxes-remainder-options">
          {OPTIONS.map((option) => (
            <label
              key={`remainder-option-${option}`}
              className={`boxes-remainder-option${disposition === option ? " is-selected" : ""}`}
            >
              <input
                type="radio"
                name="material-remainder-disposition"
                value={option}
                checked={disposition === option}
                onChange={() => setDisposition(option)}
              />
              <span className="boxes-remainder-option-body">
                <span className="boxes-remainder-option-title">{optionText[option].title}</span>
                <span className="boxes-remainder-option-hint">{optionText[option].hint}</span>
                {option === "new_box" && disposition === "new_box" && (
                  <input
                    type="text"
                    className="boxes-remainder-label-input"
                    value={newBoxLabel}
                    maxLength={160}
                    aria-label={de ? "Bezeichnung der neuen Kiste" : "Name of the new box"}
                    placeholder={de ? "Bezeichnung der neuen Kiste" : "Name of the new box"}
                    onChange={(event) => setNewBoxLabel(event.target.value)}
                  />
                )}
              </span>
            </label>
          ))}
        </div>

        <div className="boxes-remainder-actions">
          <button
            type="button"
            className="boxes-remainder-primary"
            disabled={blocked}
            onClick={() =>
              onConfirm({
                disposition,
                new_box_label: disposition === "new_box" ? trimmedLabel : null,
              })
            }
          >
            {de ? "Abrechnen & Aufgabe abschließen" : "Settle & complete task"}
          </button>
          <button type="button" onClick={onCancel}>
            {de ? "Abbrechen" : "Cancel"}
          </button>
        </div>
        {blocked && (
          <p className="boxes-remainder-note boxes-remainder-note--warn">
            {de ? "Die neue Kiste braucht eine Bezeichnung" : "The new box needs a name"}
          </p>
        )}
      </section>
    </div>
  );
}
