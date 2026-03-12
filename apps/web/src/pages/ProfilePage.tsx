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
    isAdmin,
    nicknameCheckState,
    nicknameCheckMessage,
    setNicknameCheckState,
    setNicknameCheckMessage,
    browserNotifPermission,
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

  return (
    <section className="profile-layout">
      <div className="profile-left-stack">
        <div className="card profile-settings-card">
          <h3>{de ? "Profil & Einstellungen" : "Profile & settings"}</h3>

          <div className="row wrap profile-head-row">
            <button
              type="button"
              className="profile-avatar-trigger"
              onClick={openAvatarModal}
              aria-label={de ? "Profilbild ändern" : "Change profile picture"}
              title={de ? "Profilbild ändern" : "Change profile picture"}
            >
              <AvatarBadge
                userId={user.id}
                initials={userInitials}
                hasAvatar={Boolean(user.avatar_updated_at)}
                versionKey={avatarVersionKey}
                className="profile-avatar"
              />
              <span className="profile-avatar-overlay">{de ? "Ändern" : "Change"}</span>
            </button>
            <div className="metric-stack">
              <b>{menuUserNameById(user.id, user.display_name || user.full_name)}</b>
              <small>{user.email}</small>
              <small className="muted">{de ? "Rolle" : "Role"}: {user.role}</small>
            </div>
          </div>

          <form className="modal-form" onSubmit={saveProfileSettings}>
            <label>
              {de ? "Name" : "Name"}
              <input
                value={profileSettingsForm.full_name}
                onChange={(e) =>
                  setProfileSettingsForm({ ...profileSettingsForm, full_name: e.target.value })
                }
                required
              />
            </label>
            <label>
              {de ? "E-Mail" : "Email"}
              <input
                type="email"
                value={profileSettingsForm.email}
                onChange={(e) =>
                  setProfileSettingsForm({ ...profileSettingsForm, email: e.target.value })
                }
                required
              />
            </label>
            {isAdmin && (
              <label>
                {de ? "Nickname (optional)" : "Nickname (optional)"}
                <input
                  value={profileSettingsForm.nickname}
                  onChange={(e) => {
                    setProfileSettingsForm({ ...profileSettingsForm, nickname: e.target.value });
                    setNicknameCheckState("idle");
                    setNicknameCheckMessage("");
                  }}
                  placeholder={de ? "z. B. SiteWolf" : "e.g. SiteWolf"}
                />
                <small className="muted">
                  {de
                    ? "Wird in Berichten und Exporten statt des echten Namens verwendet. Leer lassen zum Entfernen."
                    : "Used in reports and exports instead of real name. Leave empty to remove."}
                </small>
                {nicknameCheckState !== "idle" && nicknameCheckMessage && (
                  <small className="muted">{nicknameCheckMessage}</small>
                )}
              </label>
            )}
            <label>
              {de ? "Aktuelles Passwort" : "Current password"}
              <input
                type="password"
                value={profileSettingsForm.current_password}
                onChange={(e) =>
                  setProfileSettingsForm({ ...profileSettingsForm, current_password: e.target.value })
                }
                placeholder={de ? "Nur für E-Mail/Passwort-Änderung nötig" : "Only needed when changing email or password"}
              />
            </label>
            <label>
              {de ? "Neues Passwort" : "New password"}
              <input
                type="password"
                minLength={8}
                value={profileSettingsForm.new_password}
                onChange={(e) =>
                  setProfileSettingsForm({ ...profileSettingsForm, new_password: e.target.value })
                }
                placeholder={de ? "Leer lassen für keine Änderung" : "Leave empty to keep current"}
              />
            </label>
            <div className="row wrap">
              <button type="submit">{de ? "Profil speichern" : "Save profile"}</button>
            </div>
          </form>

          <small className="muted">
            {de
              ? "Sprachwechsel und Abmelden sind unten in der Seitenleiste."
              : "Language switch and sign-out are available in the sidebar footer."}
          </small>
        </div>

        {/* ── Browser notification permission ─────────────────────────────── */}
        <div className="card profile-settings-card">
          <h3>{de ? "Benachrichtigungen" : "Notifications"}</h3>
          <p className="muted" style={{ marginBottom: "0.75rem" }}>
            {de
              ? "Erhalte Benachrichtigungen für neue Aufgaben und Nachrichten, auch wenn die App im Hintergrund ist."
              : "Get notifications for new tasks and messages, even when the app is in the background."}
          </p>

          {/* iOS Safari in browser tab — needs PWA install */}
          {browserNotifPermission === "requires-pwa" && (
            <div className="notif-pwa-hint">
              <p className="notif-pwa-hint-title">
                {de ? "Nur als App verfügbar" : "Only available as an installed app"}
              </p>
              <p className="muted" style={{ fontSize: "0.85rem", margin: "0.35rem 0 0.75rem" }}>
                {de
                  ? "Safari auf iPhone und iPad unterstützt Benachrichtigungen nur, wenn die App zum Home-Bildschirm hinzugefügt wurde."
                  : "Safari on iPhone and iPad only supports notifications when the app is added to the Home Screen."}
              </p>
              <ol className="notif-pwa-steps">
                <li>
                  {de
                    ? "Tippe auf das Teilen-Symbol"
                    : "Tap the Share button"}{" "}
                  <span className="notif-pwa-icon" aria-label="share">⎋</span>{" "}
                  {de ? "in der Safari-Adressleiste" : "in the Safari toolbar"}
                </li>
                <li>
                  {de
                    ? <>Wähle &bdquo;Zum Home-Bildschirm&ldquo;</>
                    : <>Choose &ldquo;Add to Home Screen&rdquo;</>}
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
          {browserNotifPermission !== "requires-pwa" && (
            <div className="row wrap" style={{ gap: "0.75rem", alignItems: "center" }}>
              <span className="muted">
                {de ? "Status" : "Status"}:{" "}
                <strong>{notifPermissionLabel()}</strong>
              </span>
              {browserNotifPermission === "default" && (
                <button type="button" onClick={requestBrowserNotifPermission}>
                  {de ? "Benachrichtigungen aktivieren" : "Enable notifications"}
                </button>
              )}
              {browserNotifPermission === "denied" && (
                <small className="muted">
                  {de
                    ? "Benachrichtigungen sind in den Browsereinstellungen blockiert. Bitte dort freigeben."
                    : "Notifications are blocked in your browser settings. Please allow them there."}
                </small>
              )}
              {browserNotifPermission === "granted" && (
                <small className="muted">
                  {de
                    ? "Du erhältst Benachrichtigungen für neue Aufgaben und Nachrichten."
                    : "You will receive notifications for new tasks and messages."}
                </small>
              )}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
