/**
 * What an audit entry's target is, in words.
 *
 * The Protokoll row printed `target_type` as stored ("school_absence ·
 * 12"). The action stays a code on purpose — it is the identifier an admin
 * searches for and quotes — but the target is a noun and reads as one. Keys
 * are what the API's `log_admin_action` calls write; a target this map does
 * not know yet shows as stored rather than disappearing.
 */
const AUDIT_TARGET_LABELS: Record<string, { de: string; en: string }> = {
  api_token: { de: "API-Token", en: "API token" },
  backup: { de: "Backup", en: "Backup" },
  bulk: { de: "Sammelaktion", en: "Bulk action" },
  clock_entry: { de: "Zeiteintrag", en: "Time entry" },
  company: { de: "Firmendaten", en: "Company" },
  customer_credential: { de: "Zugangsdaten", en: "Credential" },
  // A role's default start page; the target id reads "{role}:{device}".
  dashboard_default: { de: "Standard-Startseite", en: "Default start page" },
  employee_group: { de: "Mitarbeitergruppe", en: "Employee group" },
  file: { de: "Datei", en: "File" },
  label_printer: { de: "Etikettendrucker", en: "Label printer" },
  material_catalog_item: { de: "Katalogartikel", en: "Catalog item" },
  message: { de: "Nachricht", en: "Message" },
  openai: { de: "OpenAI-Einstellungen", en: "OpenAI settings" },
  permission: { de: "Berechtigung", en: "Permission" },
  project: { de: "Projekt", en: "Project" },
  project_class_template: { de: "Projektklasse", en: "Project class" },
  project_line_item: { de: "Projektposition", en: "Project line item" },
  projects: { de: "Projekte", en: "Projects" },
  report: { de: "Bericht", en: "Report" },
  role: { de: "Rolle", en: "Role" },
  school_absence: { de: "Abwesenheit", en: "Absence" },
  settings: { de: "Einstellungen", en: "Settings" },
  smtp: { de: "E-Mail-Versand", en: "Email (SMTP)" },
  station: { de: "Scan-Station", en: "Scan station" },
  station_pairing: { de: "Stationskopplung", en: "Station pairing" },
  system: { de: "System", en: "System" },
  task: { de: "Aufgabe", en: "Task" },
  thread: { de: "Chat-Thread", en: "Chat thread" },
  ticket: { de: "Ticket", en: "Ticket" },
  training_week_report: { de: "Ausbildungsnachweis", en: "Training report" },
  updates: { de: "Updates", en: "Updates" },
  user: { de: "Benutzer", en: "User" },
  vacation_request: { de: "Urlaubsantrag", en: "Vacation request" },
  weather: { de: "Wetterdienst", en: "Weather" },
  werkstatt_ids_connection: { de: "Shop-Anbindung", en: "Shop connection" },
  wiki_page: { de: "Wiki-Seite", en: "Wiki page" },
};

export function auditTargetLabel(targetType: string, de: boolean): string {
  const entry = AUDIT_TARGET_LABELS[targetType];
  if (!entry) return targetType;
  return de ? entry.de : entry.en;
}
