import { createContext, FormEvent, ChangeEvent, MouseEvent, PointerEvent, RefObject, useContext } from "react";
import type { SseStatus } from "../hooks/useServerEvents";
import type { AppNotification } from "../components/NotificationPanel";
import type {
  Language,
  TaskView,
  TaskType,
  User,
  Project,
  ProjectClassTaskTemplate,
  ProjectClassTemplate,
  ProjectFinance,
  ProjectActivity,
  ProjectOfficeNote,
  ProjectOverviewDetails,
  ProjectWeatherDay,
  ProjectWeather,
  MaterialNeedStatus,
  ProjectMaterialNeed,
  MaterialCatalogItem,
  MaterialCatalogImportState,
  ProjectTrackedMaterial,
  Task,
  AssignableUser,
  WikiLibraryFile,
  Ticket,
  Thread,
  MessageAttachment,
  Message,
  ChatRenderRow,
  TimeCurrent,
  TimeEntry,
  TimesheetSummary,
  MonthWeekRange,
  MonthWeekHours,
  PlanningDay,
  PlanningWeek,
  PlanningAbsence,
  ProjectFolder,
  ProjectFile,
  VacationRequest,
  SchoolAbsence,
  InviteDispatchResponse,
  PasswordResetDispatchResponse,
  NicknameAvailability,
  WeatherSettings,
  UpdateStatus,
  UpdateInstallResponse,
  ReportWorker,
  ReportDraft,
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
  ProjectTitleParts,
  ThreadModalState,
  AvatarUploadResponse,
  AvatarDeleteResponse,
  AvatarImageSize,
  AvatarCropOutput,
} from "../types";

export interface AppContextValue {
  // ── Core auth / session ────────────────────────────────────────────────────
  token: string | null;
  setToken: (token: string | null) => void;
  language: Language;
  setLanguage: (language: Language) => void;
  workspaceMode: WorkspaceMode;
  setWorkspaceMode: (mode: WorkspaceMode) => void;
  now: Date;

  // ── Current user ───────────────────────────────────────────────────────────
  user: User | null;
  setUser: (user: User | null) => void;

  // ── Navigation ─────────────────────────────────────────────────────────────
  mainView: MainView;
  setMainView: (view: MainView) => void;
  sidebarOpen: boolean;
  setSidebarOpen: (open: boolean | ((current: boolean) => boolean)) => void;
  overviewShortcutBackVisible: boolean;
  setOverviewShortcutBackVisible: (visible: boolean) => void;
  projectTab: ProjectTab;
  setProjectTab: (tab: ProjectTab) => void;
  projectBackView: MainView | null;
  setProjectBackView: (view: MainView | null) => void;
  constructionBackView: MainView | null;
  setConstructionBackView: (view: MainView | null) => void;

  // ── Error / notice ─────────────────────────────────────────────────────────
  error: string;
  setError: (error: string) => void;
  notice: string;
  setNotice: (notice: string) => void;

  // ── Login form ─────────────────────────────────────────────────────────────
  email: string;
  setEmail: (email: string) => void;
  password: string;
  setPassword: (password: string) => void;
  publicAuthMode: "invite" | "reset" | null;
  setPublicAuthMode: (mode: "invite" | "reset" | null) => void;
  publicToken: string;
  setPublicToken: (token: string) => void;
  publicFullName: string;
  setPublicFullName: (name: string) => void;
  publicEmail: string;
  setPublicEmail: (email: string) => void;
  publicNewPassword: string;
  setPublicNewPassword: (pw: string) => void;
  publicConfirmPassword: string;
  setPublicConfirmPassword: (pw: string) => void;

  // ── Users ──────────────────────────────────────────────────────────────────
  users: User[];
  setUsers: (users: User[]) => void;
  assignableUsers: AssignableUser[];
  setAssignableUsers: (users: AssignableUser[]) => void;
  threadParticipantRoles: string[];
  setThreadParticipantRoles: (roles: string[]) => void;

  // ── Projects ───────────────────────────────────────────────────────────────
  projects: Project[];
  setProjects: (projects: Project[] | ((current: Project[]) => Project[])) => void;
  activeProjectId: number | null;
  setActiveProjectId: (id: number | null) => void;
  highlightedArchivedProjectId: number | null;
  setHighlightedArchivedProjectId: (id: number | null) => void;
  overview: any[];
  setOverview: (overview: any[]) => void;
  overviewStatusFilter: string;
  setOverviewStatusFilter: (filter: string) => void;
  projectsAllSearch: string;
  setProjectsAllSearch: (search: string) => void;
  projectsAllStateFilter: string;
  setProjectsAllStateFilter: (filter: string) => void;
  projectsAllEditedFilter: string;
  setProjectsAllEditedFilter: (filter: string) => void;
  projectSidebarSearchOpen: boolean;
  setProjectSidebarSearchOpen: (open: boolean | ((current: boolean) => boolean)) => void;
  projectSidebarSearchQuery: string;
  setProjectSidebarSearchQuery: (query: string) => void;

  // ── Project class templates ────────────────────────────────────────────────
  projectClassTemplates: ProjectClassTemplate[];
  setProjectClassTemplates: (templates: ProjectClassTemplate[]) => void;
  projectClassTemplatesByProjectId: Record<number, ProjectClassTemplate[]>;
  setProjectClassTemplatesByProjectId: (
    value:
      | Record<number, ProjectClassTemplate[]>
      | ((current: Record<number, ProjectClassTemplate[]>) => Record<number, ProjectClassTemplate[]>),
  ) => void;

