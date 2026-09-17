# Werkstatt Implementation Contract

> **This is the shared spec read by all 6 implementation agents.**
> Every agent must stay within its file-ownership fence listed below. Shared
> files (types, models, schemas, migrations, routing) are **pre-authored by
> the orchestrator** — agents extend via named sections only, never edit
> existing code in shared files.

## 1. Scope

Werkstatt is the workshop / inventory feature. It subsumes the former
top-level "Materials" view (as sub-tabs Katalog + Projekt-Bedarfe). It adds:

- Article pool (tools, consumables, machines) with **EAN** and **SP-Nummer**
- **Multi-supplier** catalog — each supplier has their own Datanorm import,
  items with the same EAN from different suppliers link automatically
- **Order lifecycle** (draft → sent → delivered) with expected delivery dates
- **Scanning** — external Bluetooth barcode scanner (primary) + camera (fallback)
- **On-add image lookup** — Unielektro image lookup triggered when the user
  adds an article from the catalog; image URL stored on the Werkstatt article

## 2. Data model

### 2.1 `werkstatt_articles`

The physical inventory record.

| column | type | notes |
|---|---|---|
| `id` | int PK | |
| `article_number` | str(32) UNIQUE NOT NULL | auto-generated "SP-0001" |
| `ean` | str(64) NULLABLE | **partial unique** (unique when not null) |
| `item_name` | str(500) NOT NULL | |
| `manufacturer` | str(255) NULLABLE | |
| `category_id` | FK werkstatt_categories NULLABLE | SET NULL on delete |
| `location_id` | FK werkstatt_locations NULLABLE | SET NULL on delete |
| `unit` | str(64) NULLABLE | "Stk", "m", "Paar" |
| `image_url` | str(1000) NULLABLE | populated on-add from catalog or manual upload |
| `image_source` | str(32) NULLABLE | "unielektro" / "manual" / "catalog" |
| `image_checked_at` | datetime NULLABLE | |
| `source_catalog_item_id` | FK material_catalog_items NULLABLE | SET NULL |
| `stock_total` | int NOT NULL default 0 | snapshot; source of truth is movement ledger |
| `stock_available` | int NOT NULL default 0 | computed after each movement |
| `stock_out` | int NOT NULL default 0 | "unterwegs" |
| `stock_repair` | int NOT NULL default 0 | |
| `stock_min` | int NOT NULL default 0 | Mindestbestand |
| `is_serialized` | bool NOT NULL default false | "Einzelexemplare" tracking |
| `bg_inspection_required` | bool NOT NULL default false | |
| `bg_inspection_interval_days` | int NULLABLE | |
| `last_bg_inspected_at` | datetime NULLABLE | |
| `next_bg_due_at` | datetime NULLABLE | |
| `purchase_price_cents` | int NULLABLE | |
| `currency` | str(8) default "EUR" | |
| `notes` | text NULLABLE | |
| `is_archived` | bool NOT NULL default false | |
| `created_at` / `updated_at` / `created_by` | standard | |

**Indexes:** `ean`, `article_number`, `category_id`, `location_id`,
`next_bg_due_at`, `is_archived`.

### 2.2 `werkstatt_suppliers`

| column | type | notes |
|---|---|---|
| `id` | int PK | |
| `name` | str(255) NOT NULL | |
| `short_name` | str(64) NULLABLE | display chip |
| `email` | str(255) NULLABLE | general contact |
| `order_email` | str(255) NULLABLE | where orders are sent |
| `phone` | str(64) NULLABLE | |
| `contact_person` | str(255) NULLABLE | |
| `address_street` / `address_zip` / `address_city` / `address_country` | str | |
| `default_lead_time_days` | int NULLABLE | |
| `notes` | text NULLABLE | |
| `is_archived` | bool NOT NULL default false | |
| `created_at` / `updated_at` / `created_by` | standard | |

### 2.3 `werkstatt_article_suppliers` (M:N with metadata)

