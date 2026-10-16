import { Link } from "@tanstack/react-router"
import { ListTree, Plus } from "lucide-react"
import { type ReactNode, useState } from "react"
import { EmptyState } from "@/components/empty-state"
import { ErrorState } from "@/components/error-state"
import { PageHeader } from "@/components/page-header"
import { ProductionLock, ProductionNotice } from "@/components/production-lock"
import { NAME_CELL, WIDE_CELL } from "@/components/table-layout"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { useStructure } from "@/features/structure/api"
import type { StructureDto } from "@/features/structure/types"
import { useRestoreFocus } from "@/hooks/use-restore-focus"
import { useStructureAccess } from "@/hooks/use-structure-access"
import { NewListDialog } from "./new-list-dialog"
import type { ListDto } from "./types"

const LINK_CLASS =
  "rounded-sm underline-offset-4 outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50"

export function ListsPage({ modelId }: { modelId: string }) {
  const structure = useStructure(modelId)
  const { canEdit, locked } = useStructureAccess(modelId)
  const [creating, setCreating] = useState(false)
  const { ref: newRef, onCloseAutoFocus: restoreFocus } = useRestoreFocus<HTMLButtonElement>()

  // The one button is in the header of a list of lists, and in the message of an empty one.
  const newButton = canEdit && (
    <ProductionLock locked={locked}>
      <Button ref={newRef} disabled={locked} onClick={() => setCreating(true)}>
        <Plus />
        New list
      </Button>
    </ProductionLock>
  )
  const empty = structure.data?.lists.length === 0

  return (
    <>
      <PageHeader
        title="Lists"
        description="The things you plan over, such as regions or products."
        actions={!empty && newButton}
      />
      {locked && (
        <div className="mb-6">
          <ProductionNotice />
        </div>
      )}
      {/* A refresh that fails in the background leaves the lists already on screen alone. */}
      {structure.data ? (
        <Lists modelId={modelId} structure={structure.data} action={newButton} />
      ) : structure.isError ? (
        <ErrorState error={structure.error} onRetry={() => void structure.refetch()} />
      ) : (
        <ListsSkeleton />
      )}
      {canEdit && structure.data && (
        <NewListDialog
          modelId={modelId}
          structure={structure.data}
          open={creating}
          onOpenChange={setCreating}
          onCloseAutoFocus={restoreFocus}
        />
      )}
    </>
  )
}

interface ListsProps {
  modelId: string
  structure: StructureDto
  /** The button that creates a list, if the user may; shown in the message of an empty page. */
  action: ReactNode
}

function Lists({ modelId, structure, action }: ListsProps) {
  if (structure.lists.length === 0) {
    return (
      <EmptyState
        icon={ListTree}
        title="No lists yet"
        description="Lists hold the things you plan over, such as regions, products or people."
        action={action}
      />
    )
  }
  const byId = new Map(structure.lists.map((list) => [list.id, list]))
  return (
    <div className="rounded-lg border">
      <Table aria-label="Lists">
        <TableHeader>
          <TableRow>
            <TableHead className="pl-4">Name</TableHead>
            <TableHead className={WIDE_CELL}>Parent list</TableHead>
            <TableHead className="w-24 pr-6 text-right lg:w-auto">Items</TableHead>
            <TableHead className={WIDE_CELL}>Top level</TableHead>
            <TableHead className={`${WIDE_CELL} pr-4`}>Settings</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {structure.lists.map((list) => (
            <ListRow
              key={list.id}
              modelId={modelId}
              list={list}
              parent={list.parent ? byId.get(list.parent) : undefined}
            />
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

function ListBadges({ list }: { list: ListDto }) {
  return (
    <>
      {list.numbered && <Badge variant="secondary">Numbered</Badge>}
      {list.production_data && <Badge variant="outline">Production data</Badge>}
    </>
  )
}

function ListRow({ modelId, list, parent }: { modelId: string; list: ListDto; parent?: ListDto }) {
  const hasBadges = list.numbered || list.production_data
  return (
    <TableRow>
      <TableCell className={`${NAME_CELL} font-medium`}>
        <Link
          to="/m/$modelId/lists/$listId"
          params={{ modelId, listId: list.id }}
          title={list.name}
          className={`block truncate ${LINK_CLASS}`}
        >
          {list.name}
        </Link>
        {/* Below lg the facts of the wide columns sit under the name. */}
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs font-normal whitespace-normal text-muted-foreground lg:hidden">
          {parent && <span>Child of {parent.name}</span>}
          {list.top_level_name && <span>Top level: {list.top_level_name}</span>}
          <ListBadges list={list} />
        </div>
      </TableCell>
      <TableCell className={WIDE_CELL}>
        {parent ? (
          <Link
            to="/m/$modelId/lists/$listId"
            params={{ modelId, listId: parent.id }}
            className={LINK_CLASS}
          >
            {parent.name}
          </Link>
        ) : (
          <span className="text-muted-foreground">None</span>
        )}
      </TableCell>
      <TableCell className="pr-6 text-right tabular-nums">
        {list.items.length.toLocaleString("en")}
      </TableCell>
      <TableCell className={WIDE_CELL}>
        {list.top_level_name ?? <span className="text-muted-foreground">None</span>}
      </TableCell>
      <TableCell className={`${WIDE_CELL} pr-4`}>
        {hasBadges && (
          <div className="flex flex-wrap gap-1">
            <ListBadges list={list} />
          </div>
        )}
      </TableCell>
    </TableRow>
  )
}

function ListsSkeleton() {
  return (
    <div role="status" aria-label="Loading lists" className="rounded-lg border">
      <div className="flex flex-col gap-4 p-4">
        {Array.from({ length: 4 }, (_, index) => (
          <div key={index} className="flex items-center gap-4">
            <Skeleton className="h-5 w-32" />
            <Skeleton className="hidden h-5 w-24 lg:block" />
            <Skeleton className="h-5 flex-1" />
            <Skeleton className="h-5 w-10" />
          </div>
        ))}
      </div>
    </div>
  )
}
