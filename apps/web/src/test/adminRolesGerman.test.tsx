/**
 * The Rollen matrix of the Verwaltungszentrum reads German.
 *
 * Found on a screenshot pass of v2.14.40: every row said "Manage users",
 * "View projects", … — the API's English labels, shown verbatim. The API now
 * sends German labels with English twins, and the page picks by language;
 * the role heads come from the one shared role map ("Geschäftsführung", not
 * "CEO"), and a cell's accessible name says whether the role HAS the grant
 * rather than "Enabled".
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";

import { AppContext } from "../context/AppContext";
import { makeAppContextStub } from "./appContextStub";
import { AdminPage } from "../pages/AdminPage";
import type { RolePermissionsMeta } from "../types";

const META: RolePermissionsMeta = {
  permissions: { admin: ["users:manage", "projects:view"], ceo: ["projects:view"] },
  all_permissions: ["projects:view", "users:manage"],
  permission_labels: { "users:manage": "Benutzer verwalten", "projects:view": "Projekte ansehen" },
  permission_descriptions: { "users:manage": "Benutzer anlegen …", "projects:view": "Die Projektliste …" },
  permission_labels_en: { "users:manage": "Manage users", "projects:view": "View projects" },
  permission_descriptions_en: { "users:manage": "Create …", "projects:view": "Browse …" },
  permission_groups: [
    { key: "users", label: "Benutzer", label_en: "Users", permissions: ["users:manage"] },
    { key: "projects", label: "Projekte", label_en: "Projects", permissions: ["projects:view"] },
  ],
  all_roles: ["admin", "ceo"],
};

function renderRoles(language: "de" | "en") {
  const value = makeAppContextStub({
    overrides: { mainView: "admin", language, canManagePermissions: true, rolePermissionsMeta: META },
  });
  return render(
    <AppContext.Provider value={value as never}>
      <AdminPage />
    </AppContext.Provider>,
  );
}

beforeEach(() => {
  (HTMLElement.prototype as unknown as { scrollTo: () => void }).scrollTo = vi.fn();
});

describe("Rollen matrix", () => {
  it("labels permissions and roles in German", () => {
    const { container } = renderRoles("de");
    const rows = [...container.querySelectorAll(".admin-roles-perm-label")].map((node) => node.textContent);
    expect(rows).toEqual(["Benutzer verwalten", "Projekte ansehen"]);
    const heads = [...container.querySelectorAll(".admin-roles-head--role")].map((node) => node.textContent);
    expect(heads[0]).toContain("Admin");
    expect(heads[1]).toContain("Geschäftsführung");
    expect(container.textContent).not.toMatch(/Manage users|View projects/);
  });

  it("says in German whether a role has the grant", () => {
    const { container } = renderRoles("de");
    const usersRow = [...container.querySelectorAll<HTMLElement>(".admin-roles-row")][0];
    const cells = within(usersRow).getAllByRole("button");
    // users:manage — the admin has it, the Geschäftsführung does not.
    expect(cells.map((cell) => cell.getAttribute("aria-label"))).toEqual(["Erteilt", "Nicht erteilt"]);
  });

  it("keeps the English twins in the English UI", () => {
    renderRoles("en");
    expect(screen.getByText("Manage users")).toBeInTheDocument();
    expect(screen.getByText("CEO")).toBeInTheDocument();
  });
});
