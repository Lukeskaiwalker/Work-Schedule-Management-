/**
 * A stand-in for EnclosureTab in the sheet tests: holds the document, runs
 * the ops a sheet hands over exactly the way the tab does (refusal → its
 * message, otherwise apply and call `then`), and applies plain edits.
 * Regroup confirmation is the tab's job; the harness applies regardless and
 * records what an op reported, so a test can assert it.
 * Invented boards only — the repo is public.
 */
import { useRef, useState, type ReactElement } from "react";
import { render } from "@testing-library/react";

import { INDEX } from "./enclosureTestCatalog";
import type { CatalogIndex } from "../utils/enclosureCatalog";
import type { Regroup } from "../utils/enclosureFeeds";
import type { EditDocument, RunEnclosureOp } from "../components/schaltplan/enclosure/useSheetStack";
import type { PanelDocument } from "../types/schaltplan";

export interface SheetHarnessApi {
  document: PanelDocument;
  onOp: RunEnclosureOp;
  onEdit: EditDocument;
}

export interface SheetHarness {
  /** The document as it stands after every op and edit so far. */
  current(): PanelDocument;
  errors: string[];
  regrouped: Regroup[][];
  rerenderWith(next: PanelDocument): void;
}

export function renderSheet(
  initial: PanelDocument,
  view: (api: SheetHarnessApi) => ReactElement,
  index: CatalogIndex = INDEX,
): SheetHarness & ReturnType<typeof render> {
  const latest = { document: initial };
  const errors: string[] = [];
  const regrouped: Regroup[][] = [];
  let replace: (next: PanelDocument) => void = () => undefined;

  function Host() {
    const [document, setDocument] = useState(initial);
    const ref = useRef(document);
    ref.current = document;
    latest.document = document;
    replace = (next) => {
      ref.current = next;
      latest.document = next;
      setDocument(next);
    };
    const onOp: RunEnclosureOp = (op, then) => {
      const result = op(ref.current, index);
      if (!result.ok) {
        errors.push(result.error);
        return;
      }
      if (result.regrouped.length > 0) regrouped.push(result.regrouped);
      ref.current = result.document;
      latest.document = result.document;
      setDocument(result.document);
      then?.(result);
    };
    const onEdit: EditDocument = (recipe) => {
      const next = recipe(ref.current);
      ref.current = next;
      latest.document = next;
      setDocument(next);
    };
    return view({ document, onOp, onEdit });
  }

  const utils = render(<Host />);
  return {
    ...utils,
    current: () => latest.document,
    errors,
    regrouped,
    rerenderWith: (next) => replace(next),
  };
}
