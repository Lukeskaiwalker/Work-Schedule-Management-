/**
 * StationPairingCard — the admin half of the device grant.
 *
 * The direction is load-bearing (RFC 8628): the Pi asks the API for a code and
 * shows it on its own screen; this card lists what has been asked for and lets
 * an admin approve or deny it. An admin cannot mint a credential for a device
 * that never asked, which is the property that makes the unauthenticated
 * `pair/start` endpoint safe to expose.
 */
import type { StationPairingRequest } from "../../utils/stationApi";
import { formatCountdown, type StationT } from "./stationText";

export interface StationPairingCardProps {
  t: StationT;
  /** Codes waiting for a decision, newest first as the API returns them. */
  pending: StationPairingRequest[];
  /** Draft station names, keyed by user code. */
  pairingNames: Record<string, string>;
  pairingBusy: boolean;
  pairingError: string | null;
  onNameChange: (userCode: string, name: string) => void;
  onApprove: (row: StationPairingRequest) => void;
  onDeny: (row: StationPairingRequest) => void;
}

function PairingRequestRow({
  row,
  t,
  name,
  busy,
  onNameChange,
  onApprove,
  onDeny,
}: {
  row: StationPairingRequest;
  t: StationT;
  name: string;
  busy: boolean;
  onNameChange: (userCode: string, name: string) => void;
  onApprove: (row: StationPairingRequest) => void;
  onDeny: (row: StationPairingRequest) => void;
}) {
  return (
    <div className="pi-station-pairing">
      <output className="pi-station-code">{row.user_code}</output>
      <p className="pi-station-countdown">
        {row.device_hint ? <b>{row.device_hint}</b> : null}
        {row.agent_version ? ` · Agent ${row.agent_version}` : ""}
        {row.requested_ip ? ` · ${row.requested_ip}` : ""}
        {" · "}
        {t("pairingValidFor")} <b>{formatCountdown(Math.max(0, row.expires_in))}</b>
      </p>
      <label className="admin-invite-field">
        <span className="admin-invite-field-label">{t("pairingName")}</span>
        <input
          type="text"
          className="admin-invite-input"
          value={name}
          onChange={(event) => onNameChange(row.user_code, event.target.value)}
          placeholder={row.device_hint ?? t("pairingNamePlaceholder")}
          maxLength={60}
          autoComplete="off"
        />
      </label>
      <div className="pi-station-actions">
        <button
          type="button"
          className="admin-invite-submit"
          onClick={() => onApprove(row)}
          disabled={busy}
        >
          {t("pairingApprove")}
        </button>
        <button
          type="button"
          className="werkstatt-card-action"
          onClick={() => onDeny(row)}
          disabled={busy}
        >
          {t("pairingDeny")}
        </button>
      </div>
    </div>
  );
}

export function StationPairingCard({
  t,
  pending,
  pairingNames,
  pairingBusy,
  pairingError,
  onNameChange,
  onApprove,
  onDeny,
}: StationPairingCardProps) {
  return (
    <div className="admin-page-card">
      <h2 className="admin-page-card-title">{t("pairingTitle")}</h2>
      <p className="admin-tools-desc">{t("pairingIntro")}</p>

      {pending.length === 0 && <p className="pi-station-feedback">{t("pairingNone")}</p>}

      {pending.map((row) => (
        <PairingRequestRow
          key={row.user_code}
          row={row}
          t={t}
          name={pairingNames[row.user_code] ?? ""}
          busy={pairingBusy}
          onNameChange={onNameChange}
          onApprove={onApprove}
          onDeny={onDeny}
        />
      ))}

      {pairingError && (
        <p className="pi-station-feedback pi-station-feedback--bad">{pairingError}</p>
      )}
    </div>
  );
}
