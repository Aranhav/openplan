import { useVirtualizer } from "@tanstack/react-virtual"
import { ArrowLeft, Loader2 } from "lucide-react"
import { useEffect, useMemo, useRef, useState } from "react"
import { toast } from "sonner"
import { ProductionLock } from "@/components/production-lock"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { SheetFooter } from "@/components/ui/sheet"
import type { useUpdateSubset } from "@/features/structure/api"
import { errorDetail } from "@/lib/api/client"
import { cn } from "@/lib/utils"
import { withIds } from "./selection"
import { matchesQuery } from "./tree"
import type { ItemDto, SubsetDto } from "./types"
import { VIRTUALIZE_ABOVE } from "./virtual"
import { countOf } from "@/lib/format"

const ROW_HEIGHT = 36
const OVERSCAN = 10

interface SubsetMembersProps {
  subset: SubsetDto
  /** The items of the subset's list, in order. */
  items: ItemDto[]
  /** The ids ticked now, which are not saved until the subset is. */
  members: ReadonlySet<string>
  onMembersChange: (members: ReadonlySet<string>) => void
  /** Whether the ticks differ from what the subset holds. */
  dirty: boolean
  update: ReturnType<typeof useUpdateSubset>
  /** Whether the user may change the subset: a builder (`canEdit`) outside production mode (`!locked`). */
  canEdit: boolean
  locked: boolean
  onBack: () => void
  /** Called once the ticks are saved. */
  onSaved: () => void
}

/** The items of a list as checkboxes, with a search, to choose which of them a subset holds. */
export function SubsetMembers({
  subset,
  items,
  members,
  onMembersChange,
  dirty,
  update,
  canEdit,
  locked,
  onBack,
  onSaved,
}: SubsetMembersProps) {
  const [query, setQuery] = useState("")
  const heading = useRef<HTMLHeadingElement>(null)
  const editable = canEdit && !locked

  useEffect(() => {
    heading.current?.focus()
  }, [])

  const shown = useMemo(
    () => (query.trim() ? items.filter((item) => matchesQuery(item, query)) : items),
    [items, query],
  )

  async function save() {
    try {
      // In the order of the list, so that the saved subset reads the same whoever saves it.
      const itemIds = items.filter((item) => members.has(item.id)).map((item) => item.id)
      await update.mutateAsync({ subsetId: subset.id, body: { item_ids: itemIds } })
      toast.success("Subset saved")
      onSaved()
    } catch (error) {
      toast.error(errorDetail(error))
    }
  }

  return (
    <>
      <div className="flex min-h-0 flex-1 flex-col gap-3 p-4">
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            className="-ml-2"
            disabled={update.isPending}
            onClick={onBack}
          >
            <ArrowLeft />
            All subsets
          </Button>
        </div>
        <h3 ref={heading} tabIndex={-1} className="text-base font-semibold outline-none">
          {subset.name}
        </h3>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            type="search"
            aria-label="Filter items"
            placeholder="Filter items"
            autoComplete="off"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="h-8 min-w-0 flex-1 basis-40"
          />
          {editable && (
            <>
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  onMembersChange(
                    withIds(
                      members,
                      shown.map(({ id }) => id),
                      true,
                    ),
                  )
                }
              >
                Select shown
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  onMembersChange(
                    withIds(
                      members,
                      shown.map(({ id }) => id),
                      false,
                    ),
                  )
                }
              >
                Clear shown
              </Button>
            </>
          )}
        </div>
        <p role="status" className="text-sm text-muted-foreground">
          {members.size.toLocaleString("en")} of {countOf(items.length, "item")} selected
          {shown.length !== items.length && `, ${countOf(shown.length, "item")} shown`}
        </p>
        <MemberList
          items={shown}
          members={members}
          editable={editable}
          listLabel={`Items in ${subset.name}`}
          onToggle={(id, checked) => onMembersChange(withIds(members, [id], checked))}
        />
      </div>
      {canEdit && (
        <SheetFooter className="flex-row justify-end border-t">
          <Button variant="outline" disabled={update.isPending} onClick={onBack}>
            Cancel
          </Button>
          <ProductionLock locked={locked}>
            <Button disabled={locked || !dirty || update.isPending} onClick={() => void save()}>
              {update.isPending && <Loader2 className="animate-spin" />}
              Save members
            </Button>
          </ProductionLock>
        </SheetFooter>
      )}
    </>
  )
}

interface MemberListProps {
  items: ItemDto[]
  members: ReadonlySet<string>
  editable: boolean
  listLabel: string
  onToggle: (id: string, checked: boolean) => void
}

function MemberList({ items, members, editable, listLabel, onToggle }: MemberListProps) {
  const scroller = useRef<HTMLDivElement>(null)
  const windowed = items.length > VIRTUALIZE_ABOVE
  // eslint-disable-next-line react-hooks/incompatible-library -- the list only reads from it
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: OVERSCAN,
    enabled: windowed,
  })
  const shown = windowed
    ? virtualizer.getVirtualItems().map(({ index, start }) => ({ index, start }))
    : items.map((_, index) => ({ index, start: index * ROW_HEIGHT }))

  if (items.length === 0) {
    return <p className="text-sm text-muted-foreground">No items match.</p>
  }
  return (
    <div ref={scroller} className="min-h-40 flex-1 overflow-y-auto rounded-md border">
      <ul aria-label={listLabel} className="relative" style={{ height: items.length * ROW_HEIGHT }}>
        {shown.map(({ index, start }) => {
          const item = items[index]
          return (
            <li
              key={item.id}
              aria-setsize={windowed ? items.length : undefined}
              aria-posinset={windowed ? index + 1 : undefined}
              className="absolute inset-x-0"
              style={{ top: start, height: ROW_HEIGHT }}
            >
              <label
                className={cn(
                  "flex h-full items-center gap-3 px-3 text-sm",
                  editable ? "cursor-pointer hover:bg-accent" : "cursor-default",
                )}
              >
                <Checkbox
                  checked={members.has(item.id)}
                  disabled={!editable}
                  onCheckedChange={(checked) => onToggle(item.id, checked === true)}
                />
                <span className="truncate">{item.name}</span>
                {item.code && (
                  <span className="ml-auto text-xs text-muted-foreground">{item.code}</span>
                )}
              </label>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
