import { createContext, useContext } from "react"
import type { LiveStatus } from "./use-model-live"

/** Whether the open model's screens hear of changes; empty outside the model's layout. */
export const LiveStatusContext = createContext<LiveStatus | undefined>(undefined)

export function useLiveStatus(): LiveStatus | undefined {
  return useContext(LiveStatusContext)
}