  // ── Project overview details ────────────────────────────────────────────────
  projectOverviewDetails: ProjectOverviewDetails | null;
  setProjectOverviewDetails: (details: ProjectOverviewDetails | null) => void;
  projectOverviewOpenTasks: Task[];
  setProjectOverviewOpenTasks: (tasks: Task[]) => void;

  // ── Project weather ─────────────────────────────────────────────────────────
  projectWeather: ProjectWeather | null;
  setProjectWeather: (weather: ProjectWeather | null) => void;
  projectWeatherLoading: boolean;
  setProjectWeatherLoading: (loading: boolean) => void;

  // ── Project finance ─────────────────────────────────────────────────────────
  projectFinance: ProjectFinance | null;
  setProjectFinance: (finance: ProjectFinance | null) => void;
  projectHoursPlannedInput: string;
  setProjectHoursPlannedInput: (value: string) => void;
  projectFinanceEditing: boolean;
  setProjectFinanceEditing: (editing: boolean) => void;
  projectFinanceForm: ProjectFinanceFormState;
  setProjectFinanceForm: (form: ProjectFinanceFormState | ((current: ProjectFinanceFormState) => ProjectFinanceFormState)) => void;

  // ── Project note ────────────────────────────────────────────────────────────
  projectNoteEditing: boolean;
  setProjectNoteEditing: (editing: boolean) => void;
  projectNoteDraft: string;
  setProjectNoteDraft: (draft: string) => void;

  // ── Project modal ───────────────────────────────────────────────────────────
  projectModalMode: "create" | "edit" | null;
  setProjectModalMode: (mode: "create" | "edit" | null) => void;
  projectForm: ProjectFormState;
  setProjectForm: (form: ProjectFormState | ((current: ProjectFormState) => ProjectFormState)) => void;
  projectFormBase: ProjectFormState | null;
  setProjectFormBase: (form: ProjectFormState | null | ((current: ProjectFormState | null) => ProjectFormState | null)) => void;
  projectEditExpectedLastUpdatedAt: string | null;
  setProjectEditExpectedLastUpdatedAt: (at: string | null) => void;

  // ── Materials ───────────────────────────────────────────────────────────────
  materialNeeds: ProjectMaterialNeed[];
  setMaterialNeeds: (needs: ProjectMaterialNeed[] | ((current: ProjectMaterialNeed[]) => ProjectMaterialNeed[])) => void;
  materialNeedUpdating: Record<number, boolean>;
  setMaterialNeedUpdating: (value: Record<number, boolean> | ((current: Record<number, boolean>) => Record<number, boolean>)) => void;
  materialCatalogRows: MaterialCatalogItem[];
  setMaterialCatalogRows: (rows: MaterialCatalogItem[]) => void;
  materialCatalogState: MaterialCatalogImportState | null;
  setMaterialCatalogState: (state: MaterialCatalogImportState | null) => void;
  materialCatalogQuery: string;
  setMaterialCatalogQuery: (query: string) => void;
  materialCatalogLoading: boolean;
  setMaterialCatalogLoading: (loading: boolean) => void;
  materialCatalogProjectId: string;
  setMaterialCatalogProjectId: (id: string) => void;
  materialCatalogProjectSearch: string;
  setMaterialCatalogProjectSearch: (search: string) => void;
  materialCatalogProjectSearchFocused: boolean;
  setMaterialCatalogProjectSearchFocused: (focused: boolean) => void;
  materialCatalogAdding: Record<number, boolean>;
  setMaterialCatalogAdding: (value: Record<number, boolean> | ((current: Record<number, boolean>) => Record<number, boolean>)) => void;
  projectTrackedMaterials: ProjectTrackedMaterial[];
  setProjectTrackedMaterials: (materials: ProjectTrackedMaterial[]) => void;

  // ── Tasks ───────────────────────────────────────────────────────────────────
  taskView: TaskView;
  setTaskView: (view: TaskView) => void;
  tasks: Task[];
  setTasks: (tasks: Task[]) => void;
  officeTaskStatusFilter: string;
  setOfficeTaskStatusFilter: (filter: string) => void;
  officeTaskAssigneeFilter: string;
  setOfficeTaskAssigneeFilter: (filter: string) => void;
  officeTaskDueDateFilter: string;
  setOfficeTaskDueDateFilter: (filter: string) => void;
  officeTaskNoDueDateFilter: boolean;
  setOfficeTaskNoDueDateFilter: (value: boolean) => void;
  officeTaskProjectFilterQuery: string;
  setOfficeTaskProjectFilterQuery: (query: string) => void;
  officeTaskProjectFilterIds: number[];
  setOfficeTaskProjectFilterIds: (ids: number[] | ((current: number[]) => number[])) => void;
  expandedMyTaskId: number | null;
  setExpandedMyTaskId: (id: number | null) => void;
  myTasksBackProjectId: number | null;
  setMyTasksBackProjectId: (id: number | null) => void;
  hasTaskNotifications: boolean;
  notifications: AppNotification[];
  notifPanelOpen: boolean;
  setNotifPanelOpen: (open: boolean | ((current: boolean) => boolean)) => void;
  markAllNotificationsRead: () => Promise<void>;

