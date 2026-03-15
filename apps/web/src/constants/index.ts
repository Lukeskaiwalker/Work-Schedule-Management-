import type { Language, MainView, ProjectTab, ReportDraft, ProjectFormState, ProjectFinanceFormState, ThreadModalState } from "../types";

export const MAIN_LABELS: Record<Language, Record<MainView, string>> = {
  en: {
    overview: "Overview",
    materials: "Materials",
    projects_all: "All Projects",
    projects_archive: "Project Archive",
    my_tasks: "My Tasks",
    office_tasks: "Tasks",
    project: "Project",
    calendar: "Calendar",
    planning: "Weekly Planning",
    construction: "Construction Report",
    wiki: "Wiki",
    messages: "Chat",
    time: "Time Tracking",
    profile: "Profile",
    admin: "Admin",
  },
  de: {
    overview: "Übersicht",
    materials: "Material",
    projects_all: "Alle Projekte",
    projects_archive: "Projektarchiv",
    my_tasks: "Meine Aufgaben",
    office_tasks: "Aufgaben",
    project: "Projekt",
    calendar: "Kalender",
    planning: "Wochenplanung",
    construction: "Baustellenbericht",
    wiki: "Wiki",
    messages: "Chat",
    time: "Zeiterfassung",
    profile: "Profil",
    admin: "Admin",
  },
};

export const TAB_LABELS: Record<Language, Record<ProjectTab, string>> = {
  en: {
    overview: "Overview",
    tasks: "Tasks",
    hours: "Project Hours",
    materials: "Materials",
    tickets: "Job Tickets",
    files: "Files",
    finances: "Finances",
  },
  de: {
    overview: "Übersicht",
    tasks: "Aufgaben",
    hours: "Projektstunden",
    materials: "Material",
    tickets: "Job Tickets",
    files: "Dateien",
    finances: "Finanzen",
  },
};

export const PROJECT_STATUS_PRESETS = [
  "active",
  "archived",
  "on_hold",
  "completed",
  "Anfrage erhalten",
  "Angebot erstellen",
  "Angebot abgeschickt",
  "Kundentermin angefragt",
  "Kundentermin vereinbart",
  "Auftrag angenommen",
  "In Durchführung",
  "Rechnung erstellen",
  "Rückfragen klären",
];

export const PROJECT_SITE_ACCESS_PRESETS = [
  "customer_on_site",
  "freely_accessible",
  "key_in_office",
  "key_pickup",
  "code_access",
  "key_box",
  "call_before_departure",
] as const;

export const PROJECT_SITE_ACCESS_WITH_NOTE = new Set<string>(["key_pickup", "code_access", "key_box"]);

export const DEFAULT_THREAD_PARTICIPANT_ROLES = ["admin", "ceo", "accountant", "planning", "employee"] as const;

export const MATERIAL_UNIT_EXAMPLES = ["pcs", "m", "cm", "mm", "m2", "m3", "kg", "g", "l", "ml", "set", "pack", "box", "roll"];

export const MATERIAL_CATALOG_SEARCH_LIMIT = 10;

export const WORKSPACE_MODE_STORAGE_KEY = "smpl_workspace_mode";
export const REPORT_DRAFT_LS_KEY = "report_draft_v2";

export const HHMM_PATTERN = "^([01]\\d|2[0-3]):[0-5]\\d$";
export const HHMM_REGEX = /^([01]\d|2[0-3]):[0-5]\d$/;

