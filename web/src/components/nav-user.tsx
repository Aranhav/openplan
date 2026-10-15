import { Link } from "@tanstack/react-router"
import { ChevronsUpDown, CircleUser, Loader2, LogOut, Palette } from "lucide-react"
import { toast } from "sonner"
import { type Theme, useTheme } from "@/components/theme-provider"
import { THEME_OPTIONS } from "@/components/theme-options"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuPortal,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar"
import { Skeleton } from "@/components/ui/skeleton"
import { useLogout, useMe } from "@/features/auth/api"
import { errorDetail } from "@/lib/api/client"

function initials(name: string): string {
  const words = name.trim().split(/\s+/)
  const letters = words.length > 1 ? [words[0], words[words.length - 1]] : [words[0]]
  return letters.map((word) => word.charAt(0).toUpperCase()).join("")
}

export function NavUser() {
  const { isMobile, setOpenMobile } = useSidebar()
  const { data: me } = useMe()
  const { theme, setTheme } = useTheme()
  const logout = useLogout()

  // Keep the menu open while signing out, so the spinner shows and a failure leaves it usable.
  function signOut(event: Event) {
    event.preventDefault()
    logout.mutate(undefined, { onError: (error) => toast.error(errorDetail(error)) })
  }

  if (!me) {
    return (
      <SidebarMenu>
        <SidebarMenuItem className="flex h-12 items-center gap-2 p-2">
          <Skeleton className="size-8 shrink-0 rounded-lg" />
          <div className="grid flex-1 gap-1.5 group-data-[collapsible=icon]:hidden">
            <Skeleton className="h-3.5 w-24" />
            <Skeleton className="h-3 w-32" />
          </div>
        </SidebarMenuItem>
      </SidebarMenu>
    )
  }

  const { name, email } = me.user
  const identity = (
    <>
      <Avatar aria-hidden className="size-8 rounded-lg">
        <AvatarFallback className="rounded-lg">{initials(name)}</AvatarFallback>
      </Avatar>
      <div className="grid flex-1 text-left text-sm leading-tight">
        <span className="truncate font-medium">{name}</span>
        <span className="truncate text-xs text-muted-foreground">{email}</span>
      </div>
    </>
  )

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton
              size="lg"
              className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
            >
              {identity}
              <ChevronsUpDown className="ml-auto" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            className="w-(--radix-dropdown-menu-trigger-width) min-w-56 rounded-lg"
            align="end"
            side={isMobile ? "bottom" : "right"}
            sideOffset={4}
          >
            <DropdownMenuLabel className="p-0 font-normal">
              <div className="flex items-center gap-2 px-1 py-1.5">{identity}</div>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuItem asChild>
                <Link to="/profile" onClick={() => setOpenMobile(false)}>
                  <CircleUser />
                  Profile
                </Link>
              </DropdownMenuItem>
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                  <Palette />
                  Theme
                </DropdownMenuSubTrigger>
                <DropdownMenuPortal>
                  <DropdownMenuSubContent>
                    <DropdownMenuRadioGroup
                      value={theme}
                      onValueChange={(value) => setTheme(value as Theme)}
                    >
                      {THEME_OPTIONS.map(({ value, label, icon: Icon }) => (
                        <DropdownMenuRadioItem key={value} value={value}>
                          <Icon />
                          {label}
                        </DropdownMenuRadioItem>
                      ))}
                    </DropdownMenuRadioGroup>
                  </DropdownMenuSubContent>
                </DropdownMenuPortal>
              </DropdownMenuSub>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem disabled={logout.isPending} onSelect={signOut}>
              {logout.isPending ? <Loader2 className="animate-spin" /> : <LogOut />}
              Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  )
}
