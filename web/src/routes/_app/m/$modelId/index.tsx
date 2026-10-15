import { createFileRoute } from "@tanstack/react-router"
import { ModelPage } from "@/features/models/model-page"

export const Route = createFileRoute("/_app/m/$modelId/")({
  component: ModelRoute,
})

function ModelRoute() {
  const { modelId } = Route.useParams()
  return <ModelPage key={modelId} modelId={modelId} />
}
