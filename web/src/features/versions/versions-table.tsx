import { Loader2 } from "lucide-react"
import { useState } from "react"
import { toast } from "sonner"
import { DeleteDialog } from "@/components/delete-dialog"
import { ProductionLock } from "@/components/production-lock"
import { RowDeleteButton } from "@/components/row-delete-button"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { useDeleteVersion, useUpdateVersion } from "@/features/structure/api"
import type { StructureDto } from "@/features/structure/types"
import { useRemovalFocus } from "@/hooks/use-removal-focus"
import { errorDetail } from "@/lib/api/client"
import type { components } from "@/lib/api/schema"
import { cn } from "@/lib/utils"
import { VersionName } from "./version-name"

type VersionRequest = components["schemas"]["VersionRequest"]

/** A version as the table shows it: its switchover is the label of the month, as requests word it. */
interface VersionRow {
  id: string
  name: string
  is_actual: boolean
  is_current: boolean
  switchover: string | null
}

/** What the switchover's select holds for none; a month label never looks like this. */
const NO_SWITCHOVER = "none"

function rowsOf({ versions, month_labels }: StructureDto): VersionRow[] {
  return versions.map((version) => ({
    id: version.id,
    name: version.name,
    is_actual: version.is_actual,
    is_current: version.is_current,
    switchover: version.switchover == null ? null : (month_labels[version.switchover] ?? null),
  }))
}

/** The rows as they will be once a save that is still on its way arrives: the choice shows at once. */
function withSave(
  rows: VersionRow[],
  save: { versionId: string; body: VersionRequest } | undefined,
): VersionRow[] {
  if (!save) {
    return rows
  }
  const { versionId, body } = save
  return rows.map((row) =>
    row.id === versionId
      ? { ...row, ...body, switchover: body.switchover ?? null }
      : {
          ...row,
          is_actual: row.is_actual && !body.is_actual,
          is_current: row.is_current && !body.is_current,
        },
  )
}

function cannotDelete(row: VersionRow) {
  if (row.is_actual) {
    return "The actual version can't be deleted."
  }
  if (row.is_current) {
    return "The current version can't be deleted. Make another version current first."
  }
  return undefined
}

interface VersionsTableProps {
  modelId: string
  structure: StructureDto
  /** Whether the signed-in user may change the versions; if not, the table only reads. */
  canEdit: boolean
  /** Whether production mode switches the controls off. */
  locked: boolean
  /** Whether the screen is too narrow for a column of its own for the switchover. */
  narrow: boolean
}

export function VersionsTable({ modelId, structure, canEdit, locked, narrow }: VersionsTableProps) {
  const updateVersion = useUpdateVersion(modelId)
  const deleteVersion = useDeleteVersion(modelId)
  const saving = updateVersion.isPending ? updateVersion.variables : undefined
  const rows = withSave(rowsOf(structure), saving)
  // The version in the dialog stays put as it closes; only `confirming` says whether it is shown.
  const [deletion, setDeletion] = useState<VersionRow>()
  const [confirming, setConfirming] = useState(false)
  const focus = useRemovalFocus(rows.map((row) => row.id))

  /** Saves a version with `change` applied: the server takes the whole version, not the change. */
  function save(row: VersionRow, change: Partial<VersionRequest>) {
    const body = { ...row, ...change }
    return updateVersion.mutateAsync({
      versionId: row.id,
      body: {
        name: body.name,
        is_actual: body.is_actual,
        is_current: body.is_current,
        // The actual version shows actual values everywhere, so it has no month to switch over in.
        switchover: body.is_actual ? null : body.switchover,
      },
    })
  }

  // A choice made while another is on its way is ignored: both would start from the same version.
  async function choose(row: VersionRow, change: Partial<VersionRequest>, done: string) {
    if (updateVersion.isPending) {
      return
    }
    try {
      await save(row, change)
      toast.success(done)
    } catch (error) {
      toast.error(errorDetail(error))
    }
  }

  async function rename(row: VersionRow, name: string) {
    await save(row, { name })
    toast.success("Version renamed")
  }

  return (
    <div className="rounded-lg border">
      <Table aria-label="Versions" className="table-fixed">
        <VersionsHead canEdit={canEdit} narrow={narrow} />
        <TableBody>
          {rows.map((row) => {
            const switchover = (
              <Switchover
                row={row}
                months={structure.month_labels}
                canEdit={canEdit}
                locked={locked}
                fill={narrow}
                onChange={(month) => void choose(row, { switchover: month }, "Switchover updated")}
              />
            )
            return (
              <TableRow key={row.id}>
                <TableCell className="pl-4">
                  {canEdit && !locked ? (
                    <VersionName name={row.name} onRename={(name) => rename(row, name)} />
                  ) : (
                    <span className="block truncate font-medium" title={row.name}>
                      {row.name}
                    </span>
                  )}
                  {/* Beside the other columns the switchover has one of its own. */}
                  {narrow && (
                    <div className="mt-2 grid max-w-40 gap-1">
                      <span className="text-xs text-muted-foreground">Switchover</span>
                      {switchover}
                    </div>
                  )}
                </TableCell>
                <TableCell className={cn("text-center", narrow && "px-1")}>
                  <VersionChoice
                    flag="is_actual"
                    row={row}
                    canEdit={canEdit}
                    locked={locked}
                    onChoose={() => void choose(row, { is_actual: true }, "Actual version updated")}
                  />
                </TableCell>
                <TableCell className={cn("text-center", narrow && "px-1")}>
                  <VersionChoice
                    flag="is_current"
                    row={row}
                    canEdit={canEdit}
                    locked={locked}
                    onChoose={() =>
                      void choose(row, { is_current: true }, "Current version updated")
                    }
                  />
                </TableCell>
                {!narrow && (
                  <TableCell className={canEdit ? undefined : "pr-4"}>{switchover}</TableCell>
                )}
                {canEdit && (
                  <TableCell className="relative pr-4">
                    {saving?.versionId === row.id && (
                      // Beside the delete button without taking room from the column.
                      <span
                        role="status"
                        aria-label={`Saving ${row.name}`}
                        className="absolute top-1/2 right-14 -translate-y-1/2"
                      >
                        <Loader2
                          aria-hidden
                          className="size-4 animate-spin text-muted-foreground"
                        />
                      </span>
                    )}
                    <div className="flex justify-end">
                      <RowDeleteButton
                        label={`Delete ${row.name}`}
                        tooltip="Delete version"
                        buttonRef={focus.refFor(row.id)}
                        locked={locked}
                        cannotDelete={cannotDelete(row)}
                        onClick={() => {
                          focus.remember(row.id)
                          setDeletion(row)
                          setConfirming(true)
                        }}
                      />
                    </div>
                  </TableCell>
                )}
              </TableRow>
            )
          })}
        </TableBody>
      </Table>
      {canEdit && deletion && (
        <DeleteDialog
          title={`Delete ${deletion.name}?`}
          description="The version is removed from the model. A version that line items are limited to can't be deleted."
          action="Delete version"
          done="Version deleted"
          onConfirm={() => deleteVersion.mutateAsync(deletion.id)}
          open={confirming}
          onOpenChange={setConfirming}
          onCloseAutoFocus={focus.onCloseAutoFocus}
        />
      )}
    </div>
  )
}

