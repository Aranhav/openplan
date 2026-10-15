import { createFileRoute } from "@tanstack/react-router"
import { ModelsPage } from "@/features/models/models-page"

export const Route = createFileRoute("/_app/w/$workspaceId/")({
  component: WorkspaceModelsRoute,
})

function WorkspaceModelsRoute() {
  const { workspaceId } = Route.useParams()
  return <ModelsPage key={workspaceId} />
}
