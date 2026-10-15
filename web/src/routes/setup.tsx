import { createFileRoute, redirect } from "@tanstack/react-router"
import { AuthLayout } from "@/components/auth-layout"
import { setupStatusQuery } from "@/features/auth/api"
import { SetupForm } from "@/features/auth/setup-form"
import { useDocumentTitle } from "@/hooks/use-document-title"

export const Route = createFileRoute("/setup")({
  beforeLoad: async ({ context: { queryClient } }) => {
    const { needs_setup } = await queryClient.ensureQueryData(setupStatusQuery)
    if (!needs_setup) {
      throw redirect({ to: "/login" })
    }
  },
  component: SetupPage,
})

function SetupPage() {
  useDocumentTitle("Set up OpenPlan")
  return (
    <AuthLayout
      title="Set up OpenPlan"
      description="Create the admin account and your first workspace."
    >
      <SetupForm />
    </AuthLayout>
  )
}
