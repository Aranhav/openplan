import type { Zone } from "./view-state"

/** The dimensions in each zone of a pivot, by the key of the dimension. */
export type Zones = Record<Zone, string[]>

export const ZONES: readonly Zone[] = ["rows", "columns", "pages"]

const isZone = (id: string): id is Zone => (ZONES as readonly string[]).includes(id)

/**
 * Where a dimension dropped on `overId` goes: on a zone, at its end; on another dimension, to
 * the place that one has now. `index` is where the dimension ends up in the zone.
 */
export function dropTarget(
  zones: Zones,
  activeId: string,
  overId: string | undefined,
): { to: Zone; index: number } | undefined {
  if (overId === undefined || overId === activeId) {
    return undefined
  }
  if (isZone(overId)) {
    const left = zones[overId].filter((id) => id !== activeId)
    return { to: overId, index: left.length }
  }
  const to = ZONES.find((zone) => zones[zone].includes(overId))
  return to && { to, index: zones[to].indexOf(overId) }
}
