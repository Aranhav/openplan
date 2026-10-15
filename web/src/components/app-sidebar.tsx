import { Link, useLocation, useMatchRoute } from "@tanstack/react-router"
import { LayoutGrid, UserCog, Users } from "lucide-react"
import { type ComponentProps, useEffect } from "react"
import { NavUser } from "@/components/nav-user"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
  SidebarRail,
  useSidebar,
} from "@/components/ui/sidebar"
import { WorkspaceSwitcher } from "@/components/workspace-switcher"
import { useMe } from "@/features/auth/api"
import { useCurrentWorkspace } from "@/hooks/use-current-workspace"

export function AppSidebar(props: ComponentProps<typeof Sidebar>) {
  const { data: me } = useMe()
  const { workspace, isLoading } = useCurrentWorkspace()
  const matchRoute = useMatchRoute()
  const { setOpenMobile } = useSidebar()
  const pathname = useLocation({ select: (location) => location.pathname })

  // On a phone the sidebar is a sheet that covers the page; close it once you have moved on.
  useEffect(() => {
    setOpenMobile(false)
  }, [pathname, setOpenMobile])

  const workspaceParams = workspace && { workspaceId: workspace.id }
  const onModels =
    workspaceParams &&
    (matchRoute({ to: "/w/$workspaceId", params: workspaceParams }) ||
      matchRoute({ to: "/m/$modelId", fuzzy: true }))
  const onMembers =
    workspaceParams && matchRoute({ to: "/w/$workspaceId/members", params: workspaceParams })
  const onUsers = matchRoute({ to: "/admin/users" })

  return (
    <Sidebar collapsible="icon" {...props}>
      <SidebarHeader>
        <WorkspaceSwitcher />
      </SidebarHeader>
      <SidebarContent>
        {(workspace || isLoading) && (
          <SidebarGroup>
            <SidebarGroupLabel>Workspace</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {workspace ? (
                  <>
                    <SidebarMenuItem>
                      <SidebarMenuButton asChild tooltip="Models" isActive={Boolean(onModels)}>
                        <Link
                          to="/w/$workspaceId"
                          params={{ workspaceId: workspace.id }}
                          activeOptions={{ exact: true }}
                        >
                          <LayoutGrid />
                          <span>Models</span>
                        </Link>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                    <SidebarMenuItem>
                      <SidebarMenuButton asChild tooltip="Members" isActive={Boolean(onMembers)}>
                        <Link to="/w/$workspaceId/members" params={{ workspaceId: workspace.id }}>
                          <Users />
                          <span>Members</span>
                        </Link>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  </>
                ) : (
                  <>
                    <SidebarMenuSkeleton showIcon />
                    <SidebarMenuSkeleton showIcon />
                  </>
                )}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        )}
        {me?.user.is_instance_admin && (
          <SidebarGroup>
            <SidebarGroupLabel>Instance</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                <SidebarMenuItem>
                  <SidebarMenuButton asChild tooltip="Users" isActive={Boolean(onUsers)}>
                    <Link to="/admin/users">
                      <UserCog />
                      <span>Users</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        )}
      </SidebarContent>
      <SidebarFooter>
        <NavUser />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  )
}
