export type Language = "en" | "de";
export type TaskView = "my" | "all_open" | "completed" | "projects_overview";
export type TaskType = "construction" | "office" | "customer_appointment";

export type AbsenceType = {
  key: string;
  label_de: string;
  label_en: string;
  counts_as_hours: boolean;
};

export type PublicHoliday = {
  date: string; // "YYYY-MM-DD"
  name: string;
};

export const MAP_PIN_FILTERS = [
  "critical",
  "active",
  "planning",
  "on_hold",
  "completed",
  "archived",
] as const;
export type MapPinFilter = (typeof MAP_PIN_FILTERS)[number];

export type UserPreferences = {
  planning_mobile_view?: "single" | "list" | "scroll";
  /** Pin types currently HIDDEN on the Map page. Empty/omitted = all visible.
   *  Stored as a blacklist so new pin types added later are visible by default
   *  for existing users. */
  map_pin_filter_hidden?: MapPinFilter[];
};

export type User = {
  id: number;
  email: string;
  full_name: string;
  nickname?: string | null;
  display_name: string;
  nickname_set_at?: string | null;
  role: "admin" | "ceo" | "accountant" | "planning" | "employee";
  is_active: boolean;
  required_daily_hours: number;
  vacation_days_per_year: number;
  vacation_days_available: number;
  vacation_days_carryover: number;
  vacation_days_total_remaining: number;
  avatar_updated_at?: string | null;
  invite_sent_at?: string | null;
  invite_accepted_at?: string | null;
  password_reset_sent_at?: string | null;
  preferences?: UserPreferences;
  /** Resolved permissions from the server — includes role defaults and per-user overrides. */
  effective_permissions?: string[];
  can_update_recent_own_time_entries?: boolean;
  /** When set, locks the user to a single workspace mode and hides the toggle. */
  workspace_lock?: "construction" | "office" | null;
};

export type Project = {
  id: number;
  project_number: string;
  name: string;
  description?: string;
  status: string;
  last_state?: string | null;
  last_status_at?: string | null;
  last_updated_at?: string | null;
  /**
   * Canonical link to a Customer row. When set, the project's customer
   * details are sourced from `customers` and the legacy `customer_*` free-text
   * columns below are treated as a denormalised snapshot kept for backwards
   * compatibility (old reports, CSV imports, and display fallback).
   */
  customer_id?: number | null;
  customer_name?: string | null;
  customer_address?: string | null;
  construction_site_address?: string | null;
  customer_contact?: string | null;
  customer_email?: string | null;
  customer_phone?: string | null;
  site_access_type?: string | null;
  site_access_note?: string | null;
  extra_attributes?: Record<string, any> | null;
  is_critical?: boolean;
  critical_since?: string | null;
  critical_set_by_user_id?: number | null;
};

// ── Customers (Kunden) ─────────────────────────────────────────────────────
// Canonical shape shared with the backend. Do NOT rename keys; the API agent
// writes against the same schema. When the real API lands, only the fetch
// layer in `utils/customersApi.ts` swaps — consumers stay unchanged.
export type Customer = {
  id: number;
  name: string;
  address: string | null;
  contact_person: string | null;
  email: string | null;
  phone: string | null;
  tax_id: string | null;
  notes: string | null;
  /** ISO calendar date (YYYY-MM-DD) when the customer was born, or null. */
  birthday: string | null;
  /** Marktstammdatenregister "Marktakteur-Nummer" — populated for PV/energy
   *  customers that operate a registered installation. Null otherwise. */
  marktakteur_nummer: string | null;
  /** ISO datetime when the row was archived, or null when active. */
  archived_at: string | null;
  created_by: number | null;
  created_at: string;
  updated_at: string;
};

/**
 * Customer row enriched with project-rollup counts. This is what the list
 * page renders (Projekte column + last-activity column) and what the detail
 * page uses for its right-column project tabs.
 */
export type CustomerListItem = Customer & {
  project_count: number;
  active_project_count: number;
  last_project_activity_at: string | null;
};

