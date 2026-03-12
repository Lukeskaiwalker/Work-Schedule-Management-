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
  } = useAppContext();

  if (mainView !== "profile" || !user) return null;

  const de = language === "de";

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
      </div>
    </section>
  );
}
