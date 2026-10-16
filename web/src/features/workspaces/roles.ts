import type { components } from "@/lib/api/schema"

export type WorkspaceRole = components["schemas"]["WorkspaceRole"]

/** Most privileged first, the order roles are offered in. */
export const roleOptions: readonly WorkspaceRole[] = ["admin", "builder", "planner", "viewer"]

export const roleLabels: Record<WorkspaceRole, string> = {
  viewer: "Viewer",
  planner: "Planner",
  builder: "Builder",
  admin: "Admin",
}

/** Builders and admins can create, change and delete models; planners and viewers only read them. */
export function canEditModels(role: WorkspaceRole): boolean {
  return role === "builder" || role === "admin"
}

/** Planners, builders and admins enter values in a model's cells; viewers only read them. */
export function canEditCells(role: WorkspaceRole): boolean {
  return role !== "viewer"
}

/** Admins manage a workspace's members. */
export function canManageMembers(role: WorkspaceRole): boolean {
  return role === "admin"
}