  // ── Project task form ────────────────────────────────────────────────────────
  projectTaskForm: ProjectTaskFormState;
  setProjectTaskForm: (
    form: ProjectTaskFormState | ((current: ProjectTaskFormState) => ProjectTaskFormState),
  ) => void;
  projectTaskMaterialRows: ReportMaterialRow[];
  setProjectTaskMaterialRows: (rows: ReportMaterialRow[] | ((current: ReportMaterialRow[]) => ReportMaterialRow[])) => void;

  // ── Task modal (weekly plan) ─────────────────────────────────────────────────
  taskModalOpen: boolean;
  setTaskModalOpen: (open: boolean) => void;
  taskModalForm: TaskModalState;
  setTaskModalForm: (form: TaskModalState | ((current: TaskModalState) => TaskModalState)) => void;
  taskModalMaterialRows: ReportMaterialRow[];
  setTaskModalMaterialRows: (rows: ReportMaterialRow[] | ((current: ReportMaterialRow[]) => ReportMaterialRow[])) => void;

  // ── Task edit modal ──────────────────────────────────────────────────────────
  taskEditModalOpen: boolean;
  setTaskEditModalOpen: (open: boolean) => void;
  taskEditForm: TaskEditFormState;
  setTaskEditForm: (form: TaskEditFormState | ((current: TaskEditFormState) => TaskEditFormState)) => void;
  taskEditMaterialRows: ReportMaterialRow[];
  setTaskEditMaterialRows: (rows: ReportMaterialRow[] | ((current: ReportMaterialRow[]) => ReportMaterialRow[])) => void;
  taskEditFormBase: TaskEditFormState | null;
  setTaskEditFormBase: (form: TaskEditFormState | null) => void;
  taskEditExpectedUpdatedAt: string | null;
  setTaskEditExpectedUpdatedAt: (at: string | null) => void;

  // ── Tickets ──────────────────────────────────────────────────────────────────
  tickets: Ticket[];
  setTickets: (tickets: Ticket[]) => void;

  // ── Files ────────────────────────────────────────────────────────────────────
  files: ProjectFile[];
  setFiles: (files: ProjectFile[]) => void;
  projectFolders: ProjectFolder[];
  setProjectFolders: (folders: ProjectFolder[]) => void;
  fileQuery: string;
  setFileQuery: (query: string) => void;
  fileUploadModalOpen: boolean;
  setFileUploadModalOpen: (open: boolean) => void;
  fileUploadFolder: string;
  setFileUploadFolder: (folder: string) => void;
  newProjectFolderPath: string;
  setNewProjectFolderPath: (path: string) => void;

  // ── Construction reports ──────────────────────────────────────────────────────
  recentConstructionReports: RecentConstructionReport[];
  setRecentConstructionReports: (reports: RecentConstructionReport[]) => void;
  reportProjectId: string;
  setReportProjectId: (id: string | ((current: string) => string)) => void;
  reportDraft: ReportDraft;
  setReportDraft: (draft: ReportDraft | ((current: ReportDraft) => ReportDraft)) => void;
  reportTaskPrefill: TaskReportPrefill | null;
  setReportTaskPrefill: (prefill: TaskReportPrefill | null) => void;
  reportSourceTaskId: number | null;
  setReportSourceTaskId: (id: number | null) => void;
  reportTaskChecklist: ReportTaskChecklistItem[];
  setReportTaskChecklist: (checklist: ReportTaskChecklistItem[] | ((current: ReportTaskChecklistItem[]) => ReportTaskChecklistItem[])) => void;
  reportMaterialRows: ReportMaterialRow[];
  setReportMaterialRows: (rows: ReportMaterialRow[] | ((current: ReportMaterialRow[]) => ReportMaterialRow[])) => void;
  reportOfficeMaterialRows: ReportMaterialRow[];
  setReportOfficeMaterialRows: (rows: ReportMaterialRow[] | ((current: ReportMaterialRow[]) => ReportMaterialRow[])) => void;
  reportImageFiles: ReportImageSelection[];
  setReportImageFiles: (files: ReportImageSelection[] | ((current: ReportImageSelection[]) => ReportImageSelection[])) => void;
  reportSubmitting: boolean;
  setReportSubmitting: (submitting: boolean) => void;
  reportUploadPercent: number | null;
  setReportUploadPercent: (percent: number | null | ((current: number | null) => number | null)) => void;
  reportUploadPhase: "uploading" | "processing" | null;
  setReportUploadPhase: (phase: "uploading" | "processing" | null) => void;
  reportWorkers: ReportWorker[];
  setReportWorkers: (workers: ReportWorker[] | ((current: ReportWorker[]) => ReportWorker[])) => void;

  // ── Wiki ───────────────────────────────────────────────────────────────────
  wikiFiles: WikiLibraryFile[];
  setWikiFiles: (files: WikiLibraryFile[]) => void;
  wikiSearch: string;
  setWikiSearch: (search: string) => void;
  activeWikiPath: string | null;
  setActiveWikiPath: (path: string | null) => void;

