/**
 * "+ Neue Kategorie" / "+ Neuer Lagerort", without leaving the article form.
 *
 * The form this replaces had free-text category and location fields, so every
 * spelling made a new one and the Bestand filters slowly filled with "Regal
 * B2", "Regal b2" and "regal  B2". Selects fix that and introduce the obvious
 * next problem: the shelf somebody is standing at is genuinely new, and
 * sending them to another page to create it means the article gets filed under
 * nothing at all.
 *
 * So both taxonomies can be created from inside the dialog — with the SAME
 * dialogs the taxonomy page uses, not a second simplified form that would
 * drift from it. The hook returns the two openers and the JSX to render; both
 * article dialogs use it, which is what keeps them identical.
 */
import { useCallback, useState } from "react";

import type { WerkstattCategory, WerkstattLocation } from "../../types/werkstatt";
import { createCategory, createLocation } from "../../utils/werkstattTaxonomyApi";
import { CategoryFormModal } from "./CategoryFormModal";
import { LocationFormModal } from "./LocationFormModal";

export interface TaxonomieSchnellanlage {
  openCategory: () => void;
  openLocation: () => void;
  /** Render this inside the dialog; it is null while neither is open. */
  modals: React.ReactNode;
}

export interface TaxonomieSchnellanlageOptions {
  token: string | null;
  language: "de" | "en";
  categories: ReadonlyArray<WerkstattCategory>;
  locations: ReadonlyArray<WerkstattLocation>;
  /** Fold the new row into the list and select it, in one step: a category
   *  created and then not chosen is the same dead end with an extra click. */
  onCategoryCreated: (category: WerkstattCategory) => void;
  onLocationCreated: (location: WerkstattLocation) => void;
  onError: (message: string) => void;
}

export function useTaxonomieSchnellanlage({
  token,
  language,
  categories,
  locations,
  onCategoryCreated,
  onLocationCreated,
  onError,
}: TaxonomieSchnellanlageOptions): TaxonomieSchnellanlage {
  const [categoryOpen, setCategoryOpen] = useState(false);
  const [locationOpen, setLocationOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const saveCategory = useCallback(
    async (name: string, parentId: string | null, notes: string) => {
      if (busy) return;
      setBusy(true);
      try {
        const created = await createCategory(token, {
          name: name.trim(),
          parent_id: parentId ? Number(parentId) : null,
          notes: notes.trim() || null,
        });
        onCategoryCreated(created);
        setCategoryOpen(false);
      } catch (err) {
        onError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [busy, token, onCategoryCreated, onError],
  );

  const saveLocation = useCallback(
    async (payload: {
      name: string;
      kind: "hall" | "shelf" | "vehicle" | "external";
      status: "open" | "closed" | "on_route" | "in_workshop";
      parent_id: string | null;
      address: string;
      notes: string;
    }) => {
      if (busy) return;
      setBusy(true);
      try {
        const created = await createLocation(token, {
          name: payload.name.trim(),
          location_type: payload.kind,
          // A shelf inherits its hall's availability, so it carries none of
          // its own — sending one would invent a fact about the place.
          status: payload.kind === "shelf" ? null : payload.status,
          parent_id: payload.parent_id ? Number(payload.parent_id) : null,
          address: payload.address.trim() || null,
          notes: payload.notes.trim() || null,
        });
        onLocationCreated(created);
        setLocationOpen(false);
      } catch (err) {
        onError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [busy, token, onLocationCreated, onError],
  );

  const modals = (
    <>
      {categoryOpen && (
        <CategoryFormModal
          open
          mode="create"
          language={language}
          initial={{ id: null, name: "", parent_id: null, notes: "" }}
          topLevelOptions={categories
            .filter((category) => category.parent_id === null)
            .map((category) => ({ id: String(category.id), name: category.name }))}
          onClose={() => setCategoryOpen(false)}
          onSave={(payload) =>
            void saveCategory(payload.name, payload.parent_id, payload.notes)
          }
        />
      )}
      {locationOpen && (
        <LocationFormModal
          open
          mode="create"
          language={language}
          initial={{
            id: null,
            name: "",
            kind: "shelf",
            status: "open",
            parent_id: null,
            address: "",
            notes: "",
          }}
          parentOptions={locations
            .filter((location) => location.location_type === "hall")
            .map((location) => ({ id: String(location.id), name: location.name }))}
          onClose={() => setLocationOpen(false)}
          onSave={(payload) => void saveLocation(payload)}
        />
      )}
    </>
  );

  return {
    openCategory: () => setCategoryOpen(true),
    openLocation: () => setLocationOpen(true),
    modals: categoryOpen || locationOpen ? modals : null,
  };
}
