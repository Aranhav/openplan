import { Link, useMatchRoute, useParams } from "@tanstack/react-router"
import { ChevronRight, Folder, RotateCw } from "lucide-react"
import { useState } from "react"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  useSidebar,
} from "@/components/ui/sidebar"
import { useModelNotFound } from "@/features/models/api"
import { useStructure } from "@/features/structure/api"
import { type ModuleGroups, groupModules } from "@/features/structure/modules"
import type { ModuleDto } from "@/features/structure/types"
import { BUILD_GROUPS, type BuildPage } from "./build-nav"

interface BuildSidebarProps {
  modelId: string
  /** Called when a link is chosen, for the sidebar to close itself over a phone's screen. */
  onNavigate: () => void
}

/** The navigation of the model being worked on: its structure screens and settings. */
export function BuildSidebar({ modelId, onNavigate }: BuildSidebarProps) {
  // There is nothing to navigate in a model that is gone; the page says so.
  if (useModelNotFound(modelId)) {
    return null
  }
  return (
    <nav aria-label="Build" className="flex flex-col gap-2">
      {BUILD_GROUPS.map((group) => (
        <SidebarGroup key={group.label}>
          <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {group.pages.map((page) =>
                page.withModules ? (
                  <ModulesItem
                    key={page.to}
                    page={page}
                    modelId={modelId}
                    onNavigate={onNavigate}
                  />
                ) : (
                  <PageItem key={page.to} page={page} modelId={modelId} onNavigate={onNavigate} />
                ),
              )}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      ))}
    </nav>
  )
}

interface PageProps extends BuildSidebarProps {
  page: BuildPage
}

function PageItem({ page, modelId, onNavigate }: PageProps) {
  const matchRoute = useMatchRoute()
  const lit = Boolean(matchRoute({ to: page.to, params: { modelId }, fuzzy: true }))
  return (
    <SidebarMenuItem>
      <PageLink page={page} modelId={modelId} onNavigate={onNavigate} lit={lit} />
    </SidebarMenuItem>
  )
}

interface PageLinkProps extends PageProps {
  /** Whether the item is drawn as where you are. */
  lit: boolean
}

function PageLink({ page, modelId, onNavigate, lit }: PageLinkProps) {
  const Icon = page.icon
  return (
    <SidebarMenuButton asChild tooltip={page.label} isActive={lit}>
      {/* Exact, or the router also marks Modules as the current page inside a module. */}
      <Link to={page.to} params={{ modelId }} activeOptions={{ exact: true }} onClick={onNavigate}>
        <Icon />
        <span>{page.label}</span>
      </Link>
    </SidebarMenuButton>
  )
}

/**
 * The open state of a folder of the navigation. It starts open and is the user's to fold, except
 * that going to a page the folder holds (`pageKey` names the page) opens it again, so a folded
 * folder never hides where you have arrived.
 */
function useFolder(holdsPage: boolean, pageKey: string | undefined) {
  const [open, setOpen] = useState(true)
  const [lastPageKey, setLastPageKey] = useState(pageKey)
  if (lastPageKey !== pageKey) {
    setLastPageKey(pageKey)
    if (holdsPage) {
      setOpen(true)
    }
  }
  return [open, setOpen] as const
}

