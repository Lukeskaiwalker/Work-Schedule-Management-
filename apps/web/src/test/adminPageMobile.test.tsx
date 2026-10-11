/**
 * The Verwaltungszentrum on a phone (owner, 2026-10-10: "Mobile version of the
 * admin center is not optimized for mobile use. I can not even horizontally
 * scroll.").
 *
 * jsdom does not lay out and does not evaluate `@media`, so this file holds
 * the two halves that can be checked without a browser — the lead measures the
 * rest at 375 px in a real one:
 *
 *  - the markup: the page uses the scrolling tab strip and shows the chosen
 *    tab; a Benutzer card says what every number is and in which unit, and
 *    its two icon actions carry words a thumb can find; a Protokoll row
 *    carries a label for each value so it can stack into a card; a backup row
 *    likewise; the restore confirmation is a dialog with a name and the
 *    classes the phone layout styles;
 *  - the stylesheet: AdminPage loads admin-mobile.css, the strip scrolls
 *    sideways at every width instead of being cut off, the phone block snaps
 *    the strip and keeps every text field and select menu at 16 px so iOS
 *    does not zoom into it, and the Protokoll and the backup list follow the
 *    width of their own card rather than the screen's — beside the 320 px
 *    sidebar (900–1279 px) the Protokoll's event column had shrunk to nothing
 *    and the backup table ran past the page.
 */
import { readFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";

import { AppContext } from "../context/AppContext";
import { makeAppContextStub } from "./appContextStub";
import { AdminPage } from "../pages/AdminPage";
import type { AuditLogEntry, BackupListResponse, User } from "../types";

const TEST_DIR = (import.meta as unknown as { dirname: string }).dirname;

/** Not `?raw`: vitest runs with `css: false`, which would hand back "". */
function readSource(relativeToSrc: string): string {
  const text = readFileSync(`${TEST_DIR}/../${relativeToSrc}`, "utf8");
  if (text.trim() === "") throw new Error(`${relativeToSrc} came back empty`);
  return text;
}

/** The body of the first `@media <query>` block, braces balanced. */
function mediaBlock(css: string, query: string): string {
  return atBlock(css, `@media ${query}`);
}

/** The body of the first at-rule block with exactly this prelude, braces balanced. */
function atBlock(css: string, prelude: string): string {
  const head = css.indexOf(`${prelude} {`);
  if (head < 0) return "";
  const open = css.indexOf("{", head);
  let depth = 0;
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === "{") depth += 1;
    if (css[i] === "}") {
      depth -= 1;
      if (depth === 0) return css.slice(open + 1, i);
    }
  }
  return "";
}

