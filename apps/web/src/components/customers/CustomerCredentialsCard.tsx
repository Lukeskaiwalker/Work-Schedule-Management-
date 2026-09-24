/**
 * "Zugangsdaten" on the customer page: the customer's credential vault.
 *
 * The logins of the plant — Wechselrichter, Wallbox, Router, the
 * manufacturer's portal — used to live on stickers, in the note feed and
 * in whoever's head had set the device up. Here they are one list per
 * customer: label, username, address, a note, and a password that is
 * encrypted on the server, never sent with the list, and fetched only on
 * "Anzeigen" — a call the server writes to the audit log and to the
 * customer's change log, so the footer of a row can say who looked last.
 *
 * The card fetches its own list, in label order, and the answer of a
 * post, an edit or a delete is folded into the list in place: no refetch,
 * because the server does not page this list. The composer opens at the
 * top on "+ Zugang"; a row's edit opens inline, with the same form.
 * Everyone who may open the customer's files may read and write here;
 * deleting is for the creator or a project manager, and the server's
 * refusal is shown as it comes rather than guessed at from the row.
 */
import { useEffect, useRef, useState } from "react";

import { useAppContext } from "../../context/AppContext";
import type { CustomerCredential } from "../../types";
import {
  createCustomerCredential,
  deleteCustomerCredential,
  listCustomerCredentials,
  revealCustomerCredential,
  updateCustomerCredential,
} from "../../utils/customersApi";
import { copyText } from "../files/copyText";
import {
  CustomerCredentialForm,
  EMPTY_CREDENTIAL_DRAFT,
  credentialChangesFromDraft,
  credentialCreateFromDraft,
  type CustomerCredentialDraft,
} from "./CustomerCredentialForm";
import { CustomerCredentialRow } from "./CustomerCredentialRow";
import "../../styles/customer-credentials.css";

type Props = {
  customerId: number;
  language: "de" | "en";
};

