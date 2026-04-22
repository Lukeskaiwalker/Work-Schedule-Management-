import { PROJECT_SITE_ACCESS_PRESETS, PROJECT_SITE_ACCESS_WITH_NOTE } from "../constants";
import type { Language, Project, ProjectClassTemplate, ProjectTitleParts, ProjectFormState } from "../types";
import { parseServerDateTime, localDateTimeInputToIso } from "./dates";
import { normalizeAddressInput } from "./misc";

const ZIP_RE = /\b\d{5}\b/g;

export function statusLabel(value: string, language: Language) {
  const raw = String(value || "").trim();
  const normalized = raw
    .trim()
    .toLowerCase();
  if (normalized === "active") return language === "de" ? "Aktiv" : "Active";
  if (normalized === "on_hold") return language === "de" ? "Pausiert" : "On hold";
  if (normalized === "completed") return language === "de" ? "Abgeschlossen" : "Completed";
  return raw || (language === "de" ? "Aktiv" : "Active");
}

export function normalizeProjectSiteAccessType(value?: string | null) {
  const normalized = String(value || "").trim();
  if (!normalized) return "";
  return PROJECT_SITE_ACCESS_PRESETS.includes(normalized as (typeof PROJECT_SITE_ACCESS_PRESETS)[number]) ? normalized : "";
}

export function projectSiteAccessRequiresNote(value?: string | null) {
  return PROJECT_SITE_ACCESS_WITH_NOTE.has(normalizeProjectSiteAccessType(value));
}

export function projectSiteAccessLabel(value: string | null | undefined, language: Language) {
  const normalized = normalizeProjectSiteAccessType(value);
  if (normalized === "customer_on_site") {
    return language === "de" ? "Kunde ist Vorort" : "Customer is on site";
  }
  if (normalized === "freely_accessible") {
    return language === "de" ? "frei zugänglich" : "Freely accessible";
  }
  if (normalized === "key_in_office") {
    return language === "de" ? "Schlüssel im Büro" : "Key in office";
  }
  if (normalized === "key_pickup") {
    return language === "de" ? "Schlüssel abholen bei" : "Pick up key at";
  }
  if (normalized === "code_access") {
    return language === "de" ? "Zugang über Code" : "Access via code";
  }
  if (normalized === "key_box") {
    return language === "de" ? "Schlüsselbox" : "Key box";
  }
  if (normalized === "call_before_departure") {
    return language === "de" ? "Anrufen vor Abfahrt" : "Call before departure";
  }
  return "";
}

export function projectSiteAccessDisplay(value: string | null | undefined, note: string | null | undefined, language: Language) {
  const label = projectSiteAccessLabel(value, language);
  if (!label) return "-";
  const normalizedNote = (note ?? "").trim();
  if (projectSiteAccessRequiresNote(value) && normalizedNote) return `${label}: ${normalizedNote}`;
  return label;
}

export function classTemplateMaterialsText(template: ProjectClassTemplate | null, language: Language): string {
  if (!template) return "";
  const materials = (template.materials_required ?? "").trim();
  const tools = (template.tools_required ?? "").trim();
  const rows: string[] = [];
  if (materials) {
    rows.push(...materials.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0));
  }
  if (tools) {
    rows.push(
      ...tools
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => `${language === "de" ? "Werkzeug" : "Tool"}: ${line}`),
    );
  }
  return rows.join("\n").trim();
}

export function activityEventLabel(eventType: string, language: Language) {
  const map: Record<string, { de: string; en: string }> = {
    "project.created": { de: "Projekt erstellt", en: "Project created" },
    "project.classes_updated": { de: "Projektklassen aktualisiert", en: "Project classes updated" },
    "project.state_changed": { de: "Status geändert", en: "State changed" },
    "project.note_updated": { de: "Notiz aktualisiert", en: "Note updated" },
    "project.critical_set": { de: "Als kritisch markiert", en: "Marked as critical" },
    "project.critical_cleared": { de: "Kritisch-Markierung entfernt", en: "Critical flag cleared" },
    "task.created": { de: "Aufgabe erstellt", en: "Task created" },
    "task.updated": { de: "Aufgabe aktualisiert", en: "Task updated" },
    "task.deleted": { de: "Aufgabe gelöscht", en: "Task deleted" },
    "ticket.created": { de: "Ticket erstellt", en: "Ticket created" },
    "ticket.updated": { de: "Ticket aktualisiert", en: "Ticket updated" },
    "file.uploaded": { de: "Datei hochgeladen", en: "File uploaded" },
    "file.deleted": { de: "Datei gelöscht", en: "File deleted" },
    "report.created": { de: "Bericht erstellt", en: "Report created" },
    "material.created": { de: "Materialbedarf erstellt", en: "Material need created" },
    "material.status_updated": { de: "Materialstatus aktualisiert", en: "Material status updated" },
    "finance.updated": { de: "Finanzen aktualisiert", en: "Finances updated" },
  };
  return map[eventType] ? (language === "de" ? map[eventType].de : map[eventType].en) : eventType;
}