/** The link to the modules, with the modules themselves beneath it. */
function ModulesItem({ page, modelId, onNavigate }: PageProps) {
  const structure = useStructure(modelId)
  const matchRoute = useMatchRoute()
  const { moduleId } = useParams({ strict: false })
  const { state, isMobile } = useSidebar()
  const [open, setOpen] = useFolder(Boolean(moduleId), moduleId)

  // The module you are in stands in for the list above it. Where the modules are out of sight,
  // folded away or hidden by the icon rail, the list stands in for the module.
  const inModule = Boolean(moduleId && structure.data?.modules.some(({ id }) => id === moduleId))
  const modulesHidden = !open || (state === "collapsed" && !isMobile)
  const lit =
    Boolean(matchRoute({ to: page.to, params: { modelId } })) || (inModule && modulesHidden)
  const link = <PageLink page={page} modelId={modelId} onNavigate={onNavigate} lit={lit} />

  // A model without modules has nothing to fold, and no list to draw under the link.
  if (structure.data?.modules.length === 0) {
    return <SidebarMenuItem>{link}</SidebarMenuItem>
  }
  return (
    <Collapsible open={open} onOpenChange={setOpen} asChild>
      <SidebarMenuItem>
        {link}
        <CollapsibleTrigger asChild>
          <SidebarMenuAction className="data-[state=open]:rotate-90">
            <ChevronRight />
            <span className="sr-only">Toggle modules</span>
          </SidebarMenuAction>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <SidebarMenuSub>
            {structure.data ? (
              <ModuleLinks
                groups={groupModules(structure.data.modules)}
                modelId={modelId}
                onNavigate={onNavigate}
              />
            ) : structure.isError ? (
              <SidebarMenuSubItem>
                <p className="px-2 py-1 text-xs text-muted-foreground">
                  Modules could not be loaded.
                </p>
                <SidebarMenuSubButton asChild>
                  <button type="button" className="w-full" onClick={() => void structure.refetch()}>
                    <RotateCw />
                    <span>Retry</span>
                  </button>
                </SidebarMenuSubButton>
              </SidebarMenuSubItem>
            ) : (
              <SidebarMenuSubItem>
                <div role="status" aria-label="Loading modules">
                  <SidebarMenuSkeleton />
                  <SidebarMenuSkeleton />
                  <SidebarMenuSkeleton />
                </div>
              </SidebarMenuSubItem>
            )}
          </SidebarMenuSub>
        </CollapsibleContent>
      </SidebarMenuItem>
    </Collapsible>
  )
}

interface ModuleLinksProps extends BuildSidebarProps {
  groups: ModuleGroups
}

function ModuleLinks({ groups, modelId, onNavigate }: ModuleLinksProps) {
  return (
    <>
      <ModuleLinkItems modules={groups.ungrouped} modelId={modelId} onNavigate={onNavigate} />
      {groups.areas.map((area) => (
        <AreaFolder key={area.name} area={area} modelId={modelId} onNavigate={onNavigate} />
      ))}
    </>
  )
}

interface AreaFolderProps extends BuildSidebarProps {
  area: ModuleGroups["areas"][number]
}

function AreaFolder({ area, modelId, onNavigate }: AreaFolderProps) {
  const { moduleId } = useParams({ strict: false })
  const holdsModule = area.modules.some(({ id }) => id === moduleId)
  const [open, setOpen] = useFolder(holdsModule, moduleId)

  return (
    <Collapsible open={open} onOpenChange={setOpen} asChild className="group/area">
      <SidebarMenuSubItem>
        <CollapsibleTrigger asChild>
          {/* Folded, the folder is lit instead of the module it holds. */}
          <SidebarMenuSubButton asChild isActive={holdsModule && !open}>
            <button type="button" className="w-full" title={area.name}>
              <Folder />
              <span className="truncate">{area.name}</span>
              <ChevronRight className="ml-auto transition-transform group-data-[state=open]/area:rotate-90" />
            </button>
          </SidebarMenuSubButton>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <SidebarMenuSub>
            <ModuleLinkItems modules={area.modules} modelId={modelId} onNavigate={onNavigate} />
          </SidebarMenuSub>
        </CollapsibleContent>
      </SidebarMenuSubItem>
    </Collapsible>
  )
}

function ModuleLinkItems({
  modules,
  modelId,
  onNavigate,
}: BuildSidebarProps & { modules: ModuleDto[] }) {
  const { moduleId } = useParams({ strict: false })
  return modules.map((module) => (
    <SidebarMenuSubItem key={module.id}>
      <SidebarMenuSubButton asChild isActive={module.id === moduleId}>
        <Link
          to="/m/$modelId/modules/$moduleId"
          params={{ modelId, moduleId: module.id }}
          title={module.name}
          onClick={onNavigate}
        >
          <span>{module.name}</span>
        </Link>
      </SidebarMenuSubButton>
    </SidebarMenuSubItem>
  ))
}
