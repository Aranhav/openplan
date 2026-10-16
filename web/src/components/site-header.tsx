import { Link, useMatchRoute, useMatches, useParams } from "@tanstack/react-router"
import { Search } from "lucide-react"
import { Fragment, type ReactNode, useRef, useState } from "react"
import { CommandMenu } from "@/components/command-menu"
import {
  Breadcrumb,
  BreadcrumbEllipsis,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Kbd } from "@/components/ui/kbd"
import { Separator } from "@/components/ui/separator"
import { SidebarTrigger } from "@/components/ui/sidebar"
import { Skeleton } from "@/components/ui/skeleton"
import { BUILD_GROUPS } from "@/features/build/build-nav"
import { useModel } from "@/features/models/api"
import { useStructure } from "@/features/structure/api"
import { useCurrentWorkspace } from "@/hooks/use-current-workspace"
import { isMac } from "@/lib/platform"
import type { FileRouteTypes } from "@/routeTree.gen"

const WORKSPACE_PAGES: Partial<Record<FileRouteTypes["id"], string>> = {
  "/_app/w/$workspaceId/": "Models",
  "/_app/w/$workspaceId/members": "Members",
}

export function SiteHeader() {
  const [searching, setSearching] = useState(false)
  const searchButton = useRef<HTMLButtonElement>(null)
  const mac = isMac()
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
        aria-keyshortcuts={mac ? "Meta+K" : "Control+K"}
        onClick={() => setSearching(true)}
      >
        <span className="flex items-center gap-2">
          <Search />
          <span className="sr-only md:not-sr-only">Search…</span>
        </span>
        <Kbd className="hidden md:inline-flex">{mac ? "⌘K" : "Ctrl K"}</Kbd>
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
  if (modelId) {
    return <ModelCrumbs modelId={modelId} routeId={routeId} workspace={workspace} />
  }
  const page = routeId && WORKSPACE_PAGES[routeId]
  // Without a workspace, the address names one the user is not in, and the page says so.
  return page && workspace ? (
    <Crumbs
      parent={
        <BreadcrumbLink asChild className="truncate">
          {workspaceLink(workspace)}
        </BreadcrumbLink>
      }
      page={page}
    />
  ) : null
}

type Workspace = { id: string; name: string }

/** An element, not a component: the crumb and the menu hand it their own props. */
function workspaceLink(workspace: Workspace) {
  return (
    <Link to="/w/$workspaceId" params={{ workspaceId: workspace.id }} title={workspace.name}>
      {workspace.name}
    </Link>
  )
}

/** The workspace stays in view on a phone, where the sidebar is tucked away; its width is capped so the page keeps room. */
function Crumbs({ parent, page }: { parent?: ReactNode; page: ReactNode }) {
  return (
    <Breadcrumb className="min-w-0">
      <BreadcrumbList className="flex-nowrap">
        {parent && (
          <>
            <BreadcrumbItem className="max-w-30 shrink-0 md:max-w-64">{parent}</BreadcrumbItem>
            <BreadcrumbSeparator />
          </>
        )}
        <BreadcrumbItem className="min-w-0">
          <BreadcrumbPage className="truncate">{page}</BreadcrumbPage>
        </BreadcrumbItem>
      </BreadcrumbList>
    </Breadcrumb>
  )
}

interface ModelCrumbsProps {
  modelId: string
  routeId: FileRouteTypes["id"] | undefined
  workspace: Workspace | undefined
}

/** The workspace, the model and the screen of the model, or a module's own name. */
function ModelCrumbs({ modelId, routeId, workspace }: ModelCrumbsProps) {
  const { moduleId } = useParams({ strict: false })
  const matchRoute = useMatchRoute()

  if (routeId === "/_app/m/$modelId/modules/$moduleId" && moduleId) {
    return <ModuleCrumbs modelId={modelId} moduleId={moduleId} workspace={workspace} />
  }
  const screen = BUILD_GROUPS.flatMap((group) => group.pages).find((candidate) =>
    matchRoute({ to: candidate.to, params: { modelId } }),
  )
  return screen ? (
    <ScreenCrumbs modelId={modelId} workspace={workspace} label={screen.label} />
  ) : null
}

