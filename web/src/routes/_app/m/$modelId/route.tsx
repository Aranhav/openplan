import { createFileRoute } from "@tanstack/react-router"
import { ModelLayout } from "@/features/build/model-layout"

export const Route = createFileRoute("/_app/m/$modelId")({
  component: ModelRoute,
})

function ModelRoute() {
  const { modelId } = Route.useParams()
  return <ModelLayout key={modelId} modelId={modelId} />
}
