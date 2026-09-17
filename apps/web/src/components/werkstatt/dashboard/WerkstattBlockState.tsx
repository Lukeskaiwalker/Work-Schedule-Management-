/**
 * The three things a dashboard block can say instead of showing rows.
 *
 * One component rather than three ternaries per card, because the distinction
 * that matters — "nothing is out there" versus "we could not find out" — was
 * exactly the one the fixture-driven version could not make. An empty list and
 * a failed request both used to render as an empty list.
 */
export type WerkstattBlockPhase = "loading" | "failed" | "empty";

/** One loaded block, as the pages track it. */
export interface WerkstattBlockSource {
  data: unknown;
  error: string | null;
}

/**
 * What a block should say instead of its rows — `null` means "render them".
 *
 * Note what decides "loading": no data AND no error, rather than a `loading`
 * flag. The flag is false for the first painted frame, because the fetch only
 * starts in an effect afterwards, and a block that treats that frame as empty
 * states a fact it has not asked about yet — "Alles über Mindestbestand.",
 * "Nichts ausgegeben." — on a screen whose whole purpose is to stop doing
 * exactly that. The same rule makes a retry read as loading rather than
 * keeping the old failure on screen.
 */
export function blockPhaseFor(
  block: WerkstattBlockSource,
  rowCount: number | undefined,
): WerkstattBlockPhase | null {
  if (block.data == null && block.error == null) return "loading";
  if (block.error) return "failed";
  if (!rowCount) return "empty";
  return null;
}

export interface WerkstattBlockStateProps {
  phase: WerkstattBlockPhase;
  /** What "empty" means for THIS block — "Alles über Mindestbestand", not a
   *  generic "keine Daten". Ignored for the other two phases. */
  emptyLabel: string;
  language: "de" | "en";
}

export function WerkstattBlockState({ phase, emptyLabel, language }: WerkstattBlockStateProps) {
  const de = language === "de";
  if (phase === "loading") {
    return <p className="wsov-state">{de ? "Lädt…" : "Loading…"}</p>;
  }
  if (phase === "failed") {
    return (
      <p className="wsov-state wsov-state--failed">
        {de ? "Nicht geladen." : "Not loaded."}
      </p>
    );
  }
  return <p className="wsov-state">{emptyLabel}</p>;
}