interface VersionsHeadProps {
  canEdit: boolean
  narrow: boolean
}

/**
 * The header of the versions table, whose columns have widths of their own (the name takes what is
 * left), so that nothing moves when a name turns into an input or the data replaces a placeholder.
 */
export function VersionsHead({ canEdit, narrow }: VersionsHeadProps) {
  return (
    <TableHeader>
      <TableRow>
        <TableHead className="pl-4">Name</TableHead>
        <TableHead className={cn("text-center", narrow ? "w-14 px-1" : "w-24")}>Actual</TableHead>
        <TableHead className={cn("text-center", narrow ? "w-16 px-1" : "w-24")}>Current</TableHead>
        {!narrow && <TableHead className={cn("w-40", !canEdit && "pr-4")}>Switchover</TableHead>}
        {canEdit && (
          <TableHead className={cn("pr-4", narrow ? "w-16" : "w-24")}>
            <span className="sr-only">Actions</span>
          </TableHead>
        )}
      </TableRow>
    </TableHeader>
  )
}

interface VersionChoiceProps {
  /** Which choice the column holds: the actual version or the current one. */
  flag: "is_actual" | "is_current"
  row: VersionRow
  canEdit: boolean
  locked: boolean
  onChoose: () => void
}

/**
 * Whether a version is the actual (or the current) one: a radio for those who can change it. A
 * radio group can't span two columns of a table, so each radio is a group of its own and the
 * table decides which of them is on.
 */
function VersionChoice({ flag, row, canEdit, locked, onChoose }: VersionChoiceProps) {
  if (!canEdit) {
    return <YesNo value={row[flag]} />
  }
  const kind = flag === "is_actual" ? "actual" : "current"
  return (
    <ProductionLock locked={locked}>
      <RadioGroup
        aria-label={`${kind === "actual" ? "Actual" : "Current"} version`}
        className="justify-items-center"
        value={row[flag] ? row.id : ""}
        disabled={locked}
        onValueChange={onChoose}
      >
        <RadioGroupItem
          value={row.id}
          aria-label={`${row.name}, ${kind} version`}
          // The stock border is too faint to find the unchecked radios by.
          className="size-5 border-muted-foreground/80"
        />
      </RadioGroup>
    </ProductionLock>
  )
}

function YesNo({ value }: { value: boolean }) {
  return value ? (
    <span className="font-medium">Yes</span>
  ) : (
    <span className="text-muted-foreground">No</span>
  )
}

interface SwitchoverProps {
  row: VersionRow
  months: string[]
  canEdit: boolean
  locked: boolean
  /** Whether the select takes the width it is given instead of its own. */
  fill: boolean
  onChange: (switchover: string | null) => void
}

function Switchover({ row, months, canEdit, locked, fill, onChange }: SwitchoverProps) {
  if (row.is_actual) {
    return <span className="text-muted-foreground">Not applicable</span>
  }
  if (!canEdit) {
    return row.switchover ?? <span className="text-muted-foreground">None</span>
  }
  return (
    <ProductionLock locked={locked}>
      <Select
        value={row.switchover ?? NO_SWITCHOVER}
        disabled={locked}
        onValueChange={(value) => onChange(value === NO_SWITCHOVER ? null : value)}
      >
        <SelectTrigger
          size="sm"
          className={fill ? "w-full" : "w-28"}
          aria-label={`Switchover for ${row.name}`}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NO_SWITCHOVER}>None</SelectItem>
          {months.map((label) => (
            <SelectItem key={label} value={label}>
              {label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </ProductionLock>
  )
}
