/**
 * The materials a task carries from its Baustellenkiste, read-only.
 *
 * The server imports the box contents onto the task; the crew reads the list
 * here (edit modal for managers, the "Meine Aufgaben" card for everyone) and
 * takes the Packliste PDF to the van. What came back is reported through the
 * Baustellenbericht, which is why `quantity_used` and `settled_at` are shown
 * but never edited on this surface.
 *
 * One implementation for both surfaces; `collapsible` is the only difference.
 */
import { useState } from "react";
import { taskPackingListPath } from "../../api/client";
import { openServerFile } from "../../native/fileOpen";
import type { Language, TaskMaterial } from "../../types";

type TaskMaterialListProps = {
  taskId: number;
  /** Optional because cached task objects may predate the field. */
  materials: TaskMaterial[] | undefined;
  language: Language;
  /** Card surfaces get a fold toggle "Material (N)"; the modal shows the table outright. */
  collapsible?: boolean;
};

export function packingListFileName(taskId: number): string {
  return `Packliste-Aufgabe-${taskId}.pdf`;
}

function formatQuantity(value: number, unit: string | null): string {
  return unit ? `${value} ${unit}` : String(value);
}

function StatusCell({ material, de }: { material: TaskMaterial; de: boolean }) {
  const reported = material.quantity_used != null;
  const settled = Boolean(material.settled_at);
  if (!reported && !settled) return <span className="muted">–</span>;
  return (
    <span className="task-material-status">
      {reported && (
        <span>
          {de ? "gemeldet" : "reported"}: {formatQuantity(material.quantity_used as number, material.unit)}
        </span>
      )}
      {settled && <span className="task-material-badge">{de ? "verbucht" : "booked"}</span>}
    </span>
  );
}

export function TaskMaterialList({
  taskId,
  materials,
  language,
  collapsible = false,
}: TaskMaterialListProps) {
  // Open at first on every surface: the crew reads this list in the row of
  // Meine Aufgaben, and what came out of the box must not hide behind a tap.
  // `collapsible` only decides whether it can be put away.
  const [open, setOpen] = useState(true);
  const rows = materials ?? [];
  const de = language === "de";
  if (rows.length === 0) return null;

  const openPackingList = () => {
    openServerFile(taskPackingListPath(taskId), packingListFileName(taskId));
  };

  return (
    <div className="task-material-list">
      <div className="task-material-list-head">
        {collapsible ? (
          <button
            type="button"
            className="task-material-list-toggle"
            aria-expanded={open}
            onClick={() => setOpen((current) => !current)}
          >
            {de ? "Material" : "Materials"} ({rows.length})
            <span aria-hidden="true">{open ? "▾" : "▸"}</span>
          </button>
        ) : (
          <span className="task-material-list-title">
            {de ? "Material aus der Kiste" : "Material from the box"} ({rows.length})
          </span>
        )}
        <button type="button" className="task-material-list-pdf" onClick={openPackingList}>
          {de ? "Packliste (PDF)" : "Packing list (PDF)"}
        </button>
      </div>
      {open && (
        <div className="task-material-list-scroll">
          <table className="task-material-table">
            <thead>
              <tr>
                <th>{de ? "Menge" : "Qty"}</th>
                <th>{de ? "Artikel" : "Item"}</th>
                <th>{de ? "Art.-Nr." : "Art. no."}</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((material) => (
                <tr key={material.id}>
                  <td className="task-material-qty">
                    {formatQuantity(material.quantity, material.unit)}
                  </td>
                  <td>{material.item_name}</td>
                  <td className="task-material-article">{material.article_no ?? "–"}</td>
                  <td>
                    <StatusCell material={material} de={de} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