  // ── Planning ───────────────────────────────────────────────────────────────
  planningWeekStart: string;
  setPlanningWeekStart: (start: string) => void;
  planningTaskTypeView: TaskType;
  setPlanningTaskTypeView: (type: TaskType) => void;
  planningWeek: PlanningWeek | null;
  setPlanningWeek: (week: PlanningWeek | null) => void;
  calendarWeekStart: string;
  setCalendarWeekStart: (start: string) => void;
  calendarWeeks: PlanningWeek[];
  setCalendarWeeks: (weeks: PlanningWeek[]) => void;
  calendarLoading: boolean;
  setCalendarLoading: (loading: boolean) => void;

  // ── Threads / messages ─────────────────────────────────────────────────────
  threads: Thread[];
  setThreads: (threads: Thread[]) => void;
  archivedThreads: Thread[];
  setArchivedThreads: (threads: Thread[]) => void;
  archivedThreadsModalOpen: boolean;
  setArchivedThreadsModalOpen: (open: boolean) => void;
  messages: Message[];
  setMessages: (messages: Message[]) => void;
  messageBody: string;
  setMessageBody: (body: string) => void;
  messageAttachment: File | null;
  setMessageAttachment: (file: File | null) => void;
  activeThreadId: number | null;
  setActiveThreadId: (id: number | null) => void;
  threadModalMode: "create" | "edit" | null;
  setThreadModalMode: (mode: "create" | "edit" | null) => void;
  threadModalForm: ThreadModalState;
  setThreadModalForm: (form: ThreadModalState | ((current: ThreadModalState) => ThreadModalState)) => void;
  threadIconFile: File | null;
  setThreadIconFile: (file: File | null) => void;
  threadIconPreviewUrl: string;
  setThreadIconPreviewUrl: (url: string) => void;
  threadActionMenuOpen: boolean;
  setThreadActionMenuOpen: (open: boolean) => void;

  // ── Time ───────────────────────────────────────────────────────────────────
  timeCurrent: TimeCurrent | null;
  setTimeCurrent: (current: TimeCurrent | null) => void;
  timeEntries: TimeEntry[];
  setTimeEntries: (entries: TimeEntry[]) => void;
  timeMonthRows: MonthWeekHours[];
  setTimeMonthRows: (rows: MonthWeekHours[]) => void;
  vacationRequests: VacationRequest[];
  setVacationRequests: (requests: VacationRequest[]) => void;
  schoolAbsences: SchoolAbsence[];
  setSchoolAbsences: (absences: SchoolAbsence[]) => void;
  vacationRequestForm: { start_date: string; end_date: string; note: string };
  setVacationRequestForm: (form: { start_date: string; end_date: string; note: string }) => void;
  schoolAbsenceForm: {
    user_id: string;
    title: string;
    start_date: string;
    end_date: string;
    recurrence_weekdays: number[];
    recurrence_until: string;
  };
  setSchoolAbsenceForm: (
    form:
      | { user_id: string; title: string; start_date: string; end_date: string; recurrence_weekdays: number[]; recurrence_until: string }
      | ((current: { user_id: string; title: string; start_date: string; end_date: string; recurrence_weekdays: number[]; recurrence_until: string }) => { user_id: string; title: string; start_date: string; end_date: string; recurrence_weekdays: number[]; recurrence_until: string }),
  ) => void;
  timeMonthCursor: Date;
  setTimeMonthCursor: (cursor: Date) => void;
  timeInfoOpen: boolean;
  setTimeInfoOpen: (open: boolean) => void;
  timeTargetUserId: string;
  setTimeTargetUserId: (id: string) => void;
  requiredHoursDrafts: Record<number, string>;
  setRequiredHoursDrafts: (drafts: Record<number, string> | ((current: Record<number, string>) => Record<number, string>)) => void;

  // ── Profile settings ────────────────────────────────────────────────────────
  profileSettingsForm: { full_name: string; email: string; nickname: string; current_password: string; new_password: string };
  setProfileSettingsForm: (form: { full_name: string; email: string; nickname: string; current_password: string; new_password: string }) => void;
  nicknameCheckState: "idle" | "checking" | "available" | "unavailable";
  setNicknameCheckState: (state: "idle" | "checking" | "available" | "unavailable") => void;
  nicknameCheckMessage: string;
  setNicknameCheckMessage: (message: string) => void;

  // ── Admin / invite ──────────────────────────────────────────────────────────
  inviteCreateForm: { email: string; full_name: string; role: User["role"] };
  setInviteCreateForm: (form: { email: string; full_name: string; role: User["role"] }) => void;
  backupExporting: boolean;
  setBackupExporting: (exporting: boolean) => void;
  weatherSettings: WeatherSettings | null;
  setWeatherSettings: (settings: WeatherSettings | null) => void;
  weatherApiKeyInput: string;
  setWeatherApiKeyInput: (key: string) => void;
  weatherSettingsSaving: boolean;
  setWeatherSettingsSaving: (saving: boolean) => void;
  updateStatus: UpdateStatus | null;
  setUpdateStatus: (status: UpdateStatus | null) => void;
  updateStatusLoading: boolean;
  setUpdateStatusLoading: (loading: boolean) => void;
  updateInstallRunning: boolean;
  setUpdateInstallRunning: (running: boolean) => void;
  preUserMenuOpen: boolean;
  setPreUserMenuOpen: (open: boolean) => void;
  adminUserMenuOpenId: number | null;
  setAdminUserMenuOpenId: (id: number | null) => void;

