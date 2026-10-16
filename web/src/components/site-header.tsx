import { createLink, useMatches, useParams } from "@tanstack/react-router"
import { Search } from "lucide-react"
import { type ComponentProps, Fragment, type ReactNode, useRef, useState } from "react"
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

/**
 * A link of the breadcrumb. The router marks a link to the page you are on, or to one above it, as
 * `aria-current="page"`, which would make every crumb the current page; only the last crumb is.
 */
const CrumbLink = createLink(function CrumbAnchor(props: ComponentProps<"a">) {
  return <a {...props} aria-current={undefined} data-status={undefined} />
})

/** An element, not a component: the crumb and the menu hand it their own props. */
function workspaceLink(workspace: Workspace) {
  return (
    <CrumbLink to="/w/$workspaceId" params={{ workspaceId: workspace.id }} title={workspace.name}>
      {workspace.name}
    </CrumbLink>
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

/**
 * The workspace, the model and the screen of the model, or a module's own name. One `TrailCrumbs`
 * serves every screen, so choosing a crumb from its menu leaves the menu's button in place for the
 * focus to return to.
 */
function ModelCrumbs({ modelId, routeId, workspace }: ModelCrumbsProps) {
  const { moduleId } = useParams({ strict: false })
  const inModule = routeId === "/_app/m/$modelId/modules/$moduleId" && Boolean(moduleId)
  const trail = useModelTrail(modelId, workspace, inModule)

  // From the route id, as the module is, so that both agree in the moment of a navigation: the
  // crumbs are never left out in between, which would unmount the menu's button.
  const screen = BUILD_GROUPS.flatMap((group) => group.pages).find(
    (candidate) => routeId === `/_app${candidate.to}/` || routeId === `/_app${candidate.to}`,
  )
  if (inModule && moduleId) {
    return (
      <TrailCrumbs trail={trail} current={<ModuleCrumb modelId={modelId} moduleId={moduleId} />} />
    )
  }
  return screen ? (
    <TrailCrumbs trail={trail} current={<CurrentCrumb>{screen.label}</CurrentCrumb>} />
  ) : null
}

/** The crumb of the page itself: the one that is kept in view, and is cut short last. */
function CurrentCrumb({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <BreadcrumbPage className="truncate" title={title}>
      {children}
    </BreadcrumbPage>
  )
}

/** A module's own name, once the structure that holds it has arrived. */
function ModuleCrumb({ modelId, moduleId }: { modelId: string; moduleId: string }) {
  const structure = useStructure(modelId)
  if (structure.isPending) {
    return (
      <CurrentCrumb>
        <Skeleton className="h-4 w-28" />
      </CurrentCrumb>
    )
  }
  const name = structure.data?.modules.find((module) => module.id === moduleId)?.name ?? "Module"
  return <CurrentCrumb title={name}>{name}</CurrentCrumb>
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
        <CrumbLink to="/m/$modelId/modules" params={{ modelId }} title={name}>
          {name}
        </CrumbLink>
      ),
    },
    ...(withModules
      ? [
          {
            key: "modules",
            link: (
              <CrumbLink to="/m/$modelId/modules" params={{ modelId }} title="Modules">
                Modules
              </CrumbLink>
            ),
          },
        ]
      : []),
  ]
}

interface TrailCrumbsProps {
  trail: TrailCrumb[]
  /** The crumb of the page itself. */
  current: ReactNode
}

/**
 * The crumbs of a model's screen. The page is the one to keep in view: the crumbs above it give way
 * first, each down to a stub, and below `xl`, where the sidebar and the search take half the
 * header, they fold into a menu.
 */
function TrailCrumbs({ trail, current }: TrailCrumbsProps) {
  const linked = trail.filter((crumb) => crumb.link)
  return (
    <Breadcrumb className="min-w-0">
      <BreadcrumbList className="flex-nowrap">
        {linked.length > 0 && (
          <>
            <BreadcrumbItem className="xl:hidden">
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
            <BreadcrumbSeparator className="xl:hidden" />
          </>
        )}
        {trail.map(({ key, link }) => (
          <Fragment key={key}>
            <BreadcrumbItem className="hidden max-w-64 min-w-10 shrink-[3] xl:inline-flex">
              {link ? (
                <BreadcrumbLink asChild className="truncate">
                  {link}
                </BreadcrumbLink>
              ) : (
                <Skeleton className="h-4 w-24" />
              )}
            </BreadcrumbItem>
            <BreadcrumbSeparator className="hidden xl:inline-flex" />
          </Fragment>
        ))}
        <BreadcrumbItem className="min-w-0">{current}</BreadcrumbItem>
      </BreadcrumbList>
    </Breadcrumb>
  )
}