// ── Partners (External contractors) ────────────────────────────────────────
// Canonical shape shared with the backend. Do NOT rename keys; the API agent
// writes against the same schema. Partners are external firms (Elektriker,
// Installateur, …) that get assigned to tasks alongside internal employees.
// They are NOT app users and have no login.
export type Partner = {
  id: number;
  name: string;
  contact_person: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  /** Free-text trade label, e.g. "Elektro", "Sanitär", "Maler". Known trades
   *  map to coloured pills (see `components/partners/PartnerTradePill.tsx`);
   *  unknown trades fall back to a neutral slate pill. */
  trade: string | null;
  tax_id: string | null;
  notes: string | null;
  /** ISO datetime when the row was archived, or null when active. */
  archived_at: string | null;
  created_by: number | null;
  created_at: string;
  updated_at: string;
};

/**
 * Partner row enriched with task-rollup counts. This is what the Werkstatt →
 * Partner list page renders (Aktuelle Aufgaben column + last-activity column)
 * and what `PartnerDetailOverlay` uses for its summary strip.
 */
export type PartnerListItem = Partner & {
  task_count: number;
  open_task_count: number;
  last_task_activity_at: string | null;
};

export type ProjectClassTaskTemplate = {
  title: string;
  description?: string | null;
  task_type: string;
  subtasks?: string[];
};

export type ProjectClassTemplate = {
  id: number;
  name: string;
  materials_required?: string | null;
  tools_required?: string | null;
  task_templates: ProjectClassTaskTemplate[];
};

export type ProjectFinance = {
  project_id: number;
  order_value_net?: number | null;
  down_payment_35?: number | null;
  main_components_50?: number | null;
  final_invoice_15?: number | null;
  planned_costs?: number | null;
  actual_costs?: number | null;
  contribution_margin?: number | null;
  reported_hours_total?: number | null;
  planned_hours_total?: number | null;
  updated_by?: number | null;
  updated_at?: string | null;
};

export type ProjectActivity = {
  id: number;
  project_id: number;
  actor_user_id?: number | null;
  actor_name?: string | null;
  event_type: string;
  message: string;
  details?: Record<string, any>;
  created_at: string;
};

export type ProjectOfficeNote = {
  report_id: number;
  report_number?: number | null;
  report_date: string;
  created_at: string;
  office_rework?: string | null;
  office_next_steps?: string | null;
};

export type ProjectOverviewDetails = {
  project: Project;
  open_tasks: number;
  my_open_tasks: number;
  finance: ProjectFinance;
  office_notes: ProjectOfficeNote[];
  recent_changes: ProjectActivity[];
};

export type ProjectWeatherDay = {
  date: string;
  temp_min?: number | null;
  temp_max?: number | null;
  description?: string | null;
  icon?: string | null;
  precipitation_probability?: number | null;
  wind_speed?: number | null;
};

export type ProjectWeather = {
  project_id: number;
  provider: string;
  query_address: string;
  fetched_at?: string | null;
  next_refresh_at?: string | null;
  stale: boolean;
  from_cache: boolean;
  can_refresh: boolean;
  message?: string | null;
  days: ProjectWeatherDay[];
};

export type MaterialNeedStatus = "order" | "on_the_way" | "available" | "completed";

export type ProjectMaterialNeed = {
  id: number;
  project_id: number;
  project_number: string;
  project_name: string;
  customer_name?: string | null;
  construction_report_id?: number | null;
  report_date?: string | null;
  item: string;
  material_catalog_item_id?: number | null;
  article_no?: string | null;
  unit?: string | null;
  quantity?: string | null;
  image_url?: string | null;
  image_source?: string | null;
  notes?: string | null;
  status: MaterialNeedStatus | string;
  created_by?: number | null;
  updated_by?: number | null;
  created_at: string;
  updated_at: string;
};

export type MaterialCatalogItem = {
  id: number;
  external_key?: string | null;
  article_no?: string | null;
  item_name: string;
  unit?: string | null;
  manufacturer?: string | null;
  ean?: string | null;
  price_text?: string | null;
  image_url?: string | null;
  image_source?: string | null;
  image_checked_at?: string | null;
  source_file: string;
  source_line: number;
};

