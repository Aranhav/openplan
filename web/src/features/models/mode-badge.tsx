import { Badge } from "@/components/ui/badge"
import type { components } from "@/lib/api/schema"

export function ModeBadge({ mode }: { mode: components["schemas"]["ModelMode"] }) {
  return mode === "prod" ? <Badge>Production</Badge> : <Badge variant="secondary">Dev</Badge>
}
