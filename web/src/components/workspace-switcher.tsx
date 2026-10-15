import { Link } from "@tanstack/react-router"
import { Check, ChevronsUpDown, Plus } from "lucide-react"
import { useState } from "react"
import { Badge } from "@/components/ui/badge"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar"
import { Skeleton } from "@/components/ui/skeleton"
import { useMe } from "@/features/auth/api"
import { useWorkspaces } from "@/features/workspaces/api"
import { CreateWorkspaceDialog } from "@/features/workspaces/create-workspace-dialog"
import { roleLabels } from "@/features/workspaces/roles"
import { useCurrentWorkspace } from "@/hooks/use-current-workspace"
import { useRestoreFocus } from "@/hooks/use-restore-focus"
import { cn } from "@/lib/utils"

export function WorkspaceSwitcher() {
  const { isMobile, setOpenMobile } = useSidebar()
  // The create dialog is opened from a menu item, which is gone by the time it closes: focus goes
  // back to the button that opened the menu.
  const { ref: trigger, onCloseAutoFocus: restoreFocus } = useRestoreFocus<HTMLButtonElement>()
  const { data: me } = useMe()
  const { data: workspaces = [] } = useWorkspaces()
  const { workspace, isLoading } = useCurrentWorkspace()
  const [creating, setCreating] = useState(false)
  const canCreate = me?.user.is_instance_admin ?? false

  if (isLoading) {
    return (
      <SidebarMenu>
        <SidebarMenuItem className="flex h-12 items-center gap-2 p-2">
          <Skeleton className="size-8 shrink-0 rounded-lg" />
          <div className="grid flex-1 gap-1.5 group-data-[collapsible=icon]:hidden">
            <Skeleton className="h-3.5 w-24" />
            <Skeleton className="h-3 w-14" />
          </div>
        </SidebarMenuItem>
      </SidebarMenu>
    )
  }

  return (
    <>
      <SidebarMenu>
        <SidebarMenuItem>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <SidebarMenuButton
                ref={trigger}
                size="lg"
                className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
              >
                <div
                  aria-hidden
                  className="flex aspect-square size-8 items-center justify-center rounded-lg bg-sidebar-primary text-sm font-semibold text-sidebar-primary-foreground"
                >
                  {workspace?.name.charAt(0).toUpperCase() ?? "?"}
                </div>
                <div className="grid flex-1 text-left text-sm leading-tight">
                  <span className="truncate font-medium">{workspace?.name ?? "No workspace"}</span>
                  {workspace && (
                    <span className="truncate text-xs text-muted-foreground">
                      {roleLabels[workspace.role]}
                    </span>
                  )}
                </div>
                <ChevronsUpDown className="ml-auto" />
              </SidebarMenuButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              className="w-(--radix-dropdown-menu-trigger-width) min-w-56 rounded-lg"
              align="start"
              side={isMobile ? "bottom" : "right"}
              sideOffset={4}
            >
              <DropdownMenuLabel className="text-xs text-muted-foreground">
                Workspaces
              </DropdownMenuLabel>
              {workspaces.length === 0 && (
                <DropdownMenuItem disabled>No workspaces</DropdownMenuItem>
              )}
              {workspaces.map((item) => (
                <DropdownMenuItem key={item.id} asChild>
                  <Link
                    to="/w/$workspaceId"
                    params={{ workspaceId: item.id }}
                    activeOptions={{ exact: true }}
                    aria-current={item.id === workspace?.id ? "true" : undefined}
                    onClick={() => setOpenMobile(false)}
                  >
                    <Check className={cn("size-4", item.id !== workspace?.id && "invisible")} />
                    <span className="truncate">{item.name}</span>
                    <Badge variant="secondary" className="ml-auto">
                      {roleLabels[item.role]}
                    </Badge>
                  </Link>
                </DropdownMenuItem>
              ))}
              {canCreate && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={() => setCreating(true)}>
                    <Plus />
                    Create workspace
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </SidebarMenuItem>
      </SidebarMenu>
      {canCreate && (
        <CreateWorkspaceDialog
          open={creating}
          onOpenChange={setCreating}
          onCloseAutoFocus={restoreFocus}
        />
      )}
    </>
  )
}
