import { Eye, RefreshCw, Search } from "lucide-react"
import { type RefObject, useId, useState } from "react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import type { ModuleDto, StructureDto } from "@/features/structure/types"
import { countOf } from "@/lib/format"
import { cn } from "@/lib/utils"
import { INDENT } from "../grid-layout"
import type { Member, ViewDefinition, ViewDim } from "../view-types"
import { dimLabel } from "./dim-labels"
import { MAX_LISTED, membersMatching } from "./member-search"
import { useMembers } from "./members-api"
import { ToolbarPanel } from "./toolbar-panel"
import { type ViewAction, dimKey } from "./view-state"

interface ShowHidePopoverProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Where the panel hangs when its button has moved into the More menu. */
  anchor?: RefObject<HTMLElement | null>
  modelId: string
  module: ModuleDto
  structure: StructureDto
  view: ViewDefinition
  dispatch: (action: ViewAction) => void
}

/**
 * Which members the grid leaves out. Each dimension on the rows or columns has a list of its
 * members, with a check for the ones that are shown. A total that is hidden hides only itself:
 * the members below it stay.
 */
export function ShowHidePopover({
  open,
  onOpenChange,
  anchor,
  modelId,
  module,
  structure,
  view,
  dispatch,
}: ShowHidePopoverProps) {
  const hidden = view.hidden?.length ?? 0
  const trigger = anchor ? undefined : (
    <Button
      variant={hidden > 0 ? "secondary" : "ghost"}
      size="sm"
      aria-label={hidden > 0 ? `Show/hide, ${hidden} hidden` : undefined}
      className="gap-1.5 px-2"
    >
      <Eye />
      Show/hide
      {hidden > 0 && (
        <Badge variant="outline" className="h-4 min-w-4 px-1">
          {hidden}
        </Badge>
      )}
    </Button>
  )
  return (
    <ToolbarPanel
      open={open}
      onOpenChange={onOpenChange}
      trigger={trigger}
      anchor={anchor}
      label="Show or hide members"
    >
      <ShowHideList
        modelId={modelId}
        module={module}
        structure={structure}
        view={view}
        dispatch={dispatch}
      />
    </ToolbarPanel>
  )
}

type ListProps = Omit<ShowHidePopoverProps, "open" | "onOpenChange" | "anchor">

function ShowHideList({ modelId, module, structure, view, dispatch }: ListProps) {
  const shownDims: ViewDim[] = [...view.rows, ...view.columns]
  const [chosen, setChosen] = useState(dimKey(shownDims[0]))
  const dim = shownDims.find((candidate) => dimKey(candidate) === chosen) ?? shownDims[0]
  const [query, setQuery] = useState("")
  const searchId = useId()
  const members = useMembers(modelId, module.id, dim, view.show_summaries ?? true)
  const hiddenHere = (view.hidden ?? []).filter((member) => dimKey(member.dim) === dimKey(dim))
  const isHidden = (key: string) => hiddenHere.some((member) => member.key === key)

  const matching = membersMatching(members.data ?? [], query)
  const listed = matching.slice(0, MAX_LISTED)
  // Time counts its depth as the height above its periods, so it steps in from the top total.
  const deepest = Math.max(0, ...(members.data ?? []).map((member) => member.depth))
  const indentOf = (member: Member) =>
    query.trim() !== "" ? 0 : dim.kind === "time" ? deepest - member.depth : member.depth

  return (
    <div className="flex flex-col gap-2">
      <h2 className="text-sm font-medium">Show or hide members</h2>
      <Select
        value={dimKey(dim)}
        onValueChange={(next) => {
          setChosen(next)
          setQuery("")
        }}
      >
        <SelectTrigger size="sm" aria-label="Dimension" className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {shownDims.map((candidate) => (
            <SelectItem key={dimKey(candidate)} value={dimKey(candidate)}>
              {dimLabel(candidate, module, structure)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          id={searchId}
          type="search"
          aria-label="Search members"
          placeholder="Search members"
          autoComplete="off"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          className="h-8 pl-8"
        />
      </div>
      {members.isPending ? (
        <div role="status" aria-label="Loading members" className="flex flex-col gap-2 py-1">
          {Array.from({ length: 5 }, (_, index) => (
            <Skeleton key={index} className="h-5 w-full" />
          ))}
        </div>
      ) : members.isError ? (
        <Button variant="outline" size="sm" onClick={() => void members.refetch()}>
          <RefreshCw />
          Retry
        </Button>
      ) : matching.length === 0 ? (
        <p className="py-2 text-sm text-muted-foreground">
          {query.trim() === "" ? "This dimension has no members." : "No member matches."}
        </p>
      ) : (
        <ScrollArea className="[&_[data-slot=scroll-area-viewport]]:max-h-64">
          <ul aria-label={`Members of ${dimLabel(dim, module, structure)}`} className="flex flex-col">
            {listed.map((member) => {
              const id = `${searchId}-${member.key}`
              return (
                <li
                  key={member.key}
                  className="flex items-center gap-2 rounded-sm px-1 py-1 hover:bg-accent"
                  style={{ paddingLeft: 4 + indentOf(member) * INDENT }}
                >
                  <Checkbox
                    id={id}
                    checked={!isHidden(member.key)}
                    onCheckedChange={(checked) =>
                      dispatch({
                        type: checked === true ? "show" : "hide",
                        member: { dim, key: member.key },
                      })
                    }
                  />
                  <Label
                    htmlFor={id}
                    className={cn("min-w-0 flex-1 truncate", member.is_summary && "font-semibold")}
                  >
                    {member.label}
                  </Label>
                </li>
              )
            })}
          </ul>
        </ScrollArea>
      )}
      {matching.length > listed.length && (
        <p className="text-xs text-muted-foreground">
          Showing the first {listed.length} of {countOf(matching.length, "member")}. Search to find
          the rest.
        </p>
      )}
      <div className="flex items-center justify-between gap-2 border-t pt-2">
        <span className="text-xs text-muted-foreground">
          {hiddenHere.length === 0 ? "All shown" : `${countOf(hiddenHere.length, "member")} hidden`}
        </span>
        <Button
          variant="outline"
          size="sm"
          disabled={hiddenHere.length === 0}
          onClick={() => dispatch({ type: "show_all", dim })}
        >
          Show all
        </Button>
      </div>
    </div>
  )
}
