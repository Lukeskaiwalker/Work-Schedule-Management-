/**
 * Which projects a crate can be packed for, and how a crate names its site.
 *
 * The handover books its checkout under the crate's project, which is what
 * puts the material under "Auf der Baustelle" for that site. So the list must
 * hold exactly the chosen customer's open jobs — the server refuses another
 * customer's project, and an archived job is no longer a site anybody drives to.
 */
import { describe, expect, it } from "vitest";

import { boxProjectLabel, openProjectsForCustomer, soleOpenProjectId } from "../utils/boxes";
import { seesEveryProject } from "../utils/projects";
import type { Project } from "../types";

function project(id: number, customerId: number | null, status = "In Durchführung"): Project {
  return { id, project_number: String(id), name: `Projekt ${id}`, status, customer_id: customerId };
}

const PROJECTS: Project[] = [
  project(1, 210),
  project(2, 210, "Archiviert"),
  project(3, 210, "Angebot"),
  project(4, 5),
  project(5, 5, "archived"),
  // A legacy job with only a free-text customer: never offered, it is nobody's in particular.
  project(6, null),
];

describe("openProjectsForCustomer", () => {
  it("lists the customer's open projects only", () => {
    expect(openProjectsForCustomer(PROJECTS, 210).map((row) => row.id)).toEqual([1, 3]);
  });

  it("lists nothing while no customer is chosen", () => {
    expect(openProjectsForCustomer(PROJECTS, null)).toEqual([]);
  });
});

describe("soleOpenProjectId", () => {
  it("names the one open project of a customer who has exactly one", () => {
    expect(soleOpenProjectId(PROJECTS, 5)).toBe(4);
  });

  it("names none when there is a choice to make, nothing to choose, or no customer", () => {
    expect(soleOpenProjectId(PROJECTS, 210)).toBeNull();
    expect(soleOpenProjectId(PROJECTS, 99)).toBeNull();
    expect(soleOpenProjectId(PROJECTS, null)).toBeNull();
  });
});

describe("boxProjectLabel", () => {
  it("prefers number and name from the project list", () => {
    expect(boxProjectLabel({ project_id: 1, project_name: "Alt" }, PROJECTS)).toBe("1 · Projekt 1");
  });

  it("falls back to the crate's own project name", () => {
    expect(boxProjectLabel({ project_id: 77, project_name: "Wallbox Garage" }, PROJECTS)).toBe("Wallbox Garage");
  });

  it("is empty for a crate without a project", () => {
    expect(boxProjectLabel({ project_id: null, project_name: null }, PROJECTS)).toBe("");
  });
});

// GET /projects is the only project list the web has, and for an employee it
// holds their own jobs only (list_projects → has_global_project_access). A
// customer's "only open job" judged from that slice may be one of several.
describe("seesEveryProject", () => {
  it("is true with projects:manage, whatever the role", () => {
    expect(seesEveryProject({ role: "employee", effective_permissions: ["projects:manage"] })).toBe(true);
    expect(seesEveryProject({ role: "admin", effective_permissions: ["projects:manage"] })).toBe(true);
  });

  it("is true for an office role with projects:view", () => {
    expect(seesEveryProject({ role: "planning", effective_permissions: ["projects:view"] })).toBe(true);
  });

  it("is false for an employee with projects:view only", () => {
    expect(seesEveryProject({ role: "employee", effective_permissions: ["projects:view"] })).toBe(false);
  });

  it("is false without either permission, without a user, or when the permissions are unknown", () => {
    expect(seesEveryProject({ role: "admin", effective_permissions: [] })).toBe(false);
    expect(seesEveryProject({ role: "admin" })).toBe(false);
    expect(seesEveryProject(null)).toBe(false);
  });
});
