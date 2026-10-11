// The portal's signed-out screens: the login, and the "set your password"
// page the office's invite and reset emails link to.

import { useState, type FormEvent } from "react";
import { ApiError } from "../api/client";
import { EyeIcon, EyeOffIcon } from "./PortalIcons";
import { acceptPortalInvite, confirmPortalPasswordReset, portalLogin, portalLoginMfa, type LoginResult } from "./portalApi";

export type PublicCompany = { name: string; logo_url: string };

type SessionHandler = (token: string, role: string) => void;

function messageFor(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    if (error.status === 401) return "E-Mail oder Passwort stimmen nicht.";
    if (error.status === 429) return "Zu viele Versuche. Bitte in ein paar Minuten erneut versuchen.";
    if (error.status === 400 && /token/i.test(error.message)) return "Dieser Link ist abgelaufen oder wurde schon benutzt. Bitte im Büro einen neuen anfordern.";
  }
  if (error instanceof TypeError) return "Keine Verbindung. Bitte Netz prüfen und erneut versuchen.";
  return fallback;
}

function PasswordInput({
  id,
  value,
  onChange,
  autoComplete,
  minLength,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  autoComplete: string;
  minLength?: number;
}) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="pp-password">
      <input
        id={id}
        className="pp-input"
        type={visible ? "text" : "password"}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        autoComplete={autoComplete}
        minLength={minLength}
        required
      />
      <button
        type="button"
        className="pp-password-toggle"
        onClick={() => setVisible((v) => !v)}
        aria-label={visible ? "Passwort verbergen" : "Passwort anzeigen"}
        aria-pressed={visible}
      >
        {visible ? <EyeOffIcon size={22} /> : <EyeIcon size={22} />}
      </button>
    </div>
  );
}

function Hero({ company, headline, lead }: { company: PublicCompany; headline: string; lead: string }) {
  const logo = company.logo_url.trim();
  return (
    <header className="pp-login-hero">
      <div className="pp-band-inner">
        <div className="pp-brand">
          <div className="pp-brand-mark" aria-hidden="true">
            {logo ? <img src={logo} alt="" /> : (company.name || "S").slice(0, 1).toUpperCase()}
          </div>
          <div>
            <div className="pp-brand-name">{company.name || "SMPL"}</div>
            <div className="pp-brand-kicker">Partnerportal</div>
          </div>
        </div>
        <h1 className="pp-login-headline">{headline}</h1>
        <p className="pp-login-lead">{lead}</p>
      </div>
    </header>
  );
}

export function PortalLoginPage({
  company,
  notice,
  initialEmail = "",
  onSession,
}: {
  company: PublicCompany;
  notice?: string | null;
  initialEmail?: string;
  onSession: SessionHandler;
}) {
  const [email, setEmail] = useState(initialEmail);
  const [password, setPassword] = useState("");
  const [mfaChallenge, setMfaChallenge] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function finish(result: LoginResult) {
    if (result.kind === "mfa") {
      setMfaChallenge(result.challenge);
      return;
    }
    onSession(result.token, result.role);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      finish(mfaChallenge === null ? await portalLogin(email, password) : await portalLoginMfa(code, mfaChallenge));
    } catch (err) {
      setError(mfaChallenge === null ? messageFor(err, "Anmeldung fehlgeschlagen.") : "Der Code stimmt nicht.");
    } finally {
      setBusy(false);
    }
  }

  const companyName = company.name || "SMPL";
  return (
    <main className="pp">
      <Hero company={company} headline="Ihre Aufträge. Immer dabei." lead={`Termine, Adressen und Fotos zu allem, was ${companyName} Ihnen zugewiesen hat.`} />
      <div className="pp-band-inner">
        <form className="pp-login-card" onSubmit={submit} noValidate={false}>
          <h2 className="pp-login-card-title">{mfaChallenge === null ? "Anmelden" : "Bestätigungscode"}</h2>
          {notice && !error && <div className="pp-notice" role="status">{notice}</div>}
          {mfaChallenge === null ? (
            <>
              <label className="pp-field" htmlFor="pp-login-email">
                E-Mail
                <input
                  id="pp-login-email"
                  className="pp-input"
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  autoComplete="username"
                  inputMode="email"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  required
                />
              </label>
              <label className="pp-field" htmlFor="pp-login-password">
                Passwort
                <PasswordInput id="pp-login-password" value={password} onChange={setPassword} autoComplete="current-password" />
              </label>
            </>
          ) : (
            <label className="pp-field" htmlFor="pp-login-code">
              6-stelliger Code aus Ihrer Authenticator-App
              <input
                id="pp-login-code"
                className="pp-input"
                value={code}
                onChange={(event) => setCode(event.target.value)}
                inputMode="numeric"
                autoComplete="one-time-code"
                autoFocus
                required
              />
            </label>
          )}
          {error && <div className="pp-alert" role="alert">{error}</div>}
          <button type="submit" className="pp-btn pp-btn--primary" disabled={busy}>
            {busy ? "Bitte warten …" : mfaChallenge === null ? "Anmelden" : "Bestätigen"}
          </button>
        </form>
        <div className="pp-login-help">
          <div className="pp-login-help-title">Noch kein Zugang?</div>
          <p className="pp-login-help-text">
            Ihr Ansprechpartner bei {companyName} schickt Ihnen eine Einladung per E-Mail. Passwort vergessen? Das Büro sendet Ihnen einen neuen Link.
          </p>
        </div>
      </div>
    </main>
  );
}