| column | type | notes |
|---|---|---|
| `id` | int PK | |
| `article_id` | FK werkstatt_articles NOT NULL | CASCADE delete |
| `supplier_id` | FK werkstatt_suppliers NOT NULL | RESTRICT delete |
| `supplier_article_no` | str(160) NULLABLE | what this supplier calls it |
| `typical_price_cents` | int NULLABLE | |
| `currency` | str(8) default "EUR" | |
| `typical_lead_time_days` | int NULLABLE | overrides supplier default |
| `minimum_order_quantity` | int NOT NULL default 1 | |
| `is_preferred` | bool NOT NULL default false | app-layer: at most one true per article |
| `source_catalog_item_id` | FK material_catalog_items NULLABLE | which Datanorm row this link came from |
| `last_ordered_at` | datetime NULLABLE | denormalised |
| `last_confirmed_lead_time_days` | int NULLABLE | observed from last delivery |
| `notes` | text NULLABLE | |
| `created_at` / `updated_at` | standard | |

**Constraints:**
- `UNIQUE(article_id, supplier_id)` — one link per pair
- `UNIQUE(supplier_id, supplier_article_no)` partial (where `supplier_article_no IS NOT NULL`)

### 2.4 `werkstatt_categories` & `werkstatt_locations`

Self-referential tree nodes. Minimal shape:

```
werkstatt_categories
  id, name, parent_id (FK self NULLABLE), display_order, icon_key, notes,
  is_archived, created_at, updated_at

werkstatt_locations
  id, name, location_type (hall | shelf | vehicle | external),
  parent_id (FK self NULLABLE), address, display_order, notes,
  is_archived, created_at, updated_at
```

### 2.5 `werkstatt_movements`

Append-only ledger of all stock changes. All inventory counters on
`werkstatt_articles` are computed from this table.

| column | type | notes |
|---|---|---|
| `id` | int PK | |
| `article_id` | FK werkstatt_articles NOT NULL | RESTRICT |
| `movement_type` | str(32) enum | `checkout` / `return` / `intake` / `correction` / `repair_out` / `repair_back` |
| `quantity` | int NOT NULL | always positive; direction derived from type |
| `from_location_id` | FK werkstatt_locations NULLABLE | |
| `to_location_id` | FK werkstatt_locations NULLABLE | |
| `project_id` | FK projects NULLABLE | when going to / coming from a project site |
| `user_id` | FK users NOT NULL | who performed the action |
| `assignee_user_id` | FK users NULLABLE | who the item was given to (for checkouts) |
| `expected_return_at` | datetime NULLABLE | |
| `related_order_line_id` | FK werkstatt_order_lines NULLABLE | for intakes from orders |
| `notes` | text NULLABLE | |
| `created_at` | datetime NOT NULL | |

### 2.6 `werkstatt_orders` & `werkstatt_order_lines`

| column (orders) | type | notes |
|---|---|---|
| `id` | int PK | |
| `order_number` | str(32) UNIQUE NOT NULL | "BST-2026-0042" auto-gen |
| `supplier_id` | FK werkstatt_suppliers NOT NULL | RESTRICT |
| `status` | str(32) | `draft` / `sent` / `confirmed` / `partially_delivered` / `delivered` / `cancelled` |
| `total_amount_cents` | int NULLABLE | denormalised |
| `currency` | str(8) default "EUR" | |
| `ordered_at` | datetime NULLABLE | set when status → `sent` |
| `expected_delivery_at` | datetime NULLABLE | set when status → `sent` (from lead time) |
| `delivered_at` | datetime NULLABLE | set when status → `delivered` |
| `delivery_reference` | str(128) NULLABLE | Lieferschein-Nr |
| `notes` | text NULLABLE | |
| `created_by` | FK users | |
| `created_at` / `updated_at` | standard | |

| column (order lines) | type | notes |
|---|---|---|
| `id` | int PK | |
| `order_id` | FK werkstatt_orders NOT NULL | CASCADE delete |
| `article_id` | FK werkstatt_articles NOT NULL | RESTRICT |
| `article_supplier_id` | FK werkstatt_article_suppliers NULLABLE | snapshot at order time |
| `quantity_ordered` | int NOT NULL | |
| `quantity_received` | int NOT NULL default 0 | |
| `unit_price_cents` | int NULLABLE | snapshot |
| `currency` | str(8) default "EUR" | |
| `line_status` | str(32) | `pending` / `partial` / `complete` / `cancelled` |
| `received_at` | datetime NULLABLE | |
| `notes` | text NULLABLE | |
| `created_at` / `updated_at` | standard | |

### 2.7 Extension to existing `material_catalog_items`

Add column:

| column | type | notes |
|---|---|---|
| `supplier_id` | FK werkstatt_suppliers NULLABLE | which supplier's Datanorm this row came from |

Backfill: existing rows get `NULL`. Future Datanorm imports MUST set the column.

