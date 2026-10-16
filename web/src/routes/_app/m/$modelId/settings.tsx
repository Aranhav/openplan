import { createFileRoute } from "@tanstack/react-router"
import { ModelPage } from "@/features/models/model-page"

export const Route = createFileRoute("/_app/m/$modelId/settings")({
  component: SettingsRoute,
})

function SettingsRoute() {
  const { modelId } = Route.useParams()
  return <ModelPage modelId={modelId} />
}
