/**
 * StationStatusCard — "is the box up, and what is plugged into it".
 *
 * The card resolves into a *statement* in every branch: the API is not there
 * yet, the request failed, nothing is paired, or here is the station. It never
 * spins forever, because the thing it describes is a Pi on a shelf that can be
 * unplugged.
 *
 * It owns no data. `PiStationPage` polls; this renders what it is handed and
 * calls back for the four actions.
 */
import type { Station, StationStatus } from "../../utils/stationApi";
import { stationStatus } from "../../utils/stationApi";
import { FeedbackLine, MetaItem, StatusPill, type Feedback } from "./StationPrimitives";
import {
  formatAge,
  formatStamp,
  formatUptime,
  statusKey,
  type StationT,
} from "./stationText";

/** The four one-shot actions; also the busy key, so only one runs at a time. */
export type StationActionKind = "print" | "recheck" | "restart" | "unpair";

export type StationListState = "loading" | "ready" | "error" | "missing";

export interface StationStatusCardProps {
  t: StationT;
  de: boolean;
  /** Ticking clock from the page, so relative ages stay honest. */
  now: number;
  stations: Station[];
  listState: StationListState;
  listError: string | null;
  selected: Station | null;
  selectedId: number | null;
  onSelect: (stationId: number) => void;
  actionBusy: StationActionKind | null;
  actionFeedback: Feedback | null;
  restartArmed: boolean;
  onArmRestart: (armed: boolean) => void;
  onTestPrint: () => void;
  onRecheck: () => void;
  onRestart: () => void;
  onUnpair: () => void;
}

// ── Pieces ───────────────────────────────────────────────────────────────

function StationSwitcher({
  stations,
  selectedId,
  onSelect,
  t,
  now,
}: {
  stations: Station[];
  selectedId: number | null;
  onSelect: (stationId: number) => void;
  t: StationT;
  now: number;
}) {
  return (
    <div className="pi-station-switcher">
      {stations.map((station) => {
        const status: StationStatus = stationStatus(station, now);
        return (
          <button
            key={station.id}
            type="button"
            aria-pressed={station.id === selectedId}
            className={`pi-station-switcher-btn${
              station.id === selectedId ? " pi-station-switcher-btn--active" : ""
            }`}
            onClick={() => onSelect(station.id)}
          >
            <StatusPill status={status} label={t(statusKey(status))} />
            {station.name}
          </button>
        );
      })}
    </div>
  );
}

function StationMetaGrid({ station, t, de, now }: { station: Station; t: StationT; de: boolean; now: number }) {
  const address = station.host
    ? `${station.host}${station.port ? `:${station.port}` : ""}`
    : "—";
  const paired = station.paired_at
    ? `${formatStamp(station.paired_at, de)}${
        station.paired_by_name ? ` · ${station.paired_by_name}` : ""
      }`
    : "—";

  return (
    <dl className="pi-station-meta">
      <MetaItem label={t("version")} value={station.agent_version ?? "—"} mono />
      <MetaItem label={t("uptime")} value={formatUptime(station.uptime_seconds, de)} />
      <MetaItem label={t("lastSeen")} value={formatAge(station.last_seen_at, de, now)} />
      <MetaItem label={t("address")} value={address} mono />
      <MetaItem label={t("pairedAt")} value={paired} />
    </dl>
  );
}

function HardwareRow({ ok, label, value }: { ok: boolean; label: string; value: string }) {
  return (
    <li className="pi-station-hw-row">
      <span className={`pi-station-dot${ok ? " pi-station-dot--ok" : " pi-station-dot--bad"}`} />
      <span className="pi-station-hw-label">{label}</span>
      <span className="pi-station-hw-value">{value}</span>
    </li>
  );
}

function StationHardware({ station, t }: { station: Station; t: StationT }) {
  const hw = station.hardware;

  const printerValue = hw?.printer_connected
    ? [
        hw.printer_model ?? "Brother PT-P710BT",
        t("printerOk"),
        hw.media_width_mm ? `${t("tape")} ${hw.media_width_mm} mm` : null,
      ]
        .filter(Boolean)
        .join(" · ")
    : (hw?.printer_error ?? t("printerMissing"));

  const scannerValue = hw?.scanner_present
    ? [hw.scanner_name, t("scannerOk")].filter(Boolean).join(" · ")
    : t("scannerMissing");

  return (
    <ul className="pi-station-hw">
      <HardwareRow ok={Boolean(hw?.printer_connected)} label={t("printer")} value={printerValue} />
      <HardwareRow ok={Boolean(hw?.scanner_present)} label={t("scanner")} value={scannerValue} />
    </ul>
  );
}