export type MaterialCatalogImportState = {
  file_count: number;
  item_count: number;
  duplicates_skipped: number;
  imported_at?: string | null;
  image_lookup_enabled?: boolean;
  image_lookup_phase?: string | null;
  image_last_run_processed?: number;
  image_total_items?: number;
  image_items_with_image?: number;
  image_items_checked?: number;
  image_items_pending?: number;
  image_items_waiting_fallback?: number;
  image_items_waiting_retry?: number;
  image_items_not_found?: number;
  image_last_checked_at?: string | null;
};

export type ProjectTrackedMaterial = {
  item: string;
  unit?: string | null;
  article_no?: string | null;
  quantity_total?: number | null;
  quantity_notes: string[];
  occurrence_count: number;
  report_count: number;
  last_report_date?: string | null;
};

export type Task = {
  id: number;
  project_id: number;
  title: string;
  description?: string | null;
  subtasks?: string[];
  materials_required?: string | null;
  storage_box_number?: number | null;
  task_type?: string | null;
  class_template_id?: number | null;
  status: string;
  is_overdue?: boolean | null;
  due_date?: string | null;
  start_time?: string | null;
  estimated_hours?: number | null;
  end_time?: string | null;
  assignee_id?: number | null;
  assignee_ids?: number[];
  /** IDs of Partner rows (external firms) assigned to this task. */
  partner_ids?: number[];
  /** Denormalised snapshot of the assigned Partner rows so task lists can
   *  render trade pills and names without a second lookup. Server sends this
   *  alongside `partner_ids`. */
  partners?: Partner[];
  week_start?: string | null;
  updated_at?: string | null;
};

export type TaskOverlap = {
  task_id: number;
  project_id: number;
  title: string;
  due_date?: string | null;
  start_time?: string | null;
  end_time?: string | null;
  estimated_hours?: number | null;
  assignee_ids: number[];
  shared_assignee_ids: number[];
  travel_minutes?: number | null;
  overlap_type?: "time_overlap" | "travel_overlap";
};

export type TaskOverlapConflictDetail = {
  code: "task_overlap";
  message: string;
  overlaps: TaskOverlap[];
};

export type AssignableUser = {
  id: number;
  full_name: string;
  nickname?: string | null;
  display_name: string;
  role: string;
  required_daily_hours: number;
  vacation_days_per_year: number;
  vacation_days_available: number;
  vacation_days_carryover: number;
  avatar_updated_at?: string | null;
};

export type WikiLibraryFile = {
  path: string;
  brand: string;
  folder: string;
  stem: string;
  extension: string;
  file_name: string;
  mime_type: string;
  previewable: boolean;
  size_bytes: number;
  modified_at: string;
};

export type TicketStatus = "open" | "in_review" | "closed";

export type TicketChecklistItem = { label: string; done: boolean };

export type Ticket = {
  id: number;
  title: string;
  site_address: string;
  ticket_date: string;
  status?: TicketStatus;
  assigned_crew?: string[];
  checklist?: TicketChecklistItem[];
  notes?: string;
  attachments_count?: number;
  reference?: string;
};

export type Thread = {
  id: number;
  name: string;
  visibility?: string;
  status?: string;
  is_restricted?: boolean;
  is_archived?: boolean;
  created_by?: number | null;
  project_id?: number | null;
  project_name?: string | null;
  site_id?: number | null;
  icon_updated_at?: string | null;
  participant_user_ids?: number[];
  participant_roles?: string[];
  message_count: number;
  unread_count: number;
  last_message_at?: string | null;
  last_message_preview?: string | null;
  can_edit?: boolean;
};

export type MessageAttachment = {
  id: number;
  file_name: string;
  content_type: string;
  created_at: string;
};

/** One emoji "bucket" on a message, aggregated server-side. */
export type MessageReactionSummary = {
  emoji: string;
  count: number;
  user_ids: number[];
  /** True when the currently authenticated user is in `user_ids`.
   *  Used to highlight the bucket in the reaction strip. */
  me_reacted: boolean;
};

export type Message = {
  id: number;
  body?: string | null;
  sender_id: number;
  created_at: string;
  attachments: MessageAttachment[];
  /** Aggregated per-emoji reactions. Empty list when nobody reacted. */
  reactions?: MessageReactionSummary[];
};

