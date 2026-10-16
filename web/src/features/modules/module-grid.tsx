import { Rows3 } from "lucide-react"
import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from "react"
import { toast } from "sonner"
import { EmptyState } from "@/components/empty-state"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { Grid, GridSkeleton } from "@/features/grid/grid"
import { GridToolbar } from "@/features/grid/toolbar/grid-toolbar"
import { cornerLabel } from "@/features/grid/toolbar/dim-labels"
import { DEFAULT_VIEW_KEY, clearDraft, readDraft, writeDraft } from "@/features/grid/toolbar/view-draft"
import {
  type ViewAction,
  isModified,
  queryOf,
  reduceView,
} from "@/features/grid/toolbar/view-state"
import { useRowInfo } from "@/features/grid/toolbar/use-row-info"
import { useSavedViews } from "@/features/grid/toolbar/views-api"
import { useViewPages } from "@/features/grid/use-view-data"
import type { GridQuery, MemberRef, SavedView, ViewDefinition } from "@/features/grid/view-types"
import { lineItemsOf } from "@/features/structure/modules"
import type { ModuleDto, StructureDto } from "@/features/structure/types"
import { useFillViewport } from "@/hooks/use-fill-viewport"
import { defaultView } from "./default-view"
import { FormulaBar } from "./formula-bar"
import { gridReference } from "./grid-reference"

/** The least the grid is tall, and the padding the page keeps below it, in pixels. */
const MIN_HEIGHT = 384
const PAGE_PADDING = 24

interface ModuleGridProps {
  modelId: string
  module: ModuleDto
  structure: StructureDto
  /** The user may not enter values (a viewer): copying still works. */
  readOnly: boolean
  /** The user may change formulas (a builder or admin). */
  canEditFormulas: boolean
  /** The user may save views and make one the default (a builder or admin). */
  canSaveViews: boolean
  /** Production mode switches changing formulas off. */
  locked: boolean
  /** The saved view in the address; none is the module's default view. */
  viewId: string | undefined
  /** Goes to another view, or to the default one. */
  onViewChange: (viewId: string | undefined, options?: { replace?: boolean }) => void
  /** Goes to the Blueprint, where the line items are added. */
  onOpenBlueprint: () => void
}

/**
 * The module's values, in the grid, laid out as a saved view: the one in the address, else the
 * module's default view, else the default pivot. Changes made on screen stay with the browser
 * session until they are saved.
 */
export function ModuleGrid({
  modelId,
  module,
  structure,
  readOnly,
  canEditFormulas,
  canSaveViews,
  locked,
  viewId,
  onViewChange,
  onOpenBlueprint,
}: ModuleGridProps) {
  const views = useSavedViews(modelId, module.id)
  const list = useMemo(() => views.data ?? [], [views.data])
  // Views this screen deletes, which are not views that went missing.
  const [deleting] = useState(() => new Set<string>())

  const requested = viewId === undefined ? undefined : list.find((view) => view.id === viewId)
  const saved = requested ?? list.find((view) => view.is_default)
  const missing =
    viewId !== undefined && views.isSuccess && requested === undefined && !deleting.has(viewId)

  // The address names a view that is not there (deleted, or a link to another module's): the
  // default view is shown and the address cleaned up, once.
  const leaveMissing = useEffectEvent(() => {
    toast.error("That view no longer exists. Showing the default view instead.")
    onViewChange(undefined, { replace: true })
  })
  useEffect(() => {
    if (missing) {
      leaveMissing()
    }
  }, [missing])

  // Changes that were not saved are given up when another view is chosen, however it was chosen.
  const key = views.isPending ? undefined : (saved?.id ?? DEFAULT_VIEW_KEY)
  const previous = useRef(key)
  useEffect(() => {
    if (key !== undefined && previous.current !== undefined && previous.current !== key) {
      clearDraft(module.id, previous.current)
    }
    previous.current = key
  }, [module.id, key])

  const lineItems = lineItemsOf(structure, module.id)
  if (lineItems.length === 0) {
    return (
      <EmptyState
        icon={Rows3}
        title="No line items yet"
        description="Add line items in the Blueprint, and their values appear here."
        action={<Button onClick={onOpenBlueprint}>Open Blueprint</Button>}
      />
    )
  }
  if (key === undefined) {
    return <ModuleGridSkeleton />
  }
  return (
    <ViewSession
      key={key}
      modelId={modelId}
      module={module}
      structure={structure}
      views={list}
      viewsFailed={views.isError ? { retry: () => void views.refetch() } : undefined}
      saved={saved}
      readOnly={readOnly}
      canEditFormulas={canEditFormulas}
      canSaveViews={canSaveViews}
      locked={locked}
      onViewChange={onViewChange}
      onDeletingView={(id) => deleting.add(id)}
    />
  )
}

function ModuleGridSkeleton() {
  return (
    <div className="flex flex-col gap-3">
      <Skeleton className="h-9 w-full" />
      <div className="h-96">
        <GridSkeleton />
      </div>
    </div>
  )
}