function StationActionBar({
  t,
  busy,
  actionBusy,
  restartArmed,
  onArmRestart,
  onTestPrint,
  onRecheck,
  onRestart,
  onUnpair,
}: {
  t: StationT;
  busy: boolean;
  actionBusy: StationActionKind | null;
  restartArmed: boolean;
  onArmRestart: (armed: boolean) => void;
  onTestPrint: () => void;
  onRecheck: () => void;
  onRestart: () => void;
  onUnpair: () => void;
}) {
  return (
    <div className="pi-station-actions">
      <button
        type="button"
        className="admin-invite-submit admin-invite-submit--secondary"
        onClick={onTestPrint}
        disabled={busy}
      >
        {actionBusy === "print" ? t("testPrinting") : t("testPrint")}
      </button>
      <button
        type="button"
        className="admin-invite-submit admin-invite-submit--secondary"
        onClick={onRecheck}
        disabled={busy}
      >
        {actionBusy === "recheck" ? t("rechecking") : t("recheck")}
      </button>
      {restartArmed ? (
        <>
          <button type="button" className="pi-station-danger-btn" onClick={onRestart} disabled={busy}>
            {actionBusy === "restart" ? t("restarting") : t("restartYes")}
          </button>
          <button type="button" className="werkstatt-card-action" onClick={() => onArmRestart(false)}>
            {t("cancel")}
          </button>
        </>
      ) : (
        <button
          type="button"
          className="admin-invite-submit admin-invite-submit--secondary"
          onClick={() => onArmRestart(true)}
          disabled={busy}
        >
          {t("restart")}
        </button>
      )}
      <button
        type="button"
        className="werkstatt-card-action pi-station-unpair"
        onClick={onUnpair}
        disabled={busy}
      >
        {t("unpair")}
      </button>
    </div>
  );
}

function StationDetail({
  station,
  t,
  de,
  now,
  actionBusy,
  actionFeedback,
  restartArmed,
  onArmRestart,
  onTestPrint,
  onRecheck,
  onRestart,
  onUnpair,
}: {
  station: Station;
  t: StationT;
  de: boolean;
  now: number;
  actionBusy: StationActionKind | null;
  actionFeedback: Feedback | null;
  restartArmed: boolean;
  onArmRestart: (armed: boolean) => void;
  onTestPrint: () => void;
  onRecheck: () => void;
  onRestart: () => void;
  onUnpair: () => void;
}) {
  const status = stationStatus(station, now);

  return (
    <div className="pi-station-detail">
      <div className="pi-station-detail-head">
        <div>
          <h3 className="pi-station-name">{station.name}</h3>
          {station.location && <p className="pi-station-sub">{station.location}</p>}
        </div>
        <StatusPill status={status} label={t(statusKey(status))} />
      </div>

      <StationMetaGrid station={station} t={t} de={de} now={now} />

      <h4 className="pi-station-subhead">{t("hardware")}</h4>
      <StationHardware station={station} t={t} />

      {station.hardware?.simulated && <p className="pi-station-warn">{t("simulated")}</p>}
      {station.agent_error && (
        <p className="pi-station-warn pi-station-warn--bad">{station.agent_error}</p>
      )}

      <StationActionBar
        t={t}
        busy={actionBusy !== null}
        actionBusy={actionBusy}
        restartArmed={restartArmed}
        onArmRestart={onArmRestart}
        onTestPrint={onTestPrint}
        onRecheck={onRecheck}
        onRestart={onRestart}
        onUnpair={onUnpair}
      />

      {restartArmed && <p className="pi-station-warn">{t("restartConfirm")}</p>}
      <FeedbackLine feedback={actionFeedback} />
    </div>
  );
}

// ── Card ─────────────────────────────────────────────────────────────────

export function StationStatusCard({
  t,
  de,
  now,
  stations,
  listState,
  listError,
  selected,
  selectedId,
  onSelect,
  actionBusy,
  actionFeedback,
  restartArmed,
  onArmRestart,
  onTestPrint,
  onRecheck,
  onRestart,
  onUnpair,
}: StationStatusCardProps) {
  return (
    <div className="admin-page-card">
      <h2 className="admin-page-card-title">{t("stationsTitle")}</h2>

      {listState === "loading" && <p className="admin-page-muted">{t("loading")}</p>}

      {listState === "missing" && (
        <div className="pi-station-notice">
          <strong>{t("apiMissingTitle")}</strong>
          <span>{t("apiMissingBody")}</span>
        </div>
      )}

      {listState === "error" && (
        <div className="pi-station-notice pi-station-notice--bad">
          <strong>{listError}</strong>
          <span>{t("listRetrying")}</span>
        </div>
      )}

      {listState === "ready" && stations.length === 0 && (
        <p className="admin-page-muted">{t("noStations")}</p>
      )}

      {stations.length > 1 && (
        <StationSwitcher
          stations={stations}
          selectedId={selectedId}
          onSelect={onSelect}
          t={t}
          now={now}
        />
      )}

      {selected && (
        <StationDetail
          station={selected}
          t={t}
          de={de}
          now={now}
          actionBusy={actionBusy}
          actionFeedback={actionFeedback}
          restartArmed={restartArmed}
          onArmRestart={onArmRestart}
          onTestPrint={onTestPrint}
          onRecheck={onRecheck}
          onRestart={onRestart}
          onUnpair={onUnpair}
        />
      )}
    </div>
  );
}
