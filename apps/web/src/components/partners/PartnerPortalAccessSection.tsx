import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useAppContext } from "../../context/AppContext";
import type { PartnerListItem, PartnerPortalLink, PartnerPortalUser } from "../../types";
import { formatServerDateTime } from "../../utils/dates";
import {
  invitePartnerPortalUser,
  listPartnerPortalUsers,
  sendPartnerPortalLink,
  setPartnerPortalUserActive,
} from "../../utils/partnersApi";
import "../../styles/partner-portal-office.css";

/**
 * "Partnerportal" on the partner slide-over: who of this subcontractor can
 * sign in to the partner portal, and the controls to invite, re-link, lock
 * and unlock them.
 *
 * A login sees exactly the tasks this partner is set on and the projects it
 * was given — nothing is granted per person. Every link the server mints is
 * shown here too, so the office can hand it over by phone or messenger when
 * the mail does not go out.
 */

const STATUS_LABEL: Record<PartnerPortalUser["status"], string> = {
  active: "Aktiv",
  invited: "Eingeladen",
  disabled: "Gesperrt",
};

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? parts[parts.length - 1][0] ?? "" : "")).toUpperCase() || "?";
}

function rowDetail(user: PartnerPortalUser, language: "de" | "en"): string {
  if (user.status === "invited") {
    return user.invite_sent_at ? `Einladung vom ${formatServerDateTime(user.invite_sent_at, language)}` : "Einladung offen";
  }
  if (user.last_login_at) return `${user.email} · zuletzt ${formatServerDateTime(user.last_login_at, language)}`;
  return user.email;
}

function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (/already has a login/i.test(message)) return "Diese E-Mail-Adresse hat schon einen Zugang.";
  if (/archived/i.test(message)) return "Der Partner ist archiviert.";
  if (/locked/i.test(message)) return "Der Zugang ist gesperrt. Erst entsperren.";
  return message || "Das hat nicht geklappt.";
}

