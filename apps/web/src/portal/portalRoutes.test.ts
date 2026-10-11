/**
 * The partner portal's URLs.
 *
 * What must hold: every screen has one German path and reading it back gives
 * the same screen; the links in the office's emails (/partner/einladung and
 * /partner/passwort with ?token=) open the set-password screen with the
 * token; unknown or malformed paths fall back to the task list; an id must
 * be a positive whole number.
 */
import { describe, expect, it } from "vitest";
import { parsePortalRoute, portalPath, type PortalRoute } from "./portalRoutes";

describe("portal routes", () => {
  it("round-trips every screen", () => {
    const routes: PortalRoute[] = [
      { name: "tasks", scope: "open" },
      { name: "tasks", scope: "done" },
      { name: "task", id: 12 },
      { name: "projects", scope: "open" },
      { name: "projects", scope: "done" },
      { name: "project", id: 5 },
      { name: "account" },
    ];
    for (const route of routes) {
      const url = new URL(portalPath(route), "https://smpl.example");
      expect(parsePortalRoute(url.pathname, url.search)).toEqual(route);
    }
    expect(portalPath({ name: "tasks", scope: "open" })).toBe("/partner");
    expect(portalPath({ name: "task", id: 12 })).toBe("/partner/aufgaben/12");
    expect(portalPath({ name: "projects", scope: "done" })).toBe("/partner/projekte?ansicht=abgeschlossen");
  });

  it("opens the set-password screen from the office's emails", () => {
    expect(parsePortalRoute("/partner/einladung", "?token=abc-DEF_1")).toEqual({ name: "invite", token: "abc-DEF_1" });
    expect(parsePortalRoute("/partner/passwort", "?token=xyz")).toEqual({ name: "reset", token: "xyz" });
    expect(parsePortalRoute("/partner/einladung", "")).toEqual({ name: "invite", token: "" });
  });

  it("falls back to the task list for anything it does not know", () => {
    for (const [path, search] of [["/partner/irgendwas", ""], ["/partner/aufgaben/abc", ""], ["/partner/aufgaben/-3", ""], ["/partner/projekte/0", ""], ["/", ""]]) {
      expect(parsePortalRoute(path, search)).toEqual({ name: "tasks", scope: "open" });
    }
    expect(parsePortalRoute("/partner/", "")).toEqual({ name: "tasks", scope: "open" });
  });
});
