import type { MainView } from "../../types";

export function SidebarNavIcon({ view }: { view: MainView }) {
  if (view === "overview") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true" className="nav-icon">
        <path d="M3 11.5 12 4l9 7.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M6 10.5v9h12v-9" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  if (view === "materials") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true" className="nav-icon">
        <path d="M4.5 7.5h15v11h-15zM4.5 7.5 12 3l7.5 4.5M12 12.2v6.3" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  if (view === "my_tasks" || view === "office_tasks") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true" className="nav-icon">
        <path d="M7 7h14M7 12h14M7 17h14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        <path d="m3.5 7.2 1.5 1.5 2.4-2.8m-3.9 6.9 1.5 1.5 2.4-2.8m-3.9 6.9 1.5 1.5 2.4-2.8" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  if (view === "planning") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true" className="nav-icon">
        <rect x="3.5" y="5.5" width="17" height="15" rx="2.4" fill="none" stroke="currentColor" strokeWidth="1.8" />
        <path d="M8 3.5v4M16 3.5v4M3.5 10h17" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
    );
  }
  if (view === "calendar") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true" className="nav-icon">
        <rect x="3.5" y="4.5" width="17" height="16" rx="2.4" fill="none" stroke="currentColor" strokeWidth="1.8" />
        <path d="M8 2.5v4M16 2.5v4M3.5 9.3h17" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        <path d="M8 12.6h2.4M13.8 12.6h2.4M8 16.4h2.4M13.8 16.4h2.4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
    );
  }
  if (view === "construction") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true" className="nav-icon">
        <rect x="6" y="3.5" width="12" height="17" rx="2.4" fill="none" stroke="currentColor" strokeWidth="1.8" />
        <path d="M9 8h6M9 12h6M9 16h4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
    );
  }
  if (view === "wiki") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true" className="nav-icon">
        <path d="M5 4.5h11a3 3 0 0 1 3 3V19a2 2 0 0 0-2-2H6.5A2.5 2.5 0 0 0 4 19V6.5a2 2 0 0 1 2-2Z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
        <path d="M8 8h7M8 11.5h7" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
    );
  }
  if (view === "messages") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true" className="nav-icon">
        <path d="M4.5 6.5h15a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2h-8l-4 3v-3h-3a2 2 0 0 1-2-2V8.5a2 2 0 0 1 2-2Z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="nav-icon">
      <circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path d="M12 7.8v4.7l3 1.8" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function PenIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="task-edit-pen-icon">
      <path
        d="M4 20h4.2L19 9.2a1.4 1.4 0 0 0 0-2L16.8 5a1.4 1.4 0 0 0-2 0L4 15.8V20Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="m13.8 6 4.2 4.2" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

export function BackIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="task-edit-pen-icon">
      <path
        d="M15.5 5.5 8.5 12l7 6.5M9 12h11"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function SearchIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="task-edit-pen-icon">
      <circle cx="11" cy="11" r="6.3" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path d="m15.6 15.6 4 4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

export function BellIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="notif-bell-icon">
      <path
        d="M12 4.2a4.6 4.6 0 0 0-4.6 4.6v2.5c0 1.8-.5 3.6-1.5 5.1L4.7 18h14.6l-1.2-1.6a8.8 8.8 0 0 1-1.5-5.1V8.8A4.6 4.6 0 0 0 12 4.2Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M9.8 18.8a2.3 2.3 0 0 0 4.4 0" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

export function CopyIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="task-edit-pen-icon">
      <rect x="9" y="9" width="10.5" height="10.5" rx="1.8" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path
        d="M6.4 15H5.8a1.8 1.8 0 0 1-1.8-1.8V5.8A1.8 1.8 0 0 1 5.8 4h7.4A1.8 1.8 0 0 1 15 5.8v.6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}
