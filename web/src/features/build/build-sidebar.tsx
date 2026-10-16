import { Link, useMatchRoute, useParams } from "@tanstack/react-router"
import { ChevronRight, Folder } from "lucide-react"
import type { ReactNode } from "react"
import { ErrorState } from "@/components/error-state"
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
} from "@/components/ui/sidebar"
import { useModel } from "@/features/models/api"
import { useStructure } from "@/features/structure/api"
import { type ModuleGroups, groupModules } from "@/features/structure/modules"
import { ApiError } from "@/lib/api/client"
import type { components } from "@/lib/api/schema"
import { BUILD_GROUPS, type BuildPage } from "./build-nav"

type ModuleDto = components["schemas"]["ModuleDto"]

interface BuildSidebarProps {
  modelId: string
  /** Called when a link is chosen, for the sidebar to close itself over a phone's screen. */
  onNavigate: () => void
}

/** The navigation of the model being worked on: its structure screens and settings. */
export function BuildSidebar({ modelId, onNavigate }: BuildSidebarProps) {
  const model = useModel(modelId)
  // There is nothing to navigate in a model that is gone; the page says so.
  if (model.error instanceof ApiError && model.error.status === 404) {
    return null
  }
  return (
    <nav aria-label="Build" className="flex flex-col gap-2">
      {BUILD_GROUPS.map((group) => (
        <SidebarGroup key={group.label}>
          <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {group.pages.map((page) => (
                <BuildPageItem
                  key={page.to}
                  page={page}
                  modelId={modelId}
                  onNavigate={onNavigate}
                />
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      ))}
    </nav>
  )
}

interface BuildPageItemProps extends BuildSidebarProps {
  page: BuildPage
}

function BuildPageItem({ page, modelId, onNavigate }: BuildPageItemProps) {
  const matchRoute = useMatchRoute()
  // The module you are in is lit instead of the list of modules above it.
  const active = Boolean(matchRoute({ to: page.to, params: { modelId }, fuzzy: !page.withModules }))
  const Icon = page.icon
  const link = (
    <SidebarMenuButton asChild tooltip={page.label} isActive={active}>
      <Link to={page.to} params={{ modelId }} onClick={onNavigate}>
        <Icon />
        <span>{page.label}</span>
      </Link>
    </SidebarMenuButton>
  )

  if (!page.withModules) {
    return <SidebarMenuItem>{link}</SidebarMenuItem>
  }
  return (
    <ModulesItem modelId={modelId} onNavigate={onNavigate}>
      {link}
    </ModulesItem>
  )
}

/** The link to the modules, with the modules themselves beneath it. */
function ModulesItem({
  modelId,
  onNavigate,
  children,
}: BuildSidebarProps & { children: ReactNode }) {
  const structure = useStructure(modelId)
  // A model without modules has nothing to fold, and no list to draw under the link.
  if (structure.data?.modules.length === 0) {
    return <SidebarMenuItem>{children}</SidebarMenuItem>
  }

  return (
    <Collapsible defaultOpen asChild>
      <SidebarMenuItem>
        {children}
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
                <ErrorState error={structure.error} onRetry={() => void structure.refetch()} />
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
        <Collapsible key={area.name} defaultOpen asChild className="group/area">
          <SidebarMenuSubItem>
            <CollapsibleTrigger asChild>
              <SidebarMenuSubButton asChild>
                <button type="button" className="w-full">
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
      ))}
    </>
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
