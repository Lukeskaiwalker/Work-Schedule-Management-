import { useState, type ChangeEvent } from "react";
import { useAppContext } from "../context/AppContext";
import { EyeIcon, EyeOffIcon } from "../components/icons";

/**
 * Password input with a show/hide toggle — used in all three login flows
 * (sign-in, invite acceptance, password reset) so the affordance is
 * consistent.
 *
 * `type` toggles between "password" and "text" based on local state; the
 * form value is still controlled by the parent so nothing about submission
 * or validation changes.
 */
function PasswordField({
  label,
  value,
  onChange,
  minLength,
  required,
  showLabel,
  hideLabel,
  autoComplete,
}: {
  label: string;
  value: string;
  onChange: (e: ChangeEvent<HTMLInputElement>) => void;
  minLength?: number;
  required?: boolean;
  showLabel: string;
  hideLabel: string;
  autoComplete?: string;
}) {
  const [visible, setVisible] = useState(false);
  return (
    <label>
      {label}
      <div className="login-password-wrap">
        <input
          type={visible ? "text" : "password"}
          value={value}
          onChange={onChange}
          minLength={minLength}
          required={required}
          autoComplete={autoComplete}
        />
        <button
          type="button"
          className="login-password-toggle"
          onClick={() => setVisible((v) => !v)}
          aria-label={visible ? hideLabel : showLabel}
          aria-pressed={visible}
          title={visible ? hideLabel : showLabel}
          tabIndex={-1}
        >
          {visible ? <EyeOffIcon /> : <EyeIcon />}
        </button>
      </div>
    </label>
  );
}

