/**
 * "Sonderkiste löschen" on an opened ad-hoc crate.
 *
 * The Sonderkisten card has said "löschbar" since v2.7.0, but no button ever
 * called DELETE /werkstatt/boxes/{id}, so a crate made for one job stayed on
 * the list long after it came back empty.
 *
 * Its own card at the foot of the crate rather than a button beside "Etikett
 * drucken": deleting is rare and final, printing is everyday, and on a phone
 * the two would sit under the same thumb. Split out of WerkstattKistenPage
 * (far past a focused size already), like KistenPackForm.
 */
import { useId, useRef, useState } from "react";

import { ApiError, apiFetch } from "../../api/client";
import { sonderkisteDeletion } from "../../utils/boxes";

type DeletableBox = {
  id: number;
  box_number: string;
  label: string;
  slot: number | null;
  status: string;
};

type Props = {
  box: DeletableBox;
  /** Lines in the opened crate — what the packer is looking at, not the rack's count. */
  itemCount: number;
  language: "de" | "en";
  token: string | null;
  /** The crate is gone; `notice` names it. The page closes it and reloads the rack. */
  onDeleted: (notice: string) => void;
  /**
   * The server said no; `message` is its German reason, verbatim. The page
   * shows it and reads the crate again: the reason is often something this
   * screen does not show yet (a line scanned in at the wall station, the crate
   * packed elsewhere), and the button has to follow what the server saw.
   * Awaited, so the button stays busy until the crate on screen is current.
   */
  onRefused: (message: string) => Promise<void> | void;
};

export function SonderkisteDeleteCard({ box, itemCount, language, token, onDeleted, onRefused }: Props) {
  const de = language === "de";
  const hintId = useId();
  const [deleting, setDeleting] = useState(false);
  // State alone lets a double tap through: the second click can land before
  // the re-render that disables the button.
  const inFlight = useRef(false);
  const deletion = sonderkisteDeletion(box, itemCount);
  if (deletion === "none") return null;

  const confirmText = de
    ? `Sonderkiste ${box.box_number} „${box.label}“ löschen?`
    : `Delete ad-hoc box ${box.box_number} “${box.label}”?`;
  const deletedNotice = de
    ? `Sonderkiste ${box.box_number} „${box.label}“ gelöscht`
    : `Ad-hoc box ${box.box_number} “${box.label}” deleted`;

  async function remove() {
    if (inFlight.current || !window.confirm(confirmText)) return;
    inFlight.current = true;
    setDeleting(true);
    try {
      await apiFetch(`/werkstatt/boxes/${box.id}`, token, { method: "DELETE" });
      onDeleted(deletedNotice);
    } catch (err: unknown) {
      // Somebody else deleted it a moment earlier: the outcome wanted. A
      // "nicht gefunden" banner over a crate still on screen would leave the
      // packer stuck on a crate that no longer exists.
      if (err instanceof ApiError && err.status === 404) {
        onDeleted(deletedNotice);
      } else {
        await onRefused(err instanceof Error ? err.message : String(err));
      }
    } finally {
      inFlight.current = false;
      setDeleting(false);
    }
  }

  return (
    <article className="werkstatt-card">
      <div className="kisten-card-body">
        <div className="kisten-action-row">
          <button
            type="button"
            className="werkstatt-action-btn werkstatt-action-btn--danger"
            onClick={() => void remove()}
            disabled={deletion !== "allowed" || deleting}
            aria-describedby={deletion === "not_empty" ? hintId : undefined}
          >
            {deleting
              ? de
                ? "Löscht…"
                : "Deleting…"
              : de
                ? "Sonderkiste löschen"
                : "Delete ad-hoc box"}
          </button>
        </div>
        {deletion === "not_empty" && (
          <p id={hintId} className="kisten-action-hint">
            {de ? "Erst leeren, dann löschen." : "Empty it first, then delete it."}
          </p>
        )}
      </div>
    </article>
  );
}
