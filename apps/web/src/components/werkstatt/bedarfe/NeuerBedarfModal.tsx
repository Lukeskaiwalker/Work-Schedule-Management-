import { useEffect, useState } from "react";
import type { Language, MaterialCatalogItem, Project } from "../../../types";
import { KatalogArtikelSuche } from "./KatalogArtikelSuche";

/**
 * "+ Bedarf" — write a need without a construction report.
 *
 * There was no reachable way to do this at all: the only caller of the create
 * endpoint was the retired MaterialsPage, so an office worker who noticed
 * something missing had to wait for a fitter to file a report. The catalogue
 * pick is offered first because a need WITH a catalogue article is the one
 * that can later be ordered in one click; free text stays possible, and says
 * plainly what it costs.
 */
export interface NeuerBedarfSubmit {
  project_id: number;
  item: string | null;
  material_catalog_item_id: number | null;
  quantity: string | null;
  unit: string | null;
  article_no: string | null;
  /** Why it is needed. Known now — asking for it in a second step on the row
      afterwards is how it ends up never being written down. */
  notes: string | null;
}

export interface NeuerBedarfModalProps {
  open: boolean;
  language: Language;
  token: string | null;
  projects: readonly Project[];
  /** Pre-selected project, e.g. the group the user was looking at. */
  defaultProjectId?: number | null;
  /** Pre-picked catalogue row — the Katalog page opens the modal this way. */
  seedCatalogItem?: MaterialCatalogItem | null;
  busy: boolean;
  error: string | null;
  onSubmit: (input: NeuerBedarfSubmit) => void;
  onClose: () => void;
}

