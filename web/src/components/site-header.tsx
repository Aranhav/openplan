import { Link, useMatches, useParams } from "@tanstack/react-router"
import { Search } from "lucide-react"
import { type ReactNode, useState } from "react"
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
import { useModel } from "@/features/models/api"
import { useCurrentWorkspace } from "@/hooks/use-current-workspace"
import type { FileRouteTypes } from "@/routeTree.gen"

const WORKSPACE_PAGES: Partial<Record<FileRouteTypes["id"], string>> = {
  "/_app/w/$workspaceId/": "Models",
  "/_app/w/$workspaceId/members": "Members",
}

const IS_APPLE = /Mac|iPhone|iPad/.test(navigator.userAgent)

export function SiteHeader() {
  const [searching, setSearching] = useState(false)
  return (
    <header className="sticky top-0 z-10 flex h-14 shrink-0 items-center gap-2 border-b bg-background px-4">
      <SidebarTrigger className="-ml-1" />
      <Separator orientation="vertical" className="mr-2 data-[orientation=vertical]:h-4" />
      <Breadcrumbs />
      <Button
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
      <CommandMenu open={searching} onOpenChange={setSearching} />
    </header>
  )
}

function Breadcrumbs() {
  const routeId = useMatches({ select: (matches) => matches[matches.length - 1]?.routeId })
  const { modelId } = useParams({ strict: false })
  const { workspace } = useCurrentWorkspace()
  const model = useModel(modelId)

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
  if (routeId === "/_app/m/$modelId/") {
    const name = model.isPending ? <Skeleton className="h-4 w-28" /> : (model.data?.name ?? "Model")
    return <Crumbs parent={parent} page={name} />
  }
  const page = routeId && WORKSPACE_PAGES[routeId]
  // Without a workspace, the address names one the user is not in, and the page says so.
  return page && workspace ? <Crumbs parent={parent} page={page} /> : null
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
