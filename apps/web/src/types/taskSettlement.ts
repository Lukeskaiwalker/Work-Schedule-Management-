/**
 * Completing a task settles the crate it took to site.
 *
 * Its own module rather than another block in `types/index.ts`: these shapes
 * belong to one flow (preview → dialog → PATCH), they are read by exactly
 * three files, and the 1 500-line shared types file is the one place in the
 * frontend where every area collides.
 *
 * Mirrors `TaskMaterialSettlementOut` / `MaterialRemainderChoice` in
 * apps/api/app/schemas/task.py.
 */

/** Where the material a job did not use up ends up. */
export type MaterialRemainderDisposition = "shelf" | "same_box" | "new_box";

export type MaterialRemainderChoice = {
  disposition: MaterialRemainderDisposition;
  /** Required for "new_box" — the server answers 400 without it. */
  new_box_label?: string | null;
};

export type MaterialSettlementBox = {
  id: number;
  box_number: string;
  label: string;
  status: string;
  customer_name: string | null;
};

export type MaterialSettlementLine = {
  id: number;
  item_name: string;
  unit: string | null;
  quantity: number;
  /**
   * `null` means nobody reported on this line — then the whole line counts as
   * fitted, which is why `remainder` can be 0 while this is null.
   */
  quantity_used: number | null;
  remainder: number;
  article_id: number | null;
};

export type MaterialSettlementPreview = {
  box: MaterialSettlementBox | null;
  lines: MaterialSettlementLine[];
  remainder_total: number;
  /** The handover was never booked — completing the task books it too. */
  handover_pending: boolean;
  /** False for almost every task; only then is the dialog shown at all. */
  needs_decision: boolean;
};

/**
 * What the completion actually did with the rest — the OUTCOME, which is not
 * always the choice that was sent.
 *
 * A crate whose last line disappears between the preview and the PATCH (another
 * tab, the Pi) is emptied whatever the dialog asked for, and the server records
 * that. Mirrors `TaskMaterialSettlementResultOut` in apps/api/app/schemas/task.py.
 */
export type MaterialSettlementResult = {
  disposition: MaterialRemainderDisposition;
  remainder_box_id: number | null;
  /** The crate the rest is in — null when it went back to the racks. */
  remainder_box_number: string | null;
  /** The handover had never been booked; completing the task booked it. */
  handover_booked: boolean;
};

/**
 * The completing PATCH's answer, narrowed to the part this flow reads.
 *
 * Deliberately not the full `Task`: the notice needs the settlement and
 * nothing else, and typing it here keeps `types/index.ts` — the one file every
 * area collides in — out of it.
 */
export type TaskCompletionResponse = {
  material_settlement?: MaterialSettlementResult | null;
};
