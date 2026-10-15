import { Outlet, createFileRoute, redirect } from "@tanstack/react-router"
import { meQuery, setupStatusQuery } from "@/features/auth/api"
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
        throw redirect({ to: "/login", search: { redirect: location.href } })
      }
      throw error
    }
  },
  component: Outlet,
})
