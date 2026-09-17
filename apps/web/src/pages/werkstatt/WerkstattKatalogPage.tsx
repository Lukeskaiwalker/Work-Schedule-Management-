import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAppContext } from "../../context/AppContext";
import { NeuerArtikelModal } from "../../components/werkstatt/NeuerArtikelModal";
import {
  NeuerBedarfModal,
  type NeuerBedarfSubmit,
} from "../../components/werkstatt/bedarfe/NeuerBedarfModal";
import { createNeed } from "../../utils/werkstattBedarfeApi";
import { searchWerkstattCatalog } from "../../utils/werkstattCatalogApi";
import { listSuppliers } from "../../utils/werkstattSuppliersApi";
import { deleteCatalogImage, uploadCatalogImage } from "../../utils/werkstattKatalogApi";
import {
  KATALOG_FETCH_LIMIT,
  KATALOG_SEARCH_LIMIT,
  countCatalogRows,
  describeImageDeletion,
  groupImage,
  imageRemovedMessage,
  isTruncated,
  rowLabel,
  supplierLeadTimes,
  supplierTagText,
  toBedarfSeed,
  trimToRowLimit,
  withCatalogImage,
} from "../../components/werkstatt/katalogEntries";
import type {
  MaterialCatalogItemLite,
  WerkstattCatalogGroup,
  WerkstattSupplier,
} from "../../types/werkstatt";
import "../../styles/katalog.css";

/**
 * WerkstattKatalogPage — Datanorm catalog browse / search.
 *
 * Reads `GET /werkstatt/catalog/search`, which is the endpoint that knows
 * which SUPPLIER a catalogue row came from. The page previously read the
 * legacy `/materials/catalog` instead, which does not carry a supplier at
 * all — so it printed the MANUFACTURER under the heading "Lieferanten",
 * filtered those names against a fixture list of suppliers that had been
 * emptied (making the filter row permanently blank), and padded every offer
 * with `lead_time_days: 0` and `is_preferred: false`, i.e. "0 Werktage" on
 * every article in the workshop and a PREFERRED badge that could never light
 * up. None of those three values existed in any API response.
 *
 * Both the search text and the supplier filter are applied by the SERVER.
 * Filtering the supplier client-side would only ever filter the rows that
 * happened to be in the current page of results, and the Datanorm pool is
 * hundreds of thousands of rows deep.
 */

const SEARCH_DEBOUNCE_MS = 220;

