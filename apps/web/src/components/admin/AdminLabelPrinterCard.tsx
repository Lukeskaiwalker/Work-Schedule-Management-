/**
 * AdminLabelPrinterCard — Werkstatt label printer setup in the admin settings.
 *
 * Self-contained on purpose (own fetches, own state) rather than following the
 * weather/OpenAI pattern of App.tsx-owned state: App.tsx is a 9k-line file
 * under active parallel work, and this card has no reason to couple to it.
 *
 * The backend resolves the address runtime-first (this card) with env vars as
 * fallback — `source` tells the admin which one is in effect. "Testdruck"
 * prints one fixed sample label so the whole path is provable from the couch.
 */
import { useCallback, useEffect, useState, type FormEvent } from "react";

import { apiFetch } from "../../api/client";
import { useAppContext } from "../../context/AppContext";

export interface LabelPrinterSettings {
  host: string;
  port: number;
  configured: boolean;
  source: "runtime" | "env" | "none";
}

interface TestResult {
  ok: boolean;
  printer: string;
  detail: string;
}

export function AdminLabelPrinterCard() {
  const { token, language } = useAppContext();
  const de = language === "de";

  const [settings, setSettings] = useState<LabelPrinterSettings | null>(null);
  const [host, setHost] = useState("");
  const [port, setPort] = useState("9100");
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [feedback, setFeedback] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const current = await apiFetch<LabelPrinterSettings>(
        "/admin/settings/label-printer",
        token,
      );
      setSettings(current);
      setHost(current.host);
      setPort(String(current.port));
    } catch {
      // The card degrades to an empty form; saving will surface real errors.
      setSettings(null);
    }
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setFeedback(null);
    try {
      const saved = await apiFetch<LabelPrinterSettings>(
        "/admin/settings/label-printer",
        token,
        {
          method: "PATCH",
          body: JSON.stringify({
            host: host.trim(),
            port: Number.parseInt(port, 10) || 9100,
          }),
        },
      );
      setSettings(saved);
      setFeedback({
        ok: true,
        text: saved.configured
          ? de
            ? `Gespeichert — Drucker ${saved.host}:${saved.port}`
            : `Saved — printer ${saved.host}:${saved.port}`
          : de
            ? "Gespeichert — Etikettendruck deaktiviert"
            : "Saved — label printing disabled",
      });
    } catch (err: unknown) {
      setFeedback({
        ok: false,
        text: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setSaving(false);
    }
  }

  async function testPrint() {
    setTesting(true);
    setFeedback(null);
    try {
      const result = await apiFetch<TestResult>(
        "/admin/settings/label-printer/test",
        token,
        { method: "POST" },
      );
      setFeedback({ ok: result.ok, text: result.detail });
    } catch (err: unknown) {
      setFeedback({
        ok: false,
        text: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setTesting(false);
    }
  }

  const sourceLabel =
    settings?.source === "runtime"
      ? de
        ? "über Admin-Einstellungen"
        : "via admin settings"
      : settings?.source === "env"
        ? de
          ? "über Server-Umgebung"
          : "via server environment"
        : null;

  return (
    <div className="admin-page-card admin-settings-block">
      <h2 className="admin-page-card-title">
        {de ? "Etikettendrucker (Werkstatt)" : "Label printer (workshop)"}
      </h2>
      <p className="admin-tools-desc">
        {de
          ? "WAGO Smart Printer für Maschinen-Etiketten. IP-Adresse im lokalen Netz eintragen — leer lassen, um den Etikettendruck zu deaktivieren."
          : "WAGO Smart Printer for machine labels. Enter its LAN IP address — leave empty to disable label printing."}
      </p>
      <form className="admin-settings-form" onSubmit={(e) => void save(e)}>
        <label className="admin-invite-field">
          <span className="admin-invite-field-label">
            {de ? "IP-Adresse / Host" : "IP address / host"}
          </span>
          <input
            type="text"
            className="admin-invite-input"
            value={host}
            onChange={(e) => setHost(e.target.value)}
            placeholder="192.168.2.158"
            autoComplete="off"
          />
        </label>
        <label className="admin-invite-field">
          <span className="admin-invite-field-label">Port</span>
          <input
            type="number"
            className="admin-invite-input"
            value={port}
            onChange={(e) => setPort(e.target.value)}
            min={1}
            max={65535}
          />
        </label>
        {settings?.configured && sourceLabel && (
          <div className="admin-settings-status">
            <span className="admin-settings-status-dot admin-settings-status-dot--ok" />
            {de
              ? `Aktiv: ${settings.host}:${settings.port} (${sourceLabel})`
              : `Active: ${settings.host}:${settings.port} (${sourceLabel})`}
          </div>
        )}
        {feedback && (
          <div className="admin-settings-status">
            <span
              className={`admin-settings-status-dot${
                feedback.ok ? " admin-settings-status-dot--ok" : ""
              }`}
            />
            {feedback.text}
          </div>
        )}
        <div className="admin-settings-form-actions">
          <button type="submit" className="admin-invite-submit" disabled={saving}>
            {saving ? (de ? "Speichern…" : "Saving…") : de ? "Speichern" : "Save"}
          </button>
          <button
            type="button"
            className="admin-invite-submit admin-invite-submit--secondary"
            onClick={() => void testPrint()}
            disabled={testing}
          >
            {testing
              ? de
                ? "Drucke…"
                : "Printing…"
              : de
                ? "Testdruck"
                : "Test print"}
          </button>
        </div>
      </form>
    </div>
  );
}
