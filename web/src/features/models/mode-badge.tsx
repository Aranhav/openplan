import { Badge } from "@/components/ui/badge"
import type { components } from "@/lib/api/schema"

interface ModeBadgeProps {
  mode: components["schemas"]["ModelMode"]
  /** Spoken as "Mode: Dev"; turn off where a visible "Mode" label already comes first. */
  announceMode?: boolean
}

export function ModeBadge({ mode, announceMode = true }: ModeBadgeProps) {
  const label = mode === "prod" ? "Production" : "Dev"
  return (
    <Badge variant={mode === "prod" ? "default" : "secondary"}>
      {announceMode && <span className="sr-only">Mode: </span>}
      {label}
    </Badge>
  )
}
