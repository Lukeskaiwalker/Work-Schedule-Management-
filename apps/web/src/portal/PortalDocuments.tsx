// Plans and documents the office shares: the project's "Partnerportal"
// folder, grouped by its subfolders. Read-only on purpose — partners add their
// own photos on the task; what lands here is the office's choice.

import { ChevronRightIcon, DocumentIcon, FolderIcon, ImageIcon } from "./PortalIcons";
import { portalDocumentUrl } from "./portalApi";
import { formatDayDate } from "./portalDates";
import { documentKind, groupDocuments } from "./portalHoursDocs";
import type { PortalDocument } from "./portalTypes";

const KIND_LABEL = { pdf: "PDF", image: "Foto", file: "Datei" } as const;

function DocumentRow({ document }: { document: PortalDocument }) {
  const kind = documentKind(document.content_type);
  return (
    <li>
      <a
        className="pp-doc-row"
        href={portalDocumentUrl(document.id)}
        target="_blank"
        rel="noopener"
        aria-label={`${document.file_name} öffnen`}
      >
        <span className={`pp-doc-icon pp-doc-icon--${kind}`}>
          {kind === "image" ? <ImageIcon size={20} /> : <DocumentIcon size={20} />}
        </span>
        <span className="pp-doc-text">
          <span className="pp-doc-name">{document.file_name}</span>
          <span className="pp-doc-meta">
            {KIND_LABEL[kind]} · {formatDayDate(document.created_at)}
          </span>
        </span>
        <span className="pp-chevron"><ChevronRightIcon size={18} /></span>
      </a>
    </li>
  );
}

export function DocumentsSection({ documents, hint }: { documents: PortalDocument[]; hint?: string }) {
  if (documents.length === 0) return null;
  const groups = groupDocuments(documents);
  return (
    <section className="pp-card pp-card--padded" aria-label="Pläne und Unterlagen">
      <div className="pp-section-head">
        <span className="pp-kicker">Pläne &amp; Unterlagen</span>
        <span className="pp-section-meta">{documents.length === 1 ? "1 Datei" : `${documents.length} Dateien`}</span>
      </div>
      {hint && <p className="pp-info-detail">{hint}</p>}
      {groups.map((group) => (
        <div key={group.folder || "/"} className="pp-doc-group">
          {group.folder && (
            <span className="pp-doc-folder">
              <FolderIcon size={16} />
              {group.folder}
            </span>
          )}
          <ul className="pp-doc-list">
            {group.documents.map((document) => (
              <DocumentRow key={document.id} document={document} />
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}
