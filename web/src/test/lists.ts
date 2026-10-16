import { screen } from "@testing-library/react"
import type userEvent from "@testing-library/user-event"
import { HttpResponse, http } from "msw"
import type { StructureDto } from "@/features/structure/types"
import type { components } from "@/lib/api/schema"
import { makeModel, me, mockSession, renderApp, serveModels, workspace } from "./app"
import { problem } from "./problem"
import { server } from "./server"
import { makeLineItem, makeStructure } from "./structure"

type Schemas = components["schemas"]
type StructureList = StructureDto["lists"][number]

export const regionsList = "0192f3a0-0000-7000-8000-000000000501"
export const countriesList = "0192f3a0-0000-7000-8000-000000000502"
export const productsList = "0192f3a0-0000-7000-8000-000000000503"
export const emea = "0192f3a0-0000-7000-8000-000000000601"
export const apac = "0192f3a0-0000-7000-8000-000000000602"
export const france = "0192f3a0-0000-7000-8000-000000000611"
export const germany = "0192f3a0-0000-7000-8000-000000000612"
export const japan = "0192f3a0-0000-7000-8000-000000000613"

function makeList(overrides: Partial<StructureList> & Pick<StructureList, "id" | "name">) {
  return {
    numbered: false,
    production_data: false,
    selective_access: false,
    items: [],
    ...overrides,
  } satisfies StructureList
}

/** Regions with a top level, Countries below them, and Products with a subset: the lists screens' usual model. */
export function listsStructure(): StructureDto {
  return makeStructure({
    lists: [
      makeList({
        id: regionsList,
        name: "Regions",
        top_level_name: "All regions",
        items: [
          { id: emea, name: "EMEA", code: "R1" },
          { id: apac, name: "APAC", code: "R2" },
        ],
      }),
      makeList({
        id: countriesList,
        name: "Countries",
        parent: regionsList,
        items: [
          { id: france, name: "France", code: "FR", parent: emea },
          { id: germany, name: "Germany", code: "DE", parent: emea },
          { id: japan, name: "Japan", code: "JP", parent: apac },
        ],
      }),
      makeList({
        id: productsList,
        name: "Products",
        production_data: true,
        items: [
          { id: "0192f3a0-0000-7000-8000-000000000621", name: "Widgets" },
          { id: "0192f3a0-0000-7000-8000-000000000622", name: "Gadgets" },
        ],
      }),
    ],
    subsets: [
      {
        id: "0192f3a0-0000-7000-8000-000000000701",
        name: "Core products",
        list: productsList,
        items: ["0192f3a0-0000-7000-8000-000000000621"],
      },
    ],
  })
}

export interface Write {
  method: string
  path: string
  body?: unknown
}

export interface ListsStore {
  structure: StructureDto
  /** Every write the page made, in order, as the server saw it. */
  writes: Write[]
}

let counter = 0
const newId = () => `0192f3a0-0000-7000-8000-${String(900000000000 + ++counter)}`

function toItem(item: StructureList["items"][number]): Schemas["ItemDto"] {
  return { id: item.id, name: item.name, code: item.code ?? null, parent_id: item.parent ?? null }
}

/**
 * Serves the lists, items and subsets endpoints from `store.structure`, which the writes change the
 * way the server would: names stay unique unless the list is numbered, a list with a parent list
 * wants a parent for every item, and an item with child items cannot be deleted. Call it after
 * `mockSession`; a test can `server.use` a handler of its own to make one request fail.
 */
