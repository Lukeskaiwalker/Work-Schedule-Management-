/**
 * One row of the Bestand table, with everything that row can do.
 *
 * Lifted out of WerkstattInventarPage because the page had grown past a
 * thousand lines and this is the part of it that is purely presentational:
 * it holds no state, owns no request, and reports each action upward by name.
 * The page keeps the decisions (which dialog opens, what is refetched) and
 * loses two hundred lines of JSX that nothing else in it interacts with.
 *
 * The row is `label-shaped`: every figure it prints was formatted by the page,
 * so the same article cannot be quoted here in one unit and in the dialog it
 * opens in another.
 */
import type { MockInventoryRow } from "./mockData";
import { KebabMenu } from "./KebabMenu";

export interface StockTableRowProps {
  row: MockInventoryRow;
  de: boolean;
  /** The article whose label is being printed right now, if any. */
  printingId: number | null;
  /** Every menu entry needs `werkstatt:manage`; without it there is no menu. */
  canManage: boolean;
  onCheckout: (articleId: number) => void;
  onAdjustStock: (articleId: number) => void;
  onEdit: (articleId: number) => void;
  onArchive: (articleId: number) => void;
  onPrintLabel: (row: MockInventoryRow) => void;
}

export function StockTableRow({
  row,
  de,
  printingId,
  canManage,
  onCheckout,
  onAdjustStock,
  onEdit,
  onArchive,
  onPrintLabel,
}: StockTableRowProps) {
  return (
    <li
      className={`werkstatt-row werkstatt-row--clickable${
        row.is_archived ? " werkstatt-row--archived" : ""
      }`}
      role="row"
      onClick={(event) => {
        // Row click opens Entnehmen, BUT don't hijack clicks on the
        // checkbox / overflow button / other interactive children.
        const target = event.target as HTMLElement;
        if (target.closest("input, button")) return;
        onCheckout(row.article_id);
      }}
    >
      <span className="werkstatt-col werkstatt-col-checkbox">
        <input type="checkbox" aria-label={row.item_name} />
      </span>
      <span className="werkstatt-col werkstatt-col-item">
        <span className="werkstatt-row-thumb" aria-hidden="true">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
            <path
              d="M12 3 3 7.5v9L12 21l9-4.5v-9L12 3Z"
              stroke="#5C7895"
              strokeWidth="1.6"
              strokeLinejoin="round"
            />
            <path d="M3 7.5 12 12l9-4.5M12 12v9" stroke="#5C7895" strokeWidth="1.6" />
          </svg>
        </span>
        <span className="werkstatt-row-main">
          <b className="werkstatt-row-name">
            {row.item_name}
            {row.is_archived && (
              <span className="stock-archived-tag">{de ? "archiviert" : "archived"}</span>
            )}
          </b>
          <small className="werkstatt-row-meta">
            {row.article_no} · {row.sub_meta}
          </small>
        </span>
      </span>
      <span className="werkstatt-col werkstatt-col-category">{row.category}</span>
      <span className="werkstatt-col werkstatt-col-location">{row.location}</span>
      <span className="werkstatt-col werkstatt-col-stock">
        <span className={`werkstatt-stock-pill werkstatt-stock-pill--${row.stock_tone}`}>
          <span className="werkstatt-stock-pill-dot" aria-hidden="true" />
          {row.stock_label}
        </span>
      </span>
      <span className="werkstatt-col werkstatt-col-out">
        {row.out_initials ? (
          <span className="werkstatt-initials" aria-hidden="true">
            {row.out_initials}
          </span>
        ) : (
          <span className="werkstatt-initials werkstatt-initials--empty" aria-hidden="true" />
        )}
        <span className="werkstatt-row-out-label">{row.out_label}</span>
      </span>
      <span className="werkstatt-col werkstatt-col-actions">
        {/* Unscannable stock is the actionable case, so that button is the
            prominent one; for everything else this is a reprint. */}
        <button
          type="button"
          className={`werkstatt-row-label-btn${row.scannable ? "" : " is-missing"}`}
          disabled={printingId !== null}
          aria-label={
            row.scannable
              ? de
                ? "Etikett erneut drucken"
                : "Reprint label"
              : de
                ? "Etikett drucken – Artikel ist nicht scannbar"
                : "Print label – article is not scannable"
          }
          title={
            row.scannable
              ? de
                ? "Etikett erneut drucken"
                : "Reprint label"
              : de
                ? "Kein Barcode – Etikett drucken"
                : "No barcode – print a label"
          }
          onClick={() => onPrintLabel(row)}
        >
          {printingId === row.article_id ? "…" : "⎙"}
        </button>
        {/* Hidden without `werkstatt:manage`: every entry behind it requires
            that permission, and a menu that can only end in a 403 is worse
            than no menu — it costs a filled-in dialog to find out. "Etikett
            drucken" is listed here as well as beside it: the button is the
            affordance for unscannable stock, the menu is the complete list of
            what a row can do, and leaving it out of one of the two makes
            people hunt. */}
        {canManage && (
          <KebabMenu
            ariaLabel={de ? "Artikel-Aktionen" : "Item actions"}
            items={[
              {
                key: "checkout",
                label: de ? "Entnehmen" : "Check out",
                onSelect: () => onCheckout(row.article_id),
              },
              {
                key: "stock",
                label: de ? "Bestand anpassen" : "Adjust stock",
                onSelect: () => onAdjustStock(row.article_id),
              },
              {
                key: "edit",
                label: de ? "Bearbeiten" : "Edit",
                onSelect: () => onEdit(row.article_id),
              },
              {
                key: "label",
                label: de ? "Etikett drucken" : "Print label",
                disabled: printingId !== null,
                onSelect: () => onPrintLabel(row),
              },
              {
                key: "archive",
                label: de ? "Archivieren" : "Archive",
                danger: true,
                onSelect: () => onArchive(row.article_id),
              },
            ]}
          />
        )}
      </span>
    </li>
  );
}
