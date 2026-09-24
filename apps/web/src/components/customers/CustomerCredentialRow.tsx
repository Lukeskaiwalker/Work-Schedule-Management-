/**
 * One entry of the vault (components/customers/CustomerCredentialsCard):
 * the category chip and the label, then the username with a copy button,
 * the address as a link when it is one, the password, the notes, and a
 * footer saying who wrote the row and who last looked at its password.
 *
 * The password is the part with rules. The list never carries it; the row
 * shows a mask and "Anzeigen" fetches it — the card makes that call, the
 * server logs it — and what comes back is shown in a box for thirty
 * seconds with the seconds counting down, or until "Ausblenden". The
 * countdown is the row's own clock: the secret lives in this component's
 * state and nowhere else, and leaving the row (an edit, another customer)
 * drops it. Bearbeiten swaps the fields for the form seeded with the row;
 * Löschen asks first. Both show on every row: who may delete is the
 * server's rule, and its refusal is shown as it comes.
 */
import { useEffect, useState } from "react";

import type { CustomerCredential } from "../../types";
import { formatServerDateTime } from "../../utils/dates";
import { credentialCategoryLabel } from "./customerCredentialCategories";
import { CustomerCredentialForm, draftFromCredential, type CustomerCredentialDraft } from "./CustomerCredentialForm";

/** How long a revealed password stays on screen. */
export const REVEAL_SECONDS = 30;

const MASK = "••••••••";