interface ViewSessionProps extends Omit<ModuleGridProps, "viewId" | "onOpenBlueprint"> {
  views: SavedView[]
  viewsFailed?: { retry: () => void }
  /** The view in use, or nothing for the module's own default pivot. */
  saved: SavedView | undefined
  onDeletingView: (viewId: string) => void
}

/**
 * One view of the module on screen. It starts from the changes the browser session kept for the
 * view, else from the view as it was saved; a view that is chosen instead gets a session of its own.
 */
function ViewSession({
  modelId,
  module,
  structure,
  views,
  viewsFailed,
  saved,
  readOnly,
  canEditFormulas,
  canSaveViews,
  locked,
  onViewChange,
  onDeletingView,
}: ViewSessionProps) {
  const { ref, height } = useFillViewport(MIN_HEIGHT, PAGE_PADDING)
  // The line item of the active cell is the one whose formula the bar shows.
  const [activeId, setActiveId] = useState<string>()

  const savedDefinition = useMemo<ViewDefinition>(
    () => saved?.definition ?? defaultView(module),
    [saved, module],
  )
  const viewKey = saved?.id ?? DEFAULT_VIEW_KEY
  // What the user changed on screen, or nothing while the view is as saved (and so follows it).
  const [edits, setEdits] = useState(() => readDraft(module, viewKey))
  const current = edits ?? savedDefinition
  const modified = edits !== undefined && isModified(edits, savedDefinition)

  const dispatch = useCallback(
    (action: ViewAction) => setEdits((before) => reduceView(before ?? savedDefinition, action)),
    [savedDefinition],
  )
  const discard = useCallback(() => setEdits(undefined), [])

  useEffect(() => {
    if (edits !== undefined && modified) {
      writeDraft(module.id, viewKey, edits)
    } else {
      clearDraft(module.id, viewKey)
    }
  }, [module.id, viewKey, edits, modified])

  // A view that was cut down to what the module still has says so, once.
  useEffect(() => {
    if (saved?.pruned) {
      toast.info("Some of this view's settings no longer apply to the module. Save the view to keep it as shown.", {
        id: `pruned-${saved.id}`,
      })
    }
  }, [saved])

  // The query is the same object until what it asks for changes: not for a width or a format.
  const queryJson = JSON.stringify(queryOf(module.id, current))
  const query = useMemo(() => JSON.parse(queryJson) as GridQuery, [queryJson])
  const { lists, calendar, month_labels } = structure
  const reference = useMemo(
    () => gridReference({ lists, calendar, month_labels }),
    [lists, calendar, month_labels],
  )
  const lineItems = lineItemsOf(structure, module.id)
  const rowInfo = useRowInfo(
    modelId,
    module.id,
    current.rows,
    current.show_summaries ?? true,
    lineItems.map((item) => item.name),
  )
  const pages = useViewPages(modelId, query)
  const corner = cornerLabel(current, module, structure)

  const toggleCollapse = useCallback(
    (member: MemberRef) => dispatch({ type: "toggle_collapse", member }),
    [dispatch],
  )
  const changeWidths = useCallback(
    (widths: Record<string, number>) => dispatch({ type: "set_column_widths", widths }),
    [dispatch],
  )
  const reset = useCallback(
    () => dispatch({ type: "replace", definition: defaultView(module) }),
    [dispatch, module],
  )

  // The first read of how the row headers nest holds the grid back, so that nothing moves as the
  // blocks arrive; later ones (another dimension on the rows) do not blank a grid on screen.
  const [ready, setReady] = useState(false)
  if (rowInfo.settled && !ready) {
    setReady(true)
  }

  return (
    <div className="flex flex-col gap-2">
      <GridToolbar
        modelId={modelId}
        module={module}
        structure={structure}
        view={current}
        dispatch={dispatch}
        reference={reference}
        shown={pages}
        views={views}
        viewsFailed={viewsFailed}
        saved={saved}
        modified={modified}
        canSaveViews={canSaveViews}
        onSelectView={(id) => onViewChange(id)}
        onDiscard={discard}
        onDeletingView={onDeletingView}
      />
      <FormulaBar
        modelId={modelId}
        lineItem={lineItems.find((item) => item.id === activeId)}
        canEdit={canEditFormulas}
        locked={locked}
      />
      {/* The grid scrolls inside the room the page leaves below the module's title, tabs and bar. */}
      <div ref={ref} style={{ height }} className="min-h-96">
        {ready ? (
          <Grid
            modelId={modelId}
            query={query}
            label={`${module.name} grid`}
            readOnly={readOnly}
            reference={reference}
            conditionalFormats={current.conditional_formats}
            columnWidths={current.column_widths}
            onColumnWidthsChange={changeWidths}
            onToggleCollapse={toggleCollapse}
            onResetView={reset}
            rowInfo={rowInfo.dims}
            corner={corner}
            onSelectLineItem={setActiveId}
          />
        ) : (
          <GridSkeleton />
        )}
      </div>
    </div>
  )
}
