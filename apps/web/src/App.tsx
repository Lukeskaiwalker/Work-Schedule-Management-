import { ChangeEvent, FormEvent, lazy, MouseEvent, PointerEvent, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppContext } from "./context/AppContext";
import type { AppContextValue } from "./context/AppContext";

import { ApiError, apiFetch, apiUploadWithProgress } from "./api/client";
import type {
  Language,
  TaskView,
  TaskType,
  User,
  Project,
  ProjectClassTemplate,
  ProjectFinance,
  ProjectOverviewDetails,
  ProjectWeather,
  MaterialNeedStatus,
  ProjectMaterialNeed,
  MaterialCatalogItem,
  MaterialCatalogImportState,
  ProjectTrackedMaterial,
  CustomerListItem,
  Partner,
  PartnerListItem,
  Task,
  TaskOverlapConflictDetail,
  AssignableUser,
  WikiLibraryFile,
  Ticket,
  Thread,
  Message,
  ChatRenderRow,
  TimeCurrent,
  TimeEntry,
  TimesheetSummary,
  MonthWeekHours,
  PlanningWeek,
  ProjectFolder,
  ProjectFile,
  VacationRequest,
  SchoolAbsence,
  InviteDispatchResponse,
  PasswordResetDispatchResponse,
  SmtpTestResult,
  NicknameAvailability,
  WeatherSettings,
  SmtpSettings,
  CompanySettings,
  EmployeeGroup,
  AuditLogEntry,
  UpdateStatus,
  UpdateInstallResponse,
  UpdateProgress,
  ReportWorker,
  ReportDraft,
  StoredReportDraft,
  ReportMaterialRow,
  ConstructionReportCreateResponse,
  ConstructionReportProcessingResponse,
  RecentConstructionReport,
  ReportImageSelection,
  TaskReportPrefill,
  ReportTaskChecklistItem,
  ProjectFormState,
  ProjectTaskFormState,
  ProjectFinanceFormState,
  TaskModalState,
  TaskEditFormState,
  WorkspaceMode,
  MainView,
  ProjectTab,
  WerkstattTab,
  ProjectTitleParts,
  ThreadModalState,
  AvatarUploadResponse,
  AvatarDeleteResponse,
  AvatarImageSize,
  RolePermissionsMeta,
  UserPermissionOverride,
  AbsenceType,
  PublicHoliday,
} from "./types";
import {
  MAIN_LABELS,
  TAB_LABELS,
  PROJECT_STATUS_PRESETS,
  DEFAULT_THREAD_PARTICIPANT_ROLES,
  MATERIAL_UNIT_EXAMPLES,
  MATERIAL_CATALOG_SEARCH_LIMIT,
  WORKSPACE_MODE_STORAGE_KEY,
  REPORT_DRAFT_LS_KEY,
  REPORT_DRAFTS_LS_KEY,
  EMPTY_PROJECT_FORM,
  EMPTY_PROJECT_FINANCE_FORM,
  EMPTY_REPORT_DRAFT,
  EMPTY_THREAD_MODAL_FORM,
} from "./constants";
import {
  parseServerDateTime,
  formatServerDateTime,
  chatDayKey,
  formatChatDayLabel,
  formatChatTimeLabel,
  isoToLocalDateTimeInput,
  localDateTimeInputToIso,
  formatDateISOLocal,
  startOfWeekISO,
  addDaysISO,
  normalizeWeekStartISO,
  isoWeekInfo,
  daysInMonth,
  weekdaysBetweenIso,
  isIsoDateWithinRange,
  isoWeekdayMondayFirst,
  formatShortIsoDate,
  monthWeekRanges,
  parseTimestampValue,
} from "./utils/dates";
import {
  initialsFromName,
  compactNameLabel,
  buildCompactUserNameMap,
  preferredDisplayName,
} from "./utils/names";
import {
  parseListLines,
  parseTaskSubtasks,
  sameStringList,
  buildReportTaskChecklist,
  sortTasksByDueTime,
  isValidTimeHHMM,
  normalizeTimeHHMM,
  taskDisplayStatus,
  isTaskOverdue,
  formatTaskStartTime,
  formatTaskTimeRange,
} from "./utils/tasks";
import {
  normalizeMaterialNeedStatus,
} from "./utils/materials";
import {
  normalizeProjectSiteAccessType,
  projectSiteAccessRequiresNote,
  classTemplateMaterialsText,
  projectUpdatedTimestamp,
  isArchivedProjectStatus,
  formatProjectTitle,
  formatProjectTitleParts,
  projectLocationAddress,
  projectPayloadFromForm,
} from "./utils/projects";
import {
  sleep,
  buildClientFileKey,
  createReportMaterialRow,
  parseReportMaterialRows,
  serializeTaskMaterialRows,
  taskMaterialsDisplay,
  serializeOfficeMaterialRows,
  buildEmptyProjectTaskFormState,
  buildTaskModalFormState,
  buildTaskEditFormState,
  taskEditPayloadFromForm,
  reportDraftFromProject,
  sameNumberSet,
} from "./utils/reports";
import {
  projectFinanceToFormState,
  parseNullableDecimalInput,
} from "./utils/finance";
import {
  isLikelyJwtToken,
  readStoredToken,
  readStoredWorkspaceMode,
  detectPublicAuthMode,
  readPublicTokenParam,
} from "./utils/auth";
import { toIcsUtcDateTime, toIcsDate, escapeIcs } from "./utils/ics";
import {
  clamp,
  isImageUploadFile,
  avatarCropOutput,
  loadImage,
  buildAvatarCropDataUrl,
  avatarStageMetrics,
  resolveCurrentReleaseVersion,
  roleOptionLabel,
} from "./utils/misc";
import {
  listCustomers as apiListCustomers,
  saveCustomer as apiSaveCustomer,
  archiveCustomer as apiArchiveCustomer,
  unarchiveCustomer as apiUnarchiveCustomer,
  type CustomerWriteInput,
} from "./utils/customersApi";
import {
  listPartners as apiListPartners,
  savePartner as apiSavePartner,
  archivePartner as apiArchivePartner,
  unarchivePartner as apiUnarchivePartner,
  type PartnerWriteInput,
} from "./utils/partnersApi";
import type {
  CustomerModalDraft,
  CustomerModalOpenOptions,
  PartnerModalDraft,
  PartnerModalOpenOptions,
} from "./context/AppContext";
import { SidebarNavIcon, PenIcon, BackIcon, SearchIcon, CopyIcon } from "./components/icons";
import { WorkHoursGauge, ProjectHoursGauge, WeeklyHoursGauge, MonthlyHoursGauge } from "./components/gauges";
import { ThreadIconBadge, threadInitials } from "./components/shared/ThreadIconBadge";
import type { AppNotification } from "./components/NotificationPanel";
import { Sidebar } from "./components/layout/Sidebar";
import { Header } from "./components/layout/Header";
import { MobileBottomNav } from "./components/layout/MobileBottomNav";
import { ProjectBanner } from "./components/project/ProjectBanner";
import { ProjectModal } from "./components/modals/ProjectModal";
import { TaskModal } from "./components/modals/TaskModal";
import { TaskEditModal } from "./components/modals/TaskEditModal";
import { FileUploadModal } from "./components/modals/FileUploadModal";
import { ThreadModal } from "./components/modals/ThreadModal";
import { ArchivedThreadsModal } from "./components/modals/ArchivedThreadsModal";
import { AvatarModal } from "./components/modals/AvatarModal";
import { CustomerModal } from "./components/modals/CustomerModal";
import { PartnerModal } from "./components/modals/PartnerModal";
import { useServerEvents, type ServerEvent } from "./hooks/useServerEvents";
import { useBrowserNotifications } from "./hooks/useBrowserNotifications";
import type { BrowserNotifPermission } from "./hooks/useBrowserNotifications";

// Pages — loaded on first navigation, never on initial load
const AdminPage = lazy(() => import("./pages/AdminPage").then((m) => ({ default: m.AdminPage })));
const CalendarPage = lazy(() => import("./pages/CalendarPage").then((m) => ({ default: m.CalendarPage })));
const ConstructionPage = lazy(() => import("./pages/ConstructionPage").then((m) => ({ default: m.ConstructionPage })));
const LoginPage = lazy(() => import("./pages/LoginPage").then((m) => ({ default: m.LoginPage })));
const MaterialsPage = lazy(() => import("./pages/MaterialsPage").then((m) => ({ default: m.MaterialsPage })));
const MessagesPage = lazy(() => import("./pages/MessagesPage").then((m) => ({ default: m.MessagesPage })));
const MyTasksPage = lazy(() => import("./pages/MyTasksPage").then((m) => ({ default: m.MyTasksPage })));
const OfficeTasksPage = lazy(() => import("./pages/OfficeTasksPage").then((m) => ({ default: m.OfficeTasksPage })));
const OverviewPage = lazy(() => import("./pages/OverviewPage").then((m) => ({ default: m.OverviewPage })));
const PlanningPage = lazy(() => import("./pages/PlanningPage").then((m) => ({ default: m.PlanningPage })));
const ProfilePage = lazy(() => import("./pages/ProfilePage").then((m) => ({ default: m.ProfilePage })));
const MapPage = lazy(() => import("./pages/MapPage").then((m) => ({ default: m.MapPage })));
const ProjectPage = lazy(() => import("./pages/ProjectPage").then((m) => ({ default: m.ProjectPage })));
const ProjectsAllPage = lazy(() => import("./pages/ProjectsAllPage").then((m) => ({ default: m.ProjectsAllPage })));
const ProjectsArchivePage = lazy(() =>
  import("./pages/ProjectsArchivePage").then((m) => ({ default: m.ProjectsArchivePage }))
);
const TimePage = lazy(() => import("./pages/TimePage").then((m) => ({ default: m.TimePage })));
const WerkstattPage = lazy(() => import("./pages/WerkstattPage").then((m) => ({ default: m.WerkstattPage })));
const WikiPage = lazy(() => import("./pages/WikiPage").then((m) => ({ default: m.WikiPage })));
const CustomersPage = lazy(() => import("./pages/CustomersPage").then((m) => ({ default: m.CustomersPage })));
const CustomerDetailPage = lazy(() =>
  import("./pages/CustomerDetailPage").then((m) => ({ default: m.CustomerDetailPage })),
);

/** Generate a stable id for a report draft. Uses `crypto.randomUUID` when
 *  available, falling back to a timestamp+random composite for older
 *  browsers (still unique enough for localStorage-scoped drafts). */
