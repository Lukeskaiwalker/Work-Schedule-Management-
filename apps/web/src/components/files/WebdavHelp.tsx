/**
 * The ⚙ in the file toolbar: how to mount this folder in the operating
 * system over WebDAV. One or more links with a copy button each, then the
 * host's hints (the project tab names the project tree, the customer card
 * the customer tree).
 *
 * Presentation only — copying is the host's, because the notice it shows
 * afterwards names what was copied.
 */
import type { Language } from "../../types";

export type WebdavLink = {
  label: string;
  url: string;
  onCopy: () => void;
};

export function WebdavHelp({
  language,
  links,
  hints,
}: {
  language: Language;
  links: readonly WebdavLink[];
  hints: readonly string[];
}) {
  const de = language === "de";
  return (
    <div className="webdav-help">
      <button type="button" className="icon-btn" aria-label="WebDAV info">
        ⚙
      </button>
      <div className="webdav-tooltip">
        <p>
          {de
            ? "Dateien wie in SharePoint per WebDAV im Betriebssystem einbinden:"
            : "SharePoint-like OS integration via WebDAV:"}
        </p>
        {links.map((link) => (
          <div key={link.url} className="webdav-help-link">
            <small>{link.label}</small>
            <div className="webdav-copy-row">
              <code>{link.url}</code>
              <button type="button" className="webdav-copy-btn" onClick={link.onCopy}>
                {de ? "Kopieren" : "Copy"}
              </button>
            </div>
          </div>
        ))}
        {hints.map((hint) => (
          <small key={hint}>{hint}</small>
        ))}
      </div>
    </div>
  );
}

/** The mounting instructions every WebDAV tree shares; the host adds the tree-specific URL hint. */
export function webdavCommonHints(language: Language): string[] {
  const de = language === "de";
  return [
    de
      ? "Jede berechtigte Person kann denselben Link mit eigenen App-Zugangsdaten verbinden."
      : "Any authorized user can connect the same link with their own app credentials.",
    de
      ? "macOS Finder: Gehe zu > Mit Server verbinden (Cmd+K). Anmeldung mit App-E-Mail + Passwort."
      : "macOS Finder: Go > Connect to Server (Cmd+K). Sign in with app email + password.",
  ];
}

export function webdavCertificateHint(language: Language): string {
  return language === "de"
    ? "Wenn HTTPS-Zertifikat auf fremden Geräten fehlschlägt, LAN-HTTP nur im vertrauenswürdigen Netzwerk nutzen."
    : "If HTTPS certificate trust fails on other devices, use LAN HTTP only on trusted networks.";
}
