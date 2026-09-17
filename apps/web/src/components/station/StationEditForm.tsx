/**
 * StationEditForm — name, location and the agent-address override, inline in
 * the status card.
 *
 * The override exists for one situation: the Pi reported an address the API
 * cannot use (a docker0 or VPN interface, or a Pi on another subnet). It is
 * validated server-side to a private LAN address; the form only carries the
 * text and shows the API's sentence when it is refused.
 */
import type { StationT } from "./stationText";

export interface StationEditDraft {
  name: string;
  location: string;
  agentUrl: string;
}

export type StationEditField = keyof StationEditDraft;

export interface StationEditFormProps {
  t: StationT;
  draft: StationEditDraft;
  busy: boolean;
  error: string | null;
  onChange: (field: StationEditField, value: string) => void;
  onCancel: () => void;
  onSave: () => void;
}

export function StationEditForm({ t, draft, busy, error, onChange, onCancel, onSave }: StationEditFormProps) {
  return (
    <form
      className="pi-station-edit"
      onSubmit={(event) => {
        event.preventDefault();
        onSave();
      }}
    >
      <label className="admin-invite-field">
        <span className="admin-invite-field-label">{t("nameLabel")}</span>
        <input
          type="text"
          className="admin-invite-input"
          value={draft.name}
          onChange={(event) => onChange("name", event.target.value)}
          maxLength={128}
          required
          autoComplete="off"
        />
      </label>
      <label className="admin-invite-field">
        <span className="admin-invite-field-label">{t("location")}</span>
        <input
          type="text"
          className="admin-invite-input"
          value={draft.location}
          onChange={(event) => onChange("location", event.target.value)}
          placeholder={t("locationPlaceholder")}
          maxLength={128}
          autoComplete="off"
        />
      </label>
      {/* The hint sits beside the label, not inside it: a label's accessible
          name is its whole text, and a screen reader (or a test) asking for
          "Agent-Adresse" must not get the hint read back as the field name. */}
      <div className="pi-station-edit-wide">
        <label className="admin-invite-field">
          <span className="admin-invite-field-label">{t("agentUrl")}</span>
          <input
            type="text"
            className="admin-invite-input pi-station-mono"
            value={draft.agentUrl}
            onChange={(event) => onChange("agentUrl", event.target.value)}
            placeholder="http://192.168.2.235:8765"
            maxLength={200}
            autoComplete="off"
            inputMode="url"
          />
        </label>
        <p className="pi-station-hint">{t("agentUrlHint")}</p>
      </div>
      {error && <p className="pi-station-feedback pi-station-feedback--bad pi-station-edit-wide">{error}</p>}
      <div className="pi-station-actions pi-station-edit-wide">
        <button type="submit" className="admin-invite-submit" disabled={busy}>
          {busy ? t("saving") : t("save")}
        </button>
        <button type="button" className="werkstatt-card-action" onClick={onCancel} disabled={busy}>
          {t("cancel")}
        </button>
      </div>
    </form>
  );
}
