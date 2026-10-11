// Building blocks shared by the portal's screens: the navy band, the two
// navigations (top on wide screens, bottom on phones), the segmented
// Offen/Erledigt switch, the day-group label and the job row.

import type { ReactNode } from "react";
import { projectSiteAccessLabel, projectSiteAccessRequiresNote } from "../utils/projects";
import { AccountIcon, ChevronLeftIcon, ChevronRightIcon, PinIcon, ProjectsIcon, TasksIcon } from "./PortalIcons";
import { timeLane, type TaskGroup } from "./portalDates";
import type { PortalMe, PortalTask } from "./portalTypes";

export type NavTarget = "tasks" | "projects" | "account";

const NAV: Array<{ key: NavTarget; label: string; Icon: typeof TasksIcon }> = [
  { key: "tasks", label: "Aufgaben", Icon: TasksIcon },
  { key: "projects", label: "Projekte", Icon: ProjectsIcon },
  { key: "account", label: "Konto", Icon: AccountIcon },
];

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  const first = parts[0][0] ?? "";
  const last = parts.length > 1 ? parts[parts.length - 1][0] ?? "" : "";
  return (first + last).toUpperCase();
}

/** A route link for the phone's maps app: Apple Maps on iOS, Google elsewhere. */
export function mapsHref(address: string, userAgent: string = typeof navigator !== "undefined" ? navigator.userAgent : ""): string {
  const query = encodeURIComponent(address);
  return /iPhone|iPad|iPod/i.test(userAgent)
    ? `https://maps.apple.com/?daddr=${query}`
    : `https://www.google.com/maps/dir/?api=1&destination=${query}`;
}

/** The site-access line: the office's preset ("Schlüssel abholen bei") plus its note. */
export function accessText(type: string | null, note: string | null): string | null {
  const label = projectSiteAccessLabel(type, "de");
  const text = (note ?? "").trim();
  if (label && text) return projectSiteAccessRequiresNote(type) ? `${label}: ${text}` : `${label}. ${text}`;
  return label || text || null;
}

export function telHref(phone: string): string {
  return `tel:${phone.replace(/[^\d+]/g, "")}`;
}

type BandProps = {
  me: PortalMe | null;
  active: NavTarget | null;
  onNavigate: (target: NavTarget) => void;
  children: ReactNode;
};

export function PortalBand({ me, active, onNavigate, children }: BandProps) {
  const companyName = me?.company.name || "SMPL";
  const logo = me?.company.logo_url?.trim();
  return (
    <header className="pp-band">
      <div className="pp-band-inner">
        <div className="pp-topbar">
          <div className="pp-brand">
            <div className="pp-brand-mark" aria-hidden="true">
              {logo ? <img src={logo} alt="" /> : companyName.slice(0, 1).toUpperCase()}
            </div>
            <div>
              <div className="pp-brand-name">{companyName}</div>
              <div className="pp-brand-kicker">Partnerportal</div>
            </div>
          </div>
          <nav className="pp-topnav" aria-label="Partnerportal">
            {NAV.map(({ key, label }) => (
              <button
                key={key}
                type="button"
                className="pp-topnav-link"
                aria-current={active === key ? "page" : undefined}
                onClick={() => onNavigate(key)}
              >
                {label}
              </button>
            ))}
          </nav>
          {me && (
            <button type="button" className="pp-avatar" onClick={() => onNavigate("account")} aria-label={`Konto von ${me.user.full_name}`}>
              {initials(me.user.full_name)}
            </button>
          )}
        </div>
        {children}
      </div>
    </header>
  );
}

type TitleProps = {
  eyebrow?: string | null;
  title: string;
  subtitle?: string | null;
  detail?: boolean;
  pills?: ReactNode;
  back?: { label: string; onClick: () => void };
};