## 3. API contract

All Werkstatt endpoints live under `/api/werkstatt/`.

### 3.1 Scan resolution (owned by Mobile BE)

```
GET  /api/werkstatt/scan/resolve?code=<raw>
```

Cascade:
1. `werkstatt_article_units.unit_number == code`      → kind=`machine`
2. `werkstatt_articles.article_number == code`       → kind=`werkstatt_article`
3. `werkstatt_articles.ean == code`                  → kind=`werkstatt_article`
4. `werkstatt_article_suppliers.supplier_article_no == code` → kind=`werkstatt_article`
5. `werkstatt_article_units.serial_number == code`   → kind=`machine`
6. `material_catalog_items.ean == code`              → kind=`catalog_match`
7. `material_catalog_items.article_no == code`       → kind=`catalog_match`
8. Otherwise                                         → kind=`not_found`

Steps 1 and 5 were added with the Maschinen register (2026-08). They bracket
the article steps rather than sitting together:

- **Step 1** is our own `M-<digits>` label, stuck on exactly one physical
  object — nothing more specific exists, so it wins outright. It is gated on
  that shape, so an EAN scan costs no extra query.
- **Step 5** is the manufacturer's nameplate serial: an arbitrary string we did
  not issue and cannot pattern-match. Running it *after* the article steps
  guarantees every article barcode resolves exactly as it did before machines
  existed.

Response shape:
```ts
type ScanResolveResult =
  | { kind: "machine"; machine: Machine; matched_by: "machine_number" | "serial_number" }
  | { kind: "werkstatt_article"; article: WerkstattArticle; matched_by: "sp" | "ean" | "supplier_no" }
  | { kind: "catalog_match"; catalog_items: MaterialCatalogItemLite[]; matched_by: "ean" | "article_no" }
  | { kind: "not_found"; code: string };
```

`machine` carries the full `Machine` including its `components`, so the phone
can warn "the battery and charger go with it" before the user confirms.

**A merged duplicate forwards to its survivor** (2026-09). Every article hit
(steps 2–4) follows `werkstatt_articles.merged_into_id` one hop, so a shelf
label printed for an article that has since been merged keeps resolving — to
the row that now holds the stock. `matched_by` is NOT changed by the hop: it
describes how the *code* matched, and it matched by SP-number whether or not
the row it named has since been folded into another. The chain is one hop from
BOTH ends: `merge_articles` refuses a survivor that is itself merged, and it
re-points every row already pointing at the duplicate onto the new survivor —
so A→B followed by B→C leaves A→C, and A's printed label still reaches the row
that holds the stock rather than an archived, zero-stock one.

#### 3.1a Article lookup — the same question, one step further

```
GET  /api/werkstatt/articles/lookup?code=<raw>&allow_external=true|false
GET  /api/station/werkstatt/lookup?code=<raw>            (station token)
```

`scan/resolve` answers "which of OUR rows is this" and never leaves the
building. `articles/lookup` runs the same cascade and then, only for a code
with a valid GTIN check digit and only when nothing here matched, asks the
public Unielektro webshop (and a configured GTIN database, if one is set up —
`EAN_LOOKUP_PROVIDER`, empty by default). It exists for the create dialog and
for the rack station's Wareneingang, both of which are otherwise dead ends in
front of somebody holding a product nobody has stocked.

```ts
type WerkstattArticleLookup =
  | { kind: "existing"; code: string; article: WerkstattArticle;
      matched_by: "sp"|"internal_code"|"ean"|"supplier_no"|"machine_number"|"serial_number";
      machine_number: string | null; via_merged_article_number: string | null }
  | { kind: "catalog"; code: string; groups: WerkstattCatalogGroup[];
      matched_by: "catalog_ean" | "catalog_article_no" }
  | { kind: "external"; code: string; hit: WerkstattExternalHit }
  | { kind: "none"; code: string;
      external_skipped: "not_a_gtin" | "disabled" | "not_requested" | null };
```

Rules the external step keeps, because a wrong suggestion is worse than none:
a product page is accepted **only** when it states a GTIN of its own and that
GTIN equals the query; every spelling of a barcode (UPC-A ↔ EAN-13) is one
product; hits are cached 30 days and **misses 24 hours** in
`werkstatt_ean_lookups`, so the rack re-scanning an unknown code costs nothing;
and a provider that is slow, down or disabled yields `none` rather than
blocking a save. `external_skipped` separates the two reasons nothing external
ran: `"disabled"` is a setting somebody has to change, `"not_requested"` is the
caller's own `allow_external=false`.

