/**
 * The personal start page (Startseite): shapes shared by the web and the API.
 *
 * The contract is docs/DASHBOARD.md (§2, §11.2). The server owns the catalog
 * and who may see which widget (apps/api/app/services/dashboard_catalog.py);
 * the web holds only UI. The two id lists below mirror the server's `CATALOG`
 * and `SHORTCUT_VIEWS`, in the same order, one string literal per line —
 * apps/api/tests/test_dashboard_catalog_parity.py reads this file with a regex
 * and fails when the two sides drift.
 */

export const DASHBOARD_DEVICES = ["mobile", "tablet", "desktop"] as const;
export type DashboardDevice = (typeof DASHBOARD_DEVICES)[number];

export const DASHBOARD_WIDGET_SIZES = ["small", "medium", "large"] as const;
export type DashboardWidgetSize = (typeof DASHBOARD_WIDGET_SIZES)[number];

/** Catalog order: the order of `available_widgets` and of „Widget hinzufügen“. */
export const DASHBOARD_WIDGET_IDS = [
  "shortcuts",
  "my_status",
  "my_tasks",
  "my_vacation",
  "notifications",
  "planning_today",
  "my_projects",
  "critical_projects",
  "absent_today",
  "werkstatt_kpis",
  "werkstatt_reorder",
  "werkstatt_on_site",
  "werkstatt_my_checkouts",
  "werkstatt_boxes",
  "werkstatt_inspections",
  "recent_panels",
  "recent_reports",
  "vacation_approvals",
  "clocked_in",
  "unread_chats",
] as const;
export type DashboardWidgetId = (typeof DASHBOARD_WIDGET_IDS)[number];

/**
 * The pages a „Schnellzugriff“ tile may open — a closed set, so a stored
 * layout can never point a tile anywhere else. Each is a MainView. The retired
 * `materials` view is deliberately absent.
 */
export const DASHBOARD_SHORTCUT_VIEWS = [
  "my_tasks",
  "planning",
  "calendar",
  "construction",
  "reports",
  "schaltplan",
  "werkstatt",
  "messages",
  "time",
  "wiki",
  "projects_all",
  "projects_map",
  "customers",
  "ausbildung",
] as const;
export type DashboardShortcutView = (typeof DASHBOARD_SHORTCUT_VIEWS)[number];

export const DASHBOARD_MAX_SHORTCUT_VIEWS = 12;

export type DashboardWidgetGroup = "shortcuts" | "personal" | "planning" | "werkstatt" | "office";

/** Only `shortcuts` carries settings, and only its tile list (1–12 views). */
export type DashboardWidgetSettings = { views: DashboardShortcutView[] };

/**
 * One placed widget. `settings` is absent rather than null: the client never
 * sends `settings: null`, and dashboardApi.ts drops a null one from responses.
 */
export type DashboardWidgetItem = {
  id: DashboardWidgetId;
  size: DashboardWidgetSize;
  settings?: DashboardWidgetSettings;
};

/** Where a layout came from: the user's own, an admin's role default, or code. */
export type DashboardLayoutSource = "user" | "role" | "builtin";

export type DashboardLayout = {
  device: DashboardDevice;
  version: 1;
  /** Display order. Already filtered to what the user may see (D6). */
  widgets: DashboardWidgetItem[];
  source: DashboardLayoutSource;
  /** ISO-8601 UTC; null for the built-in default. */
  updated_at: string | null;
  /** True when the user's own layout was saved under a role they no longer have (D22). */
  role_changed: boolean;
};

/** `GET /api/dashboard`. */
export type DashboardState = {
  layouts: Record<DashboardDevice, DashboardLayout>;
  available_widgets: DashboardWidgetId[];
  default_sizes: Record<DashboardWidgetId, DashboardWidgetSize>;
};

/** The body of both layout PUTs. */
export type DashboardLayoutInput = { version: 1; widgets: DashboardWidgetItem[] };

/** Codes of a 422 whose `detail` is an object (§3.1 rules 2–5, plus the size guard). */
export type DashboardErrorCode =
  | "unknown_widget"
  | "duplicate_widget"
  | "settings_not_allowed"
  | "unknown_view"
  | "duplicate_view"
  | "too_large";

export type DashboardErrorDetail = { code: DashboardErrorCode; message: string; ids: string[] };

/**
 * `GET /api/dashboard/absent-today`. Minimised on the server (§4.3): `type`
 * and `label` come from a fixed map, so a sick note or a free-text reason
 * never reaches a start page.
 */
export type AbsenceKind = "vacation" | "school" | "training" | "company_event" | "holiday" | "absent";

export type AbsentToday = {
  date: string;
  absences: { user_id: number; user_name: string; type: AbsenceKind; label: string }[];
};

/** One catalog row as the admin tab sees it. `requires` is an AND of OR-groups. */
export type DashboardCatalogEntry = {
  id: DashboardWidgetId;
  group: DashboardWidgetGroup;
  default_size: DashboardWidgetSize;
  requires: string[][];
};

export type DashboardRoleDefault = {
  role: string;
  device: DashboardDevice;
  widgets: DashboardWidgetItem[];
  source: "role" | "builtin";
  /** Placed widgets this role lacks the permission to see. */
  hidden_for_role: DashboardWidgetId[];
  updated_at: string | null;
};

/** `GET /api/dashboard/role-defaults`: always 15 defaults, role order × device. */
export type DashboardRoleDefaults = {
  catalog: DashboardCatalogEntry[];
  roles: string[];
  defaults: DashboardRoleDefault[];
};
