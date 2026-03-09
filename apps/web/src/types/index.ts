export type Language = "en" | "de";
export type TaskView = "my" | "all_open" | "completed" | "projects_overview";
export type TaskType = "construction" | "office" | "customer_appointment";

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
  avatar_updated_at?: string | null;
  invite_sent_at?: string | null;
  invite_accepted_at?: string | null;
  password_reset_sent_at?: string | null;
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
  customer_name?: string | null;
  customer_address?: string | null;
  construction_site_address?: string | null;
  customer_contact?: string | null;
  customer_email?: string | null;
  customer_phone?: string | null;
  site_access_type?: string | null;
  site_access_note?: string | null;
  extra_attributes?: Record<string, any> | null;
};

export type ProjectClassTaskTemplate = {
  title: string;
  description?: string | null;
  task_type: string;
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
  status: MaterialNeedStatus | string;
  created_by?: number | null;
  updated_by?: number | null;
  created_at: string;
  updated_at: string;
};

export type MaterialCatalogItem = {
  id: number;
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
  assignee_id?: number | null;
  assignee_ids?: number[];
  week_start?: string | null;
  updated_at?: string | null;
};

export type AssignableUser = {
  id: number;
  full_name: string;
  nickname?: string | null;
  display_name: string;
  role: string;
  required_daily_hours: number;
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

export type Ticket = { id: number; title: string; site_address: string; ticket_date: string };

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

export type Message = {
  id: number;
  body?: string | null;
  sender_id: number;
  created_at: string;
  attachments: MessageAttachment[];
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
};

export type TimeEntry = {
  id: number;
  user_id: number;
  clock_in: string;
  clock_out?: string | null;
  is_open: boolean;
  break_hours: number;
  required_break_hours: number;
  deducted_break_hours: number;
  net_hours: number;
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
  type: "vacation" | "school";
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
  start_date: string;
  end_date: string;
  recurrence_weekday?: number | null;
  recurrence_until?: string | null;
  created_by?: number | null;
  created_at: string;
};

export type InviteDispatchResponse = {
  ok: boolean;
  user_id: number;
  email: string;
  sent: boolean;
  invite_link: string;
  expires_at: string;
};

export type PasswordResetDispatchResponse = {
  ok: boolean;
  user_id: number;
  email: string;
  sent: boolean;
  reset_link: string;
  expires_at: string;
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
};

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
  customer_name: string;
  customer_address: string;
  construction_site_address: string;
  customer_contact: string;
  customer_email: string;
  customer_phone: string;
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
  assignee_query: string;
  assignee_ids: number[];
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
  assignee_query: string;
  assignee_ids: number[];
  week_start: string;
};

export type WorkspaceMode = "construction" | "office";

export type MainView =
  | "overview"
  | "materials"
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
  | "admin";

export type ProjectTab = "overview" | "tasks" | "hours" | "materials" | "tickets" | "files" | "finances";

export type CompactNameParts = {
  first: string;
  lastInitial: string;
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
