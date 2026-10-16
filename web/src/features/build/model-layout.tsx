import { Outlet } from "@tanstack/react-router"
import type { ReactNode } from "react"
import { LiveStatusContext } from "@/features/live/live-status"
import { useModelLive } from "@/features/live/use-model-live"
import { useModelNotFound } from "@/features/models/api"
import { ModelNotFound } from "@/features/models/model-not-found"

/**
 * What every screen of a model sits in. The Build sidebar and the header sit around it; they and
 * the screens read the model and its structure through the same queries, so each is fetched once.
 * A model that exists is followed live, so that what other users change shows on every screen.
 */
export function ModelLayout({ modelId }: { modelId: string }) {
  return useModelNotFound(modelId) ? (
    <ModelNotFound />
  ) : (
    <LiveModel modelId={modelId}>
      <Outlet />
    </LiveModel>
  )
}

/** Follows the model for as long as its screens are open, and tells them whether it is live. */
function LiveModel({ modelId, children }: { modelId: string; children: ReactNode }) {
  const status = useModelLive(modelId)
  return <LiveStatusContext value={status}>{children}</LiveStatusContext>
}