function generateDraftId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `d-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function App() {
  type ActionLinkDialogState = {
    type: "invite" | "reset";
    link: string;
  } | null;

  const [token, setToken] = useState<string | null>(() => readStoredToken());
  const [language, setLanguage] = useState<Language>("de");
  const [workspaceMode, setWorkspaceMode] = useState<WorkspaceMode>(() => readStoredWorkspaceMode());
  const [now, setNow] = useState<Date>(new Date());

  const [user, setUser] = useState<User | null>(null);
  const [mainView, setMainView] = useState<MainView>("overview");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [overviewShortcutBackVisible, setOverviewShortcutBackVisible] = useState(false);
  const [projectTab, setProjectTab] = useState<ProjectTab>("overview");
  const [werkstattTab, setWerkstattTab] = useState<WerkstattTab>("dashboard");
  const [activeWerkstattArticleId, setActiveWerkstattArticleId] = useState<number | null>(null);
  const [error, setError] = useState<string>("");
  const [notice, setNotice] = useState<string>("");
  const [actionLinkDialog, setActionLinkDialog] = useState<ActionLinkDialogState>(null);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [publicAuthMode, setPublicAuthMode] = useState<"invite" | "reset" | null>(() => detectPublicAuthMode());
  const [publicToken, setPublicToken] = useState(() => readPublicTokenParam());
  const [publicFullName, setPublicFullName] = useState("");
  const [publicEmail, setPublicEmail] = useState("");
  const [publicNewPassword, setPublicNewPassword] = useState("");
  const [publicConfirmPassword, setPublicConfirmPassword] = useState("");

  const [users, setUsers] = useState<User[]>([]);
  const [assignableUsers, setAssignableUsers] = useState<AssignableUser[]>([]);
  const [threadParticipantRoles, setThreadParticipantRoles] = useState<string[]>([
    ...DEFAULT_THREAD_PARTICIPANT_ROLES,
  ]);
  const [projects, setProjects] = useState<Project[]>([]);
  // ── Customers (Kunden) — mock-backed today, backend swap is a one-file ─
  // change to `utils/customersApi.ts`. See the TODO(customers) banner there.
  const [customers, setCustomers] = useState<CustomerListItem[]>([]);
  const [activeCustomerId, setActiveCustomerId] = useState<number | null>(null);
  const [customerModalOpen, setCustomerModalOpen] = useState(false);
  const [customerModalDraft, setCustomerModalDraft] = useState<CustomerModalDraft | null>(null);
  // ── Partners (external contractors) — REAL API backed from day one. ──────
  const [partners, setPartners] = useState<PartnerListItem[]>([]);
  const [partnerModalOpen, setPartnerModalOpen] = useState(false);
  const [partnerModalDraft, setPartnerModalDraft] = useState<PartnerModalDraft | null>(null);
  const [materialNeeds, setMaterialNeeds] = useState<ProjectMaterialNeed[]>([]);
  const [materialNeedUpdating, setMaterialNeedUpdating] = useState<Record<number, boolean>>({});
  const [materialCatalogRows, setMaterialCatalogRows] = useState<MaterialCatalogItem[]>([]);
  const [materialCatalogState, setMaterialCatalogState] = useState<MaterialCatalogImportState | null>(null);
  const [materialCatalogQuery, setMaterialCatalogQuery] = useState("");
  const [materialCatalogLoading, setMaterialCatalogLoading] = useState(false);
  const [materialCatalogProjectId, setMaterialCatalogProjectId] = useState<string>("");
  const [materialCatalogProjectSearch, setMaterialCatalogProjectSearch] = useState("");
  const [materialCatalogProjectSearchFocused, setMaterialCatalogProjectSearchFocused] = useState(false);
  const [materialCatalogAdding, setMaterialCatalogAdding] = useState<Record<number, boolean>>({});
  const [projectTrackedMaterials, setProjectTrackedMaterials] = useState<ProjectTrackedMaterial[]>([]);
  const [projectClassTemplates, setProjectClassTemplates] = useState<ProjectClassTemplate[]>([]);
  const [projectClassTemplatesByProjectId, setProjectClassTemplatesByProjectId] = useState<
    Record<number, ProjectClassTemplate[]>
  >({});
  const [projectSidebarSearchOpen, setProjectSidebarSearchOpen] = useState(false);
  const [projectSidebarSearchQuery, setProjectSidebarSearchQuery] = useState("");
  const [overview, setOverview] = useState<any[]>([]);
  const [overviewStatusFilter, setOverviewStatusFilter] = useState<string>("all");
  const [projectsAllSearch, setProjectsAllSearch] = useState<string>("");
  const [projectsAllStateFilter, setProjectsAllStateFilter] = useState<string>("all");
  const [projectsAllEditedFilter, setProjectsAllEditedFilter] = useState<string>("all");

  const [taskView, setTaskView] = useState<TaskView>("my");
  const [tasks, setTasks] = useState<Task[]>([]);
  const [officeTaskStatusFilter, setOfficeTaskStatusFilter] = useState<string>("all");
  const [officeTaskAssigneeFilter, setOfficeTaskAssigneeFilter] = useState<string>("all");
  const [officeTaskDueDateFilter, setOfficeTaskDueDateFilter] = useState<string>("");
  const [officeTaskNoDueDateFilter, setOfficeTaskNoDueDateFilter] = useState<boolean>(false);
  const [officeTaskProjectFilterQuery, setOfficeTaskProjectFilterQuery] = useState<string>("");
  const [officeTaskProjectFilterIds, setOfficeTaskProjectFilterIds] = useState<number[]>([]);
  const [expandedMyTaskId, setExpandedMyTaskId] = useState<number | null>(null);
  const [myTasksBackProjectId, setMyTasksBackProjectId] = useState<number | null>(null);
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [notifPanelOpen, setNotifPanelOpen] = useState(false);
  const hasTaskNotifications = notifications.some((entry) => entry.read_at === null);
  // Tracks IDs we've already shown a browser notification for — prevents re-alerting
  // on the initial load and on SSE reconnects that re-deliver old notifications.
  const prevNotifIdsRef = useRef<Set<number>>(new Set());

  const {
    permission: browserNotifPermission,
    isIosPwa: browserNotifIsIosPwa,
    requestPermission: requestBrowserNotifPermission,
    showNotification: showBrowserNotification,
  } = useBrowserNotifications();

  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [files, setFiles] = useState<ProjectFile[]>([]);
  const [recentConstructionReports, setRecentConstructionReports] = useState<RecentConstructionReport[]>([]);
  const [projectFolders, setProjectFolders] = useState<ProjectFolder[]>([]);
  const [projectOverviewDetails, setProjectOverviewDetails] = useState<ProjectOverviewDetails | null>(null);
  const [projectOverviewOpenTasks, setProjectOverviewOpenTasks] = useState<Task[]>([]);
  const [projectWeather, setProjectWeather] = useState<ProjectWeather | null>(null);
  const [projectWeatherLoading, setProjectWeatherLoading] = useState(false);
  const [projectFinance, setProjectFinance] = useState<ProjectFinance | null>(null);
  const [projectHoursPlannedInput, setProjectHoursPlannedInput] = useState("");
  const [projectFinanceEditing, setProjectFinanceEditing] = useState(false);
  const [projectFinanceForm, setProjectFinanceForm] = useState<ProjectFinanceFormState>(() => ({
    ...EMPTY_PROJECT_FINANCE_FORM,
  }));
  const [projectNoteEditing, setProjectNoteEditing] = useState(false);
  const [projectNoteDraft, setProjectNoteDraft] = useState("");
  const [fileUploadFolder, setFileUploadFolder] = useState("");
  const [newProjectFolderPath, setNewProjectFolderPath] = useState("");
  const [wikiFiles, setWikiFiles] = useState<WikiLibraryFile[]>([]);
  const [wikiSearch, setWikiSearch] = useState("");
  const [activeWikiPath, setActiveWikiPath] = useState<string | null>(null);

  const [planningWeekStart, setPlanningWeekStart] = useState<string>(() => startOfWeekISO(new Date()));
  const [planningTaskTypeView, setPlanningTaskTypeView] = useState<TaskType | "all">("all");
  const [planningWeek, setPlanningWeek] = useState<PlanningWeek | null>(null);
  const [calendarWeekStart, setCalendarWeekStart] = useState<string>(() => startOfWeekISO(new Date()));
  const [calendarWeeks, setCalendarWeeks] = useState<PlanningWeek[]>([]);
  const [calendarLoading, setCalendarLoading] = useState(false);

  const [threads, setThreads] = useState<Thread[]>([]);
  const [archivedThreads, setArchivedThreads] = useState<Thread[]>([]);
  const [archivedThreadsModalOpen, setArchivedThreadsModalOpen] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [messageBody, setMessageBody] = useState("");
  const [messageAttachment, setMessageAttachment] = useState<File | null>(null);
  const messageAttachmentInputRef = useRef<HTMLInputElement | null>(null);

  const [timeCurrent, setTimeCurrent] = useState<TimeCurrent | null>(null);
  const [timeEntries, setTimeEntries] = useState<TimeEntry[]>([]);
  const [timeMonthRows, setTimeMonthRows] = useState<MonthWeekHours[]>([]);
  const [vacationRequests, setVacationRequests] = useState<VacationRequest[]>([]);
  const [schoolAbsences, setSchoolAbsences] = useState<SchoolAbsence[]>([]);
  const [vacationRequestForm, setVacationRequestForm] = useState({
    start_date: formatDateISOLocal(new Date()),
    end_date: formatDateISOLocal(new Date()),
    note: "",
  });
  const [schoolAbsenceForm, setSchoolAbsenceForm] = useState({
    user_id: "",
    title: "Berufsschule",
    absence_type: "school",
    start_date: formatDateISOLocal(new Date()),
    end_date: formatDateISOLocal(new Date()),
    recurrence_weekdays: [] as number[],
    recurrence_until: "",
  });
  const [editingSchoolAbsenceId, setEditingSchoolAbsenceId] = useState<number | null>(null);
  const [profileSettingsForm, setProfileSettingsForm] = useState({
    full_name: "",
    email: "",
    nickname: "",
    current_password: "",
    new_password: "",
  });
  const [nicknameCheckState, setNicknameCheckState] = useState<"idle" | "checking" | "available" | "unavailable">("idle");
  const [nicknameCheckMessage, setNicknameCheckMessage] = useState("");
  const [inviteCreateForm, setInviteCreateForm] = useState({
    email: "",
    full_name: "",
    role: "employee" as User["role"],
  });
  const [backupExporting, setBackupExporting] = useState(false);
  const [employeeGroups, setEmployeeGroups] = useState<EmployeeGroup[]>([]);
  const [employeeGroupsLoading, setEmployeeGroupsLoading] = useState(false);
  const [auditLogs, setAuditLogs] = useState<AuditLogEntry[]>([]);
  const [auditLogsLoading, setAuditLogsLoading] = useState(false);
  const [rolePermissionsMeta, setRolePermissionsMeta] = useState<RolePermissionsMeta | null>(null);
  const [rolePermissionsLoading, setRolePermissionsLoading] = useState(false);
  const rolePermissionsMetaRef = useRef<RolePermissionsMeta | null>(null);
  const rolePermissionSaveQueuesRef = useRef<Record<string, Promise<void>>>({});
  const [userPermissionOverrides, setUserPermissionOverrides] = useState<Record<number, UserPermissionOverride>>({});
  const [userPermissionsLoading, setUserPermissionsLoading] = useState(false);
  const [weatherSettings, setWeatherSettings] = useState<WeatherSettings | null>(null);
  const [weatherApiKeyInput, setWeatherApiKeyInput] = useState("");
  const [weatherSettingsSaving, setWeatherSettingsSaving] = useState(false);
  const [companySettings, setCompanySettings] = useState<CompanySettings | null>(null);
  const [companySettingsForm, setCompanySettingsForm] = useState({
    logo_url: "",
    navigation_title: "SMPL",
    company_name: "SMPL",
    company_address: "",
  });
  const [companySettingsSaving, setCompanySettingsSaving] = useState(false);
  const [smtpSettings, setSmtpSettings] = useState<SmtpSettings | null>(null);
  const [smtpSettingsForm, setSmtpSettingsForm] = useState({
    host: "",
    port: "587",
    username: "",
    password: "",
    clear_password: false,
    starttls: true,
    ssl: false,
    from_email: "",
    from_name: "",
  });
  const [smtpSettingsSaving, setSmtpSettingsSaving] = useState(false);
  const [smtpTestSending, setSmtpTestSending] = useState(false);
  const [smtpTestLastResult, setSmtpTestLastResult] = useState<SmtpTestResult | null>(null);
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null);
  const [updateStatusLoading, setUpdateStatusLoading] = useState(false);
  const [updateInstallRunning, setUpdateInstallRunning] = useState(false);
  const [updateProgress, setUpdateProgress] = useState<UpdateProgress | null>(null);
  // Holds the active polling timer so we can cancel cleanly on unmount or
  // when the user dismisses a finished job. Lives in a ref instead of state
  // because the timer ID changes don't need to trigger re-renders.
  const updateProgressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [timeMonthCursor, setTimeMonthCursor] = useState<Date>(() => {
    const current = new Date();
    return new Date(current.getFullYear(), current.getMonth(), 1);
  });
  const [timeEntriesStartDate, setTimeEntriesStartDate] = useState<string>(() => {
    const current = new Date();
    return formatDateISOLocal(new Date(current.getFullYear(), current.getMonth(), 1));
  });
  const [timeEntriesEndDate, setTimeEntriesEndDate] = useState<string>(() => {
    const current = new Date();
    return formatDateISOLocal(new Date(current.getFullYear(), current.getMonth() + 1, 0));
  });
  const [timeInfoOpen, setTimeInfoOpen] = useState(false);
  const [timeTargetUserId, setTimeTargetUserId] = useState<string>("");
  const [timeTargetSearch, setTimeTargetSearch] = useState<string>("");
  const [timeTargetDropdownOpen, setTimeTargetDropdownOpen] = useState(false);
  const [absenceTypes, setAbsenceTypes] = useState<AbsenceType[]>([]);
  const [publicHolidays, setPublicHolidays] = useState<PublicHoliday[]>([]);
  const [requiredHoursDrafts, setRequiredHoursDrafts] = useState<Record<number, string>>({});
  const [vacationBalanceDrafts, setVacationBalanceDrafts] = useState<
    Record<number, { perYear: string; available: string; carryover: string }>
  >({});

  const [activeProjectId, setActiveProjectId] = useState<number | null>(null);
  const [highlightedArchivedProjectId, setHighlightedArchivedProjectId] = useState<number | null>(null);
  const [activeThreadId, setActiveThreadId] = useState<number | null>(null);
  const [fileQuery, setFileQuery] = useState("");
  const [projectModalMode, setProjectModalMode] = useState<"create" | "edit" | null>(null);
  const [projectForm, setProjectForm] = useState<ProjectFormState>(EMPTY_PROJECT_FORM);
  const [projectFormBase, setProjectFormBase] = useState<ProjectFormState | null>(null);
  const [projectEditExpectedLastUpdatedAt, setProjectEditExpectedLastUpdatedAt] = useState<string | null>(null);
  const [projectTaskForm, setProjectTaskForm] = useState<ProjectTaskFormState>(() =>
    buildEmptyProjectTaskFormState(),
  );
  const [projectTaskMaterialRows, setProjectTaskMaterialRows] = useState<ReportMaterialRow[]>(() => [
    createReportMaterialRow("materials"),
  ]);
  const [taskModalOpen, setTaskModalOpen] = useState(false);
  const [taskModalForm, setTaskModalForm] = useState<TaskModalState>(() =>
    buildTaskModalFormState({ dueDate: planningWeekStart }),
  );
  const [taskModalOverlapWarning, setTaskModalOverlapWarning] = useState<TaskOverlapConflictDetail | null>(null);
  const [taskModalMaterialRows, setTaskModalMaterialRows] = useState<ReportMaterialRow[]>(() => [
    createReportMaterialRow("materials"),
  ]);
  const [taskEditModalOpen, setTaskEditModalOpen] = useState(false);
  const [taskEditForm, setTaskEditForm] = useState<TaskEditFormState>(() => buildTaskEditFormState());
  const [taskEditOverlapWarning, setTaskEditOverlapWarning] = useState<TaskOverlapConflictDetail | null>(null);
  const [taskEditMaterialRows, setTaskEditMaterialRows] = useState<ReportMaterialRow[]>(() => [
    createReportMaterialRow("materials"),
  ]);
  const [taskEditFormBase, setTaskEditFormBase] = useState<TaskEditFormState | null>(null);
  const [taskEditExpectedUpdatedAt, setTaskEditExpectedUpdatedAt] = useState<string | null>(null);
  const [projectBackView, setProjectBackView] = useState<MainView | null>(null);
  const [reportProjectId, setReportProjectId] = useState<string>("");
  const [reportDraft, setReportDraft] = useState<ReportDraft>(EMPTY_REPORT_DRAFT);
  const [reportTaskPrefill, setReportTaskPrefill] = useState<TaskReportPrefill | null>(null);
  const [reportSourceTaskId, setReportSourceTaskId] = useState<number | null>(null);
  const [reportTaskChecklist, setReportTaskChecklist] = useState<ReportTaskChecklistItem[]>([]);
  const [reportMaterialRows, setReportMaterialRows] = useState<ReportMaterialRow[]>(() => [
    createReportMaterialRow("materials"),
  ]);
  const [reportOfficeMaterialRows, setReportOfficeMaterialRows] = useState<ReportMaterialRow[]>(() => [
    createReportMaterialRow("office_materials"),
  ]);
  const [reportImageFiles, setReportImageFiles] = useState<ReportImageSelection[]>([]);
  const [reportSubmitting, setReportSubmitting] = useState(false);
  const [reportUploadPercent, setReportUploadPercent] = useState<number | null>(null);
  const [reportUploadPhase, setReportUploadPhase] = useState<"uploading" | "processing" | null>(null);
  // Controlled state for previously-uncontrolled report form fields (enables autosave + restore)
  const [reportWorkDone, setReportWorkDone] = useState("");
  const [reportIncidents, setReportIncidents] = useState("");
  const [reportExtras, setReportExtras] = useState("");
  const [reportOfficeRework, setReportOfficeRework] = useState("");
  const [reportOfficeNextSteps, setReportOfficeNextSteps] = useState("");
  const [reportDate, setReportDate] = useState(() => formatDateISOLocal(new Date()));
  // When true, the source task is marked done only after the report is saved successfully.
  const [reportShouldMarkSourceTaskDone, setReportShouldMarkSourceTaskDone] = useState(false);
  // When true, a restore banner is shown on the construction page.
  const [reportDrafts, setReportDrafts] = useState<StoredReportDraft[]>([]);
  const [activeDraftId, setActiveDraftId] = useState<string | null>(null);
  const [constructionBackView, setConstructionBackView] = useState<MainView | null>(null);
  const [fileUploadModalOpen, setFileUploadModalOpen] = useState(false);
  const [avatarModalOpen, setAvatarModalOpen] = useState(false);
  const [avatarSourceUrl, setAvatarSourceUrl] = useState("");
  const [avatarZoom, setAvatarZoom] = useState(1);
  const [avatarOffsetX, setAvatarOffsetX] = useState(0);
  const [avatarOffsetY, setAvatarOffsetY] = useState(0);
  const [avatarNaturalSize, setAvatarNaturalSize] = useState<AvatarImageSize | null>(null);
  const [avatarStageSize, setAvatarStageSize] = useState(260);
  const [avatarIsDragging, setAvatarIsDragging] = useState(false);
  const [avatarPreviewDataUrl, setAvatarPreviewDataUrl] = useState("");
  const [avatarSelectedFile, setAvatarSelectedFile] = useState<File | null>(null);
  const [avatarVersionKey, setAvatarVersionKey] = useState<string>(String(Date.now()));
  const [preUserMenuOpen, setPreUserMenuOpen] = useState(false);
  const [adminUserMenuOpenId, setAdminUserMenuOpenId] = useState<number | null>(null);
  const [threadActionMenuOpen, setThreadActionMenuOpen] = useState(false);
  const avatarObjectUrlRef = useRef<string | null>(null);
  const avatarCropStageRef = useRef<HTMLDivElement | null>(null);
  const preUserMenuRef = useRef<HTMLDivElement | null>(null);
  const timeInfoRef = useRef<HTMLDivElement | null>(null);
  const avatarDragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    startOffsetX: number;
    startOffsetY: number;
  } | null>(null);
  const projectModalBackdropPointerDownRef = useRef(false);
  const taskModalBackdropPointerDownRef = useRef(false);
  const taskEditModalBackdropPointerDownRef = useRef(false);
  const [threadModalMode, setThreadModalMode] = useState<"create" | "edit" | null>(null);
  const [threadModalForm, setThreadModalForm] = useState<ThreadModalState>(EMPTY_THREAD_MODAL_FORM);
  const [threadIconFile, setThreadIconFile] = useState<File | null>(null);
  const [threadIconPreviewUrl, setThreadIconPreviewUrl] = useState<string>("");
  const threadIconObjectUrlRef = useRef<string | null>(null);
  const messageListRef = useRef<HTMLUListElement | null>(null);
  const constructionFormRef = useRef<HTMLFormElement | null>(null);
  const reportImageInputRef = useRef<HTMLInputElement | null>(null);
  const reportImageFilesRef = useRef<ReportImageSelection[]>([]);
  const shouldFollowMessagesRef = useRef(true);
  const forceScrollToBottomRef = useRef(false);
  const materialCatalogRequestSeqRef = useRef(0);
  const materialCatalogQueryRef = useRef(materialCatalogQuery);
  const materialCatalogLookupCacheRef = useRef<Record<string, MaterialCatalogItem | null>>({});

  const [reportWorkers, setReportWorkers] = useState<ReportWorker[]>([{ name: "", start_time: "", end_time: "" }]);

  useEffect(() => {
    reportImageFilesRef.current = reportImageFiles;
  }, [reportImageFiles]);

  useEffect(() => {
    materialCatalogQueryRef.current = materialCatalogQuery;
  }, [materialCatalogQuery]);

  useEffect(() => {
    setSidebarOpen(false);
  }, [mainView]);

  useEffect(() => {
    return () => {
      reportImageFilesRef.current.forEach((entry) => {
        URL.revokeObjectURL(entry.preview_url);
      });
    };
  }, []);

  const effectivePermissions = useMemo(
    () => new Set(user?.effective_permissions ?? []),
    [user?.effective_permissions],
  );
  const isAdmin = user?.role === "admin";
  const canManageUsers = effectivePermissions.has("users:manage");
  const canManagePermissions = effectivePermissions.has("permissions:manage");
  const canManageTimeEntries = effectivePermissions.has("time:manage");
  const canAdjustRequiredHours = canManageTimeEntries;
  const canCreateProject = effectivePermissions.has("projects:manage");
  const canManageTasks = effectivePermissions.has("tasks:manage");
  const isTimeManager = user?.effective_permissions?.some(p => p === "time:view_all" || p === "time:manage") ?? false;
  const canApproveVacation = user?.effective_permissions?.includes("time:approve_vacation") ?? false;
  const canManageSchoolAbsences = user?.effective_permissions?.includes("time:manage_absences") ?? false;
  const canViewAudit = effectivePermissions.has("audit:view");
  const canManageSettings = effectivePermissions.has("settings:manage");
  const canManageSystem = effectivePermissions.has("system:manage");
  const canExportBackups = effectivePermissions.has("backups:export");
  const canManageProjectImport = effectivePermissions.has("projects:import");
  const canMarkCritical = effectivePermissions.has("projects:mark_critical");
  const canUseProtectedFolders = effectivePermissions.has("files:view_protected");
  const canManageFiles = effectivePermissions.has("files:manage");
  const canViewFinance = user?.effective_permissions?.includes("finance:view") ?? false;
  const canManageFinance = user?.effective_permissions?.includes("finance:manage") ?? false;
  const mainLabels = MAIN_LABELS[language];
  const tabLabels = TAB_LABELS[language];
  const workspaceModeLabel =
    workspaceMode === "construction"
      ? language === "de"
        ? "Baustellenansicht"
        : "Construction view"
      : language === "de"
        ? "Büroansicht"
        : "Office view";

  const activeProject = useMemo(
    () => projects.find((project) => project.id === activeProjectId) ?? null,
    [projects, activeProjectId],
  );
  const activeProjectDavRef = useMemo(() => {
    const projectNumber = (activeProject?.project_number ?? "").trim();
    if (projectNumber) return projectNumber;
    if (activeProjectId) return String(activeProjectId);
    return "";
  }, [activeProject?.project_number, activeProjectId]);
  const activeProjectDavUrl = useMemo(() => {
    if (!activeProjectDavRef) return `${window.location.origin}/api/dav/projects/`;
    return `${window.location.origin}/api/dav/projects/${encodeURIComponent(activeProjectDavRef)}/`;
  }, [activeProjectDavRef]);
  const activeProjectHeader = useMemo<ProjectTitleParts>(() => {
    if (!activeProject) return { title: "", subtitle: "" };
    return formatProjectTitleParts(
      activeProject.project_number,
      activeProject.customer_name,
      activeProject.name,
      activeProject.id,
    );
  }, [activeProject]);
  const activeProjectLastState = useMemo(() => {
    if (!activeProject) return "";
    const direct = (activeProject.last_state ?? "").trim();
    if (direct) return direct;
    const fallback = activeProject.extra_attributes?.Notiz;
    return typeof fallback === "string" ? fallback.trim() : "";
  }, [activeProject]);
  const activeProjectLastStatusAtLabel = useMemo(() => {
    const raw = projectOverviewDetails?.project?.last_status_at ?? activeProject?.last_status_at ?? "";
    return formatServerDateTime(raw, language);
  }, [projectOverviewDetails?.project?.last_status_at, activeProject?.last_status_at, language]);
  const activeProjectLastUpdatedLabel = useMemo(() => {
    const raw = projectOverviewDetails?.project?.last_updated_at ?? activeProject?.last_updated_at ?? "";
    return formatServerDateTime(raw, language);
  }, [projectOverviewDetails?.project?.last_updated_at, activeProject?.last_updated_at, language]);
  const activeProjectAddress = useMemo(() => {
    return projectLocationAddress(activeProject);
  }, [activeProject]);
  const activeProjectMapQuery = useMemo(() => {
    if (!activeProjectAddress) return "";
    return activeProjectAddress;
  }, [activeProjectAddress]);
  const activeProjectMapEmbedUrl = useMemo(() => {
    if (!activeProjectMapQuery) return "";
    return `https://maps.google.com/maps?q=${encodeURIComponent(activeProjectMapQuery)}&z=14&output=embed`;
  }, [activeProjectMapQuery]);
  const activeProjectMapOpenUrl = useMemo(() => {
    if (!activeProjectMapQuery) return "";
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(activeProjectMapQuery)}`;
  }, [activeProjectMapQuery]);
  const projectStatusOptions = useMemo(() => {
    const values = new Set(PROJECT_STATUS_PRESETS);
    projects.forEach((project) => {
      const status = String(project.status ?? "").trim();
      if (status) values.add(status);
    });
    return Array.from(values);
  }, [projects]);
  const projectStatusSelectOptions = useMemo(() => {
    const values = new Set(projectStatusOptions);
    const current = projectForm.status.trim();
    if (current) values.add(current);
    return Array.from(values);
  }, [projectStatusOptions, projectForm.status]);
  const overviewStatusOptions = useMemo(() => {
    const values = new Set<string>();
    projects.forEach((project) => {
      const status = String(project.status ?? "").trim();
      if (status) values.add(status);
    });
    overview.forEach((row) => {
      const status = String(row.status ?? "").trim();
      if (status) values.add(status);
    });
    return Array.from(values).sort((a, b) =>
      a.localeCompare(b, language === "de" ? "de-DE" : "en-US", { sensitivity: "base" }),
    );
  }, [projects, overview, language]);
  const projectsById = useMemo(
    () => new Map<number, Project>(projects.map((project) => [project.id, project])),
    [projects],
  );
  const overviewProjectsById = useMemo(() => {
    const map = new Map<
      number,
      { id: number; project_number: string; name: string; status: string; customer_name: string | null }
    >();
    overview.forEach((row) => {
      const projectId = Number(row?.project_id ?? 0);
      if (!projectId || !Number.isFinite(projectId)) return;
      map.set(projectId, {
        id: projectId,
        project_number: String(row?.project_number ?? "").trim(),
        name: String(row?.name ?? "").trim(),
        status: String(row?.status ?? "").trim() || "active",
        customer_name: row?.customer_name == null ? null : String(row.customer_name),
      });
    });
    return map;
  }, [overview]);
  const materialNeedRows = useMemo(
    () =>
      materialNeeds.filter(
        (entry) =>
          projectsById.has(entry.project_id) && normalizeMaterialNeedStatus(entry.status) !== "completed",
      ),
    [materialNeeds, projectsById],
  );
  const activeProjects = useMemo(
    () => projects.filter((project) => !isArchivedProjectStatus(project.status)),
    [projects],
  );
  const materialCatalogProjectOptions = useMemo(
    () =>
      activeProjects
        .slice()
        .sort((a, b) =>
          formatProjectTitle(a.project_number, a.customer_name, a.name, a.id).localeCompare(
            formatProjectTitle(b.project_number, b.customer_name, b.name, b.id),
          ),
        ),
    [activeProjects],
  );
  const selectedMaterialCatalogProject = useMemo(
    () => materialCatalogProjectOptions.find((project) => String(project.id) === materialCatalogProjectId) ?? null,
    [materialCatalogProjectOptions, materialCatalogProjectId],
  );
  const selectedMaterialCatalogProjectLabel = useMemo(
    () => (selectedMaterialCatalogProject ? projectSearchLabel(selectedMaterialCatalogProject) : ""),
    [selectedMaterialCatalogProject],
  );
  const materialCatalogProjectSuggestions = useMemo(() => {
    const query = materialCatalogProjectSearch.trim().toLowerCase();
    if (!query) return [];
    const selectedLabelQuery = selectedMaterialCatalogProjectLabel.trim().toLowerCase();
    if (query === selectedLabelQuery) return [];
    return materialCatalogProjectOptions
      .filter((project) => {
        const searchable = [
          project.project_number,
          project.name,
          project.customer_name ?? "",
          project.customer_address ?? "",
          project.construction_site_address ?? "",
        ]
          .join(" ")
          .toLowerCase();
        return searchable.includes(query);
      })
      .slice(0, 10);
  }, [materialCatalogProjectOptions, materialCatalogProjectSearch, selectedMaterialCatalogProjectLabel]);
  const filteredSidebarProjects = useMemo(() => {
    const query = projectSidebarSearchQuery.trim().toLowerCase();
    const matchesQuery = (project: Project) => {
      const searchable = [
        project.project_number,
        project.name,
        project.customer_name ?? "",
      ]
        .join(" ")
        .toLowerCase();
      return searchable.includes(query);
    };

    if (!query) {
      return activeProjects.map((project) => ({ project, isArchived: false }));
    }

    const archivedMatches = projects
      .filter((project) => isArchivedProjectStatus(project.status))
      .filter((project) => matchesQuery(project))
      .map((project) => ({ project, isArchived: true }));

    const activeMatches = activeProjects
      .filter((project) => matchesQuery(project))
      .map((project) => ({ project, isArchived: false }));

    return [...activeMatches, ...archivedMatches];
  }, [activeProjects, projects, projectSidebarSearchQuery]);
  const archivedProjects = useMemo(
    () => projects.filter((project) => isArchivedProjectStatus(project.status)),
    [projects],
  );
  const detailedOverviewRows = useMemo(() => {
    return overview
      .map((row) => {
        const projectId = Number(row.project_id);
        const project = projectsById.get(projectId);
        const customerName = String(row.customer_name ?? project?.customer_name ?? "").trim() || "-";
        const projectName = String(row.name ?? project?.name ?? "").trim();
        const projectNumber = String(row.project_number ?? project?.project_number ?? row.project_id ?? "-");
        const lastState =
          String(row.last_state ?? project?.last_state ?? project?.extra_attributes?.Notiz ?? "").trim() || "-";
        const lastUpdatedRaw =
          String(row.last_updated_at ?? project?.last_updated_at ?? row.last_status_at ?? project?.last_status_at ?? "").trim() ||
          null;
        const lastUpdatedTimestamp = parseTimestampValue(lastUpdatedRaw);
        const lastStatusRaw =
          String(
            row.last_status_at ??
              project?.last_status_at ??
              project?.extra_attributes?.["Letzter Status Datum"] ??
              "",
          ).trim() || null;
        const lastStatusTimestamp = parseTimestampValue(lastStatusRaw);
        // Derive a single address string (site address if set, else customer
        // address) so search / display helpers can look it up without
        // reaching back into the Project record each time.
        const address = project ? projectLocationAddress(project) : "";
        return {
          ...row,
          project_id: projectId,
          project_name: projectName,
          project_number: projectNumber,
          customer_name: customerName,
          last_state: lastState,
          last_updated_at: lastUpdatedRaw,
          last_updated_timestamp: lastUpdatedTimestamp,
          last_status_at: lastStatusRaw,
          last_status_timestamp: lastStatusTimestamp,
          address,
        };
      })
      .sort((a, b) => {
        const tsDiff = b.last_updated_timestamp - a.last_updated_timestamp;
        if (tsDiff !== 0) return tsDiff;
        return Number(b.project_id || 0) - Number(a.project_id || 0);
      });
  }, [overview, projectsById]);
  const filteredDetailedOverview = useMemo(() => {
    if (overviewStatusFilter === "all") return detailedOverviewRows;
    return detailedOverviewRows.filter((row) => String(row.status ?? "").trim() === overviewStatusFilter);
  }, [detailedOverviewRows, overviewStatusFilter]);
  const filteredProjectsAll = useMemo(() => {
    const needle = projectsAllSearch.trim().toLowerCase();
    const nowTs = now.getTime();
    return detailedOverviewRows.filter((row) => {
      const status = String(row.status ?? "").trim();
      if (projectsAllStateFilter !== "all" && status !== projectsAllStateFilter) return false;
      if (projectsAllEditedFilter !== "all") {
        const ts = Number(row.last_updated_timestamp ?? 0);
        if (projectsAllEditedFilter === "missing") {
          if (ts > 0) return false;
        } else {
          if (ts <= 0) return false;
          const ageDays = (nowTs - ts) / 86_400_000;
          if (projectsAllEditedFilter === "7d" && ageDays > 7) return false;
          if (projectsAllEditedFilter === "30d" && ageDays > 30) return false;
          if (projectsAllEditedFilter === "90d" && ageDays > 90) return false;
          if (projectsAllEditedFilter === "older" && ageDays <= 90) return false;
        }
      }
      if (!needle) return true;
      const searchable = [
        String(row.project_number ?? ""),
        String(row.customer_name ?? ""),
        String(row.project_name ?? ""),
        String(row.last_state ?? ""),
        String(row.address ?? ""),
      ]
        .join(" ")
        .toLowerCase();
      return searchable.includes(needle);
    });
  }, [detailedOverviewRows, projectsAllSearch, projectsAllStateFilter, projectsAllEditedFilter, now]);
  const recentAssignedProjects = useMemo(() => {
    const assignedIds = new Set<number>();
    tasks.forEach((task) => {
      if (task.project_id) assignedIds.add(task.project_id);
    });
    return Array.from(assignedIds)
      .map((projectId) => projectsById.get(projectId))
      .filter((project): project is Project => Boolean(project))
      .sort((a, b) => {
        const delta = (projectUpdatedTimestamp(b) ?? 0) - (projectUpdatedTimestamp(a) ?? 0);
        if (delta !== 0) return delta;
        return b.id - a.id;
      })
      .slice(0, 10);
  }, [projectsById, tasks]);
  const sortedTasks = useMemo(() => sortTasksByDueTime(tasks), [tasks]);
  const overviewActionCards = useMemo(
    () =>
      [
        { view: "construction", label: mainLabels.construction },
        { view: "time", label: mainLabels.time },
        { view: "wiki", label: mainLabels.wiki },
      ] as const,
    [mainLabels],
  );
  const overviewActionCardWidth = useMemo(() => {
    const longestWordLength = overviewActionCards.reduce((maxValue, action) => {
      const longestWord = action.label
        .split(/\s+/)
        .reduce((longest, word) => (word.length > longest.length ? word : longest), "");
      return Math.max(maxValue, longestWord.length);
    }, 10);
    return `${Math.max(12, longestWordLength + 4)}ch`;
  }, [overviewActionCards]);
  const projectTaskAssigneeSuggestions = useMemo(() => {
    const query = projectTaskForm.assignee_query.trim().toLowerCase();
    if (!query) return [];
    return assignableUsers
      .filter((assignee) => !projectTaskForm.assignee_ids.includes(assignee.id))
      .filter(
        (assignee) =>
          assignee.full_name.toLowerCase().includes(query) || String(assignee.id).includes(query),
      )
      .slice(0, 8);
  }, [assignableUsers, projectTaskForm.assignee_ids, projectTaskForm.assignee_query]);
  const taskModalAssigneeSuggestions = useMemo(() => {
    const query = taskModalForm.assignee_query.trim().toLowerCase();
    if (!query) return [];
    return assignableUsers
      .filter((assignee) => !taskModalForm.assignee_ids.includes(assignee.id))
      .filter(
        (assignee) =>
          assignee.full_name.toLowerCase().includes(query) || String(assignee.id).includes(query),
      )
      .slice(0, 8);
  }, [assignableUsers, taskModalForm.assignee_ids, taskModalForm.assignee_query]);
  const taskEditAssigneeSuggestions = useMemo(() => {
    const query = taskEditForm.assignee_query.trim().toLowerCase();
    if (!query) return [];
    return assignableUsers
      .filter((assignee) => !taskEditForm.assignee_ids.includes(assignee.id))
      .filter(
        (assignee) =>
          assignee.full_name.toLowerCase().includes(query) || String(assignee.id).includes(query),
      )
      .slice(0, 8);
  }, [assignableUsers, taskEditForm.assignee_ids, taskEditForm.assignee_query]);
  const threadModalUserSuggestions = useMemo(() => {
    const query = threadModalForm.participant_user_query.trim().toLowerCase();
    if (!query) return [];
    return assignableUsers
      .filter((assignee) => !threadModalForm.participant_user_ids.includes(assignee.id))
      .filter(
        (assignee) =>
          assignee.full_name.toLowerCase().includes(query) || String(assignee.id).includes(query),
      )
      .slice(0, 8);
  }, [assignableUsers, threadModalForm.participant_user_ids, threadModalForm.participant_user_query]);
  const threadModalRoleSuggestions = useMemo(() => {
    const query = threadModalForm.participant_role_query.trim().toLowerCase();
    return threadParticipantRoles
      .filter((role) => !threadModalForm.participant_roles.includes(role))
      .filter((role) => {
        if (!query) return true;
        const label = roleOptionLabel(role, language).toLowerCase();
        return role.toLowerCase().includes(query) || label.includes(query);
      })
      .slice(0, 8);
  }, [threadParticipantRoles, threadModalForm.participant_roles, threadModalForm.participant_role_query, language]);
  const taskModalProjectSuggestions = useMemo(() => {
    const query = taskModalForm.project_query.trim().toLowerCase();
    const selectedId = Number(taskModalForm.project_id);
    // Use activeProjects (archived excluded) so users can't create new tasks
    // on a closed project. `selectedTaskModalProject` still reads from the
    // full `projects` list, so editing a task whose project was archived
    // after the fact keeps showing the existing value — only *new* picks
    // are restricted.
    const rows = activeProjects
      .filter((project) => project.id !== selectedId)
      .filter((project) => {
        if (!query) return true;
        const searchable = [
          project.project_number,
          project.name,
          project.customer_name ?? "",
          project.customer_address ?? "",
          project.construction_site_address ?? "",
        ]
          .join(" ")
          .toLowerCase();
        return searchable.includes(query);
      });
    return rows.slice(0, 8);
  }, [activeProjects, taskModalForm.project_id, taskModalForm.project_query]);
  const selectedTaskModalProject = useMemo(
    () => projects.find((project) => String(project.id) === taskModalForm.project_id) ?? null,
    [projects, taskModalForm.project_id],
  );
  const activeProjectClassTemplates = useMemo(() => {
    if (!activeProjectId) return [];
    return projectClassTemplatesByProjectId[activeProjectId] ?? [];
  }, [activeProjectId, projectClassTemplatesByProjectId]);
  const taskModalProjectClassTemplates = useMemo(() => {
    const projectId = Number(taskModalForm.project_id);
    if (!projectId) return [];
    return projectClassTemplatesByProjectId[projectId] ?? [];
  }, [taskModalForm.project_id, projectClassTemplatesByProjectId]);
  const taskEditProjectClassTemplates = useMemo(() => {
    const projectId = Number(taskEditForm.project_id);
    if (!projectId) return [];
    return projectClassTemplatesByProjectId[projectId] ?? [];
  }, [taskEditForm.project_id, projectClassTemplatesByProjectId]);
  const activeThread = useMemo(
    () => threads.find((thread) => thread.id === activeThreadId) ?? null,
    [threads, activeThreadId],
  );
  const hasUnreadThreads = useMemo(
    () => threads.some((thread) => Number(thread.unread_count ?? 0) > 0),
    [threads],
  );
  const assignableUsersById = useMemo(
    () => new Map(assignableUsers.map((entry) => [entry.id, entry])),
    [assignableUsers],
  );
  const adminUsersById = useMemo(
    () => new Map(users.map((entry) => [entry.id, entry])),
    [users],
  );
  const compactMenuUserNamesById = useMemo(() => {
    const entries: Array<{ id: number; name: string }> = [];
    if (user) {
      entries.push({ id: user.id, name: preferredDisplayName(user) });
    }
    users.forEach((entry) => {
      entries.push({ id: entry.id, name: preferredDisplayName(entry) });
    });
    assignableUsers.forEach((entry) => {
      entries.push({ id: entry.id, name: preferredDisplayName(entry) });
    });
    return buildCompactUserNameMap(entries);
  }, [assignableUsers, user, users]);
  const threadModalSelectedUsers = useMemo(
    () =>
      threadModalForm.participant_user_ids
        .map((id) => {
          const assignable = assignableUsersById.get(id);
          if (assignable) {
            const fallbackLabel = assignable.display_name || assignable.full_name || `#${id}`;
            return {
              id,
              label: compactMenuUserNamesById.get(id) || compactNameLabel(fallbackLabel, false) || `#${id}`,
              archived: false,
            };
          }
          const adminUser = adminUsersById.get(id);
          if (adminUser) {
            const fallbackLabel = adminUser.display_name || adminUser.full_name || `#${id}`;
            return {
              id,
              label: compactMenuUserNamesById.get(id) || compactNameLabel(fallbackLabel, false) || `#${id}`,
              archived: !adminUser.is_active,
            };
          }
          return { id, label: `#${id}`, archived: true };
        }),
    [threadModalForm.participant_user_ids, assignableUsersById, adminUsersById, compactMenuUserNamesById],
  );
  const threadModalIsRestricted =
    threadModalForm.participant_user_ids.length > 0 || threadModalForm.participant_roles.length > 0;
  const activeAdminUsers = useMemo(() => users.filter((entry) => entry.is_active), [users]);
  const archivedAdminUsers = useMemo(() => users.filter((entry) => !entry.is_active), [users]);
  const hasMessageText = messageBody.trim().length > 0;
  const canSendMessage = hasMessageText || Boolean(messageAttachment);
  const chatRenderRows = useMemo<ChatRenderRow[]>(() => {
    const rows: ChatRenderRow[] = [];
    let previousDay = "";
    let previousSender: number | null = null;

    messages.forEach((message, index) => {
      const dayKey = chatDayKey(message.created_at, index);
      if (dayKey !== previousDay) {
        rows.push({
          kind: "day",
          key: `day-${dayKey}-${index}`,
          label: formatChatDayLabel(message.created_at, language),
        });
        previousDay = dayKey;
        previousSender = null;
      }

      const mine = message.sender_id === user?.id;
      const showAvatar = !mine && previousSender !== message.sender_id;
      rows.push({
        kind: "message",
        key: `message-${message.id}`,
        message,
        mine,
        showAvatar,
        showSenderName: showAvatar,
        timeLabel: formatChatTimeLabel(message.created_at),
      });
      previousSender = message.sender_id;
    });

    return rows;
  }, [messages, language, user?.id]);
  const showOverviewBackButton = useMemo(
    () =>
      overviewShortcutBackVisible &&
      (mainView === "construction" || mainView === "time" || mainView === "wiki"),
    [overviewShortcutBackVisible, mainView],
  );
  const selectedReportProject = useMemo(
    () => projects.find((project) => String(project.id) === reportProjectId) ?? null,
    [projects, reportProjectId],
  );
  const planningWeekInfo = useMemo(() => isoWeekInfo(planningWeekStart), [planningWeekStart]);
  const taskStatusOptions = useMemo(() => {
    const values = new Set<string>(["open", "in_progress", "done", "on_hold"]);
    tasks.forEach((task) => {
      const status = String(task.status ?? "").trim();
      if (status) values.add(status);
    });
    const current = taskEditForm.status.trim();
    if (current) values.add(current);
    return Array.from(values);
  }, [tasks, taskEditForm.status]);

  const officeTaskStatusOptions = useMemo(() => {
    const values = new Set<string>();
    values.add("overdue");
    tasks.forEach((task) => {
      const status = String(task.status ?? "").trim();
      if (status) values.add(status);
    });
    return Array.from(values).sort((left, right) => left.localeCompare(right, language === "de" ? "de" : "en"));
  }, [tasks, language]);

  const officeTaskAssigneeOptions = useMemo(() => {
    const ids = new Set<number>();
    tasks.forEach((task) => {
      getTaskAssigneeIds(task).forEach((assigneeId) => ids.add(assigneeId));
    });
    return Array.from(ids)
      .map((assigneeId) => {
        const fallbackName =
          assignableUsersById.get(assigneeId)?.display_name ??
          assignableUsersById.get(assigneeId)?.full_name ??
          adminUsersById.get(assigneeId)?.display_name ??
          adminUsersById.get(assigneeId)?.full_name;
        return {
          id: assigneeId,
          label: menuUserNameById(assigneeId, fallbackName),
        };
      })
      .sort((left, right) => left.label.localeCompare(right.label, language === "de" ? "de" : "en"));
  }, [tasks, assignableUsersById, adminUsersById, compactMenuUserNamesById, language]);

  const officeTaskProjectOptions = useMemo(() => {
    const projectIds = new Set<number>();
    tasks.forEach((task) => {
      if (Number.isFinite(task.project_id) && task.project_id > 0) {
        projectIds.add(task.project_id);
      }
    });
    return Array.from(projectIds)
      .map((projectId) => {
        const directProject = projectsById.get(projectId);
        const overviewProject = overviewProjectsById.get(projectId);
        const label = directProject
          ? projectTitle(directProject)
          : overviewProject
            ? formatProjectTitle(
                overviewProject.project_number,
                overviewProject.customer_name,
                overviewProject.name,
                overviewProject.id,
              )
            : formatProjectTitle("", "", "", projectId);
        return { id: projectId, label };
      })
      .sort((left, right) => left.label.localeCompare(right.label, language === "de" ? "de" : "en"));
  }, [tasks, projectsById, overviewProjectsById, language]);

  const officeTaskSelectedProjectFilters = useMemo(
    () =>
      officeTaskProjectFilterIds.map((projectId) => {
        const option = officeTaskProjectOptions.find((entry) => entry.id === projectId);
        if (option) return option;
        const directProject = projectsById.get(projectId);
        const overviewProject = overviewProjectsById.get(projectId);
        const label = directProject
          ? projectTitle(directProject)
          : overviewProject
            ? formatProjectTitle(
                overviewProject.project_number,
                overviewProject.customer_name,
                overviewProject.name,
                overviewProject.id,
              )
            : formatProjectTitle("", "", "", projectId);
        return { id: projectId, label };
      }),
    [officeTaskProjectFilterIds, officeTaskProjectOptions, projectsById, overviewProjectsById],
  );

  const officeTaskProjectSuggestions = useMemo(() => {
    const query = officeTaskProjectFilterQuery.trim().toLowerCase();
    if (!query) return [];
    return officeTaskProjectOptions
      .filter((entry) => !officeTaskProjectFilterIds.includes(entry.id))
      .filter((entry) => entry.label.toLowerCase().includes(query))
      .slice(0, 8);
  }, [officeTaskProjectOptions, officeTaskProjectFilterIds, officeTaskProjectFilterQuery]);

  const officeFilteredTasks = useMemo(() => {
    const referenceTodayIso = formatDateISOLocal(now);
    const filtered = tasks.filter((task) => {
      if (officeTaskStatusFilter !== "all") {
        if (officeTaskStatusFilter === "overdue") {
          if (!isTaskOverdue(task, referenceTodayIso)) return false;
        } else {
          const taskStatus = String(task.status || "").trim();
          if (taskStatus !== officeTaskStatusFilter) return false;
        }
      }
      if (officeTaskAssigneeFilter !== "all") {
        const assigneeIds = getTaskAssigneeIds(task);
        if (officeTaskAssigneeFilter === "unassigned") {
          if (assigneeIds.length > 0) return false;
        } else {
          const targetAssigneeId = Number(officeTaskAssigneeFilter);
          if (!Number.isFinite(targetAssigneeId) || !assigneeIds.includes(targetAssigneeId)) return false;
        }
      }
      if (officeTaskNoDueDateFilter) {
        if (task.due_date) return false;
      } else if (officeTaskDueDateFilter && String(task.due_date || "") !== officeTaskDueDateFilter) {
        return false;
      }
      if (officeTaskProjectFilterIds.length > 0 && !officeTaskProjectFilterIds.includes(task.project_id)) {
        return false;
      }
      return true;
    });
    return sortTasksByDueTime(filtered);
  }, [
    tasks,
    officeTaskStatusFilter,
    officeTaskAssigneeFilter,
    officeTaskDueDateFilter,
    officeTaskNoDueDateFilter,
    officeTaskProjectFilterIds,
    now,
  ]);

  const navViews = useMemo<MainView[]>(() => {
    // Base nav list; items are filtered below based on the active workspace
    // mode. Construction mode is the site-worker view (personal tasks, field
    // tools) and Office mode is the manager/planner view (portfolio-wide).
    const allViews: MainView[] = [
      "overview",
      "projects_all",
      "projects_map",
      "customers",
      "my_tasks",
      "office_tasks",
      "calendar",
      "planning",
      "construction",
      "materials",
      "werkstatt",
      "wiki",
      "messages",
      "time",
      "profile",
    ];
    return allViews.filter((view) => {
      // Office-only items: manager task triage view and project map.
      if (view === "office_tasks" || view === "projects_map") {
        return workspaceMode === "office";
      }
      // Construction-only item: the personal assigned task list.
      if (view === "my_tasks") {
        return workspaceMode === "construction";
      }
      return true;
    });
  }, [workspaceMode]);

  const projectTabs = useMemo<ProjectTab[]>(() => {
    const tabs: ProjectTab[] = ["overview"];
    if (workspaceMode === "office") tabs.push("gantt");
    tabs.push("tasks", "hours", "materials", "tickets", "files");
    // Finances only visible in office mode — field workers in construction
    // view don't need access to financial data.
    if (canViewFinance && workspaceMode === "office") tabs.push("finances");
    return tabs;
  }, [canViewFinance, workspaceMode]);
  const activeProjectTaskView: TaskView = projectTab === "gantt" ? "projects_overview" : taskView;

  const fileRows = useMemo(
    () =>
      files.filter((file) => {
        if (!fileQuery.trim()) return true;
        const query = fileQuery.trim().toLowerCase();
        return (
          String(file.file_name).toLowerCase().includes(query) ||
          String(file.folder || "").toLowerCase().includes(query) ||
          String(file.path || "").toLowerCase().includes(query)
        );
      }),
    [files, fileQuery],
  );

  const wikiRows = useMemo(() => {
    const query = wikiSearch.trim().toLowerCase();
    const filtered = wikiFiles.filter((entry) => {
      if (!query) return true;
      const haystack = [
        entry.path,
        entry.file_name,
        entry.stem,
        entry.brand,
        entry.folder,
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(query);
    });

    const brands = new Map<
      string,
      {
        name: string;
        folders: Map<
          string,
          {
            path: string;
            name: string;
            docs: Map<string, { key: string; label: string; variants: WikiLibraryFile[] }>;
          }
        >;
      }
    >();

    for (const file of filtered) {
      const brandKey = file.brand.trim() || "-";
      let brand = brands.get(brandKey);
      if (!brand) {
        brand = { name: brandKey, folders: new Map() };
        brands.set(brandKey, brand);
      }

      const folderPath = file.folder.trim();
      let folder = brand.folders.get(folderPath);
      if (!folder) {
        const folderParts = folderPath ? folderPath.split("/") : [];
        folder = {
          path: folderPath,
          name: folderParts.length > 0 ? folderParts[folderParts.length - 1] : language === "de" ? "Hauptordner" : "Root",
          docs: new Map(),
        };
        brand.folders.set(folderPath, folder);
      }

      const docKey = file.stem.toLowerCase();
      let doc = folder.docs.get(docKey);
      if (!doc) {
        doc = { key: docKey, label: file.stem || file.file_name, variants: [] };
        folder.docs.set(docKey, doc);
      }
      doc.variants.push(file);
    }

    return Array.from(brands.values())
      .sort((a, b) => a.name.localeCompare(b.name, language === "de" ? "de-DE" : "en-US"))
      .map((brand) => ({
        name: brand.name,
        folders: Array.from(brand.folders.values())
          .sort((a, b) => a.path.localeCompare(b.path, language === "de" ? "de-DE" : "en-US"))
          .map((folder) => ({
            path: folder.path,
            name: folder.name,
            documents: Array.from(folder.docs.values())
              .sort((a, b) => a.label.localeCompare(b.label, language === "de" ? "de-DE" : "en-US"))
              .map((doc) => ({
                ...doc,
                variants: [...doc.variants].sort((left, right) => {
                  const order = (ext: string) => {
                    if (ext === "html" || ext === "htm") return 0;
                    if (ext === "pdf") return 1;
                    return 2;
                  };
                  const first = order(left.extension);
                  const second = order(right.extension);
                  if (first !== second) return first - second;
                  return left.extension.localeCompare(right.extension, language === "de" ? "de-DE" : "en-US");
                }),
              })),
          })),
      }));
  }, [wikiFiles, wikiSearch, language]);

  const activeWikiFile = useMemo(
    () => wikiFiles.find((entry) => entry.path === activeWikiPath) ?? null,
    [wikiFiles, activeWikiPath],
  );
  const activeProjectTicketDate = useMemo(() => {
    if (!activeProject?.last_status_at) return formatDateISOLocal(new Date());
    const parsed = parseServerDateTime(activeProject.last_status_at);
    if (!parsed) return formatDateISOLocal(new Date());
    return formatDateISOLocal(parsed);
  }, [activeProject?.last_status_at]);
  const activeProjectTicketAddress = useMemo(() => {
    const address = projectLocationAddress(activeProject);
    if (address) return address;
    const fallback = [(activeProject?.customer_name ?? "").trim(), (activeProject?.name ?? "").trim()]
      .filter((part) => part.length > 0)
      .join(", ");
    return fallback || "-";
  }, [activeProject]);
  const projectReportedHoursTotal = useMemo(() => {
    const raw = projectOverviewDetails?.finance?.reported_hours_total ?? projectFinance?.reported_hours_total ?? 0;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? Math.max(parsed, 0) : 0;
  }, [projectOverviewDetails?.finance?.reported_hours_total, projectFinance?.reported_hours_total]);
  const projectPlannedHoursTotal = useMemo(() => {
    const raw = projectFinance?.planned_hours_total ?? projectOverviewDetails?.finance?.planned_hours_total;
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  }, [projectFinance?.planned_hours_total, projectOverviewDetails?.finance?.planned_hours_total]);
  const projectHoursUsagePercent = useMemo(() => {
    if (projectPlannedHoursTotal <= 0) return 0;
    return (projectReportedHoursTotal / projectPlannedHoursTotal) * 100;
  }, [projectPlannedHoursTotal, projectReportedHoursTotal]);
  const userInitials = useMemo(
    () => initialsFromName(user?.display_name ?? user?.full_name ?? "", "U"),
    [user?.display_name, user?.full_name],
  );
  const todayIso = useMemo(() => formatDateISOLocal(now), [now]);
  const calendarRangeLabel = useMemo(() => {
    const firstDayIso = calendarWeeks[0]?.week_start ?? calendarWeekStart;
    const lastDayIso = calendarWeeks[calendarWeeks.length - 1]?.week_end ?? addDaysISO(calendarWeekStart, 27);
    const locale = language === "de" ? "de-DE" : "en-US";
    const firstDate = new Date(`${firstDayIso}T00:00:00`);
    const lastDate = new Date(`${lastDayIso}T00:00:00`);
    if (Number.isNaN(firstDate.getTime()) || Number.isNaN(lastDate.getTime())) {
      return `${firstDayIso} - ${lastDayIso}`;
    }
    return `${firstDate.toLocaleDateString(locale, { day: "2-digit", month: "2-digit" })} - ${lastDate.toLocaleDateString(locale, { day: "2-digit", month: "2-digit" })}`;
  }, [calendarWeekStart, calendarWeeks, language]);
  const timeTargetUser = useMemo(
    () => assignableUsers.find((entry) => String(entry.id) === timeTargetUserId) ?? null,
    [assignableUsers, timeTargetUserId],
  );
  const requiredDailyHours = timeCurrent?.required_daily_hours ?? user?.required_daily_hours ?? 8;
  const dailyNetHours = timeCurrent?.daily_net_hours ?? 0;
  const gaugeNetHours = dailyNetHours;
  const monthWeekDefs = useMemo(
    () => monthWeekRanges(timeMonthCursor),
    [timeMonthCursor.getFullYear(), timeMonthCursor.getMonth()],
  );
  // Always-current refs so setInterval callbacks never use stale values
  const monthWeekDefsRef = useRef(monthWeekDefs);
  useEffect(() => { monthWeekDefsRef.current = monthWeekDefs; });

  const monthCursorISO = `${timeMonthCursor.getFullYear()}-${String(timeMonthCursor.getMonth() + 1).padStart(2, "0")}`;
  const monthCursorISORef = useRef(monthCursorISO);
  useEffect(() => { monthCursorISORef.current = monthCursorISO; });

  const monthCursorLabel = useMemo(
    () =>
      timeMonthCursor.toLocaleDateString(language === "de" ? "de-DE" : "en-US", {
        month: "long",
        year: "numeric",
      }),
    [timeMonthCursor, language],
  );
  // Fetched directly from the monthly timesheet endpoint so the total reflects
  // only the calendar month (Feb 1-28), not full weeks that bleed into adjacent months.
  const [monthlyWorkedHours, setMonthlyWorkedHours] = useState<number>(0);
  const monthlyRequiredHours = useMemo(() => {
    const required = requiredDailyHours > 0 ? requiredDailyHours : 8;
    const monthStart = new Date(timeMonthCursor.getFullYear(), timeMonthCursor.getMonth(), 1, 12, 0, 0, 0);
    const monthEnd = new Date(
      timeMonthCursor.getFullYear(),
      timeMonthCursor.getMonth(),
      daysInMonth(timeMonthCursor.getFullYear(), timeMonthCursor.getMonth()),
      12,
      0,
      0,
      0,
    );
    const weekdays = weekdaysBetweenIso(formatDateISOLocal(monthStart), formatDateISOLocal(monthEnd));
    return Number((weekdays * required).toFixed(2));
  }, [requiredDailyHours, timeMonthCursor]);
  const viewingOwnTime = !isTimeManager || !timeTargetUserId || Number(timeTargetUserId) === user?.id;
  const pendingVacationRequests = useMemo(
    () => vacationRequests.filter((row) => row.status === "pending"),
    [vacationRequests],
  );
  const approvedVacationRequests = useMemo(
    () => vacationRequests.filter((row) => row.status === "approved"),
    [vacationRequests],
  );
  const approvedVacationRequestsByUserId = useMemo(() => {
    const map = new Map<number, VacationRequest[]>();
    approvedVacationRequests.forEach((row) => {
      const current = map.get(row.user_id) ?? [];
      current.push(row);
      map.set(row.user_id, current);
    });
    return map;
  }, [approvedVacationRequests]);
  const schoolAbsencesByUserId = useMemo(() => {
    const map = new Map<number, SchoolAbsence[]>();
    schoolAbsences
      .filter((row) => row.status === "approved")
      .forEach((row) => {
      const current = map.get(row.user_id) ?? [];
      current.push(row);
      map.set(row.user_id, current);
      });
    return map;
  }, [schoolAbsences]);
  function assigneeAvailabilityHint(userId: number, referenceIsoDate?: string | null) {
    const targetDate = String(referenceIsoDate ?? "").trim() || todayIso;
    const vacationRows = approvedVacationRequestsByUserId.get(userId) ?? [];
    for (const row of vacationRows) {
      const startIso = row.start_date || "";
      const endIso = row.end_date || row.start_date || "";
      if (!isIsoDateWithinRange(targetDate, startIso, endIso)) continue;
      const startLabel = formatShortIsoDate(startIso, language);
      const endLabel = formatShortIsoDate(endIso, language);
      return language === "de"
        ? `Abwesend von ${startLabel} bis ${endLabel} (Urlaub)`
        : `Absent from ${startLabel} until ${endLabel} (Vacation)`;
    }
    const schoolRows = schoolAbsencesByUserId.get(userId) ?? [];
    for (const row of schoolRows) {
      const startIso = row.start_date || "";
      const endIso = row.recurrence_until || row.end_date || row.start_date || "";
      if (!isIsoDateWithinRange(targetDate, startIso, endIso)) continue;
      if (
        row.recurrence_weekday !== null &&
        row.recurrence_weekday !== undefined &&
        row.recurrence_weekday !== isoWeekdayMondayFirst(targetDate)
      ) {
        continue;
      }
      const startLabel = formatShortIsoDate(startIso, language);
      const endLabel = formatShortIsoDate(endIso, language);
      const typeInfo = absenceTypes.find((entry) => entry.key === row.absence_type);
      const typeLabel = typeInfo ? (language === "de" ? typeInfo.label_de : typeInfo.label_en) : row.absence_type;
      return language === "de"
        ? `Abwesend von ${startLabel} bis ${endLabel} (${typeLabel})`
        : `Absent from ${startLabel} until ${endLabel} (${typeLabel})`;
    }
    return "";
  }
  const sidebarNowLabel = useMemo(
    () =>
      now.toLocaleString(language === "de" ? "de-DE" : "en-US", {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      }),
    [language, now],
  );
  const avatarStageState = useMemo(
    () => avatarStageMetrics(avatarNaturalSize, avatarStageSize, avatarZoom, avatarOffsetX, avatarOffsetY),
    [avatarNaturalSize, avatarStageSize, avatarZoom, avatarOffsetX, avatarOffsetY],
  );
  const firmwareBuild = useMemo(() => {
    const build = String(import.meta.env.VITE_APP_BUILD ?? "").trim();
    if (build) return build;
    const mode = String(import.meta.env.MODE ?? "").trim();
    return mode ? `local-${mode}` : "local";
  }, []);
  const resolvedCurrentReleaseVersion = useMemo(
    () => resolveCurrentReleaseVersion(updateStatus),
    [updateStatus],
  );
  const currentReleaseLabel = useMemo(() => {
    const currentCommit = String(updateStatus?.current_commit || "").trim();
    const normalizedBuild = firmwareBuild.toLowerCase().startsWith("local-") ? "" : firmwareBuild;
    const statusMessage = String(updateStatus?.message || "").toLowerCase();
    const missingMetadata =
      statusMessage.includes("current release version is unresolved")
      || statusMessage.includes("release metadata");
    return (
      resolvedCurrentReleaseVersion ||
      currentCommit ||
      normalizedBuild ||
      (missingMetadata ? (language === "de" ? "Metadaten fehlen" : "Metadata missing") : "") ||
      (language === "de" ? "nicht gesetzt" : "not set")
    );
  }, [firmwareBuild, language, resolvedCurrentReleaseVersion, updateStatus?.current_commit, updateStatus?.message]);

  useEffect(() => {
    if (assignableUsers.length === 0) return;
    setRequiredHoursDrafts((current) => {
      const next: Record<number, string> = { ...current };
      assignableUsers.forEach((entry) => {
        if (next[entry.id] === undefined) {
          next[entry.id] = String(entry.required_daily_hours ?? 8);
        }
      });
      return next;
    });
  }, [assignableUsers]);

  useEffect(() => {
    if (users.length === 0) return;
    setVacationBalanceDrafts((current) => {
      const next = { ...current };
      users.forEach((entry) => {
        if (next[entry.id] === undefined) {
          next[entry.id] = {
            perYear: String(entry.vacation_days_per_year ?? 0),
            available: String(entry.vacation_days_available ?? 0),
            carryover: String(entry.vacation_days_carryover ?? 0),
          };
        }
      });
      return next;
    });
  }, [users]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(""), 5000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    if (overviewStatusFilter === "all") return;
    if (overviewStatusOptions.includes(overviewStatusFilter)) return;
    setOverviewStatusFilter("all");
  }, [overviewStatusFilter, overviewStatusOptions]);

  useEffect(() => {
    if (projectsAllStateFilter === "all") return;
    if (overviewStatusOptions.includes(projectsAllStateFilter)) return;
    setProjectsAllStateFilter("all");
  }, [projectsAllStateFilter, overviewStatusOptions]);

  useEffect(() => {
    if (!preUserMenuOpen) return;
    const onPointerOutside = (event: MouseEvent | TouchEvent) => {
      const target = event.target as Node | null;
      if (!target || !preUserMenuRef.current) return;
      if (!preUserMenuRef.current.contains(target)) setPreUserMenuOpen(false);
    };
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPreUserMenuOpen(false);
    };
    document.addEventListener("mousedown", onPointerOutside as EventListener);
    document.addEventListener("touchstart", onPointerOutside as EventListener);
    document.addEventListener("keydown", onEscape);
    return () => {
      document.removeEventListener("mousedown", onPointerOutside as EventListener);
      document.removeEventListener("touchstart", onPointerOutside as EventListener);
      document.removeEventListener("keydown", onEscape);
    };
  }, [preUserMenuOpen]);

  useEffect(() => {
    if (!timeInfoOpen) return;
    const onPointerOutside = (event: MouseEvent | TouchEvent) => {
      const target = event.target as Node | null;
      if (!target || !timeInfoRef.current) return;
      if (!timeInfoRef.current.contains(target)) setTimeInfoOpen(false);
    };
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setTimeInfoOpen(false);
    };
    document.addEventListener("mousedown", onPointerOutside as EventListener);
    document.addEventListener("touchstart", onPointerOutside as EventListener);
    document.addEventListener("keydown", onEscape);
    return () => {
      document.removeEventListener("mousedown", onPointerOutside as EventListener);
      document.removeEventListener("touchstart", onPointerOutside as EventListener);
      document.removeEventListener("keydown", onEscape);
    };
  }, [timeInfoOpen]);

  useEffect(() => {
    if (adminUserMenuOpenId === null) return;
    const onPointerOutside = (event: MouseEvent | TouchEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (target.closest(".admin-actions-menu-wrap")) return;
      setAdminUserMenuOpenId(null);
    };
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setAdminUserMenuOpenId(null);
    };
    document.addEventListener("mousedown", onPointerOutside as EventListener);
    document.addEventListener("touchstart", onPointerOutside as EventListener);
    document.addEventListener("keydown", onEscape);
    return () => {
      document.removeEventListener("mousedown", onPointerOutside as EventListener);
      document.removeEventListener("touchstart", onPointerOutside as EventListener);
      document.removeEventListener("keydown", onEscape);
    };
  }, [adminUserMenuOpenId]);

  useEffect(() => {
    if (!threadActionMenuOpen) return;
    const onPointerOutside = (event: MouseEvent | TouchEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      // Allow clicks inside the menu wrapper (new class) OR the legacy wrapper.
      if (target.closest(".messages-page-chat-menu")) return;
      if (target.closest(".thread-actions-menu-wrap")) return;
      setThreadActionMenuOpen(false);
    };
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setThreadActionMenuOpen(false);
    };
    document.addEventListener("mousedown", onPointerOutside as EventListener);
    document.addEventListener("touchstart", onPointerOutside as EventListener);
    document.addEventListener("keydown", onEscape);
    return () => {
      document.removeEventListener("mousedown", onPointerOutside as EventListener);
      document.removeEventListener("touchstart", onPointerOutside as EventListener);
      document.removeEventListener("keydown", onEscape);
    };
  }, [threadActionMenuOpen]);

  // Cancel any in-flight update-progress poll when App unmounts. Without this,
  // the chained setTimeout could fire after teardown and call setState on an
  // unmounted tree (React would warn, and we'd leak a request per tab close).
  useEffect(() => {
    return () => {
      if (updateProgressTimerRef.current !== null) {
        clearTimeout(updateProgressTimerRef.current);
        updateProgressTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!threadActionMenuOpen) return;
    if (!activeThread || !activeThread.can_edit || mainView !== "messages") {
      setThreadActionMenuOpen(false);
    }
  }, [threadActionMenuOpen, activeThread, mainView]);

  useEffect(() => {
    if (mainView !== "time" && timeInfoOpen) setTimeInfoOpen(false);
  }, [mainView, timeInfoOpen]);

  useEffect(() => {
    if (user?.avatar_updated_at) setAvatarVersionKey(user.avatar_updated_at);
  }, [user?.id, user?.avatar_updated_at]);

  useEffect(() => {
    if (!user) return;
    setProfileSettingsForm({
      full_name: user.full_name ?? "",
      email: user.email ?? "",
      nickname: user.nickname ?? "",
      current_password: "",
      new_password: "",
    });
    setNicknameCheckState("idle");
    setNicknameCheckMessage("");
  }, [user?.id, user?.full_name, user?.email, user?.nickname]);

  useEffect(() => {
    rolePermissionsMetaRef.current = rolePermissionsMeta;
  }, [rolePermissionsMeta]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(WORKSPACE_MODE_STORAGE_KEY, workspaceMode);
    } catch {
      // ignore localStorage failures (private mode / browser settings)
    }
  }, [workspaceMode]);

  // Enforce workspace_lock: if the user has a lock set, always force that mode.
  useEffect(() => {
    const lock = user?.workspace_lock;
    if (lock === "construction" || lock === "office") {
      setWorkspaceMode(lock);
    }
  }, [user?.workspace_lock]);  // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (workspaceMode === "office" && mainView === "my_tasks") {
      setMainView("office_tasks");
      return;
    }
    if (workspaceMode === "construction" && mainView === "office_tasks") {
      setMainView("my_tasks");
    }
  }, [workspaceMode, mainView]);

  useEffect(() => {
    if (workspaceMode !== "office" && (projectTab === "gantt" || projectTab === "finances")) {
      setProjectTab("overview");
    }
  }, [workspaceMode, projectTab]);

  /**
   * Legacy-alias redirect: the top-level "Materials" view was absorbed into
   * Werkstatt as sub-tabs (Projekt-Bedarfe + Katalog). Deep links and old
   * localStorage state can still set mainView="materials"; route them to
   * the Werkstatt bedarfe tab instead of showing the retired page.
   * See WERKSTATT_CONTRACT.md §1 for the absorption plan.
   */
  useEffect(() => {
    if (mainView === "materials") {
      setWerkstattTab("bedarfe");
      setMainView("werkstatt");
    }
  }, [mainView]);

  useEffect(() => {
    void loadPublicCompanySettings();
  }, []);

  useEffect(() => {
    return () => {
      if (avatarObjectUrlRef.current) {
        URL.revokeObjectURL(avatarObjectUrlRef.current);
      }
      if (threadIconObjectUrlRef.current) {
        URL.revokeObjectURL(threadIconObjectUrlRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!avatarSourceUrl) {
      setAvatarPreviewDataUrl("");
      return;
    }
    let canceled = false;
    const output = avatarCropOutput(avatarSelectedFile);
    buildAvatarCropDataUrl(avatarSourceUrl, avatarZoom, avatarOffsetX, avatarOffsetY, 320, output.mimeType)
      .then((dataUrl) => {
        if (!canceled) setAvatarPreviewDataUrl(dataUrl);
      })
      .catch(() => {
        if (!canceled) setAvatarPreviewDataUrl("");
      });
    return () => {
      canceled = true;
    };
  }, [avatarSourceUrl, avatarZoom, avatarOffsetX, avatarOffsetY, avatarSelectedFile]);

  useEffect(() => {
    if (!avatarSourceUrl) {
      setAvatarNaturalSize(null);
      return;
    }
    let canceled = false;
    loadImage(avatarSourceUrl)
      .then((img) => {
        if (canceled) return;
        setAvatarNaturalSize({
          width: img.naturalWidth || img.width,
          height: img.naturalHeight || img.height,
        });
      })
      .catch(() => {
        if (!canceled) setAvatarNaturalSize(null);
      });
    return () => {
      canceled = true;
    };
  }, [avatarSourceUrl]);

  useEffect(() => {
    if (!avatarModalOpen || !avatarSourceUrl) return;
    const node = avatarCropStageRef.current;
    if (!node) return;
    const syncSize = () => setAvatarStageSize(node.clientWidth || 260);
    syncSize();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(syncSize);
    observer.observe(node);
    return () => observer.disconnect();
  }, [avatarModalOpen, avatarSourceUrl]);

  useEffect(() => {
    if (!token) {
      setUser(null);
      return;
    }
    apiFetch<User>("/auth/me", token)
      .then((u) => setUser(u))
      .catch(() => {
        setToken(null);
        localStorage.removeItem("smpl_token");
      });
  }, [token]);

  useEffect(() => {
    if (!token || !user) return;
    void loadBaseData();
    void loadNotifications();
  }, [token, user]);

  useEffect(() => {
    if (token && user) return;
    setNotifications([]);
    setNotifPanelOpen(false);
  }, [token, user]);

  useEffect(() => {
    if (!token || !user) return;
    if (mainView !== "project") return;
    if (!activeProjectId) return;

    // Guard: redirect away from finances tab if user lost permission
    if (projectTab === "finances" && !canViewFinance) {
      setProjectTab("overview");
      return;
    }

    if (projectTab === "overview") void loadProjectOverview(activeProjectId);
    if (projectTab === "tasks" || projectTab === "gantt") void loadTasks(activeProjectTaskView, activeProjectId);
    if (projectTab === "tickets") void loadSitesAndTickets(activeProjectId);
    if (projectTab === "files") {
      void loadFiles(activeProjectId);
      void loadProjectFolders(activeProjectId);
    }
    if (projectTab === "finances" || projectTab === "hours") void loadProjectFinance(activeProjectId);
    if (projectTab === "materials") void loadProjectTrackedMaterials(activeProjectId);
  }, [mainView, projectTab, activeProjectId, token, user, activeProjectTaskView, canViewFinance]);

  useEffect(() => {
    if (!token || !user) return;
    if (mainView !== "project") return;
    if (!activeProjectId) return;
    void loadProjectWeather(activeProjectId, true);
  }, [token, user, mainView, activeProjectId, language]);

  async function refreshCurrentUser() {
    if (!token) return null;
    const currentUser = await apiFetch<User>("/auth/me", token);
    setUser(currentUser);
    return currentUser;
  }

  useEffect(() => {
    if (!token || !user) return;
    if (mainView !== "planning") return;
    void loadPlanningWeek(null, planningWeekStart, planningTaskTypeView === "all" ? null : planningTaskTypeView);
  }, [mainView, token, user, planningWeekStart, planningTaskTypeView]);

  useEffect(() => {
    if (!token || !user) return;
    if (mainView !== "materials") return;
    void loadMaterialNeeds();
  }, [mainView, token, user]);

  useEffect(() => {
    const hasSelectedProject = materialCatalogProjectOptions.some(
      (project) => String(project.id) === materialCatalogProjectId,
    );
    if (hasSelectedProject) return;
    if (activeProjectId && materialCatalogProjectOptions.some((project) => project.id === activeProjectId)) {
      setMaterialCatalogProjectId(String(activeProjectId));
      return;
    }
    if (materialCatalogProjectOptions.length > 0) {
      setMaterialCatalogProjectId(String(materialCatalogProjectOptions[0].id));
      return;
    }
    if (materialCatalogProjectId) setMaterialCatalogProjectId("");
  }, [materialCatalogProjectId, materialCatalogProjectOptions, activeProjectId]);

  useEffect(() => {
    if (materialCatalogProjectSearchFocused) return;
    setMaterialCatalogProjectSearch(selectedMaterialCatalogProjectLabel);
  }, [selectedMaterialCatalogProjectLabel, materialCatalogProjectSearchFocused]);

  useEffect(() => {
    if (!token || !user) return;
    if (mainView !== "materials") return;
    const timeout = window.setTimeout(() => {
      void loadMaterialCatalog(materialCatalogQuery);
    }, 220);
    return () => window.clearTimeout(timeout);
  }, [mainView, token, user, materialCatalogQuery]);

  useEffect(() => {
    if (!token || !user) return;
    if (mainView !== "materials") return;
    const poll = window.setInterval(() => {
      apiFetch<MaterialCatalogImportState>("/materials/catalog/state", token)
        .then((state) => setMaterialCatalogState(state))
        .catch(() => undefined);
    }, 5000);
    return () => window.clearInterval(poll);
  }, [mainView, token, user]);

  useEffect(() => {
    if (!token || !user) return;
    if (mainView !== "office_tasks") return;
    void loadTasks("projects_overview", null);
  }, [mainView, token, user]);

  useEffect(() => {
    if (!token || !user) return;
    if (mainView !== "calendar") return;
    void loadPlanningWindow(null, calendarWeekStart, 4);
  }, [mainView, token, user, calendarWeekStart]);

  useEffect(() => {
    if (!token || !user) return;
    if (mainView !== "construction") return;
    const targetProjectId = Number(reportProjectId);
    void loadConstructionReportFiles(targetProjectId > 0 ? targetProjectId : null);
  }, [mainView, token, user, reportProjectId]);

  useEffect(() => {
    if (!reportProjectId) return;
    const isValid = projects.some((project) => String(project.id) === reportProjectId);
    if (isValid) return;
    setReportProjectId("");
    setReportDraft({ ...EMPTY_REPORT_DRAFT });
  }, [projects, reportProjectId]);

  useEffect(() => {
    if (mainView !== "construction" || !reportTaskPrefill) return;
    // Use controlled state instead of DOM manipulation so autosave captures the prefill.
    setReportDate(reportTaskPrefill.report_date);
    setReportWorkDone(reportTaskPrefill.work_done);
    setReportIncidents(reportTaskPrefill.incidents);
    setReportMaterialRows(parseReportMaterialRows(reportTaskPrefill.materials, "materials"));
    setReportSourceTaskId(reportTaskPrefill.task_id);
    setReportTaskChecklist(buildReportTaskChecklist(reportTaskPrefill.subtasks));
    setReportTaskPrefill(null);
  }, [mainView, reportTaskPrefill]);

  useEffect(() => {
    if (mainView === "construction") return;
    setReportSourceTaskId(null);
    setReportTaskChecklist([]);
  }, [mainView]);

  // ── On mount: load all drafts, migrating the legacy single-slot v2 key ────
  // Runs exactly once. The v2 slot (if present) is folded into the v3 array
  // as a single migrated entry, then removed. Corrupt / unparseable data is
  // silently ignored so the user isn't locked out of the feature.
  useEffect(() => {
    try {
      const v3raw = localStorage.getItem(REPORT_DRAFTS_LS_KEY);
      const parsed: unknown = v3raw ? JSON.parse(v3raw) : null;
      const existing: StoredReportDraft[] = Array.isArray(parsed)
        ? parsed.filter((d): d is StoredReportDraft => !!d && typeof d === "object" && (d as StoredReportDraft).v === 3 && typeof (d as StoredReportDraft).id === "string")
        : [];

      const v2raw = localStorage.getItem(REPORT_DRAFT_LS_KEY);
      if (v2raw && existing.length === 0) {
        // One-time migration from single-slot v2 → array v3.
        try {
          const legacy = JSON.parse(v2raw) as { v?: number } & Omit<StoredReportDraft, "v" | "id">;
          if (legacy?.v === 2) {
            const migrated: StoredReportDraft = {
              ...legacy,
              v: 3,
              id: generateDraftId(),
            } as StoredReportDraft;
            existing.push(migrated);
          }
        } catch {
          // Corrupt v2 payload — drop it.
        }
        try { localStorage.removeItem(REPORT_DRAFT_LS_KEY); } catch {}
      }
      setReportDrafts(existing);
    } catch {
      // Any unexpected failure → start with an empty list; drafts array is
      // rebuilt on the next autosave tick.
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Debounced autosave: upsert the current form state into reportDrafts ───
  // If an active draft id is set, that entry is updated in place. Otherwise
  // a fresh draft is created and its id is stashed as the active one so
  // subsequent edits target the same entry.
  useEffect(() => {
    const timer = setTimeout(() => {
      const hasContent =
        reportWorkDone.trim().length > 0 ||
        reportIncidents.trim().length > 0 ||
        reportDraft.customer.trim().length > 0 ||
        reportWorkers.some((w) => w.name.trim().length > 0) ||
        reportMaterialRows.some((r) => r.item.trim().length > 0);
      if (!hasContent) return; // Don't create or overwrite a draft with empty state.

      const snapshot: Omit<StoredReportDraft, "id"> = {
        v: 3,
        projectId: reportProjectId,
        draft: reportDraft,
        workDone: reportWorkDone,
        incidents: reportIncidents,
        extras: reportExtras,
        officeRework: reportOfficeRework,
        officeNextSteps: reportOfficeNextSteps,
        date: reportDate,
        workers: reportWorkers,
        materialRows: reportMaterialRows.map(({ item, qty, unit, article_no }) => ({ item, qty, unit, article_no })),
        officeMaterialRows: reportOfficeMaterialRows.map(({ item, qty, unit, article_no }) => ({ item, qty, unit, article_no })),
        sourceTaskId: reportSourceTaskId,
        savedAt: new Date().toISOString(),
      };

      setReportDrafts((prev) => {
        const targetId = activeDraftId;
        let next: StoredReportDraft[];
        if (targetId && prev.some((d) => d.id === targetId)) {
          next = prev.map((d) => (d.id === targetId ? { ...snapshot, id: targetId } : d));
        } else {
          const newId = generateDraftId();
          // Defer the activeDraftId update to the next tick so we don't
          // trigger a setState-during-render warning.
          setTimeout(() => setActiveDraftId(newId), 0);
          next = [{ ...snapshot, id: newId }, ...prev];
        }
        try { localStorage.setItem(REPORT_DRAFTS_LS_KEY, JSON.stringify(next)); } catch {}
        return next;
      });
    }, 800);
    return () => clearTimeout(timer);
  }, [
    activeDraftId, reportProjectId, reportDraft, reportWorkDone, reportIncidents,
    reportExtras, reportOfficeRework, reportOfficeNextSteps, reportDate, reportWorkers,
    reportMaterialRows, reportOfficeMaterialRows, reportSourceTaskId,
  ]);

  useEffect(() => {
    setProjectTaskForm(buildEmptyProjectTaskFormState());
    setProjectTaskMaterialRows([createReportMaterialRow("materials")]);
    setProjectOverviewDetails(null);
    setProjectOverviewOpenTasks([]);
    setProjectWeather(null);
    setProjectWeatherLoading(false);
    setProjectFinance(null);
    setProjectTrackedMaterials([]);
    setProjectFinanceEditing(false);
    setProjectFinanceForm({ ...EMPTY_PROJECT_FINANCE_FORM });
    setProjectNoteEditing(false);
    setProjectNoteDraft("");
  }, [activeProjectId]);

  useEffect(() => {
    if (!token || !user) return;
    if (!activeProjectId) return;
    void loadProjectClassTemplates(activeProjectId);
  }, [token, user, activeProjectId]);

  useEffect(() => {
    if (!token || !user || !taskModalOpen) return;
    const projectId = Number(taskModalForm.project_id);
    if (!projectId) return;
    void loadProjectClassTemplates(projectId);
  }, [token, user, taskModalOpen, taskModalForm.project_id]);

  useEffect(() => {
    if (!token || !user || !taskEditModalOpen) return;
    const projectId = Number(taskEditForm.project_id);
    if (!projectId) return;
    void loadProjectClassTemplates(projectId);
  }, [token, user, taskEditModalOpen, taskEditForm.project_id]);

  useEffect(() => {
    const availableIds = new Set(activeProjectClassTemplates.map((row) => String(row.id)));
    if (!projectTaskForm.class_template_id) return;
    if (availableIds.has(projectTaskForm.class_template_id)) return;
    setProjectTaskForm((current) => ({ ...current, class_template_id: "" }));
  }, [activeProjectClassTemplates, projectTaskForm.class_template_id]);

  useEffect(() => {
    const availableIds = new Set(taskModalProjectClassTemplates.map((row) => String(row.id)));
    if (!taskModalForm.class_template_id) return;
    if (availableIds.has(taskModalForm.class_template_id)) return;
    setTaskModalForm((current) => ({ ...current, class_template_id: "" }));
  }, [taskModalProjectClassTemplates, taskModalForm.class_template_id]);

  useEffect(() => {
    const availableIds = new Set(taskEditProjectClassTemplates.map((row) => String(row.id)));
    if (!taskEditForm.class_template_id) return;
    if (availableIds.has(taskEditForm.class_template_id)) return;
    setTaskEditForm((current) => ({ ...current, class_template_id: "" }));
  }, [taskEditProjectClassTemplates, taskEditForm.class_template_id]);

  useEffect(() => {
    if (projectNoteEditing) return;
    setProjectNoteDraft(activeProject?.description ?? "");
  }, [activeProject?.description, projectNoteEditing]);

  useEffect(() => {
    if (expandedMyTaskId === null) return;
    if (tasks.some((task) => task.id === expandedMyTaskId)) return;
    setExpandedMyTaskId(null);
  }, [tasks, expandedMyTaskId]);

  useEffect(() => {
    if (!token || !user) return;
    if (mainView !== "overview" && mainView !== "my_tasks") return;
    void loadTasks("my", null);
  }, [mainView, token, user]);

  useEffect(() => {
    if (!token) return;
    apiFetch<AbsenceType[]>("/time/absence-types", token)
      .then(setAbsenceTypes)
      .catch(() => {});
  }, [token]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!token) return;
    const now = new Date();
    const currentYear = now.getFullYear();
    // Fetch current + next year so the calendar always has upcoming holidays
    Promise.all([
      apiFetch<PublicHoliday[]>(`/time/public-holidays?year=${currentYear}`, token),
      apiFetch<PublicHoliday[]>(`/time/public-holidays?year=${currentYear + 1}`, token),
    ])
      .then(([cur, next]) => setPublicHolidays([...cur, ...next]))
      .catch(() => {});
  }, [token]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (mainView === "projects_archive") return;
    setHighlightedArchivedProjectId(null);
  }, [mainView]);

  useEffect(() => {
    if (!token || !user) return;
    if (mainView !== "wiki") return;
    void loadWikiLibraryFiles();
  }, [mainView, token, user]);

  useEffect(() => {
    if (!wikiFiles.length) {
      setActiveWikiPath(null);
      return;
    }
    if (activeWikiPath && wikiFiles.some((entry) => entry.path === activeWikiPath)) return;
    const preferred =
      wikiFiles.find((entry) => entry.extension === "html" || entry.extension === "htm") ||
      wikiFiles.find((entry) => entry.extension === "pdf") ||
      wikiFiles.find((entry) => entry.previewable) ||
      wikiFiles[0];
    setActiveWikiPath(preferred?.path ?? null);
  }, [wikiFiles, activeWikiPath]);

  useEffect(() => {
    if (!token || !user) return;
    void loadThreads();
    const poll = window.setInterval(() => {
      void loadThreads();
    }, mainView === "messages" ? 4000 : 12000);
    return () => window.clearInterval(poll);
  }, [token, user, mainView, activeThreadId]);

  useEffect(() => {
    if (!token || mainView !== "messages" || !activeThreadId) return;
    void loadMessages(activeThreadId);
    const poll = window.setInterval(() => {
      void loadMessages(activeThreadId);
    }, 4000);
    return () => window.clearInterval(poll);
  }, [token, mainView, activeThreadId]);

  useEffect(() => {
    if (mainView !== "messages" || !activeThreadId) return;
    shouldFollowMessagesRef.current = true;
    forceScrollToBottomRef.current = true;
  }, [mainView, activeThreadId]);

  useEffect(() => {
    if (mainView !== "messages" || !activeThreadId) return;
    if (!forceScrollToBottomRef.current && !shouldFollowMessagesRef.current) return;
    const raf = window.requestAnimationFrame(() => {
      scrollMessageListToBottom();
      forceScrollToBottomRef.current = false;
    });
    return () => window.cancelAnimationFrame(raf);
  }, [messages, mainView, activeThreadId]);

  useEffect(() => {
    if (!token || (mainView !== "time" && mainView !== "overview")) return;
    void refreshTimeData();
    const poll = window.setInterval(() => {
      void refreshTimeData();
    }, 5000);
    return () => window.clearInterval(poll);
  }, [token, mainView, timeTargetUserId, isTimeManager, monthWeekDefs, timeEntriesStartDate, timeEntriesEndDate]);

  useEffect(() => {
    if (!token || mainView !== "overview") return;
    void loadRecentConstructionReports(10);
    const poll = window.setInterval(() => {
      void loadRecentConstructionReports(10);
    }, 15000);
    return () => window.clearInterval(poll);
  }, [token, mainView]);

  async function refreshRealtimeProjectLists() {
    if (!token) return;
    try {
      const [projectData, projectOverview] = await Promise.all([
        apiFetch<Project[]>("/projects", token),
        apiFetch<any[]>("/projects-overview", token),
      ]);
      setProjects(projectData);
      setOverview(projectOverview);
    } catch {
      // Silent by design for background realtime sync.
    }
  }

  async function refreshActiveViewRealtime() {
    if (!token || !user) return;
    try {
      if (mainView === "project" && activeProjectId) {
        if (projectTab === "overview") await loadProjectOverview(activeProjectId);
        if (projectTab === "tasks" || projectTab === "gantt") await loadTasks(activeProjectTaskView, activeProjectId);
        if (projectTab === "tickets") await loadSitesAndTickets(activeProjectId);
        if (projectTab === "files") {
          await Promise.all([loadFiles(activeProjectId), loadProjectFolders(activeProjectId)]);
        }
        if (projectTab === "finances" || projectTab === "hours") await loadProjectFinance(activeProjectId);
        if (projectTab === "materials") await loadProjectTrackedMaterials(activeProjectId);
        return;
      }

      if (mainView === "overview" || mainView === "my_tasks") {
        await loadTasks("my", null);
        if (mainView === "overview") {
          await loadRecentConstructionReports(10);
        }
        return;
      }

      if (mainView === "office_tasks") {
        await loadTasks("projects_overview", null);
        return;
      }

      if (mainView === "planning") {
        await loadPlanningWeek(null, planningWeekStart, planningTaskTypeView === "all" ? null : planningTaskTypeView);
        return;
      }

      if (mainView === "calendar") {
        await loadPlanningWindow(null, calendarWeekStart, 4);
        return;
      }

      if (mainView === "materials") {
        await Promise.all([loadMaterialNeeds(), loadMaterialCatalog(materialCatalogQuery)]);
        return;
      }

      if (mainView === "messages") {
        await loadThreads();
        if (activeThreadId) {
          await loadMessages(activeThreadId);
        }
        return;
      }

      if (mainView === "construction") {
        const targetProjectId = Number(reportProjectId);
        await loadConstructionReportFiles(targetProjectId > 0 ? targetProjectId : null);
        return;
      }

      if (mainView === "wiki") {
        await loadWikiLibraryFiles();
        return;
      }

      if (mainView === "time") {
        await refreshTimeData();
      }
    } catch {
      // Silent by design for background realtime sync.
    }
  }

  const handleServerEvent = useCallback((event: ServerEvent) => {
    const eventType = String(event.type || "").trim().toLowerCase();
    if (!eventType) return;

    let planningRefreshed = false;

    // Keep project headers/sidebars in sync for task/project mutations.
    if (eventType.startsWith("task.") || eventType.startsWith("project.")) {
      void refreshRealtimeProjectLists();
    }

    if (eventType === "task.created" || eventType === "task.updated" || eventType === "task.deleted") {
      // Re-fetch planning week if the planning view is currently open.
      if (mainView === "planning") {
        void loadPlanningWeek(null, planningWeekStart, planningTaskTypeView === "all" ? null : planningTaskTypeView);
        planningRefreshed = true;
      }
      // Re-fetch calendar weeks if the calendar view is open. Only task
      // mutations matter here — chat messages, file uploads, etc. should NOT
      // cause the calendar to flash its loading state.
      if (mainView === "calendar") {
        void loadPlanningWindow(null, calendarWeekStart, 4);
        planningRefreshed = true;
      }
    }

    // Keep thread list fresh even outside the messages view.
    if (eventType.startsWith("message.") || eventType.startsWith("thread.")) {
      void loadThreads();
    }

    if (eventType === "message.created") {
      // Show a browser notification for incoming messages from others, but
      // skip it when the user is already in the messages view for that thread.
      const senderId = event.data?.sender_id;
      const threadId = event.data?.thread_id;
      const body = typeof event.data?.body === "string" ? event.data.body : "";
      const isOwnMessage = senderId === user?.id;
      const isActiveThread = mainView === "messages" && activeThreadId === threadId;
      if (!isOwnMessage && !isActiveThread) {
        const senderName = userNameById(Number(senderId));
        const title = language === "de" ? "Neue Nachricht" : "New message";
        const notifBody = senderName ? `${senderName}: ${body}` : body;
        showBrowserNotification(title, { body: notifBody.slice(0, 120), icon: "/icon-192.png" });
      }
    }

    if (eventType === "notification.created") {
      void loadNotifications();
      return;
    }

    // Fallback: refresh the active view for any event not already handled.
    // Skip calendar and planning — they manage their own refresh above and
    // shouldn't flash their loading state for unrelated events (e.g. chat).
    if (!planningRefreshed && mainView !== "calendar" && mainView !== "planning") {
      void refreshActiveViewRealtime();
    }
  }, [
    activeThreadId,
    calendarWeekStart,
    language,
    loadNotifications,
    loadPlanningWeek,
    loadPlanningWindow,
    loadThreads,
    mainView,
    planningTaskTypeView,
    planningWeekStart,
    refreshActiveViewRealtime,
    refreshRealtimeProjectLists,
    showBrowserNotification,
    user?.id,
    userNameById,
  ]);

  const { status: sseStatus } = useServerEvents(token, {
    onEvent: handleServerEvent,
    onReconnect: () => {
      void loadNotifications();
      void refreshActiveViewRealtime();
      void refreshRealtimeProjectLists();
    },
  });

  async function saveUserPreference<K extends keyof import("./types").UserPreferences>(
    key: K,
    value: import("./types").UserPreferences[K],
  ): Promise<void> {
    if (!token) return;
    try {
      const updated = await apiFetch<User>("/auth/me/preferences", token, {
        method: "PATCH",
        body: JSON.stringify({ [key]: value }),
      });
      setUser(updated);
    } catch {
      // Preference save failure is non-critical — silently ignore.
    }
  }

  async function loadBaseData() {
    try {
      const [projectData, projectOverview] = await Promise.all([
        apiFetch<Project[]>("/projects", token),
        apiFetch<any[]>("/projects-overview", token),
      ]);
      setProjects(projectData);
      setOverview(projectOverview);
      await loadRecentConstructionReports(10);
      if (projectData.length > 0) {
        const visibleProjects = projectData.filter((project) => !isArchivedProjectStatus(project.status));
        const hasVisibleActive = activeProjectId
          ? visibleProjects.some((project) => project.id === activeProjectId)
          : false;
        if (!hasVisibleActive) {
          setActiveProjectId(visibleProjects[0]?.id ?? null);
        }
      }
      setReportProjectId((current) => {
        if (current && projectData.some((project) => String(project.id) === current)) return current;
        return "";
      });
      try {
        const classTemplates = await apiFetch<ProjectClassTemplate[]>("/project-class-templates", token);
        setProjectClassTemplates(classTemplates);
      } catch {
        setProjectClassTemplates([]);
      }
      setProjectClassTemplatesByProjectId((current) => {
        const next: Record<number, ProjectClassTemplate[]> = {};
        projectData.forEach((project) => {
          if (current[project.id]) next[project.id] = current[project.id];
        });
        return next;
      });
      try {
        const assignables = await apiFetch<AssignableUser[]>("/users/assignable", token);
        setAssignableUsers(assignables);
      } catch {
        setAssignableUsers([]);
      }
      try {
        const roles = await apiFetch<string[]>("/threads/participant-roles", token);
        const normalizedRoles = Array.from(
          new Set(
            roles
              .map((entry) => String(entry || "").trim().toLowerCase())
              .filter((entry) => entry.length > 0),
          ),
        );
        setThreadParticipantRoles(
          normalizedRoles.length > 0 ? normalizedRoles : [...DEFAULT_THREAD_PARTICIPANT_ROLES],
        );
      } catch {
        setThreadParticipantRoles([...DEFAULT_THREAD_PARTICIPANT_ROLES]);
      }
      if (canManageSettings) {
        try {
          const [weatherRow, companyRow, smtpRow] = await Promise.all([
            apiFetch<WeatherSettings>("/admin/settings/weather", token),
            apiFetch<CompanySettings>("/admin/settings/company", token),
            apiFetch<SmtpSettings>("/admin/settings/smtp", token),
          ]);
          setWeatherSettings(weatherRow);
          setWeatherApiKeyInput("");
          setCompanySettings(companyRow);
          setCompanySettingsForm({
            logo_url: companyRow.logo_url || "",
            navigation_title: companyRow.navigation_title || "SMPL",
            company_name: companyRow.company_name || "SMPL",
            company_address: companyRow.company_address || "",
          });
          setSmtpSettings(smtpRow);
          setSmtpSettingsForm({
            host: smtpRow.host || "",
            port: String(smtpRow.port || 587),
            username: smtpRow.username || "",
            password: "",
            clear_password: false,
            starttls: smtpRow.starttls,
            ssl: smtpRow.ssl,
            from_email: smtpRow.from_email || "",
            from_name: smtpRow.from_name || "",
          });
        } catch {
          setWeatherSettings(null);
          setCompanySettingsForm({
            logo_url: "",
            navigation_title: "SMPL",
            company_name: "SMPL",
            company_address: "",
          });
          setSmtpSettings(null);
          setSmtpSettingsForm({
            host: "",
            port: "587",
            username: "",
            password: "",
            clear_password: false,
            starttls: true,
            ssl: false,
            from_email: "",
            from_name: "",
          });
        }
      } else {
        setWeatherSettings(null);
        setSmtpSettings(null);
        setSmtpSettingsForm({
          host: "",
          port: "587",
          username: "",
          password: "",
          clear_password: false,
          starttls: true,
          ssl: false,
          from_email: "",
          from_name: "",
        });
      }
      if (canManageUsers) {
        const userData = await apiFetch<User[]>("/admin/users", token);
        setUsers(userData);
      } else {
        setUsers([]);
      }
      if (canManageSystem) {
        try {
          const statusRow = await apiFetch<UpdateStatus>("/admin/updates/status", token);
          setUpdateStatus(statusRow);
        } catch {
          setUpdateStatus(null);
        }
      } else {
        setUpdateStatus(null);
      }
      if (mainView === "project" && activeProjectId) {
        if (projectTab === "overview") await loadProjectOverview(activeProjectId);
        if (projectTab === "tasks" || projectTab === "gantt") await loadTasks(activeProjectTaskView, activeProjectId);
        if (projectTab === "finances" || projectTab === "hours") await loadProjectFinance(activeProjectId);
        if (projectTab === "materials") await loadProjectTrackedMaterials(activeProjectId);
      }
      if (mainView === "materials") {
        await loadMaterialNeeds();
        await loadMaterialCatalog(materialCatalogQuery);
      }
    } catch (err: any) {
      setError(err.message ?? "Failed to load data");
    }
  }

  async function loadProjectClassTemplates(projectId: number) {
    try {
      const rows = await apiFetch<ProjectClassTemplate[]>(`/projects/${projectId}/class-templates`, token);
      setProjectClassTemplatesByProjectId((current) => ({ ...current, [projectId]: rows }));
      return rows;
    } catch (err: any) {
      setProjectClassTemplatesByProjectId((current) => ({ ...current, [projectId]: [] }));
      setError(err.message ?? "Failed to load project classes");
      return [];
    }
  }

  async function loadTasks(mode: TaskView, projectId: number | null) {
    const projectQuery = projectId ? `&project_id=${projectId}` : "";
    try {
      const taskData = await apiFetch<Task[]>(`/tasks?view=${mode}${projectQuery}`, token);
      setTasks(taskData);
    } catch (err: any) {
      setError(err.message ?? "Failed to load tasks");
    }
  }

  async function loadMaterialNeeds() {
    try {
      const rows = await apiFetch<ProjectMaterialNeed[]>("/materials", token);
      setMaterialNeeds(rows);
    } catch (err: any) {
      setMaterialNeeds([]);
      setError(err.message ?? "Failed to load materials");
    }
  }

  async function uploadMaterialCatalogImage(
    externalKey: string,
    file: File,
  ): Promise<MaterialCatalogItem | null> {
    if (!externalKey) {
      setError(
        language === "de"
          ? "Dieser Katalog-Eintrag hat keinen externen Schlüssel."
          : "This catalog item has no external key.",
      );
      return null;
    }
    const form = new FormData();
    form.append("file", file);
    try {
      const result = await apiFetch<{
        ok: boolean;
        external_key: string;
        image_url: string;
        image_source: string;
      }>(`/materials/catalog/images/${encodeURIComponent(externalKey)}`, token, {
        method: "POST",
        body: form,
      });
      setMaterialCatalogRows((current) =>
        current.map((row) =>
          row.external_key === externalKey
            ? {
                ...row,
                image_url: result.image_url,
                image_source: result.image_source,
                image_checked_at: new Date().toISOString(),
              }
            : row,
        ),
      );
      setNotice(
        language === "de"
          ? "Bild hochgeladen."
          : "Image uploaded.",
      );
      const match = materialCatalogRows.find((row) => row.external_key === externalKey);
      return match
        ? {
            ...match,
            image_url: result.image_url,
            image_source: result.image_source,
            image_checked_at: new Date().toISOString(),
          }
        : null;
    } catch (err: any) {
      setError(err?.message ?? "Image upload failed");
      return null;
    }
  }

  async function deleteMaterialCatalogImage(externalKey: string): Promise<void> {
    if (!externalKey) return;
    try {
      await apiFetch<{ ok: boolean }>(
        `/materials/catalog/images/${encodeURIComponent(externalKey)}`,
        token,
        { method: "DELETE" },
      );
      setMaterialCatalogRows((current) =>
        current.map((row) =>
          row.external_key === externalKey
            ? { ...row, image_url: null, image_source: null, image_checked_at: null }
            : row,
        ),
      );
      setNotice(
        language === "de"
          ? "Bild entfernt. Automatische Suche aktiv."
          : "Image removed. Auto-lookup re-enabled.",
      );
    } catch (err: any) {
      setError(err?.message ?? "Image removal failed");
    }
  }

  async function loadMaterialCatalog(query: string) {
    const requestSeq = ++materialCatalogRequestSeqRef.current;
    setMaterialCatalogLoading(true);
    try {
      const q = query.trim();
      const [rows, state] = await Promise.all([
        apiFetch<MaterialCatalogItem[]>(
          `/materials/catalog?q=${encodeURIComponent(q)}&limit=${MATERIAL_CATALOG_SEARCH_LIMIT}`,
          token,
        ),
        apiFetch<MaterialCatalogImportState>("/materials/catalog/state", token).catch(() => null),
      ]);
      if (requestSeq !== materialCatalogRequestSeqRef.current) return;
      if (q !== materialCatalogQueryRef.current.trim()) return;
      setMaterialCatalogRows(rows.slice(0, MATERIAL_CATALOG_SEARCH_LIMIT));
      setMaterialCatalogState(state);
    } catch (err: any) {
      if (requestSeq !== materialCatalogRequestSeqRef.current) return;
      if (query.trim() !== materialCatalogQueryRef.current.trim()) return;
      setMaterialCatalogRows([]);
      setMaterialCatalogState(null);
      setError(err.message ?? "Failed to load material catalog");
    } finally {
      if (requestSeq !== materialCatalogRequestSeqRef.current) return;
      setMaterialCatalogLoading(false);
    }
  }

  function normalizeMaterialCatalogLookupKey(value: string) {
    return value.trim().toLowerCase();
  }

  function isLikelyMaterialCatalogIdentifier(value: string) {
    const normalized = value.trim();
    if (!normalized || normalized.length < 2) return false;
    if (/^\d+$/.test(normalized)) return true;
    return /[0-9]|[-_/]/.test(normalized);
  }

  function mergeMaterialRowWithCatalogItem(row: ReportMaterialRow, catalogItem: MaterialCatalogItem): ReportMaterialRow {
    return {
      ...row,
      item: String(catalogItem.item_name || row.item || "").trim(),
      article_no: String(catalogItem.article_no || row.article_no || "").trim(),
      unit: String(catalogItem.unit || row.unit || "").trim(),
    };
  }

  function findMaterialCatalogMatch(
    rows: MaterialCatalogItem[],
    lookupKey: string,
  ): MaterialCatalogItem | null {
    const exactArticleNo =
      rows.find((entry) => normalizeMaterialCatalogLookupKey(String(entry.article_no || "")) === lookupKey) ?? null;
    if (exactArticleNo) return exactArticleNo;
    const exactEan = rows.find((entry) => normalizeMaterialCatalogLookupKey(String(entry.ean || "")) === lookupKey) ?? null;
    if (exactEan) return exactEan;
    const exactName =
      rows.find((entry) => normalizeMaterialCatalogLookupKey(String(entry.item_name || "")) === lookupKey) ?? null;
    if (exactName) return exactName;
    if (rows.length === 1) return rows[0];
    return null;
  }

  async function lookupMaterialCatalogByIdentifier(rawValue: string): Promise<MaterialCatalogItem | null> {
    const lookupKey = normalizeMaterialCatalogLookupKey(rawValue);
    if (!lookupKey) return null;
    if (lookupKey in materialCatalogLookupCacheRef.current) {
      return materialCatalogLookupCacheRef.current[lookupKey] ?? null;
    }
    try {
      const rows = await apiFetch<MaterialCatalogItem[]>(
        `/materials/catalog?q=${encodeURIComponent(rawValue.trim())}&limit=${MATERIAL_CATALOG_SEARCH_LIMIT}`,
        token,
      );
      const match = findMaterialCatalogMatch(rows.slice(0, MATERIAL_CATALOG_SEARCH_LIMIT), lookupKey);
      materialCatalogLookupCacheRef.current[lookupKey] = match;
      return match;
    } catch {
      return null;
    }
  }

  async function enrichTaskModalMaterialRowFromCatalog(
    index: number,
    lookupField: "item" | "article_no",
  ) {
    const row = taskModalMaterialRows[index];
    if (!row) return;
    const rawLookupValue = lookupField === "article_no" ? row.article_no : row.item;
    if (lookupField === "item" && !isLikelyMaterialCatalogIdentifier(rawLookupValue)) return;
    const lookupKey = normalizeMaterialCatalogLookupKey(rawLookupValue);
    if (!lookupKey) return;
    const matched = await lookupMaterialCatalogByIdentifier(rawLookupValue);
    if (!matched) return;
    setTaskModalMaterialRows((current) => {
      const target = current[index];
      if (!target) return current;
      const currentLookupKey = normalizeMaterialCatalogLookupKey(
        lookupField === "article_no" ? target.article_no : target.item,
      );
      if (currentLookupKey !== lookupKey) return current;
      const merged = mergeMaterialRowWithCatalogItem(target, matched);
      if (
        merged.item === target.item &&
        merged.article_no === target.article_no &&
        merged.unit === target.unit
      ) {
        return current;
      }
      const next = [...current];
      next[index] = merged;
      setTaskModalForm((form) => ({ ...form, materials_required: serializeTaskMaterialRows(next) }));
      return next;
    });
  }

  async function enrichTaskEditMaterialRowFromCatalog(
    index: number,
    lookupField: "item" | "article_no",
  ) {
    const row = taskEditMaterialRows[index];
    if (!row) return;
    const rawLookupValue = lookupField === "article_no" ? row.article_no : row.item;
    if (lookupField === "item" && !isLikelyMaterialCatalogIdentifier(rawLookupValue)) return;
    const lookupKey = normalizeMaterialCatalogLookupKey(rawLookupValue);
    if (!lookupKey) return;
    const matched = await lookupMaterialCatalogByIdentifier(rawLookupValue);
    if (!matched) return;
    setTaskEditMaterialRows((current) => {
      const target = current[index];
      if (!target) return current;
      const currentLookupKey = normalizeMaterialCatalogLookupKey(
        lookupField === "article_no" ? target.article_no : target.item,
      );
      if (currentLookupKey !== lookupKey) return current;
      const merged = mergeMaterialRowWithCatalogItem(target, matched);
      if (
        merged.item === target.item &&
        merged.article_no === target.article_no &&
        merged.unit === target.unit
      ) {
        return current;
      }
      const next = [...current];
      next[index] = merged;
      setTaskEditForm((form) => ({ ...form, materials_required: serializeTaskMaterialRows(next) }));
      return next;
    });
  }

  async function enrichReportMaterialRowFromCatalog(
    index: number,
    lookupField: "item" | "article_no",
  ) {
    const row = reportMaterialRows[index];
    if (!row) return;
    const rawLookupValue = lookupField === "article_no" ? row.article_no : row.item;
    if (lookupField === "item" && !isLikelyMaterialCatalogIdentifier(rawLookupValue)) return;
    const lookupKey = normalizeMaterialCatalogLookupKey(rawLookupValue);
    if (!lookupKey) return;
    const matched = await lookupMaterialCatalogByIdentifier(rawLookupValue);
    if (!matched) return;
    setReportMaterialRows((current) => {
      const target = current[index];
      if (!target) return current;
      const currentLookupKey = normalizeMaterialCatalogLookupKey(
        lookupField === "article_no" ? target.article_no : target.item,
      );
      if (currentLookupKey !== lookupKey) return current;
      const merged = mergeMaterialRowWithCatalogItem(target, matched);
      if (
        merged.item === target.item &&
        merged.article_no === target.article_no &&
        merged.unit === target.unit
      ) {
        return current;
      }
      const next = [...current];
      next[index] = merged;
      return next;
    });
  }

  async function enrichReportOfficeMaterialRowFromCatalog(
    index: number,
    lookupField: "item" | "article_no",
  ) {
    const row = reportOfficeMaterialRows[index];
    if (!row) return;
    const rawLookupValue = lookupField === "article_no" ? row.article_no : row.item;
    if (lookupField === "item" && !isLikelyMaterialCatalogIdentifier(rawLookupValue)) return;
    const lookupKey = normalizeMaterialCatalogLookupKey(rawLookupValue);
    if (!lookupKey) return;
    const matched = await lookupMaterialCatalogByIdentifier(rawLookupValue);
    if (!matched) return;
    setReportOfficeMaterialRows((current) => {
      const target = current[index];
      if (!target) return current;
      const currentLookupKey = normalizeMaterialCatalogLookupKey(
        lookupField === "article_no" ? target.article_no : target.item,
      );
      if (currentLookupKey !== lookupKey) return current;
      const merged = mergeMaterialRowWithCatalogItem(target, matched);
      if (
        merged.item === target.item &&
        merged.article_no === target.article_no &&
        merged.unit === target.unit
      ) {
        return current;
      }
      const next = [...current];
      next[index] = merged;
      return next;
    });
  }

  function selectMaterialCatalogProject(project: Project) {
    setMaterialCatalogProjectId(String(project.id));
    setMaterialCatalogProjectSearch(projectSearchLabel(project));
    setMaterialCatalogProjectSearchFocused(false);
  }

  async function addCatalogMaterialNeed(materialCatalogItem: MaterialCatalogItem, quantity?: string) {
    const projectId = Number(materialCatalogProjectId);
    if (!projectId) {
      setError(language === "de" ? "Bitte zuerst ein Projekt auswählen." : "Please select a project first.");
      return;
    }
    setMaterialCatalogAdding((current) => ({ ...current, [materialCatalogItem.id]: true }));
    try {
      const body: Record<string, unknown> = {
        project_id: projectId,
        material_catalog_item_id: materialCatalogItem.id,
      };
      if (quantity && quantity.trim()) {
        body.quantity = quantity.trim();
      }
      const created = await apiFetch<ProjectMaterialNeed>("/materials", token, {
        method: "POST",
        body: JSON.stringify(body),
      });
      setMaterialNeeds((current) => [created, ...current]);
      setNotice(
        language === "de"
          ? `Material hinzugefügt: ${materialCatalogItem.item_name}`
          : `Material added: ${materialCatalogItem.item_name}`,
      );
    } catch (err: any) {
      setError(err.message ?? "Failed to add material");
    } finally {
      setMaterialCatalogAdding((current) => {
        const next = { ...current };
        delete next[materialCatalogItem.id];
        return next;
      });
    }
  }

  async function updateMaterialNeedState(materialNeedId: number, nextStatus: MaterialNeedStatus) {
    setMaterialNeedUpdating((current) => ({ ...current, [materialNeedId]: true }));
    try {
      const updated = await apiFetch<ProjectMaterialNeed>(`/materials/${materialNeedId}`, token, {
        method: "PATCH",
        body: JSON.stringify({ status: nextStatus }),
      });
      setMaterialNeeds((current) =>
        current.map((entry) => (entry.id === materialNeedId ? updated : entry)),
      );
      setNotice(language === "de" ? "Materialstatus aktualisiert" : "Material status updated");
    } catch (err: any) {
      setError(err.message ?? "Failed to update material status");
    } finally {
      setMaterialNeedUpdating((current) => {
        const next = { ...current };
        delete next[materialNeedId];
        return next;
      });
    }
  }

  async function updateMaterialNeedNote(materialNeedId: number, notes: string) {
    try {
      const updated = await apiFetch<ProjectMaterialNeed>(`/materials/${materialNeedId}`, token, {
        method: "PATCH",
        body: JSON.stringify({ notes }),
      });
      setMaterialNeeds((current) =>
        current.map((entry) => (entry.id === materialNeedId ? updated : entry)),
      );
    } catch (err: any) {
      setError(err.message ?? "Failed to update material note");
    }
  }

  async function loadProjectOverview(projectId: number) {
    try {
      const [details, openTasks] = await Promise.all([
        apiFetch<ProjectOverviewDetails>(`/projects/${projectId}/overview`, token),
        apiFetch<Task[]>(`/tasks?view=all_open&project_id=${projectId}`, token).catch(() => []),
      ]);
      setProjectOverviewDetails(details);
      setProjects((current) =>
        current.map((entry) => (entry.id === details.project.id ? { ...entry, ...details.project } : entry)),
      );
      setProjectOverviewOpenTasks(openTasks);
      setProjectFinance(details.finance ?? null);
      setProjectFinanceForm(projectFinanceToFormState(details.finance ?? null));
      setProjectHoursPlannedInput(
        details.finance?.planned_hours_total == null ? "" : String(details.finance.planned_hours_total),
      );
      const baseNote = details.project.description ?? "";
      setProjectNoteDraft(baseNote);
    } catch (err: any) {
      setProjectOverviewDetails(null);
      setProjectOverviewOpenTasks([]);
      setProjectHoursPlannedInput("");
      setError(err.message ?? "Failed to load project overview");
    }
  }

  async function loadProjectWeather(projectId: number, refresh: boolean) {
    setProjectWeatherLoading(true);
    try {
      const query = `?refresh=${refresh ? "true" : "false"}&lang=${encodeURIComponent(language)}`;
      const payload = await apiFetch<ProjectWeather>(`/projects/${projectId}/weather${query}`, token);
      setProjectWeather(payload);
    } catch (err: any) {
      setProjectWeather(null);
      setError(err.message ?? "Failed to load project weather");
    } finally {
      setProjectWeatherLoading(false);
    }
  }

  async function loadProjectFinance(projectId: number) {
    try {
      const finance = await apiFetch<ProjectFinance>(`/projects/${projectId}/finance`, token);
      setProjectFinance(finance);
      setProjectFinanceForm(projectFinanceToFormState(finance));
      setProjectHoursPlannedInput(finance.planned_hours_total == null ? "" : String(finance.planned_hours_total));
    } catch (err: any) {
      setProjectFinance(null);
      setProjectHoursPlannedInput("");
      setError(err.message ?? "Failed to load project finance");
    }
  }

  async function loadProjectTrackedMaterials(projectId: number) {
    try {
      const rows = await apiFetch<ProjectTrackedMaterial[]>(`/projects/${projectId}/materials`, token);
      setProjectTrackedMaterials(rows);
    } catch (err: any) {
      setProjectTrackedMaterials([]);
      setError(err.message ?? "Failed to load project materials");
    }
  }

  async function saveWeatherSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canManageSettings) return;
    setWeatherSettingsSaving(true);
    try {
      const payload = await apiFetch<WeatherSettings>("/admin/settings/weather", token, {
        method: "PATCH",
        body: JSON.stringify({ api_key: weatherApiKeyInput.trim() }),
      });
      setWeatherSettings(payload);
      setWeatherApiKeyInput("");
      setNotice(
        language === "de"
          ? "Wetter-API Einstellungen gespeichert"
          : "Weather API settings saved",
      );
    } catch (err: any) {
      setError(err.message ?? "Failed to save weather settings");
    } finally {
      setWeatherSettingsSaving(false);
    }
  }

  async function loadPublicCompanySettings() {
    try {
      const payload = await apiFetch<CompanySettings>("/admin/settings/company/public", null);
      setCompanySettings(payload);
      setCompanySettingsForm((current) =>
        current.logo_url ||
        current.navigation_title !== "SMPL" ||
        current.company_name !== "SMPL" ||
        current.company_address
          ? current
          : {
              logo_url: payload.logo_url || "",
              navigation_title: payload.navigation_title || "SMPL",
              company_name: payload.company_name || "SMPL",
              company_address: payload.company_address || "",
            },
      );
    } catch {
      setCompanySettings((current) => current);
    }
  }

  async function saveCompanySettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canManageSettings) return;
    setCompanySettingsSaving(true);
    try {
      const payload = await apiFetch<CompanySettings>("/admin/settings/company", token, {
        method: "PATCH",
        body: JSON.stringify({
          logo_url: companySettingsForm.logo_url.trim(),
          navigation_title: companySettingsForm.navigation_title.trim(),
          company_name: companySettingsForm.company_name.trim(),
          company_address: companySettingsForm.company_address.trim(),
        }),
      });
      setCompanySettings(payload);
      setCompanySettingsForm({
        logo_url: payload.logo_url || "",
        navigation_title: payload.navigation_title || "SMPL",
        company_name: payload.company_name || "SMPL",
        company_address: payload.company_address || "",
      });
      setNotice(
        language === "de"
          ? "Firmeninformationen gespeichert"
          : "Company settings saved",
      );
    } catch (err: any) {
      setError(err.message ?? "Failed to save company settings");
    } finally {
      setCompanySettingsSaving(false);
    }
  }

  async function saveSmtpSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canManageSettings) return;
    setSmtpSettingsSaving(true);
    try {
      const payload = await apiFetch<SmtpSettings>("/admin/settings/smtp", token, {
        method: "PATCH",
        body: JSON.stringify({
          host: smtpSettingsForm.host.trim(),
          port: Number(smtpSettingsForm.port) || 587,
          username: smtpSettingsForm.username.trim(),
          password: smtpSettingsForm.password,
          clear_password: smtpSettingsForm.clear_password,
          starttls: smtpSettingsForm.starttls,
          ssl: smtpSettingsForm.ssl,
          from_email: smtpSettingsForm.from_email.trim(),
          from_name: smtpSettingsForm.from_name.trim(),
        }),
      });
      setSmtpSettings(payload);
      setSmtpSettingsForm((current) => ({
        ...current,
        host: payload.host || "",
        port: String(payload.port || 587),
        username: payload.username || "",
        password: "",
        clear_password: false,
        starttls: payload.starttls,
        ssl: payload.ssl,
        from_email: payload.from_email || "",
        from_name: payload.from_name || "",
      }));
      setNotice(
        language === "de"
          ? "SMTP-Einstellungen gespeichert"
          : "SMTP settings saved",
      );
    } catch (err: any) {
      setError(err.message ?? "Failed to save SMTP settings");
    } finally {
      setSmtpSettingsSaving(false);
    }
  }

  async function sendSmtpTest(toEmail?: string): Promise<SmtpTestResult | null> {
    if (!canManageSettings) return null;
    setSmtpTestSending(true);
    setSmtpTestLastResult(null);
    try {
      const result = await apiFetch<SmtpTestResult>(
        "/admin/settings/smtp/test",
        token,
        {
          method: "POST",
          body: JSON.stringify({
            to_email: toEmail && toEmail.trim().length > 0 ? toEmail.trim() : null,
          }),
        },
      );
      setSmtpTestLastResult(result);
      if (result.ok) {
        setNotice(
          language === "de"
            ? `Test-E-Mail an ${result.to_email} gesendet.`
            : `Test email sent to ${result.to_email}.`,
        );
      } else {
        setError(
          (language === "de" ? "SMTP-Test fehlgeschlagen: " : "SMTP test failed: ") +
            (result.error_detail ||
              (language === "de" ? "Unbekannter Fehler" : "Unknown error")),
        );
      }
      return result;
    } catch (err: any) {
      const message = err?.message ?? "SMTP test failed";
      setError(message);
      setSmtpTestLastResult({
        ok: false,
        error_type: "request",
        error_detail: message,
        to_email: toEmail ?? "",
      });
      return null;
    } finally {
      setSmtpTestSending(false);
    }
  }

  async function loadUpdateStatus(showNotice = false) {
    if (!canManageSystem) return;
    setUpdateStatusLoading(true);
    try {
      const statusRow = await apiFetch<UpdateStatus>("/admin/updates/status", token);
      setUpdateStatus(statusRow);
      if (showNotice) {
        setNotice(
          language === "de" ? "Update-Status aktualisiert" : "Update status refreshed",
        );
      }
    } catch (err: any) {
      setError(err.message ?? "Failed to load update status");
    } finally {
      setUpdateStatusLoading(false);
    }
  }

  async function getUpdateProgress(jobId: string): Promise<UpdateProgress | null> {
    try {
      return await apiFetch<UpdateProgress>(`/admin/updates/progress/${jobId}`, token);
    } catch (err: any) {
      // 404 means the runner forgot the job (e.g., restart). Treat as terminal
      // by returning null so the caller stops polling — surfacing this as an
      // error toast every 2s would be noisy.
      const status = err?.status ?? err?.response?.status;
      if (status === 404) return null;
      throw err;
    }
  }

  function clearUpdateProgressTimer() {
    if (updateProgressTimerRef.current !== null) {
      clearTimeout(updateProgressTimerRef.current);
      updateProgressTimerRef.current = null;
    }
  }

  /** Poll the runner for a job's progress every 2s until it reaches a terminal
   *  state (succeeded/failed) or the runner forgets it (404 → null). On terminal
   *  state we refresh the update status (so the version label flips) and clear
   *  the running flag. Errors during a single poll don't tear down the loop —
   *  they're surfaced as a notice and the next tick retries. */
  async function pollUpdateProgress(jobId: string) {
    clearUpdateProgressTimer();
    try {
      const snapshot = await getUpdateProgress(jobId);
      if (snapshot === null) {
        // Runner forgot the job; nothing more we can show.
        setUpdateInstallRunning(false);
        return;
      }
      setUpdateProgress(snapshot);
      const isTerminal = snapshot.status === "succeeded" || snapshot.status === "failed";
      if (isTerminal) {
        setUpdateInstallRunning(false);
        if (snapshot.status === "succeeded") {
          setNotice(
            snapshot.detail ||
              (language === "de" ? "Update erfolgreich abgeschlossen" : "Update completed successfully"),
          );
        } else {
          setError(
            snapshot.detail ||
              (language === "de" ? "Update fehlgeschlagen" : "Update failed"),
          );
        }
        await loadUpdateStatus(false);
        return;
      }
      updateProgressTimerRef.current = setTimeout(() => {
        void pollUpdateProgress(jobId);
      }, 2000);
    } catch (err: any) {
      // Transient error (network blip, runner restart) — schedule another tick
      // rather than aborting. The user can still see the last good snapshot.
      updateProgressTimerRef.current = setTimeout(() => {
        void pollUpdateProgress(jobId);
      }, 4000);
    }
  }

  async function installSystemUpdate(dryRun: boolean) {
    if (!canManageSystem) return;
    setUpdateInstallRunning(true);
    setUpdateProgress(null);
    clearUpdateProgressTimer();
    try {
      const result = await apiFetch<UpdateInstallResponse>("/admin/updates/install", token, {
        method: "POST",
        body: JSON.stringify({ dry_run: dryRun }),
      });
      if (!result.ok) {
        setError(result.detail || (language === "de" ? "Update fehlgeschlagen" : "Update failed"));
        setUpdateInstallRunning(false);
        return;
      }
      // Async path: the api delegated to the update_runner sidecar. Start polling
      // the job's progress; the running flag stays true until the poller sees a
      // terminal status. We do NOT await pollUpdateProgress because the loop is
      // self-scheduling via setTimeout.
      if (result.async_mode && result.job_id) {
        setNotice(
          result.detail ||
            (language === "de" ? "Update gestartet (läuft im Hintergrund)" : "Update started (running in background)"),
        );
        setUpdateProgress({
          job_id: result.job_id,
          kind: "update",
          status: "queued",
          log_tail: null,
          detail: result.detail ?? null,
          exit_code: null,
          started_at: null,
          finished_at: null,
        });
        void pollUpdateProgress(result.job_id);
        return;
      }
      // Sync path: legacy in-process flow already finished by the time we got
      // here. Show the result and clear the running flag.
      setNotice(result.detail || (language === "de" ? "Update ausgeführt" : "Update completed"));
      await loadUpdateStatus(false);
      setUpdateInstallRunning(false);
    } catch (err: any) {
      setError(err.message ?? "Failed to run update");
      setUpdateInstallRunning(false);
    }
  }

  async function loadPlanningWeek(projectId: number | null, weekStart: string, taskType?: TaskType | null) {
    const params: string[] = [];
    if (projectId) params.push(`project_id=${projectId}`);
    if (taskType) params.push(`task_type=${encodeURIComponent(taskType)}`);
    const query = params.length > 0 ? `?${params.join("&")}` : "";
    try {
      const week = await apiFetch<PlanningWeek>(`/planning/week/${weekStart}${query}`, token);
      setPlanningWeek(week);
    } catch (err: any) {
      setError(err.message ?? "Failed to load weekly planning");
    }
  }

  async function loadPlanningWindow(projectId: number | null, weekStart: string, weekCount: number) {
    const query = projectId ? `?project_id=${projectId}` : "";
    const starts = Array.from({ length: Math.max(weekCount, 1) }, (_, index) =>
      normalizeWeekStartISO(addDaysISO(weekStart, index * 7)),
    );
    setCalendarLoading(true);
    try {
      const weeks = await Promise.all(
        starts.map((weekStartValue) => apiFetch<PlanningWeek>(`/planning/week/${weekStartValue}${query}`, token)),
      );
      setCalendarWeeks(weeks);
    } catch (err: any) {
      setCalendarWeeks([]);
      setError(err.message ?? "Failed to load calendar");
    } finally {
      setCalendarLoading(false);
    }
  }

  async function loadSitesAndTickets(projectId: number) {
    try {
      const ticketData = await apiFetch<Ticket[]>(`/projects/${projectId}/job-tickets`, token);
      setTickets(ticketData);
    } catch (err: any) {
      setError(err.message ?? "Failed to load tickets");
    }
  }

  async function loadFiles(projectId: number) {
    try {
      setFiles(await apiFetch<ProjectFile[]>(`/projects/${projectId}/files`, token));
    } catch (err: any) {
      setError(err.message ?? "Failed to load files");
    }
  }

  async function loadProjectFolders(projectId: number) {
    try {
      const rows = await apiFetch<ProjectFolder[]>(`/projects/${projectId}/folders`, token);
      setProjectFolders(rows);
      setFileUploadFolder((current) => {
        if (current === "/") return current;
        if (current && rows.some((folder) => folder.path === current)) return current;
        const fallback = rows.find((folder) => canUseProtectedFolders || !folder.is_protected);
        return fallback?.path ?? "/";
      });
    } catch (err: any) {
      setProjectFolders([]);
      setError(err.message ?? "Failed to load project folders");
    }
  }

  async function loadConstructionReportFiles(projectId: number | null) {
    const query = projectId ? `?project_id=${projectId}` : "";
    try {
      setFiles(await apiFetch<ProjectFile[]>(`/construction-reports/files${query}`, token));
    } catch (err: any) {
      setError(err.message ?? "Failed to load report files");
    }
  }

  async function loadRecentConstructionReports(limit = 10) {
    try {
      const rows = await apiFetch<RecentConstructionReport[]>(`/construction-reports/recent?limit=${Number(limit)}`, token);
      setRecentConstructionReports(rows);
    } catch (err: any) {
      setRecentConstructionReports([]);
      if (err?.status !== 403) {
        setError(err.message ?? "Failed to load recent construction reports");
      }
    }
  }

  async function loadWikiLibraryFiles(search?: string) {
    try {
      const query = search && search.trim() ? `?q=${encodeURIComponent(search.trim())}` : "";
      const files = await apiFetch<WikiLibraryFile[]>(`/wiki/library/files${query}`, token);
      setWikiFiles(files);
    } catch (err: any) {
      setError(err.message ?? "Failed to load wiki files");
    }
  }

  async function loadNotifications() {
    if (!token) return;
    try {
      const data = await apiFetch<AppNotification[]>("/notifications", token);
      // Diff against already-seen IDs so we only pop a browser notification for
      // entries that arrived since the last fetch (not the whole history on load).
      // `hadPrevious` is checked BEFORE updating the ref so the initial load
      // (empty ref) never triggers browser popups.
      const hadPrevious = prevNotifIdsRef.current.size > 0;
      const newItems = data.filter((n) => !prevNotifIdsRef.current.has(n.id));
      prevNotifIdsRef.current = new Set(data.map((n) => n.id));

      if (hadPrevious && newItems.length > 0) {
        newItems.forEach((n) => {
          const title = language === "de" ? "Neue Aufgabe" : "New task";
          const body = n.actor_name ? `${n.actor_name}: ${n.message}` : n.message;
          showBrowserNotification(title, { body, icon: "/icon-192.png" });
        });
      }

      setNotifications(data);
    } catch {
      // Notifications are non-critical.
    }
  }

  async function markAllNotificationsRead() {
    if (!token) return;
    try {
      await apiFetch<{ marked_read: number }>("/notifications/read-all", token, {
        method: "PATCH",
      });
      const readAt = new Date().toISOString();
      setNotifications((current) =>
        current.map((entry) => ({ ...entry, read_at: entry.read_at ?? readAt })),
      );
    } catch {
      // Notifications are non-critical.
    }
  }

  function isThreadArchived(thread: Thread | null | undefined) {
    if (!thread) return false;
    if (thread.is_archived) return true;
    return String(thread.status || "").trim().toLowerCase() === "archived";
  }

  async function loadThreads() {
    try {
      const data = await apiFetch<Thread[]>("/threads", token);
      setThreads(data);
      if (data.length > 0 && !data.some((x) => x.id === activeThreadId)) {
        setActiveThreadId(data[0].id);
      }
      if (data.length === 0) setActiveThreadId(null);
    } catch (err: any) {
      if (err?.status === 403 && mainView !== "messages") return;
      setError(err.message ?? "Failed to load threads");
    }
  }

  async function loadArchivedThreads() {
    try {
      const data = await apiFetch<Thread[]>("/threads?include_archived=true", token);
      setArchivedThreads(data.filter((thread) => isThreadArchived(thread)));
    } catch (err: any) {
      setArchivedThreads([]);
      setError(err.message ?? "Failed to load archived threads");
    }
  }

  async function loadMessages(threadId: number) {
    try {
      setMessages(await apiFetch<Message[]>(`/threads/${threadId}/messages`, token));
    } catch (err: any) {
      setError(err.message ?? "Failed to load messages");
    }
  }

  async function refreshTimeData() {
    try {
      const currentDefs = monthWeekDefsRef.current;
      // Managers see ALL users' time entries by default when no user_id is
      // sent (backend guard at time_tracking.py:1679). That aggregates
      // everyone into the Time-page calendar, which is wrong — the user
      // expects "their own hours" unless they explicitly pick someone in
      // the employee picker. Default to the logged-in user's id so the
      // calendar stays scoped, matching what non-managers see.
      const effectiveTimeUserId: number | null =
        mainView === "time" && isTimeManager
          ? timeTargetUserId
            ? Number(timeTargetUserId)
            : user?.id ?? null
          : null;
      const userQuery = effectiveTimeUserId != null ? `&user_id=${effectiveTimeUserId}` : "";
      const currentQuery = effectiveTimeUserId != null ? `?user_id=${effectiveTimeUserId}` : "";
      const vacationQuery = effectiveTimeUserId != null ? `?user_id=${effectiveTimeUserId}` : "";
      const schoolQuery = effectiveTimeUserId != null ? `?user_id=${effectiveTimeUserId}` : "";
      const entriesRangeQuery =
        timeEntriesStartDate && timeEntriesEndDate
          ? `&start_date=${timeEntriesStartDate}&end_date=${timeEntriesEndDate}`
          : "";
      const monthISO = monthCursorISORef.current;
      const timesheetRequests =
        mainView === "time"
          ? currentDefs.map((row) =>
              apiFetch<TimesheetSummary>(`/time/timesheet?period=weekly&day=${row.weekStart}${userQuery}`, token),
            )
          : [];
      // One extra request for the strict calendar-month total (avoids double-counting
      // days from adjacent months that bleed into the first/last ISO week of the month).
      const monthlyTimesheetRequest =
        mainView === "time"
          ? apiFetch<TimesheetSummary>(`/time/timesheet?period=monthly&day=${monthISO}-01${userQuery}`, token)
          : Promise.resolve(null);
      const [current, entries, vacationRows, schoolRows, monthlySheet, ...timesheetRows] = await Promise.all([
        apiFetch<TimeCurrent>(`/time/current${currentQuery}`, token),
        apiFetch<TimeEntry[]>(`/time/entries?period=weekly${entriesRangeQuery}${userQuery}`, token),
        apiFetch<VacationRequest[]>(`/time/vacation-requests${vacationQuery}`, token),
        apiFetch<SchoolAbsence[]>(`/time/school-absences${schoolQuery}`, token),
        monthlyTimesheetRequest,
        ...timesheetRequests,
      ]);
      setTimeCurrent(current);
      setTimeEntries(entries);
      setVacationRequests(vacationRows);
      setSchoolAbsences(schoolRows);
      if (mainView === "time") {
        const monthly = monthlySheet as TimesheetSummary | null;
        setMonthlyWorkedHours(Number((monthly?.total_hours ?? 0).toFixed(2)));
        const requiredHours = current.required_daily_hours > 0 ? current.required_daily_hours : 8;
        const rows = currentDefs.map((row, index) => {
          const timesheet = timesheetRows[index] as TimesheetSummary | undefined;
          const workedHours = Number(timesheet?.total_hours ?? 0);
          return {
            ...row,
            workedHours: Number(workedHours.toFixed(2)),
            requiredHours: Number((row.weekdaysInWeek * requiredHours).toFixed(2)),
          };
        });
        setTimeMonthRows(rows);
      } else {
        setTimeMonthRows([]);
        setMonthlyWorkedHours(0);
      }
    } catch (err: any) {
      setError(err.message ?? "Failed to load time data");
    }
  }

  async function onLogin(event: FormEvent) {
    event.preventDefault();
    setError("");
    setNotice("");
    try {
      try {
        const stale = localStorage.getItem("smpl_token");
        if (stale && !isLikelyJwtToken(stale)) localStorage.removeItem("smpl_token");
      } catch {
        // no-op
      }

      const body = JSON.stringify({ email: email.trim(), password });
      const requestInit: RequestInit = {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        credentials: "include",
      };

      let response: Response;
      try {
        response = await fetch("/api/auth/login", requestInit);
      } catch (innerErr: any) {
        const message = String(innerErr?.message ?? "");
        if (message.toLowerCase().includes("expected pattern")) {
          const absoluteLoginUrl = `${window.location.protocol}//${window.location.host}/api/auth/login`;
          response = await fetch(absoluteLoginUrl, requestInit);
        } else {
          throw innerErr;
        }
      }
      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.detail ?? "Login failed");
      }
      const newToken = response.headers.get("X-Access-Token");
      if (!newToken) throw new Error("No access token returned");
      const cleanToken = newToken.trim();
      if (!isLikelyJwtToken(cleanToken)) {
        throw new Error(
          language === "de" ? "Ungültiges Token vom Server empfangen" : "Received invalid token from server",
        );
      }
      setToken(cleanToken);
      localStorage.setItem("smpl_token", cleanToken);
      const me = (await response.json()) as User;
      setUser(me);
    } catch (err: any) {
      const message = String(err?.message ?? "");
      if (message.toLowerCase().includes("expected pattern")) {
        setError(
          language === "de"
            ? "Anmeldung fehlgeschlagen (Browser-URL-Fehler). Bitte Seite neu laden und erneut versuchen."
            : "Login failed (browser URL pattern error). Please reload and try again.",
        );
      } else {
        setError(message || "Login failed");
      }
    }
  }

  function resetPublicAuthRoute() {
    setPublicAuthMode(null);
    setPublicToken("");
    setPublicFullName("");
    setPublicEmail("");
    setPublicNewPassword("");
    setPublicConfirmPassword("");
    if (window.location.pathname !== "/") {
      window.history.replaceState({}, "", "/");
    }
  }

  async function submitPublicInviteAccept(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!publicToken) {
      setError(language === "de" ? "Einladungstoken fehlt." : "Invite token is missing.");
      return;
    }
    if (publicNewPassword.length < 8) {
      setError(language === "de" ? "Passwort muss mindestens 8 Zeichen haben." : "Password must be at least 8 characters.");
      return;
    }
    if (publicNewPassword !== publicConfirmPassword) {
      setError(language === "de" ? "Passwörter stimmen nicht überein." : "Passwords do not match.");
      return;
    }
    try {
      const accepted = await apiFetch<User>("/auth/invites/accept", null, {
        method: "POST",
        body: JSON.stringify({
          token: publicToken,
          new_password: publicNewPassword,
          full_name: publicFullName.trim() || null,
          email: publicEmail.trim() || null,
        }),
      });
      setEmail(accepted.email);
      setPassword("");
      resetPublicAuthRoute();
      setNotice(language === "de" ? "Einladung akzeptiert. Bitte anmelden." : "Invite accepted. Please sign in.");
    } catch (err: any) {
      setError(err.message ?? "Failed to accept invite");
    }
  }

  async function submitPublicPasswordReset(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!publicToken) {
      setError(language === "de" ? "Reset-Token fehlt." : "Reset token is missing.");
      return;
    }
    if (publicNewPassword.length < 8) {
      setError(language === "de" ? "Passwort muss mindestens 8 Zeichen haben." : "Password must be at least 8 characters.");
      return;
    }
    if (publicNewPassword !== publicConfirmPassword) {
      setError(language === "de" ? "Passwörter stimmen nicht überein." : "Passwords do not match.");
      return;
    }
    try {
      await apiFetch("/auth/password-reset/confirm", null, {
        method: "POST",
        body: JSON.stringify({
          token: publicToken,
          new_password: publicNewPassword,
        }),
      });
      resetPublicAuthRoute();
      setNotice(language === "de" ? "Passwort aktualisiert. Bitte anmelden." : "Password updated. Please sign in.");
    } catch (err: any) {
      setError(err.message ?? "Failed to reset password");
    }
  }

  function openCreateProjectModal() {
    setProjectForm(EMPTY_PROJECT_FORM);
    setProjectFormBase(null);
    setProjectEditExpectedLastUpdatedAt(null);
    setProjectModalMode("create");
  }

  function openEditProjectModal(project: Project) {
    const assignedClassTemplateIds = (projectClassTemplatesByProjectId[project.id] ?? []).map((row) => row.id);
    const nextForm: ProjectFormState = {
      project_number: project.project_number ?? "",
      name: project.name ?? "",
      description: project.description ?? "",
      status: project.status ?? "active",
      last_state:
        project.last_state ??
        (typeof project.extra_attributes?.Notiz === "string" ? project.extra_attributes.Notiz : ""),
      last_status_at: isoToLocalDateTimeInput(project.last_status_at),
      customer_id: project.customer_id ?? null,
      customer_name: project.customer_name ?? "",
      customer_address: project.customer_address ?? "",
      construction_site_address: project.construction_site_address ?? "",
      customer_contact: project.customer_contact ?? "",
      customer_email: project.customer_email ?? "",
      customer_phone: project.customer_phone ?? "",
      // When the saved record already has a site address distinct from the
      // customer address, keep the advanced field visible on reopen.
      use_separate_site_address: Boolean(
        project.construction_site_address &&
          project.construction_site_address !== project.customer_address,
      ),
      site_access_type: normalizeProjectSiteAccessType(project.site_access_type),
      site_access_note: project.site_access_note ?? "",
      class_template_ids: assignedClassTemplateIds,
    };
    setProjectForm(nextForm);
    setProjectFormBase(nextForm);
    setProjectEditExpectedLastUpdatedAt(project.last_updated_at ?? null);
    setProjectModalMode("edit");
    if (!projectClassTemplatesByProjectId[project.id]) {
      void loadProjectClassTemplates(project.id).then((rows) => {
        const resolvedClassTemplateIds = rows.map((entry) => entry.id);
        setProjectForm((current) => {
          if (current.project_number !== (project.project_number ?? "")) return current;
          return { ...current, class_template_ids: resolvedClassTemplateIds };
        });
        setProjectFormBase((current) => {
          if (!current) return current;
          if (current.project_number !== (project.project_number ?? "")) return current;
          return { ...current, class_template_ids: resolvedClassTemplateIds };
        });
      });
    }
  }

  function closeProjectModal() {
    setProjectFormBase(null);
    setProjectEditExpectedLastUpdatedAt(null);
    setProjectModalMode(null);
  }

  function onProjectModalBackdropPointerDown(event: PointerEvent<HTMLDivElement>) {
    projectModalBackdropPointerDownRef.current = event.target === event.currentTarget;
  }

  function onProjectModalBackdropPointerUp(event: PointerEvent<HTMLDivElement>) {
    const startedOnBackdrop = projectModalBackdropPointerDownRef.current;
    projectModalBackdropPointerDownRef.current = false;
    if (!startedOnBackdrop) return;
    if (event.target !== event.currentTarget) return;
    closeProjectModal();
  }

  function resetProjectModalBackdropPointerState() {
    projectModalBackdropPointerDownRef.current = false;
  }

  function getTaskAssigneeIds(task: Task): number[] {
    if (Array.isArray(task.assignee_ids) && task.assignee_ids.length > 0) return task.assignee_ids;
    if (task.assignee_id) return [task.assignee_id];
    return [];
  }

  function isTaskAssignedToCurrentUser(task: Task): boolean {
    if (!user) return false;
    return getTaskAssigneeIds(task).includes(user.id);
  }

  function menuUserNameById(userId: number, fallbackName?: string | null): string {
    const mapped = compactMenuUserNamesById.get(userId);
    if (mapped) return mapped;
    const fallback = compactNameLabel(String(fallbackName ?? ""), false);
    return fallback || `#${userId}`;
  }

  function getTaskAssigneeLabel(task: Task): string {
    const ids = getTaskAssigneeIds(task);
    if (ids.length === 0) return "-";
    return ids
      .map((id) =>
        menuUserNameById(
          id,
          assignableUsersById.get(id)?.display_name ??
            assignableUsersById.get(id)?.full_name ??
            adminUsersById.get(id)?.display_name ??
            adminUsersById.get(id)?.full_name,
        ),
      )
      .join(", ");
  }

  function projectTitleParts(project: Project | null | undefined): ProjectTitleParts {
    if (!project) return { title: "-", subtitle: "" };
    return formatProjectTitleParts(project.project_number, project.customer_name, project.name, project.id);
  }

  function projectTitle(project: Project | null | undefined): string {
    return projectTitleParts(project).title;
  }

  function taskProjectTitleParts(task: Task): ProjectTitleParts {
    const directProject = projectsById.get(task.project_id);
    if (directProject) return projectTitleParts(directProject);
    const overviewProject = overviewProjectsById.get(task.project_id);
    if (overviewProject) {
      return formatProjectTitleParts(
        overviewProject.project_number,
        overviewProject.customer_name,
        overviewProject.name,
        overviewProject.id,
      );
    }
    return formatProjectTitleParts("", "", "", task.project_id);
  }

  function recentReportProjectTitleParts(report: RecentConstructionReport): ProjectTitleParts {
    const projectId = Number(report.project_id ?? 0);
    const project = projectId > 0 ? projectsById.get(projectId) : null;
    return formatProjectTitleParts(
      report.project_number ?? project?.project_number,
      project?.customer_name ?? null,
      report.project_name ?? project?.name ?? null,
      report.project_id ?? null,
    );
  }

  function threadProjectTitleParts(thread: Thread): ProjectTitleParts {
    const projectId = Number(thread.project_id ?? 0);
    if (projectId > 0) {
      const project = projectsById.get(projectId);
      if (project) {
        return formatProjectTitleParts(project.project_number, project.customer_name, project.name, project.id);
      }
    }
    return { title: String(thread.project_name ?? "").trim(), subtitle: "" };
  }

  function ensureProjectVisibleById(projectId: number) {
    if (projectsById.has(projectId)) return;
    const fallback = overviewProjectsById.get(projectId);
    setProjects((current) => {
      if (current.some((project) => project.id === projectId)) return current;
      return [
        {
          id: fallback?.id ?? projectId,
          project_number: fallback?.project_number || String(projectId),
          name: fallback?.name || `Project ${projectId}`,
          status: fallback?.status || "active",
          customer_name: fallback?.customer_name ?? null,
        },
        ...current,
      ];
    });
  }

  function openProjectById(
    projectId: number,
    backView: MainView | null = "my_tasks",
    tab: ProjectTab = "overview",
  ) {
    ensureProjectVisibleById(projectId);
    setMyTasksBackProjectId(null);
    setProjectBackView(backView);
    setActiveProjectId(projectId);
    setProjectTab(tab);
    setMainView("project");
  }

  function openProjectGanttById(projectId: number, backView: MainView | null = "planning") {
    openProjectById(projectId, backView, "gantt");
  }

  function projectSearchLabel(project: Project): string {
    return projectTitle(project);
  }

  async function exportTaskCalendar(task: Task) {
    const taskAssignees = getTaskAssigneeIds(task);
    if (!user || !taskAssignees.includes(user.id)) {
      setError(language === "de" ? "Nur zugewiesene Mitarbeiter können den Termin exportieren" : "Only assigned users can export this task");
      return;
    }

    const project = projectsById.get(task.project_id);
    const dueDateIso = task.due_date || formatDateISOLocal(new Date());
    const startTime = formatTaskStartTime(task.start_time || "") || "";
    const endTime = formatTaskStartTime(task.end_time || "") || "";
    const dtStamp = toIcsUtcDateTime(new Date());
    const uid = `task-${task.id}-${Date.now()}@smpl.local`;

    let eventDateLines = "";
    if (startTime) {
      const startAt = new Date(`${dueDateIso}T${startTime}:00`);
      const endAt = endTime
        ? new Date(`${dueDateIso}T${endTime}:00`)
        : new Date(startAt.getTime() + 60 * 60 * 1000);
      eventDateLines = `DTSTART:${toIcsUtcDateTime(startAt)}\r\nDTEND:${toIcsUtcDateTime(endAt)}`;
    } else {
      const startDay = new Date(`${dueDateIso}T00:00:00`);
      const endDay = new Date(startDay);
      endDay.setDate(endDay.getDate() + 1);
      eventDateLines = `DTSTART;VALUE=DATE:${toIcsDate(startDay)}\r\nDTEND;VALUE=DATE:${toIcsDate(endDay)}`;
    }

    const summaryBase = project ? `${project.project_number} - ${task.title}` : task.title;
    const projectLabel = project
      ? formatProjectTitle(project.project_number, project.customer_name, project.name, project.id)
      : "";
    const materialsSummary = taskMaterialsDisplay(task.materials_required, "en");
    const lines: string[] = [
      `Task ID: #${task.id}`,
      `Status: ${taskDisplayStatus(task, todayIso)}`,
      project ? `Project: ${projectLabel}` : `Project ID: ${task.project_id}`,
      project?.customer_name ? `Customer: ${project.customer_name}` : "",
      `Due: ${task.due_date ?? "-"}`,
      startTime ? `Time: ${formatTaskTimeRange(task)}` : "",
      task.description ? `Info: ${task.description}` : "",
      materialsSummary ? `Materials: ${materialsSummary}` : "",
      task.storage_box_number ? `Storage box: ${task.storage_box_number}` : "",
      `Assignees: ${getTaskAssigneeLabel(task)}`,
    ].filter((line) => line.length > 0);

    const location = projectLocationAddress(project);
    const ics = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//SMPL//Workflow//EN",
      "CALSCALE:GREGORIAN",
      "METHOD:PUBLISH",
      "BEGIN:VEVENT",
      `UID:${uid}`,
      `DTSTAMP:${dtStamp}`,
      eventDateLines,
      `SUMMARY:${escapeIcs(summaryBase)}`,
      `DESCRIPTION:${escapeIcs(lines.join("\n"))}`,
      location ? `LOCATION:${escapeIcs(location)}` : "",
      "END:VEVENT",
      "END:VCALENDAR",
    ]
      .filter((line) => line.length > 0)
      .join("\r\n");

    const fileNameSource = `${project?.project_number ?? "task"}-${task.id}`.replace(/[^a-zA-Z0-9_-]+/g, "-");
    const blob = new Blob([ics], { type: "text/calendar;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    try {
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${fileNameSource}.ics`;
      anchor.rel = "noopener";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setNotice(language === "de" ? "Kalenderdatei exportiert" : "Calendar file exported");
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  function userNameById(userId: number): string {
    if (!user) return "";
    if (userId === user.id) return language === "de" ? "Ich" : "Me";
    return menuUserNameById(
      userId,
      assignableUsersById.get(userId)?.display_name ??
        assignableUsersById.get(userId)?.full_name ??
        adminUsersById.get(userId)?.display_name ??
        adminUsersById.get(userId)?.full_name,
    );
  }

  function userInitialsById(userId: number) {
    if (!user) return "";
    if (userId === user.id) return userInitials;
    return initialsFromName(userNameById(userId), "U");
  }

  function userAvatarVersionById(userId: number) {
    if (!user) return "0";
    if (userId === user.id) return user.avatar_updated_at || avatarVersionKey;
    return (
      assignableUsersById.get(userId)?.avatar_updated_at ||
      adminUsersById.get(userId)?.avatar_updated_at ||
      "0"
    );
  }

  function userHasAvatar(userId: number) {
    if (!user) return false;
    if (userId === user.id) return Boolean(user.avatar_updated_at);
    return Boolean(assignableUsersById.get(userId)?.avatar_updated_at || adminUsersById.get(userId)?.avatar_updated_at);
  }

  function openTaskModal(defaults?: { projectId?: number | null; dueDate?: string; taskType?: TaskType }) {
    const fallbackProjectId = defaults?.projectId ?? null;
    const fallbackDueDate = defaults?.dueDate ?? "";
    const fallbackProject = projects.find((project) => project.id === fallbackProjectId) ?? null;
    const nextForm = buildTaskModalFormState({
      projectId: fallbackProjectId,
      dueDate: fallbackDueDate,
      projectQuery: fallbackProject ? projectSearchLabel(fallbackProject) : "",
      taskType: defaults?.taskType,
    });
    setTaskModalForm(nextForm);
    setTaskModalOverlapWarning(null);
    setTaskModalMaterialRows(parseReportMaterialRows(nextForm.materials_required, "materials"));
    setTaskModalOpen(true);
  }

  function closeTaskModal() {
    setTaskModalOpen(false);
    setTaskModalOverlapWarning(null);
  }

  function onTaskModalBackdropPointerDown(event: PointerEvent<HTMLDivElement>) {
    taskModalBackdropPointerDownRef.current = event.target === event.currentTarget;
  }

  function onTaskModalBackdropPointerUp(event: PointerEvent<HTMLDivElement>) {
    const startedOnBackdrop = taskModalBackdropPointerDownRef.current;
    taskModalBackdropPointerDownRef.current = false;
    if (!startedOnBackdrop) return;
    if (event.target !== event.currentTarget) return;
    closeTaskModal();
  }

  function resetTaskModalBackdropPointerState() {
    taskModalBackdropPointerDownRef.current = false;
  }

  function updateTaskModalField<K extends keyof TaskModalState>(field: K, value: TaskModalState[K]) {
    setTaskModalOverlapWarning(null);
    setTaskModalForm((current) => ({ ...current, [field]: value }));
  }

  function updateTaskModalMaterialRow(
    index: number,
    field: keyof Omit<ReportMaterialRow, "id">,
    value: string,
  ) {
    setTaskModalMaterialRows((current) => {
      const next = [...current];
      next[index] = { ...next[index], [field]: value };
      setTaskModalForm((form) => ({ ...form, materials_required: serializeTaskMaterialRows(next) }));
      return next;
    });
  }

  function addTaskModalMaterialRow() {
    setTaskModalMaterialRows((current) => {
      const next = [...current, createReportMaterialRow("materials")];
      setTaskModalForm((form) => ({ ...form, materials_required: serializeTaskMaterialRows(next) }));
      return next;
    });
  }

  function removeTaskModalMaterialRow(index: number) {
    setTaskModalMaterialRows((current) => {
      const next =
        current.length <= 1 ? [createReportMaterialRow("materials")] : current.filter((_, rowIndex) => rowIndex !== index);
      setTaskModalForm((form) => ({ ...form, materials_required: serializeTaskMaterialRows(next) }));
      return next;
    });
  }

  function selectTaskModalClassTemplate(classTemplateId: string) {
    const normalized = classTemplateId.trim();
    const selected = taskModalProjectClassTemplates.find((entry) => String(entry.id) === normalized) ?? null;
    const importedMaterials = selected ? classTemplateMaterialsText(selected, language) : "";
    const importedRows = parseReportMaterialRows(importedMaterials, "materials");
    setTaskModalOverlapWarning(null);
    setTaskModalForm((current) => ({
      ...current,
      class_template_id: normalized,
      materials_required: selected ? importedMaterials : current.materials_required,
    }));
    if (selected) setTaskModalMaterialRows(importedRows);
  }

  function addTaskModalAssignee(assigneeId: number) {
    setTaskModalOverlapWarning(null);
    setTaskModalForm((current) => {
      if (current.assignee_ids.includes(assigneeId)) {
        return { ...current, assignee_query: "" };
      }
      return {
        ...current,
        assignee_ids: [...current.assignee_ids, assigneeId],
        assignee_query: "",
      };
    });
  }

  function removeTaskModalAssignee(assigneeId: number) {
    setTaskModalOverlapWarning(null);
    setTaskModalForm((current) => ({
      ...current,
      assignee_ids: current.assignee_ids.filter((id) => id !== assigneeId),
    }));
  }

  function addFirstMatchingTaskModalAssignee() {
    const first = taskModalAssigneeSuggestions[0];
    if (!first) return;
    addTaskModalAssignee(first.id);
  }

  function openTaskEditModal(task: Task) {
    const nextForm = buildTaskEditFormState(task);
    setTaskEditForm(nextForm);
    setTaskEditFormBase(nextForm);
    setTaskEditOverlapWarning(null);
    setTaskEditMaterialRows(parseReportMaterialRows(nextForm.materials_required, "materials"));
    setTaskEditExpectedUpdatedAt(task.updated_at ?? null);
    setTaskEditModalOpen(true);
  }

  function closeTaskEditModal() {
    setTaskEditModalOpen(false);
    setTaskEditFormBase(null);
    setTaskEditExpectedUpdatedAt(null);
    setTaskEditOverlapWarning(null);
    setTaskEditForm(buildTaskEditFormState());
    setTaskEditMaterialRows([createReportMaterialRow("materials")]);
  }

  function onTaskEditModalBackdropPointerDown(event: PointerEvent<HTMLDivElement>) {
    taskEditModalBackdropPointerDownRef.current = event.target === event.currentTarget;
  }

  function onTaskEditModalBackdropPointerUp(event: PointerEvent<HTMLDivElement>) {
    const startedOnBackdrop = taskEditModalBackdropPointerDownRef.current;
    taskEditModalBackdropPointerDownRef.current = false;
    if (!startedOnBackdrop) return;
    if (event.target !== event.currentTarget) return;
    closeTaskEditModal();
  }

  function resetTaskEditModalBackdropPointerState() {
    taskEditModalBackdropPointerDownRef.current = false;
  }

  function updateTaskEditField<K extends keyof TaskEditFormState>(field: K, value: TaskEditFormState[K]) {
    setTaskEditOverlapWarning(null);
    setTaskEditForm((current) => ({ ...current, [field]: value }));
  }

  function updateTaskEditMaterialRow(
    index: number,
    field: keyof Omit<ReportMaterialRow, "id">,
    value: string,
  ) {
    setTaskEditMaterialRows((current) => {
      const next = [...current];
      next[index] = { ...next[index], [field]: value };
      setTaskEditForm((form) => ({ ...form, materials_required: serializeTaskMaterialRows(next) }));
      return next;
    });
  }

  function addTaskEditMaterialRow() {
    setTaskEditMaterialRows((current) => {
      const next = [...current, createReportMaterialRow("materials")];
      setTaskEditForm((form) => ({ ...form, materials_required: serializeTaskMaterialRows(next) }));
      return next;
    });
  }

  function removeTaskEditMaterialRow(index: number) {
    setTaskEditMaterialRows((current) => {
      const next =
        current.length <= 1 ? [createReportMaterialRow("materials")] : current.filter((_, rowIndex) => rowIndex !== index);
      setTaskEditForm((form) => ({ ...form, materials_required: serializeTaskMaterialRows(next) }));
      return next;
    });
  }

  function selectTaskEditClassTemplate(classTemplateId: string) {
    const normalized = classTemplateId.trim();
    const selected = taskEditProjectClassTemplates.find((entry) => String(entry.id) === normalized) ?? null;
    const importedMaterials = selected ? classTemplateMaterialsText(selected, language) : "";
    const importedRows = parseReportMaterialRows(importedMaterials, "materials");
    setTaskEditOverlapWarning(null);
    setTaskEditForm((current) => ({
      ...current,
      class_template_id: normalized,
      materials_required: selected ? importedMaterials : current.materials_required,
    }));
    if (selected) setTaskEditMaterialRows(importedRows);
  }

  function addTaskEditAssignee(assigneeId: number) {
    setTaskEditOverlapWarning(null);
    setTaskEditForm((current) => {
      if (current.assignee_ids.includes(assigneeId)) {
        return { ...current, assignee_query: "" };
      }
      return {
        ...current,
        assignee_ids: [...current.assignee_ids, assigneeId],
        assignee_query: "",
      };
    });
  }

  function removeTaskEditAssignee(assigneeId: number) {
    setTaskEditOverlapWarning(null);
    setTaskEditForm((current) => ({
      ...current,
      assignee_ids: current.assignee_ids.filter((id) => id !== assigneeId),
    }));
  }

  function addFirstMatchingTaskEditAssignee() {
    const first = taskEditAssigneeSuggestions[0];
    if (!first) return;
    addTaskEditAssignee(first.id);
  }

  function selectTaskModalProject(project: Project) {
    setTaskModalForm((current) => ({
      ...current,
      project_id: String(project.id),
      project_query: projectSearchLabel(project),
      class_template_id: "",
      create_project_from_task: false,
      new_project_name: "",
      new_project_number: "",
    }));
  }

  function addOfficeTaskProjectFilter(projectId: number) {
    setOfficeTaskProjectFilterIds((current) => {
      if (current.includes(projectId)) return current;
      return [...current, projectId];
    });
    setOfficeTaskProjectFilterQuery("");
  }

  function removeOfficeTaskProjectFilter(projectId: number) {
    setOfficeTaskProjectFilterIds((current) => current.filter((entry) => entry !== projectId));
  }

  function addFirstMatchingOfficeTaskProjectFilter() {
    const first = officeTaskProjectSuggestions[0];
    if (!first) return;
    addOfficeTaskProjectFilter(first.id);
  }

  function updateProjectFormField<K extends keyof ProjectFormState>(field: K, value: ProjectFormState[K]) {
    setProjectForm((current) => ({ ...current, [field]: value }));
  }

  function updateProjectSiteAccessType(value: string) {
    const normalized = normalizeProjectSiteAccessType(value);
    setProjectForm((current) => ({
      ...current,
      site_access_type: normalized,
      site_access_note: projectSiteAccessRequiresNote(normalized) ? current.site_access_note : "",
    }));
  }

  function toggleProjectClassTemplate(templateId: number, checked: boolean) {
    setProjectForm((current) => {
      const currentIds = new Set(current.class_template_ids);
      if (checked) {
        currentIds.add(templateId);
      } else {
        currentIds.delete(templateId);
      }
      return { ...current, class_template_ids: [...currentIds] };
    });
  }

  function updateProjectFinanceFormField(field: keyof ProjectFinanceFormState, value: string) {
    setProjectFinanceForm((current) => ({ ...current, [field]: value }));
  }

  function financeFormPayload(options?: { changedOnly?: boolean }): Record<string, number | null> {
    const toNumberOrNull = (value: string): number | null => {
      const normalized = value.trim().replace(",", ".");
      if (!normalized) return null;
      const parsed = Number(normalized);
      return Number.isFinite(parsed) ? parsed : null;
    };
    const payload = {
      order_value_net: toNumberOrNull(projectFinanceForm.order_value_net),
      down_payment_35: toNumberOrNull(projectFinanceForm.down_payment_35),
      main_components_50: toNumberOrNull(projectFinanceForm.main_components_50),
      final_invoice_15: toNumberOrNull(projectFinanceForm.final_invoice_15),
      planned_costs: toNumberOrNull(projectFinanceForm.planned_costs),
      actual_costs: toNumberOrNull(projectFinanceForm.actual_costs),
      contribution_margin: toNumberOrNull(projectFinanceForm.contribution_margin),
    };
    if (!options?.changedOnly) return payload;
    const currentValues = {
      order_value_net: projectFinance?.order_value_net ?? null,
      down_payment_35: projectFinance?.down_payment_35 ?? null,
      main_components_50: projectFinance?.main_components_50 ?? null,
      final_invoice_15: projectFinance?.final_invoice_15 ?? null,
      planned_costs: projectFinance?.planned_costs ?? null,
      actual_costs: projectFinance?.actual_costs ?? null,
      contribution_margin: projectFinance?.contribution_margin ?? null,
    };
    const changedPayload: Record<string, number | null> = {};
    (Object.keys(payload) as (keyof typeof payload)[]).forEach((field) => {
      if (payload[field] !== currentValues[field]) {
        changedPayload[field] = payload[field];
      }
    });
    return changedPayload;
  }

  function validateTimeInputOrSetError(value: string, required: boolean): string | null {
    const normalized = normalizeTimeHHMM(value);
    if (!normalized) {
      if (required) {
        setError(language === "de" ? "Startzeit ist erforderlich" : "Start time is required");
      }
      return null;
    }
    if (!isValidTimeHHMM(normalized)) {
      setError(language === "de" ? "Bitte Zeit im Format HH:MM eingeben" : "Please use time format HH:MM");
      return null;
    }
    return normalized;
  }

  function validateEstimatedHoursOrSetError(value: string): number | null {
    const normalized = value.trim().replace(",", ".");
    if (!normalized) return null;
    const parsed = Number(normalized);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      setError(language === "de" ? "Bitte eine gültige Dauer eingeben" : "Please enter a valid duration");
      return null;
    }
    const halfHourSteps = Math.round(parsed * 2);
    if (Math.abs((halfHourSteps / 2) - parsed) > 1e-9) {
      setError(language === "de" ? "Die Dauer muss in 0,5-Stunden-Schritten angegeben werden" : "Duration must use 0.5-hour increments");
      return null;
    }
    if (parsed >= 24) {
      setError(language === "de" ? "Die Dauer muss unter 24 Stunden liegen" : "Duration must be under 24 hours");
      return null;
    }
    return halfHourSteps / 2;
  }

  function getTaskOverlapConflictDetail(error: unknown): TaskOverlapConflictDetail | null {
    if (!(error instanceof ApiError)) return null;
    const detail = error.detail;
    if (!detail || typeof detail !== "object") return null;
    const candidate = detail as Partial<TaskOverlapConflictDetail>;
    if (candidate.code !== "task_overlap" || !Array.isArray(candidate.overlaps)) return null;
    return {
      code: "task_overlap",
      message: String(candidate.message || ""),
      overlaps: candidate.overlaps,
    };
  }

  function updateProjectTaskFormField<K extends keyof ProjectTaskFormState>(
    field: K,
    value: ProjectTaskFormState[K],
  ) {
    setProjectTaskForm((current) => ({ ...current, [field]: value }));
  }

  function updateProjectTaskMaterialRow(
    index: number,
    field: keyof Omit<ReportMaterialRow, "id">,
    value: string,
  ) {
    setProjectTaskMaterialRows((current) => {
      const next = [...current];
      next[index] = { ...next[index], [field]: value };
      setProjectTaskForm((form) => ({ ...form, materials_required: serializeTaskMaterialRows(next) }));
      return next;
    });
  }

  function addProjectTaskMaterialRow() {
    setProjectTaskMaterialRows((current) => {
      const next = [...current, createReportMaterialRow("materials")];
      setProjectTaskForm((form) => ({ ...form, materials_required: serializeTaskMaterialRows(next) }));
      return next;
    });
  }

  function removeProjectTaskMaterialRow(index: number) {
    setProjectTaskMaterialRows((current) => {
      const next =
        current.length <= 1 ? [createReportMaterialRow("materials")] : current.filter((_, rowIndex) => rowIndex !== index);
      setProjectTaskForm((form) => ({ ...form, materials_required: serializeTaskMaterialRows(next) }));
      return next;
    });
  }

  function selectProjectTaskClassTemplate(classTemplateId: string) {
    const normalized = classTemplateId.trim();
    const selected = activeProjectClassTemplates.find((entry) => String(entry.id) === normalized) ?? null;
    const importedMaterials = selected ? classTemplateMaterialsText(selected, language) : "";
    const importedRows = parseReportMaterialRows(importedMaterials, "materials");
    setProjectTaskForm((current) => ({
      ...current,
      class_template_id: normalized,
      materials_required: selected ? importedMaterials : current.materials_required,
    }));
    if (selected) setProjectTaskMaterialRows(importedRows);
  }

  function addProjectTaskAssignee(assigneeId: number) {
    setProjectTaskForm((current) => {
      if (current.assignee_ids.includes(assigneeId)) {
        return { ...current, assignee_query: "" };
      }
      return {
        ...current,
        assignee_ids: [...current.assignee_ids, assigneeId],
        assignee_query: "",
      };
    });
  }

  function removeProjectTaskAssignee(assigneeId: number) {
    setProjectTaskForm((current) => ({
      ...current,
      assignee_ids: current.assignee_ids.filter((id) => id !== assigneeId),
    }));
  }

  function addFirstMatchingProjectTaskAssignee() {
    const first = projectTaskAssigneeSuggestions[0];
    if (!first) return;
    addProjectTaskAssignee(first.id);
  }

  async function submitProjectForm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const payload = projectPayloadFromForm(projectForm);
    if (!payload.project_number || !payload.name) {
      setError(language === "de" ? "Projektnummer und Name sind erforderlich" : "Project number and name are required");
      return;
    }

    try {
      if (projectModalMode === "create") {
        const createdProject = await apiFetch<Project>("/projects", token, {
          method: "POST",
          body: JSON.stringify(payload),
        });
        setActiveProjectId(createdProject.id);
        setProjectBackView(null);
        setMainView("project");
        setProjectTab("overview");
        setNotice(language === "de" ? "Projekt erstellt" : "Project created");
      } else if (projectModalMode === "edit" && activeProjectId) {
        const basePayload = projectPayloadFromForm(projectFormBase ?? projectForm);
        const patchPayload: Record<string, unknown> = {};
        (
          [
            "project_number",
            "name",
            "description",
            "status",
            "last_state",
            "last_status_at",
            "customer_id",
            "customer_name",
            "customer_address",
            "construction_site_address",
            "customer_contact",
            "customer_email",
            "customer_phone",
            "site_access_type",
            "site_access_note",
            "class_template_ids",
          ] as (keyof typeof payload)[]
        ).forEach((key) => {
          if (key === "class_template_ids") {
            if (!sameNumberSet(payload.class_template_ids, basePayload.class_template_ids)) {
              patchPayload[key] = payload[key];
            }
            return;
          }
          if (payload[key] !== basePayload[key]) {
            patchPayload[key] = payload[key];
          }
        });
        if (projectEditExpectedLastUpdatedAt !== null) {
          patchPayload.expected_last_updated_at = projectEditExpectedLastUpdatedAt;
        }
        const hasChanges = Object.keys(patchPayload).some((key) => key !== "expected_last_updated_at");
        if (!hasChanges) {
          closeProjectModal();
          return;
        }
        await apiFetch<Project>(`/projects/${activeProjectId}`, token, {
          method: "PATCH",
          body: JSON.stringify(patchPayload),
        });
        setNotice(language === "de" ? "Projekt aktualisiert" : "Project updated");
      }

      closeProjectModal();
      await loadBaseData();
    } catch (err: any) {
      if (err?.status === 409) {
        setError(
          language === "de"
            ? "Projekt wurde in der Zwischenzeit geändert. Bitte neu laden und erneut speichern."
            : "Project was changed in the meantime. Please reload and save again.",
        );
        return;
      }
      setError(err.message ?? "Failed to save project");
    }
  }

  async function setProjectCritical(projectId: number, isCritical: boolean): Promise<void> {
    if (!token) return;
    try {
      const updated = await apiFetch<Project>(`/projects/${projectId}/critical`, token, {
        method: "PUT",
        body: JSON.stringify({ is_critical: isCritical }),
      });
      setProjects((prev) => prev.map((p) => (p.id === projectId ? { ...p, ...updated } : p)));
      if (activeProjectId === projectId) {
        // Activity feed surfaces the critical set/cleared event
        await loadProjectOverview(projectId);
      }
    } catch (err: any) {
      setError(err?.message ?? (language === "de" ? "Markierung fehlgeschlagen" : "Failed to update critical flag"));
    }
  }

  async function saveProjectInternalNote() {
    if (!activeProjectId) return;
    const expectedLastUpdatedAt =
      projectOverviewDetails?.project?.last_updated_at ?? activeProject?.last_updated_at ?? null;
    const payload: Record<string, unknown> = { description: projectNoteDraft };
    if (expectedLastUpdatedAt !== null) {
      payload.expected_last_updated_at = expectedLastUpdatedAt;
    }
    try {
      await apiFetch<Project>(`/projects/${activeProjectId}`, token, {
        method: "PATCH",
        body: JSON.stringify(payload),
      });
      setProjectNoteEditing(false);
      await loadBaseData();
      await loadProjectOverview(activeProjectId);
      setNotice(language === "de" ? "Notiz aktualisiert" : "Note updated");
    } catch (err: any) {
      if (err?.status === 409) {
        setError(
          language === "de"
            ? "Projekt wurde in der Zwischenzeit geändert. Bitte neu laden und erneut speichern."
            : "Project was changed in the meantime. Please reload and save again.",
        );
        return;
      }
      setError(err.message ?? "Failed to save note");
    }
  }

  async function saveProjectFinance() {
    if (!activeProjectId) return;
    const patchPayload: Record<string, unknown> = financeFormPayload({ changedOnly: true });
    if (projectFinance?.updated_at !== undefined) {
      patchPayload.expected_updated_at = projectFinance.updated_at ?? null;
    }
    const hasChanges = Object.keys(patchPayload).some((key) => key !== "expected_updated_at");
    if (!hasChanges) {
      setProjectFinanceEditing(false);
      return;
    }
    try {
      const updated = await apiFetch<ProjectFinance>(`/projects/${activeProjectId}/finance`, token, {
        method: "PATCH",
        body: JSON.stringify(patchPayload),
      });
      setProjectFinance(updated);
      setProjectFinanceForm(projectFinanceToFormState(updated));
      setProjectHoursPlannedInput(updated.planned_hours_total == null ? "" : String(updated.planned_hours_total));
      setProjectFinanceEditing(false);
      await loadBaseData();
      await loadProjectOverview(activeProjectId);
      setNotice(language === "de" ? "Finanzen aktualisiert" : "Finances updated");
    } catch (err: any) {
      if (err?.status === 409) {
        setError(
          language === "de"
            ? "Projektfinanzen wurden in der Zwischenzeit geändert. Bitte neu laden und erneut speichern."
            : "Project finances were changed in the meantime. Please reload and save again.",
        );
        return;
      }
      setError(err.message ?? "Failed to save finances");
    }
  }

  async function saveProjectHours() {
    if (!activeProjectId) return;
    const normalizedInput = projectHoursPlannedInput.trim();
    const parsed = parseNullableDecimalInput(projectHoursPlannedInput);
    if (normalizedInput && parsed == null) {
      setError(language === "de" ? "Bitte gueltige Stunden eintragen" : "Please enter valid hours");
      return;
    }
    if (parsed != null && parsed < 0) {
      setError(language === "de" ? "Geplante Stunden muessen >= 0 sein" : "Planned hours must be >= 0");
      return;
    }
    const currentPlannedHours = projectFinance?.planned_hours_total ?? null;
    if (parsed === currentPlannedHours) return;

    const patchPayload: Record<string, unknown> = { planned_hours_total: parsed };
    if (projectFinance?.updated_at !== undefined) {
      patchPayload.expected_updated_at = projectFinance.updated_at ?? null;
    }
    try {
      const updated = await apiFetch<ProjectFinance>(`/projects/${activeProjectId}/finance`, token, {
        method: "PATCH",
        body: JSON.stringify(patchPayload),
      });
      setProjectFinance(updated);
      setProjectFinanceForm(projectFinanceToFormState(updated));
      setProjectHoursPlannedInput(updated.planned_hours_total == null ? "" : String(updated.planned_hours_total));
      await loadBaseData();
      await loadProjectOverview(activeProjectId);
      setNotice(language === "de" ? "Projektstunden aktualisiert" : "Project hours updated");
    } catch (err: any) {
      if (err?.status === 409) {
        setError(
          language === "de"
            ? "Projektfinanzen wurden in der Zwischenzeit geändert. Bitte neu laden und erneut speichern."
            : "Project finances were changed in the meantime. Please reload and save again.",
        );
        return;
      }
      setError(err.message ?? "Failed to save project hours");
    }
  }

  async function archiveActiveProject() {
    if (!activeProjectId) return;
    const expectedLastUpdatedAt =
      projectOverviewDetails?.project?.last_updated_at ?? activeProject?.last_updated_at ?? null;
    const payload: Record<string, unknown> = { status: "archived" };
    if (expectedLastUpdatedAt !== null) {
      payload.expected_last_updated_at = expectedLastUpdatedAt;
    }
    try {
      await apiFetch<Project>(`/projects/${activeProjectId}`, token, {
        method: "PATCH",
        body: JSON.stringify(payload),
      });
      setNotice(language === "de" ? "Projekt archiviert" : "Project archived");
      closeProjectModal();
      await loadBaseData();
    } catch (err: any) {
      if (err?.status === 409) {
        setError(
          language === "de"
            ? "Projekt wurde in der Zwischenzeit geändert. Bitte neu laden und erneut versuchen."
            : "Project was changed in the meantime. Please reload and try again.",
        );
        return;
      }
      setError(err.message ?? "Failed to archive project");
    }
  }

  async function deleteActiveProject() {
    if (!activeProjectId) return;
    const confirmed = window.confirm(
      language === "de"
        ? "Projekt wirklich dauerhaft löschen? Diese Aktion kann nicht rückgängig gemacht werden."
        : "Delete this project permanently? This action cannot be undone.",
    );
    if (!confirmed) return;
    try {
      await apiFetch(`/projects/${activeProjectId}`, token, { method: "DELETE" });
      setNotice(language === "de" ? "Projekt gelöscht" : "Project deleted");
      closeProjectModal();
      setActiveProjectId(null);
      setProjectBackView(null);
      setMainView("overview");
      await loadBaseData();
    } catch (err: any) {
      setError(err.message ?? "Failed to delete project");
    }
  }

  async function unarchiveProject(projectId: number, expectedLastUpdatedAt?: string | null) {
    if (!canCreateProject) return;
    const payload: Record<string, unknown> = { status: "active" };
    if (expectedLastUpdatedAt !== null && expectedLastUpdatedAt !== undefined) {
      payload.expected_last_updated_at = expectedLastUpdatedAt;
    }
    try {
      await apiFetch<Project>(`/projects/${projectId}`, token, {
        method: "PATCH",
        body: JSON.stringify(payload),
      });
      setHighlightedArchivedProjectId((current) => (current === projectId ? null : current));
      setNotice(language === "de" ? "Projekt wiederhergestellt" : "Project restored");
      await loadBaseData();
    } catch (err: any) {
      if (err?.status === 409) {
        setError(
          language === "de"
            ? "Projekt wurde in der Zwischenzeit geändert. Bitte neu laden und erneut versuchen."
            : "Project was changed in the meantime. Please reload and try again.",
        );
        return;
      }
      setError(err.message ?? "Failed to restore project");
    }
  }

  async function deleteProjectById(projectId: number) {
    if (!canCreateProject) return;
    const confirmed = window.confirm(
      language === "de"
        ? "Projekt wirklich dauerhaft löschen? Diese Aktion kann nicht rückgängig gemacht werden."
        : "Delete this project permanently? This action cannot be undone.",
    );
    if (!confirmed) return;
    try {
      await apiFetch(`/projects/${projectId}`, token, { method: "DELETE" });
      setNotice(language === "de" ? "Projekt gelöscht" : "Project deleted");
      if (activeProjectId === projectId) {
        setActiveProjectId(null);
        setMainView("overview");
      }
      await loadBaseData();
    } catch (err: any) {
      setError(err.message ?? "Failed to delete project");
    }
  }

  async function createTask(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!activeProjectId) return;
    if (!projectTaskForm.title.trim()) {
      setError(language === "de" ? "Aufgabentitel ist erforderlich" : "Task title is required");
      return;
    }
    const dueDate = projectTaskForm.due_date.trim() || null;
    const storageBoxNumber =
      projectTaskForm.has_storage_box && projectTaskForm.storage_box_number.trim()
        ? Number(projectTaskForm.storage_box_number)
        : null;
    if (
      storageBoxNumber !== null &&
      (!Number.isFinite(storageBoxNumber) || !Number.isInteger(storageBoxNumber) || storageBoxNumber <= 0)
    ) {
      setError(language === "de" ? "Bitte eine gültige Lagerbox-Nummer angeben" : "Please enter a valid storage box number");
      return;
    }
    const startTime =
      projectTaskForm.start_time.trim().length > 0
        ? validateTimeInputOrSetError(projectTaskForm.start_time, false)
        : null;
    if (projectTaskForm.start_time.trim().length > 0 && !startTime) return;
    const estimatedHours = validateEstimatedHoursOrSetError(projectTaskForm.estimated_hours);
    if (projectTaskForm.estimated_hours.trim().length > 0 && estimatedHours == null) return;
    if (estimatedHours != null && !startTime) {
      setError(language === "de" ? "Für eine Dauer muss auch eine Startzeit gesetzt sein" : "Duration requires a start time");
      return;
    }
    const classTemplateId =
      projectTaskForm.class_template_id.trim().length > 0 ? Number(projectTaskForm.class_template_id) : null;
    const materialsRequired = serializeTaskMaterialRows(projectTaskMaterialRows).trim() || null;
    const subtasks = parseTaskSubtasks(projectTaskForm.subtasks_raw);
    try {
      await apiFetch("/tasks", token, {
        method: "POST",
        body: JSON.stringify({
          project_id: activeProjectId,
          title: projectTaskForm.title.trim(),
          description: projectTaskForm.description.trim() || null,
          subtasks,
          materials_required: materialsRequired,
          storage_box_number: storageBoxNumber,
          task_type: projectTaskForm.task_type,
          class_template_id: classTemplateId,
          status: "open",
          due_date: dueDate,
          start_time: startTime,
          estimated_hours: estimatedHours,
          assignee_ids: projectTaskForm.assignee_ids,
          week_start: dueDate ? normalizeWeekStartISO(dueDate) : null,
        }),
      });
      setProjectTaskForm(buildEmptyProjectTaskFormState());
      setProjectTaskMaterialRows([createReportMaterialRow("materials")]);
      await loadTasks(activeProjectTaskView, activeProjectId);
      await loadProjectOverview(activeProjectId);
      if (mainView === "planning") {
        await loadPlanningWeek(null, planningWeekStart, planningTaskTypeView === "all" ? null : planningTaskTypeView);
      }
      setOverview(await apiFetch<any[]>("/projects-overview", token));
      setNotice(language === "de" ? "Aufgabe gespeichert" : "Task saved");
    } catch (err: any) {
      setError(err.message ?? "Failed to create task");
    }
  }

  async function createWeeklyPlanTask(confirmOverlap = false) {
    if (!taskModalForm.title.trim()) {
      setError(language === "de" ? "Aufgabentitel ist erforderlich" : "Task title is required");
      return;
    }
    const dueDate = taskModalForm.due_date.trim() || null;
    const storageBoxNumber =
      taskModalForm.has_storage_box && taskModalForm.storage_box_number.trim()
        ? Number(taskModalForm.storage_box_number)
        : null;
    if (
      storageBoxNumber !== null &&
      (!Number.isFinite(storageBoxNumber) || !Number.isInteger(storageBoxNumber) || storageBoxNumber <= 0)
    ) {
      setError(language === "de" ? "Bitte eine gültige Lagerbox-Nummer angeben" : "Please enter a valid storage box number");
      return;
    }
    const startTime =
      taskModalForm.start_time.trim().length > 0
        ? validateTimeInputOrSetError(taskModalForm.start_time, false)
        : null;
    if (taskModalForm.start_time.trim().length > 0 && !startTime) return;
    const estimatedHours = validateEstimatedHoursOrSetError(taskModalForm.estimated_hours);
    if (taskModalForm.estimated_hours.trim().length > 0 && estimatedHours == null) return;
    if (estimatedHours != null && !startTime) {
      setError(language === "de" ? "Für eine Dauer muss auch eine Startzeit gesetzt sein" : "Duration requires a start time");
      return;
    }
    const targetWeekStart = dueDate ? normalizeWeekStartISO(dueDate) : null;
    const classTemplateId =
      taskModalForm.class_template_id.trim().length > 0 ? Number(taskModalForm.class_template_id) : null;
    const materialsRequired = serializeTaskMaterialRows(taskModalMaterialRows).trim() || null;
    const subtasks = parseTaskSubtasks(taskModalForm.subtasks_raw);

    let projectId = Number(taskModalForm.project_id);
    try {
      if (!projectId && taskModalForm.create_project_from_task) {
        if (!canCreateProject) {
          setError(language === "de" ? "Keine Berechtigung zum Erstellen von Projekten" : "No permission to create projects");
          return;
        }
        const projectName = taskModalForm.new_project_name.trim() || taskModalForm.title.trim();
        if (!projectName) {
          setError(language === "de" ? "Projektname ist erforderlich" : "Project name is required");
          return;
        }
        const numberInput = taskModalForm.new_project_number.trim();
        const generatedProjectNumber = numberInput || `T${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${Date.now().toString().slice(-5)}`;
        const createdProject = await apiFetch<Project>("/projects", token, {
          method: "POST",
          body: JSON.stringify({
            project_number: generatedProjectNumber,
            name: projectName,
            description: taskModalForm.description.trim() || "",
            status: "active",
            last_state: null,
            last_status_at: null,
            customer_name: "",
            customer_address: "",
            construction_site_address: "",
            customer_contact: "",
            customer_email: "",
            customer_phone: "",
          }),
        });
        projectId = createdProject.id;
      }

      if (!projectId) {
        setError(language === "de" ? "Projekt ist erforderlich" : "Project is required");
        return;
      }

      await apiFetch("/tasks", token, {
        method: "POST",
        body: JSON.stringify({
          project_id: projectId,
          title: taskModalForm.title.trim(),
          description: taskModalForm.description.trim() || null,
          subtasks,
          materials_required: materialsRequired,
          storage_box_number: storageBoxNumber,
          task_type: taskModalForm.task_type,
          class_template_id: classTemplateId,
          status: "open",
          assignee_ids: taskModalForm.assignee_ids,
          partner_ids: taskModalForm.partner_ids,
          due_date: dueDate,
          start_time: startTime,
          estimated_hours: estimatedHours,
          week_start: targetWeekStart,
          confirm_overlap: confirmOverlap,
        }),
      });
      closeTaskModal();
      await loadBaseData();
      if (targetWeekStart) {
        setPlanningWeekStart(targetWeekStart);
        await loadPlanningWeek(null, targetWeekStart, planningTaskTypeView === "all" ? null : planningTaskTypeView);
      }
      setNotice(language === "de" ? "Aufgabe gespeichert" : "Task saved");
    } catch (err: any) {
      const overlapDetail = getTaskOverlapConflictDetail(err);
      if (overlapDetail) {
        setTaskModalOverlapWarning(overlapDetail);
        return;
      }
      setError(err.message ?? "Failed to create task");
    }
  }

  async function saveTaskEdit(confirmOverlap = false) {
    if (!taskEditForm.id) return;
    if (!taskEditForm.title.trim()) {
      setError(language === "de" ? "Aufgabentitel ist erforderlich" : "Task title is required");
      return;
    }
    const storageBoxNumber =
      taskEditForm.has_storage_box && taskEditForm.storage_box_number.trim()
        ? Number(taskEditForm.storage_box_number)
        : null;
    if (
      storageBoxNumber !== null &&
      (!Number.isFinite(storageBoxNumber) || !Number.isInteger(storageBoxNumber) || storageBoxNumber <= 0)
    ) {
      setError(language === "de" ? "Bitte eine gültige Lagerbox-Nummer angeben" : "Please enter a valid storage box number");
      return;
    }

    const startTime =
      taskEditForm.start_time.trim().length > 0
        ? validateTimeInputOrSetError(taskEditForm.start_time, false)
        : null;
    if (taskEditForm.start_time.trim().length > 0 && !startTime) return;
    const estimatedHours = validateEstimatedHoursOrSetError(taskEditForm.estimated_hours);
    if (taskEditForm.estimated_hours.trim().length > 0 && estimatedHours == null) return;
    if (estimatedHours != null && !startTime) {
      setError(language === "de" ? "Für eine Dauer muss auch eine Startzeit gesetzt sein" : "Duration requires a start time");
      return;
    }
    const baseStartTime =
      taskEditFormBase && taskEditFormBase.start_time.trim().length > 0
        ? normalizeTimeHHMM(taskEditFormBase.start_time)
        : null;
    const nextMaterialsRequired = serializeTaskMaterialRows(taskEditMaterialRows);
    const nextPayload = taskEditPayloadFromForm(
      { ...taskEditForm, materials_required: nextMaterialsRequired, estimated_hours: estimatedHours != null ? String(estimatedHours) : "" },
      startTime,
    );
    const basePayload = taskEditPayloadFromForm(taskEditFormBase ?? taskEditForm, baseStartTime);
    const patchPayload: Record<string, unknown> = {};
    (
      [
        "title",
        "description",
        "subtasks",
        "materials_required",
        "storage_box_number",
        "task_type",
        "class_template_id",
        "status",
        "due_date",
        "start_time",
        "estimated_hours",
        "assignee_ids",
        "partner_ids",
        "week_start",
      ] as (keyof typeof nextPayload)[]
    ).forEach((key) => {
      if (key === "assignee_ids") {
        if (!sameNumberSet(nextPayload.assignee_ids, basePayload.assignee_ids)) {
          patchPayload[key] = nextPayload[key];
        }
        return;
      }
      if (key === "partner_ids") {
        if (!sameNumberSet(nextPayload.partner_ids, basePayload.partner_ids)) {
          patchPayload[key] = nextPayload[key];
        }
        return;
      }
      if (key === "subtasks") {
        if (!sameStringList(nextPayload.subtasks, basePayload.subtasks)) {
          patchPayload[key] = nextPayload[key];
        }
        return;
      }
      if (nextPayload[key] !== basePayload[key]) {
        patchPayload[key] = nextPayload[key];
      }
    });
    if (taskEditExpectedUpdatedAt !== null) {
      patchPayload.expected_updated_at = taskEditExpectedUpdatedAt;
    }
    patchPayload.confirm_overlap = confirmOverlap;
    const hasChanges = Object.keys(patchPayload).some((key) => key !== "expected_updated_at" && key !== "confirm_overlap");
    if (!hasChanges) {
      closeTaskEditModal();
      return;
    }
    try {
      await apiFetch(`/tasks/${taskEditForm.id}`, token, {
        method: "PATCH",
        body: JSON.stringify(patchPayload),
      });
      closeTaskEditModal();
      if (mainView === "project" && activeProjectId) {
        await loadTasks(activeProjectTaskView, activeProjectId);
        await loadProjectOverview(activeProjectId);
      }
      if (mainView === "my_tasks" || mainView === "overview") {
        await loadTasks("my", null);
      }
      if (mainView === "planning") {
        await loadPlanningWeek(null, planningWeekStart, planningTaskTypeView === "all" ? null : planningTaskTypeView);
      }
      setOverview(await apiFetch<any[]>("/projects-overview", token));
      setNotice(language === "de" ? "Aufgabe aktualisiert" : "Task updated");
    } catch (err: any) {
      const overlapDetail = getTaskOverlapConflictDetail(err);
      if (overlapDetail) {
        setTaskEditOverlapWarning(overlapDetail);
        return;
      }
      if (err?.status === 409) {
        setError(
          language === "de"
            ? "Aufgabe wurde in der Zwischenzeit geändert. Bitte neu laden und erneut speichern."
            : "Task was changed in the meantime. Please reload and save again.",
        );
        return;
      }
      setError(err.message ?? "Failed to update task");
    }
  }

  function openConstructionReportFromTask(task: Task, sourceView: MainView | null = "my_tasks") {
    const project = projectsById.get(task.project_id) ?? null;
    const projectIdValue = project ? String(project.id) : "";
    const taskAssignees = getTaskAssigneeIds(task);
    const workerRows = taskAssignees
      .map((assigneeId) => {
        const fullName =
          assignableUsersById.get(assigneeId)?.full_name ?? adminUsersById.get(assigneeId)?.full_name ?? "";
        return fullName.trim();
      })
      .filter((name) => name.length > 0)
      .map((name) => ({ name, start_time: "", end_time: "" }));
    setReportWorkers(workerRows.length > 0 ? workerRows : [{ name: "", start_time: "", end_time: "" }]);

    applyReportProjectSelection(projectIdValue);
    setReportTaskPrefill({
      task_id: task.id,
      report_date: task.due_date || formatDateISOLocal(new Date()),
      work_done: [
        `${language === "de" ? "Aufgabe" : "Task"} #${task.id}: ${task.title}`,
        task.description
          ? `${language === "de" ? "Information" : "Information"}: ${task.description}`
          : "",
      ]
        .filter((line) => line.length > 0)
        .join("\n"),
      incidents:
        task.storage_box_number != null
          ? `${language === "de" ? "Lagerbox" : "Storage box"}: ${task.storage_box_number}`
          : "",
      materials: task.materials_required ?? "",
      subtasks: task.subtasks ?? [],
    });
    setOverviewShortcutBackVisible(false);
    setConstructionBackView(sourceView);
    setMainView("construction");
  }

  async function markTaskDone(
    task: Task,
    options?: { openReportFromTask?: Task; reportBackView?: MainView | null },
  ) {
    // When opening a report from a task, defer the API call until the report is
    // saved so accidental button presses don't silently mark the task done.
    if (options?.openReportFromTask) {
      setReportShouldMarkSourceTaskDone(true);
      openConstructionReportFromTask(
        options.openReportFromTask,
        options.reportBackView ?? "my_tasks",
      );
      return;
    }

    const payload: Record<string, unknown> = { status: "done" };
    if (task.updated_at !== null && task.updated_at !== undefined) {
      payload.expected_updated_at = task.updated_at;
    }
    try {
      await apiFetch(`/tasks/${task.id}`, token, {
        method: "PATCH",
        body: JSON.stringify(payload),
      });
      if (mainView === "project" && activeProjectId) {
        await loadTasks(activeProjectTaskView, activeProjectId);
        await loadProjectOverview(activeProjectId);
      }
      if (mainView === "my_tasks" || mainView === "overview") {
        await loadTasks("my", null);
      }
      if (mainView === "planning") {
        await loadPlanningWeek(null, planningWeekStart, planningTaskTypeView === "all" ? null : planningTaskTypeView);
      }
      setNotice(language === "de" ? "Aufgabe abgeschlossen" : "Task marked complete");
    } catch (err: any) {
      if (err?.status === 409) {
        setError(
          language === "de"
            ? "Aufgabe wurde in der Zwischenzeit geändert. Bitte neu laden und erneut versuchen."
            : "Task was changed in the meantime. Please reload and try again.",
        );
        return;
      }
      setError(err.message ?? "Failed to complete task");
    }
  }

  async function deleteTaskFromEdit() {
    if (!taskEditForm.id) return;
    const confirmed = window.confirm(
      language === "de"
        ? "Aufgabe wirklich löschen?"
        : "Delete this task permanently?",
    );
    if (!confirmed) return;
    try {
      await apiFetch(`/tasks/${taskEditForm.id}`, token, { method: "DELETE" });
      closeTaskEditModal();
      if (mainView === "project" && activeProjectId) {
        await loadTasks(activeProjectTaskView, activeProjectId);
        await loadProjectOverview(activeProjectId);
      }
      if (mainView === "my_tasks" || mainView === "overview") {
        await loadTasks("my", null);
      }
      if (mainView === "planning") {
        await loadPlanningWeek(null, planningWeekStart, planningTaskTypeView === "all" ? null : planningTaskTypeView);
      }
      setOverview(await apiFetch<any[]>("/projects-overview", token));
      setNotice(language === "de" ? "Aufgabe gelöscht" : "Task deleted");
    } catch (err: any) {
      setError(err.message ?? "Failed to delete task");
    }
  }

  function openProjectFromTask(task: Task, backView: MainView | null = "my_tasks") {
    openProjectById(task.project_id, backView);
  }

  function openTaskFromProject(task: Task) {
    if (!isTaskAssignedToCurrentUser(task) || task.status === "done") return;
    setProjectBackView(null);
    setExpandedMyTaskId(task.id);
    setMyTasksBackProjectId(activeProjectId ?? task.project_id);
    setMainView("my_tasks");
  }

  function openTaskFromPlanning(task: Task) {
    if (!isTaskAssignedToCurrentUser(task)) return;
    setMyTasksBackProjectId(null);
    setExpandedMyTaskId(task.id);
    setMainView("my_tasks");
  }

  async function createTicket(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!activeProjectId) return;
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    try {
      await apiFetch(`/projects/${activeProjectId}/job-tickets`, token, {
        method: "POST",
        body: JSON.stringify({
          site_id: null,
          title: String(form.get("title")),
          site_address: activeProjectTicketAddress,
          ticket_date: activeProjectTicketDate,
          assigned_crew: String(form.get("assigned_crew") || "")
            .split(",")
            .map((x) => x.trim())
            .filter(Boolean),
          checklist: [{ label: "Safety check", done: false }],
          notes: String(form.get("notes") || ""),
        }),
      });
      formElement.reset();
      await loadSitesAndTickets(activeProjectId);
      await loadProjectOverview(activeProjectId);
      setOverview(await apiFetch<any[]>("/projects-overview", token));
    } catch (err: any) {
      setError(err.message ?? "Failed to create ticket");
    }
  }

  async function uploadTicketAttachment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!activeProjectId) return;
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const ticketId = Number(form.get("ticket_id"));
    if (!ticketId) return;
    try {
      await apiFetch(`/projects/${activeProjectId}/job-tickets/${ticketId}/attachments`, token, {
        method: "POST",
        body: form,
      });
      formElement.reset();
      await loadProjectOverview(activeProjectId);
      setOverview(await apiFetch<any[]>("/projects-overview", token));
      setNotice(language === "de" ? "Anhang hochgeladen" : "Attachment uploaded");
    } catch (err: any) {
      setError(err.message ?? "Failed to upload ticket attachment");
    }
  }

  async function clockIn() {
    try {
      await apiFetch("/time/clock-in", token, { method: "POST" });
      await refreshTimeData();
    } catch (err: any) {
      setError(err.message ?? "Clock in failed");
    }
  }

  async function clockOut() {
    try {
      await apiFetch("/time/clock-out", token, { method: "POST" });
      await refreshTimeData();
    } catch (err: any) {
      setError(err.message ?? "Clock out failed");
    }
  }

  async function startBreak() {
    try {
      await apiFetch("/time/break-start", token, { method: "POST" });
      await refreshTimeData();
    } catch (err: any) {
      setError(err.message ?? "Break start failed");
    }
  }

  async function endBreak() {
    try {
      await apiFetch("/time/break-end", token, { method: "POST" });
      await refreshTimeData();
    } catch (err: any) {
      setError(err.message ?? "Break end failed");
    }
  }

  async function updateTimeEntry(event: FormEvent<HTMLFormElement>, entryId: number) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const clockInIso = localDateTimeInputToIso(String(form.get("clock_in") || ""));
    const clockOutIso = localDateTimeInputToIso(String(form.get("clock_out") || ""));
    const breakMinutes = Number(form.get("break_minutes") || 0);
    if (!clockInIso) return;
    try {
      await apiFetch(`/time/entries/${entryId}`, token, {
        method: "PATCH",
        body: JSON.stringify({
          clock_in: clockInIso,
          clock_out: clockOutIso,
          break_minutes: breakMinutes,
        }),
      });
      await refreshTimeData();
      setNotice(language === "de" ? "Zeitbuchung aktualisiert" : "Time entry updated");
    } catch (err: any) {
      setError(err.message ?? "Failed to update time entry");
    }
  }

  function openCreateThreadModal() {
    setThreadModalForm(EMPTY_THREAD_MODAL_FORM);
    setThreadIconFile(null);
    setThreadIconPreviewUrl("");
    setThreadModalMode("create");
  }

  function openEditThreadModal(thread: Thread) {
    setThreadActionMenuOpen(false);
    setThreadModalForm({
      name: thread.name ?? "",
      project_id: thread.project_id ? String(thread.project_id) : "",
      participant_user_query: "",
      participant_user_ids: Array.from(
        new Set((thread.participant_user_ids ?? []).map((entry) => Number(entry)).filter((entry) => entry > 0)),
      ),
      participant_role_query: "",
      participant_roles: Array.from(
        new Set(
          (thread.participant_roles ?? [])
            .map((entry) => String(entry || "").trim().toLowerCase())
            .filter((entry) => entry.length > 0),
        ),
      ),
    });
    setThreadIconFile(null);
    setThreadIconPreviewUrl("");
    setThreadModalMode("edit");
  }

  function closeThreadModal() {
    setThreadModalMode(null);
    setThreadModalForm(EMPTY_THREAD_MODAL_FORM);
    setThreadIconFile(null);
    setThreadIconPreviewUrl("");
    if (threadIconObjectUrlRef.current) {
      URL.revokeObjectURL(threadIconObjectUrlRef.current);
      threadIconObjectUrlRef.current = null;
    }
  }

  async function openArchivedThreadsModal() {
    setArchivedThreadsModalOpen(true);
    await loadArchivedThreads();
  }

  function closeArchivedThreadsModal() {
    setArchivedThreadsModalOpen(false);
    setArchivedThreads([]);
  }

  function onThreadIconFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0] ?? null;
    if (!file) {
      setThreadIconFile(null);
      setThreadIconPreviewUrl("");
      return;
    }
    if (!isImageUploadFile(file)) {
      setError(language === "de" ? "Bitte eine Bilddatei wählen." : "Please select an image file.");
      return;
    }
    if (threadIconObjectUrlRef.current) {
      URL.revokeObjectURL(threadIconObjectUrlRef.current);
    }
    const objectUrl = URL.createObjectURL(file);
    threadIconObjectUrlRef.current = objectUrl;
    setThreadIconFile(file);
    setThreadIconPreviewUrl(objectUrl);
  }

  function addThreadModalUser(userId: number) {
    setThreadModalForm((current) => {
      if (current.participant_user_ids.includes(userId)) {
        return { ...current, participant_user_query: "" };
      }
      return {
        ...current,
        participant_user_ids: [...current.participant_user_ids, userId],
        participant_user_query: "",
      };
    });
  }

  function removeThreadModalUser(userId: number) {
    setThreadModalForm((current) => ({
      ...current,
      participant_user_ids: current.participant_user_ids.filter((id) => id !== userId),
    }));
  }

  function addFirstMatchingThreadModalUser() {
    const first = threadModalUserSuggestions[0];
    if (!first) return;
    addThreadModalUser(first.id);
  }

  function addThreadModalRole(role: string) {
    const normalizedRole = String(role || "").trim().toLowerCase();
    if (!normalizedRole) return;
    setThreadModalForm((current) => {
      if (current.participant_roles.includes(normalizedRole)) {
        return { ...current, participant_role_query: "" };
      }
      return {
        ...current,
        participant_roles: [...current.participant_roles, normalizedRole],
        participant_role_query: "",
      };
    });
  }

  function removeThreadModalRole(role: string) {
    setThreadModalForm((current) => ({
      ...current,
      participant_roles: current.participant_roles.filter((entry) => entry !== role),
    }));
  }

  function addFirstMatchingThreadModalRole() {
    const first = threadModalRoleSuggestions[0];
    if (!first) return;
    addThreadModalRole(first);
  }

  async function submitThreadModal(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = threadModalForm.name.trim();
    const selectedProjectId = threadModalForm.project_id ? Number(threadModalForm.project_id) : null;
    if (!name) {
      setError(language === "de" ? "Thread-Name ist erforderlich" : "Thread name is required");
      return;
    }
    if (threadModalForm.project_id && (!Number.isInteger(selectedProjectId) || Number(selectedProjectId) <= 0)) {
      setError(language === "de" ? "Bitte ein gültiges Projekt wählen." : "Please select a valid project.");
      return;
    }

    try {
      let targetThreadId: number | null = null;
      if (threadModalMode === "create") {
        const created = await apiFetch<Thread>("/threads", token, {
          method: "POST",
          body: JSON.stringify({
            name,
            project_id: selectedProjectId,
            participant_user_ids: threadModalForm.participant_user_ids,
            participant_roles: threadModalForm.participant_roles,
          }),
        });
        targetThreadId = created.id;
      } else if (threadModalMode === "edit" && activeThreadId) {
        const updated = await apiFetch<Thread>(`/threads/${activeThreadId}`, token, {
          method: "PATCH",
          body: JSON.stringify({
            name,
            project_id: selectedProjectId,
            participant_user_ids: threadModalForm.participant_user_ids,
            participant_roles: threadModalForm.participant_roles,
          }),
        });
        targetThreadId = updated.id;
      }

      if (threadIconFile && targetThreadId) {
        const form = new FormData();
        form.set("file", threadIconFile);
        await apiFetch(`/threads/${targetThreadId}/icon`, token, {
          method: "POST",
          body: form,
        });
      }

      closeThreadModal();
      await loadThreads();
      if (targetThreadId) {
        setActiveThreadId(targetThreadId);
        await loadMessages(targetThreadId);
      }
      setNotice(
        threadModalMode === "edit"
          ? language === "de"
            ? "Thread aktualisiert"
            : "Thread updated"
          : language === "de"
            ? "Thread erstellt"
            : "Thread created",
      );
    } catch (err: any) {
      setError(err.message ?? (threadModalMode === "edit" ? "Failed to update thread" : "Failed to create thread"));
    }
  }

  async function archiveActiveThread() {
    if (!activeThread || !activeThread.can_edit) return;
    const confirmed = window.confirm(
      language === "de"
        ? "Diesen Chat archivieren? Er kann später wiederhergestellt werden."
        : "Archive this chat? It can be restored later.",
    );
    if (!confirmed) return;
    try {
      await apiFetch(`/threads/${activeThread.id}/archive`, token, { method: "POST" });
      await loadThreads();
      setNotice(language === "de" ? "Chat archiviert" : "Chat archived");
    } catch (err: any) {
      setError(err.message ?? "Failed to archive thread");
    }
  }

  async function restoreArchivedThread(threadId: number) {
    try {
      await apiFetch(`/threads/${threadId}/restore`, token, { method: "POST" });
      await loadArchivedThreads();
      await loadThreads();
      setActiveThreadId(threadId);
      await loadMessages(threadId);
      setNotice(language === "de" ? "Chat wiederhergestellt" : "Chat restored");
    } catch (err: any) {
      setError(err.message ?? "Failed to restore thread");
    }
  }

  async function deleteThread(thread: Thread) {
    if (!thread.can_edit) return;
    const confirmed = window.confirm(
      language === "de"
        ? "Diesen Chat dauerhaft löschen? Verlauf und Anhänge bleiben nicht erhalten."
        : "Delete this chat permanently? History and attachments cannot be restored.",
    );
    if (!confirmed) return;
    try {
      await apiFetch(`/threads/${thread.id}`, token, { method: "DELETE" });
      if (activeThreadId === thread.id) {
        setActiveThreadId(null);
        setMessages([]);
      }
      await loadThreads();
      if (archivedThreadsModalOpen) {
        await loadArchivedThreads();
      }
      setNotice(language === "de" ? "Chat gelöscht" : "Chat deleted");
    } catch (err: any) {
      setError(err.message ?? "Failed to delete thread");
    }
  }

  async function sendMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!activeThreadId) return;
    const form = new FormData();
    const text = messageBody.trim();
    const selectedAttachment = messageAttachment ?? messageAttachmentInputRef.current?.files?.[0] ?? null;
    if (text) form.set("body", text);
    if (selectedAttachment) {
      form.set("attachment", selectedAttachment);
    }
    if (!text && !selectedAttachment) return;
    try {
      await apiFetch(`/threads/${activeThreadId}/messages`, token, {
        method: "POST",
        body: form,
      });
      shouldFollowMessagesRef.current = true;
      forceScrollToBottomRef.current = true;
      setMessageBody("");
      setMessageAttachment(null);
      if (messageAttachmentInputRef.current) {
        messageAttachmentInputRef.current.value = "";
      }
      window.requestAnimationFrame(() => {
        scrollMessageListToBottom();
      });
      await loadMessages(activeThreadId);
      await loadThreads();
    } catch (err: any) {
      setError(err.message ?? "Failed to send message");
    }
  }

  async function uploadFile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!activeProjectId) return;
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const inlineFolderPath = newProjectFolderPath.trim();
    const selectedFolder = inlineFolderPath || fileUploadFolder;
    if (selectedFolder) {
      form.set("folder", selectedFolder);
    }
    try {
      await apiFetch(`/projects/${activeProjectId}/files`, token, { method: "POST", body: form });
      formElement.reset();
      setFileUploadModalOpen(false);
      if (inlineFolderPath) {
        setFileUploadFolder(inlineFolderPath);
      }
      setNewProjectFolderPath("");
      await loadFiles(activeProjectId);
      await loadProjectFolders(activeProjectId);
      await loadProjectOverview(activeProjectId);
      setOverview(await apiFetch<any[]>("/projects-overview", token));
    } catch (err: any) {
      setError(err.message ?? "File upload failed");
    }
  }

  async function createProjectFolderFromInput() {
    if (!activeProjectId) return;
    const folderPath = newProjectFolderPath.trim();
    if (!folderPath) return;
    try {
      const created = await apiFetch<ProjectFolder>(`/projects/${activeProjectId}/folders`, token, {
        method: "POST",
        body: JSON.stringify({ path: folderPath }),
      });
      setNewProjectFolderPath("");
      await loadProjectFolders(activeProjectId);
      setFileUploadFolder(created.path);
      setNotice(language === "de" ? "Ordner erstellt" : "Folder created");
    } catch (err: any) {
      setError(err.message ?? "Failed to create folder");
    }
  }

  function openAvatarModal() {
    setAvatarModalOpen(true);
    setAvatarZoom(1);
    setAvatarOffsetX(0);
    setAvatarOffsetY(0);
  }

  function onMessageAttachmentChange(event: ChangeEvent<HTMLInputElement>) {
    const selected = event.target.files?.[0] ?? null;
    setMessageAttachment(selected);
  }

  function scrollMessageListToBottom() {
    const list = messageListRef.current;
    if (!list) return;
    list.scrollTop = list.scrollHeight;
  }

  function clearMessageAttachment() {
    setMessageAttachment(null);
    if (messageAttachmentInputRef.current) {
      messageAttachmentInputRef.current.value = "";
    }
  }

  function onMessageListScroll() {
    const list = messageListRef.current;
    if (!list) return;
    const distanceToBottom = list.scrollHeight - list.scrollTop - list.clientHeight;
    shouldFollowMessagesRef.current = distanceToBottom <= 48;
  }

  function closeAvatarModal() {
    setAvatarModalOpen(false);
    setAvatarZoom(1);
    setAvatarOffsetX(0);
    setAvatarOffsetY(0);
    setAvatarNaturalSize(null);
    setAvatarIsDragging(false);
    avatarDragRef.current = null;
    setAvatarPreviewDataUrl("");
    setAvatarSelectedFile(null);
    setAvatarSourceUrl("");
    if (avatarObjectUrlRef.current) {
      URL.revokeObjectURL(avatarObjectUrlRef.current);
      avatarObjectUrlRef.current = null;
    }
  }

  function onAvatarFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    if (!isImageUploadFile(file)) {
      setError(language === "de" ? "Bitte eine Bilddatei wählen." : "Please select an image file.");
      return;
    }
    if (avatarObjectUrlRef.current) {
      URL.revokeObjectURL(avatarObjectUrlRef.current);
    }
    const objectUrl = URL.createObjectURL(file);
    avatarObjectUrlRef.current = objectUrl;
    setAvatarSelectedFile(file);
    setAvatarPreviewDataUrl("");
    setAvatarSourceUrl(objectUrl);
    setAvatarZoom(1);
    setAvatarOffsetX(0);
    setAvatarOffsetY(0);
    setAvatarIsDragging(false);
    avatarDragRef.current = null;
  }

  function onAvatarDragStart(event: PointerEvent<HTMLDivElement>) {
    if (!avatarSourceUrl) return;
    avatarDragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startOffsetX: avatarOffsetX,
      startOffsetY: avatarOffsetY,
    };
    setAvatarIsDragging(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function onAvatarDragMove(event: PointerEvent<HTMLDivElement>) {
    const drag = avatarDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const node = avatarCropStageRef.current;
    const stageSize = node?.clientWidth || avatarStageSize || 260;
    const metrics = avatarStageMetrics(avatarNaturalSize, stageSize, avatarZoom, 0, 0);
    const deltaX = event.clientX - drag.startX;
    const deltaY = event.clientY - drag.startY;
    const nextOffsetX = metrics.maxPanX > 0 ? drag.startOffsetX + (deltaX / metrics.maxPanX) * 100 : 0;
    const nextOffsetY = metrics.maxPanY > 0 ? drag.startOffsetY + (deltaY / metrics.maxPanY) * 100 : 0;
    setAvatarOffsetX(clamp(nextOffsetX, -100, 100));
    setAvatarOffsetY(clamp(nextOffsetY, -100, 100));
  }

  function onAvatarDragEnd(event: PointerEvent<HTMLDivElement>) {
    const drag = avatarDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    avatarDragRef.current = null;
    setAvatarIsDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  async function saveAvatar() {
    if (!avatarPreviewDataUrl && !avatarSelectedFile) {
      setError(language === "de" ? "Bitte zuerst ein Bild auswählen." : "Please choose an image first.");
      return;
    }
    try {
      const form = new FormData();
      const output = avatarCropOutput(avatarSelectedFile);
      if (avatarPreviewDataUrl) {
        const previewResponse = await fetch(avatarPreviewDataUrl);
        const blob = await previewResponse.blob();
        form.set("file", new File([blob], `avatar.${output.extension}`, { type: output.mimeType }));
      } else if (avatarSelectedFile) {
        form.set("file", avatarSelectedFile);
      }
      const result = await apiFetch<AvatarUploadResponse>("/users/me/avatar", token, {
        method: "POST",
        body: form,
      });
      setAvatarVersionKey(result.avatar_updated_at || String(Date.now()));
      setUser(await apiFetch<User>("/auth/me", token));
      setNotice(language === "de" ? "Profilbild aktualisiert" : "Profile picture updated");
      closeAvatarModal();
    } catch (err: any) {
      setError(err.message ?? "Avatar upload failed");
    }
  }

  async function deleteAvatar() {
    if (!user || !user.avatar_updated_at) return;
    const confirmed = window.confirm(
      language === "de" ? "Profilbild entfernen?" : "Remove profile picture?",
    );
    if (!confirmed) return;
    try {
      await apiFetch<AvatarDeleteResponse>("/users/me/avatar", token, { method: "DELETE" });
      setAvatarVersionKey(String(Date.now()));
      setUser(await apiFetch<User>("/auth/me", token));
      closeAvatarModal();
      setNotice(language === "de" ? "Profilbild entfernt" : "Profile picture removed");
    } catch (err: any) {
      setError(err.message ?? "Avatar delete failed");
    }
  }

  function fileDownloadUrl(fileId: number) {
    return `/api/files/${fileId}/download`;
  }

  function filePreviewUrl(fileId: number) {
    return `/api/files/${fileId}/preview`;
  }

  function isPreviewable(file: any) {
    const contentType = String(file?.content_type ?? "");
    return (
      contentType.startsWith("image/") ||
      contentType === "application/pdf" ||
      contentType.startsWith("text/")
    );
  }

  async function deleteFile(fileId: number) {
    try {
      await apiFetch<void>(`/files/${fileId}`, token, { method: "DELETE" });
      setFiles((current) => current.filter((f) => f.id !== fileId));
    } catch (err: any) {
      setError(err.message ?? "Failed to delete file");
    }
  }

  function wikiFileUrl(path: string, download = false) {
    const normalized = path
      .split("/")
      .filter((segment) => segment.length > 0)
      .map((segment) => encodeURIComponent(segment))
      .join("/");
    return `/api/wiki/library/raw/${normalized}${download ? "?download=1" : ""}`;
  }

  function formatFileSize(sizeBytes: number) {
    if (sizeBytes < 1024) return `${sizeBytes} B`;
    if (sizeBytes < 1024 * 1024) return `${(sizeBytes / 1024).toFixed(1)} KB`;
    return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  function updateReportWorker(index: number, field: keyof ReportWorker, value: string) {
    setReportWorkers((current) => {
      const next = [...current];
      next[index] = { ...next[index], [field]: value };
      return next;
    });
  }

  function addReportWorkerRow() {
    setReportWorkers((current) => [...current, { name: "", start_time: "", end_time: "" }]);
  }

  function removeReportWorkerRow(index: number) {
    setReportWorkers((current) => (current.length <= 1 ? current : current.filter((_, i) => i !== index)));
  }

  function applyReportProjectSelection(nextProjectId: string) {
    setReportProjectId(nextProjectId);
    const selected = projects.find((project) => String(project.id) === nextProjectId) ?? null;
    setReportDraft(reportDraftFromProject(selected));
    setReportSourceTaskId(null);
    setReportTaskChecklist([]);
  }

  function toggleReportTaskChecklistItem(itemId: string, checked: boolean) {
    setReportTaskChecklist((current) =>
      current.map((entry) => (entry.id === itemId ? { ...entry, done: checked } : entry)),
    );
  }

  function updateReportDraftField(field: keyof ReportDraft, value: string) {
    setReportDraft((current) => ({ ...current, [field]: value }));
  }

  /** Load a specific draft into the active construction report form. */
  function openReportDraft(id: string) {
    const stored = reportDrafts.find((d) => d.id === id);
    if (!stored) return;
    setActiveDraftId(stored.id);
    setReportProjectId(stored.projectId);
    const restoredProject = projects.find((p) => String(p.id) === stored.projectId) ?? null;
    setReportDraft(restoredProject ? reportDraftFromProject(restoredProject) : stored.draft);
    setReportWorkDone(stored.workDone);
    setReportIncidents(stored.incidents);
    setReportExtras(stored.extras);
    setReportOfficeRework(stored.officeRework);
    setReportOfficeNextSteps(stored.officeNextSteps);
    setReportDate(stored.date);
    setReportWorkers(
      stored.workers.length > 0 ? stored.workers : [{ name: "", start_time: "", end_time: "" }],
    );
    setReportMaterialRows(
      stored.materialRows.length > 0
        ? stored.materialRows.map((r) => ({ ...createReportMaterialRow("materials"), ...r }))
        : [createReportMaterialRow("materials")],
    );
    setReportOfficeMaterialRows(
      stored.officeMaterialRows.length > 0
        ? stored.officeMaterialRows.map((r) => ({ ...createReportMaterialRow("office_materials"), ...r }))
        : [createReportMaterialRow("office_materials")],
    );
    setReportSourceTaskId(stored.sourceTaskId);
  }

  /** Remove a draft permanently. If it was the active one, also reset the
   *  form so the user isn't editing a ghost. */
  function deleteReportDraft(id: string) {
    setReportDrafts((prev) => {
      const next = prev.filter((d) => d.id !== id);
      try { localStorage.setItem(REPORT_DRAFTS_LS_KEY, JSON.stringify(next)); } catch {}
      return next;
    });
    if (activeDraftId === id) {
      setActiveDraftId(null);
      resetReportFormFields();
    }
  }

  /** Reset the form + clear the active draft id. The next autosave tick will
   *  create a fresh draft entry once the user types something. */
  function startNewReportDraft() {
    setActiveDraftId(null);
    resetReportFormFields();
  }

  /** Shared form-reset helper used by startNewReportDraft and deleteReportDraft.
   *  Mirrors the cleanup done after a successful submit. */
  function resetReportFormFields() {
    setReportDraft({ ...EMPTY_REPORT_DRAFT });
    setReportWorkDone("");
    setReportIncidents("");
    setReportExtras("");
    setReportOfficeRework("");
    setReportOfficeNextSteps("");
    setReportWorkers([{ name: "", start_time: "", end_time: "" }]);
    setReportMaterialRows([createReportMaterialRow("materials")]);
    setReportOfficeMaterialRows([createReportMaterialRow("office_materials")]);
    setReportSourceTaskId(null);
    setReportTaskChecklist([]);
  }

  function updateReportMaterialRow(
    index: number,
    field: keyof Omit<ReportMaterialRow, "id">,
    value: string,
  ) {
    setReportMaterialRows((current) => {
      const next = [...current];
      next[index] = { ...next[index], [field]: value };
      return next;
    });
  }

  function addReportMaterialRow() {
    setReportMaterialRows((current) => [...current, createReportMaterialRow("materials")]);
  }

  function removeReportMaterialRow(index: number) {
    setReportMaterialRows((current) =>
      current.length <= 1 ? [createReportMaterialRow("materials")] : current.filter((_, rowIndex) => rowIndex !== index),
    );
  }

  function updateReportOfficeMaterialRow(
    index: number,
    field: keyof Omit<ReportMaterialRow, "id">,
    value: string,
  ) {
    setReportOfficeMaterialRows((current) => {
      const next = [...current];
      next[index] = { ...next[index], [field]: value };
      return next;
    });
  }

  function addReportOfficeMaterialRow() {
    setReportOfficeMaterialRows((current) => [...current, createReportMaterialRow("office_materials")]);
  }

  function removeReportOfficeMaterialRow(index: number) {
    setReportOfficeMaterialRows((current) =>
      current.length <= 1
        ? [createReportMaterialRow("office_materials")]
        : current.filter((_, rowIndex) => rowIndex !== index),
    );
  }

  function onReportImagesChange(event: ChangeEvent<HTMLInputElement>) {
    const selectedFiles = event.target.files ? Array.from(event.target.files) : [];
    if (selectedFiles.length === 0) return;
    const invalidFile = selectedFiles.find((file) => !isImageUploadFile(file));
    if (invalidFile) {
      setError(language === "de" ? "Bitte nur Bilddateien wählen." : "Please select image files only.");
      event.target.value = "";
      return;
    }
    setReportImageFiles((current) => {
      const seen = new Set(current.map((entry) => entry.key));
      const next = [...current];
      for (const file of selectedFiles) {
        const fileKey = buildClientFileKey(file);
        if (seen.has(fileKey)) continue;
        seen.add(fileKey);
        next.push({
          key: fileKey,
          file,
          preview_url: URL.createObjectURL(file),
        });
      }
      return next;
    });
    event.target.value = "";
  }

  function removeReportImage(fileKey: string) {
    setReportImageFiles((current) => {
      const toRemove = current.find((entry) => entry.key === fileKey) ?? null;
      if (toRemove) {
        URL.revokeObjectURL(toRemove.preview_url);
      }
      return current.filter((entry) => entry.key !== fileKey);
    });
  }

  function onReportImageRemoveClick(event: MouseEvent<HTMLButtonElement>, fileKey: string) {
    event.preventDefault();
    event.stopPropagation();
    removeReportImage(fileKey);
  }

  function clearReportImages() {
    setReportImageFiles((current) => {
      current.forEach((entry) => {
        URL.revokeObjectURL(entry.preview_url);
      });
      return [];
    });
    if (reportImageInputRef.current) {
      reportImageInputRef.current.value = "";
    }
  }

  async function submitConstructionReport(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (reportSubmitting) return;
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const rawProjectId = String(form.get("project_id") || reportProjectId || "").trim();
    const parsedProjectId = rawProjectId ? Number(rawProjectId) : NaN;
    let targetProjectId: number | null = null;
    if (rawProjectId) {
      if (!Number.isFinite(parsedProjectId) || parsedProjectId <= 0) {
        setError(language === "de" ? "Ungültige Projekt-ID" : "Invalid project ID");
        return;
      }
      targetProjectId = parsedProjectId;
    }
    const targetProject = targetProjectId ? projects.find((project) => project.id === targetProjectId) : null;

    const workers = reportWorkers
      .map((worker) => ({
        name: worker.name.trim(),
        start_time: normalizeTimeHHMM(worker.start_time) || null,
        end_time: normalizeTimeHHMM(worker.end_time) || null,
      }))
      .filter((worker) => worker.name.length > 0);
    const invalidWorkerIndex = workers.findIndex(
      (worker) =>
        (worker.start_time && !isValidTimeHHMM(worker.start_time)) ||
        (worker.end_time && !isValidTimeHHMM(worker.end_time)),
    );
    if (invalidWorkerIndex >= 0) {
      setError(
        language === "de"
          ? `Bitte gültige Zeiten eintragen (HH:MM oder 4 Ziffern, Mitarbeiter Zeile ${invalidWorkerIndex + 1}).`
          : `Please enter valid times (HH:MM or 4 digits, worker row ${invalidWorkerIndex + 1}).`,
      );
      return;
    }

    const materials = reportMaterialRows
      .map((row) => ({
        item: row.item.trim(),
        qty: row.qty.trim(),
        unit: row.unit.trim(),
        article_no: row.article_no.trim(),
      }))
      .filter((row) => row.item.length > 0)
      .map((row) => ({
        item: row.item,
        qty: row.qty || null,
        unit: row.unit || null,
        article_no: row.article_no || null,
      }));
    // Use controlled state for previously-uncontrolled fields.
    const extras = parseListLines(reportExtras).map((line) => {
      const [description, reason] = line.split("|").map((x) => x.trim());
      return { description: description || "-", reason: reason || null };
    });
    const officeMaterialNeed = serializeOfficeMaterialRows(reportOfficeMaterialRows);
    const completedSubtasks = reportTaskChecklist.filter((entry) => entry.done).map((entry) => entry.label);

    const payload = {
      customer: reportDraft.customer.trim() || null,
      customer_address: reportDraft.customer_address.trim() || null,
      customer_contact: reportDraft.customer_contact.trim() || null,
      customer_email: reportDraft.customer_email.trim() || null,
      customer_phone: reportDraft.customer_phone.trim() || null,
      project_name: (targetProject?.name || reportDraft.project_name || "").trim() || null,
      project_number: (targetProject?.project_number || reportDraft.project_number || "").trim() || null,
      workers,
      materials,
      extras,
      work_done: reportWorkDone,
      incidents: reportIncidents,
      office_material_need: officeMaterialNeed,
      office_rework: reportOfficeRework,
      office_next_steps: reportOfficeNextSteps,
      source_task_id: targetProjectId && reportSourceTaskId ? reportSourceTaskId : null,
      completed_subtasks: targetProjectId && reportSourceTaskId ? completedSubtasks : [],
    };

    const multipart = new FormData();
    multipart.set("report_date", reportDate);
    multipart.set("send_telegram", "false");
    multipart.set("payload", JSON.stringify(payload));
    if (targetProjectId) multipart.set("project_id", String(targetProjectId));

    for (const [index, selection] of reportImageFiles.entries()) {
      const fallbackName = selection.file.name.trim() || `report-photo-${index + 1}.jpg`;
      multipart.append("images", selection.file, fallbackName);
    }

    try {
      setReportSubmitting(true);
      setReportUploadPercent(0);
      setReportUploadPhase("uploading");
      const reportEndpoint = targetProjectId ? `/projects/${targetProjectId}/construction-reports` : "/construction-reports";
      const createdReport = await apiUploadWithProgress<ConstructionReportCreateResponse>(
        reportEndpoint,
        token,
        multipart,
        (progress) => {
          if (progress.percent != null) {
            setReportUploadPercent(progress.percent);
            if (progress.percent >= 100) {
              setReportUploadPhase("processing");
            }
            return;
          }
          if (progress.loaded > 0) {
            setReportUploadPercent((current) => current ?? 1);
          }
        },
      );

      // If this report was linked to a task via "Create report from task", mark
      // the task done now that the report saved successfully.
      const taskToMarkDone = reportShouldMarkSourceTaskDone ? reportSourceTaskId : null;

      formElement.reset();
      setReportDraft(reportDraftFromProject(targetProject ?? null));
      setReportWorkDone("");
      setReportIncidents("");
      setReportExtras("");
      setReportOfficeRework("");
      setReportOfficeNextSteps("");
      setReportDate(formatDateISOLocal(new Date()));
      setReportWorkers([{ name: "", start_time: "", end_time: "" }]);
      setReportMaterialRows([createReportMaterialRow("materials")]);
      setReportOfficeMaterialRows([createReportMaterialRow("office_materials")]);
      setReportSourceTaskId(null);
      setReportShouldMarkSourceTaskDone(false);
      setReportTaskChecklist([]);
      clearReportImages();
      // Remove the submitted draft from the array so it doesn't linger in
      // the drafts list. Other drafts (for the same or different projects)
      // are preserved.
      if (activeDraftId) {
        setReportDrafts((prev) => {
          const next = prev.filter((d) => d.id !== activeDraftId);
          try { localStorage.setItem(REPORT_DRAFTS_LS_KEY, JSON.stringify(next)); } catch {}
          return next;
        });
      }
      setActiveDraftId(null);

      // Mark source task done after clearing form state (deferred from markTaskDone).
      if (taskToMarkDone) {
        const task = planningWeek?.days.flatMap((d) => d.tasks).find((t) => t.id === taskToMarkDone)
          ?? null;
        try {
          await apiFetch(`/tasks/${taskToMarkDone}`, token, {
            method: "PATCH",
            body: JSON.stringify({ status: "done" }),
          });
          await loadTasks("my", null);
          setNotice(
            language === "de"
              ? "Aufgabe als erledigt markiert"
              : "Task marked as complete",
          );
        } catch {
          // Non-critical — report was saved, silently skip task mark.
          void task;
        }
      }

      let finalProcessingStatus: ConstructionReportProcessingResponse | null = null;
      const initialStatus = String(createdReport.processing_status || "").toLowerCase();
      if (initialStatus === "queued" || initialStatus === "processing") {
        setReportUploadPhase("processing");
        const timeoutAt = Date.now() + 120_000;
        while (Date.now() < timeoutAt) {
          await sleep(2000);
          try {
            finalProcessingStatus = await apiFetch<ConstructionReportProcessingResponse>(
              `/construction-reports/${createdReport.id}/processing`,
              token,
            );
          } catch {
            finalProcessingStatus = null;
            break;
          }
          if (!finalProcessingStatus) {
            break;
          }
          const statusValue = String(finalProcessingStatus.processing_status || "").toLowerCase();
          if (statusValue === "completed" || statusValue === "failed") {
            break;
          }
        }
      }

      const terminalStatus = String(
        finalProcessingStatus?.processing_status || createdReport.processing_status || "",
      ).toLowerCase();
      if (terminalStatus === "failed") {
        const fallbackDetail =
          language === "de" ? "PDF-Verarbeitung für den Bericht fehlgeschlagen." : "Report PDF processing failed.";
        throw new Error(finalProcessingStatus?.processing_error || createdReport.processing_error || fallbackDetail);
      }
      if (terminalStatus !== "completed") {
        setNotice(
          language === "de"
            ? "Baustellenbericht gespeichert. PDF wird im Hintergrund erstellt."
            : "Construction report saved. PDF is processing in the background.",
        );
      } else {
        const followUpTaskId = Number(createdReport.follow_up_task_id ?? 0);
        if (followUpTaskId > 0) {
          setNotice(
            language === "de"
              ? `Baustellenbericht gespeichert. Folgeaufgabe #${followUpTaskId} mit offenen Unteraufgaben erstellt.`
              : `Construction report saved. Follow-up task #${followUpTaskId} created for open sub-tasks.`,
          );
        } else if (createdReport.report_number && targetProjectId) {
          setNotice(
            language === "de"
              ? `Baustellenbericht #${createdReport.report_number} gespeichert`
              : `Construction report #${createdReport.report_number} saved`,
          );
        } else {
          setNotice(language === "de" ? "Baustellenbericht gespeichert" : "Construction report saved");
        }
      }

      await loadConstructionReportFiles(targetProjectId);
      if (targetProjectId) {
        await loadProjectOverview(targetProjectId);
      }
      setOverview(await apiFetch<any[]>("/projects-overview", token));
      await loadRecentConstructionReports(10);
    } catch (err: any) {
      setError(err.message ?? "Failed to submit report");
    } finally {
      setReportSubmitting(false);
      setReportUploadPercent(null);
      setReportUploadPhase(null);
    }
  }

  async function applyTemplate(userId: number) {
    try {
      await apiFetch(`/admin/users/${userId}/apply-template`, token, { method: "POST" });
      setNotice(language === "de" ? "Rollen-Template angewendet" : "Permission template applied");
    } catch (err: any) {
      setError(err.message ?? "Failed to apply template");
    }
  }

  async function updateRole(userId: number, role: User["role"]) {
    try {
      await apiFetch(`/admin/users/${userId}`, token, {
        method: "PATCH",
        body: JSON.stringify({ role }),
      });
      setUsers(await apiFetch<User[]>("/admin/users", token));
    } catch (err: any) {
      setError(err.message ?? "Failed to update role");
    }
  }

  async function updateWorkspaceLock(userId: number, lock: "construction" | "office" | null) {
    try {
      await apiFetch(`/admin/users/${userId}`, token, {
        method: "PATCH",
        body: JSON.stringify({ workspace_lock: lock }),
      });
      setUsers(await apiFetch<User[]>("/admin/users", token));
      // If the admin is updating their own workspace lock, update the local
      // user state immediately so the sidebar toggle hides and the lock takes
      // effect without a page refresh. Other users will pick up the change on
      // their next /me refresh.
      if (user && user.id === userId) {
        setUser({ ...user, workspace_lock: lock });
      }
    } catch (err: any) {
      setError(err.message ?? "Failed to update workspace lock");
    }
  }

  async function updateRequiredDailyHours(targetUserId: number) {
    const targetHours = Number(requiredHoursDrafts[targetUserId]);
    if (!targetUserId || !Number.isFinite(targetHours) || targetHours < 1 || targetHours > 24) {
      setError(language === "de" ? "Bitte gültige Stunden zwischen 1 und 24 angeben" : "Please enter valid hours between 1 and 24");
      return;
    }
    try {
      await apiFetch(`/time/required-hours/${targetUserId}`, token, {
        method: "PATCH",
        body: JSON.stringify({ required_daily_hours: targetHours }),
      });
      setAssignableUsers((current) =>
        current.map((entry) =>
          entry.id === targetUserId ? { ...entry, required_daily_hours: targetHours } : entry,
        ),
      );
      setRequiredHoursDrafts((current) => ({ ...current, [targetUserId]: String(targetHours) }));
      setUsers((current) =>
        current.map((entry) =>
          entry.id === targetUserId ? { ...entry, required_daily_hours: targetHours } : entry,
        ),
      );
      if (user && user.id === targetUserId) {
        setUser({ ...user, required_daily_hours: targetHours });
      }
      await refreshTimeData();
      setNotice(language === "de" ? "Sollstunden aktualisiert" : "Required hours updated");
    } catch (err: any) {
      setError(err.message ?? "Failed to update required hours");
    }
  }

  async function updateVacationBalance(targetUserId: number) {
    const draft = vacationBalanceDrafts[targetUserId];
    const perYear = Number(draft?.perYear ?? "");
    const available = Number(draft?.available ?? "");
    const carryover = Number(draft?.carryover ?? "");
    if (
      !targetUserId ||
      !Number.isFinite(perYear) ||
      !Number.isFinite(available) ||
      !Number.isFinite(carryover) ||
      perYear < 0 ||
      available < 0 ||
      carryover < 0
    ) {
      setError(language === "de" ? "Bitte gültige Urlaubstage angeben" : "Please enter valid vacation day values");
      return;
    }
    try {
      const updatedBalance = await apiFetch<TimeCurrent | {
        user_id: number;
        vacation_days_per_year: number;
        vacation_days_available: number;
        vacation_days_carryover: number;
        vacation_days_total_remaining: number;
      }>(`/time/vacation-balance/${targetUserId}`, token, {
        method: "PATCH",
        body: JSON.stringify({
          vacation_days_per_year: perYear,
          vacation_days_available: available,
          vacation_days_carryover: carryover,
        }),
      });
      setVacationBalanceDrafts((current) => {
        const next = { ...current };
        delete next[targetUserId];
        return next;
      });
      setAssignableUsers((current) =>
        current.map((entry) =>
          entry.id === targetUserId
            ? {
                ...entry,
                vacation_days_per_year: updatedBalance.vacation_days_per_year,
                vacation_days_available: updatedBalance.vacation_days_available,
                vacation_days_carryover: updatedBalance.vacation_days_carryover,
              }
            : entry,
        ),
      );
      setUsers(await apiFetch<User[]>("/admin/users", token));
      if (user && user.id === targetUserId) {
        setUser({
          ...user,
          vacation_days_per_year: updatedBalance.vacation_days_per_year,
          vacation_days_available: updatedBalance.vacation_days_available,
          vacation_days_carryover: updatedBalance.vacation_days_carryover,
          vacation_days_total_remaining: updatedBalance.vacation_days_total_remaining,
        });
      }
      await refreshTimeData();
      setNotice(language === "de" ? "Urlaubstage aktualisiert" : "Vacation days updated");
    } catch (err: any) {
      setError(err.message ?? "Failed to update vacation balance");
    }
  }

  async function saveProfileSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fullName = profileSettingsForm.full_name.trim();
    const emailValue = profileSettingsForm.email.trim();
    const nicknameValue = profileSettingsForm.nickname.trim();
    const currentNicknameValue = String(user?.nickname ?? "").trim();
    const payload: Record<string, string> = {};
    if (fullName) payload.full_name = fullName;
    if (emailValue) payload.email = emailValue;
    if (canManageUsers) {
      if (!nicknameValue) {
        payload.nickname = "";
        setNicknameCheckState("idle");
        setNicknameCheckMessage("");
      } else if (nicknameValue.toLowerCase() === currentNicknameValue.toLowerCase()) {
        payload.nickname = nicknameValue;
        setNicknameCheckState("idle");
        setNicknameCheckMessage("");
      } else {
        setNicknameCheckState("checking");
        setNicknameCheckMessage(language === "de" ? "Prüfe Verfügbarkeit..." : "Checking availability...");
        try {
          const availability = await apiFetch<NicknameAvailability>(
            `/auth/nickname-availability?nickname=${encodeURIComponent(nicknameValue)}`,
            token,
          );
          if (!availability.available) {
            setNicknameCheckState("unavailable");
            setNicknameCheckMessage(
              language === "de"
                ? "Nickname ist nicht verfügbar."
                : "Nickname is not available.",
            );
            setError(
              language === "de"
                ? "Nickname ist nicht verfügbar. Bitte einen anderen wählen."
                : "Nickname is not available. Please choose another one.",
            );
            return;
          }
          setNicknameCheckState("available");
          setNicknameCheckMessage(language === "de" ? "Nickname verfügbar." : "Nickname is available.");
          payload.nickname = nicknameValue;
        } catch (err: any) {
          setNicknameCheckState("unavailable");
          setNicknameCheckMessage(err.message ?? "Nickname availability check failed");
          setError(err.message ?? "Failed to verify nickname availability");
          return;
        }
      }
    }
    if (profileSettingsForm.current_password.trim()) {
      payload.current_password = profileSettingsForm.current_password;
    }
    if (profileSettingsForm.new_password.trim()) {
      payload.new_password = profileSettingsForm.new_password;
    }

    try {
      const updated = await apiFetch<User>("/auth/me", token, {
        method: "PATCH",
        body: JSON.stringify(payload),
      });
      setUser(updated);
      setProfileSettingsForm({
        full_name: updated.full_name,
        email: updated.email,
        nickname: updated.nickname ?? "",
        current_password: "",
        new_password: "",
      });
      if (canManageUsers) {
        setUsers(await apiFetch<User[]>("/admin/users", token));
      }
      setNotice(language === "de" ? "Profil gespeichert" : "Profile updated");
    } catch (err: any) {
      setError(err.message ?? "Failed to update profile");
    }
  }

  function formatActionLinkNotice(
    result: InviteDispatchResponse | PasswordResetDispatchResponse,
    type: "invite" | "reset",
    copied: boolean,
  ) {
    if (result.sent) {
      if (type === "invite") {
        return language === "de"
          ? copied
            ? "Einladung per E-Mail versendet und Link kopiert"
            : "Einladung per E-Mail versendet. Link zum Kopieren geoeffnet"
          : copied
            ? "Invitation email sent and link copied"
            : "Invitation email sent. Opened link dialog for copying";
      }
      return language === "de"
        ? copied
          ? "Passwort-Reset per E-Mail versendet und Link kopiert"
          : "Passwort-Reset per E-Mail versendet. Link zum Kopieren geoeffnet"
        : copied
          ? "Password reset email sent and link copied"
          : "Password reset email sent. Opened link dialog for copying";
    }
    // Send failed — surface the reason so admins know WHY clipboard took over.
    const detail = result.email_error_detail?.trim();
    const reason = detail
      ? detail
      : result.email_error_type === "not_configured"
        ? language === "de"
          ? "SMTP nicht konfiguriert"
          : "SMTP not configured"
        : language === "de"
          ? "E-Mail-Versand fehlgeschlagen"
          : "Email send failed";
    return language === "de"
      ? copied
        ? `${reason}. Link wurde kopiert.`
        : `${reason}. Link zum Kopieren geöffnet.`
      : copied
        ? `${reason}. Link copied.`
        : `${reason}. Opened link dialog for copying.`;
  }

  async function copyActionLink(value: string) {
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(value);
        return;
      } catch {
        // Fallback below.
      }
    }
    const fallback = document.createElement("textarea");
    fallback.value = value;
    fallback.setAttribute("readonly", "true");
    fallback.style.position = "absolute";
    fallback.style.left = "-9999px";
    document.body.appendChild(fallback);
    fallback.focus();
    fallback.select();
    const copied = document.execCommand("copy");
    document.body.removeChild(fallback);
    if (!copied) {
      throw new Error("Clipboard copy failed");
    }
  }

  async function handleActionLinkResult(
    result: InviteDispatchResponse | PasswordResetDispatchResponse,
    type: "invite" | "reset",
  ) {
    const linkValue = "invite_link" in result ? result.invite_link : result.reset_link;
    let copied = false;
    try {
      await copyActionLink(linkValue);
      copied = true;
      setActionLinkDialog(null);
    } catch {
      copied = false;
      setActionLinkDialog({ type, link: linkValue });
    }
    setNotice(formatActionLinkNotice(result, type, copied));
  }

  async function sendInviteToUser(targetUserId: number) {
    setAdminUserMenuOpenId(null);
    try {
      const result = await apiFetch<InviteDispatchResponse>(`/admin/users/${targetUserId}/send-invite`, token, {
        method: "POST",
      });
      setUsers(await apiFetch<User[]>("/admin/users", token));
      await handleActionLinkResult(result, "invite");
    } catch (err: any) {
      setError(err.message ?? "Failed to send invite");
    }
  }

  async function sendPasswordResetToUser(targetUserId: number) {
    setAdminUserMenuOpenId(null);
    try {
      const result = await apiFetch<PasswordResetDispatchResponse>(
        `/admin/users/${targetUserId}/send-password-reset`,
        token,
        {
          method: "POST",
        },
      );
      setUsers(await apiFetch<User[]>("/admin/users", token));
      await handleActionLinkResult(result, "reset");
    } catch (err: any) {
      setError(err.message ?? "Failed to send password reset");
    }
  }

  async function softDeleteUser(targetUserId: number) {
    if (user && user.id === targetUserId) {
      setError(language === "de" ? "Eigenes Konto kann nicht gelöscht werden." : "You cannot delete your own account.");
      return;
    }
    const confirmed = window.confirm(
      language === "de"
        ? "Benutzer archivieren? Die Daten bleiben für Auswertungen erhalten."
        : "Archive user? Historical data remains available for reporting.",
    );
    if (!confirmed) return;

    setAdminUserMenuOpenId(null);
    try {
      const result = await apiFetch<{ ok: boolean; user_id: number; deleted: boolean }>(
        `/admin/users/${targetUserId}`,
        token,
        {
          method: "DELETE",
        },
      );
      setUsers(await apiFetch<User[]>("/admin/users", token));
      setAssignableUsers(await apiFetch<AssignableUser[]>("/users/assignable", token));
      setNotice(
        result.deleted
          ? language === "de"
            ? "Benutzer archiviert"
            : "User archived"
          : language === "de"
            ? "Benutzer war bereits archiviert"
            : "User was already archived",
      );
    } catch (err: any) {
      setError(err.message ?? "Failed to delete user");
    }
  }

  async function restoreArchivedUser(targetUserId: number) {
    setAdminUserMenuOpenId(null);
    try {
      await apiFetch<User>(`/admin/users/${targetUserId}`, token, {
        method: "PATCH",
        body: JSON.stringify({ is_active: true }),
      });
      setUsers(await apiFetch<User[]>("/admin/users", token));
      setAssignableUsers(await apiFetch<AssignableUser[]>("/users/assignable", token));
      setNotice(language === "de" ? "Benutzer wiederhergestellt" : "User restored");
    } catch (err: any) {
      setError(err.message ?? "Failed to restore user");
    }
  }

  async function submitCreateInvite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const emailValue = inviteCreateForm.email.trim();
    const nameValue = inviteCreateForm.full_name.trim();
    if (!emailValue || !nameValue) {
      setError(language === "de" ? "Bitte Name und E-Mail angeben." : "Please provide name and email.");
      return;
    }
    try {
      const result = await apiFetch<InviteDispatchResponse>("/admin/invites", token, {
        method: "POST",
        body: JSON.stringify({
          email: emailValue,
          full_name: nameValue,
          role: inviteCreateForm.role,
        }),
      });
      setInviteCreateForm({ email: "", full_name: "", role: "employee" });
      setUsers(await apiFetch<User[]>("/admin/users", token));
      await handleActionLinkResult(result, "invite");
    } catch (err: any) {
      setError(err.message ?? "Failed to create invite");
    }
  }

  async function exportEncryptedDatabaseBackup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canExportBackups) return;
    const form = event.currentTarget;
    const formData = new FormData(form);
    const keyFile = formData.get("key_file");
    if (!(keyFile instanceof File) || keyFile.size <= 0) {
      setError(language === "de" ? "Bitte eine Schlüsseldatei auswählen." : "Please select a key file.");
      return;
    }

    setBackupExporting(true);
    try {
      const headers: HeadersInit = {};
      if (token) {
        headers.Authorization = `Bearer ${token}`;
      }
      const response = await fetch("/api/admin/backups/database", {
        method: "POST",
        headers,
        body: formData,
        credentials: "include",
      });
      if (!response.ok) {
        let detail = response.statusText;
        try {
          const payload = await response.json();
          detail = payload.detail ?? detail;
        } catch {
          // no-op
        }
        throw new Error(detail || "Backup export failed");
      }

      const blob = await response.blob();
      const disposition = response.headers.get("content-disposition") ?? "";
      const fileNameMatch = disposition.match(/filename\*?=(?:UTF-8''|\"|)([^\";]+)/i);
      const rawFileName = fileNameMatch?.[1]?.trim() || "smpl-db-backup.smplbak";
      const normalizedRawFileName = rawFileName.replace(/\"/g, "");
      let fileName = normalizedRawFileName;
      try {
        fileName = decodeURIComponent(normalizedRawFileName);
      } catch {
        fileName = normalizedRawFileName;
      }
      const blobUrl = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = blobUrl;
      link.download = fileName;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(blobUrl);
      form.reset();
      setNotice(
        language === "de"
          ? "Verschlüsseltes Datenbank-Backup wurde heruntergeladen."
          : "Encrypted database backup downloaded.",
      );
    } catch (err: any) {
      setError(err.message ?? "Failed to export backup");
    } finally {
      setBackupExporting(false);
    }
  }

  const loadEmployeeGroups = async () => {
    if (!token) return;
    setEmployeeGroupsLoading(true);
    try {
      const res = await fetch("/api/admin/employee-groups", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const data = await res.json();
        setEmployeeGroups(data);
      }
    } catch {
      // silently ignore
    } finally {
      setEmployeeGroupsLoading(false);
    }
  };

  const createEmployeeGroup = async (
    name: string,
    memberIds: number[],
    canUpdateRecentOwnTimeEntries: boolean,
  ) => {
    if (!token) return;
    const res = await fetch("/api/admin/employee-groups", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        name,
        member_user_ids: memberIds,
        can_update_recent_own_time_entries: canUpdateRecentOwnTimeEntries,
      }),
    });
    if (res.ok) {
      const created = await res.json();
      setEmployeeGroups((prev) => [...prev, created].sort((a, b) => a.name.localeCompare(b.name)));
    } else {
      setError("Failed to create group");
    }
  };

  const updateEmployeeGroup = async (
    id: number,
    patch: {
      name?: string;
      member_user_ids?: number[];
      can_update_recent_own_time_entries?: boolean;
    },
  ) => {
    if (!token) return;
    const res = await fetch(`/api/admin/employee-groups/${id}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (res.ok) {
      const updated = await res.json();
      setEmployeeGroups((prev) =>
        prev.map((g) => (g.id === id ? updated : g)).sort((a, b) => a.name.localeCompare(b.name)),
      );
    } else {
      setError("Failed to update group");
    }
  };

  const deleteEmployeeGroup = async (id: number) => {
    if (!token) return;
    const res = await fetch(`/api/admin/employee-groups/${id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) {
      setEmployeeGroups((prev) => prev.filter((g) => g.id !== id));
    } else {
      setError("Failed to delete group");
    }
  };

  const loadAuditLogs = async () => {
    if (!token || !canViewAudit) return;
    setAuditLogsLoading(true);
    try {
      const res = await fetch("/api/admin/audit-logs", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const data = await res.json();
        setAuditLogs(data);
      }
    } catch {
      // silently ignore
    } finally {
      setAuditLogsLoading(false);
    }
  };

  const loadRolePermissions = async () => {
    if (!token || !canManagePermissions) return;
    setRolePermissionsLoading(true);
    try {
      const res = await fetch("/api/admin/role-permissions", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const data = await res.json();
        setRolePermissionsMeta(data);
      }
    } catch {
      // silently ignore
    } finally {
      setRolePermissionsLoading(false);
    }
  };

  const setRolePermission = async (role: string, permission: string, enabled: boolean) => {
    if (!token || !canManagePermissions) return;
    const meta = rolePermissionsMetaRef.current;
    if (!meta) return;

    const current = meta.permissions[role] ?? [];
    const next = enabled
      ? [...new Set([...current, permission])]
      : current.filter((p) => p !== permission);
    const unchanged =
      current.length === next.length && current.every((value, index) => value === next[index]);
    if (unchanged) return;

    const optimisticMeta = {
      ...meta,
      permissions: { ...meta.permissions, [role]: next },
    };
    rolePermissionsMetaRef.current = optimisticMeta;
    setRolePermissionsMeta(optimisticMeta);

    const previousQueue = rolePermissionSaveQueuesRef.current[role] ?? Promise.resolve();
    const currentRequest = previousQueue
      .catch(() => undefined)
      .then(async () => {
        const latestMeta = rolePermissionsMetaRef.current;
        const latestPermissions = latestMeta?.permissions[role] ?? [];
        const res = await fetch(`/api/admin/role-permissions/${role}`, {
          method: "PUT",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ permissions: latestPermissions }),
        });
        if (!res.ok) {
          await loadRolePermissions();
          return;
        }
        const data = await res.json();
        setRolePermissionsMeta((prev) => {
          const merged = prev ? { ...prev, permissions: data.permissions } : prev;
          rolePermissionsMetaRef.current = merged;
          return merged;
        });
        await refreshCurrentUser();
      })
      .catch(async () => {
        await loadRolePermissions();
      });

    rolePermissionSaveQueuesRef.current[role] = currentRequest;
    await currentRequest;
  };

  const resetRoleToDefaults = async (role: string) => {
    if (!token || !canManagePermissions) return;
    try {
      const res = await fetch(`/api/admin/role-permissions/${role}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const data = await res.json();
        setRolePermissionsMeta((prev) =>
          prev ? { ...prev, permissions: data.permissions } : prev,
        );
        await refreshCurrentUser();
      }
    } catch {
      // silently ignore
    }
  };

  const loadUserPermissions = async (userId: number) => {
    if (!token || !canManagePermissions) return;
    setUserPermissionsLoading(true);
    try {
      const res = await fetch(`/api/admin/user-permissions/${userId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const data: UserPermissionOverride = await res.json();
        setUserPermissionOverrides((prev) => ({ ...prev, [userId]: data }));
      }
    } catch {
      // silently ignore
    } finally {
      setUserPermissionsLoading(false);
    }
  };

  const setUserPermissionOverride = async (userId: number, extra: string[], denied: string[]) => {
    if (!token || !canManagePermissions) return;
    try {
      const res = await fetch(`/api/admin/user-permissions/${userId}`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ extra, denied }),
      });
      if (res.ok) {
        const data: UserPermissionOverride = await res.json();
        setUserPermissionOverrides((prev) => ({ ...prev, [userId]: data }));
        await refreshCurrentUser();
      }
    } catch {
      // silently ignore
    }
  };

  const resetUserPermissions = async (userId: number) => {
    if (!token || !canManagePermissions) return;
    try {
      const res = await fetch(`/api/admin/user-permissions/${userId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const data: UserPermissionOverride = await res.json();
        setUserPermissionOverrides((prev) => ({ ...prev, [userId]: data }));
      }
    } catch {
      // silently ignore
    }
  };

  async function submitVacationRequest(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const startDate = vacationRequestForm.start_date;
    const endDate = vacationRequestForm.end_date;
    if (!startDate || !endDate) {
      setError(language === "de" ? "Bitte Start- und Enddatum angeben." : "Please select start and end date.");
      return;
    }
    try {
      await apiFetch<VacationRequest>("/time/vacation-requests", token, {
        method: "POST",
        body: JSON.stringify({
          start_date: startDate,
          end_date: endDate,
          note: vacationRequestForm.note.trim() || null,
        }),
      });
      setVacationRequestForm({
        start_date: formatDateISOLocal(new Date()),
        end_date: formatDateISOLocal(new Date()),
        note: "",
      });
      await refreshTimeData();
      setNotice(language === "de" ? "Urlaubsantrag gesendet" : "Vacation request submitted");
    } catch (err: any) {
      setError(err.message ?? "Failed to submit vacation request");
    }
  }

  async function reviewVacationRequest(requestId: number, status: "approved" | "rejected") {
    try {
      await apiFetch<VacationRequest>(`/time/vacation-requests/${requestId}`, token, {
        method: "PATCH",
        body: JSON.stringify({ status }),
      });
      if (canManageUsers) {
        setUsers(await apiFetch<User[]>("/admin/users", token));
      }
      if (user) {
        setUser(await apiFetch<User>("/auth/me", token));
      }
      await refreshTimeData();
      setNotice(
        status === "approved"
          ? language === "de"
            ? "Urlaubsantrag genehmigt"
            : "Vacation request approved"
          : language === "de"
            ? "Urlaubsantrag abgelehnt"
            : "Vacation request rejected",
      );
    } catch (err: any) {
      setError(err.message ?? "Failed to review vacation request");
    }
  }

  async function submitSchoolAbsence(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const targetUserId = canManageSchoolAbsences ? Number(schoolAbsenceForm.user_id) : Number(user?.id ?? 0);
    if (!targetUserId || !Number.isFinite(targetUserId)) {
      setError(language === "de" ? "Bitte Mitarbeiter auswählen." : "Please choose an employee.");
      return;
    }
    const title = schoolAbsenceForm.title.trim() || "Berufsschule";
    const absenceType = schoolAbsenceForm.absence_type || "other";
    const typeInfo = absenceTypes.find((t) => t.key === absenceType);
    const countsAsHours = typeInfo ? typeInfo.counts_as_hours : true;
    const selectedWeekdays = [...schoolAbsenceForm.recurrence_weekdays].sort((a, b) => a - b);
    const recurrenceUntil = schoolAbsenceForm.recurrence_until || schoolAbsenceForm.end_date || null;
    if (editingSchoolAbsenceId !== null && selectedWeekdays.length > 1) {
      setError(
        language === "de"
          ? "Wiederkehrende Abwesenheiten bitte einzeln bearbeiten."
          : "Please edit recurring absences one day at a time.",
      );
      return;
    }
    try {
      if (editingSchoolAbsenceId !== null) {
        await apiFetch<SchoolAbsence>(`/time/school-absences/${editingSchoolAbsenceId}`, token, {
          method: "PATCH",
          body: JSON.stringify({
            title,
            absence_type: absenceType,
            counts_as_hours: countsAsHours,
            start_date: schoolAbsenceForm.start_date,
            end_date: selectedWeekdays.length > 0 ? schoolAbsenceForm.start_date : schoolAbsenceForm.end_date,
            recurrence_weekday: selectedWeekdays.length > 0 ? selectedWeekdays[0] : null,
            recurrence_until: selectedWeekdays.length > 0 ? recurrenceUntil : null,
          }),
        });
      } else if (selectedWeekdays.length > 0) {
        await Promise.all(
          selectedWeekdays.map((day) =>
            apiFetch<SchoolAbsence>("/time/school-absences", token, {
              method: "POST",
              body: JSON.stringify({
                user_id: targetUserId,
                title,
                absence_type: absenceType,
                counts_as_hours: countsAsHours,
                start_date: schoolAbsenceForm.start_date,
                end_date: schoolAbsenceForm.start_date,
                recurrence_weekday: day,
                recurrence_until: recurrenceUntil,
              }),
            }),
          ),
        );
      } else {
        await apiFetch<SchoolAbsence>("/time/school-absences", token, {
          method: "POST",
          body: JSON.stringify({
            user_id: targetUserId,
            title,
            absence_type: absenceType,
            counts_as_hours: countsAsHours,
            start_date: schoolAbsenceForm.start_date,
            end_date: schoolAbsenceForm.end_date,
            recurrence_weekday: null,
            recurrence_until: null,
          }),
        });
      }
      cancelSchoolAbsenceEdit();
      await refreshTimeData();
      setNotice(
        editingSchoolAbsenceId !== null
          ? language === "de"
            ? "Abwesenheit aktualisiert"
            : "Absence updated"
          : canManageSchoolAbsences
            ? language === "de"
              ? "Abwesenheit gespeichert"
              : "Absence saved"
            : language === "de"
              ? "Abwesenheitsantrag gesendet"
              : "Absence request submitted",
      );
    } catch (err: any) {
      setError(err.message ?? "Failed to save absence");
    }
  }

  function startSchoolAbsenceEdit(absence: SchoolAbsence) {
    setEditingSchoolAbsenceId(absence.id);
    setSchoolAbsenceForm({
      user_id: String(absence.user_id),
      title: absence.title,
      absence_type: absence.absence_type,
      start_date: absence.start_date,
      end_date: absence.end_date,
      recurrence_weekdays:
        absence.recurrence_weekday !== null && absence.recurrence_weekday !== undefined
          ? [absence.recurrence_weekday]
          : [],
      recurrence_until: absence.recurrence_until ?? "",
    });
  }

  function cancelSchoolAbsenceEdit() {
    setEditingSchoolAbsenceId(null);
    setSchoolAbsenceForm({
      user_id: "",
      title: "Berufsschule",
      absence_type: "school",
      start_date: formatDateISOLocal(new Date()),
      end_date: formatDateISOLocal(new Date()),
      recurrence_weekdays: [],
      recurrence_until: "",
    });
  }

  async function reviewSchoolAbsence(absenceId: number, status: "approved" | "rejected") {
    try {
      await apiFetch<SchoolAbsence>(`/time/school-absences/${absenceId}/review`, token, {
        method: "PATCH",
        body: JSON.stringify({ status }),
      });
      await refreshTimeData();
      setNotice(
        status === "approved"
          ? language === "de"
            ? "Abwesenheitsantrag genehmigt"
            : "Absence request approved"
          : language === "de"
            ? "Abwesenheitsantrag abgelehnt"
            : "Absence request rejected",
      );
    } catch (err: any) {
      setError(err.message ?? "Failed to review absence request");
    }
  }

  function toggleSchoolRecurrenceWeekday(day: number, checked: boolean) {
    setSchoolAbsenceForm((current) => {
      const existing = new Set(current.recurrence_weekdays);
      if (checked) {
        existing.add(day);
      } else {
        existing.delete(day);
      }
      return {
        ...current,
        recurrence_weekdays: [...existing].sort((a, b) => a - b),
      };
    });
  }

  async function removeSchoolAbsence(absenceId: number) {
    const confirmed = window.confirm(
      language === "de"
        ? "Abwesenheit wirklich löschen?"
        : "Do you really want to delete this absence?",
    );
    if (!confirmed) return;
    try {
      await apiFetch(`/time/school-absences/${absenceId}`, token, { method: "DELETE" });
      if (editingSchoolAbsenceId === absenceId) {
        cancelSchoolAbsenceEdit();
      }
      await refreshTimeData();
      setNotice(language === "de" ? "Abwesenheit gelöscht" : "Absence deleted");
    } catch (err: any) {
      setError(err.message ?? "Failed to delete absence");
    }
  }

  async function downloadProjectCsvTemplate() {
    if (!canManageProjectImport) return;
    try {
      const response = await fetch("/api/admin/projects/import-template.csv", {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        credentials: "include",
      });
      if (!response.ok) {
        throw new Error(response.statusText || "Template download failed");
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      try {
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = "projects-import-template.csv";
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
      } finally {
        URL.revokeObjectURL(url);
      }
    } catch (err: any) {
      setError(err.message ?? "Failed to download CSV template");
    }
  }

  async function downloadProjectClassTemplateCsv() {
    if (!canManageProjectImport) return;
    try {
      const response = await fetch("/api/admin/project-classes/template.csv", {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        credentials: "include",
      });
      if (!response.ok) {
        throw new Error(response.statusText || "Template download failed");
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      try {
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = "project-class-template.csv";
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
      } finally {
        URL.revokeObjectURL(url);
      }
    } catch (err: any) {
      setError(err.message ?? "Failed to download project class template");
    }
  }

  async function importProjectsCsv(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canManageProjectImport) return;
    const form = new FormData(event.currentTarget);
    const file = form.get("file");
    if (!(file instanceof File) || file.size <= 0) {
      setError(language === "de" ? "Bitte eine CSV-Datei auswählen." : "Please select a CSV file.");
      return;
    }
    const payload = new FormData();
    payload.set("file", file);
    try {
      const result = await apiFetch<{
        processed_rows: number;
        created: number;
        updated: number;
        temporary_numbers: number;
        duplicates_skipped: number;
        skipped_project_fields: number;
        skipped_finance_fields: number;
        skipped_filled_fields: number;
      }>("/admin/projects/import-csv", token, {
        method: "POST",
        body: payload,
      });
      await loadBaseData();
      const skippedFilledFields =
        typeof result.skipped_filled_fields === "number"
          ? result.skipped_filled_fields
          : (result.skipped_project_fields ?? 0) + (result.skipped_finance_fields ?? 0);
      setNotice(
        language === "de"
          ? `CSV importiert: ${result.processed_rows} Zeilen, ${result.created} neu, ${result.updated} aktualisiert, ${skippedFilledFields} Felder übersprungen (bereits befüllt)`
          : `CSV imported: ${result.processed_rows} rows, ${result.created} created, ${result.updated} updated, ${skippedFilledFields} fields skipped (already filled)`,
      );
      event.currentTarget.reset();
    } catch (err: any) {
      setError(err.message ?? "Failed to import CSV");
    }
  }

  async function importProjectClassTemplateCsv(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canManageProjectImport) return;
    const form = new FormData(event.currentTarget);
    const file = form.get("file");
    if (!(file instanceof File) || file.size <= 0) {
      setError(language === "de" ? "Bitte eine CSV-Datei auswählen." : "Please select a CSV file.");
      return;
    }
    const payload = new FormData();
    payload.set("file", file);
    try {
      const result = await apiFetch<{
        created: number;
        updated: number;
        classes: number;
        task_templates: number;
      }>("/admin/project-classes/import-csv", token, {
        method: "POST",
        body: payload,
      });
      await loadBaseData();
      setNotice(
        language === "de"
          ? `Klassen-Template importiert: ${result.classes} Klassen (${result.created} neu, ${result.updated} aktualisiert)`
          : `Class template imported: ${result.classes} classes (${result.created} created, ${result.updated} updated)`,
      );
      event.currentTarget.reset();
    } catch (err: any) {
      setError(err.message ?? "Failed to import class template CSV");
    }
  }

  // ── Customers (Kunden) helpers ────────────────────────────────────────────
  // Thin wrappers around the real `/api/customers` endpoints that keep
  // `customers` in state and surface user-facing errors through `setError`.
  // Token passed explicitly, matching `loadPartners` / `savePartner` shape.
  const loadCustomers = useCallback(
    async (query: string = "", archived: boolean = false): Promise<void> => {
      try {
        const rows = await apiListCustomers(token, query, archived);
        setCustomers(rows);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setError(
          message ||
            (language === "de"
              ? "Kunden konnten nicht geladen werden"
              : "Failed to load customers"),
        );
      }
    },
    [language, token],
  );

  const saveCustomer = useCallback(
    async (data: CustomerWriteInput, id?: number): Promise<CustomerListItem> => {
      const saved = await apiSaveCustomer(token, data, id);
      setCustomers((current) => {
        const existingIndex = current.findIndex((row) => row.id === saved.id);
        if (existingIndex >= 0) {
          return current.map((row) => (row.id === saved.id ? saved : row));
        }
        return [...current, saved];
      });
      setNotice(
        language === "de"
          ? id
            ? "Kunde aktualisiert"
            : "Kunde angelegt"
          : id
            ? "Customer updated"
            : "Customer created",
      );
      return saved;
    },
    [language, token],
  );

  const archiveCustomer = useCallback(
    async (id: number): Promise<void> => {
      try {
        const updated = await apiArchiveCustomer(token, id);
        setCustomers((current) =>
          current.map((row) => (row.id === id ? updated : row)),
        );
        setNotice(language === "de" ? "Kunde archiviert" : "Customer archived");
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
      }
    },
    [language, token],
  );

  const unarchiveCustomer = useCallback(
    async (id: number): Promise<void> => {
      try {
        const updated = await apiUnarchiveCustomer(token, id);
        setCustomers((current) =>
          current.map((row) => (row.id === id ? updated : row)),
        );
        setNotice(
          language === "de" ? "Kunde wiederhergestellt" : "Customer restored",
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
      }
    },
    [language, token],
  );

  const openCustomer = useCallback((id: number) => {
    setActiveCustomerId(id);
    setProjectBackView(null);
    setOverviewShortcutBackVisible(false);
    setMainView("customer_detail");
  }, []);

  const openCustomerModal = useCallback((options: CustomerModalOpenOptions) => {
    setCustomerModalDraft(options);
    setCustomerModalOpen(true);
  }, []);

  const closeCustomerModal = useCallback(() => {
    setCustomerModalOpen(false);
    setCustomerModalDraft(null);
  }, []);

  // ── Partners (external contractors) helpers ──────────────────────────────
  // Thin wrappers around `utils/partnersApi` keeping `partners` in state and
  // surfacing errors through `setError`. Calls real backend endpoints.
  const loadPartners = useCallback(
    async (
      query: string = "",
      archived: boolean = false,
      trade: string | null = null,
    ): Promise<void> => {
      try {
        const rows = await apiListPartners(token, query, archived, trade);
        setPartners(rows);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setError(
          message ||
            (language === "de"
              ? "Partner konnten nicht geladen werden"
              : "Failed to load partners"),
        );
      }
    },
    [token, language],
  );

  const savePartner = useCallback(
    async (data: PartnerWriteInput, id?: number): Promise<PartnerListItem> => {
      const saved = await apiSavePartner(token, data, id);
      setPartners((current) => {
        const existingIndex = current.findIndex((row) => row.id === saved.id);
        if (existingIndex >= 0) {
          return current.map((row) => (row.id === saved.id ? saved : row));
        }
        return [...current, saved];
      });
      setNotice(
        language === "de"
          ? id
            ? "Partner aktualisiert"
            : "Partner angelegt"
          : id
            ? "Partner updated"
            : "Partner created",
      );
      return saved;
    },
    [token, language],
  );

  const archivePartner = useCallback(
    async (id: number): Promise<void> => {
      try {
        const updated = await apiArchivePartner(token, id);
        setPartners((current) =>
          current.map((row) => (row.id === id ? updated : row)),
        );
        setNotice(language === "de" ? "Partner archiviert" : "Partner archived");
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
      }
    },
    [token, language],
  );

  const unarchivePartner = useCallback(
    async (id: number): Promise<void> => {
      try {
        const updated = await apiUnarchivePartner(token, id);
        setPartners((current) =>
          current.map((row) => (row.id === id ? updated : row)),
        );
        setNotice(
          language === "de" ? "Partner wiederhergestellt" : "Partner restored",
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
      }
    },
    [token, language],
  );

  const openPartnerModal = useCallback((options: PartnerModalOpenOptions) => {
    setPartnerModalDraft(options);
    setPartnerModalOpen(true);
  }, []);

  const closePartnerModal = useCallback(() => {
    setPartnerModalOpen(false);
    setPartnerModalDraft(null);
  }, []);

  const partnerById = useCallback(
    (id: number): Partner | null => {
      const row = partners.find((p) => p.id === id);
      return row ?? null;
    },
    [partners],
  );

  // Initial mock-data hydration — the backend swap removes the need for this
  // because the real API will stream via SSE like the rest of the app.
  useEffect(() => {
    if (!token) return;
    void loadCustomers("", false);
  }, [token, loadCustomers]);

  // Partners load on login. The Werkstatt → Partner tab re-triggers with
  // specific filters; this initial pull keeps the TaskModal multi-select
  // suggestions warm regardless of whether the user ever visits the tab.
  useEffect(() => {
    if (!token) return;
    void loadPartners("", false, null);
  }, [token, loadPartners]);

  function openProfileViewFromMenu() {
    setProjectBackView(null);
    setOverviewShortcutBackVisible(false);
    setMainView("profile");
    setPreUserMenuOpen(false);
  }

  function openAdminViewFromMenu() {
    setProjectBackView(null);
    setOverviewShortcutBackVisible(false);
    setMainView("admin");
    setPreUserMenuOpen(false);
  }

  function signOut() {
    localStorage.removeItem("smpl_token");
    setToken(null);
    setPreUserMenuOpen(false);
  }

  async function copyToClipboard(value: string, label: "all" | "project" | "address") {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
      } else {
        const fallback = document.createElement("textarea");
        fallback.value = value;
        fallback.setAttribute("readonly", "true");
        fallback.style.position = "absolute";
        fallback.style.left = "-9999px";
        document.body.appendChild(fallback);
        fallback.select();
        document.execCommand("copy");
        document.body.removeChild(fallback);
      }
      setNotice(
        language === "de"
          ? label === "all"
            ? "WebDAV-Link (alle Projekte) kopiert"
            : label === "project"
              ? "WebDAV-Link (aktuelles Projekt) kopiert"
              : "Projektadresse kopiert"
          : label === "all"
            ? "WebDAV link (all projects) copied"
            : label === "project"
              ? "WebDAV link (current project) copied"
              : "Project address copied",
      );
    } catch {
      setError(
        language === "de"
          ? label === "address"
            ? "Adresse konnte nicht kopiert werden"
            : "Link konnte nicht kopiert werden"
          : label === "address"
            ? "Failed to copy address"
            : "Failed to copy link",
      );
    }
  }

  const contextValue: AppContextValue = {
    // ── Core auth / session ───────────────────────────────────────────────────
    token,
    setToken,
    language,
    setLanguage,
    workspaceMode,
    setWorkspaceMode,
    now,

    // ── Current user ──────────────────────────────────────────────────────────
    user,
    setUser,
    saveUserPreference,

    // ── Navigation ────────────────────────────────────────────────────────────
    mainView,
    setMainView,
    sidebarOpen,
    setSidebarOpen,
    overviewShortcutBackVisible,
    setOverviewShortcutBackVisible,
    projectTab,
    setProjectTab,
    werkstattTab,
    setWerkstattTab,
    activeWerkstattArticleId,
    setActiveWerkstattArticleId,
    projectBackView,
    setProjectBackView,
    constructionBackView,
    setConstructionBackView,

    // ── Error / notice ────────────────────────────────────────────────────────
    error,
    setError,
    notice,
    setNotice,

    // ── Login form ────────────────────────────────────────────────────────────
    email,
    setEmail,
    password,
    setPassword,
    publicAuthMode,
    setPublicAuthMode,
    publicToken,
    setPublicToken,
    publicFullName,
    setPublicFullName,
    publicEmail,
    setPublicEmail,
    publicNewPassword,
    setPublicNewPassword,
    publicConfirmPassword,
    setPublicConfirmPassword,

    // ── Users ─────────────────────────────────────────────────────────────────
    users,
    setUsers,
    assignableUsers,
    setAssignableUsers,
    threadParticipantRoles,
    setThreadParticipantRoles,

    // ── Projects ──────────────────────────────────────────────────────────────
    projects,
    setProjects,
    activeProjectId,
    setActiveProjectId,
    highlightedArchivedProjectId,
    setHighlightedArchivedProjectId,
    overview,
    setOverview,
    overviewStatusFilter,
    setOverviewStatusFilter,
    projectsAllSearch,
    setProjectsAllSearch,
    projectsAllStateFilter,
    setProjectsAllStateFilter,
    projectsAllEditedFilter,
    setProjectsAllEditedFilter,
    projectSidebarSearchOpen,
    setProjectSidebarSearchOpen,
    projectSidebarSearchQuery,
    setProjectSidebarSearchQuery,

    // ── Customers ─────────────────────────────────────────────────────────────
    customers,
    setCustomers,
    activeCustomerId,
    setActiveCustomerId,
    customerModalOpen,
    customerModalDraft,
    loadCustomers,
    saveCustomer,
    archiveCustomer,
    unarchiveCustomer,
    openCustomer,
    openCustomerModal,
    closeCustomerModal,

    // ── Partners (external contractors) ────────────────────────────────────────
    partners,
    setPartners,
    partnerModalOpen,
    partnerModalDraft,
    loadPartners,
    savePartner,
    archivePartner,
    unarchivePartner,
    openPartnerModal,
    closePartnerModal,
    partnerById,

    // ── Project class templates ───────────────────────────────────────────────
    projectClassTemplates,
    setProjectClassTemplates,
    projectClassTemplatesByProjectId,
    setProjectClassTemplatesByProjectId,

    // ── Project overview details ──────────────────────────────────────────────
    projectOverviewDetails,
    setProjectOverviewDetails,
    projectOverviewOpenTasks,
    setProjectOverviewOpenTasks,

    // ── Project weather ───────────────────────────────────────────────────────
    projectWeather,
    setProjectWeather,
    projectWeatherLoading,
    setProjectWeatherLoading,

    // ── Project finance ───────────────────────────────────────────────────────
    projectFinance,
    setProjectFinance,
    projectHoursPlannedInput,
    setProjectHoursPlannedInput,
    projectFinanceEditing,
    setProjectFinanceEditing,
    projectFinanceForm,
    setProjectFinanceForm,

    // ── Project note ──────────────────────────────────────────────────────────
    projectNoteEditing,
    setProjectNoteEditing,
    projectNoteDraft,
    setProjectNoteDraft,

    // ── Project modal ─────────────────────────────────────────────────────────
    projectModalMode,
    setProjectModalMode,
    projectForm,
    setProjectForm,
    projectFormBase,
    setProjectFormBase,
    projectEditExpectedLastUpdatedAt,
    setProjectEditExpectedLastUpdatedAt,

    // ── Materials ─────────────────────────────────────────────────────────────
    materialNeeds,
    setMaterialNeeds,
    materialNeedUpdating,
    setMaterialNeedUpdating,
    materialCatalogRows,
    setMaterialCatalogRows,
    materialCatalogState,
    setMaterialCatalogState,
    materialCatalogQuery,
    setMaterialCatalogQuery,
    materialCatalogLoading,
    setMaterialCatalogLoading,
    materialCatalogProjectId,
    setMaterialCatalogProjectId,
    materialCatalogProjectSearch,
    setMaterialCatalogProjectSearch,
    materialCatalogProjectSearchFocused,
    setMaterialCatalogProjectSearchFocused,
    materialCatalogAdding,
    setMaterialCatalogAdding,
    projectTrackedMaterials,
    setProjectTrackedMaterials,

    // ── Tasks ─────────────────────────────────────────────────────────────────
    taskView,
    setTaskView,
    tasks,
    setTasks,
    officeTaskStatusFilter,
    setOfficeTaskStatusFilter,
    officeTaskAssigneeFilter,
    setOfficeTaskAssigneeFilter,
    officeTaskDueDateFilter,
    setOfficeTaskDueDateFilter,
    officeTaskNoDueDateFilter,
    setOfficeTaskNoDueDateFilter,
    officeTaskProjectFilterQuery,
    setOfficeTaskProjectFilterQuery,
    officeTaskProjectFilterIds,
    setOfficeTaskProjectFilterIds,
    expandedMyTaskId,
    setExpandedMyTaskId,
    myTasksBackProjectId,
    setMyTasksBackProjectId,
    hasTaskNotifications,
    notifications,
    notifPanelOpen,
    setNotifPanelOpen,
    markAllNotificationsRead,

    // ── Project task form ─────────────────────────────────────────────────────
    projectTaskForm,
    setProjectTaskForm,
    projectTaskMaterialRows,
    setProjectTaskMaterialRows,

    // ── Task modal ────────────────────────────────────────────────────────────
    taskModalOpen,
    setTaskModalOpen,
    taskModalForm,
    taskModalOverlapWarning,
    setTaskModalOverlapWarning,
    setTaskModalForm,
    taskModalMaterialRows,
    setTaskModalMaterialRows,

    // ── Task edit modal ───────────────────────────────────────────────────────
    taskEditModalOpen,
    setTaskEditModalOpen,
    taskEditForm,
    taskEditOverlapWarning,
    setTaskEditOverlapWarning,
    setTaskEditForm,
    taskEditMaterialRows,
    setTaskEditMaterialRows,
    taskEditFormBase,
    setTaskEditFormBase,
    taskEditExpectedUpdatedAt,
    setTaskEditExpectedUpdatedAt,

    // ── Tickets ───────────────────────────────────────────────────────────────
    tickets,
    setTickets,

    // ── Files ─────────────────────────────────────────────────────────────────
    files,
    setFiles,
    projectFolders,
    setProjectFolders,
    fileQuery,
    setFileQuery,
    fileUploadModalOpen,
    setFileUploadModalOpen,
    fileUploadFolder,
    setFileUploadFolder,
    newProjectFolderPath,
    setNewProjectFolderPath,

    // ── Construction reports ──────────────────────────────────────────────────
    recentConstructionReports,
    setRecentConstructionReports,
    reportProjectId,
    setReportProjectId,
    reportDraft,
    setReportDraft,
    reportWorkDone,
    setReportWorkDone,
    reportIncidents,
    setReportIncidents,
    reportExtras,
    setReportExtras,
    reportOfficeRework,
    setReportOfficeRework,
    reportOfficeNextSteps,
    setReportOfficeNextSteps,
    reportDate,
    setReportDate,
    reportDrafts,
    activeDraftId,
    openReportDraft,
    deleteReportDraft,
    startNewReportDraft,
    reportTaskPrefill,
    setReportTaskPrefill,
    reportSourceTaskId,
    setReportSourceTaskId,
    reportTaskChecklist,
    setReportTaskChecklist,
    reportMaterialRows,
    setReportMaterialRows,
    reportOfficeMaterialRows,
    setReportOfficeMaterialRows,
    reportImageFiles,
    setReportImageFiles,
    reportSubmitting,
    setReportSubmitting,
    reportUploadPercent,
    setReportUploadPercent,
    reportUploadPhase,
    setReportUploadPhase,
    reportWorkers,
    setReportWorkers,

    // ── Wiki ──────────────────────────────────────────────────────────────────
    wikiFiles,
    setWikiFiles,
    wikiSearch,
    setWikiSearch,
    activeWikiPath,
    setActiveWikiPath,

    // ── Planning ──────────────────────────────────────────────────────────────
    planningWeekStart,
    setPlanningWeekStart,
    planningTaskTypeView,
    setPlanningTaskTypeView,
    planningWeek,
    setPlanningWeek,
    calendarWeekStart,
    setCalendarWeekStart,
    calendarWeeks,
    setCalendarWeeks,
    calendarLoading,
    setCalendarLoading,

    // ── Threads / messages ────────────────────────────────────────────────────
    threads,
    setThreads,
    archivedThreads,
    setArchivedThreads,
    archivedThreadsModalOpen,
    setArchivedThreadsModalOpen,
    messages,
    setMessages,
    messageBody,
    setMessageBody,
    messageAttachment,
    setMessageAttachment,
    activeThreadId,
    setActiveThreadId,
    threadModalMode,
    setThreadModalMode,
    threadModalForm,
    setThreadModalForm,
    threadIconFile,
    setThreadIconFile,
    threadIconPreviewUrl,
    setThreadIconPreviewUrl,
    threadActionMenuOpen,
    setThreadActionMenuOpen,

    // ── Time ──────────────────────────────────────────────────────────────────
    timeCurrent,
    setTimeCurrent,
    timeEntries,
    setTimeEntries,
    timeMonthRows,
    setTimeMonthRows,
    vacationRequests,
    setVacationRequests,
    schoolAbsences,
    setSchoolAbsences,
    vacationRequestForm,
    setVacationRequestForm,
    schoolAbsenceForm,
    setSchoolAbsenceForm,
    editingSchoolAbsenceId,
    setEditingSchoolAbsenceId,
    timeMonthCursor,
    setTimeMonthCursor,
    timeEntriesStartDate,
    setTimeEntriesStartDate,
    timeEntriesEndDate,
    setTimeEntriesEndDate,
    timeInfoOpen,
    setTimeInfoOpen,
    timeTargetUserId,
    setTimeTargetUserId,
    timeTargetSearch,
    setTimeTargetSearch,
    timeTargetDropdownOpen,
    setTimeTargetDropdownOpen,
    absenceTypes,
    publicHolidays,
    requiredHoursDrafts,
    setRequiredHoursDrafts,
    vacationBalanceDrafts,
    setVacationBalanceDrafts,

    // ── Profile settings ──────────────────────────────────────────────────────
    profileSettingsForm,
    setProfileSettingsForm,
    nicknameCheckState,
    setNicknameCheckState,
    nicknameCheckMessage,
    setNicknameCheckMessage,

    // ── Admin / invite ────────────────────────────────────────────────────────
    inviteCreateForm,
    setInviteCreateForm,
    backupExporting,
    setBackupExporting,
    weatherSettings,
    setWeatherSettings,
    weatherApiKeyInput,
    setWeatherApiKeyInput,
    weatherSettingsSaving,
    setWeatherSettingsSaving,
    companySettings,
    setCompanySettings,
    companySettingsForm,
    setCompanySettingsForm,
    companySettingsSaving,
    setCompanySettingsSaving,
    smtpSettings,
    setSmtpSettings,
    smtpSettingsForm,
    setSmtpSettingsForm,
    smtpSettingsSaving,
    setSmtpSettingsSaving,
    updateStatus,
    setUpdateStatus,
    updateStatusLoading,
    setUpdateStatusLoading,
    updateInstallRunning,
    setUpdateInstallRunning,
    updateProgress,
    setUpdateProgress,
    preUserMenuOpen,
    setPreUserMenuOpen,
    adminUserMenuOpenId,
    setAdminUserMenuOpenId,
    employeeGroups,
    setEmployeeGroups,
    employeeGroupsLoading,
    auditLogs,
    auditLogsLoading,
    loadEmployeeGroups,
    createEmployeeGroup,
    updateEmployeeGroup,
    deleteEmployeeGroup,
    loadAuditLogs,
    rolePermissionsMeta,
    rolePermissionsLoading,
    loadRolePermissions,
    setRolePermission,
    resetRoleToDefaults,

    // ── Per-user permission overrides ─────────────────────────────────────────
    userPermissionOverrides,
    userPermissionsLoading,
    loadUserPermissions,
    setUserPermissionOverride,
    resetUserPermissions,

    // ── Browser notifications ─────────────────────────────────────────────────
    browserNotifPermission,
    browserNotifIsIosPwa,
    requestBrowserNotifPermission,

    // ── Avatar ────────────────────────────────────────────────────────────────
    avatarModalOpen,
    setAvatarModalOpen,
    avatarSourceUrl,
    setAvatarSourceUrl,
    avatarZoom,
    setAvatarZoom,
    avatarOffsetX,
    setAvatarOffsetX,
    avatarOffsetY,
    setAvatarOffsetY,
    avatarNaturalSize,
    setAvatarNaturalSize,
    avatarStageSize,
    setAvatarStageSize,
    avatarIsDragging,
    setAvatarIsDragging,
    avatarPreviewDataUrl,
    setAvatarPreviewDataUrl,
    avatarSelectedFile,
    setAvatarSelectedFile,
    avatarVersionKey,
    setAvatarVersionKey,

    // ── Refs ──────────────────────────────────────────────────────────────────
    constructionFormRef,
    avatarCropStageRef,
    messageListRef,
    reportImageInputRef,
    messageAttachmentInputRef,
    avatarDragRef,
    preUserMenuRef,

    // ── Derived booleans ──────────────────────────────────────────────────────
    isAdmin,
    canManageUsers,
    canManagePermissions,
    canAdjustRequiredHours,
    canCreateProject,
    canManageTasks,
    isTimeManager,
    canApproveVacation,
    canManageSchoolAbsences,
    canViewAudit,
    canManageSettings,
    canManageSystem,
    canExportBackups,
    canManageProjectImport,
    canMarkCritical,
    setProjectCritical,
    canUseProtectedFolders,
    canManageFiles,
    canViewFinance,
    canManageFinance,
    hasMessageText,
    canSendMessage,
    viewingOwnTime,
    threadModalIsRestricted,

    // ── Derived labels ────────────────────────────────────────────────────────
    mainLabels,
    tabLabels,
    workspaceModeLabel,

    // ── Derived numeric values ────────────────────────────────────────────────
    requiredDailyHours,
    dailyNetHours,
    gaugeNetHours,

    // ── useMemo values ────────────────────────────────────────────────────────
    activeProject,
    activeProjectDavRef,
    activeProjectDavUrl,
    activeProjectHeader,
    activeProjectLastState,
    activeProjectLastStatusAtLabel,
    activeProjectLastUpdatedLabel,
    activeProjectAddress,
    activeProjectMapQuery,
    activeProjectMapEmbedUrl,
    activeProjectMapOpenUrl,
    activeProjectTicketDate,
    activeProjectTicketAddress,
    activeProjectClassTemplates,
    taskModalProjectClassTemplates,
    taskEditProjectClassTemplates,
    projectStatusOptions,
    projectStatusSelectOptions,
    overviewStatusOptions,
    projectsById,
    overviewProjectsById,
    materialNeedRows,
    activeProjects,
    archivedProjects,
    materialCatalogProjectOptions,
    selectedMaterialCatalogProject,
    selectedMaterialCatalogProjectLabel,
    materialCatalogProjectSuggestions,
    filteredSidebarProjects,
    detailedOverviewRows,
    filteredDetailedOverview,
    filteredProjectsAll,
    recentAssignedProjects,
    sortedTasks,
    overviewActionCards,
    overviewActionCardWidth,
    projectTaskAssigneeSuggestions,
    taskModalAssigneeSuggestions,
    taskEditAssigneeSuggestions,
    threadModalUserSuggestions,
    threadModalRoleSuggestions,
    taskModalProjectSuggestions,
    selectedTaskModalProject,
    activeThread,
    hasUnreadThreads,
    sseStatus,
    assignableUsersById,
    adminUsersById,
    compactMenuUserNamesById,
    threadModalSelectedUsers,
    activeAdminUsers,
    archivedAdminUsers,
    chatRenderRows,
    showOverviewBackButton,
    selectedReportProject,
    planningWeekInfo,
    taskStatusOptions,
    officeTaskStatusOptions,
    officeTaskAssigneeOptions,
    officeTaskProjectOptions,
    officeTaskSelectedProjectFilters,
    officeTaskProjectSuggestions,
    officeFilteredTasks,
    navViews,
    projectTabs,
    fileRows,
    wikiRows,
    activeWikiFile,
    projectReportedHoursTotal,
    projectPlannedHoursTotal,
    projectHoursUsagePercent,
    userInitials,
    todayIso,
    calendarRangeLabel,
    timeTargetUser,
    monthWeekDefs,
    monthCursorLabel,
    monthCursorISO,
    monthlyWorkedHours,
    monthlyRequiredHours,
    pendingVacationRequests,
    approvedVacationRequests,
    approvedVacationRequestsByUserId,
    schoolAbsencesByUserId,
    sidebarNowLabel,
    avatarStageState,
    firmwareBuild,
    resolvedCurrentReleaseVersion,
    currentReleaseLabel,

    // ── Sync helper functions ─────────────────────────────────────────────────
    assigneeAvailabilityHint,
    getTaskAssigneeIds,
    isTaskAssignedToCurrentUser,
    menuUserNameById,
    getTaskAssigneeLabel,
    projectTitleParts,
    projectTitle,
    taskProjectTitleParts,
    recentReportProjectTitleParts,
    threadProjectTitleParts,
    ensureProjectVisibleById,
    openProjectById,
    projectSearchLabel,
    openCreateProjectModal,
    openEditProjectModal,
    closeProjectModal,
    onProjectModalBackdropPointerDown,
    onProjectModalBackdropPointerUp,
    resetProjectModalBackdropPointerState,
    updateProjectFormField,
    updateProjectSiteAccessType,
    toggleProjectClassTemplate,
    updateProjectFinanceFormField,
    financeFormPayload,
    validateTimeInputOrSetError,
    updateProjectTaskFormField,
    updateProjectTaskMaterialRow,
    addProjectTaskMaterialRow,
    removeProjectTaskMaterialRow,
    selectProjectTaskClassTemplate,
    addProjectTaskAssignee,
    removeProjectTaskAssignee,
    addFirstMatchingProjectTaskAssignee,
    openTaskModal,
    closeTaskModal,
    onTaskModalBackdropPointerDown,
    onTaskModalBackdropPointerUp,
    resetTaskModalBackdropPointerState,
    updateTaskModalField,
    updateTaskModalMaterialRow,
    addTaskModalMaterialRow,
    removeTaskModalMaterialRow,
    selectTaskModalClassTemplate,
    addTaskModalAssignee,
    removeTaskModalAssignee,
    addFirstMatchingTaskModalAssignee,
    selectTaskModalProject,
    openTaskEditModal,
    closeTaskEditModal,
    onTaskEditModalBackdropPointerDown,
    onTaskEditModalBackdropPointerUp,
    resetTaskEditModalBackdropPointerState,
    updateTaskEditField,
    updateTaskEditMaterialRow,
    addTaskEditMaterialRow,
    removeTaskEditMaterialRow,
    selectTaskEditClassTemplate,
    addTaskEditAssignee,
    removeTaskEditAssignee,
    addFirstMatchingTaskEditAssignee,
    addOfficeTaskProjectFilter,
    removeOfficeTaskProjectFilter,
    addFirstMatchingOfficeTaskProjectFilter,
    openConstructionReportFromTask,
    openProjectFromTask,
    openProjectGanttById,
    openTaskFromProject,
    openTaskFromPlanning,
    userNameById,
    userInitialsById,
    userAvatarVersionById,
    userHasAvatar,
    isThreadArchived,
    openCreateThreadModal,
    openEditThreadModal,
    closeThreadModal,
    onThreadIconFileChange,
    addThreadModalUser,
    removeThreadModalUser,
    addFirstMatchingThreadModalUser,
    addThreadModalRole,
    removeThreadModalRole,
    addFirstMatchingThreadModalRole,
    closeArchivedThreadsModal,
    openAvatarModal,
    closeAvatarModal,
    onAvatarFileChange,
    onAvatarDragStart,
    onAvatarDragMove,
    onAvatarDragEnd,
    onMessageAttachmentChange,
    scrollMessageListToBottom,
    clearMessageAttachment,
    onMessageListScroll,
    fileDownloadUrl,
    filePreviewUrl,
    isPreviewable,
    deleteFile,
    wikiFileUrl,
    formatFileSize,
    updateReportWorker,
    addReportWorkerRow,
    removeReportWorkerRow,
    applyReportProjectSelection,
    toggleReportTaskChecklistItem,
    updateReportDraftField,
    updateReportMaterialRow,
    addReportMaterialRow,
    removeReportMaterialRow,
    updateReportOfficeMaterialRow,
    addReportOfficeMaterialRow,
    removeReportOfficeMaterialRow,
    onReportImagesChange,
    removeReportImage,
    onReportImageRemoveClick,
    clearReportImages,
    formatActionLinkNotice,
    toggleSchoolRecurrenceWeekday,
    openAdminViewFromMenu,
    openProfileViewFromMenu,
    signOut,
    selectMaterialCatalogProject,
    normalizeMaterialCatalogLookupKey,
    isLikelyMaterialCatalogIdentifier,
    mergeMaterialRowWithCatalogItem,
    findMaterialCatalogMatch,
    resetPublicAuthRoute,

    // ── Async functions ───────────────────────────────────────────────────────
    loadBaseData,
    loadProjectClassTemplates,
    loadTasks,
    loadMaterialNeeds,
    loadMaterialCatalog,
    uploadMaterialCatalogImage,
    deleteMaterialCatalogImage,
    lookupMaterialCatalogByIdentifier,
    enrichTaskModalMaterialRowFromCatalog,
    enrichTaskEditMaterialRowFromCatalog,
    enrichReportMaterialRowFromCatalog,
    enrichReportOfficeMaterialRowFromCatalog,
    addCatalogMaterialNeed,
    updateMaterialNeedState,
    updateMaterialNeedNote,
    loadProjectOverview,
    loadProjectWeather,
    loadProjectFinance,
    loadProjectTrackedMaterials,
    saveWeatherSettings,
    saveCompanySettings,
    saveSmtpSettings,
    sendSmtpTest,
    smtpTestSending,
    smtpTestLastResult,
    loadUpdateStatus,
    installSystemUpdate,
    getUpdateProgress,
    loadPlanningWeek,
    loadPlanningWindow,
    loadSitesAndTickets,
    loadFiles,
    loadProjectFolders,
    loadConstructionReportFiles,
    loadRecentConstructionReports,
    loadWikiLibraryFiles,
    loadThreads,
    loadArchivedThreads,
    loadMessages,
    refreshTimeData,
    onLogin,
    submitPublicInviteAccept,
    submitPublicPasswordReset,
    submitProjectForm,
    saveProjectInternalNote,
    saveProjectFinance,
    saveProjectHours,
    archiveActiveProject,
    deleteActiveProject,
    unarchiveProject,
    deleteProjectById,
    createTask,
    createWeeklyPlanTask,
    saveTaskEdit,
    markTaskDone,
    deleteTaskFromEdit,
    exportTaskCalendar,
    createTicket,
    uploadTicketAttachment,
    clockIn,
    clockOut,
    startBreak,
    endBreak,
    updateTimeEntry,
    submitThreadModal,
    archiveActiveThread,
    openArchivedThreadsModal,
    restoreArchivedThread,
    deleteThread,
    sendMessage,
    uploadFile,
    createProjectFolderFromInput,
    saveAvatar,
    deleteAvatar,
    applyTemplate,
    updateRole,
    updateWorkspaceLock,
    updateRequiredDailyHours,
    updateVacationBalance,
    saveProfileSettings,
    sendInviteToUser,
    sendPasswordResetToUser,
    softDeleteUser,
    restoreArchivedUser,
    submitCreateInvite,
    exportEncryptedDatabaseBackup,
    submitVacationRequest,
    reviewVacationRequest,
    submitSchoolAbsence,
    startSchoolAbsenceEdit,
    cancelSchoolAbsenceEdit,
    reviewSchoolAbsence,
    removeSchoolAbsence,
    downloadProjectCsvTemplate,
    downloadProjectClassTemplateCsv,
    importProjectsCsv,
    importProjectClassTemplateCsv,
    submitConstructionReport,
    copyToClipboard,
  };

  return (
    <AppContext.Provider value={contextValue}>
    {!user ? (
      <Suspense fallback={<div className="page-loading-spinner" aria-hidden="true" />}>
        <LoginPage />
      </Suspense>
    ) : <div className={`app-shell workspace-mode-${workspaceMode}`}>
      <Sidebar />

      <main className="content">
        <Header />

        <ProjectBanner />
        {error && (
          <div className="error" onClick={() => setError("")}>
            {error}
          </div>
        )}
        {notice && (
          <div className="notice" onClick={() => setNotice("")}>
            {notice}
          </div>
        )}
        {actionLinkDialog && (
          <div className="modal-backdrop" role="presentation" onClick={() => setActionLinkDialog(null)}>
            <section
              className="card modal-card modal-card-sm action-link-dialog"
              role="dialog"
              aria-modal="true"
              aria-labelledby="action-link-dialog-title"
              onClick={(event) => event.stopPropagation()}
            >
              <h3 id="action-link-dialog-title">
                {language === "de"
                  ? actionLinkDialog.type === "invite"
                    ? "Einladungslink"
                    : "Passwort-Reset-Link"
                  : actionLinkDialog.type === "invite"
                    ? "Invite link"
                    : "Password reset link"}
              </h3>
              <p className="muted" style={{ marginTop: "0.4rem" }}>
                {language === "de"
                  ? "Der Browser hat das automatische Kopieren blockiert. Du kannst den Link hier direkt kopieren."
                  : "The browser blocked automatic copying. You can copy the link directly here."}
              </p>
              <input
                className="action-link-input"
                type="text"
                readOnly
                value={actionLinkDialog.link}
                onFocus={(event) => event.currentTarget.select()}
                onClick={(event) => event.currentTarget.select()}
              />
              <div className="action-link-actions">
                <button
                  type="button"
                  onClick={async () => {
                    try {
                      await copyActionLink(actionLinkDialog.link);
                      setActionLinkDialog(null);
                      setNotice(language === "de" ? "Link kopiert" : "Link copied");
                    } catch {
                      setError(language === "de" ? "Link konnte nicht kopiert werden" : "Failed to copy link");
                    }
                  }}
                >
                  {language === "de" ? "Link kopieren" : "Copy link"}
                </button>
                <button type="button" className="ghost" onClick={() => setActionLinkDialog(null)}>
                  {language === "de" ? "Schliessen" : "Close"}
                </button>
              </div>
            </section>
          </div>
        )}
        <datalist id="material-unit-options">
          {MATERIAL_UNIT_EXAMPLES.map((unit) => (
            <option key={`material-unit-${unit}`} value={unit} />
          ))}
        </datalist>

        <ProjectModal />

        <TaskModal />

        <TaskEditModal />

        <FileUploadModal />

        <AvatarModal />

        <ThreadModal />

        <ArchivedThreadsModal />

        <CustomerModal />

        <PartnerModal />

        <Suspense fallback={<div className="page-loading-spinner" aria-hidden="true" />}>
          {mainView === "overview" && <OverviewPage />}
          {mainView === "materials" && <MaterialsPage />}
          {(mainView === "werkstatt" || mainView === "werkstatt_scan") && <WerkstattPage />}
          {mainView === "projects_all" && <ProjectsAllPage />}
          {mainView === "projects_archive" && <ProjectsArchivePage />}
          {mainView === "my_tasks" && <MyTasksPage />}
          {mainView === "office_tasks" && <OfficeTasksPage />}
          {mainView === "project" && !activeProject && (
            <section className="card">
              <h3>{language === "de" ? "Kein Projekt ausgewählt" : "No project selected"}</h3>
              <p>
                {language === "de"
                  ? "Waehle links ein Projekt aus."
                  : "Select a project from the left list."}
              </p>
            </section>
          )}
          {mainView === "project" && <ProjectPage />}
          {mainView === "calendar" && <CalendarPage />}
          {mainView === "planning" && <PlanningPage />}
          {mainView === "construction" && <ConstructionPage />}
          {mainView === "wiki" && <WikiPage />}
          {mainView === "messages" && <MessagesPage />}
          {mainView === "time" && <TimePage />}
          {mainView === "profile" && <ProfilePage />}
          {mainView === "admin" && <AdminPage />}
          {mainView === "projects_map" && <MapPage />}
          {mainView === "customers" && <CustomersPage />}
          {mainView === "customer_detail" && <CustomerDetailPage />}
        </Suspense>
      </main>

      <MobileBottomNav />
    </div>}
    </AppContext.Provider>
  );
}
