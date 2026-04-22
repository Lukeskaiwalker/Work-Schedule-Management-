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
1. `werkstatt_articles.article_number == code`       → kind=`werkstatt_article`
2. `werkstatt_articles.ean == code`                  → kind=`werkstatt_article`
3. `werkstatt_article_suppliers.supplier_article_no == code` → kind=`werkstatt_article`
4. `material_catalog_items.ean == code`              → kind=`catalog_match`
5. `material_catalog_items.article_no == code`       → kind=`catalog_match`
6. Otherwise                                         → kind=`not_found`

Response shape:
```ts
type ScanResolveResult =
  | { kind: "werkstatt_article"; article: WerkstattArticle; matched_by: "sp" | "ean" | "supplier_no" }
  | { kind: "catalog_match"; catalog_items: MaterialCatalogItemLite[]; matched_by: "ean" | "article_no" }
  | { kind: "not_found"; code: string };
```

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
GET    /api/werkstatt/articles                 (search + filter)
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
PATCH /api/werkstatt/articles/{id}/suppliers/{link_id}
DELETE /api/werkstatt/articles/{id}/suppliers/{link_id}

POST /api/werkstatt/datanorm/upload                 multipart: file + supplier_id → preview
POST /api/werkstatt/datanorm/commit                 { import_token } → apply preview
GET  /api/werkstatt/datanorm/history

GET  /api/werkstatt/bedarfe                         (read-through to ProjectMaterialNeed)
GET  /api/werkstatt/catalog/search                  (search material_catalog_items)
```

### 3.4 Reorder + Orders (owned by Tablet BE)

```
GET  /api/werkstatt/reorder/suggestions             (articles below stock_min, grouped by preferred supplier)
POST /api/werkstatt/reorder/submit                  { supplier_id, lines[] } → creates werkstatt_orders row

GET  /api/werkstatt/orders                          ?status=&supplier_id=
POST /api/werkstatt/orders                          (draft)
PATCH /api/werkstatt/orders/{id}                    (status transitions)
GET  /api/werkstatt/orders/{id}
POST /api/werkstatt/orders/{id}/mark-sent           → sets ordered_at + expected_delivery_at
POST /api/werkstatt/orders/{id}/mark-delivered      → sets delivered_at, creates intake movements

GET  /api/werkstatt/inspections/due                 (BG-Prüfungen coming up)
POST /api/werkstatt/inspections/{article_id}        (record BG-Prüfung)
```

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
