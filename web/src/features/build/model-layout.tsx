import { Outlet } from "@tanstack/react-router"
import { useModelNotFound } from "@/features/models/api"
import { ModelNotFound } from "@/features/models/model-not-found"

/**
 * What every screen of a model sits in. The Build sidebar and the header sit around it; they and
 * the screens read the model and its structure through the same queries, so each is fetched once.
 */
export function ModelLayout({ modelId }: { modelId: string }) {
  return useModelNotFound(modelId) ? <ModelNotFound /> : <Outlet />
}