A page is accepted only when the NAME comes from the same evidence as the
GTIN — the JSON-LD `Product` whose gtin matched, or the microdata `Product`
scope the matching `itemprop` sits inside. A search or category listing states
many GTINs and its `og:title` is the query, so a listing is followed for its
links and may never name an article.

```
POST /api/station/werkstatt/articles/from-lookup     (station token)
  body: { code, quantity, item_name?, unit?, notes?, request_id? }
```

`request_id` identifies one booking ATTEMPT and is reused verbatim on its
retries. The station's HTTP timeout and the server's webshop budget are two
different clocks, and booking a delivery is not idempotent: a repeat carrying
the same token replays the first answer (`created:false`, `origin:"existing"`)
instead of booking the pallet twice. Omitted, the endpoint behaves as before.

### 3.2 Quick checkout / return (owned by Mobile BE)

```
POST /api/werkstatt/mobile/checkout
  body: { article_id, quantity, project_id?, assignee_user_id?, expected_return_at?, notes? }

POST /api/werkstatt/mobile/return
  body: { article_id, quantity, condition: "ok"|"repair"|"lost", notes? }

GET  /api/werkstatt/mobile/movements?limit=20
GET  /api/werkstatt/mobile/my-checkouts
```

### 3.3 Core CRUD (owned by Desktop BE)

```
GET    /api/werkstatt/articles                 (search + filter; ?supplier_id= filters to linked articles
                                                AND fills supplier_article_no; ?annotate_supplier_id= fills
                                                supplier_article_no WITHOUT filtering — the order picker)
POST   /api/werkstatt/articles
GET    /api/werkstatt/articles/{id}
PATCH  /api/werkstatt/articles/{id}
DELETE /api/werkstatt/articles/{id}            (soft-archive)
POST   /api/werkstatt/articles/{id}/refresh-image
POST   /api/werkstatt/articles/{id}/link-catalog     { catalog_item_id }
POST   /api/werkstatt/articles/from-catalog          { catalog_item_id, supplier_links[] }

GET/POST/PATCH/DELETE  /api/werkstatt/suppliers
GET/POST/PATCH/DELETE  /api/werkstatt/categories
GET/POST/PATCH/DELETE  /api/werkstatt/locations

POST /api/werkstatt/articles/{id}/suppliers          { supplier_id, supplier_article_no?, ... }
                                                    upsert on (article, supplier): an existing pair gets
                                                    the sent fields written and comes back with 200
PATCH /api/werkstatt/articles/{id}/suppliers/{link_id}
DELETE /api/werkstatt/articles/{id}/suppliers/{link_id}

POST /api/werkstatt/datanorm/upload                 multipart: file + supplier_id → preview
POST /api/werkstatt/datanorm/commit                 { import_token } → apply preview
GET  /api/werkstatt/datanorm/history

GET  /api/werkstatt/bedarfe                         ?status=order,ordered&project_id=&supplier_id=&q=
                                                    &include_completed=&orderable_only=
                                                    `status=` + `include_completed=true` are additive
                                                    (chips AND finished rows); an unknown status or
                                                    supplier value is a 400, never a wider list
                                                    `supplier_id=none` → rows with no catalogue supplier
                                                    (the exact inverse of orderable_only)
                                                    ProjectMaterialNeed + catalogue context per row:
                                                    { supplier_id, supplier_name, catalog_item_name,
                                                      manufacturer, ean, orderable, source,
                                                      werkstatt_order_id, werkstatt_order_number,
                                                      werkstatt_order_line_id, ordered_at }
                                                    `orderable` = has a catalogue match whose supplier is
                                                    known; NOT a statement about a webshop connection
POST /api/werkstatt/bedarfe/bulk                    { ids[≤500], status?, notes? } → updated rows
                                                    403 lists the ids the caller may not see; one activity
                                                    per project, not per row
POST /api/werkstatt/bedarfe/bulk-delete             { ids[≤500] } → { deleted }
POST /api/werkstatt/bedarfe/create-order            (werkstatt:manage)
                                                    { need_ids[], supplier_id?, order_id?, title? }
                                                    → { orders[], added[{need_id, order_id, line_id,
                                                        quantity_warning}], skipped[{need_id, reason,
                                                        order_number}] }
                                                    one DRAFT per supplier — never sent; the pre-send
                                                    resolution gate above still applies
                                                    skip reasons: already_ordered | completed |
                                                    no_catalog_item | no_supplier | other_supplier
                                                    lines are built by services/werkstatt_order_lines.py,
                                                    the same builder the drawer uses
GET  /api/werkstatt/catalog/search                  (search material_catalog_items)

DELETE /api/materials/{id}                          204; an order line it reached is kept (the line is what
                                                    was bought) — the need is only unlinked
PATCH  /api/materials/{id}                          status | notes | item | quantity | unit | article_no |
                                                    material_catalog_item_id
                                                    explicit null: unlinks the catalogue row / clears
                                                    the note; an omitted key keeps what is stored
POST   /api/materials                               + notes (a manual need carries its reason from the
                                                    start rather than in a second PATCH)
```

