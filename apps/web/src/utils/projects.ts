import { PROJECT_SITE_ACCESS_PRESETS, PROJECT_SITE_ACCESS_WITH_NOTE } from "../constants";
import type { Language, Project, ProjectClassTemplate, ProjectTitleParts, ProjectFormState } from "../types";
import { parseServerDateTime, localDateTimeInputToIso } from "./dates";
import { normalizeAddressInput } from "./misc";

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
  const sections: string[] = [];
  if (materials) {
    sections.push(`${language === "de" ? "Materialien" : "Materials"}:\n${materials}`);
  }
  if (tools) {
    sections.push(`${language === "de" ? "Werkzeuge" : "Tools"}:\n${tools}`);
  }
  return sections.join("\n\n").trim();
}

export function activityEventLabel(eventType: string, language: Language) {
  const map: Record<string, { de: string; en: string }> = {
    "project.created": { de: "Projekt erstellt", en: "Project created" },
    "project.classes_updated": { de: "Projektklassen aktualisiert", en: "Project classes updated" },
    "project.state_changed": { de: "Status geändert", en: "State changed" },
    "project.note_updated": { de: "Notiz aktualisiert", en: "Note updated" },
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
  return {
    project_number: form.project_number.trim(),
    name: form.name.trim(),
    description: form.description.trim(),
    status: form.status.trim() || "active",
    last_state: form.last_state.trim() || null,
    last_status_at: localDateTimeInputToIso(form.last_status_at),
    customer_name: form.customer_name.trim(),
    customer_address: normalizeAddressInput(form.customer_address),
    construction_site_address: normalizeAddressInput(form.construction_site_address),
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
