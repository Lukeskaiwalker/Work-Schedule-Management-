import { useState } from "react";
import { apiFetch, ApiError } from "../../api/client";
import { useAppContext } from "../../context/AppContext";
import type { User } from "../../types";

type EnrollData = {
  secret: string;
  otpauth_uri: string;
  qr_data_uri: string;
};

type VerifyResult = {
  ok: boolean;
  mfa_enabled: boolean;
  recovery_codes: string[];
};

/**
 * TOTP two-factor authentication panel on the profile page.
 *
 * Three states, driven by `user.mfa_enabled` plus local enrollment progress:
 *   1. Off — a "Enable" button that begins enrollment (QR + secret + code field).
 *   2. Enrolling — show the QR, wait for a valid code, then reveal the one-time
 *      recovery codes (shown exactly once).
 *   3. On — status + a disable form requiring the current password AND a code.
 */
export function TwoFactorSection() {
  const { language, token: sessionToken, user, setUser } = useAppContext();
  const de = language === "de";

  const [enroll, setEnroll] = useState<EnrollData | null>(null);
  const [enrollPassword, setEnrollPassword] = useState("");
  const [code, setCode] = useState("");
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [disablePassword, setDisablePassword] = useState("");
  const [disableCode, setDisableCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!user) return null;
  const enabled = Boolean(user.mfa_enabled);

  async function beginEnroll(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!sessionToken) return;
    setBusy(true);
    setError(null);
    try {
      const data = await apiFetch<EnrollData>("/auth/me/mfa/enroll", sessionToken, {
        method: "POST",
        body: JSON.stringify({ current_password: enrollPassword }),
      });
      setEnroll(data);
      setEnrollPassword("");
      setCode("");
      setRecoveryCodes(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function confirmEnroll(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!sessionToken) return;
    setBusy(true);
    setError(null);
    try {
      const result = await apiFetch<VerifyResult>("/auth/me/mfa/verify", sessionToken, {
        method: "POST",
        body: JSON.stringify({ code: code.trim() }),
      });
      setRecoveryCodes(result.recovery_codes);
      setEnroll(null);
      setCode("");
      setUser({ ...(user as User), mfa_enabled: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function disable(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!sessionToken) return;
    setBusy(true);
    setError(null);
    try {
      const updated = await apiFetch<User>("/auth/me/mfa/disable", sessionToken, {
        method: "POST",
        body: JSON.stringify({ current_password: disablePassword, code: disableCode.trim() }),
      });
      setUser(updated);
      setDisablePassword("");
      setDisableCode("");
      setRecoveryCodes(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="profile-page-card profile-page-card--mfa">
      <header className="profile-page-card-head">
        <h2 className="profile-page-card-title">
          {de ? "Zwei-Faktor-Authentifizierung" : "Two-factor authentication"}
        </h2>
      </header>

      <p className="api-tokens-intro">
        {de
          ? "Schütze dein Konto mit einem zeitbasierten Code (TOTP) aus einer Authenticator-App zusätzlich zum Passwort."
          : "Protect your account with a time-based code (TOTP) from an authenticator app in addition to your password."}
      </p>

      {error && <p className="api-tokens-error">{error}</p>}

      {/* ── One-time recovery codes (shown right after enabling) ─────────── */}
      {recoveryCodes && (
        <div className="api-tokens-just-minted" role="alert">
          <strong className="api-tokens-just-minted-title">
            {de ? "Wiederherstellungscodes" : "Recovery codes"}
          </strong>
          <p className="api-tokens-just-minted-warning">
            {de
              ? "Bewahre diese Codes sicher auf. Jeder Code funktioniert einmal, falls du keinen Zugriff auf deine App hast. Sie werden nur einmal angezeigt."
              : "Store these somewhere safe. Each code works once if you lose access to your app. They are shown only once."}
          </p>
          <textarea
            className="api-tokens-just-minted-input"
            readOnly
            rows={5}
            value={recoveryCodes.join("\n")}
            onFocus={(e) => e.currentTarget.select()}
          />
          <button
            type="button"
            className="api-tokens-just-minted-dismiss"
            onClick={() => setRecoveryCodes(null)}
          >
            {de ? "Habe ich gespeichert" : "I've saved them"}
          </button>
        </div>
      )}

      {enabled ? (
        // ── State: enabled → offer disable ────────────────────────────────
        !recoveryCodes && (
          <form className="api-tokens-mint-form" onSubmit={disable}>
            <p className="mfa-status-on">
              {de ? "✓ Zwei-Faktor-Authentifizierung ist aktiv." : "✓ Two-factor authentication is on."}
            </p>
            <label className="profile-page-field">
              <span className="profile-page-field-label">{de ? "Aktuelles Passwort" : "Current password"}</span>
              <input
                className="profile-page-input"
                type="password"
                value={disablePassword}
                onChange={(e) => setDisablePassword(e.target.value)}
                autoComplete="current-password"
                required
              />
            </label>
            <label className="profile-page-field">
              <span className="profile-page-field-label">{de ? "Code" : "Code"}</span>
              <input
                className="profile-page-input"
                value={disableCode}
                onChange={(e) => setDisableCode(e.target.value)}
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="123456"
                required
              />
            </label>
            <div className="profile-page-form-actions">
              <button type="submit" className="danger-btn" disabled={busy}>
                {busy ? (de ? "Bitte warten…" : "Please wait…") : de ? "Deaktivieren" : "Disable"}
              </button>
            </div>
          </form>
        )
      ) : enroll ? (
        // ── State: enrolling → show QR + confirm code ─────────────────────
        <form className="api-tokens-mint-form" onSubmit={confirmEnroll}>
          <p className="mfa-enroll-step">
            {de
              ? "1. Scanne den QR-Code mit deiner Authenticator-App (oder gib den Schlüssel manuell ein)."
              : "1. Scan the QR code with your authenticator app (or enter the key manually)."}
          </p>
          <img
            src={enroll.qr_data_uri}
            alt={de ? "2FA QR-Code" : "2FA QR code"}
            className="mfa-qr"
            style={{ width: 180, height: 180 }}
          />
          <label className="profile-page-field">
            <span className="profile-page-field-label">{de ? "Schlüssel (manuell)" : "Key (manual entry)"}</span>
            <input className="profile-page-input" readOnly value={enroll.secret} onFocus={(e) => e.currentTarget.select()} />
          </label>
          <label className="profile-page-field">
            <span className="profile-page-field-label">
              {de ? "2. Code aus der App eingeben" : "2. Enter the code from the app"}
            </span>
            <input
              className="profile-page-input"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder="123456"
              autoFocus
              required
            />
          </label>
          <div className="profile-page-form-actions">
            <button type="submit" className="profile-page-save-btn" disabled={busy}>
              {busy ? (de ? "Wird geprüft…" : "Verifying…") : de ? "Aktivieren" : "Enable"}
            </button>
            <button type="button" onClick={() => setEnroll(null)} disabled={busy}>
              {de ? "Abbrechen" : "Cancel"}
            </button>
          </div>
        </form>
      ) : (
        // ── State: off → confirm password, then begin enrollment ──────────
        !recoveryCodes && (
          <form className="api-tokens-mint-form" onSubmit={beginEnroll}>
            <label className="profile-page-field">
              <span className="profile-page-field-label">
                {de ? "Aktuelles Passwort zum Aktivieren" : "Current password to enable"}
              </span>
              <input
                className="profile-page-input"
                type="password"
                value={enrollPassword}
                onChange={(e) => setEnrollPassword(e.target.value)}
                autoComplete="current-password"
                required
              />
            </label>
            <div className="profile-page-form-actions">
              <button type="submit" className="profile-page-save-btn" disabled={busy}>
                {busy ? (de ? "Bitte warten…" : "Please wait…") : de ? "Aktivieren" : "Enable"}
              </button>
            </div>
          </form>
        )
      )}
    </div>
  );
}