**Need status ladder** (v2.15): `order` → `ordered` → `on_the_way` → `available` → `completed`.
`ordered` is set by the hand-off above and cleared when that order is cancelled or its line deleted;
marking the order delivered advances its needs to `available`. The rule lives in
`apps/api/app/services/material_needs.py::sync_needs_for_order`, called from the order lifecycle
routers — never duplicated at a call site.

**Merging a draft** is the fourth event on that rule. `POST /orders/{id}/merge` retires the source
without going through `cancel_order`, so the router pairs `capture_merge_links` (before) with
`sync_needs_for_merge` (after): a need whose line was re-parented now points at the target — where
"geliefert" will reach it — and a need whose line was folded into a duplicate goes back to
`order` with its links cleared.

### 3.4 Reorder + Orders (owned by Tablet BE)

```
GET  /api/werkstatt/reorder/suggestions             (articles below stock_min, grouped by preferred supplier)
POST /api/werkstatt/reorder/submit                  { supplier_id, lines[], allow_unresolved? } → creates + sends
                                                    409 unresolved_lines unless allow_unresolved (no row left behind)

GET  /api/werkstatt/orders                          ?status=&supplier_id=
POST /api/werkstatt/orders                          (draft; lines[] = article_id | catalog_item_id | free text)
PATCH /api/werkstatt/orders/{id}                    (notes, delivery_reference)
GET  /api/werkstatt/orders/{id}
POST /api/werkstatt/orders/{id}/mark-sent           → sets ordered_at + expected_delivery_at
POST /api/werkstatt/orders/{id}/mark-delivered      → sets delivered_at, creates intake movements

GET  /api/werkstatt/orders/{id}/resolution          (any user; read-only, no backfill) per line:
                                                    { line_id, position, supplier_article_no, matched_by,
                                                      is_resolved, ean, catalog_item_id, ambiguous_alternatives,
                                                      alternatives[≤5], will_send, warning }
                                                    + identifier, channel, line_count, ready_count, warnings[]
GET  /api/werkstatt/orders/{id}/export              ?format=csv|text|json&allow_unresolved=  (werkstatt:manage)
                                                    csv → text/csv download "BST-2026-0042.csv"; text → ArtNo<TAB>Qty;
                                                    json → { csv, text, filename, warnings, sent_positions,
                                                      dropped_positions, submitted_at }
                                                    409 unresolved_lines unless allow_unresolved; stamps
                                                    submitted_at on a draft only
POST /api/werkstatt/ids/submit                      ?order_id=&allow_unresolved=  → 409 unresolved_lines
                                                    (structured detail: code, message, warnings[],
                                                    unresolved_positions[]) unless allow_unresolved;
                                                    validates submit_field_map at the moment of use

GET  /api/werkstatt/inspections/due                 (BG-Prüfungen coming up)
POST /api/werkstatt/inspections/{article_id}        (record BG-Prüfung)
```

Order-line contract (`OrderLineCreatePayload`, shared by `POST /orders`, `POST /orders/{id}/lines`
and the reorder path via `services/werkstatt_order_lines.build_order_line`):
`article_id` (stocked), `catalog_item_id` (a Datanorm row of the ORDER's supplier — 409 otherwise;
snapshots supplier_article_no/description/manufacturer/ean/unit and links a stocked article by EAN),
or free text (`description` / `supplier_article_no` required). Explicit fields win over snapshots.
`WerkstattOrder.source` accepts `needs` for drafts assembled from material needs.

Supplier columns (migration 20260918_0084, `werkstatt_suppliers`):
- `order_identifier` `supplier_no` (default) | `supplier_no_or_ean` | `ean` | `both` — what every
  outbound cart / export carries per line; decided once in `ids_cart_builder.wire_identity`.
