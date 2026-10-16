import { Ellipsis, Eye, Filter, Paintbrush, Sigma } from "lucide-react"
import { type RefObject, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Separator } from "@/components/ui/separator"
import { Toggle } from "@/components/ui/toggle"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import type { ModuleDto, StructureDto } from "@/features/structure/types"
import type { GridReference } from "../edit-reference"
import type { PageMember, SavedView, ViewDefinition } from "../view-types"
import { ConditionalFormatSheet } from "./conditional-format-sheet"
import { FilterPopover } from "./filter-popover"
import { PageSelectors } from "./page-selectors"
import { PivotPopover } from "./pivot-popover"
import { SavedViews } from "./saved-views"
import { ShowHidePopover } from "./show-hide-popover"
import { useToolbarFit } from "./use-toolbar-fit"
import type { ViewAction } from "./view-state"

type Panel = "pivot" | "filter" | "show-hide"

interface GridToolbarProps {
  modelId: string
  module: ModuleDto
  structure: StructureDto
  /** The view as it is now. */
  view: ViewDefinition
  dispatch: (action: ViewAction) => void
  reference: GridReference
  /** The members the pages show, as the grid's first block says. */
  shown: readonly PageMember[] | undefined
  views: readonly SavedView[]
  /** The saved views could not be read. */
  viewsFailed?: { retry: () => void }
  /** The view in use, or nothing for the module's own default pivot. */
  saved: SavedView | undefined
  modified: boolean
  canSaveViews: boolean
  onSelectView: (viewId: string | undefined, options?: { replace?: boolean }) => void
  onDiscard: () => void
  onDeletingView: (viewId: string, deleting: boolean) => void
}

/**
 * The controls of the grid in one row: the pivot, a selector for each page, filter, show/hide,
 * summaries, conditional formatting and the saved views. When the row is too narrow for them
 * the last four go into a More menu, which opens the same panels.
 */
export function GridToolbar({
  modelId,
  module,
  structure,
  view,
  dispatch,
  reference,
  shown,
  views,
  viewsFailed,
  saved,
  modified,
  canSaveViews,
  onSelectView,
  onDiscard,
  onDeletingView,
}: GridToolbarProps) {
  const row = useRef<HTMLDivElement>(null)
  const pages = useRef<HTMLDivElement>(null)
  const more = useRef<HTMLButtonElement>(null)
  const format = useRef<HTMLButtonElement>(null)
  const compact = useToolbarFit(row, pages)
  const [panel, setPanel] = useState<Panel>()
  const [formatting, setFormatting] = useState(false)
  // The More menu hands focus to what it opens; it takes it back only when it opens nothing.
  const opened = useRef(false)
  const summaries = view.show_summaries ?? true

  const panelProps = (name: Panel) => ({
    open: panel === name,
    onOpenChange: (open: boolean) => setPanel(open ? name : undefined),
  })
  const open = (name: Panel) => {
    opened.current = true
    setPanel(name)
  }
  const anchor: RefObject<HTMLElement | null> | undefined = compact ? more : undefined

  return (
    <TooltipProvider>
      <div
        ref={row}
        role="group"
        aria-label="Grid controls"
        className="flex h-9 items-center gap-1"
      >
        <PivotPopover
          {...panelProps("pivot")}
          module={module}
          structure={structure}
          view={view}
          dispatch={dispatch}
        />
        <Separator orientation="vertical" className="mx-0.5 h-5" />
        {/* The padding leaves room for the focus rings, which a scrolling box would cut off. */}
        <div
          ref={pages}
          className="-mx-1 -my-1 flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto px-1 py-1 [scrollbar-width:thin]"
        >
          <PageSelectors
            modelId={modelId}
            module={module}
            structure={structure}
            view={view}
            shown={shown}
            dispatch={dispatch}
          />
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <FilterPopover
            {...panelProps("filter")}
            anchor={anchor}
            module={module}
            structure={structure}
            view={view}
            reference={reference}
            dispatch={dispatch}
          />
          <ShowHidePopover
            {...panelProps("show-hide")}
            anchor={anchor}
            modelId={modelId}
            module={module}
            structure={structure}
            view={view}
            dispatch={dispatch}
          />
          {compact ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button ref={more} variant="ghost" size="sm" className="gap-1.5 px-2">
                  <Ellipsis />
                  More
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="end"
                onCloseAutoFocus={(event) => {
                  if (opened.current) {
                    event.preventDefault()
                    opened.current = false
                  }
                }}
              >
                <DropdownMenuItem onSelect={() => open("filter")}>
                  <Filter />
                  Filter…
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => open("show-hide")}>
                  <Eye />
                  Show/hide…
                </DropdownMenuItem>
                <DropdownMenuCheckboxItem
                  checked={summaries}
                  onCheckedChange={() => dispatch({ type: "toggle_summaries" })}
                >
                  Summaries
                </DropdownMenuCheckboxItem>
                <DropdownMenuItem
                  onSelect={() => {
                    opened.current = true
                    setFormatting(true)
                  }}
                >
                  <Paintbrush />
                  Conditional formatting…
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : (
            <>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Toggle
                    size="sm"
                    pressed={summaries}
                    onPressedChange={() => dispatch({ type: "toggle_summaries" })}
                    aria-label="Summaries"
                    className="size-8 min-w-8 px-0"
                  >
                    <Sigma />
                  </Toggle>
                </TooltipTrigger>
                <TooltipContent>Summaries</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    ref={format}
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Conditional formatting"
                    onClick={() => setFormatting(true)}
                  >
                    <Paintbrush />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Conditional formatting</TooltipContent>
              </Tooltip>
            </>
          )}
        </div>
        <Separator orientation="vertical" className="mx-0.5 h-5" />
        <SavedViews
          modelId={modelId}
          moduleId={module.id}
          views={views}
          failed={viewsFailed}
          saved={saved}
          current={view}
          modified={modified}
          canSave={canSaveViews}
          onSelect={onSelectView}
          onDiscard={onDiscard}
          onDeleting={onDeletingView}
        />
      </div>
      <ConditionalFormatSheet
        open={formatting}
        onOpenChange={setFormatting}
        module={module}
        structure={structure}
        view={view}
        dispatch={dispatch}
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          ;(compact ? more : format).current?.focus()
        }}
      />
    </TooltipProvider>
  )
}