// An address is linked only when it says how to reach it — http(s) — or
// when it plainly is a host: an IPv4 address or a dotted name, with an
// optional port and path. Anything else ("Aufkleber unten am Gerät", a
// javascript: URL) is text, so nothing in the vault can become a click
// on something it is not.
const HOST_LIKE =
  /^(?:\d{1,3}(?:\.\d{1,3}){3}|[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+)(?::\d{1,5})?(?:\/\S*)?$/i;

/** Where the address opens, or null when it is not one to open. */
export function credentialHref(url: string): string | null {
  const value = url.trim();
  if (/^https?:\/\//i.test(value)) return value;
  if (HOST_LIKE.test(value)) return `http://${value}`;
  return null;
}

type Props = {
  row: CustomerCredential;
  language: "de" | "en";
  editing: boolean;
  saving: boolean;
  removing: boolean;
  revealing: boolean;
  onEdit: () => void;
  onCancelEdit: () => void;
  onSave: (draft: CustomerCredentialDraft) => void;
  onDelete: () => void;
  /** Fetches the password; resolves to null when the server refused (already reported). */
  onReveal: () => Promise<string | null>;
  onCopy: (text: string) => void;
};

/** "angelegt von X · zuletzt angezeigt <when> von Y", each half only where the row has it. */
function footerText(row: CustomerCredential, language: "de" | "en"): string {
  const de = language === "de";
  const parts: string[] = [];
  const creator = row.created_by_name?.trim();
  if (creator) parts.push(`${de ? "angelegt von" : "created by"} ${creator}`);
  if (row.last_revealed_at) {
    const when = formatServerDateTime(row.last_revealed_at, language);
    const viewer = row.last_revealed_by_name?.trim();
    const by = viewer ? ` ${de ? "von" : "by"} ${viewer}` : "";
    parts.push(`${de ? "zuletzt angezeigt" : "last revealed"} ${when}${by}`);
  }
  return parts.join(" · ");
}

export function CustomerCredentialRow({
  row,
  language,
  editing,
  saving,
  removing,
  revealing,
  onEdit,
  onCancelEdit,
  onSave,
  onDelete,
  onReveal,
  onCopy,
}: Props) {
  const de = language === "de";
  const [secret, setSecret] = useState<string | null>(null);
  const [remaining, setRemaining] = useState(0);

  // The clock: one tick a second while a password is on screen. The
  // interval is tied to the secret, so a fresh reveal restarts it.
  useEffect(() => {
    if (secret === null) return;
    const timer = window.setInterval(() => {
      setRemaining((current) => current - 1);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [secret]);

  useEffect(() => {
    if (secret !== null && remaining <= 0) setSecret(null);
  }, [secret, remaining]);

  // Leaving the fields — into the form, or to another row in this slot —
  // drops the password rather than carrying it along.
  useEffect(() => {
    setSecret(null);
  }, [editing, row.id]);

  async function reveal() {
    if (revealing) return;
    const value = await onReveal();
    if (value === null) return;
    setRemaining(REVEAL_SECONDS);
    setSecret(value);
  }

  const chip = credentialCategoryLabel(row.category, language);
  const href = row.url ? credentialHref(row.url) : null;
  const footer = footerText(row, language);
  const busy = saving || removing;

  return (
    <li className="customer-credentials-item">
      <div className="customer-credentials-item-head">
        <span className={`customer-credentials-chip customer-credentials-chip--${row.category}`}>{chip}</span>
        <strong className="customer-credentials-label">{row.label}</strong>
      </div>

      {editing ? (
        <CustomerCredentialForm
          initial={draftFromCredential(row)}
          mode="edit"
          hasSecret={row.has_secret}
          language={language}
          saving={saving}
          onSubmit={onSave}
          onCancel={onCancelEdit}
        />
      ) : (
        <>
          <dl className="customer-credentials-fields">
            <dt>{de ? "Benutzername" : "Username"}</dt>
            <dd>
              {row.username ? (
                <>
                  <span className="customer-credentials-value">{row.username}</span>
                  <button
                    type="button"
                    className="linklike customer-credentials-copy"
                    onClick={() => onCopy(row.username ?? "")}
                    aria-label={de ? "Benutzername kopieren" : "Copy username"}
                  >
                    {de ? "Kopieren" : "Copy"}
                  </button>
                </>
              ) : (
                <span className="muted">—</span>
              )}
            </dd>

            <dt>URL</dt>
            <dd>
              {row.url ? (
                href ? (
                  <a href={href} target="_blank" rel="noopener noreferrer" className="customer-credentials-value">
                    {row.url}
                  </a>
                ) : (
                  <span className="customer-credentials-value">{row.url}</span>
                )
              ) : (
                <span className="muted">—</span>
              )}
            </dd>

            <dt>{de ? "Passwort" : "Password"}</dt>
            <dd>
              {!row.has_secret ? (
                <span className="muted">{de ? "kein Passwort hinterlegt" : "no password stored"}</span>
              ) : secret !== null ? (
                <span className="customer-credentials-secret-box">
                  <code className="customer-credentials-secret">{secret}</code>
                  <button
                    type="button"
                    className="linklike customer-credentials-copy"
                    onClick={() => onCopy(secret)}
                    aria-label={de ? "Passwort kopieren" : "Copy password"}
                  >
                    {de ? "Kopieren" : "Copy"}
                  </button>
                  <button type="button" className="linklike" onClick={() => setSecret(null)}>
                    {de ? "Ausblenden" : "Hide"}
                  </button>
                  <span className="customer-credentials-countdown" aria-live="off">
                    {de ? `noch ${remaining} s` : `${remaining} s left`}
                  </span>
                </span>
              ) : (
                <>
                  <span className="customer-credentials-masked" aria-label={de ? "Passwort hinterlegt" : "Password stored"}>
                    {MASK}
                  </span>
                  <button
                    type="button"
                    className="linklike customer-credentials-copy"
                    onClick={() => void reveal()}
                    disabled={revealing || busy}
                  >
                    {revealing ? (de ? "Lädt…" : "Loading…") : de ? "Anzeigen" : "Reveal"}
                  </button>
                </>
              )}
            </dd>
          </dl>

          {row.notes && <p className="customer-credentials-notes muted">{row.notes}</p>}

          <div className="customer-credentials-item-foot">
            {footer && <span className="customer-credentials-meta">{footer}</span>}
            <div className="customer-credentials-item-actions">
              <button type="button" className="linklike" onClick={onEdit} disabled={busy}>
                {de ? "Bearbeiten" : "Edit"}
              </button>
              <button type="button" className="linklike" onClick={onDelete} disabled={busy}>
                {removing ? (de ? "Löscht…" : "Deleting…") : de ? "Löschen" : "Delete"}
              </button>
            </div>
          </div>
        </>
      )}
    </li>
  );
}