- `order_channel` `ids` | `manual` — informational; the shop button stays gated on an enabled connection.
  Set to `ids` by the 0084 data step for every supplier with an enabled `werkstatt_ids_connections`
  row, and by `PUT /werkstatt/ids/connections` whenever an enabled connection is saved (disabling
  leaves it alone). The hand-over pages `/werkstatt/ids/handoff|hook/{token}` live in
  `workflow_werkstatt_ids_handoff.py`; connection CRUD, `/start`, `/submit` and the manual import
  stay in `workflow_werkstatt_ids.py`.

## 4. Scan input contract (FE, shared across agents)

Every FE agent uses the `useBarcodeScanner` hook from `apps/web/src/hooks/useBarcodeScanner.ts`:

```ts
const { isListening, lastScan, simulateScan } = useBarcodeScanner({
  enabled: true,
  onScan: (code: string) => void,
});
```

Rules:
- HID-keyboard-wedge detection: buffer keystrokes arriving <30ms apart, fire on Enter
- Ignores events when focus is in `<input>`, `<textarea>`, `[contenteditable="true"]`
- When FE wants scan input inside an input field (e.g. the catalog search), it binds the scanner to that field's onChange instead

## 5. File ownership (hard fence)

### Shared — orchestrator-owned (agents: READ ONLY)

- `apps/web/src/types/werkstatt.ts`
- `apps/web/src/types/index.ts` (for MainView additions)
- `apps/web/src/App.tsx` (for routing wiring)
- `apps/web/src/hooks/useBarcodeScanner.ts`
- `apps/api/app/models/werkstatt.py`
- `apps/api/app/models/__init__.py` / `entities.py` (re-export)
- `apps/api/app/schemas/werkstatt.py` (shells — agents append named sections)
- `apps/api/alembic/versions/20260425_0047_werkstatt_core.py`
- `apps/api/app/routers/workflow.py` (aggregator)

Agents that need schema changes beyond the baseline: create a new migration
numbered `0048_tablet_werkstatt_*.py`, `0049_mobile_werkstatt_*.py`, etc.

### Desktop BE

- `apps/api/app/routers/workflow_werkstatt.py` (articles, categories, locations)
- `apps/api/app/routers/workflow_werkstatt_taxonomy.py`
- `apps/api/app/routers/workflow_werkstatt_suppliers.py`
- `apps/api/app/routers/workflow_werkstatt_datanorm.py` (upload + commit)
- `apps/api/app/routers/workflow_werkstatt_bedarfe.py` (read-through to ProjectMaterialNeed)
- `apps/api/app/routers/workflow_werkstatt_catalog.py` (catalog search for Werkstatt context)
- `apps/api/app/services/werkstatt_article_numbers.py` (SP-number generator)
- `apps/api/app/services/werkstatt_datanorm_import.py` (supplier-scoped import)
- `apps/api/tests/test_werkstatt_desktop.py`

### Desktop FE

- `apps/web/src/pages/project/WerkstattInventarTab.tsx` — no, these are top-level pages; put directly under `pages/werkstatt/`:
- `apps/web/src/pages/werkstatt/WerkstattInventarPage.tsx`
- `apps/web/src/pages/werkstatt/WerkstattKategorienPage.tsx`
- `apps/web/src/pages/werkstatt/WerkstattLieferantenPage.tsx`
- `apps/web/src/pages/werkstatt/WerkstattBedarfePage.tsx`
- `apps/web/src/pages/werkstatt/WerkstattKatalogPage.tsx`
- `apps/web/src/pages/werkstatt/WerkstattDatanormImportPage.tsx`
- `apps/web/src/components/werkstatt/NeuerArtikelModal.tsx` (with Katalog tab)
- `apps/web/src/components/werkstatt/EntnehmenModal.tsx`
- `apps/web/src/components/werkstatt/BestandAnpassenModal.tsx`
- `apps/web/src/components/werkstatt/KatalogPicker.tsx` (multi-supplier picker)
- Append to `apps/web/src/styles.css` under `/* ── Werkstatt Desktop ── */`
- Remove "materials" sidebar entry (one line in `components/layout/Sidebar.tsx`)

### Tablet BE

