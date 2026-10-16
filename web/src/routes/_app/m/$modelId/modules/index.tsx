import { createFileRoute } from "@tanstack/react-router"
import { ModulesPage } from "@/features/modules/modules-page"

export const Route = createFileRoute("/_app/m/$modelId/modules/")({
  component: ModulesRoute,
})

function ModulesRoute() {
  const { modelId } = Route.useParams()
  return <ModulesPage modelId={modelId} />
}
