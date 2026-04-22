import { useAppContext } from "../context/AppContext";
import { AvatarBadge } from "../components/shared/AvatarBadge";

export function ProfilePage() {
  const {
    mainView,
    language,
    user,
    openAvatarModal,
    menuUserNameById,
    userInitials,
    avatarVersionKey,
    profileSettingsForm,
    setProfileSettingsForm,
    saveProfileSettings,
    canManageUsers,
    nicknameCheckState,
    nicknameCheckMessage,
    setNicknameCheckState,
    setNicknameCheckMessage,
    browserNotifPermission,
    browserNotifIsIosPwa,
    requestBrowserNotifPermission,
  } = useAppContext();

  if (mainView !== "profile" || !user) return null;

  const de = language === "de";

  // Human-readable label for the current notification permission state.
  function notifPermissionLabel(): string {
    if (browserNotifPermission === "unsupported") {
      return de ? "Nicht unterstützt" : "Not supported";
    }
    if (browserNotifPermission === "requires-pwa") {
      return de ? "App-Installation erforderlich" : "App install required";
    }
    if (browserNotifPermission === "granted") {
      return de ? "Aktiviert" : "Enabled";
    }
    if (browserNotifPermission === "denied") {
      return de ? "Blockiert (Browsereinstellungen)" : "Blocked (browser settings)";
    }
    return de ? "Nicht aktiviert" : "Not enabled";
  }

  const displayName = menuUserNameById(user.id, user.display_name || user.full_name);

  return (
    <section className="profile-page">
      <h1 className="profile-page-title">
        {de ? "Profil & Einstellungen" : "Profile & Settings"}
      </h1>

      <div className="profile-page-grid">
        {/* ── Left: Profile card ─────────────────────────────────────── */}
        <div className="profile-page-card profile-page-card--profile">
          <header className="profile-page-card-head">
            <h2 className="profile-page-card-title">{de ? "Profil" : "Profile"}</h2>
          </header>

          <div className="profile-page-identity">
            <button
              type="button"
              className="profile-page-avatar-trigger"
              onClick={openAvatarModal}
              aria-label={de ? "Profilbild ändern" : "Change profile picture"}
              title={de ? "Profilbild ändern" : "Change profile picture"}
            >
              <AvatarBadge
                userId={user.id}
                initials={userInitials}
                hasAvatar={Boolean(user.avatar_updated_at)}
                versionKey={avatarVersionKey}
                className="profile-page-avatar"
              />
              <span className="profile-page-avatar-overlay">
                {de ? "Ändern" : "Change"}
              </span>
            </button>
            <div className="profile-page-identity-text">
              <span className="profile-page-identity-name">{displayName}</span>
              <span className="profile-page-identity-email">{user.email}</span>
              <span className="profile-page-identity-role">
                {de ? "Rolle" : "Role"}: {user.role}
              </span>
            </div>
          </div>

          <form className="profile-page-form" onSubmit={saveProfileSettings}>
            <label className="profile-page-field">
              <span className="profile-page-field-label">{de ? "Name" : "Name"}</span>
              <input
                className="profile-page-input"
                value={profileSettingsForm.full_name}
                onChange={(e) =>
                  setProfileSettingsForm({
                    ...profileSettingsForm,
                    full_name: e.target.value,
                  })
                }
                required
              />
            </label>
            <label className="profile-page-field">
              <span className="profile-page-field-label">{de ? "E-Mail" : "Email"}</span>
              <input
                className="profile-page-input"
                type="email"
                value={profileSettingsForm.email}
                onChange={(e) =>
                  setProfileSettingsForm({
                    ...profileSettingsForm,
                    email: e.target.value,
                  })
                }
                required
              />
            </label>
            {canManageUsers && (
              <label className="profile-page-field">
                <span className="profile-page-field-label">
                  {de ? "Nickname (optional)" : "Nickname (optional)"}
                </span>
                <input
                  className="profile-page-input"
                  value={profileSettingsForm.nickname}
                  onChange={(e) => {
                    setProfileSettingsForm({
                      ...profileSettingsForm,
                      nickname: e.target.value,
                    });
                    setNicknameCheckState("idle");
                    setNicknameCheckMessage("");
                  }}
                  placeholder={de ? "z. B. SiteWolf" : "e.g. SiteWolf"}
                />
                <small className="profile-page-field-hint">
                  {de
                    ? "Wird in Berichten und Exporten statt des echten Namens verwendet."
                    : "Used in reports and exports instead of real name."}
                </small>
                {nicknameCheckState !== "idle" && nicknameCheckMessage && (
                  <small className="profile-page-field-hint">{nicknameCheckMessage}</small>
                )}
              </label>
            )}
            <div className="profile-page-grid-2">
              <label className="profile-page-field">
                <span className="profile-page-field-label">
                  {de ? "Aktuelles Passwort" : "Current password"}
                </span>
                <input
                  className="profile-page-input"
                  type="password"
                  value={profileSettingsForm.current_password}
                  onChange={(e) =>
                    setProfileSettingsForm({
                      ...profileSettingsForm,
                      current_password: e.target.value,
                    })
                  }
                  placeholder={
                    de
                      ? "Nur für E-Mail/Passwort-Änderung"
                      : "Only needed when changing email/password"
                  }
                />
              </label>
              <label className="profile-page-field">
                <span className="profile-page-field-label">
                  {de ? "Neues Passwort" : "New password"}
                </span>
                <input
                  className="profile-page-input"
                  type="password"
                  minLength={8}
                  value={profileSettingsForm.new_password}
                  onChange={(e) =>
                    setProfileSettingsForm({
                      ...profileSettingsForm,
                      new_password: e.target.value,
                    })
                  }
                  placeholder={
                    de ? "Leer lassen für keine Änderung" : "Leave empty to keep current"
                  }
                />
              </label>
            </div>
            <div className="profile-page-form-actions">
              <button type="submit" className="profile-page-save-btn">
                {de ? "Profil speichern" : "Save profile"}
              </button>
            </div>
          </form>

          <small className="profile-page-footer-note">
            {de
              ? "Sprachwechsel und Abmelden sind unten in der Seitenleiste."
              : "Language switch and sign-out are available in the sidebar footer."}
          </small>
        </div>

        {/* ── Right: Notifications card ──────────────────────────────── */}
        <div className="profile-page-card profile-page-card--notifications">
          <header className="profile-page-card-head">
            <h2 className="profile-page-card-title">
              {de ? "Benachrichtigungen" : "Notifications"}
            </h2>
          </header>

          <p className="profile-page-notif-intro">
            {de
              ? "Erhalte Benachrichtigungen für neue Aufgaben und Nachrichten, auch wenn die App im Hintergrund ist."
              : "Get notifications for new tasks and messages, even when the app is in the background."}
          </p>

          <div className="profile-page-notif-status">
            <span className="profile-page-notif-status-label">
              {de ? "Status" : "Status"}:
            </span>
            <span
              className={`profile-page-notif-status-value profile-page-notif-status-value--${browserNotifPermission}`}
            >
              {notifPermissionLabel()}
            </span>
          </div>

          {/* iOS Safari in browser tab — needs PWA install */}
          {browserNotifPermission === "requires-pwa" && (
            <div className="profile-page-notif-hint">
              <p className="profile-page-notif-hint-title">
                {de ? "Nur als App verfügbar" : "Only available as an installed app"}
              </p>
              <p className="profile-page-notif-hint-body">
                {de
                  ? "Safari auf iPhone und iPad unterstützt Benachrichtigungen nur, wenn die App zum Home-Bildschirm hinzugefügt wurde."
                  : "Safari on iPhone and iPad only supports notifications when the app is added to the Home Screen."}
              </p>
              <ol className="profile-page-notif-steps">
                <li>
                  {de ? "Tippe auf das Teilen-Symbol" : "Tap the Share button"}{" "}
                  <span className="profile-page-notif-icon" aria-label="share">
                    ⎋
                  </span>{" "}
                  {de ? "in der Safari-Adressleiste" : "in the Safari toolbar"}
                </li>
                <li>
                  {de ? (
                    <>Wähle &bdquo;Zum Home-Bildschirm&ldquo;</>
                  ) : (
                    <>Choose &ldquo;Add to Home Screen&rdquo;</>
                  )}
                </li>
                <li>
                  {de
                    ? "Öffne die App vom Home-Bildschirm und aktiviere Benachrichtigungen hier"
                    : "Open the app from the Home Screen, then enable notifications here"}
                </li>
              </ol>
            </div>
          )}

          {/* Normal permission flow for all other browsers */}
          {browserNotifPermission === "default" && (
            <button
              type="button"
              className="profile-page-notif-enable-btn"
              onClick={requestBrowserNotifPermission}
            >
              {de ? "Benachrichtigungen aktivieren" : "Enable notifications"}
            </button>
          )}

          {browserNotifPermission === "granted" && (
            <p className="profile-page-notif-body-note">
              {de
                ? "Du erhältst Benachrichtigungen für neue Aufgaben und Nachrichten."
                : "You will receive notifications for new tasks and messages."}
            </p>
          )}

          {browserNotifPermission === "denied" && (
            <div className="profile-page-notif-hint">
              {browserNotifIsIosPwa ? (
                <>
                  <p className="profile-page-notif-hint-title">
                    {de ? "Benachrichtigungen nicht aktiviert" : "Notifications not enabled"}
                  </p>
                  <p className="profile-page-notif-hint-body">
                    {de
                      ? "Tippe zuerst auf den Button. Falls kein Dialogfeld erscheint, aktiviere Benachrichtigungen manuell in den Einstellungen."
                      : "Tap the button first. If no system prompt appears, enable notifications manually in Settings."}
                  </p>
                  <button
                    type="button"
                    className="profile-page-notif-enable-btn"
                    onClick={requestBrowserNotifPermission}
                  >
                    {de ? "Benachrichtigungen aktivieren" : "Enable notifications"}
                  </button>
                  <p className="profile-page-notif-hint-body">
                    {de ? "Falls der Button nichts bewirkt:" : "If the button does nothing:"}
                  </p>
                  <ol className="profile-page-notif-steps">
                    <li>
                      {de ? "Öffne die iPhone-Einstellungen" : "Open the iPhone Settings app"}
                    </li>
                    <li>
                      {de ? (
                        <>
                          Scrolle nach unten und tippe auf <strong>SMPL</strong>
                        </>
                      ) : (
                        <>
                          Scroll down and tap <strong>SMPL</strong>
                        </>
                      )}
                    </li>
                    <li>
                      {de ? (
                        <>
                          Tippe auf <strong>Mitteilungen</strong> und aktiviere{" "}
                          <strong>Mitteilungen erlauben</strong>
                        </>
                      ) : (
                        <>
                          Tap <strong>Notifications</strong> and turn on{" "}
                          <strong>Allow Notifications</strong>
                        </>
                      )}
                    </li>
                  </ol>
                </>
              ) : (
                <p className="profile-page-notif-hint-body">
                  {de
                    ? "Benachrichtigungen sind in den Browsereinstellungen blockiert. Bitte dort freigeben."
                    : "Notifications are blocked in your browser settings. Please allow them there."}
                </p>
              )}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
