import { createFileRoute, redirect } from "@tanstack/react-router"
import { z } from "zod"
import { AuthLayout } from "@/components/auth-layout"
import { meQuery, setupStatusQuery } from "@/features/auth/api"
import { LoginForm } from "@/features/auth/login-form"
import { safeRedirectPath } from "@/features/auth/redirect"
import { useDocumentTitle } from "@/hooks/use-document-title"
import { ApiError } from "@/lib/api/client"

export const Route = createFileRoute("/login")({
  validateSearch: z.object({ redirect: z.string().optional().catch(undefined) }),
  beforeLoad: async ({ context: { queryClient }, search }) => {
    const { needs_setup } = await queryClient.ensureQueryData(setupStatusQuery)
    if (needs_setup) {
      throw redirect({ to: "/setup" })
    }
    try {
      await queryClient.ensureQueryData(meQuery)
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        return
      }
      throw error
    }
    throw redirect({ href: safeRedirectPath(search.redirect) })
  },
  component: LoginPage,
})

function LoginPage() {
  const { redirect: redirectTo } = Route.useSearch()
  useDocumentTitle("Sign in · OpenPlan")
  return (
    <AuthLayout title="Sign in">
      <LoginForm redirectTo={redirectTo} />
    </AuthLayout>
  )
}
