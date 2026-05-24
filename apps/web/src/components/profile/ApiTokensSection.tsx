import { useCallback, useEffect, useState } from "react";
import { apiFetch, ApiError } from "../../api/client";
import { useAppContext } from "../../context/AppContext";
import type { ApiToken, ApiTokenCreated } from "../../types";

/**
 * v2.5.23 — Personal Access Token management panel.
 *
 * Rendered inside the user's profile page when, and only when,
 * ``user.api_access_enabled`` is true. The component is responsible
 * for the full lifecycle of a user's PATs:
 *
 *   • list — what tokens does this user already have?
 *   • mint — create a new token (and show the plaintext exactly once)
 *   • revoke — invalidate an existing token (kept in the list as
 *              "revoked" for audit clarity)
 *
 * Security UX notes:
 *
 *   - The just-minted token is rendered in a separate panel with a
 *     copy button and a clear "you will not see this again" warning.
 *   - The token field in the panel uses ``readOnly`` + monospace so
 *     accidental edits are visually obvious. There is no "show
 *     again" affordance — by design.
 *   - Revoked rows are dimmed but kept visible, so the user can
 *     answer "did I really revoke that one?" without cross-checking
 *     the audit log.
 */
export function ApiTokensSection() {
  const { language, token: sessionToken, user } = useAppContext();
  const de = language === "de";

  const [tokens, setTokens] = useState<ApiToken[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [newExpiryDays, setNewExpiryDays] = useState<string>("90");
  const [minting, setMinting] = useState(false);
  const [mintError, setMintError] = useState<string | null>(null);
  const [justMinted, setJustMinted] = useState<ApiTokenCreated | null>(null);
  const [copied, setCopied] = useState(false);

  const refresh = useCallback(async () => {
    if (!sessionToken) return;
    setLoading(true);
    setLoadError(null);
    try {
      const rows = await apiFetch<ApiToken[]>("/auth/api-tokens", sessionToken);
      setTokens(rows);
    } catch (err) {
      const message = err instanceof ApiError ? err.message : String(err);
      setLoadError(message);
    } finally {
      setLoading(false);
    }
  }, [sessionToken]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function handleMint(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!sessionToken) return;
    const name = newName.trim();
    if (!name) {
      setMintError(de ? "Bitte einen Namen angeben" : "Please give the token a name");
      return;
    }
    const parsedExpiry = newExpiryDays.trim() === "" ? null : Number(newExpiryDays);
    if (parsedExpiry !== null && (!Number.isFinite(parsedExpiry) || parsedExpiry < 1)) {
      setMintError(de ? "Ungültige Ablaufzeit" : "Invalid expiry");
      return;
    }
    setMinting(true);
    setMintError(null);
    try {
      const created = await apiFetch<ApiTokenCreated>("/auth/api-tokens", sessionToken, {
        method: "POST",
        body: JSON.stringify({
          name,
          expires_in_days: parsedExpiry,
        }),
      });
      setJustMinted(created);
      setNewName("");
      setCopied(false);
      await refresh();
    } catch (err) {
      const message = err instanceof ApiError ? err.message : String(err);
      setMintError(message);
    } finally {
      setMinting(false);
    }
  }

  async function handleRevoke(tokenId: number) {
    if (!sessionToken) return;
    const confirmed = window.confirm(
      de
        ? "Token wirklich widerrufen? Anfragen mit diesem Token werden sofort abgelehnt."
        : "Really revoke this token? Requests using it will be rejected immediately.",
    );
    if (!confirmed) return;
    try {
      await apiFetch(`/auth/api-tokens/${tokenId}`, sessionToken, { method: "DELETE" });
      await refresh();
    } catch (err) {
      const message = err instanceof ApiError ? err.message : String(err);
      setLoadError(message);
    }
  }

  async function handleCopy() {
    if (!justMinted) return;
    try {
      await navigator.clipboard.writeText(justMinted.token);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API can fail on insecure origins or restricted permissions.
      // Fall back to selecting the text so the user can ⌘+C manually.
      const input = document.getElementById("smpl-pat-just-minted") as HTMLInputElement | null;
      input?.select();
    }
  }

  function statusBadge(row: ApiToken): { label: string; cls: string } {
    if (row.revoked_at) return { label: de ? "Widerrufen" : "Revoked", cls: "api-tokens-badge--revoked" };
    if (row.expires_at && new Date(row.expires_at) <= new Date()) {
      return { label: de ? "Abgelaufen" : "Expired", cls: "api-tokens-badge--expired" };
    }
    return { label: de ? "Aktiv" : "Active", cls: "api-tokens-badge--active" };
  }

  // Hide the whole panel until the admin gate is enabled. We render
  // nothing rather than a disabled state — the user can't do anything
  // useful here without their admin's involvement.
  if (!user?.api_access_enabled) return null;

  return (
    <div className="profile-page-card profile-page-card--api-tokens">
      <header className="profile-page-card-head">
        <h2 className="profile-page-card-title">{de ? "API-Tokens" : "API tokens"}</h2>
      </header>

      <p className="api-tokens-intro">
        {de
          ? "Erstelle einen Personal Access Token (PAT), um über die SMPL-API mit deinem Konto zu arbeiten. Tokens werden im Header gesendet: "
          : "Mint a Personal Access Token (PAT) to call the SMPL API with your account. Send it in the header: "}
        <code>Authorization: Bearer smpl_pat_…</code>
        {" "}
        {de ? (
          <>
            Die vollständige API-Referenz ist unter{" "}
            <a href="/api/docs" target="_blank" rel="noreferrer">/api/docs</a>
            {" "}verfügbar.
          </>
        ) : (
          <>
            The full API reference is available at{" "}
            <a href="/api/docs" target="_blank" rel="noreferrer">/api/docs</a>.
          </>
        )}
      </p>

      {/* ── Just-minted panel ───────────────────────────────────────── */}
      {justMinted && (
        <div className="api-tokens-just-minted" role="alert">
          <strong className="api-tokens-just-minted-title">
            {de ? "Token erstellt" : "Token created"}
          </strong>
          <p className="api-tokens-just-minted-warning">
            {de
              ? "Kopiere den Token jetzt. Er wird nie wieder angezeigt — bei Verlust musst du ihn widerrufen und neu erstellen."
              : "Copy the token now. It will never be shown again — if lost, revoke it and mint a new one."}
          </p>
          <div className="api-tokens-just-minted-row">
            <input
              id="smpl-pat-just-minted"
              type="text"
              readOnly
              value={justMinted.token}
              className="api-tokens-just-minted-input"
              onFocus={(e) => e.currentTarget.select()}
            />
            <button type="button" className="api-tokens-copy-btn" onClick={handleCopy}>
              {copied ? (de ? "Kopiert" : "Copied") : de ? "Kopieren" : "Copy"}
            </button>
          </div>
          <button
            type="button"
            className="api-tokens-just-minted-dismiss"
            onClick={() => setJustMinted(null)}
          >
            {de ? "Habe ich gespeichert" : "I've saved it"}
          </button>
        </div>
      )}

      {/* ── Mint form ───────────────────────────────────────────────── */}
      <form className="api-tokens-mint-form" onSubmit={handleMint}>
        <label className="profile-page-field">
          <span className="profile-page-field-label">{de ? "Token-Name" : "Token name"}</span>
          <input
            className="profile-page-input"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder={de ? "z. B. Planungs-Agent" : "e.g. Planning agent"}
            maxLength={128}
            required
          />
        </label>
        <label className="profile-page-field">
          <span className="profile-page-field-label">
            {de ? "Ablauf in Tagen (leer = nie)" : "Expires in days (empty = never)"}
          </span>
          <input
            className="profile-page-input"
            type="number"
            min={1}
            max={3650}
            value={newExpiryDays}
            onChange={(e) => setNewExpiryDays(e.target.value)}
          />
        </label>
        {mintError && <p className="api-tokens-error">{mintError}</p>}
        <div className="profile-page-form-actions">
          <button type="submit" className="profile-page-save-btn" disabled={minting}>
            {minting
              ? de ? "Wird erstellt…" : "Creating…"
              : de ? "Token erstellen" : "Create token"}
          </button>
        </div>
      </form>

      {/* ── Existing tokens list ────────────────────────────────────── */}
      <div className="api-tokens-list">
        <h3 className="api-tokens-list-title">{de ? "Deine Tokens" : "Your tokens"}</h3>
        {loadError && <p className="api-tokens-error">{loadError}</p>}
        {loading ? (
          <p className="api-tokens-empty">{de ? "Lade…" : "Loading…"}</p>
        ) : tokens.length === 0 ? (
          <p className="api-tokens-empty">
            {de ? "Noch keine Tokens." : "No tokens yet."}
          </p>
        ) : (
          <ul className="api-tokens-rows">
            {tokens.map((row) => {
              const badge = statusBadge(row);
              const isInactive = Boolean(row.revoked_at) ||
                (row.expires_at !== null && row.expires_at !== undefined && new Date(row.expires_at) <= new Date());
              return (
                <li
                  key={row.id}
                  className={`api-tokens-row${isInactive ? " api-tokens-row--inactive" : ""}`}
                >
                  <div className="api-tokens-row-main">
                    <strong className="api-tokens-row-name">{row.name}</strong>
                    <code className="api-tokens-row-prefix">{row.prefix}…</code>
                    <span className={`api-tokens-badge ${badge.cls}`}>{badge.label}</span>
                  </div>
                  <div className="api-tokens-row-meta">
                    <span>
                      {de ? "Erstellt" : "Created"}: {new Date(row.created_at).toLocaleString()}
                    </span>
                    {row.last_used_at && (
                      <span>
                        {de ? "Zuletzt verwendet" : "Last used"}:{" "}
                        {new Date(row.last_used_at).toLocaleString()}
                      </span>
                    )}
                    {row.expires_at && (
                      <span>
                        {de ? "Läuft ab" : "Expires"}:{" "}
                        {new Date(row.expires_at).toLocaleString()}
                      </span>
                    )}
                    {row.revoked_at && (
                      <span>
                        {de ? "Widerrufen" : "Revoked"}:{" "}
                        {new Date(row.revoked_at).toLocaleString()}
                      </span>
                    )}
                  </div>
                  {!row.revoked_at && (
                    <button
                      type="button"
                      className="api-tokens-revoke-btn"
                      onClick={() => void handleRevoke(row.id)}
                    >
                      {de ? "Widerrufen" : "Revoke"}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
