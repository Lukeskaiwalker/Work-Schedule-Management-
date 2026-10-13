/**
 * The Werkstatt page's way into "Material gewechselt"
 * (docs/LABEL_PRINTER_CALIBRATION.md §7.11).
 *
 * Self-gating, so the page that mounts it needs one line:
 *   1. without `werkstatt:manage` or `settings:manage` it renders and fetches
 *      nothing;
 *   2. otherwise it reads the overview once (DB only — no printer I/O on a
 *      page load) and renders nothing while that loads or if it fails;
 *   3. staff without `settings:manage` see nothing until an admin switches on
 *      `label_calibration_staff_enabled` — the flow stays admin-only until the
 *      physical tests have results;
 *   4. no printer address → the button is shown disabled, with the reason.
 */
import { useEffect, useState } from "react";

import { useAppContext } from "../../context/AppContext";
import type { LabelPrinterOverview } from "../../types/labelPrinter";
import { getLabelPrinterOverview } from "../../utils/labelPrinterApi";
import { MaterialChangeSheet } from "./MaterialChangeSheet";

function PrinterIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M7 9V4h10v5" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
      <rect x="4" y="9" width="16" height="7" rx="1.5" stroke="currentColor" strokeWidth="1.7" />
      <path d="M8 14h8v6H8z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
    </svg>
  );
}

export function LabelPrinterQuickEntry() {
  const { token, user, language } = useAppContext();
  const de = language === "de";
  const permissions = user?.effective_permissions ?? [];
  const allowed = permissions.includes("werkstatt:manage") || permissions.includes("settings:manage");
  const [overview, setOverview] = useState<LabelPrinterOverview | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!allowed) return undefined;
    let alive = true;
    getLabelPrinterOverview(token)
      .then((next) => {
        if (alive) setOverview(next);
      })
      .catch(() => {
        // Not worth a banner on the machine register: the entry simply stays hidden.
        if (alive) setOverview(null);
      });
    return () => {
      alive = false;
    };
  }, [allowed, token]);

  if (!allowed || !overview) return null;
  if (!overview.can_full && !overview.staff_enabled) return null;

  const title = overview.configured
    ? de
      ? "WAGO-Etikettendrucker: Material gewechselt"
      : "WAGO label printer: material changed"
    : de
      ? "Kein Etikettendrucker konfiguriert"
      : "No label printer configured";

  return (
    <>
      <button
        type="button"
        className="werkstatt-action-btn"
        title={title}
        disabled={!overview.configured}
        onClick={() => setOpen(true)}
      >
        <PrinterIcon />
        {de ? "Etikettendrucker" : "Label printer"}
      </button>
      {open && <MaterialChangeSheet onClose={() => setOpen(false)} />}
    </>
  );
}