export const WEATHER_DESCRIPTION_DE_LABELS: Record<string, string> = {
  clear: "Klar",
  "clear sky": "Klarer Himmel",
  clouds: "Bewoelkt",
  "few clouds": "Leicht bewoelkt",
  "scattered clouds": "Aufgelockerte Bewoelkung",
  "broken clouds": "Stark bewoelkt",
  "overcast clouds": "Bedeckt",
  rain: "Regen",
  "light rain": "Leichter Regen",
  "moderate rain": "Maessiger Regen",
  "heavy intensity rain": "Starker Regen",
  "very heavy rain": "Sehr starker Regen",
  "extreme rain": "Extremer Regen",
  drizzle: "Nieselregen",
  "light intensity drizzle": "Leichter Nieselregen",
  "drizzle rain": "Nieselregen",
  "shower rain": "Schauer",
  thunderstorm: "Gewitter",
  snow: "Schnee",
  "light snow": "Leichter Schneefall",
  mist: "Dunst",
  haze: "Dunst",
  fog: "Nebel",
  smoke: "Rauch",
  dust: "Staub",
  sand: "Sand",
  ash: "Asche",
  squall: "Boeen",
  tornado: "Tornado",
  "thunderstorm with light rain": "Gewitter mit leichtem Regen",
  "thunderstorm with rain": "Gewitter mit Regen",
  "thunderstorm with heavy rain": "Gewitter mit starkem Regen",
  "light thunderstorm": "Leichtes Gewitter",
  "heavy thunderstorm": "Starkes Gewitter",
  "ragged thunderstorm": "Unregelmaessiges Gewitter",
  "thunderstorm with light drizzle": "Gewitter mit leichtem Nieselregen",
  "thunderstorm with drizzle": "Gewitter mit Nieselregen",
  "thunderstorm with heavy drizzle": "Gewitter mit starkem Nieselregen",
  "heavy intensity drizzle": "Starker Nieselregen",
  "light intensity drizzle rain": "Leichter Nieselregen",
  "heavy intensity drizzle rain": "Starker Nieselregen",
  "shower rain and drizzle": "Regenschauer mit Nieselregen",
  "heavy shower rain and drizzle": "Starke Regenschauer mit Nieselregen",
  "shower drizzle": "Nieselregen-Schauer",
  "freezing rain": "Gefrierender Regen",
  "light intensity shower rain": "Leichter Regenschauer",
  "heavy intensity shower rain": "Starker Regenschauer",
  "ragged shower rain": "Unregelmaessige Regenschauer",
  "heavy snow": "Starker Schneefall",
  sleet: "Schneeregen",
  "light shower sleet": "Leichter Schneeregen-Schauer",
  "shower sleet": "Schneeregen-Schauer",
  "light rain and snow": "Leichter Regen und Schnee",
  "rain and snow": "Regen und Schnee",
  "light shower snow": "Leichter Schneeschauer",
  "shower snow": "Schneeschauer",
  "heavy shower snow": "Starker Schneeschauer",
  "sand/dust whirls": "Sand-/Staubwirbel",
  "volcanic ash": "Vulkanasche",
  squalls: "Boeen",
  light: "Leicht",
  moderate: "Maessig",
  heavy: "Stark",
  very: "Sehr",
  extreme: "Extrem",
  intensity: "",
  with: "mit",
  and: "und",
  few: "Wenige",
  scattered: "Aufgelockerte",
  broken: "Stark",
  overcast: "Bedeckt",
  shower: "Schauer",
  whirls: "Wirbel",
  volcanic: "Vulkan",
};

export const IMAGE_INPUT_ACCEPT = "image/*,.heic,.heif";
export const IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "gif", "webp", "bmp", "tif", "tiff", "heic", "heif"]);
export const HEIC_EXTENSIONS = new Set(["heic", "heif"]);

export const EMPTY_PROJECT_FORM: ProjectFormState = {
  project_number: "",
  name: "",
  description: "",
  status: "active",
  last_state: "",
  last_status_at: "",
  customer_name: "",
  customer_address: "",
  construction_site_address: "",
  customer_contact: "",
  customer_email: "",
  customer_phone: "",
  site_access_type: "",
  site_access_note: "",
  class_template_ids: [],
};

export const EMPTY_PROJECT_FINANCE_FORM: ProjectFinanceFormState = {
  order_value_net: "",
  down_payment_35: "",
  main_components_50: "",
  final_invoice_15: "",
  planned_costs: "",
  actual_costs: "",
  contribution_margin: "",
};

export const EMPTY_REPORT_DRAFT: ReportDraft = {
  customer: "",
  customer_address: "",
  customer_contact: "",
  customer_email: "",
  customer_phone: "",
  project_name: "",
  project_number: "",
};

export const EMPTY_THREAD_MODAL_FORM: ThreadModalState = {
  name: "",
  project_id: "",
  participant_user_query: "",
  participant_user_ids: [],
  participant_role_query: "",
  participant_roles: [],
};