  // ── Avatar ──────────────────────────────────────────────────────────────────
  avatarModalOpen: boolean;
  setAvatarModalOpen: (open: boolean) => void;
  avatarSourceUrl: string;
  setAvatarSourceUrl: (url: string) => void;
  avatarZoom: number;
  setAvatarZoom: (zoom: number) => void;
  avatarOffsetX: number;
  setAvatarOffsetX: (offset: number) => void;
  avatarOffsetY: number;
  setAvatarOffsetY: (offset: number) => void;
  avatarNaturalSize: AvatarImageSize | null;
  setAvatarNaturalSize: (size: AvatarImageSize | null) => void;
  avatarStageSize: number;
  setAvatarStageSize: (size: number) => void;
  avatarIsDragging: boolean;
  setAvatarIsDragging: (dragging: boolean) => void;
  avatarPreviewDataUrl: string;
  setAvatarPreviewDataUrl: (url: string) => void;
  avatarSelectedFile: File | null;
  setAvatarSelectedFile: (file: File | null) => void;
  avatarVersionKey: string;
  setAvatarVersionKey: (key: string) => void;

  // ── Refs exposed to children ────────────────────────────────────────────────
  constructionFormRef: RefObject<HTMLFormElement | null>;
  avatarCropStageRef: RefObject<HTMLDivElement | null>;
  messageListRef: RefObject<HTMLUListElement | null>;
  reportImageInputRef: RefObject<HTMLInputElement | null>;
  messageAttachmentInputRef: RefObject<HTMLInputElement | null>;
  avatarDragRef: RefObject<{
    pointerId: number;
    startX: number;
    startY: number;
    startOffsetX: number;
    startOffsetY: number;
  } | null>;
  preUserMenuRef: RefObject<HTMLDivElement | null>;

  // ── Derived booleans ─────────────────────────────────────────────────────────
  isAdmin: boolean;
  canAdjustRequiredHours: boolean;
  canCreateProject: boolean;
  canManageTasks: boolean;
  isTimeManager: boolean;
  canApproveVacation: boolean;
  canManageSchoolAbsences: boolean;
  canManageProjectImport: boolean;
  canUseProtectedFolders: boolean;
  canManageFinance: boolean;
  hasMessageText: boolean;
  canSendMessage: boolean;
  viewingOwnTime: boolean;
  threadModalIsRestricted: boolean;

  // ── Derived labels ────────────────────────────────────────────────────────────
  mainLabels: Record<string, string>;
  tabLabels: Record<string, string>;
  workspaceModeLabel: string;

  // ── Derived numeric values ───────────────────────────────────────────────────
  requiredDailyHours: number;
  dailyNetHours: number;
  gaugeNetHours: number;

  // ── useMemo values ────────────────────────────────────────────────────────────
  activeProject: Project | null;
  activeProjectDavRef: string;
  activeProjectDavUrl: string;
  activeProjectHeader: ProjectTitleParts;
  activeProjectLastState: string;
  activeProjectLastStatusAtLabel: string;
  activeProjectLastUpdatedLabel: string;
  activeProjectAddress: string;
  activeProjectMapQuery: string;
  activeProjectMapEmbedUrl: string;
  activeProjectMapOpenUrl: string;
  activeProjectTicketDate: string;
  activeProjectTicketAddress: string;
  activeProjectClassTemplates: ProjectClassTemplate[];
  taskModalProjectClassTemplates: ProjectClassTemplate[];
  taskEditProjectClassTemplates: ProjectClassTemplate[];
  projectStatusOptions: string[];
  projectStatusSelectOptions: string[];
  overviewStatusOptions: string[];
  projectsById: Map<number, Project>;
  overviewProjectsById: Map<
    number,
    { id: number; project_number: string; name: string; status: string; customer_name: string | null }
  >;
  materialNeedRows: ProjectMaterialNeed[];
  activeProjects: Project[];
  archivedProjects: Project[];
  materialCatalogProjectOptions: Project[];
  selectedMaterialCatalogProject: Project | null;
  selectedMaterialCatalogProjectLabel: string;
  materialCatalogProjectSuggestions: Project[];
  filteredSidebarProjects: Array<{ project: Project; isArchived: boolean }>;
  detailedOverviewRows: any[];
  filteredDetailedOverview: any[];
  filteredProjectsAll: any[];
  recentAssignedProjects: Project[];
  sortedTasks: Task[];
  overviewActionCards: ReadonlyArray<{ view: string; label: string }>;
  overviewActionCardWidth: string;
  projectTaskAssigneeSuggestions: AssignableUser[];
  taskModalAssigneeSuggestions: AssignableUser[];
  taskEditAssigneeSuggestions: AssignableUser[];
  threadModalUserSuggestions: AssignableUser[];
  threadModalRoleSuggestions: string[];
  taskModalProjectSuggestions: Project[];
  selectedTaskModalProject: Project | null;
  activeThread: Thread | null;
  hasUnreadThreads: boolean;
  sseStatus: SseStatus;
  assignableUsersById: Map<number, AssignableUser>;
  adminUsersById: Map<number, User>;
  compactMenuUserNamesById: Map<number, string>;
  threadModalSelectedUsers: Array<{ id: number; label: string; archived: boolean }>;
  activeAdminUsers: User[];
  archivedAdminUsers: User[];
  chatRenderRows: ChatRenderRow[];
  showOverviewBackButton: boolean;
  selectedReportProject: Project | null;
  planningWeekInfo: ReturnType<typeof import("../utils/dates").isoWeekInfo>;
  taskStatusOptions: string[];
  officeTaskStatusOptions: string[];
  officeTaskAssigneeOptions: Array<{ id: number; label: string }>;
  officeTaskProjectOptions: Array<{ id: number; label: string }>;
  officeTaskSelectedProjectFilters: Array<{ id: number; label: string }>;
  officeTaskProjectSuggestions: Array<{ id: number; label: string }>;
  officeFilteredTasks: Task[];
  navViews: MainView[];
  projectTabs: ProjectTab[];
  fileRows: ProjectFile[];
  wikiRows: any[];
  activeWikiFile: WikiLibraryFile | null;
  projectReportedHoursTotal: number;
  projectPlannedHoursTotal: number;
  projectHoursUsagePercent: number;
  userInitials: string;
  todayIso: string;
  calendarRangeLabel: string;
  timeTargetUser: AssignableUser | null;
  monthWeekDefs: MonthWeekRange[];
  monthCursorLabel: string;
  monthlyWorkedHours: number;
  monthlyRequiredHours: number;
  pendingVacationRequests: VacationRequest[];
  approvedVacationRequests: VacationRequest[];
  approvedVacationRequestsByUserId: Map<number, VacationRequest[]>;
  schoolAbsencesByUserId: Map<number, SchoolAbsence[]>;
  sidebarNowLabel: string;
  avatarStageState: ReturnType<typeof import("../utils/misc").avatarStageMetrics>;
  firmwareBuild: string;
  resolvedCurrentReleaseVersion: string | null;
  currentReleaseLabel: string;

