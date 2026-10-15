import { Outlet, createFileRoute, redirect } from "@tanstack/react-router"
import { AppSidebar } from "@/components/app-sidebar"
import { SiteHeader } from "@/components/site-header"
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar"
import { meQuery, setupStatusQuery } from "@/features/auth/api"
import { loginSearch } from "@/features/auth/redirect"
import { ApiError } from "@/lib/api/client"

export const Route = createFileRoute("/_app")({
  beforeLoad: async ({ context: { queryClient }, location }) => {
    const { needs_setup } = await queryClient.ensureQueryData(setupStatusQuery)
    if (needs_setup) {
      throw redirect({ to: "/setup" })
    }
    try {
      return { me: await queryClient.ensureQueryData(meQuery) }
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        throw redirect({ to: "/login", search: loginSearch(location.href) })
      }
      throw error
    }
  },
  component: AppLayout,
})

function AppLayout() {
  // The sidebar provider saves its state in a cookie; reading it back keeps a collapsed sidebar collapsed.
  return (
    <SidebarProvider defaultOpen={!document.cookie.includes("sidebar_state=false")}>
      <AppSidebar />
      <SidebarInset className="min-w-0">
        <SiteHeader />
        <div className="flex-1 p-4 md:p-6">
          <Outlet />
        </div>
      </SidebarInset>
    </SidebarProvider>
  )
}
