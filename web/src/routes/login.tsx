import { createFileRoute } from "@tanstack/react-router"
import { z } from "zod"
import { AuthLayout } from "@/components/auth-layout"
import { LoginForm } from "@/features/auth/login-form"

export const Route = createFileRoute("/login")({
  validateSearch: z.object({ redirect: z.string().optional().catch(undefined) }),
  component: LoginPage,
})

function LoginPage() {
  const { redirect } = Route.useSearch()
  return (
    <AuthLayout title="Sign in">
      <LoginForm redirectTo={redirect} />
    </AuthLayout>
  )
}
