/**
 * stationText — the words and the locale-dependent formatters for the scan
 * station panels.
 *
 * This lives beside the panels rather than in `utils/stationApi.ts`: that file
 * is transport (fetch, error shapes, endpoint paths) and has no business
 * knowing what a German admin reads. Everything here renders *strings for a
 * human*, which is why `formatUptime` and friends are here too — "3 T 4 Std"
 * against "3d 4h" is copy, not arithmetic.
 */
import type { StationStatus } from "../../utils/stationApi";
import { parseServerDateTime } from "../../utils/dates";

// ── Copy ─────────────────────────────────────────────────────────────────

export const TEXT = {
  // Matches the sidebar label from constants/index.ts — a page whose heading
  // disagrees with the item that opened it reads as the wrong page.
  title: { de: "Scan-Station", en: "Scan Station" },
  intro: {
    de: "Raspberry Pi im Büro: Barcode-Scanner, Etikettendrucker und Geräte-Import (Benning/Metrel). Hier wird der Pi mit SMPL gekoppelt und überwacht.",
    en: "Raspberry Pi in the office: barcode scanner, label printer and device import (Benning/Metrel). Pair and monitor the Pi from here.",
  },
  reload: { de: "Aktualisieren", en: "Refresh" },
  reloading: { de: "Lädt…", en: "Loading…" },
  updatedAt: { de: "Stand", en: "Updated" },
  loading: { de: "Stationen werden geladen…", en: "Loading stations…" },
  stationsTitle: { de: "Stationen", en: "Stations" },
  noStations: {
    // The Pi starts the pairing and shows its own code; nothing is created
    // here. Copy that told the admin to generate a code described the flow
    // this page had before the device grant, and asked for something the
    // screen no longer offers.
    de: "Noch keine Station gekoppelt. Kopplung am Pi starten — die Anfrage erscheint dann hier zur Freigabe.",
    en: "No station paired yet. Start pairing on the Pi; the request then appears here for approval.",
  },
  statusOnline: { de: "Online", en: "Online" },
  statusStale: { de: "Verzögert", en: "Delayed" },
  statusOffline: { de: "Offline", en: "Offline" },
  statusUnknown: { de: "Unbekannt", en: "Unknown" },
  version: { de: "Agent-Version", en: "Agent version" },
  uptime: { de: "Laufzeit", en: "Uptime" },
  lastSeen: { de: "Zuletzt gesehen", en: "Last seen" },
  address: { de: "Adresse", en: "Address" },
  pairedAt: { de: "Gekoppelt", en: "Paired" },
  hardware: { de: "Hardware", en: "Hardware" },
  printer: { de: "Etikettendrucker", en: "Label printer" },
  scanner: { de: "Barcode-Scanner", en: "Barcode scanner" },
  printerOk: { de: "verbunden", en: "connected" },
  printerMissing: { de: "nicht verbunden", en: "not connected" },
  scannerOk: { de: "erkannt", en: "detected" },
  scannerMissing: { de: "nicht erkannt", en: "not detected" },
  simulated: {
    de: "Simulationsmodus — Druckaufträge werden gerendert, aber nicht gedruckt.",
    en: "Simulation mode — print jobs are rendered but never printed.",
  },
  tape: { de: "Band", en: "Tape" },
  testPrint: { de: "Testetikett drucken", en: "Print test label" },
  testPrinting: { de: "Druckt…", en: "Printing…" },
  recheck: { de: "Hardware prüfen", en: "Re-check hardware" },
  rechecking: { de: "Prüft…", en: "Checking…" },
  restart: { de: "Agent neu starten", en: "Restart agent" },
  restarting: { de: "Startet neu…", en: "Restarting…" },
  restartConfirm: {
    de: "Wirklich neu starten? Laufende Zählungen bleiben gespeichert, ein Druckauftrag bricht ab.",
    en: "Really restart? Recorded counts survive, a running print job is aborted.",
  },
  restartYes: { de: "Ja, neu starten", en: "Yes, restart" },
  cancel: { de: "Abbrechen", en: "Cancel" },
  unpair: { de: "Entkoppeln", en: "Unpair" },
  unpairConfirm: {
    de: "Station entkoppeln? Der Pi verliert den Zugang und muss neu gekoppelt werden.",
    en: "Unpair the station? The Pi loses access and has to be paired again.",
  },
  sessionsTitle: { de: "Aufgezeichnete Sitzungen", en: "Recorded sessions" },
  sessionsIntro: {
    de: "Zählungen, die lokal auf dem Pi liegen. Übernehmen schreibt sie in eine Werkstatt-Inventur.",
    en: "Counts held locally on the Pi. Importing writes them into a workshop inventory.",
  },
  sessionsEmpty: { de: "Die Station hat noch nichts aufgezeichnet.", en: "The station has not recorded anything yet." },
  colSession: { de: "Sitzung", en: "Session" },
  colArticles: { de: "Artikel", en: "Articles" },
  colQty: { de: "Menge", en: "Qty" },
  colScans: { de: "Scans", en: "Scans" },
  colLast: { de: "Letzter Scan", en: "Last scan" },
  importAction: { de: "Übernehmen", en: "Import" },
  importing: { de: "Übernimmt…", en: "Importing…" },
  imported: { de: "Übernommen", en: "Imported" },
  importAgain: { de: "Erneut übernehmen", en: "Import again" },
  pairingTitle: { de: "Neue Station koppeln", en: "Pair a new station" },
  pairingIntro: {
    de: "Der Code ist wenige Minuten gültig und wird einmalig verwendet. Am Pi eintippen — kein Passwort nötig.",
    en: "The code is valid for a few minutes and can be used once. Type it on the Pi — no password needed.",
  },
  pairingName: { de: "Name der Station (optional)", en: "Station name (optional)" },
  pairingValidFor: { de: "Gültig noch", en: "Valid for" },
  pairingNone: {
    de: "Keine offenen Anfragen. Starte den Agent auf dem Pi — er zeigt dort einen Code an, der hier erscheint.",
    en: "No pending requests. Start the agent on the Pi — it shows a code there which appears here.",
  },
  pairingNamePlaceholder: { de: "z. B. Büro-Station", en: "e.g. office station" },
  pairingApprove: { de: "Freigeben", en: "Approve" },
  pairingDeny: { de: "Ablehnen", en: "Deny" },
  setupTitle: { de: "Neuen Pi einrichten", en: "Set up a fresh Pi" },
  setupIntro: {
    de: "Einmalig auf einem frischen Raspberry Pi OS ausführen. Der Pi zeigt danach einen Code, der hier freigegeben wird.",
    en: "Run once on a fresh Raspberry Pi OS. The Pi then shows a code, which is approved here.",
  },
  copy: { de: "Kopieren", en: "Copy" },
  copied: { de: "Kopiert", en: "Copied" },
  copyFailed: {
    de: "Kopieren nicht möglich — bitte manuell markieren.",
    en: "Copy failed — please select manually.",
  },
  apiMissingTitle: { de: "Schnittstelle noch nicht verfügbar", en: "API not available yet" },
  apiMissingBody: {
    de: "Dieser Server kennt die Stations-Endpunkte noch nicht. Die Einrichtungsanleitung unten funktioniert trotzdem.",
    en: "This server does not expose the station endpoints yet. The setup instructions below still apply.",
  },
  listRetrying: {
    de: "Die Anzeige aktualisiert sich weiter im Hintergrund.",
    en: "The page keeps retrying in the background.",
  },
  sessionsFailed: {
    de: "Die Sitzungen konnten nicht geladen werden.",
    en: "Sessions could not be loaded.",
  },
} as const;

