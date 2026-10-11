// Shapes of /api/portal — mirror apps/api/app/schemas/portal.py.
//
// Deliberately separate from the office app's `types/index.ts`: the portal
// never sees an office `Task` or `Project`, and keeping the two vocabularies
// apart makes it impossible to wire an office field into a partner screen
// by accident.

export type PortalUser = { id: number; full_name: string; email: string };
export type PortalPartner = { id: number; name: string; trade: string | null };
export type PortalCompany = { name: string; logo_url: string; phone: string; email: string };
export type PortalMe = { user: PortalUser; partner: PortalPartner; company: PortalCompany };

export type PortalTaskStatus = "open" | "in_progress" | "on_hold" | "done";

export type PortalProjectRef = { id: number; number: string; name: string };

export type PortalTask = {
  id: number;
  title: string;
  status: PortalTaskStatus;
  due_date: string | null;
  end_date: string | null;
  start_time: string | null;
  estimated_hours: number | null;
  is_overdue: boolean;
  project: PortalProjectRef | null;
  customer_name: string | null;
  address: string | null;
  attachment_count: number;
};

export type PortalFileSource = "partner" | "office" | "external";

export type PortalFile = {
  id: number;
  file_name: string;
  content_type: string;
  created_at: string;
  source: PortalFileSource;
};

/** A file from the project's "Partnerportal" folder; `folder` is the path below it ("" for the folder itself). */
export type PortalDocument = {
  id: number;
  file_name: string;
  content_type: string;
  folder: string;
  created_at: string;
};

export type PortalHoursTaskRef = { id: number; title: string };

/** One day of one crew: `workers` people for `hours` each. */
export type PortalHoursEntry = {
  id: number;
  work_date: string;
  workers: number;
  hours: number;
  total_hours: number;
  note: string | null;
  task: PortalHoursTaskRef | null;
  reported_by: string | null;
  created_at: string;
  can_delete: boolean;
};

export type PortalHoursInput = {
  task_id?: number | null;
  project_id?: number | null;
  work_date: string;
  workers: number;
  hours: number;
  note?: string | null;
};

export type PortalTaskDetail = PortalTask & {
  description: string | null;
  subtasks: string[];
  materials: string | null;
  site_access_type: string | null;
  site_access_note: string | null;
  project_note: string | null;
  team: string[];
  files: PortalFile[];
  documents: PortalDocument[];
  hours: PortalHoursEntry[];
  hours_total: number;
  can_complete: boolean;
};

export type PortalNextTask = { id: number; title: string; due_date: string | null; start_time: string | null };

export type PortalProjectPhase = "running" | "finished";

export type PortalProject = {
  id: number;
  number: string;
  name: string;
  address: string | null;
  phase: PortalProjectPhase;
  open_task_count: number;
  overdue_task_count: number;
  next_task: PortalNextTask | null;
};

export type PortalProjectDetail = PortalProject & {
  site_access_type: string | null;
  site_access_note: string | null;
  partner_note: string | null;
  tasks: PortalTask[];
  documents: PortalDocument[];
  hours: PortalHoursEntry[];
  hours_total: number;
};

export type PortalScope = "open" | "done";
