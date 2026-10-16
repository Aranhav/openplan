import { createFileRoute } from "@tanstack/react-router"
import { z } from "zod"
import { ModulePage } from "@/features/modules/module-page"

export const Route = createFileRoute("/_app/m/$modelId/modules/$moduleId")({
  validateSearch: z.object({
    tab: z.enum(["grid", "blueprint"]).optional().catch(undefined),
    li: z.string().optional().catch(undefined),
  }),
  component: ModuleRoute,
})

function ModuleRoute() {
  const { modelId, moduleId } = Route.useParams()
  const { li } = Route.useSearch()
  return <ModulePage modelId={modelId} moduleId={moduleId} selectedLineItemId={li} />
}
