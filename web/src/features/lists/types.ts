import type { StructureDto } from "@/features/structure/types"
import type { components } from "@/lib/api/schema"

/** An item as the per-list read gives it; the structure document names its fields differently. */
export type ItemDto = components["schemas"]["ItemDto"]
export type ItemInput = components["schemas"]["ItemInput"]
export type ListDto = StructureDto["lists"][number]
export type SubsetDto = StructureDto["subsets"][number]
