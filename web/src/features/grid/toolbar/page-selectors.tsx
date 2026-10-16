import { Check, ChevronsUpDown, RefreshCw } from "lucide-react"
import { useState } from "react"
import { Button } from "@/components/ui/button"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
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
import type { Member, PageMember, ViewDefinition, ViewDim } from "../view-types"
import { dimLabel } from "./dim-labels"
import { MAX_LISTED, membersMatching } from "./member-search"
import { useMembers } from "./members-api"
import { type ViewAction, dimKey } from "./view-state"

/** A dimension with this many members or fewer is chosen from a menu; with more, from a search. */
export const MAX_MENU_MEMBERS = 20

const STEP = 12

interface PageSelectorsProps {
  modelId: string
  module: ModuleDto
  structure: StructureDto
  view: ViewDefinition
  /** The members the pages show now, once the grid's first block says, for a page at its default member. */
  shown: readonly PageMember[] | undefined
  dispatch: (action: ViewAction) => void
}

/** One selector for each dimension on a page, to choose the member the grid shows it at. */
export function PageSelectors({ modelId, module, structure, view, shown, dispatch }: PageSelectorsProps) {
  return (
    <>
      {(view.pages ?? []).map((page) => (
        <PageSelector
          key={dimKey(page.dim)}
          modelId={modelId}
          moduleId={module.id}
          name={dimLabel(page.dim, module, structure)}
          showSummaries={view.show_summaries ?? true}
          selectedKey={
            page.key ?? shown?.find((candidate) => dimKey(candidate.dim) === dimKey(page.dim))?.member.key
          }
          dim={page.dim}
          onChange={(key) => dispatch({ type: "set_page", dim: page.dim, key })}
        />
      ))}
    </>
  )
}

interface PageSelectorProps {
  modelId: string
  moduleId: string
  name: string
  dim: ViewDim
  showSummaries: boolean
  /** The key of the member shown, if known. */
  selectedKey: string | undefined
  onChange: (key: string) => void
}

function PageSelector({
  modelId,
  moduleId,
  name,
  dim,
  showSummaries,
  selectedKey,
  onChange,
}: PageSelectorProps) {
  const members = useMembers(modelId, moduleId, dim, showSummaries)
  if (members.isPending) {
    return <Skeleton aria-label={`Loading ${name}`} role="status" className="h-8 w-32" />
  }
  if (members.isError) {
    return (
      <Button variant="outline" size="sm" onClick={() => void members.refetch()}>
        <RefreshCw />
        {name}: retry
      </Button>
    )
  }
  if (members.data.length === 0) {
    return (
      <Button variant="outline" size="sm" disabled>
        <span className="text-muted-foreground">{name}</span>
        No members
      </Button>
    )
  }
  return members.data.length <= MAX_MENU_MEMBERS ? (
    <MenuSelector name={name} members={members.data} selectedKey={selectedKey} onChange={onChange} />
  ) : (
    <SearchSelector name={name} members={members.data} selectedKey={selectedKey} onChange={onChange} />
  )
}

interface SelectorProps {
  name: string
  members: readonly Member[]
  selectedKey: string | undefined
  onChange: (key: string) => void
}

/** What a selector is called to assistive technology: the dimension and the member shown, as the button reads. */
function nameOf(name: string, shown: Member | undefined) {
  return shown ? `${name}: ${shown.label}` : name
}

function MenuSelector({ name, members, selectedKey, onChange }: SelectorProps) {
  const selected = members.find((member) => member.key === selectedKey)
  return (
    <Select value={selectedKey ?? ""} onValueChange={onChange}>
      <SelectTrigger
        size="sm"
        aria-label={nameOf(name, selected)}
        className="max-w-44 shrink-0 gap-1.5 px-2"
      >
        <span className="text-muted-foreground">{name}</span>
        <SelectValue placeholder="Choose" />
      </SelectTrigger>
      <SelectContent>
        {members.map((member) => (
          <SelectItem
            key={member.key}
            value={member.key}
            style={{ paddingLeft: 8 + member.depth * STEP }}
            className={cn(member.is_summary && "font-medium")}
          >
            {member.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

function SearchSelector({ name, members, selectedKey, onChange }: SelectorProps) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const selected = members.find((member) => member.key === selectedKey)
  const matching = membersMatching(members, query)
  const listed = matching.slice(0, MAX_LISTED)

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        setQuery("")
      }}
    >
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          role="combobox"
          aria-expanded={open}
          aria-label={nameOf(name, selected)}
          className="max-w-44 shrink-0 gap-1.5 px-2 font-normal"
        >
          <span className="text-muted-foreground">{name}</span>
          <span className="truncate">{selected?.label ?? "Choose"}</span>
          <ChevronsUpDown className="text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" aria-label={`Members of ${name}`} className="w-72 p-0">
        <Command shouldFilter={false} label={`Members of ${name}`}>
          <CommandInput placeholder={`Find in ${name}…`} value={query} onValueChange={setQuery} />
          <CommandList>
            <CommandEmpty>No member matches.</CommandEmpty>
            <CommandGroup>
              {listed.map((member) => (
                <CommandItem
                  key={member.key}
                  value={member.key}
                  style={{ paddingLeft: 8 + member.depth * STEP }}
                  onSelect={() => {
                    onChange(member.key)
                    setOpen(false)
                    setQuery("")
                  }}
                >
                  <Check className={cn(member.key === selectedKey ? "opacity-100" : "opacity-0")} />
                  <span className={cn("truncate", member.is_summary && "font-medium")}>
                    {member.label}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
          {matching.length > listed.length && (
            <p className="border-t px-3 py-2 text-xs text-muted-foreground">
              Showing the first {listed.length} of {countOf(matching.length, "member")}. Type to
              narrow them down.
            </p>
          )}
        </Command>
      </PopoverContent>
    </Popover>
  )
}