export function serveLists(structure: StructureDto = listsStructure()): ListsStore {
  const store: ListsStore = { structure, writes: [] }
  const list = (id: unknown) => store.structure.lists.find((candidate) => candidate.id === id)
  const replaceList = (id: string, change: (list: StructureList) => StructureList) => {
    store.structure = {
      ...store.structure,
      lists: store.structure.lists.map((other) => (other.id === id ? change(other) : other)),
    }
  }
  const record = async (request: Request, path: string) => {
    const body = request.method === "DELETE" ? undefined : await request.clone().json()
    store.writes.push({ method: request.method, path, body })
    return body
  }
  const notFound = () => problem(404, "not_found", "Not found.")

  server.use(
    http.get("/api/v1/models/:id/structure", () => HttpResponse.json(store.structure)),
    http.get("/api/v1/models/:id/lists/:listId/items", ({ params }) => {
      const found = list(params.listId)
      return found ? HttpResponse.json(found.items.map(toItem)) : notFound()
    }),
    http.post("/api/v1/models/:id/lists", async ({ request }) => {
      const body = (await record(request, "lists")) as Schemas["CreateListRequest"]
      if (
        store.structure.lists.some((other) => other.name.toLowerCase() === body.name.toLowerCase())
      ) {
        return problem(409, "structure.name_taken", `A list named ${body.name} already exists.`)
      }
      const created: StructureList = makeList({
        id: newId(),
        name: body.name,
        parent: body.parent_list_id,
        top_level_name: body.top_level_name,
        numbered: body.numbered,
        production_data: body.production_data,
      })
      store.structure = { ...store.structure, lists: [...store.structure.lists, created] }
      return HttpResponse.json(
        {
          id: created.id,
          name: created.name,
          parent_list_id: created.parent,
          top_level_name: created.top_level_name,
          numbered: created.numbered,
          production_data: created.production_data,
          selective_access: false,
        },
        { status: 201 },
      )
    }),
    http.patch("/api/v1/models/:id/lists/:listId", async ({ params, request }) => {
      const body = (await record(request, `lists/${params.listId}`)) as Schemas["UpdateListRequest"]
      const found = list(params.listId)
      if (!found) {
        return notFound()
      }
      const updated: StructureList = {
        ...found,
        ...(body.name != null && { name: body.name }),
        ...("top_level_name" in body && { top_level_name: body.top_level_name }),
        ...(body.production_data != null && { production_data: body.production_data }),
      }
      replaceList(found.id, () => updated)
      return HttpResponse.json({ id: updated.id, name: updated.name })
    }),
    http.delete("/api/v1/models/:id/lists/:listId", async ({ params, request }) => {
      await record(request, `lists/${params.listId}`)
      const inUse =
        store.structure.lists.some((other) => other.parent === params.listId) ||
        store.structure.subsets.some((subset) => subset.list === params.listId)
      if (inUse) {
        return problem(409, "structure.in_use", "The list is used by a subset or another list.")
      }
      store.structure = {
        ...store.structure,
        lists: store.structure.lists.filter((other) => other.id !== params.listId),
      }
      return new HttpResponse(null, { status: 204 })
    }),
    http.post("/api/v1/models/:id/lists/:listId/items", async ({ params, request }) => {
      const body = (await record(
        request,
        `lists/${params.listId}/items`,
      )) as Schemas["CreateItemsRequest"]
      const found = list(params.listId)
      if (!found) {
        return notFound()
      }
      const parentList = found.parent ? list(found.parent) : undefined
      const taken = new Set(found.items.map((item) => item.name.toLowerCase()))
      const created: StructureList["items"] = []
      for (const [index, input] of body.items.entries()) {
        const name = input.name.trim()
        if (!found.numbered && taken.has(name.toLowerCase())) {
          return problem(409, "structure.name_taken", `The name ${name} is taken.`)
        }
        if (parentList && !parentList.items.some((item) => item.id === input.parent_id)) {
          return problem(
            422,
            "structure.invalid",
            "The parent item does not exist in the parent list.",
            {
              errors: [
                {
                  field: `items[${index}].parent_id`,
                  message: "The parent item does not exist in the parent list.",
                },
              ],
            },
          )
        }
        taken.add(name.toLowerCase())
        created.push({
          id: newId(),
          name,
          ...(input.code && { code: input.code }),
          ...(input.parent_id && { parent: input.parent_id }),
        })
      }
      replaceList(found.id, (other) => ({ ...other, items: [...other.items, ...created] }))
      return HttpResponse.json(created.map(toItem), { status: 201 })
    }),
    http.patch("/api/v1/models/:id/lists/:listId/items/:itemId", async ({ params, request }) => {
      const body = (await record(
        request,
        `lists/${params.listId}/items/${params.itemId}`,
      )) as Schemas["UpdateItemRequest"]
      const found = list(params.listId)
      const current = found?.items.find((item) => item.id === params.itemId)
      if (!found || !current) {
        return notFound()
      }
      if (
        body.name != null &&
        !found.numbered &&
        found.items.some(
          (item) => item.id !== current.id && item.name.toLowerCase() === body.name?.toLowerCase(),
        )
      ) {
        return problem(409, "structure.name_taken", `The name ${body.name} is taken.`)
      }
      const updated = {
        ...current,
        ...(body.name != null && { name: body.name.trim() }),
        ...("code" in body && { code: body.code ?? undefined }),
        ...("parent_id" in body && { parent: body.parent_id ?? undefined }),
      }
      replaceList(found.id, (other) => ({
        ...other,
        items: other.items.map((item) => (item.id === current.id ? updated : item)),
      }))
      return HttpResponse.json(toItem(updated))
    }),
    http.post("/api/v1/models/:id/lists/:listId/items/delete", async ({ params, request }) => {
      const body = (await record(
        request,
        `lists/${params.listId}/items/delete`,
      )) as Schemas["DeleteItemsRequest"]
      const found = list(params.listId)
      if (!found) {
        return notFound()
      }
      const orphan = store.structure.lists
        .filter((child) => child.parent === found.id)
        .flatMap((child) => child.items)
        .find((item) => item.parent && body.ids.includes(item.parent))
      if (orphan) {
        return problem(
          422,
          "structure.invalid",
          `Items that still have child items cannot be deleted; delete '${orphan.name}' first.`,
        )
      }
      store.structure = {
        ...store.structure,
        lists: store.structure.lists.map((other) =>
          other.id === found.id
            ? { ...other, items: other.items.filter((item) => !body.ids.includes(item.id)) }
            : other,
        ),
        subsets: store.structure.subsets.map((subset) => ({
          ...subset,
          items: subset.items.filter((id) => !body.ids.includes(id)),
        })),
      }
      return new HttpResponse(null, { status: 204 })
    }),
    http.post("/api/v1/models/:id/modules/:moduleId/line-items", async ({ params, request }) => {
      const body = (await record(
        request,
        `modules/${params.moduleId}/line-items`,
      )) as Schemas["CreateLineItemRequest"]
      const moduleId = String(params.moduleId)
      const owner = list(moduleId)
      const modules = store.structure.modules
      // A list's id stands in for the module of its properties, which exists from the first one.
      const created = makeLineItem({
        id: newId(),
        module: moduleId,
        name: body.name,
        ordinal: store.structure.line_items.filter((item) => item.module === moduleId).length,
        ...(body.format && { format: body.format }),
      })
      store.structure = {
        ...store.structure,
        modules:
          owner && !modules.some((module) => module.id === moduleId)
            ? [
                ...modules,
                {
                  id: moduleId,
                  name: `${owner.name} Properties`,
                  functional_area: "System",
                  axes: [{ kind: "list", list: owner.id }],
                },
              ]
            : modules,
        line_items: [...store.structure.line_items, created],
      }
      return HttpResponse.json(created, { status: 201 })
    }),
    http.post("/api/v1/models/:id/subsets", async ({ request }) => {
      const body = (await record(request, "subsets")) as Schemas["CreateSubsetRequest"]
      if (
        store.structure.subsets.some(
          (subset) => subset.name.toLowerCase() === body.name.toLowerCase(),
        )
      ) {
        return problem(409, "structure.name_taken", `A subset named ${body.name} already exists.`)
      }
      const created = {
        id: newId(),
        name: body.name,
        list: body.list_id,
        items: body.item_ids ?? [],
      }
      store.structure = { ...store.structure, subsets: [...store.structure.subsets, created] }
      return HttpResponse.json(
        { id: created.id, name: created.name, list_id: created.list, item_ids: created.items },
        { status: 201 },
      )
    }),
    http.patch("/api/v1/models/:id/subsets/:subsetId", async ({ params, request }) => {
      const body = (await record(
        request,
        `subsets/${params.subsetId}`,
      )) as Schemas["UpdateSubsetRequest"]
      const current = store.structure.subsets.find((subset) => subset.id === params.subsetId)
      if (!current) {
        return notFound()
      }
      const updated = {
        ...current,
        ...(body.name != null && { name: body.name }),
        ...(body.item_ids != null && { items: body.item_ids }),
      }
      store.structure = {
        ...store.structure,
        subsets: store.structure.subsets.map((subset) =>
          subset.id === current.id ? updated : subset,
        ),
      }
      return HttpResponse.json({
        id: updated.id,
        name: updated.name,
        list_id: updated.list,
        item_ids: updated.items,
      })
    }),
    http.delete("/api/v1/models/:id/subsets/:subsetId", async ({ params, request }) => {
      await record(request, `subsets/${params.subsetId}`)
      store.structure = {
        ...store.structure,
        subsets: store.structure.subsets.filter((subset) => subset.id !== params.subsetId),
      }
      return new HttpResponse(null, { status: 204 })
    }),
  )
  return store
}

interface ListsAppOptions {
  role?: components["schemas"]["WorkspaceRole"]
  mode?: "dev" | "prod"
  structure?: StructureDto
}

/**
 * Signs in as a member of the workspace with this role, serves a model in this mode and the lists
 * endpoints from `structure`, and renders the app at `path` inside the model (`/lists`,
 * `/lists/<id>?tab=properties`). Mock whatever else the page asks for, such as the view query,
 * before calling it.
 */
export function openListsApp(
  path: string,
  { role = "admin", mode = "dev", structure = listsStructure() }: ListsAppOptions = {},
) {
  const model = makeModel()
  mockSession({ me: { ...me, workspaces: [{ ...workspace, role }] } })
  serveModels([{ ...model, mode }])
  const store = serveLists(structure)
  return { store, ...renderApp(`/m/${model.id}${path}`) }
}

/** Opens a combobox and chooses the option whose name starts with `option`. */
export async function chooseOption(
  typist: ReturnType<typeof userEvent.setup>,
  combobox: HTMLElement,
  option: string,
) {
  await typist.click(combobox)
  await typist.click(await screen.findByRole("option", { name: new RegExp(`^${option}`) }))
}
