import { HttpResponse, http } from "msw"
import type { StructureDto } from "@/features/structure/types"
import { server } from "./server"

export interface StructureStore {
  structure: StructureDto
}

/**
 * Serves the structure in `store.structure` for every model, read afresh on each request. A test
 * that mocks a structure change replaces it, so the page's next read of the structure shows it.
 */
export function serveStructureStore(structure: StructureDto): StructureStore {
  const store = { structure }
  server.use(http.get("/api/v1/models/:id/structure", () => HttpResponse.json(store.structure)))
  return store
}
