import { CalendarRange, Plus } from "lucide-react"
import { useState } from "react"
import { EmptyState } from "@/components/empty-state"
import { DeleteDialog } from "@/components/delete-dialog"
import { ProductionLock } from "@/components/production-lock"
import { RowDeleteButton } from "@/components/row-delete-button"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { useDeleteTimeRange } from "@/features/structure/api"
import type { StructureDto } from "@/features/structure/types"
import { useRemovalFocus } from "@/hooks/use-removal-focus"
import { useRestoreFocus } from "@/hooks/use-restore-focus"
import { AddTimeRangeDialog } from "./add-time-range-dialog"

type TimeRange = StructureDto["time_ranges"][number]

interface TimeRangesCardProps {
  modelId: string
  structure: StructureDto
  /** Whether the signed-in user may add and delete time ranges; if not, the table only reads. */
  canEdit: boolean
  /** Whether production mode switches the buttons off. */
  locked: boolean
}

export function TimeRangesCard({ modelId, structure, canEdit, locked }: TimeRangesCardProps) {
  const ranges = structure.time_ranges
  const [adding, setAdding] = useState(false)
  const { ref: addRef, onCloseAutoFocus: restoreFocus } = useRestoreFocus<HTMLButtonElement>()

  // The one button is in the header of a list, and in the message of an empty one.
  const addButton = canEdit && (
    <ProductionLock locked={locked}>
      <Button ref={addRef} disabled={locked} onClick={() => setAdding(true)}>
        <Plus />
        Add time range
      </Button>
    </ProductionLock>
  )

  return (
    <Card>
      <CardHeader>
        <CardTitle role="heading" aria-level={2}>
          Time ranges
        </CardTitle>
        <CardDescription className="col-start-1 row-start-2">
          For modules that cover fewer years than the calendar.
        </CardDescription>
        {/* Under the description on a phone, where beside it the description would be a few words wide. */}
        {ranges.length > 0 && addButton && (
          <CardAction className="col-start-1 row-span-1 row-start-3 justify-self-start sm:col-start-2 sm:row-span-2 sm:row-start-1 sm:justify-self-end">
            {addButton}
          </CardAction>
        )}
      </CardHeader>
      <CardContent>
        {ranges.length === 0 ? (
          <EmptyState
            icon={CalendarRange}
            title="No time ranges yet"
            description="A time range is a run of fiscal years that a module can use instead of the calendar."
            action={addButton}
            headingLevel={3}
          />
        ) : (
          <TimeRangesTable modelId={modelId} ranges={ranges} canEdit={canEdit} locked={locked} />
        )}
      </CardContent>
      {canEdit && (
        <AddTimeRangeDialog
          modelId={modelId}
          calendar={structure.calendar}
          open={adding}
          onOpenChange={setAdding}
          onCloseAutoFocus={restoreFocus}
        />
      )}
    </Card>
  )
}

interface TimeRangesTableProps {
  modelId: string
  ranges: TimeRange[]
  canEdit: boolean
  locked: boolean
}

function TimeRangesTable({ modelId, ranges, canEdit, locked }: TimeRangesTableProps) {
  const deleteTimeRange = useDeleteTimeRange(modelId)
  // The range in the dialog stays put as it closes; only `confirming` says whether it is shown.
  const [deletion, setDeletion] = useState<TimeRange>()
  const [confirming, setConfirming] = useState(false)
  const focus = useRemovalFocus(ranges.map((range) => range.id))

  return (
    <div className="rounded-lg border">
      <Table aria-label="Time ranges">
        <TableHeader>
          <TableRow>
            <TableHead className="pl-4">Name</TableHead>
            <TableHead>First year</TableHead>
            <TableHead className={canEdit ? undefined : "pr-4"}>Years</TableHead>
            {canEdit && (
              <TableHead className="w-12 pr-4">
                <span className="sr-only">Actions</span>
              </TableHead>
            )}
          </TableRow>
        </TableHeader>
        <TableBody>
          {ranges.map((range) => (
            <TableRow key={range.id}>
              {/* Takes the width the other columns leave, and cuts a long name short. */}
              <TableCell className="w-full max-w-0 truncate pl-4 font-medium" title={range.name}>
                {range.name}
              </TableCell>
              <TableCell className="tabular-nums">{range.first_year}</TableCell>
              <TableCell className={canEdit ? "tabular-nums" : "pr-4 tabular-nums"}>
                {range.years}
              </TableCell>
              {canEdit && (
                <TableCell className="pr-4 text-right">
                  <RowDeleteButton
                    label={`Delete ${range.name}`}
                    tooltip="Delete time range"
                    buttonRef={focus.refFor(range.id)}
                    locked={locked}
                    onClick={() => {
                      focus.remember(range.id)
                      setDeletion(range)
                      setConfirming(true)
                    }}
                  />
                </TableCell>
              )}
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {canEdit && deletion && (
        <DeleteDialog
          title={`Delete ${deletion.name}?`}
          description="The time range is removed. A time range that a module still uses can't be deleted."
          action="Delete time range"
          done="Time range deleted"
          onConfirm={() => deleteTimeRange.mutateAsync(deletion.id)}
          open={confirming}
          onOpenChange={setConfirming}
          onCloseAutoFocus={focus.onCloseAutoFocus}
        />
      )}
    </div>
  )
}