export function PortalTitle({ eyebrow, title, subtitle, detail, pills, back }: TitleProps) {
  return (
    <>
      {back && (
        <button type="button" className="pp-back" onClick={back.onClick}>
          <ChevronLeftIcon size={22} />
          {back.label}
        </button>
      )}
      <div className="pp-title-block" style={back ? { paddingTop: 10 } : undefined}>
        {eyebrow && <div className="pp-eyebrow">{eyebrow}</div>}
        <h1 className={detail ? "pp-title pp-title--detail" : "pp-title"}>{title}</h1>
        {subtitle && <p className="pp-subtitle">{subtitle}</p>}
        {pills && <div className="pp-pills">{pills}</div>}
      </div>
    </>
  );
}

export function BottomNav({ active, onNavigate }: { active: NavTarget | null; onNavigate: (target: NavTarget) => void }) {
  return (
    <nav className="pp-bottomnav" aria-label="Partnerportal">
      {NAV.map(({ key, label, Icon }) => (
        <button
          key={key}
          type="button"
          className="pp-bottomnav-link"
          aria-current={active === key ? "page" : undefined}
          onClick={() => onNavigate(key)}
        >
          <Icon size={24} />
          {label}
        </button>
      ))}
    </nav>
  );
}

type SegmentOption<T extends string> = { value: T; label: string; count?: number | null };

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: Array<SegmentOption<T>>;
  value: T;
  onChange: (value: T) => void;
  label: string;
}) {
  return (
    <div className="pp-segmented" role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className="pp-segment"
          aria-pressed={option.value === value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
          {option.count != null && option.count > 0 && <span className="pp-count">{option.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function GroupLabel({ label, hint }: { label: string; hint?: string }) {
  return (
    <div className="pp-group-label">
      <span className="pp-group-key">{label}</span>
      {hint && <span className="pp-group-hint">{hint}</span>}
    </div>
  );
}

function TaskContext({ task, showProject }: { task: PortalTask; showProject: boolean }) {
  if (task.project && showProject) {
    // The number stays on one line: "2024-" / "015" reads as two things.
    return (
      <span className="pp-row-meta">
        {task.project.name} · <span className="pp-nowrap">{task.project.number}</span>
      </span>
    );
  }
  if (task.customer_name) return <span className="pp-row-meta">{task.customer_name}</span>;
  return null;
}

export function TaskRow({
  task,
  todayIso,
  onOpen,
  showProject = true,
  group,
}: {
  task: PortalTask;
  todayIso: string;
  onOpen: (task: PortalTask) => void;
  showProject?: boolean;
  group?: TaskGroup["key"];
}) {
  const lane = timeLane(task, todayIso);
  const laneClass =
    task.is_overdue
      ? "pp-lane-primary pp-lane-primary--overdue"
      : group === "today" && lane.primary === "Heute"
        ? "pp-lane-primary pp-lane-primary--today"
        : "pp-lane-primary";
  return (
    <button type="button" className="pp-row" onClick={() => onOpen(task)}>
      <span className="pp-lane">
        <span className={laneClass}>{lane.primary}</span>
        {lane.secondary && <span className="pp-lane-secondary">{lane.secondary}</span>}
      </span>
      <span className="pp-row-body">
        <span className="pp-row-title">{task.title}</span>
        <TaskContext task={task} showProject={showProject} />
        {/* Inside a project the address is the project's, already on screen. */}
        {task.address && showProject && (
          <span className="pp-row-address">
            <PinIcon size={14} />
            {task.address}
          </span>
        )}
      </span>
      <span className="pp-chevron">
        <ChevronRightIcon size={20} />
      </span>
    </button>
  );
}

export function EmptyState({ title, text }: { title: string; text: string }) {
  return (
    <div className="pp-empty" role="status">
      <div className="pp-empty-title">{title}</div>
      <div>{text}</div>
    </div>
  );
}

export function Skeletons({ count = 3 }: { count?: number }) {
  return (
    <div aria-busy="true" aria-label="Wird geladen" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {Array.from({ length: count }, (_, index) => (
        <div key={index} className="pp-skeleton" />
      ))}
    </div>
  );
}