export function PartnerPortalAccessSection({ partner }: { partner: PartnerListItem }) {
  const { token, language } = useAppContext();
  const [users, setUsers] = useState<PartnerPortalUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [link, setLink] = useState<PartnerPortalLink | null>(null);
  const [copied, setCopied] = useState(false);
  const archived = Boolean(partner.archived_at);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setUsers(await listPartnerPortalUsers(token, partner.id));
      setError(null);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setLoading(false);
    }
  }, [token, partner.id]);

  useEffect(() => {
    setLink(null);
    void load();
  }, [load]);

  function showLink(result: PartnerPortalLink) {
    setLink(result);
    setCopied(false);
    setUsers((current) => {
      const others = current.filter((row) => row.id !== result.user.id);
      return [...others, result.user].sort((a, b) => Number(b.is_active) - Number(a.is_active) || a.full_name.localeCompare(b.full_name));
    });
  }

  async function invite(event: FormEvent) {
    event.preventDefault();
    if (!name.trim() || !email.trim()) {
      setError("Bitte Name und E-Mail angeben.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      showLink(await invitePartnerPortalUser(token, partner.id, { full_name: name, email }));
      setName("");
      setEmail("");
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  async function resend(user: PartnerPortalUser) {
    setBusy(true);
    setError(null);
    try {
      showLink(await sendPartnerPortalLink(token, partner.id, user.id));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  async function toggle(user: PartnerPortalUser) {
    setBusy(true);
    setError(null);
    try {
      const updated = await setPartnerPortalUserActive(token, partner.id, user.id, !user.is_active);
      setUsers((current) => current.map((row) => (row.id === updated.id ? updated : row)));
      if (link?.user.id === updated.id && !updated.is_active) setLink(null);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  async function copyLink() {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link.invite_link);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  // "Aktiv" means can sign in today; an invite nobody accepted yet cannot.
  const activeCount = users.filter((user) => user.status === "active").length;
  const invitedCount = users.filter((user) => user.status === "invited").length;
  const chip = [
    activeCount > 0 ? `${activeCount} aktiv` : null,
    invitedCount > 0 ? `${invitedCount} eingeladen` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <section className="partner-portal-access" aria-labelledby={`partner-portal-${partner.id}`}>
      <div className="partner-portal-access-head">
        <span id={`partner-portal-${partner.id}`} className="partner-portal-access-eyebrow">PARTNERPORTAL</span>
        <span className={activeCount > 0 ? "partner-portal-access-chip partner-portal-access-chip--on" : "partner-portal-access-chip"}>
          {chip || "Kein Zugang"}
        </span>
      </div>
      <p className="partner-portal-access-lead">
        Zugänge sehen nur die Aufgaben und Projekte, die diesem Partner zugewiesen sind.
      </p>

      {loading ? (
        <small className="muted">Zugänge werden geladen…</small>
      ) : users.length > 0 ? (
        <ul className="partner-portal-access-list">
          {users.map((user) => (
            <li key={user.id} className="partner-portal-access-row">
              <span className={`partner-portal-access-avatar partner-portal-access-avatar--${user.status}`} aria-hidden="true">
                {initials(user.full_name)}
              </span>
              <span className="partner-portal-access-who">
                <span className="partner-portal-access-name">{user.full_name}</span>
                <span className="partner-portal-access-detail">{rowDetail(user, language)}</span>
                <span className="partner-portal-access-actions">
                  {user.is_active && !archived && (
                    <button type="button" className="partner-list-action-btn" disabled={busy} onClick={() => void resend(user)}>
                      {user.status === "invited" ? "Einladung erneut" : "Passwort-Link"}
                    </button>
                  )}
                  <button type="button" className="partner-list-action-btn partner-list-action-btn--ghost" disabled={busy} onClick={() => void toggle(user)}>
                    {user.is_active ? "Sperren" : "Entsperren"}
                  </button>
                </span>
              </span>
              <span className={`partner-portal-access-status partner-portal-access-status--${user.status}`}>{STATUS_LABEL[user.status]}</span>
            </li>
          ))}
        </ul>
      ) : null}

      {link && (
        <div className={link.sent ? "partner-portal-access-link partner-portal-access-link--sent" : "partner-portal-access-link"} role="status">
          <span className="partner-portal-access-link-text">
            {link.sent
              ? `${link.kind === "invite" ? "Einladung" : "Passwort-Link"} an ${link.user.email} gesendet. Link zum Weitergeben:`
              : "E-Mail konnte nicht gesendet werden. Link selbst weitergeben:"}
          </span>
          <span className="partner-portal-access-link-row">
            <input className="partner-portal-access-link-input" value={link.invite_link} readOnly onFocus={(event) => event.target.select()} aria-label="Link" />
            <button type="button" className="partner-list-action-btn" onClick={() => void copyLink()}>
              {copied ? "Kopiert" : "Kopieren"}
            </button>
          </span>
        </div>
      )}

      {archived ? (
        <p className="partner-portal-access-lead">Der Partner ist archiviert – das Portal ist für seine Zugänge geschlossen.</p>
      ) : (
        <form className="partner-portal-access-form" onSubmit={invite}>
          <span className="partner-portal-access-form-title">Neuen Zugang einladen</span>
          <input className="partner-portal-access-input" placeholder="Name" value={name} onChange={(event) => setName(event.target.value)} aria-label="Name" />
          <input
            className="partner-portal-access-input"
            placeholder="E-Mail"
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            aria-label="E-Mail"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
          />
          <span className="partner-portal-access-form-foot">
            <small className="muted">Der Link ist 72 Stunden gültig.</small>
            <button type="submit" className="partner-portal-access-submit" disabled={busy}>
              {busy ? "Bitte warten…" : "Einladung senden"}
            </button>
          </span>
        </form>
      )}
      {error && <p className="partner-portal-access-error" role="alert">{error}</p>}
    </section>
  );
}
