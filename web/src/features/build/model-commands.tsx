import { useNavigate } from "@tanstack/react-router"
import { useCommandState } from "cmdk"
import { Grid3x3, ListTree, Rows3 } from "lucide-react"
import { ErrorState } from "@/components/error-state"
import { CommandGroup, CommandItem } from "@/components/ui/command"
import { Skeleton } from "@/components/ui/skeleton"
import { useModelNotFound } from "@/features/models/api"
import { countOf } from "@/lib/format"
import { useStructure } from "@/features/structure/api"
import { BUILD_GROUPS } from "./build-nav"

interface ModelCommandsProps {
  modelId: string
  run: (action: () => unknown) => void
}

/** Line items are only listed once the search can tell them apart; a model has many of them. */
const MIN_SEARCH_FOR_LINE_ITEMS = 2

/** What the command palette offers inside a model: its screens, modules and line items. */
export function ModelCommands({ modelId, run }: ModelCommandsProps) {
  const navigate = useNavigate()
  // Like the sidebar, offer nothing for a model that is gone.
  if (useModelNotFound(modelId)) {
    return null
  }
  return (
    <>
      <CommandGroup heading="Model">
        {BUILD_GROUPS.flatMap((group) => group.pages).map(({ label, icon: Icon, to }) => (
          <CommandItem
            key={to}
            value={`Go to ${label}`}
            onSelect={() => run(() => navigate({ to, params: { modelId } }))}
          >
            <Icon />
            {label}
          </CommandItem>
        ))}
      </CommandGroup>
      <StructureCommands modelId={modelId} run={run} />
    </>
  )
}

// Its own component, so the structure is only asked for once the palette is open.
function StructureCommands({ modelId, run }: ModelCommandsProps) {
  const navigate = useNavigate()
  const structure = useStructure(modelId)
  const search = useCommandState((state) => state.search)

  if (structure.isError) {
    return (
      <CommandGroup heading="Modules">
        <ErrorState error={structure.error} onRetry={() => void structure.refetch()} />
      </CommandGroup>
    )
  }
  if (structure.isPending) {
    return (
      <CommandGroup heading="Modules">
        <div role="status" aria-label="Loading modules" className="flex flex-col gap-2 px-2 py-1.5">
          <Skeleton className="h-5 w-full" />
          <Skeleton className="h-5 w-3/4" />
        </div>
      </CommandGroup>
    )
  }
  const { lists, modules, line_items: lineItems } = structure.data
  const moduleOf = new Map(modules.map((module) => [module.id, module]))

  return (
    <>
      {lists.length > 0 && (
        <CommandGroup heading="Lists">
          {lists.map((list) => (
            <CommandItem
              key={list.id}
              value={`Open list ${list.name}`}
              onSelect={() =>
                run(() =>
                  navigate({
                    to: "/m/$modelId/lists/$listId",
                    params: { modelId, listId: list.id },
                  }),
                )
              }
            >
              <ListTree />
              {list.name}
              <span className="ml-auto text-xs text-muted-foreground">
                {countOf(list.items.length, "item")}
              </span>
            </CommandItem>
          ))}
        </CommandGroup>
      )}
      {modules.length > 0 && (
        <CommandGroup heading="Modules">
          {modules.map((module) => (
            <CommandItem
              key={module.id}
              value={`Open module ${module.name} ${module.functional_area}`}
              onSelect={() =>
                run(() =>
                  navigate({
                    to: "/m/$modelId/modules/$moduleId",
                    params: { modelId, moduleId: module.id },
                  }),
                )
              }
            >
              <Grid3x3 />
              {module.name}
              {module.functional_area && (
                <span className="ml-auto text-xs text-muted-foreground">
                  {module.functional_area}
                </span>
              )}
            </CommandItem>
          ))}
        </CommandGroup>
      )}
      {lineItems.length > 0 && search.trim().length >= MIN_SEARCH_FOR_LINE_ITEMS && (
        <CommandGroup heading="Line items">
          {lineItems.map((item) => {
            const module = moduleOf.get(item.module)
            return (
              module && (
                <CommandItem
                  key={item.id}
                  value={`Open line item ${item.name} in ${module.name}`}
                  onSelect={() =>
                    run(() =>
                      navigate({
                        to: "/m/$modelId/modules/$moduleId",
                        params: { modelId, moduleId: module.id },
                        search: { tab: "blueprint", li: item.id },
                      }),
                    )
                  }
                >
                  <Rows3 />
                  {item.name}
                  <span className="ml-auto text-xs text-muted-foreground">{module.name}</span>
                </CommandItem>
              )
            )
          })}
        </CommandGroup>
      )}
    </>
  )
}
