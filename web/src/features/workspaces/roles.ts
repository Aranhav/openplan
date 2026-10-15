import type { components } from "@/lib/api/schema"

export type WorkspaceRole = components["schemas"]["WorkspaceRole"]

export const roleLabels: Record<WorkspaceRole, string> = {
  viewer: "Viewer",
  planner: "Planner",
  builder: "Builder",
  admin: "Admin",
}
