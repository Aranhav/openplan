import { Outlet } from "@tanstack/react-router"
import { useModel } from "@/features/models/api"
import { ModelNotFound } from "@/features/models/model-not-found"
import { ApiError } from "@/lib/api/client"

/**
 * What every screen of a model sits in. The Build sidebar and the header sit around it; they and
 * the screens read the model and its structure through the same queries, so each is fetched once.
 */
export function ModelLayout({ modelId }: { modelId: string }) {
  const model = useModel(modelId)

  // A 404 means the model is gone, even if a copy of it is still on screen.
  if (model.error instanceof ApiError && model.error.status === 404) {
    return <ModelNotFound />
  }
  return <Outlet />
}