export function NeuerBedarfModal({
  open,
  language,
  token,
  projects,
  defaultProjectId = null,
  seedCatalogItem = null,
  busy,
  error,
  onSubmit,
  onClose,
}: NeuerBedarfModalProps) {
  const de = language === "de";
  const [projectId, setProjectId] = useState<number | null>(defaultProjectId);
  const [catalogItem, setCatalogItem] = useState<MaterialCatalogItem | null>(seedCatalogItem);
  const [item, setItem] = useState("");
  const [quantity, setQuantity] = useState("");
  const [unit, setUnit] = useState("");
  const [notes, setNotes] = useState("");

  // Reopening with a different seed must not show the previous one.
  useEffect(() => {
    if (!open) return;
    setProjectId(defaultProjectId);
    setCatalogItem(seedCatalogItem);
    setItem("");
    setQuantity("");
    setUnit(seedCatalogItem?.unit ?? "");
    setNotes("");
  }, [open, defaultProjectId, seedCatalogItem]);

  if (!open) return null;

  const hasName = catalogItem != null || item.trim().length > 0;
  const canSubmit = projectId != null && hasName && !busy;

  return (
    <div className="werkstatt-modal-backdrop" role="presentation" onClick={onClose}>
      <div
        className="werkstatt-modal werkstatt-modal--narrow"
        role="dialog"
        aria-modal="true"
        aria-label={de ? "Neuer Bedarf" : "New material need"}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="werkstatt-modal-head">
          <div>
            <span className="werkstatt-sub-breadcrumb">
              {de ? "PROJEKT-BEDARFE › NEU" : "PROJECT NEEDS › NEW"}
            </span>
            <h2 className="werkstatt-modal-title">{de ? "Neuer Bedarf" : "New need"}</h2>
          </div>
          <button
            type="button"
            className="werkstatt-modal-close"
            onClick={onClose}
            aria-label={de ? "Schließen" : "Close"}
          >
            ✕
          </button>
        </header>

        <div className="werkstatt-modal-body bedarfe-neu-body">
          <label className="bedarfe-field">
            <span className="bedarfe-field-label">{de ? "Projekt" : "Project"}</span>
            <select
              className="bedarfe-input"
              value={projectId == null ? "" : String(projectId)}
              onChange={(event) =>
                setProjectId(event.target.value ? Number(event.target.value) : null)
              }
            >
              <option value="">{de ? "— bitte wählen —" : "— choose —"}</option>
              {projects.map((project) => (
                <option key={`neu-bedarf-project-${project.id}`} value={project.id}>
                  {project.project_number} · {project.name}
                </option>
              ))}
            </select>
          </label>

          {catalogItem ? (
            <div className="bedarfe-picked">
              <span className="bedarfe-picked-name">{catalogItem.item_name}</span>
              <span className="muted">
                {[catalogItem.article_no ? `Art.-Nr. ${catalogItem.article_no}` : null, catalogItem.manufacturer]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
              <button
                type="button"
                className="bedarfe-link-btn"
                onClick={() => setCatalogItem(null)}
              >
                {de ? "Anderen Artikel wählen" : "Pick another article"}
              </button>
            </div>
          ) : (
            <>
              <KatalogArtikelSuche
                token={token}
                language={language}
                onPick={(picked) => {
                  setCatalogItem(picked);
                  if (!unit.trim()) setUnit(picked.unit ?? "");
                }}
                autoFocus
              />
              <label className="bedarfe-field">
                <span className="bedarfe-field-label">
                  {de ? "…oder freier Text" : "…or free text"}
                </span>
                <input
                  type="text"
                  className="bedarfe-input"
                  value={item}
                  placeholder={de ? "z. B. Kabelbinder schwarz" : "e.g. black cable ties"}
                  onChange={(event) => setItem(event.target.value)}
                />
              </label>
              {item.trim().length > 0 && (
                <p className="bedarfe-hint">
                  {de
                    ? "Ohne Katalog-Artikel kann daraus später keine Bestellposition werden."
                    : "Without a catalogue article this cannot become an order line later."}
                </p>
              )}
            </>
          )}

          <div className="bedarfe-field-row">
            <label className="bedarfe-field">
              <span className="bedarfe-field-label">{de ? "Menge" : "Quantity"}</span>
              <input
                type="text"
                className="bedarfe-input"
                value={quantity}
                placeholder={de ? "z. B. 25" : "e.g. 25"}
                onChange={(event) => setQuantity(event.target.value)}
              />
            </label>
            <label className="bedarfe-field">
              <span className="bedarfe-field-label">{de ? "Einheit" : "Unit"}</span>
              <input
                type="text"
                className="bedarfe-input"
                value={unit}
                placeholder={de ? "z. B. m" : "e.g. m"}
                onChange={(event) => setUnit(event.target.value)}
              />
            </label>
          </div>

          <label className="bedarfe-field">
            <span className="bedarfe-field-label">{de ? "Notiz (optional)" : "Note (optional)"}</span>
            <textarea
              className="bedarfe-input bedarfe-textarea"
              rows={2}
              value={notes}
              placeholder={
                de ? "z. B. Rest vom Freitag reicht nicht" : "e.g. Friday's leftovers are not enough"
              }
              onChange={(event) => setNotes(event.target.value)}
            />
          </label>
        </div>

        {error && <p className="werkstatt-modal-error">{error}</p>}

        <footer className="werkstatt-modal-foot">
          <button type="button" className="werkstatt-action-btn" onClick={onClose}>
            {de ? "Abbrechen" : "Cancel"}
          </button>
          <button
            type="button"
            className="werkstatt-action-btn werkstatt-action-btn--primary"
            disabled={!canSubmit}
            onClick={() => {
              if (projectId == null) return;
              onSubmit({
                project_id: projectId,
                item: item.trim() || null,
                material_catalog_item_id: catalogItem?.id ?? null,
                quantity: quantity.trim() || null,
                unit: unit.trim() || null,
                article_no: catalogItem?.article_no ?? null,
                notes: notes.trim() || null,
              });
            }}
          >
            {busy ? (de ? "Wird gespeichert…" : "Saving…") : de ? "Bedarf anlegen" : "Add need"}
          </button>
        </footer>
      </div>
    </div>
  );
}
