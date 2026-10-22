/**
 * Titles, descriptions and groups of the start-page widgets.
 *
 * Kept apart from the widget components (docs/DASHBOARD.md D24): the editor's
 * placeholder tiles, the „Widget hinzufügen“ dialog and the admin tab render
 * from this alone, so editing a layout downloads no widget code and fires no
 * widget request. The German copy is §8.5 verbatim; `group` matches the
 * server's catalog (§1).
 */
import type { DashboardDevice, DashboardWidgetGroup, DashboardWidgetId } from "../../types/dashboard";

type Text = { de: string; en: string };

/** How the three device classes are named in the editor, its notices and the admin tab (§8.2). */
export const DASHBOARD_DEVICE_LABEL: Readonly<Record<DashboardDevice, Text>> = Object.freeze({
  mobile: { de: "Handy", en: "Phone" },
  tablet: { de: "Tablet", en: "Tablet" },
  desktop: { de: "Desktop", en: "Desktop" },
});

export type DashboardWidgetMeta = {
  id: DashboardWidgetId;
  group: DashboardWidgetGroup;
  title: Text;
  description: Text;
};

function meta(
  id: DashboardWidgetId,
  group: DashboardWidgetGroup,
  title: Text,
  description: Text,
): DashboardWidgetMeta {
  return { id, group, title, description };
}

export const DASHBOARD_WIDGET_META: Readonly<Record<DashboardWidgetId, DashboardWidgetMeta>> = Object.freeze({
  shortcuts: meta(
    "shortcuts",
    "shortcuts",
    { de: "Schnellzugriff", en: "Shortcuts" },
    { de: "Kacheln zu deinen wichtigsten Seiten.", en: "Tiles for your most important pages." },
  ),
  my_status: meta(
    "my_status",
    "personal",
    { de: "Mein Status", en: "My status" },
    { de: "Ein- und ausstempeln, Stunden heute.", en: "Clock in and out, hours today." },
  ),
  my_tasks: meta(
    "my_tasks",
    "personal",
    { de: "Meine Aufgaben", en: "My tasks" },
    { de: "Deine offenen Aufgaben, überfällige zuerst.", en: "Your open tasks, overdue first." },
  ),
  my_vacation: meta(
    "my_vacation",
    "personal",
    { de: "Urlaub", en: "Vacation" },
    { de: "Resturlaub und deine Anträge.", en: "Remaining leave and your requests." },
  ),
  notifications: meta(
    "notifications",
    "personal",
    { de: "Benachrichtigungen", en: "Notifications" },
    { de: "Neueste Hinweise für dich.", en: "The latest notices for you." },
  ),
  planning_today: meta(
    "planning_today",
    "planning",
    { de: "Mein Einsatz", en: "My schedule" },
    {
      de: "Wofür du heute und diese Woche eingeplant bist.",
      en: "What you are scheduled for today and this week.",
    },
  ),
  my_projects: meta(
    "my_projects",
    "planning",
    { de: "Meine Projekte", en: "My projects" },
    { de: "Projekte mit offenen Aufgaben für dich.", en: "Projects with open tasks for you." },
  ),
  critical_projects: meta(
    "critical_projects",
    "planning",
    { de: "Kritische Projekte", en: "Critical projects" },
    { de: "Als kritisch markierte Projekte.", en: "Projects marked as critical." },
  ),
  absent_today: meta(
    "absent_today",
    "planning",
    { de: "Wer fehlt heute", en: "Absent today" },
    { de: "Wer heute nicht da ist.", en: "Who is not in today." },
  ),
  werkstatt_kpis: meta(
    "werkstatt_kpis",
    "werkstatt",
    { de: "Lager-Kennzahlen", en: "Stock figures" },
    {
      de: "Unter Mindestbestand, auf Baustelle, in Reparatur.",
      en: "Below minimum stock, on site, in repair.",
    },
  ),
  werkstatt_reorder: meta(
    "werkstatt_reorder",
    "werkstatt",
    { de: "Nachbestellen", en: "Reorder" },
    { de: "Artikel unter Mindestbestand.", en: "Articles below minimum stock." },
  ),
  werkstatt_on_site: meta(
    "werkstatt_on_site",
    "werkstatt",
    { de: "Auf Baustelle", en: "On site" },
    { de: "Ausgegebenes Material je Projekt.", en: "Issued material per project." },
  ),
  werkstatt_my_checkouts: meta(
    "werkstatt_my_checkouts",
    "werkstatt",
    { de: "Meine Ausleihen", en: "My checkouts" },
    { de: "Was du gerade ausgeliehen hast.", en: "What you currently have checked out." },
  ),
  werkstatt_boxes: meta(
    "werkstatt_boxes",
    "werkstatt",
    { de: "Baustellenkisten", en: "Construction boxes" },
    { de: "Gepackte und zugewiesene Kisten.", en: "Packed and assigned boxes." },
  ),
  werkstatt_inspections: meta(
    "werkstatt_inspections",
    "werkstatt",
    { de: "Fällige Prüfungen", en: "Due inspections" },
    { de: "Prüfungen der nächsten 30 Tage.", en: "Inspections due in the next 30 days." },
  ),
  recent_panels: meta(
    "recent_panels",
    "werkstatt",
    { de: "Zuletzt bearbeitete Verteiler", en: "Recently edited panels" },
    { de: "Die zuletzt geänderten Verteilerpläne.", en: "The most recently changed panel plans." },
  ),
  recent_reports: meta(
    "recent_reports",
    "office",
    { de: "Neueste Berichte", en: "Latest reports" },
    { de: "Die neuesten Baustellenberichte.", en: "The latest construction reports." },
  ),
  vacation_approvals: meta(
    "vacation_approvals",
    "office",
    { de: "Offene Urlaubsanträge", en: "Pending vacation requests" },
    { de: "Anträge, die auf Freigabe warten.", en: "Requests waiting for approval." },
  ),
  clocked_in: meta(
    "clocked_in",
    "office",
    { de: "Wer ist eingestempelt", en: "Clocked in" },
    { de: "Wer gerade arbeitet, mit Stunden heute.", en: "Who is working right now, with hours today." },
  ),
  unread_chats: meta(
    "unread_chats",
    "office",
    { de: "Ungelesene Chats", en: "Unread chats" },
    { de: "Chats mit neuen Nachrichten.", en: "Chats with new messages." },
  ),
});
