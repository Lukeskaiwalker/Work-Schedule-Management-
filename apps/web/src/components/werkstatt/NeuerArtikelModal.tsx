/**
 * "Neuer Lagerartikel" — the consumables-only create dialog.
 *
 * Two things were wrong with the dialog this replaces, and they compounded.
 * It saved nothing (an error toast and a TODO), and it asked for the wrong
 * things: a Seriennummer, a BG-Prüfpflicht toggle and free-text taxonomies,
 * which are a machine's fields, not a box of terminals'. Machines are created
 * in the Maschinen tab, where units get labels and inspection dates; this
 * dialog never sets `is_serialized`, so what it makes is always a consumable.
 *
 * Three steps, because a code answers a question before the form can:
 *
 *   Code    — scan (wedge or camera), type, or skip. The camera is a
 *             first-class button: the workshop tablet has no wedge.
 *   Treffer — what the code turned out to be. An article we already stock
 *             ends the flow here, with the action somebody actually wanted.
 *   Daten   — the form, prefilled from whatever the lookup found.
 *
 * The dialog owns the requests but not the news: it reports the created
 * article upward and lets the page decide what to say and what to reload.
 */
import { useCallback, useEffect, useState } from "react";

import { ApiError } from "../../api/client";
import type {
  MaterialCatalogItemLite,
  WerkstattArticle,
  WerkstattArticleLookup,
  WerkstattCatalogGroup,
} from "../../types/werkstatt";
import {
  createArticle,
  createArticleFromCatalog,
} from "../../utils/werkstattArticlesApi";
import { lookupArticleCode } from "../../utils/werkstattArticleLookupApi";
import { searchWerkstattCatalog } from "../../utils/werkstattCatalogApi";
import { ArtikelCodeStep } from "./ArtikelCodeStep";
import { ArtikelFormFields } from "./ArtikelFormFields";
import { ArtikelLookupResult } from "./ArtikelLookupResult";
import { ArtikelKatalogSchritt } from "./ArtikelKatalogSchritt";
import {
  artikelFormError,
  artikelFormFromHit,
  emptyArtikelForm,
  toCreateInput,
  type ArtikelFormValues,
} from "./artikelForm";
import { useArtikelStammdaten } from "./useArtikelStammdaten";
import { useTaxonomieSchnellanlage } from "./useTaxonomieSchnellanlage";
import "../../styles/stock.css";

type Step = "code" | "result" | "form";

export interface NeuerArtikelModalProps {
  open: boolean;
  onClose: () => void;
  language: "de" | "en";
  token: string | null;
  /** A code the caller already has — from the mobile scanner, say. The
   *  dialog resolves it on open instead of asking for it again. */
  seedCode?: string | null;
  /** A catalogue row the caller already picked (the Katalog page's
   *  "In Werkstatt anlegen"). Skips straight to the catalogue branch. */
  seedCatalogItem?: MaterialCatalogItemLite | null;
  onCreated: (article: WerkstattArticle) => void;
  /** An `existing` hit hands off rather than offering a duplicate. */
  onAdjustStock?: (articleId: number) => void;
  onEditArticle?: (articleId: number) => void;
}

