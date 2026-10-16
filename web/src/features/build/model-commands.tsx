import { useNavigate } from "@tanstack/react-router"
import { Grid3x3, Rows3 } from "lucide-react"
import { ErrorState } from "@/components/error-state"
import { CommandGroup, CommandItem } from "@/components/ui/command"
import { Skeleton } from "@/components/ui/skeleton"
import { useStructure } from "@/features/structure/api"
import { BUILD_GROUPS } from "./build-nav"

interface ModelCommandsProps {
  modelId: string
  run: (action: () => unknown) => void
}

/** What the command palette offers inside a model: its screens, modules and line items. */
export function ModelCommands({ modelId, run }: ModelCommandsProps) {
  const navigate = useNavigate()
  return (
    <>
      <CommandGroup heading="This model">
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
  const { modules, line_items: lineItems } = structure.data
  const moduleOf = new Map(modules.map((module) => [module.id, module]))

  return (
    <>
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
      {lineItems.length > 0 && (
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
