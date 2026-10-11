/**
 * Which app boots: the office app or the partner portal.
 *
 * What must hold: any /partner URL opens the portal (its login, invite and
 * password pages included); a stored session of a partner login opens the
 * portal wherever the browser lands; everything else is the office app; a
 * malformed or foreign token never crashes the choice and never picks the
 * portal on its own.
 */
import { describe, expect, it } from "vitest";
import { chooseShell, roleFromToken } from "./shellChoice";

function jwt(payload: Record<string, unknown>): string {
  const encode = (value: object) =>
    btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${encode({ alg: "HS256", typ: "JWT" })}.${encode(payload)}.signature`;
}

describe("roleFromToken", () => {
  it("reads the role claim and survives anything else", () => {
    expect(roleFromToken(jwt({ sub: "2", role: "external" }))).toBe("external");
    expect(roleFromToken(jwt({ sub: "1", role: "admin" }))).toBe("admin");
    expect(roleFromToken(jwt({ sub: "1" }))).toBeNull();
    expect(roleFromToken("not-a-token")).toBeNull();
    expect(roleFromToken("a.%%%.c")).toBeNull();
    expect(roleFromToken(null)).toBeNull();
  });
});

describe("chooseShell", () => {
  const partner = jwt({ sub: "2", role: "external" });
  const staff = jwt({ sub: "1", role: "employee" });

  it("opens the portal on its own URLs", () => {
    for (const path of ["/partner", "/partner/", "/partner/einladung", "/partner/aufgaben/12", "/partner/passwort"]) {
      expect(chooseShell(path, null)).toBe("portal");
      expect(chooseShell(path, staff)).toBe("portal");
    }
    expect(chooseShell("/partnerschaft", null)).toBe("app");
  });

  it("opens the portal for a partner session anywhere, the office app otherwise", () => {
    expect(chooseShell("/", partner)).toBe("portal");
    expect(chooseShell("/projects", partner)).toBe("portal");
    expect(chooseShell("/", staff)).toBe("app");
    expect(chooseShell("/", null)).toBe("app");
    expect(chooseShell("/invite", null)).toBe("app");
  });
});