/** The stylesheet with every at-rule block taken out: the rules that hold at every width. */
function topLevel(css: string): string {
  const code = css.replace(/\/\*[\s\S]*?\*\//g, "");
  let out = "";
  let depth = 0;
  let inAtRule = false;
  for (let i = 0; i < code.length; i += 1) {
    const ch = code[i];
    if (!inAtRule && depth === 0 && ch === "@") inAtRule = true;
    if (ch === "{") depth += 1;
    if (!inAtRule) out += ch;
    if (ch === "}") {
      depth -= 1;
      if (inAtRule && depth === 0) inAtRule = false;
    }
  }
  return out;
}

/** The declarations of the first rule whose selector list is exactly `selector`. */
function ruleBody(css: string, selector: string): string {
  const pattern = new RegExp(`(^|[}\\s])${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`, "m");
  return pattern.exec(css)?.[2] ?? "";
}

function user(overrides: Partial<User> = {}): User {
  return {
    id: 7,
    email: "max@example.com",
    full_name: "Max Müller",
    display_name: "Max",
    role: "employee",
    is_active: true,
    required_daily_hours: 8,
    vacation_days_per_year: 30,
    vacation_days_available: 10,
    vacation_days_carryover: 2.5,
    vacation_days_total_remaining: 12.5,
    ...overrides,
  };
}

const MAX = user();
const ANNA = user({
  id: 8,
  email: "anna@example.com",
  full_name: "Anna Schmidt",
  display_name: "Anna",
  required_daily_hours: 6.5,
  vacation_days_total_remaining: 1,
});

const AUDIT_LOG: AuditLogEntry = {
  id: 1,
  actor_user_id: 7,
  category: "projects",
  action: "project.status_changed",
  target_type: "project",
  target_id: "2026-0001",
  details: null,
  created_at: "2026-10-09T14:05:00Z",
};

const BACKUPS: BackupListResponse = {
  files: [
    {
      filename: "smpl-backup-2026-10-10T03-00-00Z.tar.enc",
      size_bytes: 3 * 1024 * 1024,
      created_at: "2026-10-10T03:00:00Z",
      is_generated: true,
    },
  ],
  free_bytes: 10 * 1024 ** 3,
  total_bytes: 20 * 1024 ** 3,
  passphrase_configured: true,
};

function page(overrides: Record<string, unknown>) {
  const value = makeAppContextStub({
    overrides: {
      mainView: "admin",
      activeAdminUsers: [],
      archivedAdminUsers: [],
      adminUsersById: new Map([[MAX.id, MAX], [ANNA.id, ANNA]]),
      userInitialsById: () => "MM",
      userHasAvatar: () => false,
      userAvatarVersionById: () => "0",
      userPermissionOverrides: {},
      requiredHoursDrafts: {},
      vacationBalanceDrafts: {},
      ...overrides,
    },
  });
  return (
    <AppContext.Provider value={value as never}>
      <AdminPage />
    </AppContext.Provider>
  );
}

beforeEach(() => {
  // jsdom has no Element.scrollTo; the strip falls back to scrollLeft, but a
  // spy keeps the fallback path out of these tests.
  (HTMLElement.prototype as unknown as { scrollTo: () => void }).scrollTo = vi.fn();
});

afterEach(() => {
  delete (HTMLElement.prototype as unknown as { scrollTo?: unknown }).scrollTo;
});

describe("Verwaltungszentrum tab strip", () => {
  it("is the scrolling strip, and a tap opens the tab it names", () => {
    render(page({ canManageUsers: true, canViewAudit: true, canManageBackups: true, activeAdminUsers: [MAX] }));
    const strip = screen.getByRole("tablist", { name: "Verwaltungsbereiche" });
    expect(strip).toHaveClass("admin-page-tabs");
    expect(within(strip).getAllByRole("tab").map((t) => t.textContent)).toEqual([
      "Benutzer",
      "Gruppen",
      "Protokoll",
      "Backups",
    ]);
    expect(screen.getByRole("tab", { name: "Benutzer" })).toHaveAttribute("aria-selected", "true");

    fireEvent.click(screen.getByRole("tab", { name: "Protokoll" }));
    expect(screen.getByRole("tab", { name: "Protokoll" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel", { name: "Protokoll" })).toBeInTheDocument();
  });

  it("marks the page as the admin centre the phone stylesheet is scoped to", () => {
    const { container } = render(page({ canManageUsers: true, activeAdminUsers: [MAX] }));
    expect(container.querySelector("section.admin-page")).toHaveClass("admin-center");
  });
});

describe("Benutzer cards", () => {
  function card(name: string): HTMLElement {
    return screen.getByRole("button", { name: new RegExp(name) });
  }

  function cell(row: HTMLElement, column: "hours" | "vacation"): HTMLElement {
    const found = row.querySelector<HTMLElement>(`.admin-users-col--${column}`);
    if (!found) throw new Error(`no ${column} cell`);
    return found;
  }

  it("says what each number is and in which unit", () => {
    render(page({ canManageUsers: true, activeAdminUsers: [MAX, ANNA] }));

    const max = card("Max Müller");
    const hours = cell(max, "hours");
    expect(within(hours).getByText("Arbeitszeit/Tag")).toHaveClass("admin-users-cell-label");
    expect(hours.querySelector(".admin-users-cell-value")).toHaveTextContent(/^8\s*h$/);

    const vacation = cell(max, "vacation");
    expect(within(vacation).getByText("Resturlaub")).toHaveClass("admin-users-cell-label");
    expect(vacation.querySelector(".admin-users-cell-value")).toHaveTextContent(/^12\.5\s*Tage$/);

    const anna = card("Anna Schmidt");
    expect(cell(anna, "hours").querySelector(".admin-users-cell-value")).toHaveTextContent(/^6\.5\s*h$/);
    expect(cell(anna, "vacation").querySelector(".admin-users-cell-value")).toHaveTextContent(/^1\s*Tag$/);
  });

  it("puts words on the invite and password actions", () => {
    render(page({ canManageUsers: true, activeAdminUsers: [MAX] }));
    const max = card("Max Müller");
    expect(within(max).getByRole("button", { name: "Einladung senden" })).toHaveClass("admin-users-action-icon");
    expect(within(max).getByRole("button", { name: "Passwort zurücksetzen" })).toHaveClass("admin-users-action-icon");
  });

  it("still sends the password reset from the labelled action", () => {
    const sendPasswordResetToUser = vi.fn();
    render(page({ canManageUsers: true, activeAdminUsers: [MAX], sendPasswordResetToUser }));
    fireEvent.click(within(card("Max Müller")).getByRole("button", { name: "Passwort zurücksetzen" }));
    expect(sendPasswordResetToUser).toHaveBeenCalledWith(MAX.id);
  });
});

describe("Protokoll rows", () => {
  it("label every value, so a row can stack into a card", () => {
    const { container } = render(page({ canViewAudit: true, auditLogs: [AUDIT_LOG] }));
    const row = container.querySelector<HTMLElement>(".admin-audit-row");
    if (!row) throw new Error("no audit row");

    const expected: [string, string | RegExp][] = [
      ["Zeitpunkt", /\d/],
      ["Kategorie", "Projekte"],
      ["Benutzer", "Max"],
      ["Aktion", "project.status_changed"],
      ["Ziel", "project · 2026-0001"],
    ];
    for (const [label, value] of expected) {
      const labelEl = within(row).getByText(label);
      expect(labelEl).toHaveClass("admin-audit-label");
      const field = labelEl.closest(".admin-audit-col, .admin-audit-field");
      expect(field, label).not.toBeNull();
      expect(field?.textContent?.replace(label, "")).toMatch(value);
    }
  });

  it("leaves the target out when the event has none", () => {
    const { container } = render(
      page({ canViewAudit: true, auditLogs: [{ ...AUDIT_LOG, target_type: null, target_id: null }] }),
    );
    const row = container.querySelector<HTMLElement>(".admin-audit-row");
    if (!row) throw new Error("no audit row");
    expect(within(row).queryByText("Ziel")).not.toBeInTheDocument();
  });
});

describe("Backups", () => {
  const backupsContext = {
    canManageBackups: true,
    canExportBackups: true,
    canRestoreBackups: true,
    backupsList: BACKUPS,
  };

  /** Export rights also show the System tab, which comes first. */
  function openBackups() {
    fireEvent.click(screen.getByRole("tab", { name: "Backups" }));
  }

  it("label every value of a backup row, so it can stack into a card", () => {
    const { container } = render(page(backupsContext));
    openBackups();
    const table = container.querySelector("table.admin-backups-table");
    expect(table).not.toBeNull();
    const row = table?.querySelector<HTMLElement>("tbody tr");
    if (!row) throw new Error("no backup row");
    for (const label of ["Datei", "Größe", "Erstellt", "Quelle"]) {
      expect(within(row).getByText(label)).toHaveClass("admin-backups-label");
    }
    expect(within(row).getByText(BACKUPS.files[0].filename)).toBeInTheDocument();
    expect(within(row).getByText("3.00 MB")).toBeInTheDocument();
  });

  it("keeps the backup table in a box of its own that can scroll sideways", () => {
    const { container } = render(page(backupsContext));
    openBackups();
    const table = container.querySelector("table.admin-backups-table");
    expect(table?.parentElement).toHaveClass("admin-backups-table-wrap");
    // The restore confirmation is position: fixed — it must not sit inside the wrapper.
    fireEvent.click(screen.getByRole("button", { name: "Wiederherstellen" }));
    expect(screen.getByRole("dialog").closest(".admin-backups-table-wrap")).toBeNull();
  });

  it("asks for the restore in a named dialog the phone layout can style", () => {
    render(page(backupsContext));
    openBackups();
    fireEvent.click(screen.getByRole("button", { name: "Wiederherstellen" }));
    const dialog = screen.getByRole("dialog", { name: "Wiederherstellung bestätigen" });
    expect(dialog).toHaveClass("admin-dialog");
    expect(within(dialog).getByRole("textbox", { name: "Dateiname zur Bestätigung" })).toHaveClass("admin-dialog-input");
    expect(within(dialog).getByRole("button", { name: "Wiederherstellen" })).toBeDisabled();
  });
});

describe("admin-mobile.css", () => {
  // Read per test, so a missing file fails these tests and not the whole file.
  const css = () => readSource("styles/admin-mobile.css");
  const phone = () => mediaBlock(css(), "(max-width: 767px)");

  it("is loaded by the admin page", () => {
    expect(readSource("pages/AdminPage.tsx")).toContain('import "../styles/admin-mobile.css";');
  });

  it("makes the tab strip its own sideways scroller at every width", () => {
    const strip = ruleBody(css(), ".admin-center .admin-page-tabs");
    expect(strip).toMatch(/max-width:\s*100%/);
    expect(strip).toMatch(/overflow-x:\s*auto/);
    expect(strip).toMatch(/flex-wrap:\s*nowrap/);
  });

  it("snaps the strip on a phone and gives each tab a thumb-sized target", () => {
    expect(ruleBody(phone(), ".admin-center .admin-page-tabs")).toMatch(/scroll-snap-type:\s*x/);
    expect(ruleBody(phone(), ".admin-center .admin-page-tabs .admin-page-tab")).toMatch(/min-height:\s*44px/);
  });

  it("makes the Protokoll card the width its rows answer to", () => {
    expect(ruleBody(topLevel(css()), ".admin-center .admin-audit-card")).toMatch(/container:\s*admin-audit\s*\/\s*inline-size/);
  });

  it("stacks the Protokoll when its card is narrow — on a phone and beside the sidebar", () => {
    const narrow = atBlock(css(), "@container admin-audit (max-width: 639px)");
    expect(ruleBody(narrow, ".admin-center .admin-audit-table-head")).toMatch(/display:\s*none/);
    expect(ruleBody(narrow, ".admin-center .admin-audit-row")).toMatch(/grid-template-columns:\s*minmax\(0,\s*1fr\)/);
    expect(ruleBody(narrow, ".admin-center .admin-audit-label")).toMatch(/display:\s*block/);
    // Not by the screen width any more: a 1024 px screen with the sidebar has a narrower card than a 768 px one without.
    expect(phone()).not.toMatch(/\.admin-audit-label/);
  });

  it("narrows the Protokoll's columns before it has to stack", () => {
    const compact = atBlock(css(), "@container admin-audit (max-width: 799px)");
    expect(ruleBody(compact, ".admin-center .admin-audit-table-head,\n  .admin-center .admin-audit-row")).toMatch(
      /grid-template-columns:\s*140px 110px 140px minmax\(0,\s*1fr\)/,
    );
    // The stacked block must come after it, or the narrower columns would win on a phone.
    expect(css().indexOf("@container admin-audit (max-width: 639px)")).toBeGreaterThan(
      css().indexOf("@container admin-audit (max-width: 799px)"),
    );
  });

  it("lets the backup table scroll inside its card, and makes the list the width its rows answer to", () => {
    const wrap = ruleBody(topLevel(css()), ".admin-backups-table-wrap");
    expect(wrap).toMatch(/container:\s*admin-backups\s*\/\s*inline-size/);
    expect(wrap).toMatch(/max-width:\s*100%/);
    expect(wrap).toMatch(/overflow-x:\s*auto/);
  });

  it("stacks the backup rows when the list is narrow — on a phone and beside the sidebar", () => {
    const narrow = atBlock(css(), "@container admin-backups (max-width: 519px)");
    expect(ruleBody(narrow, ".admin-backups-table thead")).toMatch(/display:\s*none/);
    expect(ruleBody(narrow, ".admin-backups-label")).toMatch(/display:\s*block/);
    expect(ruleBody(narrow, ".admin-backups-filename,\n  .admin-backups-value")).toMatch(/overflow-wrap:\s*anywhere/);
    // Hidden unless stacked, at every width; no longer by the screen's width.
    expect(ruleBody(topLevel(css()), ".admin-backups-label")).toMatch(/display:\s*none/);
    expect(phone()).not.toMatch(/\.admin-backups-table thead/);
    expect(mediaBlock(css(), "(min-width: 768px)")).not.toMatch(/\.admin-backups-label/);
  });

  it("keeps text fields at 16 px on a phone so iOS does not zoom", () => {
    expect(phone()).toMatch(/\.admin-center input:not\(\[type="checkbox"\]\):not\(\[type="radio"\]\)[^{]*\{[^}]*font-size:\s*16px/);
  });

  it("keeps select menus and text areas at 16 px on a phone, over the 13 px of `.admin-page .admin-…-select`", () => {
    // `.admin-center select` (0,1,1) lost to `.admin-page .admin-users-select`,
    // `.admin-page .admin-invite-input` and `.admin-page .admin-audit-select`
    // (0,2,0, 13 px) in styles.css. `.admin-page.admin-center select` is 0,2,1.
    expect(phone()).toMatch(/\.admin-page\.admin-center select[,\s][^{]*\{[^}]*font-size:\s*16px/);
    expect(phone()).toMatch(/\.admin-page\.admin-center textarea[,\s][^{]*\{[^}]*font-size:\s*16px/);
  });

  it("hides the phone-only labels on wider screens", () => {
    const wide = mediaBlock(css(), "(min-width: 768px)");
    expect(wide).toMatch(/\.admin-center \.admin-users-cell-label[^{]*\{[^}]*display:\s*none/);
    // The Protokoll's labels follow its card: hidden unless the card is narrow.
    expect(ruleBody(topLevel(css()), ".admin-center .admin-audit-label")).toMatch(/display:\s*none/);
  });
});