function messageOf(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

/** The server's order — by label — kept after a row is added or renamed. */
function sortedByLabel(rows: CustomerCredential[]): CustomerCredential[] {
  return [...rows].sort((a, b) => a.label.localeCompare(b.label, "de", { sensitivity: "base" }));
}

export function CustomerCredentialsCard({ customerId, language }: Props) {
  const { token, user, setError, setNotice } = useAppContext();
  const de = language === "de";

  const [rows, setRows] = useState<CustomerCredential[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [composing, setComposing] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [removingId, setRemovingId] = useState<number | null>(null);
  const [revealingId, setRevealingId] = useState<number | null>(null);
  // Which customer the in-flight requests belong to. A switch to another
  // customer bumps it, and a late answer for the old one is dropped instead
  // of landing in the new list — together with any half-written form.
  const generation = useRef(0);

  useEffect(() => {
    generation.current += 1;
    const ticket = generation.current;
    setRows([]);
    setComposing(false);
    setEditingId(null);
    setLoadError(null);
    setLoading(true);

    listCustomerCredentials(token, customerId)
      .then((list) => {
        if (generation.current !== ticket) return;
        setRows(sortedByLabel(list));
      })
      .catch((err: unknown) => {
        if (generation.current !== ticket) return;
        setLoadError(messageOf(err, de ? "Zugangsdaten konnten nicht geladen werden" : "Failed to load credentials"));
      })
      .finally(() => {
        if (generation.current !== ticket) return;
        setLoading(false);
      });

    return () => {
      generation.current += 1;
    };
  }, [customerId, token, reloadKey]); // eslint-disable-line react-hooks/exhaustive-deps

  /** The label the API would refuse, reported here first. */
  function labelMissing(draft: CustomerCredentialDraft): boolean {
    if (draft.label.trim().length > 0) return false;
    setError(de ? "Bitte eine Bezeichnung eintragen" : "Please enter a label");
    return true;
  }

  async function create(draft: CustomerCredentialDraft) {
    if (saving || labelMissing(draft)) return;
    const ticket = generation.current;
    setSaving(true);
    try {
      const created = await createCustomerCredential(token, customerId, credentialCreateFromDraft(draft));
      if (generation.current !== ticket) return;
      setRows((current) => sortedByLabel([...current, created]));
      setComposing(false);
      setNotice(de ? "Zugangsdaten gespeichert" : "Credentials saved");
    } catch (err) {
      // The form stays open: a failed save is retried, not retyped.
      setError(messageOf(err, de ? "Zugangsdaten konnten nicht gespeichert werden" : "Failed to save credentials"));
    } finally {
      setSaving(false);
    }
  }

  async function update(row: CustomerCredential, draft: CustomerCredentialDraft) {
    if (saving || labelMissing(draft)) return;
    const changes = credentialChangesFromDraft(row, draft);
    if (Object.keys(changes).length === 0) {
      setEditingId(null);
      return;
    }
    const ticket = generation.current;
    setSaving(true);
    try {
      const updated = await updateCustomerCredential(token, customerId, row.id, changes);
      if (generation.current !== ticket) return;
      setRows((current) => sortedByLabel(current.map((item) => (item.id === updated.id ? updated : item))));
      setEditingId(null);
      setNotice(de ? "Zugangsdaten gespeichert" : "Credentials saved");
    } catch (err) {
      setError(messageOf(err, de ? "Zugangsdaten konnten nicht gespeichert werden" : "Failed to save credentials"));
    } finally {
      setSaving(false);
    }
  }

  async function remove(row: CustomerCredential) {
    if (removingId !== null) return;
    if (!window.confirm(de ? "Diese Zugangsdaten löschen?" : "Delete these credentials?")) return;
    const ticket = generation.current;
    setRemovingId(row.id);
    try {
      await deleteCustomerCredential(token, customerId, row.id);
      if (generation.current !== ticket) return;
      setRows((current) => current.filter((item) => item.id !== row.id));
      setNotice(de ? "Zugangsdaten gelöscht" : "Credentials deleted");
    } catch (err) {
      setError(messageOf(err, de ? "Zugangsdaten konnten nicht gelöscht werden" : "Failed to delete credentials"));
    } finally {
      setRemovingId(null);
    }
  }

  /**
   * The one audited call. The row's footer is brought up to date from the
   * answer — the server has logged this reveal, so the list would say the
   * same on its next load.
   */
  async function reveal(row: CustomerCredential): Promise<string | null> {
    if (revealingId !== null) return null;
    const ticket = generation.current;
    setRevealingId(row.id);
    try {
      const answer = await revealCustomerCredential(token, customerId, row.id);
      if (generation.current !== ticket) return null;
      setRows((current) =>
        current.map((item) =>
          item.id === row.id
            ? { ...item, last_revealed_at: answer.revealed_at, last_revealed_by_name: user?.display_name ?? item.last_revealed_by_name }
            : item,
        ),
      );
      return answer.secret;
    } catch (err) {
      setError(messageOf(err, de ? "Passwort konnte nicht angezeigt werden" : "Failed to reveal the password"));
      return null;
    } finally {
      setRevealingId(null);
    }
  }

  async function copy(text: string) {
    try {
      await copyText(text);
      setNotice(de ? "Kopiert" : "Copied");
    } catch {
      setError(de ? "Kopieren nicht möglich" : "Could not copy");
    }
  }

  function openComposer() {
    setEditingId(null);
    setComposing(true);
  }

  function startEdit(row: CustomerCredential) {
    setComposing(false);
    setEditingId(row.id);
  }

  const showHeaderAction = !loading && loadError === null && !composing;

  return (
    <section className="customer-credentials-card">
      <header className="customer-contact-card-head customer-credentials-head">
        <div className="customer-credentials-head-text">
          <h3 className="customer-contact-card-title">{de ? "Zugangsdaten" : "Credentials"}</h3>
          <p className="muted customer-credentials-intro">
            {de
              ? "Logins der Anlage — Wechselrichter, Wallbox, Router, Portale. Passwörter werden verschlüsselt gespeichert; jedes Anzeigen wird protokolliert."
              : "Logins of the plant — inverter, wallbox, router, portals. Passwords are stored encrypted; every reveal is logged."}
          </p>
        </div>
        {showHeaderAction && (
          <button type="button" className="customers-action-btn" onClick={openComposer}>
            + {de ? "Zugang" : "Login"}
          </button>
        )}
      </header>

      {composing && (
        <div className="customer-credentials-composer">
          <CustomerCredentialForm
            initial={EMPTY_CREDENTIAL_DRAFT}
            mode="create"
            hasSecret={false}
            language={language}
            saving={saving}
            onSubmit={(draft) => void create(draft)}
            onCancel={() => setComposing(false)}
          />
        </div>
      )}

      {loading ? (
        <small className="muted" role="status">
          {de ? "Zugangsdaten werden geladen…" : "Loading credentials…"}
        </small>
      ) : loadError !== null ? (
        <div className="customer-credentials-error" role="alert">
          <span>{de ? "Zugangsdaten konnten nicht geladen werden." : "Credentials could not be loaded."}</span>
          <small className="muted">{loadError}</small>
          <button type="button" className="linklike" onClick={() => setReloadKey((current) => current + 1)}>
            {de ? "Erneut versuchen" : "Try again"}
          </button>
        </div>
      ) : rows.length === 0 ? (
        !composing && (
          <p className="muted customer-credentials-empty">
            {de ? "Noch keine Zugangsdaten hinterlegt." : "No credentials stored yet."}
          </p>
        )
      ) : (
        <ul className="customer-credentials-list">
          {rows.map((row) => (
            <CustomerCredentialRow
              key={`customer-credential-${row.id}`}
              row={row}
              language={language}
              editing={editingId === row.id}
              saving={saving && editingId === row.id}
              removing={removingId === row.id}
              revealing={revealingId === row.id}
              onEdit={() => startEdit(row)}
              onCancelEdit={() => setEditingId(null)}
              onSave={(draft) => void update(row, draft)}
              onDelete={() => void remove(row)}
              onReveal={() => reveal(row)}
              onCopy={(text) => void copy(text)}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
