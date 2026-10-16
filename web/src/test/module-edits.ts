import { HttpResponse, http } from "msw"
import type { FormulaError, ViewQuery } from "@/features/grid/view-types"
import type { LineItemDto, ModuleDto, StructureDto } from "@/features/structure/types"
import type { components } from "@/lib/api/schema"
import { problem } from "./problem"
import { server } from "./server"

type Schemas = components["schemas"]

export interface ModuleStore {
  structure: StructureDto
  /** The body of every request that changed a module or a line item, by what it did. */
  requests: { action: string; id?: string; body?: unknown }[]
  /** What is wrong with the formula of a line item, by line item, as a query says. */
  formulaErrors: Record<string, FormulaError[]>
  /** The problems the server finds in a formula it is asked to save; none accepts it. */
  checkFormula: (formula: string) => FormulaError[]
  /** Makes every change wait, for a test to look at the page while one is being saved; call the result to let them through. */
  hold: () => () => void
}

let counter = 0

function nextId() {
  counter += 1
  return `0192f3a0-0000-7000-8000-0000000009${String(counter).padStart(2, "0")}`
}

const nameTaken = () => problem(409, "structure.name_taken", "That name is already in use.")

/**
 * Serves the structure in `store.structure` and the endpoints that change modules and line
 * items, which change it the way the server does. Reading it afresh on each request, a page sees
 * the change after the invalidation that follows. The query endpoint answers with no rows, only
 * the line items of the module and what `store.formulaErrors` says of them.
 */
