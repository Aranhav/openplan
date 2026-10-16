import { CalendarRange, GitBranch, Grid3x3, type LucideIcon, Settings } from "lucide-react"

/** The addresses of the model's own pages, which take no parameter besides the model. */
type BuildPath =
  | "/m/$modelId/time"
  | "/m/$modelId/versions"
  | "/m/$modelId/modules"
  | "/m/$modelId/settings"

export interface BuildPage {
  label: string
  icon: LucideIcon
  to: BuildPath
  /** The page opens into the modules of the model, which the sidebar lists beneath it. */
  withModules?: boolean
}

export interface BuildGroup {
  label: string
  pages: BuildPage[]
}

/**
 * The model's navigation, in order, for the sidebar and the command palette. A screen that
 * arrives later (lists) is one more entry here.
 */
export const BUILD_GROUPS: BuildGroup[] = [
  {
    label: "Structure",
    pages: [
      { label: "Time", icon: CalendarRange, to: "/m/$modelId/time" },
      { label: "Versions", icon: GitBranch, to: "/m/$modelId/versions" },
      { label: "Modules", icon: Grid3x3, to: "/m/$modelId/modules", withModules: true },
    ],
  },
  {
    label: "Model",
    pages: [{ label: "Model settings", icon: Settings, to: "/m/$modelId/settings" }],
  },
]