export function LoginPage() {
  const {
    user,
    language,
    setLanguage,
    publicAuthMode,
    publicToken,
    setPublicToken,
    publicFullName,
    setPublicFullName,
    publicEmail,
    setPublicEmail,
    publicNewPassword,
    setPublicNewPassword,
    publicConfirmPassword,
    setPublicConfirmPassword,
    email,
    setEmail,
    password,
    setPassword,
    error,
    notice,
    onLogin,
    mfaLoginPending,
    mfaCode,
    setMfaCode,
    submitMfaLogin,
    cancelMfaLogin,
    submitPublicInviteAccept,
    submitPublicPasswordReset,
    resetPublicAuthRoute,
    companySettings,
    sessionExpired,
  } = useAppContext();

  if (user) return null;

  const isPublicTokenFlow = publicAuthMode === "invite" || publicAuthMode === "reset";
  const brandLogoUrl = companySettings?.logo_url?.trim() || "/logo.jpeg";
  const brandTitle = companySettings?.navigation_title?.trim() || "SMPL Workflow";
  const showPasswordLabel = language === "de" ? "Passwort anzeigen" : "Show password";
  const hidePasswordLabel = language === "de" ? "Passwort verbergen" : "Hide password";
  return (
    <main className="login-shell">
      {isPublicTokenFlow ? (
        <form
          className="card auth-card"
          onSubmit={publicAuthMode === "invite" ? submitPublicInviteAccept : submitPublicPasswordReset}
        >
          <img src={brandLogoUrl} alt="Company logo" className="brand-logo large" />
          <h1>{brandTitle}</h1>
          <p>
            {publicAuthMode === "invite"
              ? language === "de"
                ? "Einladung annehmen"
                : "Accept invitation"
              : language === "de"
                ? "Passwort zurücksetzen"
                : "Reset password"}
          </p>
          <label>
            Token
            {/* Invite and reset tokens are case-sensitive and compared
                verbatim, so autocapitalisation or autocorrect on a phone
                does not just look wrong — it makes a valid token fail. */}
            <input
              value={publicToken}
              onChange={(event) => setPublicToken(event.target.value)}
              required
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
            />
          </label>
          {publicAuthMode === "invite" && (
            <>
              <label>
                {language === "de" ? "Name (optional)" : "Name (optional)"}
                <input value={publicFullName} onChange={(event) => setPublicFullName(event.target.value)} />
              </label>
              <label>
                {language === "de" ? "E-Mail (optional)" : "Email (optional)"}
                <input
                  type="email"
                  value={publicEmail}
                  onChange={(event) => setPublicEmail(event.target.value)}
                  inputMode="email"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                />
              </label>
            </>
          )}
          <PasswordField
            label={language === "de" ? "Neues Passwort" : "New password"}
            value={publicNewPassword}
            onChange={(event) => setPublicNewPassword(event.target.value)}
            minLength={8}
            required
            showLabel={showPasswordLabel}
            hideLabel={hidePasswordLabel}
            autoComplete="new-password"
          />
          <PasswordField
            label={language === "de" ? "Passwort bestätigen" : "Confirm password"}
            value={publicConfirmPassword}
            onChange={(event) => setPublicConfirmPassword(event.target.value)}
            minLength={8}
            required
            showLabel={showPasswordLabel}
            hideLabel={hidePasswordLabel}
            autoComplete="new-password"
          />
          <div className="row wrap">
            <button type="submit">
              {publicAuthMode === "invite"
                ? language === "de"
                  ? "Einladung bestätigen"
                  : "Accept invite"
                : language === "de"
                  ? "Passwort setzen"
                  : "Set password"}
            </button>
            <button type="button" onClick={resetPublicAuthRoute}>
              {language === "de" ? "Zur Anmeldung" : "Back to sign in"}
            </button>
            <button type="button" onClick={() => setLanguage(language === "de" ? "en" : "de")}>
              {language === "de" ? "EN" : "DE"}
            </button>
          </div>
          {error && <div className="error">{error}</div>}
          {notice && <div className="notice">{notice}</div>}
        </form>
      ) : mfaLoginPending ? (
        <form className="card auth-card" onSubmit={submitMfaLogin}>
          <img src={brandLogoUrl} alt="Company logo" className="brand-logo large" />
          <h1>{brandTitle}</h1>
          <p>{language === "de" ? "Zwei-Faktor-Authentifizierung" : "Two-factor authentication"}</p>
          <label>
            {language === "de" ? "6-stelliger Code" : "6-digit code"}
            <input
              value={mfaCode}
              onChange={(e) => setMfaCode(e.target.value)}
              inputMode="numeric"
              autoComplete="one-time-code"
              autoFocus
              placeholder="123456"
            />
          </label>
          <small className="muted">
            {language === "de"
              ? "Code aus deiner Authenticator-App oder ein Wiederherstellungscode."
              : "Code from your authenticator app, or a recovery code."}
          </small>
          <div className="row">
            <button type="submit">{language === "de" ? "Bestätigen" : "Verify"}</button>
            <button type="button" onClick={cancelMfaLogin}>
              {language === "de" ? "Abbrechen" : "Cancel"}
            </button>
          </div>
          {error && <div className="error">{error}</div>}
          {notice && <div className="notice">{notice}</div>}
        </form>
      ) : (
        <form className="card auth-card" onSubmit={onLogin}>
          <img src={brandLogoUrl} alt="Company logo" className="brand-logo large" />
          <h1>{brandTitle}</h1>
          <p>{language === "de" ? "Private, selbst gehostete Workflow-App" : "Private self-hosted workflow app"}</p>
          <label>
            Email
            {/* iOS applies sentence-case to a bare text input, so a phone
                keyboard turns "dev@…" into "Dev@…" before the value ever
                reaches the form. The server lower-cases the address so this
                particular field survived it, but nothing guaranteed that —
                and the shifted first character is visible in the box, which
                reads as a typo the user did not make. inputMode brings up the
                keyboard with the @ key. */}
            <input
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="username"
              inputMode="email"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
            />
          </label>
          <PasswordField
            label={language === "de" ? "Passwort" : "Password"}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            showLabel={showPasswordLabel}
            hideLabel={hidePasswordLabel}
            autoComplete="current-password"
          />
          <div className="row">
            <button type="submit">{language === "de" ? "Anmelden" : "Sign in"}</button>
            <button type="button" onClick={() => setLanguage(language === "de" ? "en" : "de")}>
              {language === "de" ? "EN" : "DE"}
            </button>
          </div>
          {sessionExpired && !error && (
            <div className="notice auth-session-expired" role="status">
              {language === "de"
                ? "Deine Sitzung ist abgelaufen. Bitte melde dich erneut an — nicht gespeicherte Eingaben gehen verloren."
                : "Your session has expired. Please sign in again — anything unsaved was not submitted."}
            </div>
          )}
          {error && <div className="error">{error}</div>}
          {notice && <div className="notice">{notice}</div>}
        </form>
      )}
    </main>
  );
}
