import type { LucideIcon } from "lucide-react"
import type { ReactNode } from "react"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"

interface EmptyStateProps {
  icon: LucideIcon
  title: string
  description: string
  action?: ReactNode
  /** The title is a heading: 1 when the state is the whole page, 2 below a `PageHeader`, 3 inside a titled card. */
  headingLevel?: 1 | 2 | 3
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  headingLevel = 2,
}: EmptyStateProps) {
  return (
    <Empty className="border">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Icon />
        </EmptyMedia>
        <EmptyTitle role="heading" aria-level={headingLevel}>
          {title}
        </EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
      {action && <EmptyContent>{action}</EmptyContent>}
    </Empty>
  )
}