- `apps/api/app/routers/workflow_werkstatt_orders.py`
- `apps/api/app/routers/workflow_werkstatt_reorder.py`
- `apps/api/app/routers/workflow_werkstatt_inspections.py`
- `apps/api/app/services/werkstatt_orders.py` (status transitions, order number gen)
- `apps/api/app/services/werkstatt_reorder.py` (suggestion engine)
- `apps/api/app/services/werkstatt_inspections.py` (BG-Prüfung tracking)
- `apps/api/tests/test_werkstatt_tablet.py`

### Tablet FE

- `apps/web/src/pages/werkstatt/WerkstattOrdersPage.tsx`
- `apps/web/src/components/werkstatt/AvailabilityBadge.tsx` ("Wieder verfügbar ab …")
- Append to `apps/web/src/styles.css` under `/* ── Werkstatt Tablet ── */`
  - Tablet responsive breakpoints (768–1279px) for all Werkstatt pages

### Mobile BE

- `apps/api/app/routers/workflow_werkstatt_mobile.py`
- `apps/api/app/routers/workflow_werkstatt_scan.py`
- `apps/api/app/services/werkstatt_scan.py` (resolution cascade)
- `apps/api/app/services/werkstatt_movements.py` (ledger helpers)
- `apps/api/tests/test_werkstatt_mobile.py`

### Mobile FE

- `apps/web/src/pages/werkstatt/WerkstattMobileHomePage.tsx`
- `apps/web/src/pages/werkstatt/WerkstattMobileScanPage.tsx`
- `apps/web/src/pages/werkstatt/WerkstattMobileArtikelPage.tsx`
- `apps/web/src/pages/werkstatt/WerkstattMobileNachbestellenPage.tsx`
- Append to `apps/web/src/styles.css` under `/* ── Werkstatt Mobile ── */`
- Edit `apps/web/src/components/layout/MobileBottomNav.tsx` (if Werkstatt not already present)

## 6. Conventions

- **TypeScript:** no `any`. Use `unknown` + narrow. All text bilingual via
  `const de = language === "de"` + ternary inline (no i18n library).
- **Python:** `from __future__ import annotations`. Mapped[T] ORM style.
  FastAPI routers follow `apps/api/app/routers/workflow_*.py` patterns.
- **Immutability:** spread operator for state updates. No in-place mutation.
- **File size cap:** <400 lines per file (extract helpers/components if larger).
- **No new dependencies** without asking the orchestrator.
- **Tests:** each BE agent writes at least one happy-path and one error-path
  test per new endpoint.
- **Screenshot gate (FE):** FE agents must run `tsc --noEmit` before finishing.

## 7. Scope caps (what NOT to build this round)

Queued for a follow-up round — do NOT implement:

- Mobile "Lieferung empfangen" flow (delivery receiving)
- Email dispatch on order submit
- Order import from supplier webshop / email parse
- Partial-delivery / cancelled / confirmed-status UX
- Order audit trail page
- Real `@zxing/browser` camera QR library — mobile FE stubs the camera with
  a "paste test code" input; external scanner via `useBarcodeScanner` works fully
- Final deletion of `MaterialsPage.tsx` (keep rendering null; delete later)
- Multi-language Datanorm parsers (stick to the existing parser)

If an agent discovers it needs functionality outside its fence, **stop and flag
it** in the agent's final summary — do not extend shared files or reach into
another agent's fence.

---

## 8. Current state after the 2026-09 program

§§1–7 describe the build round that created this area and its agent fences.
Those fences are history; this section is what the code does **now**
(migration `0088`). Where the two disagree, this section wins.

### 8.1 Articles: consumables vs machines

`is_serialized` is the single marker — a machine is a serialized article with
units. `GET /werkstatt/articles` takes `?kind=consumable|machine` and the lite
row carries `is_serialized`, so the Bestand page can show consumables only
while the Maschinen tab keeps its own list. The create dialog on Bestand never
sends `is_serialized`; new machine types are created from the Maschinen side.

### 8.2 Article lookup cascade

`GET /werkstatt/articles/lookup?code=` and its station twin
`GET /station/werkstatt/lookup` answer `existing | catalog | external | none`:

1. own articles and machine units, through the GTIN variants (UPC-A ↔ EAN-13,
   EAN-8) — stored EANs are never rewritten, only the search fans out;
2. the wholesaler Datanorm catalogue, grouped by EAN;
3. the public Unielektro webshop, but only for a checksum-valid GTIN, and only
   when the scraped product's own GTIN equals the query **and** its name comes
   from the same record as that GTIN. Hits and misses are cached
   (`werkstatt_ean_lookups`), so a scanner cannot hammer the shop.

