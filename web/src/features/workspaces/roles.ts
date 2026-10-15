import type { components } from "@/lib/api/schema"

export type WorkspaceRole = components["schemas"]["WorkspaceRole"]

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
