import { Link, useMatchRoute, useMatches, useParams } from "@tanstack/react-router"
import { Search } from "lucide-react"
import { Fragment, type ReactNode, useRef, useState } from "react"
import { CommandMenu } from "@/components/command-menu"
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb"
import { Button } from "@/components/ui/button"
import { Kbd } from "@/components/ui/kbd"
import { Separator } from "@/components/ui/separator"
import { SidebarTrigger } from "@/components/ui/sidebar"
import { Skeleton } from "@/components/ui/skeleton"
import { BUILD_GROUPS } from "@/features/build/build-nav"
import { useModel } from "@/features/models/api"
import { useStructure } from "@/features/structure/api"
import { useCurrentWorkspace } from "@/hooks/use-current-workspace"
import { cn } from "@/lib/utils"
import type { FileRouteTypes } from "@/routeTree.gen"

const WORKSPACE_PAGES: Partial<Record<FileRouteTypes["id"], string>> = {
  "/_app/w/$workspaceId/": "Models",
  "/_app/w/$workspaceId/members": "Members",
}

const HIDDEN_ON_PHONE = "hidden md:inline-flex"

const IS_APPLE = /Mac|iPhone|iPad/.test(navigator.userAgent)

export function SiteHeader() {
  const [searching, setSearching] = useState(false)
  const searchButton = useRef<HTMLButtonElement>(null)
  return (
    <header className="sticky top-0 z-10 flex h-14 shrink-0 items-center gap-2 border-b bg-background px-4">
      <SidebarTrigger className="-ml-1" />
      <Separator orientation="vertical" className="mr-2 data-[orientation=vertical]:h-4" />
      <Breadcrumbs />
      <Button
        ref={searchButton}
        variant="outline"
        size="sm"
        className="ml-auto justify-between gap-2 text-muted-foreground md:w-56"
        aria-keyshortcuts={IS_APPLE ? "Meta+K" : "Control+K"}
        onClick={() => setSearching(true)}
      >
        <span className="flex items-center gap-2">
          <Search />
          <span className="sr-only md:not-sr-only">Search…</span>
        </span>
        <Kbd className="hidden md:inline-flex">{IS_APPLE ? "⌘K" : "Ctrl K"}</Kbd>
      </Button>
      <CommandMenu open={searching} onOpenChange={setSearching} searchButton={searchButton} />
    </header>
  )
}

function Breadcrumbs() {
  const routeId = useMatches({ select: (matches) => matches[matches.length - 1]?.routeId })
  const { modelId } = useParams({ strict: false })
  const { workspace } = useCurrentWorkspace()

  if (routeId === "/_app/profile") {
    return <Crumbs page="Profile" />
  }
  if (routeId === "/_app/admin/users") {
    return <Crumbs parent="Instance" page="Users" />
  }
  const parent = workspace && (
    <BreadcrumbLink asChild className="truncate">
      <Link to="/w/$workspaceId" params={{ workspaceId: workspace.id }}>
        {workspace.name}
      </Link>
    </BreadcrumbLink>
  )
  if (modelId) {
    return <ModelCrumbs modelId={modelId} routeId={routeId} parent={parent} />
  }
  const page = routeId && WORKSPACE_PAGES[routeId]
  // Without a workspace, the address names one the user is not in, and the page says so.
  return page && workspace ? <Crumbs parent={parent} page={page} /> : null
}

interface ModelCrumbsProps {
  modelId: string
  routeId: FileRouteTypes["id"] | undefined
  parent: ReactNode
}

/**
 * The workspace, the model and the screen of the model: its name in the sidebar, or a module's own
 * name. On a phone the workspace gives way, so that the model and the screen have room.
 */
function ModelCrumbs({ modelId, routeId, parent }: ModelCrumbsProps) {
  const { moduleId } = useParams({ strict: false })
  const model = useModel(modelId)
  const matchRoute = useMatchRoute()

  const modelCrumb = model.isPending ? (
    <Skeleton className="h-4 w-24" />
  ) : (
    <BreadcrumbLink asChild className="truncate">
      <Link to="/m/$modelId/modules" params={{ modelId }}>
        {model.data?.name ?? "Model"}
      </Link>
    </BreadcrumbLink>
  )
  if (routeId === "/_app/m/$modelId/modules/$moduleId" && moduleId) {
    return (
      <Crumbs
        parent={parent}
        parentClassName={HIDDEN_ON_PHONE}
        trail={[
          { node: modelCrumb },
          {
            className: HIDDEN_ON_PHONE,
            node: (
              <BreadcrumbLink asChild>
                <Link to="/m/$modelId/modules" params={{ modelId }}>
                  Modules
                </Link>
              </BreadcrumbLink>
            ),
          },
        ]}
        page={<ModuleName modelId={modelId} moduleId={moduleId} />}
      />
    )
  }
  const screen = BUILD_GROUPS.flatMap((group) => group.pages).find((candidate) =>
    matchRoute({ to: candidate.to, params: { modelId } }),
  )
  return screen ? (
    <Crumbs
      parent={parent}
      parentClassName={HIDDEN_ON_PHONE}
      trail={[{ node: modelCrumb }]}
      page={screen.label}
    />
  ) : null
}

/** A module's own name, once the structure that holds it has arrived. */
function ModuleName({ modelId, moduleId }: { modelId: string; moduleId: string }) {
  const structure = useStructure(modelId)
  if (structure.isPending) {
    return <Skeleton className="h-4 w-28" />
  }
  return structure.data?.modules.find((module) => module.id === moduleId)?.name ?? "Module"
}

interface CrumbsProps {
  /** The first crumb. The workspace stays in view on a phone, where the sidebar is tucked away; its width is capped so the page keeps room. */
  parent?: ReactNode
  parentClassName?: string
  /** The crumbs between `parent` and the page, which give way to the page when there is no room. */
  trail?: { node: ReactNode; className?: string }[]
  page: ReactNode
}

function Crumbs({ parent, parentClassName, trail = [], page }: CrumbsProps) {
  return (
    <Breadcrumb className="min-w-0">
      <BreadcrumbList className="flex-nowrap">
        {parent && (
          <>
            <BreadcrumbItem className={cn("max-w-30 shrink-0 md:max-w-64", parentClassName)}>
              {parent}
            </BreadcrumbItem>
            <BreadcrumbSeparator className={parentClassName} />
          </>
        )}
        {trail.map(({ node, className }, index) => (
          <Fragment key={index}>
            <BreadcrumbItem className={cn("max-w-32 min-w-0 shrink-[3] md:max-w-64", className)}>
              {node}
            </BreadcrumbItem>
            <BreadcrumbSeparator className={className} />
          </Fragment>
        ))}
        <BreadcrumbItem className="min-w-0">
          <BreadcrumbPage className="truncate">{page}</BreadcrumbPage>
        </BreadcrumbItem>
      </BreadcrumbList>
    </Breadcrumb>
  )
}
