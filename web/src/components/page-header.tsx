import { type ReactNode, type RefCallback, useCallback, useContext } from "react"
import { useDocumentTitle } from "@/hooks/use-document-title"
import { HeadingContext } from "@/lib/heading-focus"

interface PageHeaderProps {
  title: string
  description?: ReactNode
  actions?: ReactNode
  /**
   * Draws the title itself when it is more than text, such as one that renames in place. It is
   * given the class of the page's `h1` and the ref to put on it, which is how code that has to
   * put focus on the heading finds it, and must render the `h1`; `title` is still the tab's.
   */
  renderTitle?: (headingClassName: string, headingRef: RefCallback<HTMLHeadingElement>) => ReactNode
}

const HEADING_CLASS = "text-2xl font-semibold tracking-tight break-words outline-none"

export function PageHeader({ title, description, actions, renderTitle }: PageHeaderProps) {
  useDocumentTitle(`${title} · OpenPlan`)
  const target = useContext(HeadingContext)
  // The same function between renders, or the heading would be handed over again each time.
  const keepHeading = useCallback(
    (element: HTMLHeadingElement | null) => {
      target?.set(element)
      return () => {
        if (target?.get() === element) {
          target.set(null)
        }
      }
    },
    [target],
  )
  return (
    <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
      <div className="flex min-w-0 flex-col gap-1">
        {renderTitle ? (
          renderTitle(HEADING_CLASS, keepHeading)
        ) : (
          <h1
            tabIndex={-1}
            className={HEADING_CLASS}
            ref={keepHeading}
          >
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