export type ChatRenderRow =
  | {
      kind: "day";
      key: string;
      label: string;
    }
  | {
      kind: "message";
      key: string;
      message: Message;
      mine: boolean;
      showAvatar: boolean;
      showSenderName: boolean;
      timeLabel: string;
    };

export type TimeCurrent = {
  server_time: string;
  clock_entry_id?: number | null;
  clock_in?: string | null;
  break_open: boolean;
  worked_hours_live: number;
  break_hours_live: number;
  required_break_hours_live: number;
  deducted_break_hours_live: number;
  net_hours_live: number;
  required_daily_hours: number;
  daily_net_hours: number;
  progress_percent_live: number;
  vacation_days_per_year: number;
  vacation_days_available: number;
  vacation_days_carryover: number;
  vacation_days_total_remaining: number;
};

export type TimeEntry = {
  id: number;
  user_id: number;
  user_name?: string | null;
  clock_in: string;
  clock_out?: string | null;
  is_open: boolean;
  break_hours: number;
  required_break_hours: number;
  deducted_break_hours: number;
  net_hours: number;
  can_edit: boolean;
};

export type TimesheetSummary = {
  user_id: number;
  total_hours: number;
  period_start: string;
  period_end: string;
};

export type MonthWeekRange = {
  weekStart: string;
  weekEnd: string;
  weekNumber: number;
  weekYear: number;
  weekdaysInWeek: number;
};

export type MonthWeekHours = MonthWeekRange & {
  workedHours: number;
  requiredHours: number;
};

export type PlanningDay = {
  date: string;
  tasks: Task[];
  absences?: PlanningAbsence[];
};

export type PlanningWeek = {
  week_start: string;
  week_end: string;
  days: PlanningDay[];
};

export type PlanningAbsence = {
  type: string;
  user_id: number;
  user_name: string;
  label: string;
  status?: string | null;
};

export type ProjectFolder = {
  path: string;
  is_protected: boolean;
};

export type ProjectFile = {
  id: number;
  project_id: number;
  folder?: string;
  path?: string;
  file_name: string;
  content_type: string;
  created_at: string;
};

export type VacationRequest = {
  id: number;
  user_id: number;
  user_name: string;
  start_date: string;
  end_date: string;
  vacation_days_used: number;
  note?: string | null;
  status: string;
  reviewed_by?: number | null;
  reviewed_at?: string | null;
  created_at: string;
};

export type SchoolAbsence = {
  id: number;
  user_id: number;
  user_name: string;
  title: string;
  absence_type: string;
  counts_as_hours: boolean;
  status: "pending" | "approved" | "rejected";
  start_date: string;
  end_date: string;
  recurrence_weekday?: number | null;
  recurrence_until?: string | null;
  created_by?: number | null;
  reviewed_by?: number | null;
  reviewed_at?: string | null;
  created_at: string;
};

export type InviteDispatchResponse = {
  ok: boolean;
  user_id: number;
  email: string;
  sent: boolean;
  invite_link: string;
  expires_at: string;
  email_error_type?: string | null;
  email_error_detail?: string | null;
};

export type PasswordResetDispatchResponse = {
  ok: boolean;
  user_id: number;
  email: string;
  sent: boolean;
  reset_link: string;
  expires_at: string;
  email_error_type?: string | null;
  email_error_detail?: string | null;
};

export type SmtpTestResult = {
  ok: boolean;
  error_type: string | null;
  error_detail: string | null;
  to_email: string;
};

export type NicknameAvailability = {
  nickname: string;
  available: boolean;
  locked: boolean;
  reason?: string | null;
};

export type WeatherSettings = {
  provider: string;
  configured: boolean;
  masked_api_key: string;
};

export type SmtpSettings = {
  host: string;
  port: number;
  username: string;
  has_password: boolean;
  masked_password: string;
  starttls: boolean;
  ssl: boolean;
  from_email: string;
  from_name: string;
  configured: boolean;
};

export type CompanySettings = {
  logo_url: string;
  navigation_title: string;
  company_name: string;
  company_address: string;
};

