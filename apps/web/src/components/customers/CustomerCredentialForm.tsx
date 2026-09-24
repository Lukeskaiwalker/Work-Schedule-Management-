/**
 * The Zugangsdaten form: what the login is for, the username, the
 * password, where to log in, and a note. The composer at the top of the
 * vault and the inline edit of a row are the same form seeded differently
 * (components/customers/CustomerCredentialsCard, CustomerCredentialRow).
 *
 * The form holds strings only — what its inputs show — and hands the
 * draft back on Speichern; `credentialCreateFromDraft` and
 * `credentialChangesFromDraft` turn it into what the API takes, kept
 * apart so the mapping can be tested without a render. The password
 * field is the one that differs between the two uses: a new row sends
 * what was typed, an edit leaves the stored password alone unless
 * something was typed ("unverändert lassen") or "Passwort entfernen" was
 * ticked — the API reads an absent `secret` as keep and "" as clear.
 */
import { useId, useState } from "react";

import type { CustomerCredential, CustomerCredentialCategory } from "../../types";
import type { CustomerCredentialCreate, CustomerCredentialUpdate } from "../../utils/customersApi";
import {
  CUSTOMER_CREDENTIAL_CATEGORIES,
  DEFAULT_CUSTOMER_CREDENTIAL_CATEGORY,
  credentialCategoryLabel,
} from "./customerCredentialCategories";

/** What the inputs hold: "" where nothing is typed. */
export type CustomerCredentialDraft = {
  label: string;
  category: CustomerCredentialCategory;
  username: string;
  /** What was typed into the password field; "" is "nothing typed". */
  secret: string;
  url: string;
  notes: string;
  /** Edit only: "Passwort entfernen" — sends `secret: ""`. */
  removeSecret: boolean;
};

// Mirror the server's limits, so the browser stops the typing where the
// API would refuse it.
export const CREDENTIAL_LABEL_MAX_CHARS = 160;
export const CREDENTIAL_SECRET_MAX_CHARS = 512;

export const EMPTY_CREDENTIAL_DRAFT: CustomerCredentialDraft = {
  label: "",
  category: DEFAULT_CUSTOMER_CREDENTIAL_CATEGORY,
  username: "",
  secret: "",
  url: "",
  notes: "",
  removeSecret: false,
};

export function draftFromCredential(row: CustomerCredential): CustomerCredentialDraft {
  return {
    label: row.label,
    category: row.category,
    username: row.username ?? "",
    secret: "",
    url: row.url ?? "",
    notes: row.notes ?? "",
    removeSecret: false,
  };
}

/** Trimmed; "" becomes null, which is what the API stores for "none". */
function textOrNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * What POST takes: every field trimmed, the optional ones null when empty,
 * the secret only when one was typed — an untyped password is no password,
 * not an empty one.
 */
export function credentialCreateFromDraft(draft: CustomerCredentialDraft): CustomerCredentialCreate {
  const secret = draft.secret.length > 0 ? { secret: draft.secret } : {};
  return {
    label: draft.label.trim(),
    category: draft.category,
    username: textOrNull(draft.username),
    url: textOrNull(draft.url),
    notes: textOrNull(draft.notes),
    ...secret,
  };
}

/**
 * What PATCH takes: only the keys whose value differs from the row. The
 * password is a key of its own — "" when it is to be removed, the typed
 * text when replaced, absent otherwise. An empty result means "nothing
 * to send".
 */
export function credentialChangesFromDraft(
  row: CustomerCredential,
  draft: CustomerCredentialDraft,
): CustomerCredentialUpdate {
  const label = draft.label.trim();
  const username = textOrNull(draft.username);
  const url = textOrNull(draft.url);
  const notes = textOrNull(draft.notes);
  return {
    ...(label !== row.label ? { label } : {}),
    ...(draft.category !== row.category ? { category: draft.category } : {}),
    ...(username !== (row.username ?? null) ? { username } : {}),
    ...(url !== (row.url ?? null) ? { url } : {}),
    ...(notes !== (row.notes ?? null) ? { notes } : {}),
    ...(draft.removeSecret ? { secret: "" } : draft.secret.length > 0 ? { secret: draft.secret } : {}),
  };
}

type Props = {
  initial: CustomerCredentialDraft;
  /** An edit leaves the password alone unless told otherwise; a new row has none to keep. */
  mode: "create" | "edit";
  /** Edit only: whether there is a stored password that "Passwort entfernen" could remove. */
  hasSecret: boolean;
  language: "de" | "en";
  saving: boolean;
  onSubmit: (draft: CustomerCredentialDraft) => void;
  onCancel: () => void;
};

