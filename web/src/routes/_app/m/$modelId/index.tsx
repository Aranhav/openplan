import { createFileRoute } from "@tanstack/react-router"
import { PageHeader } from "@/components/page-header"

export const Route = createFileRoute("/_app/m/$modelId/")({
  component: () => <PageHeader title="Model" />,
})