export type UpdateStatus = {
  repository: string;
  branch: string;
  current_version?: string | null;
  current_commit?: string | null;
  latest_version?: string | null;
  latest_commit?: string | null;
  latest_published_at?: string | null;
  latest_url?: string | null;
  update_available?: boolean | null;
  install_supported: boolean;
  install_mode: string;
  install_steps: string[];
  message?: string | null;
};

export type UpdateInstallResponse = {
  ok: boolean;
  mode: string;
  detail: string;
  ran_steps: string[];
  dry_run: boolean;
  /** When true, the api delegated the install to the update_runner sidecar.
   *  The actual safe_update.sh run is in flight; poll /admin/updates/progress/{job_id}
   *  to follow it. When false, the sync legacy path ran inline and ran_steps holds
   *  the executed commands. */
  async_mode?: boolean;
  /** Set when async_mode is true. Use with getUpdateProgress() to poll status. */
  job_id?: string | null;
};

/** Progress snapshot for a runner-mediated update job.
 *  Mirrors UpdateProgressOut on the api side. status is one of
 *  "queued" | "running" | "succeeded" | "failed". The latter two are terminal. */
export type UpdateProgress = {
  job_id: string;
  kind: string;
  status: "queued" | "running" | "succeeded" | "failed" | string;
  started_at?: string | null;
  finished_at?: string | null;
  exit_code?: number | null;
  detail?: string | null;
  /** Tail of the runner's stdout+stderr log. May be empty until the job starts running. */
  log_tail?: string | null;
};

/** Single encrypted-archive backup file as returned by GET /admin/backups. */
export type BackupFile = {
  filename: string;
  size_bytes: number;
  /** ISO-8601 mtime — used as a stand-in for "created at" because the upload
   *  flow recreates the file via temp-rename (cleaner than parsing the
   *  filename's embedded timestamp on the client). */
  created_at: string;
  /** True for files produced by scripts/backup.sh (timestamped pattern);
   *  false for operator-uploaded files. UI renders an "Imported" badge for
   *  the latter so the source is obvious. */
  is_generated: boolean;
};

export type BackupListResponse = {
  files: BackupFile[];
  free_bytes: number;
  total_bytes: number;
  /** Echoed from the api so the UI can warn if BACKUP_PASSPHRASE is empty.
   *  Does NOT expose the passphrase itself. */
  passphrase_configured: boolean;
};

/** Progress snapshot for a backup or restore job. Same shape as UpdateProgress
 *  on the wire (the runner uses one Job model for all kinds), but typed as
 *  a separate alias to keep the polling state readable. */
export type BackupJobProgress = UpdateProgress;

export type ReportWorker = {
  name: string;
  start_time: string;
  end_time: string;
};

export type ReportDraft = {
  customer: string;
  customer_address: string;
  customer_contact: string;
  customer_email: string;
  customer_phone: string;
  project_name: string;
  project_number: string;
};

/** Serialised form state stored in localStorage for draft recovery.
 *  v3 introduces a per-draft `id` and moves storage from a single LS slot
 *  to an array (smpl_report_drafts_v3), enabling multiple drafts per user.
 *  The legacy v2 shape is auto-migrated on first read. */
export type StoredReportDraft = {
  v: 3;
  id: string;
  projectId: string;
  draft: ReportDraft;
  workDone: string;
  incidents: string;
  extras: string;
  officeRework: string;
  officeNextSteps: string;
  date: string;
  workers: ReportWorker[];
  materialRows: Pick<ReportMaterialRow, "item" | "qty" | "unit" | "article_no">[];
  officeMaterialRows: Pick<ReportMaterialRow, "item" | "qty" | "unit" | "article_no">[];
  sourceTaskId: number | null;
  savedAt: string;
};

export type ReportMaterialRow = {
  id: string;
  item: string;
  qty: string;
  unit: string;
  article_no: string;
};

export type ConstructionReportCreateResponse = {
  id: number;
  project_id: number | null;
  report_number?: number | null;
  telegram_sent: boolean;
  telegram_mode: string;
  attachment_file_name: string | null;
  report_images: Array<{ id: string; file_name: string; content_type: string }>;
  processing_status: string;
  processing_error?: string | null;
  follow_up_task_id?: number | null;
  follow_up_subtask_count?: number;
};

