import type { ReactNode } from "react"
import { useDocumentTitle } from "@/hooks/use-document-title"

interface PageHeaderProps {
  title: string
  description?: ReactNode
  actions?: ReactNode
  /**
   * Draws the title itself when it is more than text, such as one that renames in place. It is
   * given the class of the page's `h1`, and must render the `h1`; `title` is still the tab's.
   */
  renderTitle?: (headingClassName: string) => ReactNode
}

const HEADING_CLASS = "text-2xl font-semibold tracking-tight break-words outline-none"

export function PageHeader({ title, description, actions, renderTitle }: PageHeaderProps) {
  useDocumentTitle(`${title} · OpenPlan`)
  return (
    <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
      <div className="flex min-w-0 flex-col gap-1">
        {renderTitle ? (
          renderTitle(HEADING_CLASS)
        ) : (
          <h1 tabIndex={-1} className={HEADING_CLASS}>
            {title}
          </h1>
        )}
        {description && (
          <div className="text-sm break-words text-muted-foreground">{description}</div>
        )}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  )
}
