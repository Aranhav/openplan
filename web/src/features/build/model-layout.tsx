import { Outlet } from "@tanstack/react-router"
import { LiveStatusContext } from "@/features/live/live-status"
import { useModelLive } from "@/features/live/use-model-live"
import { useModel, useModelNotFound } from "@/features/models/api"
import { ModelNotFound } from "@/features/models/model-not-found"

/**
 * What every screen of a model sits in. The Build sidebar and the header sit around it; they and
 * the screens read the model and its structure through the same queries, so each is fetched once.
 * A model that is known to exist is followed live, so that what other users change shows on every
 * screen; one that is still being asked for, or is gone, is not.
 */
export function ModelLayout({ modelId }: { modelId: string }) {
  const notFound = useModelNotFound(modelId)
  const known = useModel(modelId).data !== undefined
  const live = useModelLive(known && !notFound ? modelId : undefined)
  return notFound ? (
    <ModelNotFound />
  ) : (
    <LiveStatusContext value={live}>
      <Outlet />
    </LiveStatusContext>
  )
}