`none` carries `external_skipped` (`not_a_gtin` | `disabled` | null) because
"that is not a barcode" and "the web search is switched off" are different
instructions to the person standing there.

### 8.3 Duplicates and merge

`GET /werkstatt/articles/duplicates` returns pairs with both sides' facts and a
German reason; `POST …/duplicates/dismiss` (and its `DELETE`) persists and
undoes a "Kein Duplikat". `POST /werkstatt/articles/merge` repoints movements,
order lines, crate items, machine units, inventory counts and task materials,
carries `internal_code` over, sets `merged_into_id` on the duplicate and
archives it. `resolve_scan` follows `merged_into_id`, so **the duplicate's
printed shelf label keeps working** and leads to the survivor. A second merge
forwards the first one's pointer, so the chain never grows past one hop.
Merging is irreversible; the confirm dialog says so.

### 8.4 Orders: which identifier the shop receives

`werkstatt_suppliers.order_identifier` (`supplier_no` default, plus
`supplier_no_or_ean`, `ean`, `both`) decides what a cart or an export carries
per line, and `order_channel` (`ids` | `manual`) decides which hand-over the UI
offers. The policy is resolved once and shared by the IDS cart, the CSV/text
export and the read-only preview, so those three can never disagree.

`GET /werkstatt/orders/{id}/resolution` is that preview and writes nothing.
Every hand-over path — IDS submit, export, and the reorder auto-send — passes
the same gate: a line with no usable identifier answers **409** and does not
stamp `submitted_at`, unless the caller opts in with `allow_unresolved`.

### 8.5 Material needs → order

Needs gained the status `ordered` between `order` and `on_the_way`, plus
`werkstatt_order_id` / `werkstatt_order_line_id` / `ordered_at`.
`POST /werkstatt/bedarfe/create-order` groups the selection by the catalogue
row's supplier, creates **one draft per supplier** through
`services/werkstatt_order_lines.py`, and skips anything without a catalogue
match with a reason the UI shows. A needs-created order is a draft and is never
auto-sent. `services/material_needs.sync_needs_for_order` is the single place
that maps an order event back onto its needs (delivered → `available`,
cancelled or line deleted → `order`), including when a draft is merged into
another.

### 8.6 Construction boxes

`offen → gepackt → zugewiesen → zurueck`, where **`gepackt` is a resting
state**: packed, assigned to a customer, standing in the workshop, contents
still editable, and **no stock moved**. `POST /werkstatt/boxes/{id}/pack`
seals it; the handover (`gepackt → zugewiesen`) is what books the checkout, and
`POST /station/werkstatt/boxes/{id}/handover` lets the wall screen do it.
`gepackt → offen` is "Zuweisung aufheben" and clears the customer.

At task completion `GET /tasks/{id}/material-settlement` previews what is left
and `TaskUpdate.material_remainder` decides where it goes: `shelf`, `same_box`
or `new_box`. The ledger is identical in all three (`correction` for what was
fitted, `return` for the rest) — only the crate differs. A crate that never had
its handover booked gets it retro-booked, and every line is capped at what the
crate actually holds, so two tasks sharing one crate cannot settle it twice.

### 8.7 Station surface

The Pi reports its own LAN address on each heartbeat (the pairing IP is the
router's, because the office hairpins NAT), and the api reaches it only through
`services/station_agent_client.py`: private addresses only, a fixed path
allowlist, short timeouts, capped bodies, and a proof header derived from the
station token for `/restart`. An unknown code at Wareneingang is read first
(`lookup`), then written with a `request_id` so a retry replays instead of
booking twice; when nothing is found the rack asks for a name and unit.

**After a release the Pi must be re-run through `install-pi.sh`** — the service
runs a copy under `/opt/smpl-station`, so pulling the repo changes nothing.
Until then every Scan-Station action answers „Adresse unbekannt".

### 8.8 What §7 said not to build, and what is built now

Built since: order creation from the Orders tab, CSV/clipboard export, the
camera scanner (real `BarcodeDetector` with the documented insecure-context
fallback), and `MaterialsPage.tsx` is now **deleted** — `mainView="materials"`
redirects to Werkstatt › Bedarfe for old deep links. Still not built: e-mail
dispatch on submit, order import from a supplier mailbox, partial-delivery UX,
and an order audit page.
