import { useAppContext } from "../context/AppContext";

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
    submitPublicInviteAccept,
    submitPublicPasswordReset,
    resetPublicAuthRoute,
  } = useAppContext();

  if (user) return null;

  const isPublicTokenFlow = publicAuthMode === "invite" || publicAuthMode === "reset";
  return (
    <main className="login-shell">
      {isPublicTokenFlow ? (
        <form
          className="card auth-card"
          onSubmit={publicAuthMode === "invite" ? submitPublicInviteAccept : submitPublicPasswordReset}
        >
          <img src="/logo.jpeg" alt="Company logo" className="brand-logo large" />
          <h1>SMPL Workflow</h1>
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
            <input value={publicToken} onChange={(event) => setPublicToken(event.target.value)} required />
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
                />
              </label>
            </>
          )}
          <label>
            {language === "de" ? "Neues Passwort" : "New password"}
            <input
              type="password"
              minLength={8}
              value={publicNewPassword}
              onChange={(event) => setPublicNewPassword(event.target.value)}
              required
            />
          </label>
          <label>
            {language === "de" ? "Passwort bestätigen" : "Confirm password"}
            <input
              type="password"
              minLength={8}
              value={publicConfirmPassword}
              onChange={(event) => setPublicConfirmPassword(event.target.value)}
              required
            />
          </label>
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
      ) : (
        <form className="card auth-card" onSubmit={onLogin}>
          <img src="/logo.jpeg" alt="Company logo" className="brand-logo large" />
          <h1>SMPL Workflow</h1>
          <p>{language === "de" ? "Private, selbst gehostete Workflow-App" : "Private self-hosted workflow app"}</p>
          <label>
            Email
            <input value={email} onChange={(e) => setEmail(e.target.value)} />
          </label>
          <label>
            {language === "de" ? "Passwort" : "Password"}
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </label>
          <div className="row">
            <button type="submit">{language === "de" ? "Anmelden" : "Sign in"}</button>
            <button type="button" onClick={() => setLanguage(language === "de" ? "en" : "de")}>
              {language === "de" ? "EN" : "DE"}
            </button>
          </div>
          {error && <div className="error">{error}</div>}
          {notice && <div className="notice">{notice}</div>}
        </form>
      )}
    </main>
  );
}
