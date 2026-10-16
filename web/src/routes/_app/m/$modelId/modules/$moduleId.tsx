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
  const { tab, li } = Route.useSearch()
  const navigate = Route.useNavigate()
  return (
    <ModulePage
      modelId={modelId}
      moduleId={moduleId}
      tab={tab ?? "grid"}
      selectedLineItemId={li}
      onTabChange={(next) => void navigate({ search: (previous) => ({ ...previous, tab: next }) })}
      // Moving the selection is not a step to go back over.
      onSelectLineItem={(id) =>
        void navigate({ search: (previous) => ({ ...previous, li: id }), replace: true })
      }
    />
  )
}