  // ── Sync helper functions ─────────────────────────────────────────────────────
  assigneeAvailabilityHint: (userId: number, referenceIsoDate?: string | null) => string;
  getTaskAssigneeIds: (task: Task) => number[];
  isTaskAssignedToCurrentUser: (task: Task) => boolean;
  menuUserNameById: (userId: number, fallbackName?: string | null) => string;
  getTaskAssigneeLabel: (task: Task) => string;
  projectTitleParts: (project: Project | null | undefined) => ProjectTitleParts;
  projectTitle: (project: Project | null | undefined) => string;
  taskProjectTitleParts: (task: Task) => ProjectTitleParts;
  recentReportProjectTitleParts: (report: RecentConstructionReport) => ProjectTitleParts;
  threadProjectTitleParts: (thread: Thread) => ProjectTitleParts;
  ensureProjectVisibleById: (projectId: number) => void;
  openProjectById: (projectId: number, backView?: MainView | null) => void;
  projectSearchLabel: (project: Project) => string;
  openCreateProjectModal: () => void;
  openEditProjectModal: (project: Project) => void;
  closeProjectModal: () => void;
  onProjectModalBackdropPointerDown: (event: PointerEvent<HTMLDivElement>) => void;
  onProjectModalBackdropPointerUp: (event: PointerEvent<HTMLDivElement>) => void;
  resetProjectModalBackdropPointerState: () => void;
  updateProjectFormField: <K extends keyof ProjectFormState>(field: K, value: ProjectFormState[K]) => void;
  updateProjectSiteAccessType: (value: string) => void;
  toggleProjectClassTemplate: (templateId: number, checked: boolean) => void;
  updateProjectFinanceFormField: (field: keyof ProjectFinanceFormState, value: string) => void;
  financeFormPayload: (options?: { changedOnly?: boolean }) => Record<string, number | null>;
  validateTimeInputOrSetError: (value: string, required: boolean) => string | null;
  updateProjectTaskFormField: <K extends keyof ProjectTaskFormState>(field: K, value: ProjectTaskFormState[K]) => void;
  updateProjectTaskMaterialRow: (index: number, field: keyof Omit<ReportMaterialRow, "id">, value: string) => void;
  addProjectTaskMaterialRow: () => void;
  removeProjectTaskMaterialRow: (index: number) => void;
  selectProjectTaskClassTemplate: (classTemplateId: string) => void;
  addProjectTaskAssignee: (assigneeId: number) => void;
  removeProjectTaskAssignee: (assigneeId: number) => void;
  addFirstMatchingProjectTaskAssignee: () => void;
  openTaskModal: (defaults?: { projectId?: number | null; dueDate?: string; taskType?: TaskType }) => void;
  closeTaskModal: () => void;
  onTaskModalBackdropPointerDown: (event: PointerEvent<HTMLDivElement>) => void;
  onTaskModalBackdropPointerUp: (event: PointerEvent<HTMLDivElement>) => void;
  resetTaskModalBackdropPointerState: () => void;
  updateTaskModalField: <K extends keyof TaskModalState>(field: K, value: TaskModalState[K]) => void;
  updateTaskModalMaterialRow: (index: number, field: keyof Omit<ReportMaterialRow, "id">, value: string) => void;
  addTaskModalMaterialRow: () => void;
  removeTaskModalMaterialRow: (index: number) => void;
  selectTaskModalClassTemplate: (classTemplateId: string) => void;
  addTaskModalAssignee: (assigneeId: number) => void;
  removeTaskModalAssignee: (assigneeId: number) => void;
  addFirstMatchingTaskModalAssignee: () => void;
  selectTaskModalProject: (project: Project) => void;
  openTaskEditModal: (task: Task) => void;
  closeTaskEditModal: () => void;
  onTaskEditModalBackdropPointerDown: (event: PointerEvent<HTMLDivElement>) => void;
  onTaskEditModalBackdropPointerUp: (event: PointerEvent<HTMLDivElement>) => void;
  resetTaskEditModalBackdropPointerState: () => void;
  updateTaskEditField: <K extends keyof TaskEditFormState>(field: K, value: TaskEditFormState[K]) => void;
  updateTaskEditMaterialRow: (index: number, field: keyof Omit<ReportMaterialRow, "id">, value: string) => void;
  addTaskEditMaterialRow: () => void;
  removeTaskEditMaterialRow: (index: number) => void;
  selectTaskEditClassTemplate: (classTemplateId: string) => void;
  addTaskEditAssignee: (assigneeId: number) => void;
  removeTaskEditAssignee: (assigneeId: number) => void;
  addFirstMatchingTaskEditAssignee: () => void;
  addOfficeTaskProjectFilter: (projectId: number) => void;
  removeOfficeTaskProjectFilter: (projectId: number) => void;
  addFirstMatchingOfficeTaskProjectFilter: () => void;
  openConstructionReportFromTask: (task: Task, sourceView?: MainView | null) => void;
  openProjectFromTask: (task: Task, backView?: MainView | null) => void;
  openTaskFromProject: (task: Task) => void;
  openTaskFromPlanning: (task: Task) => void;
  userNameById: (userId: number) => string;
  userInitialsById: (userId: number) => string;
  userAvatarVersionById: (userId: number) => string;
  userHasAvatar: (userId: number) => boolean;
  isThreadArchived: (thread: Thread | null | undefined) => boolean;
  openCreateThreadModal: () => void;
  openEditThreadModal: (thread: Thread) => void;
  closeThreadModal: () => void;
  onThreadIconFileChange: (event: ChangeEvent<HTMLInputElement>) => void;
  addThreadModalUser: (userId: number) => void;
  removeThreadModalUser: (userId: number) => void;
  addFirstMatchingThreadModalUser: () => void;
  addThreadModalRole: (role: string) => void;
  removeThreadModalRole: (role: string) => void;
  addFirstMatchingThreadModalRole: () => void;
  closeArchivedThreadsModal: () => void;
  openAvatarModal: () => void;
  closeAvatarModal: () => void;
  onAvatarFileChange: (event: ChangeEvent<HTMLInputElement>) => void;
  onAvatarDragStart: (event: PointerEvent<HTMLDivElement>) => void;
  onAvatarDragMove: (event: PointerEvent<HTMLDivElement>) => void;
  onAvatarDragEnd: (event: PointerEvent<HTMLDivElement>) => void;
  onMessageAttachmentChange: (event: ChangeEvent<HTMLInputElement>) => void;
  scrollMessageListToBottom: () => void;
  clearMessageAttachment: () => void;
  onMessageListScroll: () => void;
  fileDownloadUrl: (fileId: number) => string;
  filePreviewUrl: (fileId: number) => string;
  isPreviewable: (file: any) => boolean;
  wikiFileUrl: (path: string, download?: boolean) => string;
  formatFileSize: (sizeBytes: number) => string;
  updateReportWorker: (index: number, field: keyof ReportWorker, value: string) => void;
  addReportWorkerRow: () => void;
  removeReportWorkerRow: (index: number) => void;
  applyReportProjectSelection: (nextProjectId: string) => void;
  toggleReportTaskChecklistItem: (itemId: string, checked: boolean) => void;
  updateReportDraftField: (field: keyof ReportDraft, value: string) => void;
  updateReportMaterialRow: (index: number, field: keyof Omit<ReportMaterialRow, "id">, value: string) => void;
  addReportMaterialRow: () => void;
  removeReportMaterialRow: (index: number) => void;
  updateReportOfficeMaterialRow: (index: number, field: keyof Omit<ReportMaterialRow, "id">, value: string) => void;
  addReportOfficeMaterialRow: () => void;
  removeReportOfficeMaterialRow: (index: number) => void;
  onReportImagesChange: (event: ChangeEvent<HTMLInputElement>) => void;
  removeReportImage: (fileKey: string) => void;
  onReportImageRemoveClick: (event: MouseEvent<HTMLButtonElement>, fileKey: string) => void;
  clearReportImages: () => void;
  formatActionLinkNotice: (result: InviteDispatchResponse | PasswordResetDispatchResponse, type: "invite" | "reset") => string;
  toggleSchoolRecurrenceWeekday: (day: number, checked: boolean) => void;
  openProfileViewFromMenu: () => void;
  signOut: () => void;
  selectMaterialCatalogProject: (project: Project) => void;
  normalizeMaterialCatalogLookupKey: (value: string) => string;
  isLikelyMaterialCatalogIdentifier: (value: string) => boolean;
  mergeMaterialRowWithCatalogItem: (row: ReportMaterialRow, catalogItem: MaterialCatalogItem) => ReportMaterialRow;
  findMaterialCatalogMatch: (rows: MaterialCatalogItem[], lookupKey: string) => MaterialCatalogItem | null;
  resetPublicAuthRoute: () => void;

