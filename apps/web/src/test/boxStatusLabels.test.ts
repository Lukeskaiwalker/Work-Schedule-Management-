/**
 * How a crate's state reads, everywhere it reads.
 *
 * The label map lived three times over (the Kisten page, the customer card,
 * utils/boxes) and the copies were about to say different things: "gepackt"
 * now means "packed for a customer and standing ready to be taken", not just
 * "sealed". These pin the one map and the task-row summary that uses it.
 */
import { describe, expect, it } from "vitest";

import { boxStatusLabel, taskBoxDisplay, taskBoxSummary } from "../utils/boxes";
import type { Task } from "../types";

function task(extra: Partial<Task>): Task {
  return {
    id: 1,
    title: "Montage",
    status: "open",
    ...extra,
  } as Task;
}

describe("boxStatusLabel", () => {
  it("says a packed crate is ready, in both languages", () => {
    expect(boxStatusLabel("gepackt", true)).toBe("Gepackt – bereit");
    expect(boxStatusLabel("gepackt", false)).toBe("Packed – ready");
  });

  it("keeps the other states as they were", () => {
    expect(boxStatusLabel("zugewiesen", true)).toBe("Beim Kunden");
    expect(boxStatusLabel("offen", true)).toBe("Offen");
    expect(boxStatusLabel("zurueck", true)).toBe("Zurück");
  });

  it("passes an unknown state through and answers nothing for none", () => {
    expect(boxStatusLabel("unterwegs", true)).toBe("unterwegs");
    expect(boxStatusLabel(null, true)).toBe("");
  });
});

describe("taskBoxSummary", () => {
  it("appends the crate's state to its identity", () => {
    const row = task({
      construction_box_number: "K3",
      construction_box_label: "Kiste 3",
      construction_box_status: "gepackt",
    });
    expect(taskBoxSummary(row, true)).toBe("K3 — Kiste 3 · Gepackt – bereit");
  });

  it("falls back to the identity alone when no state is known", () => {
    const row = task({ construction_box_number: "K3", construction_box_label: "Kiste 3" });
    expect(taskBoxSummary(row, true)).toBe(taskBoxDisplay(row));
  });

  it("is null for a task without a crate", () => {
    expect(taskBoxSummary(task({}), true)).toBeNull();
  });

  it("still reads the legacy free-typed number", () => {
    expect(taskBoxSummary(task({ storage_box_number: 4 }), true)).toBe("4");
  });
});