export type StationTextKey = keyof typeof TEXT;

/** The lookup the panels receive as a prop, so language resolves in one place. */
export type StationT = (key: StationTextKey) => string;

export function createStationT(de: boolean): StationT {
  return (key) => (de ? TEXT[key].de : TEXT[key].en);
}

export function statusKey(status: StationStatus): StationTextKey {
  switch (status) {
    case "online":
      return "statusOnline";
    case "stale":
      return "statusStale";
    case "offline":
      return "statusOffline";
    default:
      return "statusUnknown";
  }
}

// ── Formatting ───────────────────────────────────────────────────────────

export function formatUptime(seconds: number | null, de: boolean): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return "—";
  const total = Math.floor(seconds);
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  if (days > 0) return de ? `${days} T ${hours} Std` : `${days}d ${hours}h`;
  if (hours > 0) return de ? `${hours} Std ${minutes} Min` : `${hours}h ${minutes}m`;
  if (minutes > 0) return de ? `${minutes} Min` : `${minutes}m`;
  return de ? `${total} s` : `${total}s`;
}

/**
 * "vor 12 s" up to a day, an absolute timestamp beyond it.
 *
 * An ops page lives on the recent past: for anything inside the last hour the
 * age is the whole message, and for anything older the exact moment matters
 * more than the arithmetic.
 */
export function formatAge(iso: string | null, de: boolean, now: number): string {
  const parsed = parseServerDateTime(iso);
  if (!parsed) return "—";
  const seconds = Math.max(0, Math.round((now - parsed.getTime()) / 1000));
  if (seconds < 60) return de ? `vor ${seconds} s` : `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return de ? `vor ${minutes} Min` : `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return de ? `vor ${hours} Std` : `${hours}h ago`;
  return parsed.toLocaleString(de ? "de-DE" : "en-US", {
    dateStyle: "short",
    timeStyle: "short",
  });
}

export function formatStamp(iso: string | null, de: boolean): string {
  const parsed = parseServerDateTime(iso);
  if (!parsed) return "—";
  return parsed.toLocaleString(de ? "de-DE" : "en-US", {
    dateStyle: "short",
    timeStyle: "short",
  });
}

export function formatCountdown(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(safe / 60);
  return `${minutes}:${String(safe % 60).padStart(2, "0")}`;
}
