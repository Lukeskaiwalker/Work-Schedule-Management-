// The partner's own account: who is signed in for which company, a password
// change, and signing out.

import { useState, type FormEvent } from "react";
import { ApiError } from "../api/client";
import { LogoutIcon } from "./PortalIcons";
import { PortalBand, PortalTitle, type NavTarget } from "./PortalParts";
import { changePortalPassword } from "./portalApi";
import type { PortalMe } from "./portalTypes";

export function PortalAccountPage({
  token,
  me,
  onNavigate,
  onLogout,
}: {
  token: string;
  me: PortalMe;
  onNavigate: (target: NavTarget) => void;
  onLogout: () => void;
}) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setMessage(null);
    if (next.length < 8) {
      setMessage({ kind: "error", text: "Das neue Passwort braucht mindestens 8 Zeichen." });
      return;
    }
    setBusy(true);
    try {
      await changePortalPassword(token, current, next);
      setCurrent("");
      setNext("");
      setMessage({ kind: "ok", text: "Neues Passwort gespeichert." });
    } catch (error) {
      setMessage({
        kind: "error",
        text: error instanceof ApiError && error.status === 403 ? "Das aktuelle Passwort stimmt nicht." : "Speichern hat nicht geklappt. Bitte erneut versuchen.",
      });
    } finally {
      setBusy(false);
    }
  }

  const company = me.partner.trade ? `${me.partner.name} · ${me.partner.trade}` : me.partner.name;

  return (
    <>
      <PortalBand me={me} active="account" onNavigate={onNavigate}>
        <PortalTitle eyebrow={me.partner.name} title="Konto" subtitle={`Angemeldet als ${me.user.full_name}`} />
      </PortalBand>
      <main className="pp-main">
        <div className="pp-main-inner">
          <section className="pp-card" aria-label="Profil">
            <div className="pp-info-row">
              <span className="pp-info-text">
                <span className="pp-info-detail">Name</span>
                <span className="pp-info-title">{me.user.full_name}</span>
              </span>
            </div>
            <div className="pp-info-row">
              <span className="pp-info-text">
                <span className="pp-info-detail">E-Mail</span>
                <span className="pp-body-text">{me.user.email}</span>
              </span>
            </div>
            <div className="pp-info-row">
              <span className="pp-info-text">
                <span className="pp-info-detail">Firma</span>
                <span className="pp-body-text">{company}</span>
              </span>
            </div>
          </section>

          <form className="pp-card pp-card--padded" onSubmit={submit} aria-label="Passwort ändern">
            <span className="pp-kicker">Passwort ändern</span>
            <label className="pp-field" htmlFor="pp-current-password">
              Aktuelles Passwort
              <input id="pp-current-password" className="pp-input" type="password" autoComplete="current-password" value={current} onChange={(event) => setCurrent(event.target.value)} required />
            </label>
            <label className="pp-field" htmlFor="pp-next-password">
              Neues Passwort
              <input id="pp-next-password" className="pp-input" type="password" autoComplete="new-password" minLength={8} value={next} onChange={(event) => setNext(event.target.value)} required />
              <span className="pp-hint">Mindestens 8 Zeichen.</span>
            </label>
            {message && (
              <div className={message.kind === "ok" ? "pp-notice" : "pp-alert"} role={message.kind === "ok" ? "status" : "alert"}>
                {message.text}
              </div>
            )}
            <button type="submit" className="pp-btn pp-btn--soft" disabled={busy}>
              {busy ? "Wird gespeichert …" : "Passwort speichern"}
            </button>
          </form>

          <button type="button" className="pp-btn pp-btn--danger" onClick={onLogout}>
            <LogoutIcon size={18} />
            Abmelden
          </button>
        </div>
      </main>
    </>
  );
}