export function CustomerCredentialForm({ initial, mode, hasSecret, language, saving, onSubmit, onCancel }: Props) {
  const de = language === "de";
  const ids = {
    label: useId(),
    category: useId(),
    username: useId(),
    secret: useId(),
    url: useId(),
    notes: useId(),
  };
  const [draft, setDraft] = useState<CustomerCredentialDraft>(initial);
  const [secretShown, setSecretShown] = useState(false);

  function update<K extends keyof CustomerCredentialDraft>(key: K, value: CustomerCredentialDraft[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  const editing = mode === "edit";
  const secretDisabled = saving || draft.removeSecret;

  return (
    <div className="customer-credentials-form">
      <div className="customer-credentials-field">
        <label htmlFor={ids.label}>{de ? "Bezeichnung" : "Label"}</label>
        <input
          id={ids.label}
          type="text"
          value={draft.label}
          onChange={(event) => update("label", event.target.value)}
          maxLength={CREDENTIAL_LABEL_MAX_CHARS}
          disabled={saving}
          autoComplete="off"
          placeholder={de ? "z. B. Wechselrichter SMA Sunny Boy" : "e.g. inverter SMA Sunny Boy"}
        />
      </div>
      <div className="customer-credentials-field">
        <label htmlFor={ids.category}>{de ? "Kategorie" : "Category"}</label>
        <select
          id={ids.category}
          value={draft.category}
          onChange={(event) => update("category", event.target.value as CustomerCredentialCategory)}
          disabled={saving}
        >
          {CUSTOMER_CREDENTIAL_CATEGORIES.map((category) => (
            <option key={category} value={category}>
              {credentialCategoryLabel(category, language)}
            </option>
          ))}
        </select>
      </div>
      <div className="customer-credentials-field">
        <label htmlFor={ids.username}>{de ? "Benutzername" : "Username"}</label>
        <input
          id={ids.username}
          type="text"
          value={draft.username}
          onChange={(event) => update("username", event.target.value)}
          disabled={saving}
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
        />
      </div>
      <div className="customer-credentials-field">
        <label htmlFor={ids.secret}>{de ? "Passwort" : "Password"}</label>
        <div className="customer-credentials-secret-input">
          <input
            id={ids.secret}
            type={secretShown ? "text" : "password"}
            value={draft.secret}
            onChange={(event) => update("secret", event.target.value)}
            maxLength={CREDENTIAL_SECRET_MAX_CHARS}
            disabled={secretDisabled}
            autoComplete="new-password"
            placeholder={editing ? (de ? "unverändert lassen" : "leave unchanged") : undefined}
          />
          <button
            type="button"
            className="linklike"
            onClick={() => setSecretShown((current) => !current)}
            disabled={secretDisabled}
            aria-label={
              secretShown ? (de ? "Passwort verbergen" : "Hide password") : de ? "Passwort anzeigen" : "Show password"
            }
          >
            {secretShown ? (de ? "Verbergen" : "Hide") : de ? "Anzeigen" : "Show"}
          </button>
        </div>
        {editing && hasSecret && (
          <label className="customer-credentials-remove-secret">
            <input
              type="checkbox"
              checked={draft.removeSecret}
              onChange={(event) => update("removeSecret", event.target.checked)}
              disabled={saving}
            />
            {de ? "Passwort entfernen" : "Remove password"}
          </label>
        )}
      </div>
      <div className="customer-credentials-field">
        <label htmlFor={ids.url}>URL</label>
        <input
          id={ids.url}
          type="text"
          value={draft.url}
          onChange={(event) => update("url", event.target.value)}
          disabled={saving}
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          placeholder={de ? "http://192.168.178.40 oder Portal-Adresse" : "http://192.168.178.40 or portal address"}
        />
      </div>
      <div className="customer-credentials-field">
        <label htmlFor={ids.notes}>{de ? "Notizen" : "Notes"}</label>
        <textarea
          id={ids.notes}
          value={draft.notes}
          onChange={(event) => update("notes", event.target.value)}
          disabled={saving}
          placeholder={de ? "z. B. wo der Aufkleber klebt, welche Rolle das Login hat" : "e.g. where the sticker is, what the login is for"}
        />
      </div>
      <div className="customer-credentials-actions">
        <button type="button" className="customers-action-btn" onClick={onCancel} disabled={saving}>
          {de ? "Abbrechen" : "Cancel"}
        </button>
        <button
          type="button"
          className="customers-action-btn customers-action-btn--primary"
          onClick={() => onSubmit(draft)}
          disabled={saving}
        >
          {saving ? (de ? "Speichert…" : "Saving…") : de ? "Speichern" : "Save"}
        </button>
      </div>
    </div>
  );
}