export function PortalSetPasswordPage({
  company,
  mode,
  token,
  onSession,
  onDone,
}: {
  company: PublicCompany;
  mode: "invite" | "reset";
  token: string;
  onSession: SessionHandler;
  onDone: (notice: string) => void;
}) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    if (!token) {
      setError("Der Link ist unvollständig. Bitte den Link aus der E-Mail vollständig öffnen.");
      return;
    }
    if (password.length < 8) {
      setError("Das Passwort braucht mindestens 8 Zeichen.");
      return;
    }
    if (password !== confirm) {
      setError("Die beiden Passwörter stimmen nicht überein.");
      return;
    }
    setBusy(true);
    try {
      if (mode === "invite") {
        const accepted = await acceptPortalInvite(token, password);
        const result = await portalLogin(accepted.email, password);
        if (result.kind === "session") {
          onSession(result.token, result.role);
          return;
        }
        onDone("Passwort gespeichert. Bitte melden Sie sich an.");
      } else {
        await confirmPortalPasswordReset(token, password);
        onDone("Neues Passwort gespeichert. Bitte melden Sie sich an.");
      }
    } catch (err) {
      setError(messageFor(err, "Das hat nicht geklappt. Bitte erneut versuchen."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="pp">
      <Hero
        company={company}
        headline={mode === "invite" ? "Willkommen im Partnerportal." : "Neues Passwort."}
        lead={mode === "invite" ? "Legen Sie Ihr Passwort fest – danach sehen Sie sofort Ihre Aufträge." : "Legen Sie ein neues Passwort für Ihren Zugang fest."}
      />
      <div className="pp-band-inner">
        <form className="pp-login-card" onSubmit={submit}>
          <h2 className="pp-login-card-title">Passwort festlegen</h2>
          <label className="pp-field" htmlFor="pp-new-password">
            Neues Passwort
            <PasswordInput id="pp-new-password" value={password} onChange={setPassword} autoComplete="new-password" minLength={8} />
            <span className="pp-hint">Mindestens 8 Zeichen.</span>
          </label>
          <label className="pp-field" htmlFor="pp-confirm-password">
            Passwort wiederholen
            <PasswordInput id="pp-confirm-password" value={confirm} onChange={setConfirm} autoComplete="new-password" minLength={8} />
          </label>
          {error && <div className="pp-alert" role="alert">{error}</div>}
          <button type="submit" className="pp-btn pp-btn--primary" disabled={busy}>
            {busy ? "Bitte warten …" : "Passwort speichern"}
          </button>
        </form>
      </div>
    </main>
  );
}
