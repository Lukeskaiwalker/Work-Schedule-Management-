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
  if (view === "werkstatt") {
    // Workshop / inventory — matches the 4-quadrant grid icon in Paper design 7DK-0.
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true" className="nav-icon">
        <rect x="3.5" y="3.5" width="17" height="17" rx="2" fill="none" stroke="currentColor" strokeWidth="1.8" />
        <path d="M8 3.5v17M16 3.5v17M3.5 8h17M3.5 16h17" fill="none" stroke="currentColor" strokeWidth="1.8" />
      </svg>
    );
  }
  if (view === "customers" || view === "customer_detail") {
    // Two-silhouette contact icon — reads as "people/address book" and
    // distinguishes from the single-person profile icon below.
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true" className="nav-icon">
        <circle cx="9.2" cy="8.6" r="3.3" fill="none" stroke="currentColor" strokeWidth="1.8" />
        <path
          d="M3 19.5c.6-3.2 3.1-5 6.2-5s5.6 1.8 6.2 5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M15.8 11.2a3 3 0 0 0 0-5.8M17.5 19.5c-.2-2.3-1.5-3.8-3.3-4.6"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  if (view === "projects_all" || view === "projects_archive") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true" className="nav-icon">
        <path d="M3.5 7.5a1.8 1.8 0 0 1 1.8-1.8h3.9l1.8 2.1h7.7a1.8 1.8 0 0 1 1.8 1.8v8.6a1.8 1.8 0 0 1-1.8 1.8H5.3a1.8 1.8 0 0 1-1.8-1.8V7.5Z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
        <path d="M3.5 11.2h17" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
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
  if (view === "time") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true" className="nav-icon">
        <circle cx="12" cy="12.6" r="7.6" fill="none" stroke="currentColor" strokeWidth="1.8" />
        <path d="M12 8.4v4.2l2.8 1.7" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M9 3.2h6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
    );
  }
  if (view === "profile") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true" className="nav-icon">
        <circle cx="12" cy="8.4" r="3.6" fill="none" stroke="currentColor" strokeWidth="1.8" />
        <path d="M4.8 20c.6-4 3.6-6.1 7.2-6.1s6.6 2.1 7.2 6.1" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  if (view === "admin") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true" className="nav-icon">
        <path
          d="M12 3 4.5 6.2v5.1c0 4.4 3.2 8.4 7.5 9.7 4.3-1.3 7.5-5.3 7.5-9.7V6.2L12 3Z"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinejoin="round"
        />
        <path
          d="m8.5 12 2.5 2.5 4.5-4.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  if (view === "projects_map") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true" className="nav-icon">
        <path
          d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7Z"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
        />
        <circle cx="12" cy="9" r="2.5" fill="none" stroke="currentColor" strokeWidth="1.8" />
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

export function MailIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="task-edit-pen-icon">
      <rect x="3" y="5.5" width="18" height="13" rx="2" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path d="m3 7 9 7 9-7" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function KeyIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="task-edit-pen-icon">
      <circle cx="8.5" cy="12" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path d="m13 12 7.5 0M17.5 12v2.5M20.5 12v2" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

export function ArchiveUserIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="task-edit-pen-icon">
      <circle cx="10" cy="7.5" r="3.5" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path d="M3 20c0-4 3.1-6.5 7-6.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <path d="m16 16 4 4m-4 0 4-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function ShieldIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="task-edit-pen-icon">
      <path d="M12 3 4.5 6.5v6c0 4 3.3 7 7.5 8.5 4.2-1.5 7.5-4.5 7.5-8.5v-6L12 3Z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
      <path d="m8.5 12 2.5 2.5 4.5-4.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function EyeIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="login-password-eye-icon">
      <path
        d="M2.5 12s3.5-7 9.5-7 9.5 7 9.5 7-3.5 7-9.5 7-9.5-7-9.5-7Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="12" r="3.2" fill="none" stroke="currentColor" strokeWidth="1.8" />
    </svg>
  );
}

export function EyeOffIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="login-password-eye-icon">
      <path
        d="M3 3l18 18"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
      <path
        d="M10.6 6.2A11 11 0 0 1 12 6c6 0 9.5 6 9.5 6a19 19 0 0 1-3.2 3.8M6.3 7.9A18 18 0 0 0 2.5 12s3.5 6 9.5 6c1.4 0 2.7-.3 3.9-.8"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M9.8 9.8a3.2 3.2 0 0 0 4.4 4.4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function ResetIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="task-edit-pen-icon">
      <path
        d="M20 11a8 8 0 1 0-2.34 5.66"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M20 4v7h-7"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