  // ── Async functions ───────────────────────────────────────────────────────────
  loadBaseData: () => Promise<void>;
  loadProjectClassTemplates: (projectId: number) => Promise<ProjectClassTemplate[]>;
  loadTasks: (mode: TaskView, projectId: number | null) => Promise<void>;
  loadMaterialNeeds: () => Promise<void>;
  loadMaterialCatalog: (query: string) => Promise<void>;
  lookupMaterialCatalogByIdentifier: (rawValue: string) => Promise<MaterialCatalogItem | null>;
  enrichTaskModalMaterialRowFromCatalog: (index: number, lookupField: "item" | "article_no") => Promise<void>;
  enrichTaskEditMaterialRowFromCatalog: (index: number, lookupField: "item" | "article_no") => Promise<void>;
  enrichReportMaterialRowFromCatalog: (index: number, lookupField: "item" | "article_no") => Promise<void>;
  enrichReportOfficeMaterialRowFromCatalog: (index: number, lookupField: "item" | "article_no") => Promise<void>;
  addCatalogMaterialNeed: (materialCatalogItem: MaterialCatalogItem) => Promise<void>;
  updateMaterialNeedState: (materialNeedId: number, nextStatus: MaterialNeedStatus) => Promise<void>;
  loadProjectOverview: (projectId: number) => Promise<void>;
  loadProjectWeather: (projectId: number, refresh: boolean) => Promise<void>;
  loadProjectFinance: (projectId: number) => Promise<void>;
  loadProjectTrackedMaterials: (projectId: number) => Promise<void>;
  saveWeatherSettings: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  loadUpdateStatus: (showNotice?: boolean) => Promise<void>;
  installSystemUpdate: (dryRun: boolean) => Promise<void>;
  loadPlanningWeek: (projectId: number | null, weekStart: string, taskType?: TaskType | null) => Promise<void>;
  loadPlanningWindow: (projectId: number | null, weekStart: string, weekCount: number) => Promise<void>;
  loadSitesAndTickets: (projectId: number) => Promise<void>;
  loadFiles: (projectId: number) => Promise<void>;
  loadProjectFolders: (projectId: number) => Promise<void>;
  loadConstructionReportFiles: (projectId: number | null) => Promise<void>;
  loadRecentConstructionReports: (limit?: number) => Promise<void>;
  loadWikiLibraryFiles: (search?: string) => Promise<void>;
  loadThreads: () => Promise<void>;
  loadArchivedThreads: () => Promise<void>;
  loadMessages: (threadId: number) => Promise<void>;
  refreshTimeData: () => Promise<void>;
  onLogin: (event: FormEvent) => Promise<void>;
  submitPublicInviteAccept: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  submitPublicPasswordReset: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  submitProjectForm: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  saveProjectInternalNote: () => Promise<void>;
  saveProjectFinance: () => Promise<void>;
  saveProjectHours: () => Promise<void>;
  archiveActiveProject: () => Promise<void>;
  deleteActiveProject: () => Promise<void>;
  unarchiveProject: (projectId: number, expectedLastUpdatedAt?: string | null) => Promise<void>;
  deleteProjectById: (projectId: number) => Promise<void>;
  createTask: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  createWeeklyPlanTask: () => Promise<void>;
  saveTaskEdit: () => Promise<void>;
  markTaskDone: (task: Task, options?: { openReportFromTask?: Task; reportBackView?: MainView | null }) => Promise<void>;
  deleteTaskFromEdit: () => Promise<void>;
  exportTaskCalendar: (task: Task) => Promise<void>;
  createTicket: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  uploadTicketAttachment: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  clockIn: () => Promise<void>;
  clockOut: () => Promise<void>;
  startBreak: () => Promise<void>;
  endBreak: () => Promise<void>;
  updateTimeEntry: (event: FormEvent<HTMLFormElement>, entryId: number) => Promise<void>;
  submitThreadModal: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  archiveActiveThread: () => Promise<void>;
  openArchivedThreadsModal: () => Promise<void>;
  restoreArchivedThread: (threadId: number) => Promise<void>;
  deleteThread: (thread: Thread) => Promise<void>;
  sendMessage: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  uploadFile: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  createProjectFolderFromInput: () => Promise<void>;
  saveAvatar: () => Promise<void>;
  deleteAvatar: () => Promise<void>;
  applyTemplate: (userId: number) => Promise<void>;
  updateRole: (userId: number, role: User["role"]) => Promise<void>;
  updateRequiredDailyHours: (targetUserId: number) => Promise<void>;
  saveProfileSettings: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  sendInviteToUser: (targetUserId: number) => Promise<void>;
  sendPasswordResetToUser: (targetUserId: number) => Promise<void>;
  softDeleteUser: (targetUserId: number) => Promise<void>;
  restoreArchivedUser: (targetUserId: number) => Promise<void>;
  submitCreateInvite: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  exportEncryptedDatabaseBackup: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  submitVacationRequest: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  reviewVacationRequest: (requestId: number, status: "approved" | "rejected") => Promise<void>;
  submitSchoolAbsence: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  removeSchoolAbsence: (absenceId: number) => Promise<void>;
  downloadProjectCsvTemplate: () => Promise<void>;
  downloadProjectClassTemplateCsv: () => Promise<void>;
  importProjectsCsv: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  importProjectClassTemplateCsv: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  submitConstructionReport: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  copyToClipboard: (value: string, label: "all" | "project" | "address") => Promise<void>;
}

export const AppContext = createContext<AppContextValue | null>(null);

export function useAppContext(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useAppContext must be used inside AppContext.Provider");
  return ctx;
}