function errorText(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

export function WerkstattKatalogPage() {
  const {
    mainView,
    language,
    werkstattTab,
    setNotice,
    token,
    user,
    activeProjects,
  } = useAppContext();

  const de = language === "de";
  const active = mainView === "werkstatt" && werkstattTab === "katalog";

  /* POST /werkstatt/articles (and /articles/from-catalog) need
   * `werkstatt:manage`. Offering the dialog without it costs a filled-in
   * dialog to learn that — the same rule the Bestand page's row menu keeps. */
  const canManageStock = (user?.effective_permissions ?? []).includes("werkstatt:manage");

  const [query, setQuery] = useState("");
  const [supplierFilter, setSupplierFilter] = useState<number | null>(null);
  const [groups, setGroups] = useState<ReadonlyArray<WerkstattCatalogGroup>>([]);
  /* Decided on the RAW response (one row wider than the page shows) and kept,
   * because the trimmed list on screen can no longer prove it. */
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [suppliers, setSuppliers] = useState<ReadonlyArray<WerkstattSupplier>>([]);
  const [suppliersLoading, setSuppliersLoading] = useState(true);
  const [supplierError, setSupplierError] = useState<string | null>(null);
  const [imageError, setImageError] = useState<string | null>(null);
  const [imageBusyKeys, setImageBusyKeys] = useState<ReadonlySet<string>>(new Set());
  /* The catalogue row whose × is armed: a delete is two deliberate clicks. */
  const [pendingImageDelete, setPendingImageDelete] = useState<string | null>(null);
  /* Bumped by the retry buttons. A counter rather than a callback because both
   * loads are effects, and re-running an effect is what "try again" means. */
  const [retryCount, setRetryCount] = useState(0);

  const [neuerArtikelOpen, setNeuerArtikelOpen] = useState(false);
  const [neuerArtikelSeed, setNeuerArtikelSeed] = useState<MaterialCatalogItemLite | null>(null);
  // "Zum Projekt-Bedarf": the catalogue is where somebody realises a site is
  // short of something, and until now the only way to record that was to wait
  // for a fitter to file a report.
  const [bedarfSeed, setBedarfSeed] = useState<MaterialCatalogItemLite | null>(null);
  const [bedarfBusy, setBedarfBusy] = useState(false);
  const [bedarfError, setBedarfError] = useState<string | null>(null);

  const imageFileInputRefs = useRef<Record<string, HTMLInputElement | null>>({});
  /* Out-of-order guard: a fast typist has several searches in flight and the
   * slowest one must not be the one that lands. */
  const searchSeqRef = useRef(0);

  // Debounced, server-side search. Re-runs on every input the server cares
  // about: the text, the supplier filter, the session.
  useEffect(() => {
    if (!active) return;
    const seq = searchSeqRef.current + 1;
    searchSeqRef.current = seq;
    setLoading(true);
    const timeout = window.setTimeout(() => {
      void searchWerkstattCatalog(token, {
        q: query.trim(),
        supplierId: supplierFilter,
        // One row more than the page shows, purely to tell "cut off here"
        // apart from "that is all there is".
        limit: KATALOG_FETCH_LIMIT,
      })
        .then((found) => {
          if (seq !== searchSeqRef.current) return;
          // Judge before trimming; show only what the note talks about.
          setTruncated(isTruncated(found));
          setGroups(trimToRowLimit(found));
          setLoadError(null);
          // A new result is a new list: an armed × must not survive into it
          // and turn the next single click on that row into a deletion.
          setPendingImageDelete(null);
        })
        .catch((err: unknown) => {
          if (seq !== searchSeqRef.current) return;
          // Empty the list as well: leaving the previous hits on screen under
          // a failed search is how a stale result gets read as a fresh one.
          setGroups([]);
          setTruncated(false);
          setLoadError(
            errorText(
              err,
              de ? "Katalog konnte nicht geladen werden." : "The catalog could not be loaded.",
            ),
          );
        })
        .finally(() => {
          if (seq !== searchSeqRef.current) return;
          setLoading(false);
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timeout);
  }, [active, token, query, supplierFilter, retryCount, de]);

  // The supplier filter's options. Independent of the search: a failure here
  // costs the filter row, not the catalogue.
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    setSuppliersLoading(true);
    void listSuppliers(token)
      .then((rows) => {
        if (cancelled) return;
        setSuppliers(rows);
        setSupplierError(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setSuppliers([]);
        setSupplierError(
          errorText(
            err,
            de ? "Lieferanten konnten nicht geladen werden." : "Suppliers could not be loaded.",
          ),
        );
      })
      .finally(() => {
        if (!cancelled) setSuppliersLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [active, token, retryCount, de]);

  /** Chips offer every live supplier, including ones with no Datanorm rows
   *  yet — picking such a supplier answers "nothing imported for them",
   *  which is the thing the buyer wanted to know. */
  const supplierChips = useMemo(
    () => suppliers.filter((supplier) => !supplier.is_archived),
    [suppliers],
  );

  const leadTimes = useMemo(() => supplierLeadTimes(suppliers), [suppliers]);

  const setImageBusy = useCallback((externalKey: string, busy: boolean) => {
    setImageBusyKeys((current) => {
      const next = new Set(current);
      if (busy) next.add(externalKey);
      else next.delete(externalKey);
      return next;
    });
  }, []);

  const handleImageUpload = useCallback(
    async (externalKey: string, file: File) => {
      setImageBusy(externalKey, true);
      setImageError(null);
      try {
        const result = await uploadCatalogImage(token, externalKey, file);
        setGroups((current) => withCatalogImage(current, externalKey, result.image_url));
        setNotice(de ? "Bild hochgeladen." : "Image uploaded.");
      } catch (err) {
        setImageError(
          errorText(
            err,
            de ? "Bild konnte nicht hochgeladen werden." : "The image could not be uploaded.",
          ),
        );
      } finally {
        setImageBusy(externalKey, false);
      }
    },
    [de, setImageBusy, setNotice, token],
  );

  const handleImageDelete = useCallback(
    async (externalKey: string) => {
      setImageBusy(externalKey, true);
      setImageError(null);
      try {
        await deleteCatalogImage(token, externalKey);
        /* Worded from the card the user clicked on — which row the picture
         * came off, and whether another wholesaler's picture for the same EAN
         * has just taken its place. The LIST is updated functionally, so a
         * search that landed during the round trip is not overwritten by the
         * rows this click started from. */
        const deletion = describeImageDeletion(groups, externalKey);
        setGroups((current) => withCatalogImage(current, externalKey, null));
        setNotice(imageRemovedMessage(deletion, de));
      } catch (err) {
        setImageError(
          errorText(
            err,
            de ? "Bild konnte nicht entfernt werden." : "The image could not be removed.",
          ),
        );
      } finally {
        setImageBusy(externalKey, false);
      }
    },
    [de, groups, setImageBusy, setNotice, token],
  );

  /**
   * First click arms, second click deletes.
   *
   * DELETE /materials/catalog/images/{key} removes the cached file and resets
   * the row's image state for EVERY user in the company, with no undo — a
   * hand-uploaded picture has no original to come back from. Both image
   * endpoints are gated on an authenticated user only, so there is no
   * permission to hang the control on and a deliberate second click is the
   * only protection available. A mis-tap on a small × in a browsing list is
   * otherwise a company-wide destructive write.
   */
  const armImageDelete = useCallback((externalKey: string) => {
    setPendingImageDelete(externalKey);
    setImageError(null);
  }, []);

  const confirmImageDelete = useCallback(
    (externalKey: string) => {
      setPendingImageDelete(null);
      void handleImageDelete(externalKey);
    },
    [handleImageDelete],
  );

  /**
   * Switch the supplier filter and drop the rows on screen with it.
   *
   * The chip is aria-selected on the same render, while the new result is a
   * debounce plus a round trip away — on a workshop tablet easily a second or
   * two. Leaving the previous supplier's cards under an already-active chip
   * re-attributes every price on screen to a wholesaler that never quoted it.
   * Emptying the list falls back to the page's own "no counts + Lädt…" state,
   * which claims nothing. (Stale rows under a TYPED query are a different
   * case: the text narrows a pool, it does not re-attribute it.)
   */
  const chooseSupplier = useCallback(
    (supplierId: number | null) => {
      if (supplierId === supplierFilter) return;
      setSupplierFilter(supplierId);
      setGroups([]);
      setTruncated(false);
    },
    [supplierFilter],
  );

  const submitBedarf = useCallback(
    async (input: NeuerBedarfSubmit) => {
      setBedarfBusy(true);
      setBedarfError(null);
      try {
        await createNeed(token, input);
        setBedarfSeed(null);
        setNotice(de ? "Zum Projekt-Bedarf hinzugefügt" : "Added to the project needs");
      } catch (err) {
        setBedarfError(
          errorText(
            err,
            de ? "Bedarf konnte nicht angelegt werden." : "The need could not be created.",
          ),
        );
      } finally {
        setBedarfBusy(false);
      }
    },
    [de, setNotice, token],
  );

  /* One stable object per seed. Built with useMemo rather than inline in the
   * JSX because the dialog keys its "resolve what I was handed" effect on the
   * seed, and a new object on every render would re-run it. */
  const bedarfSeedItem = useMemo(
    () => (bedarfSeed ? toBedarfSeed(bedarfSeed) : null),
    [bedarfSeed],
  );

  if (!active) return null;

  const productCount = groups.length;
  const rowCount = countCatalogRows(groups);
  /* No counts before there is anything to count: "0 Produkte" next to a
   * spinner is a figure, and a figure gets believed. A refresh over rows
   * already on screen keeps showing those, which are the true ones. */
  const firstLoad = loading && groups.length === 0;
  const hasNoEan = groups.some((group) => !group.ean);
  const activeSupplierName =
    supplierFilter == null
      ? null
      : (supplierChips.find((s) => s.id === supplierFilter)?.name ?? null);

  return (
    <section className="werkstatt-tab-page">
      <header className="werkstatt-sub-head">
        <div className="werkstatt-sub-head-text">
          <span className="werkstatt-sub-breadcrumb">
            {de ? "WERKSTATT › KATALOG" : "WORKSHOP › CATALOG"}
          </span>
          <h1 className="werkstatt-sub-title">
            {de ? "Datanorm-Katalog" : "Datanorm catalog"}
          </h1>
          <p className="werkstatt-sub-subtitle">
            {de
              ? "Durchsuche den Datanorm-Pool aller Lieferanten. Gleiche Produkte (gleiche EAN) werden automatisch zusammengefasst."
              : "Browse the Datanorm pool across all suppliers. Identical products (same EAN) are grouped automatically."}
          </p>
        </div>
      </header>

      <div className="werkstatt-filter-bar werkstatt-filter-bar--slim">
        <div className="werkstatt-search werkstatt-search--katalog">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <circle cx="11" cy="11" r="6.3" stroke="#5C7895" strokeWidth="1.8" />
            <path d="m15.6 15.6 4 4" stroke="#5C7895" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
          <input
            type="text"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={
              de
                ? "Name, EAN, Artikelnummer oder Hersteller suchen…"
                : "Search name, EAN, article number or manufacturer…"
            }
            aria-label={de ? "Katalog durchsuchen" : "Search the catalog"}
          />
        </div>
      </div>

      <div className="werkstatt-card werkstatt-katalog-wrap">
        <div
          className="werkstatt-chips"
          role="tablist"
          aria-label={de ? "Nach Lieferant filtern" : "Filter by supplier"}
        >
          <button
            type="button"
            role="tab"
            aria-selected={supplierFilter === null}
            className={`werkstatt-chip${supplierFilter === null ? " werkstatt-chip--active" : ""}`}
            onClick={() => chooseSupplier(null)}
          >
            {de ? "Alle Lieferanten" : "All suppliers"}
          </button>
          {supplierChips.map((supplier) => (
            <button
              key={supplier.id}
              type="button"
              role="tab"
              aria-selected={supplierFilter === supplier.id}
              className={`werkstatt-chip${supplierFilter === supplier.id ? " werkstatt-chip--active" : ""}`}
              onClick={() => chooseSupplier(supplier.id)}
            >
              {supplier.short_name?.trim() || supplier.name}
            </button>
          ))}
          {/* An empty filter row otherwise reads as "there are no suppliers",
              which is a different answer from "not loaded yet". */}
          {supplierChips.length === 0 && !supplierError && (
            <span className="muted katalog-chip-note">
              {suppliersLoading
                ? de
                  ? "Lieferanten werden geladen…"
                  : "Loading suppliers…"
                : de
                  ? "Keine Lieferanten angelegt."
                  : "No suppliers created yet."}
            </span>
          )}
        </div>

        {supplierError && (
          <p className="katalog-inline-error" role="alert">
            {de
              ? `Lieferanten konnten nicht geladen werden — es lässt sich gerade nicht nach Lieferant filtern. (${supplierError})`
              : `Suppliers could not be loaded — filtering by supplier is unavailable. (${supplierError})`}{" "}
            <button
              type="button"
              className="katalog-retry"
              onClick={() => setRetryCount((count) => count + 1)}
            >
              {de ? "Erneut versuchen" : "Try again"}
            </button>
          </p>
        )}

        {imageError && (
          <p className="katalog-inline-error" role="alert">
            {imageError}{" "}
            <button type="button" className="katalog-retry" onClick={() => setImageError(null)}>
              {de ? "Ausblenden" : "Dismiss"}
            </button>
          </p>
        )}

        <div className="werkstatt-katalog-head">
          <span>
            {loadError
              ? de
                ? "Keine Zahlen — der Katalog wurde nicht geladen."
                : "No figures — the catalog did not load."
              : firstLoad
                ? ""
                : de
                  ? `${productCount} Produkte · ${rowCount} Katalogeinträge`
                  : `${productCount} products · ${rowCount} catalog rows`}
          </span>
          {loading && <span className="muted">{de ? "Lädt…" : "Loading…"}</span>}
        </div>

        {!loadError && !loading && truncated && (
          <p className="katalog-note" role="note">
            {de
              ? `Nur die ersten ${KATALOG_SEARCH_LIMIT} Katalogeinträge werden angezeigt — es gibt weitere Treffer. Suche eingrenzen. Die Lieferantenzahl je Produkt kann dadurch unvollständig sein.`
              : `Only the first ${KATALOG_SEARCH_LIMIT} catalog rows are shown — there are more hits. Narrow the search. A product's supplier count can be incomplete because of the cut.`}
          </p>
        )}

        {loadError ? (
          <div className="katalog-error" role="alert">
            <b>{de ? "Katalog konnte nicht geladen werden." : "The catalog could not be loaded."}</b>
            <span className="katalog-error-detail">{loadError}</span>
            <button
              type="button"
              className="werkstatt-action-btn"
              onClick={() => setRetryCount((count) => count + 1)}
            >
              {de ? "Erneut versuchen" : "Try again"}
            </button>
          </div>
        ) : (
          <ul className="werkstatt-katalog-list">
            {groups.map((group) => {
              const hero = group.hero;
              const isMulti = group.suppliers.length > 1;
              const image = groupImage(group);
              // Written to the row the card is about; removed from the row the
              // picture actually hangs on, which after an EAN fold can be a
              // different wholesaler's row.
              const uploadKey = hero.external_key;
              const imageKey = image?.external_key ?? uploadKey;
              const imageBusy = imageBusyKeys.has(uploadKey) || imageBusyKeys.has(imageKey);
              const deleteArmed = pendingImageDelete === imageKey;
              return (
                <li
                  key={group.ean ? `ean-${group.ean}` : `row-${hero.id}`}
                  className={`werkstatt-katalog-card${isMulti ? " werkstatt-katalog-card--hero" : ""}`}
                >
                  <div className="werkstatt-katalog-card-head">
                    <span className="werkstatt-katalog-thumb katalog-thumb">
                      {image?.image_url ? (
                        <img src={image.image_url} alt="" className="katalog-thumb-img" />
                      ) : (
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                          <path
                            d="M12 3 3 7.5v9L12 21l9-4.5v-9L12 3Z"
                            stroke="#5C7895"
                            strokeWidth="1.6"
                            strokeLinejoin="round"
                          />
                        </svg>
                      )}
                      {uploadKey && (
                        <>
                          <button
                            type="button"
                            className="katalog-thumb-hit"
                            onClick={() => imageFileInputRefs.current[uploadKey]?.click()}
                            disabled={imageBusy}
                            title={
                              image?.image_url
                                ? de
                                  ? "Bild ersetzen"
                                  : "Replace image"
                                : de
                                  ? "Bild hochladen"
                                  : "Upload image"
                            }
                            aria-label={
                              image?.image_url
                                ? de
                                  ? `Bild von ${hero.item_name} ersetzen`
                                  : `Replace image of ${hero.item_name}`
                                : de
                                  ? `Bild für ${hero.item_name} hochladen`
                                  : `Upload an image for ${hero.item_name}`
                            }
                          />
                          {image?.image_url && (
                            <button
                              type="button"
                              className={`katalog-thumb-remove${deleteArmed ? " katalog-thumb-remove--armed" : ""}`}
                              disabled={imageBusy}
                              aria-expanded={deleteArmed}
                              onClick={(event) => {
                                event.stopPropagation();
                                armImageDelete(imageKey);
                              }}
                              title={
                                de
                                  ? "Bild entfernen — gilt für alle und lässt sich nicht rückgängig machen."
                                  : "Remove image — applies to everyone and cannot be undone."
                              }
                              aria-label={de ? "Bild entfernen" : "Remove image"}
                            >
                              ×
                            </button>
                          )}
                          {imageBusy && (
                            <span className="katalog-thumb-busy" aria-hidden="true">
                              …
                            </span>
                          )}
                          <input
                            ref={(node) => {
                              imageFileInputRefs.current[uploadKey] = node;
                            }}
                            type="file"
                            accept="image/jpeg,image/png,image/webp,image/gif"
                            hidden
                            onChange={(event) => {
                              const picked = event.target.files?.[0];
                              event.target.value = "";
                              if (picked) void handleImageUpload(uploadKey, picked);
                            }}
                          />
                        </>
                      )}
                    </span>
                    <span className="werkstatt-katalog-title">
                      <b>{hero.item_name}</b>
                      <span
                        className={`werkstatt-katalog-supplier-tag${isMulti ? "" : " werkstatt-katalog-supplier-tag--single"}`}
                      >
                        {supplierTagText(group, {
                          de,
                          filtered: supplierFilter !== null,
                          truncated,
                        })}
                      </span>
                      <small className="werkstatt-katalog-meta">
                        {/* Who sells it, on the cards that have no offer list.
                            The field was in the response and thrown away, so
                            the price on a single-offer card could only be
                            attributed by re-running the search once per
                            supplier chip. */}
                        {!isMulti && (
                          <>
                            <b className="werkstatt-katalog-hero-supplier">
                              {hero.supplier_name?.trim() ||
                                (de ? "ohne Lieferant" : "no supplier")}
                            </b>
                            {" · "}
                          </>
                        )}
                        {hero.manufacturer ?? "—"} ·{" "}
                        {group.ean ? `EAN ${group.ean}` : de ? "keine EAN" : "no EAN"}
                        {hero.article_no ? ` · Art.-Nr. ${hero.article_no}` : ""}
                      </small>
                    </span>
                    {!isMulti && (
                      <span className="werkstatt-katalog-hero-price">
                        <b>{hero.price_text?.trim() || "—"}</b>
                        <small>
                          {hero.unit?.trim() ||
                            (de ? "keine Einheit" : "no unit")}
                        </small>
                      </span>
                    )}
                    <button
                      type="button"
                      className="werkstatt-action-btn"
                      onClick={() => {
                        setBedarfError(null);
                        setBedarfSeed(hero);
                      }}
                    >
                      {de ? "Zum Projekt-Bedarf" : "To project needs"}
                    </button>
                    {canManageStock && (
                      <button
                        type="button"
                        className="werkstatt-action-btn werkstatt-action-btn--primary"
                        onClick={() => {
                          setNeuerArtikelSeed(hero);
                          setNeuerArtikelOpen(true);
                        }}
                      >
                        {de ? "In Werkstatt anlegen" : "Add to workshop"}
                      </button>
                    )}
                  </div>
                  {deleteArmed && image && (
                    <p className="katalog-confirm" role="alert">
                      <span>
                        {de
                          ? `Bild von ${rowLabel(image, de)} entfernen? Das gilt für alle im Betrieb und lässt sich nicht rückgängig machen — ein selbst hochgeladenes Bild ist danach weg.`
                          : `Remove ${rowLabel(image, de)}'s image? This applies to everyone in the company and cannot be undone — an uploaded picture is gone for good.`}
                      </span>
                      <button
                        type="button"
                        className="katalog-confirm-yes"
                        disabled={imageBusy}
                        onClick={() => confirmImageDelete(imageKey)}
                      >
                        {de ? "Entfernen" : "Remove"}
                      </button>
                      <button
                        type="button"
                        className="katalog-confirm-no"
                        onClick={() => setPendingImageDelete(null)}
                      >
                        {de ? "Abbrechen" : "Cancel"}
                      </button>
                    </p>
                  )}
                  {isMulti && (
                    <ul className="werkstatt-katalog-offers">
                      {group.suppliers.map((offer) => {
                        const lead =
                          offer.supplier_id == null ? undefined : leadTimes.get(offer.supplier_id);
                        return (
                          <li key={offer.id} className="werkstatt-katalog-offer">
                            <span className="werkstatt-katalog-offer-main">
                              <b>
                                {offer.supplier_name ??
                                  (de ? "ohne Lieferant" : "no supplier")}
                              </b>
                              <small>Art.-Nr. {offer.article_no || "—"}</small>
                            </span>
                            <span
                              className="werkstatt-katalog-offer-lead"
                              title={
                                lead == null
                                  ? undefined
                                  : de
                                    ? "Standard-Lieferzeit des Lieferanten — nicht artikelbezogen."
                                    : "The supplier's standard lead time — not per article."
                              }
                            >
                              {lead == null
                                ? de
                                  ? "Lieferzeit unbekannt"
                                  : "lead time unknown"
                                : de
                                  ? `i. d. R. ${lead} Werktage`
                                  : `usually ${lead} days`}
                            </span>
                            <span className="werkstatt-katalog-offer-price">
                              {offer.price_text?.trim() || "—"}
                            </span>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </li>
              );
            })}

            {firstLoad && (
              <li className="werkstatt-katalog-empty muted">{de ? "Lädt…" : "Loading…"}</li>
            )}

            {groups.length === 0 && !loading && (
              <li className="werkstatt-katalog-empty muted">
                {query.trim() || supplierFilter !== null
                  ? de
                    ? `Keine Treffer${activeSupplierName ? ` bei ${activeSupplierName}` : ""}.`
                    : `No hits${activeSupplierName ? ` at ${activeSupplierName}` : ""}.`
                  : de
                    ? "Noch keine Katalogdaten. Eine Datanorm-Datei wird unter Werkstatt › Datanorm-Import eingelesen (Administrator)."
                    : "No catalog data yet. A Datanorm file is imported under Workshop › Datanorm import (administrator)."}
              </li>
            )}
          </ul>
        )}

        {hasNoEan && !loadError && (
          <div className="werkstatt-no-ean-warn" role="note">
            <span className="werkstatt-no-ean-warn-icon" aria-hidden="true">⚠</span>
            <span>
              {de
                ? "Einige Produkte haben keine EAN — sie können später nicht per Scan gefunden werden und laufen über die interne SP-Nummer."
                : "Some products have no EAN — they cannot be found by scan and will fall back to the internal SP number."}
            </span>
          </div>
        )}
      </div>

      <NeuerArtikelModal
        open={neuerArtikelOpen}
        onClose={() => {
          setNeuerArtikelOpen(false);
          setNeuerArtikelSeed(null);
        }}
        language={language}
        token={token}
        seedCatalogItem={neuerArtikelSeed}
        onCreated={(article) => {
          setNeuerArtikelSeed(null);
          setNotice(
            de
              ? `${article.article_number} „${article.item_name}“ im Bestand angelegt`
              : `${article.article_number} “${article.item_name}” added to stock`,
          );
        }}
      />

      <NeuerBedarfModal
        open={bedarfSeed != null}
        language={language}
        token={token}
        projects={activeProjects}
        seedCatalogItem={bedarfSeedItem}
        busy={bedarfBusy}
        error={bedarfError}
        onSubmit={(input) => void submitBedarf(input)}
        onClose={() => setBedarfSeed(null)}
      />
    </section>
  );
}