export type ConstructionReportProcessingResponse = {
  report_id: number;
  project_id: number | null;
  report_number?: number | null;
  processing_status: string;
  processing_error?: string | null;
  processed_at?: string | null;
  telegram_sent: boolean;
  telegram_mode: string;
  attachment_file_name: string | null;
};

export type RecentConstructionReport = {
  id: number;
  project_id: number | null;
  report_number?: number | null;
  user_id?: number | null;
  user_display_name?: string | null;
  project_number?: string | null;
  project_name?: string | null;
  report_date: string;
  created_at: string;
  processing_status: string;
  attachment_file_name?: string | null;
  attachment_id?: number | null;
};

export type ReportImageSelection = {
  key: string;
  file: File;
  preview_url: string;
};

export type TaskReportPrefill = {
  task_id: number;
  report_date: string;
  work_done: string;
  incidents: string;
  materials: string;
  subtasks: string[];
};

export type ReportTaskChecklistItem = {
  id: string;
  label: string;
  done: boolean;
};

export type ProjectFormState = {
  project_number: string;
  name: string;
  description: string;
  status: string;
  last_state: string;
  last_status_at: string;
  /**
   * When non-null, the project is linked to a Customer row. The legacy
   * `customer_*` fields below are kept as a denormalised snapshot so old
   * drafts/reports still render, but the source of truth is this id.
   */
  customer_id: number | null;
  customer_name: string;
  customer_address: string;
  construction_site_address: string;
  customer_contact: string;
  customer_email: string;
  customer_phone: string;
  /**
   * True when the user explicitly wants to use a construction-site address
   * that differs from the customer's stammdaten address. Purely UI state —
   * when false, `construction_site_address` is cleared on submit so the
   * backend treats the customer address as authoritative.
   */
  use_separate_site_address: boolean;
  site_access_type: string;
  site_access_note: string;
  class_template_ids: number[];
};

export type ProjectTaskFormState = {
  title: string;
  description: string;
  subtasks_raw: string;
  materials_required: string;
  has_storage_box: boolean;
  storage_box_number: string;
  task_type: TaskType;
  class_template_id: string;
  due_date: string;
  start_time: string;
  estimated_hours: string;
  assignee_query: string;
  assignee_ids: number[];
};

export type ProjectFinanceFormState = {
  order_value_net: string;
  down_payment_35: string;
  main_components_50: string;
  final_invoice_15: string;
  planned_costs: string;
  actual_costs: string;
  contribution_margin: string;
};

export type TaskPriority = "low" | "normal" | "high" | "urgent";

export type TaskModalState = {
  title: string;
  description: string;
  subtasks_raw: string;
  materials_required: string;
  has_storage_box: boolean;
  storage_box_number: string;
  task_type: TaskType;
  class_template_id: string;
  project_id: string;
  project_query: string;
  due_date: string;
  start_time: string;
  estimated_hours: string;
  priority: TaskPriority;
  assignee_query: string;
  assignee_ids: number[];
  /** IDs of Partner rows (external firms) attached to this task. */
  partner_ids: number[];
  create_project_from_task: boolean;
  new_project_name: string;
  new_project_number: string;
};

export type TaskEditFormState = {
  id: number | null;
  project_id: number | null;
  title: string;
  description: string;
  subtasks_raw: string;
  materials_required: string;
  has_storage_box: boolean;
  storage_box_number: string;
  task_type: TaskType;
  class_template_id: string;
  status: string;
  due_date: string;
  start_time: string;
  estimated_hours: string;
  priority: TaskPriority;
  assignee_query: string;
  assignee_ids: number[];
  /** IDs of Partner rows (external firms) attached to this task. */
  partner_ids: number[];
  week_start: string;
};

export type WorkspaceMode = "construction" | "office";