export function projectUpdatedTimestamp(project: Project) {
  const byLastUpdate = project.last_updated_at ? parseServerDateTime(project.last_updated_at)?.getTime() : Number.NaN;
  if (Number.isFinite(byLastUpdate)) return byLastUpdate;
  const direct = project.last_status_at ? parseServerDateTime(project.last_status_at)?.getTime() : Number.NaN;
  if (Number.isFinite(direct)) return direct;
  const fromExtra = project.extra_attributes?.["Letzter Status Datum"];
  if (typeof fromExtra === "string") {
    const parsed = parseServerDateTime(fromExtra)?.getTime();
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

export function isArchivedProjectStatus(value: string | null | undefined) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (!normalized) return false;
  return normalized === "archived" || normalized === "archiviert" || normalized.includes("archiv");
}

export function preferredProjectDisplayName(customerName?: string | null, projectName?: string | null) {
  const customer = String(customerName ?? "").trim();
  if (customer) return customer;
  return String(projectName ?? "").trim();
}

export function projectLocationAddress(project: Pick<Project, "construction_site_address" | "customer_address"> | null | undefined) {
  if (!project) return "";
  const constructionSiteAddress = String(project.construction_site_address ?? "").trim();
  if (constructionSiteAddress) return constructionSiteAddress;
  return String(project.customer_address ?? "").trim();
}

function normalizedTravelAddress(address: string) {
  return normalizeAddressInput(address).replace(/\s+/g, " ").trim();
}

function addressCityFragment(address: string) {
  const match = normalizedTravelAddress(address).match(/\b\d{5}\s+([^,]+)/);
  if (!match) return "";
  return match[1].replace(/\s{2,}/g, " ").trim().toLowerCase();
}

export function estimateTravelMinutesFromAddresses(fromAddress: string, toAddress: string): number | null {
  const left = normalizedTravelAddress(fromAddress);
  const right = normalizedTravelAddress(toAddress);
  if (!left || !right) return null;
  if (left.toLowerCase() === right.toLowerCase()) return 0;

  const leftZip = left.match(ZIP_RE) ?? [];
  const rightZip = right.match(ZIP_RE) ?? [];
  const leftCity = addressCityFragment(left);
  const rightCity = addressCityFragment(right);

  if (leftZip.length > 0 && rightZip.length > 0) {
    const leftZipValue = leftZip[0] ?? "";
    const rightZipValue = rightZip[0] ?? "";
    if (leftZipValue === rightZipValue) return 12;
    if (leftCity && rightCity && leftCity === rightCity) return 18;
    if (leftZipValue.slice(0, 2) === rightZipValue.slice(0, 2)) return 30;
    return 45;
  }

  if (leftCity && rightCity) {
    if (leftCity === rightCity) return 18;
    return 35;
  }

  return 15;
}

export function estimateTravelMinutesBetweenProjects(
  fromProject: Pick<Project, "construction_site_address" | "customer_address"> | null | undefined,
  toProject: Pick<Project, "construction_site_address" | "customer_address"> | null | undefined,
) {
  const fromAddress = projectLocationAddress(fromProject);
  const toAddress = projectLocationAddress(toProject);
  return estimateTravelMinutesFromAddresses(fromAddress, toAddress);
}

export function formatProjectTitle(
  projectNumber?: string | null,
  customerName?: string | null,
  projectName?: string | null,
  fallbackId?: number | null,
) {
  const number = String(projectNumber ?? "").trim();
  const name = preferredProjectDisplayName(customerName, projectName);
  if (number && name) return `${number} - ${name}`;
  if (number) return number;
  if (name) return name;
  if (typeof fallbackId === "number" && Number.isFinite(fallbackId)) return String(fallbackId);
  return "-";
}

export function formatProjectSubtitle(customerName?: string | null, projectName?: string | null) {
  const customer = String(customerName ?? "").trim();
  const project = String(projectName ?? "").trim();
  if (!customer || !project) return "";
  if (customer.localeCompare(project, undefined, { sensitivity: "base" }) === 0) return "";
  return project;
}

export function formatProjectTitleParts(
  projectNumber?: string | null,
  customerName?: string | null,
  projectName?: string | null,
  fallbackId?: number | null,
): ProjectTitleParts {
  return {
    title: formatProjectTitle(projectNumber, customerName, projectName, fallbackId),
    subtitle: formatProjectSubtitle(customerName, projectName),
  };
}

export function projectPayloadFromForm(form: ProjectFormState) {
  const normalizedSiteAccessType = normalizeProjectSiteAccessType(form.site_access_type);
  // When the user keeps "use_separate_site_address" off, we don't send a
  // site address — backend will treat the customer address as authoritative.
  // When a customer_id is set, the legacy `customer_*` snapshot fields are
  // still sent so older consumers (reports, CSV exports) keep working until
  // they migrate to joining through `customer_id`.
  const constructionSite = form.use_separate_site_address
    ? normalizeAddressInput(form.construction_site_address)
    : "";
  return {
    project_number: form.project_number.trim(),
    name: form.name.trim(),
    description: form.description.trim(),
    status: form.status.trim() || "active",
    last_state: form.last_state.trim() || null,
    last_status_at: localDateTimeInputToIso(form.last_status_at),
    customer_id: form.customer_id,
    customer_name: form.customer_name.trim(),
    customer_address: normalizeAddressInput(form.customer_address),
    construction_site_address: constructionSite,
    customer_contact: form.customer_contact.trim(),
    customer_email: form.customer_email.trim(),
    customer_phone: form.customer_phone.trim(),
    site_access_type: normalizedSiteAccessType || null,
    site_access_note: projectSiteAccessRequiresNote(normalizedSiteAccessType)
      ? form.site_access_note.trim() || null
      : null,
    class_template_ids: form.class_template_ids,
  };
}