function ScreenCrumbs({
  modelId,
  workspace,
  label,
}: Omit<ModelCrumbsProps, "routeId"> & { label: string }) {
  const trail = useModelTrail(modelId, workspace, false)
  return <TrailCrumbs trail={trail} page={label} />
}

/** A module's own name, once the structure that holds it has arrived. */
function ModuleCrumbs({
  modelId,
  moduleId,
  workspace,
}: Omit<ModelCrumbsProps, "routeId"> & { moduleId: string }) {
  const trail = useModelTrail(modelId, workspace, true)
  const structure = useStructure(modelId)
  const name = structure.isPending
    ? undefined
    : (structure.data?.modules.find((module) => module.id === moduleId)?.name ?? "Module")
  return (
    <TrailCrumbs trail={trail} page={name ?? <Skeleton className="h-4 w-28" />} pageTitle={name} />
  )
}

interface TrailCrumb {
  key: string
  /** The link to the crumb's page; none while what it names is still loading. */
  link: ReactNode
}

/** The links above a screen of a model: its workspace, the model and, for a module, the modules. */
function useModelTrail(
  modelId: string,
  workspace: Workspace | undefined,
  withModules: boolean,
): TrailCrumb[] {
  const model = useModel(modelId)
  const name = model.data?.name ?? "Model"
  return [
    ...(workspace ? [{ key: "workspace", link: workspaceLink(workspace) }] : []),
    {
      key: "model",
      link: model.isPending ? null : (
        <Link to="/m/$modelId/modules" params={{ modelId }} title={name}>
          {name}
        </Link>
      ),
    },
    ...(withModules
      ? [
          {
            key: "modules",
            link: (
              <Link to="/m/$modelId/modules" params={{ modelId }}>
                Modules
              </Link>
            ),
          },
        ]
      : []),
  ]
}

interface TrailCrumbsProps {
  trail: TrailCrumb[]
  page: ReactNode
  /** The page's name in full, for where it is cut short. */
  pageTitle?: string
}

/**
 * The crumbs of a model's screen. The page is the one to keep in view: the crumbs above it give way
 * first, each down to a stub, and below `lg`, where the sidebar and the search take half the
 * header, they fold into a menu.
 */
function TrailCrumbs({ trail, page, pageTitle }: TrailCrumbsProps) {
  const linked = trail.filter((crumb) => crumb.link)
  return (
    <Breadcrumb className="min-w-0">
      <BreadcrumbList className="flex-nowrap">
        {linked.length > 0 && (
          <>
            <BreadcrumbItem className="lg:hidden">
              <DropdownMenu>
                <DropdownMenuTrigger className="flex items-center rounded-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50">
                  <BreadcrumbEllipsis className="size-7" />
                  <span className="sr-only">Show the path to this page</span>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                  {linked.map(({ key, link }) => (
                    <DropdownMenuItem key={key} asChild>
                      {link}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            </BreadcrumbItem>
            <BreadcrumbSeparator className="lg:hidden" />
          </>
        )}
        {trail.map(({ key, link }) => (
          <Fragment key={key}>
            <BreadcrumbItem className="hidden max-w-64 min-w-10 shrink-[3] lg:inline-flex">
              {link ? (
                <BreadcrumbLink asChild className="truncate">
                  {link}
                </BreadcrumbLink>
              ) : (
                <Skeleton className="h-4 w-24" />
              )}
            </BreadcrumbItem>
            <BreadcrumbSeparator className="hidden lg:inline-flex" />
          </Fragment>
        ))}
        <BreadcrumbItem className="min-w-0">
          <BreadcrumbPage className="truncate" title={pageTitle}>
            {page}
          </BreadcrumbPage>
        </BreadcrumbItem>
      </BreadcrumbList>
    </Breadcrumb>
  )
}
