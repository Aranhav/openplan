import { createFileRoute } from "@tanstack/react-router"
import { PageHeader } from "@/components/page-header"

export const Route = createFileRoute("/_app/admin/users")({
  component: () => <PageHeader title="Users" />,
})