export function NeuerArtikelModal({
  open,
  onClose,
  language,
  token,
  seedCode = null,
  seedCatalogItem = null,
  onCreated,
  onAdjustStock,
  onEditArticle,
}: NeuerArtikelModalProps) {
  const de = language === "de";
  const stammdaten = useArtikelStammdaten(token, open);

  const [step, setStep] = useState<Step>("code");
  const [lookup, setLookup] = useState<WerkstattArticleLookup | null>(null);
  const [values, setValues] = useState<ArtikelFormValues>(emptyArtikelForm());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Catalogue branch state: which group is chosen and which suppliers' rows
  // get linked. Two levels, because the group decides what the article IS and
  // the ticks decide which article numbers it will carry.
  const [groups, setGroups] = useState<WerkstattCatalogGroup[]>([]);
  const [catalogQuery, setCatalogQuery] = useState("");
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [pickedGroup, setPickedGroup] = useState<WerkstattCatalogGroup | null>(null);
  const [pickedSuppliers, setPickedSuppliers] = useState<ReadonlySet<number>>(new Set());

  const taxonomy = useTaxonomieSchnellanlage({
    token,
    language,
    categories: stammdaten.categories,
    locations: stammdaten.locations,
    onCategoryCreated: (category) => {
      stammdaten.addCategory(category);
      setValues((prev) => ({ ...prev, category_id: category.id }));
    },
    onLocationCreated: (location) => {
      stammdaten.addLocation(location);
      setValues((prev) => ({ ...prev, location_id: location.id }));
    },
    onError: setError,
  });

  const reset = useCallback(() => {
    setStep("code");
    setLookup(null);
    setValues(emptyArtikelForm());
    setError(null);
    setBusy(false);
    setGroups([]);
    setCatalogQuery("");
    setPickedGroup(null);
    setPickedSuppliers(new Set());
  }, []);

  const runLookup = useCallback(
    async (code: string) => {
      setBusy(true);
      setError(null);
      try {
        const found = await lookupArticleCode(token, code);
        setLookup(found);
        if (found.kind === "catalog") {
          setGroups(found.groups);
          setPickedGroup(found.groups[0] ?? null);
          setPickedSuppliers(new Set(found.groups[0]?.suppliers.map((row) => row.id) ?? []));
          setStep("result");
        } else if (found.kind === "external") {
          setValues(artikelFormFromHit(found.hit));
          setStep("form");
        } else if (found.kind === "existing") {
          setStep("result");
        } else {
          setValues(emptyArtikelForm({ ean: code.trim(), ean_locked: true }));
          setStep("form");
        }
        return {
          ok: found.kind !== "existing",
          label:
            found.kind === "existing"
              ? de
                ? `Schon im Bestand: ${found.article.article_number}`
                : `Already stocked: ${found.article.article_number}`
              : de
                ? "Code übernommen"
                : "Code accepted",
        };
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        setError(detail);
        return { ok: false, label: detail };
      } finally {
        setBusy(false);
      }
    },
    [token, de],
  );

  /* Opening with a code or a catalogue row means the first question is already
   * answered; asking it again would be the dialog ignoring what it was handed.
   *
   * Keyed on the seed's ID, never on the object: a caller that builds the seed
   * inline in JSX hands us a new object on every render, and an effect
   * depending on the object would re-run, set state, re-render, and loop. The
   * id is what actually changed when the seed changed. */
  const seedCatalogItemId = seedCatalogItem?.id ?? null;
  useEffect(() => {
    if (!open) {
      reset();
      return;
    }
    if (seedCatalogItem) {
      const group: WerkstattCatalogGroup = {
        ean: seedCatalogItem.ean,
        hero: seedCatalogItem,
        suppliers: [seedCatalogItem],
      };
      setGroups([group]);
      setPickedGroup(group);
      setPickedSuppliers(new Set([seedCatalogItem.id]));
      setLookup({
        kind: "catalog",
        code: seedCatalogItem.ean ?? seedCatalogItem.article_no ?? "",
        groups: [group],
        matched_by: "catalog_ean",
      });
      setStep("result");
      return;
    }
    if (seedCode) void runLookup(seedCode);
    // `runLookup` and `seedCatalogItem` are read but deliberately not depended
    // on: re-running this would refire a lookup that can reach a webshop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, seedCode, seedCatalogItemId, reset]);

  const searchCatalog = useCallback(
    async (query: string) => {
      setCatalogQuery(query);
      if (query.trim().length < 2) return;
      setCatalogLoading(true);
      try {
        setGroups(await searchWerkstattCatalog(token, { q: query.trim(), limit: 40 }));
      } catch {
        // The picker keeps whatever it had; the create path does not depend
        // on the catalogue being reachable.
        setGroups([]);
      } finally {
        setCatalogLoading(false);
      }
    },
    [token],
  );

  const saveFromCatalog = useCallback(async () => {
    if (!pickedGroup || busy) return;
    setBusy(true);
    setError(null);
    try {
      const extra = pickedGroup.suppliers.filter(
        (row) => pickedSuppliers.has(row.id) && row.supplier_id != null,
      );
      const article = await createArticleFromCatalog(token, {
        catalog_item_id: pickedGroup.hero.id,
        category_id: values.category_id,
        location_id: values.location_id,
        stock_total: Number.parseInt(values.stock_total, 10) || 0,
        stock_min: Number.parseInt(values.stock_min, 10) || 0,
        supplier_links: extra.map((row, index) => ({
          supplier_id: row.supplier_id as number,
          supplier_article_no: row.article_no,
          source_catalog_item_id: row.id,
          is_preferred: index === 0,
        })),
      });
      onCreated(article);
      onClose();
    } catch (err) {
      setError(errorText(err, de));
    } finally {
      setBusy(false);
    }
  }, [pickedGroup, pickedSuppliers, busy, token, values, onCreated, onClose, de]);

  const saveForm = useCallback(async () => {
    if (busy) return;
    const invalid = artikelFormError(values, de);
    if (invalid) {
      setError(invalid);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const external = lookup?.kind === "external" ? lookup.hit.source : null;
      const article = await createArticle(
        token,
        toCreateInput(values, {
          lookupSource: external,
          imageSource: external ? "external" : null,
        }),
      );
      onCreated(article);
      onClose();
    } catch (err) {
      setError(errorText(err, de));
    } finally {
      setBusy(false);
    }
  }, [busy, values, de, lookup, token, onCreated, onClose]);

  if (!open) return null;

  const isCatalogStep = step === "result" && lookup?.kind === "catalog";
  const title = de ? "Neuer Lagerartikel" : "New stock item";

  return (
    <div className="werkstatt-modal-backdrop" role="presentation" onClick={onClose}>
      <div
        className="werkstatt-modal werkstatt-modal--wide stock-modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="werkstatt-modal-head">
          <div>
            <span className="werkstatt-sub-breadcrumb">
              {de ? "WERKSTATT · NEUER ARTIKEL" : "WORKSHOP · NEW ITEM"}
            </span>
            <h2 className="werkstatt-modal-title">{title}</h2>
            <small className="muted">
              {de
                ? "Verbrauchs- und Lagerartikel. Maschinen werden unter „Maschinen“ angelegt."
                : "Consumables and stock items. Machines are created under “Machines”."}
            </small>
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

        <div className="werkstatt-modal-body">
          {step === "code" && (
            <ArtikelCodeStep
              de={de}
              language={language}
              busy={busy}
              error={error}
              onSubmit={runLookup}
              onSkip={() => {
                setLookup(null);
                setValues(emptyArtikelForm());
                setStep("form");
              }}
            />
          )}

          {step === "result" && lookup && (
            <>
              <ArtikelLookupResult
                de={de}
                result={lookup}
                onAdjustStock={
                  onAdjustStock
                    ? (articleId) => {
                        onClose();
                        onAdjustStock(articleId);
                      }
                    : undefined
                }
                onEditArticle={
                  onEditArticle
                    ? (articleId) => {
                        onClose();
                        onEditArticle(articleId);
                      }
                    : undefined
                }
                onBack={() => setStep("code")}
              />
              {isCatalogStep && (
                <ArtikelKatalogSchritt
                  de={de}
                  language={language}
                  groups={groups}
                  pickedGroup={pickedGroup}
                  pickedSuppliers={pickedSuppliers}
                  loading={catalogLoading}
                  busy={busy}
                  values={values}
                  categories={stammdaten.categories}
                  locations={stammdaten.locations}
                  search={{ value: catalogQuery, onChange: (value) => void searchCatalog(value) }}
                  onPickGroup={(group) => {
                    setPickedGroup(group);
                    setPickedSuppliers(new Set(group.suppliers.map((row) => row.id)));
                  }}
                  onToggleSupplier={(id) =>
                    setPickedSuppliers((prev) => {
                      const next = new Set(prev);
                      if (next.has(id)) next.delete(id);
                      else next.add(id);
                      return next;
                    })
                  }
                  onChangeValues={setValues}
                />
              )}
            </>
          )}

          {step === "form" && (
            <>
              {lookup && <ArtikelLookupResult de={de} result={lookup} onBack={() => setStep("code")} />}
              <ArtikelFormFields
                de={de}
                values={values}
                onChange={setValues}
                categories={stammdaten.categories}
                locations={stammdaten.locations}
                suppliers={stammdaten.suppliers}
                mode="create"
                disabled={busy}
                onCreateCategory={taxonomy.openCategory}
                onCreateLocation={taxonomy.openLocation}
              />
            </>
          )}

          {error && step !== "code" && (
            <p className="stock-modal-error" role="alert">
              {error}
            </p>
          )}
          {stammdaten.error && (
            <p className="stock-modal-error muted" role="status">
              {de
                ? "Kategorien, Lagerorte oder Lieferanten konnten nicht geladen werden — der Artikel lässt sich trotzdem anlegen."
                : "Categories, locations or suppliers could not be loaded — the article can still be created."}
            </p>
          )}
        </div>

        <footer className="werkstatt-modal-foot">
          <small className="muted">
            {isCatalogStep && pickedGroup
              ? de
                ? `1 Artikel gewählt · ${pickedSuppliers.size} Lieferanten verknüpft`
                : `1 article selected · ${pickedSuppliers.size} suppliers linked`
              : ""}
          </small>
          <div className="werkstatt-modal-foot-actions">
            <button type="button" className="werkstatt-action-btn" onClick={onClose}>
              {de ? "Abbrechen" : "Cancel"}
            </button>
            {isCatalogStep && (
              <button
                type="button"
                className="werkstatt-action-btn werkstatt-action-btn--primary"
                disabled={busy || !pickedGroup}
                onClick={() => void saveFromCatalog()}
              >
                {de ? "Artikel anlegen + verknüpfen" : "Create + link article"}
              </button>
            )}
            {step === "form" && (
              <button
                type="button"
                className="werkstatt-action-btn werkstatt-action-btn--primary"
                disabled={busy || !values.item_name.trim()}
                onClick={() => void saveForm()}
              >
                {busy ? (de ? "Speichern…" : "Saving…") : de ? "Artikel speichern" : "Save article"}
              </button>
            )}
          </div>
        </footer>
      </div>
      {taxonomy.modals}
    </div>
  );
}

/**
 * The server's own sentence, which is in German and names the article an EAN
 * already belongs to. Falling back to a generic message would throw away the
 * only part of the answer the user can act on.
 */
function errorText(err: unknown, de: boolean): string {
  if (err instanceof ApiError && typeof err.detail === "string") return err.detail;
  if (err instanceof Error && err.message) return err.message;
  return de ? "Speichern fehlgeschlagen." : "Saving failed.";
}