/**
 * Every MainView value MUST have a corresponding navigation entry point in
 * Sidebar.tsx (sidebar nav items or the user-menu popup). Adding a new view
 * here without wiring it to a nav entry leaves it unreachable — always update
 * Sidebar.tsx in the same commit.
 *
 * Current nav map:
 *   sidebar nav items  → overview, werkstatt, projects_all, projects_archive,
 *                         my_tasks, office_tasks, project, calendar, planning,
 *                         construction, wiki, messages, time
 *   sidebar user menu  → profile, admin
 *
 * Legacy / transitional:
 *   - "materials" is kept for deep-link backwards compatibility. On load,
 *     App.tsx redirects it to mainView="werkstatt" + werkstattTab="bedarfe".
 *     The sidebar no longer surfaces it. Plan to drop entirely once soak.
 *   - "werkstatt_scan" is a fullscreen scanner experience (mobile camera
 *     fallback; external HID scanners stay in-context via useBarcodeScanner).
 */
export type MainView =
  | "overview"
  | "materials"
  | "werkstatt"
  | "werkstatt_scan"
  | "projects_all"
  | "projects_archive"
  | "my_tasks"
  | "office_tasks"
  | "project"
  | "calendar"
  | "planning"
  | "construction"
  | "wiki"
  | "messages"
  | "time"
  | "profile"
  | "admin"
  | "projects_map"
  | "customers"
  | "customer_detail";

/**
 * Sub-tab state for the Werkstatt main view. Analogous to `ProjectTab`.
 * Every value maps to a page component under `pages/werkstatt/*` which
 * self-gates on `{ mainView === "werkstatt" && werkstattTab === "<value>" }`.
 */
export type WerkstattTab =
  | "dashboard"
  | "inventar"
  | "artikel"            // article detail — selected via activeWerkstattArticleId
  | "nachbestellen"
  | "on_site"            // "Auf Baustelle" — all checked-out items grouped by project
  | "bedarfe"            // Projekt-Bedarfe (absorbed from legacy Materials view)
  | "katalog"            // Datanorm pool browse (absorbed from legacy Materials view)
  | "lieferanten"
  | "partner"            // external contractors (Elektro / Sanitär / Maler … subcontractors)
  | "kategorien"         // kategorien & lagerorte (one page, tabbed within)
  | "orders"
  | "datanorm_import";

export type ProjectTab = "overview" | "gantt" | "tasks" | "hours" | "materials" | "tickets" | "files" | "finances";

export type CompactNameParts = {
  first: string;
  lastInitial: string;
};

/** Map of role → sorted list of permission strings (e.g. "time:manage"). */
export type RolePermissionsMap = Record<string, string[]>;

/** Full metadata payload returned by GET /admin/role-permissions */
export type RolePermissionsMeta = {
  permissions: RolePermissionsMap;
  all_permissions: string[];
  permission_labels: Record<string, string>;
  permission_descriptions: Record<string, string>;
  permission_groups: Array<{
    key: string;
    label: string;
    permissions: string[];
  }>;
  all_roles: string[];
};

export type ProjectTitleParts = {
  title: string;
  subtitle: string;
};

export type ThreadModalState = {
  name: string;
  project_id: string;
  participant_user_query: string;
  participant_user_ids: number[];
  participant_role_query: string;
  participant_roles: string[];
};

export type AvatarUploadResponse = {
  ok: boolean;
  avatar_updated_at?: string | null;
};

export type AvatarDeleteResponse = {
  ok: boolean;
  deleted: boolean;
  avatar_updated_at?: string | null;
};

export type AvatarImageSize = {
  width: number;
  height: number;
};

export type AvatarCropOutput = {
  mimeType: string;
  extension: string;
};

export type EmployeeGroupMember = {
  user_id: number;
  full_name: string;
  display_name: string;
  is_active: boolean;
};

export type EmployeeGroup = {
  id: number;
  name: string;
  can_update_recent_own_time_entries: boolean;
  member_user_ids: number[];
  members: EmployeeGroupMember[];
};

export type AuditLogEntry = {
  id: number;
  actor_user_id: number | null;
  category: string;
  action: string;
  target_type: string | null;
  target_id: string | null;
  details: Record<string, unknown> | null;
  created_at: string;
};

export type UserPermissionOverride = {
  user_id: number;
  extra: string[];
  denied: string[];
};