export function serveModuleStore(structure: StructureDto): ModuleStore {
  const store: ModuleStore = {
    structure,
    requests: [],
    formulaErrors: {},
    checkFormula: () => [],
    hold: () => {
      let release!: () => void
      gate = new Promise<void>((resolve) => {
        release = resolve
      })
      return () => {
        gate = undefined
        release()
      }
    },
  }
  let gate: Promise<void> | undefined
  const lineItem = (id: unknown) => store.structure.line_items.find((item) => item.id === id)
  const change = (patch: Partial<StructureDto>) => {
    store.structure = { ...store.structure, ...patch }
  }
  const lineItemsOf = (moduleId: string) =>
    store.structure.line_items.filter((item) => item.module === moduleId)

  server.use(
    http.get("/api/v1/models/:id/structure", () => HttpResponse.json(store.structure)),
    http.post("/api/v1/models/:id/modules", async ({ request }) => {
      await gate
      const body = (await request.json()) as Schemas["CreateModuleRequest"]
      store.requests.push({ action: "create module", body })
      if (store.structure.modules.some((module) => module.name === body.name)) {
        return nameTaken()
      }
      const module: ModuleDto = {
        id: nextId(),
        name: body.name,
        functional_area: body.functional_area ?? "",
        axes: body.axes,
      }
      change({ modules: [...store.structure.modules, module] })
      return HttpResponse.json(module, { status: 201 })
    }),
    http.patch("/api/v1/models/:id/modules/:moduleId", async ({ params, request }) => {
      await gate
      const body = (await request.json()) as Schemas["UpdateModuleRequest"]
      store.requests.push({ action: "update module", id: String(params.moduleId), body })
      const module = store.structure.modules.find((candidate) => candidate.id === params.moduleId)
      if (!module) {
        return problem(404, "not_found", "Not found.")
      }
      if (
        body.name &&
        store.structure.modules.some((other) => other.id !== module.id && other.name === body.name)
      ) {
        return nameTaken()
      }
      const updated: ModuleDto = {
        ...module,
        ...(body.name != null && { name: body.name }),
        ...(body.functional_area != null && { functional_area: body.functional_area }),
        ...(body.axes != null && { axes: body.axes }),
      }
      change({
        modules: store.structure.modules.map((candidate) =>
          candidate.id === module.id ? updated : candidate,
        ),
      })
      return HttpResponse.json(updated)
    }),
    http.delete("/api/v1/models/:id/modules/:moduleId", async ({ params }) => {
      await gate
      store.requests.push({ action: "delete module", id: String(params.moduleId) })
      change({
        modules: store.structure.modules.filter((module) => module.id !== params.moduleId),
        line_items: store.structure.line_items.filter((item) => item.module !== params.moduleId),
      })
      return new HttpResponse(null, { status: 204 })
    }),
    http.post("/api/v1/models/:id/modules/:moduleId/line-items", async ({ params, request }) => {
      await gate
      const body = (await request.json()) as Schemas["CreateLineItemRequest"]
      store.requests.push({ action: "create line item", id: String(params.moduleId), body })
      const siblings = lineItemsOf(String(params.moduleId))
      if (siblings.some((item) => item.name === body.name)) {
        return nameTaken()
      }
      const created: LineItemDto = {
        id: nextId(),
        module: String(params.moduleId),
        name: body.name,
        notes: body.notes ?? "",
        ordinal: body.ordinal ?? Math.max(-1, ...siblings.map((item) => item.ordinal)) + 1,
        format: body.format ?? {
          type: "number",
          decimals: 0,
          thousands_sep: true,
          unit: { type: "none" },
          negative: "minus",
        },
        summary: body.summary ?? { method: "sum" },
        time_scale: body.time_scale ?? "module",
        versions: body.versions ?? "module",
      }
      change({ line_items: [...store.structure.line_items, created] })
      return HttpResponse.json(created, { status: 201 })
    }),
    http.patch("/api/v1/models/:id/line-items/:lineItemId", async ({ params, request }) => {
      await gate
      const body = (await request.json()) as Schemas["UpdateLineItemRequest"]
      store.requests.push({ action: "update line item", id: String(params.lineItemId), body })
      const current = lineItem(params.lineItemId)
      if (!current) {
        return problem(404, "not_found", "Not found.")
      }
      if (body.formula) {
        const problems = store.checkFormula(body.formula)
        if (problems.length > 0) {
          return HttpResponse.json(
            {
              type: "about:blank",
              title: "Unprocessable Entity",
              status: 422,
              code: problems[0].code,
              detail:
                problems.length === 1
                  ? problems[0].message
                  : `The formula has ${problems.length} problems.`,
              errors: problems.map(({ start, end, message }) => ({
                field: "formula",
                message: `${start}-${end}: ${message}`,
              })),
              formula_errors: problems,
            },
            { status: 422, headers: { "content-type": "application/problem+json" } },
          )
        }
      }
      if (
        body.name &&
        lineItemsOf(current.module).some(
          (other) => other.id !== current.id && other.name === body.name,
        )
      ) {
        return nameTaken()
      }
      // A field that is absent stays as it is, a null one is cleared.
      const updated = { ...current } as Record<string, unknown>
      for (const [field, value] of Object.entries(body)) {
        if (value === null) {
          delete updated[field]
        } else {
          updated[field] = value
        }
      }
      change({
        line_items: store.structure.line_items.map((item) =>
          item.id === current.id ? (updated as unknown as LineItemDto) : item,
        ),
      })
      return HttpResponse.json(updated)
    }),
    http.delete("/api/v1/models/:id/line-items/:lineItemId", async ({ params }) => {
      await gate
      store.requests.push({ action: "delete line item", id: String(params.lineItemId) })
      change({
        line_items: store.structure.line_items.filter((item) => item.id !== params.lineItemId),
      })
      return new HttpResponse(null, { status: 204 })
    }),
    http.post("/api/v1/models/:id/line-items/reorder", async ({ request }) => {
      await gate
      const body = (await request.json()) as Schemas["ReorderLineItemsRequest"]
      store.requests.push({ action: "reorder", id: body.module_id, body })
      change({
        line_items: store.structure.line_items.map((item) =>
          item.module === body.module_id ? { ...item, ordinal: body.ids.indexOf(item.id) } : item,
        ),
      })
      return new HttpResponse(null, { status: 204 })
    }),
    http.post("/api/v1/models/:id/query", async ({ request }) => {
      const query = (await request.json()) as ViewQuery
      return HttpResponse.json({
        row_dims: query.rows,
        column_dims: query.columns,
        pages: [],
        rows: [],
        columns: [],
        total_rows: 0,
        total_columns: 0,
        cells: [],
        line_items: lineItemsOf(query.module).map((item) => ({
          id: item.id,
          name: item.name,
          format: item.format,
          is_input: !item.formula,
          dims: [],
          errors: store.formulaErrors[item.id] ?? [],
        })),
        seq: 1,
      })
    }),
  )
  return store
}
