import type { Language, RolePermissionsMeta } from "../types";

/**
 * What the admin centre prints for a permission, in the UI's language.
 *
 * GET /admin/role-permissions sends the labels in German (the product's
 * language) under the plain names and the English twins under `*_en`. A
 * server from before the twins existed sends only the plain set, which is
 * then used in both languages; a permission with no label at all shows its
 * key rather than an empty row.
 */
type PermissionGroup = RolePermissionsMeta["permission_groups"][number];

export function permissionLabel(meta: RolePermissionsMeta, perm: string, language: Language): string {
  const english = language === "en" ? meta.permission_labels_en?.[perm] : undefined;
  return english ?? meta.permission_labels[perm] ?? perm;
}

/** "" when the permission has no description — the tooltip then stays closed. */
export function permissionDescription(meta: RolePermissionsMeta, perm: string, language: Language): string {
  const english = language === "en" ? meta.permission_descriptions_en?.[perm] : undefined;
  return english ?? meta.permission_descriptions[perm] ?? "";
}

export function permissionGroupLabel(group: PermissionGroup, language: Language): string {
  return (language === "en" ? group.label_en : undefined) ?? group.label;
}
