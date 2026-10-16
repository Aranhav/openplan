import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { HttpResponse, delay, http } from "msw"
import { toast } from "sonner"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { StructureDto } from "@/features/structure/types"
import type { components } from "@/lib/api/schema"
import { makeModel, me, mockSession, renderApp, serveModels, workspace } from "@/test/app"
import { problem } from "@/test/problem"
import { server } from "@/test/server"
import { actualId, forecastId, makeStructure } from "@/test/structure"
import { serveStructureStore } from "@/test/structure-edits"

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

type VersionRequest = components["schemas"]["VersionRequest"]
type VersionDto = StructureDto["versions"][number]

const budgetId = "0192f3a0-0000-7000-8000-000000000203"
const model = makeModel({ name: "Revenue plan" })
const api = `/api/v1/models/${model.id}`
const PRODUCTION_MESSAGE =
  "This model is in production mode. Structural changes arrive through ALM sync."

const actual: VersionDto = { id: actualId, name: "Actual", is_actual: true, is_current: false }
const budget: VersionDto = {
  id: budgetId,
  name: "Budget",
  is_actual: false,
  is_current: true,
  switchover: 3,
}
const forecast: VersionDto = {
  id: forecastId,
  name: "Forecast",
  is_actual: false,
  is_current: false,
}

type Typist = ReturnType<typeof userEvent.setup>

function openVersions(
  versions = [actual, budget, forecast],
  {
    role = "admin",
    mode = "dev",
  }: { role?: components["schemas"]["WorkspaceRole"]; mode?: "dev" | "prod" } = {},
) {
  mockSession({ me: { ...me, workspaces: [{ ...workspace, role }] } })
  serveModels([{ ...model, mode }])
  const store = serveStructureStore(makeStructure({ versions }))
  renderApp(`/m/${model.id}/versions`)
  return store
}

/** Answers a version being saved the way the server does: the flags move to the version. */
function serveVersionSaves(store: { structure: StructureDto }, onBody = vi.fn()) {
  server.use(
    http.put(`${api}/versions/:versionId`, async ({ params, request }) => {
      const body = (await request.json()) as VersionRequest
      onBody(body, params.versionId)
      const switchover = body.switchover
        ? store.structure.month_labels.indexOf(body.switchover)
        : null
      store.structure = {
        ...store.structure,
        versions: store.structure.versions.map((version) => {
          if (version.id !== params.versionId) {
            return {
              ...version,
              is_actual: version.is_actual && !body.is_actual,
              is_current: version.is_current && !body.is_current,
            }
          }
          return {
            id: version.id,
            name: body.name,
            is_actual: body.is_actual,
            is_current: body.is_current,
            switchover,
          }
        }),
      }
      return HttpResponse.json({ id: params.versionId, ...body })
    }),
  )
  return onBody
}

async function findTable() {
  return within(await screen.findByRole("table", { name: "Versions" }))
}

async function chooseOption(typist: Typist, combobox: HTMLElement, option: string) {
  await typist.click(combobox)
  await typist.click(await screen.findByRole("option", { name: option }))
}

describe("the versions page", () => {
  it("titles the page and sits in the Build navigation", async () => {
    openVersions()

    expect(await screen.findByRole("heading", { level: 1, name: "Versions" })).toBeVisible()
    expect(document.title).toBe("Versions · OpenPlan")
    const nav = within(await screen.findByRole("navigation", { name: "Build" }))
    expect(nav.getByRole("link", { name: "Versions" })).toHaveAttribute("aria-current", "page")
    const crumbs = within(screen.getByRole("navigation", { name: "breadcrumb" }))
    expect(await crumbs.findByText("Versions")).toHaveAttribute("aria-current", "page")
  })

  it("explains the switchover", async () => {
    openVersions()

    expect(
      await screen.findByText(
        "Before its switchover month, a version shows the values of the actual version.",
      ),
    ).toBeVisible()
  })

  describe("the table", () => {
    it("lists each version with what it is and when it switches over", async () => {
      openVersions()
      const table = await findTable()

      expect(table.getAllByRole("columnheader").map((header) => header.textContent)).toEqual([
        "Name",
        "Actual",
        "Current",
        "Switchover",
        "Actions",
      ])
      const rows = table.getAllByRole("row").slice(1)
      expect(rows.map((row) => within(row).getAllByRole("cell")[0].textContent)).toEqual([
        "Actual",
        "Budget",
        "Forecast",
      ])
      expect(table.getByRole("radio", { name: "Actual, actual version" })).toBeChecked()
      expect(table.getByRole("radio", { name: "Budget, actual version" })).not.toBeChecked()
      expect(table.getByRole("radio", { name: "Budget, current version" })).toBeChecked()
      expect(table.getByRole("radio", { name: "Forecast, current version" })).not.toBeChecked()
      expect(table.getByRole("combobox", { name: "Switchover for Budget" })).toHaveTextContent(
        "Apr 26",
      )
      expect(table.getByRole("combobox", { name: "Switchover for Forecast" })).toHaveTextContent(
        "None",
      )
    })

    it("has no switchover for the actual version", async () => {
      openVersions()
      const table = await findTable()

      const row = within(table.getByRole("row", { name: /^Actual/ }))
      expect(row.getAllByRole("cell")[3]).toHaveTextContent("Not applicable")
      expect(row.queryByRole("combobox")).not.toBeInTheDocument()
    })

    it("lists None and every month of the calendar as a switchover", async () => {
      const typist = userEvent.setup()
      openVersions()
      const table = await findTable()

      await typist.click(table.getByRole("combobox", { name: "Switchover for Forecast" }))

      const options = screen.getAllByRole("option").map((option) => option.textContent)
      expect(options).toHaveLength(37)
      expect(options.slice(0, 3)).toEqual(["None", "Jan 26", "Feb 26"])
      expect(options.at(-1)).toBe("Dec 28")
    })
  })

  describe("on a screen too narrow for a column of the switchover's own", () => {
    const desktopWidth = window.innerWidth

    afterEach(() => {
      window.innerWidth = desktopWidth
    })

    it.each([375, 900, 1023])("puts the switchover under the name at %ipx", async (width) => {
      window.innerWidth = width
      const typist = userEvent.setup()
      const store = openVersions()
      const saved = serveVersionSaves(store)
      const table = await findTable()

      expect(table.getAllByRole("columnheader").map((header) => header.textContent)).toEqual([
        "Name",
        "Actual",
        "Current",
        "Actions",
      ])
      const name = within(
        within(table.getByRole("row", { name: /Forecast/ })).getAllByRole("cell")[0],
      )
      expect(name.getByText("Switchover")).toBeVisible()
      await chooseOption(
        typist,
        name.getByRole("combobox", { name: "Switchover for Forecast" }),
        "Jul 26",
      )
      await waitFor(() => expect(saved).toHaveBeenCalled())
      expect(saved).toHaveBeenCalledWith(
        expect.objectContaining({ switchover: "Jul 26" }),
        forecast.id,
      )
    })

    it("puts a viewer's switchover under the name too", async () => {
      window.innerWidth = 375
      openVersions(undefined, { role: "viewer" })
      const table = await findTable()

      const name = within(
        within(table.getByRole("row", { name: /Budget/ })).getAllByRole("cell")[0],
      )
      expect(name.getByText("Switchover")).toBeVisible()
      expect(name.getByText("Apr 26")).toBeVisible()
      expect(table.getAllByRole("columnheader")).toHaveLength(3)
    })
  })

  describe("renaming", () => {
    async function startRenaming(typist: Typist, name = "Forecast") {
      const table = await findTable()
      await typist.click(table.getByRole("button", { name: `Rename ${name}` }))
      return table
    }

    it("turns the name into an input, with the name selected", async () => {
      const typist = userEvent.setup()
      openVersions()
      const table = await startRenaming(typist)

      const input = table.getByRole("textbox", { name: "Name of Forecast" })
      expect(input).toHaveFocus()
      expect(input).toHaveValue("Forecast")
      expect(input).toHaveProperty("selectionStart", 0)
      expect(input).toHaveProperty("selectionEnd", "Forecast".length)
      expect(table.queryByRole("button", { name: "Rename Forecast" })).not.toBeInTheDocument()
    })

    it("saves the new name on Enter and gives focus back to the name", async () => {
      const typist = userEvent.setup()
      const store = openVersions()
      const saved = serveVersionSaves(store)
      const table = await startRenaming(typist)

      await typist.keyboard("  Latest forecast {Enter}")

      expect(await table.findByRole("button", { name: "Rename Latest forecast" })).toHaveFocus()
      expect(saved).toHaveBeenCalledWith(
        { name: "Latest forecast", is_actual: false, is_current: false, switchover: null },
        forecast.id,
      )
      expect(toast.success).toHaveBeenCalledWith("Version renamed")
      expect(table.queryByRole("textbox")).not.toBeInTheDocument()
    })

    it("keeps the switchover and the flags of the version it renames", async () => {
      const typist = userEvent.setup()
      const store = openVersions()
      const saved = serveVersionSaves(store)
      await startRenaming(typist, "Budget")

      await typist.keyboard("{End}2{Enter}")

      await waitFor(() => expect(saved).toHaveBeenCalled())
      expect(saved).toHaveBeenCalledWith(
        { name: "Budget2", is_actual: false, is_current: true, switchover: "Apr 26" },
        budget.id,
      )
    })

    it("leaves the name alone on Escape and gives focus back", async () => {
      const typist = userEvent.setup()
      const store = openVersions()
      const saved = serveVersionSaves(store)
      const table = await startRenaming(typist)

      await typist.keyboard("Nope{Escape}")

      expect(table.getByRole("button", { name: "Rename Forecast" })).toHaveFocus()
      expect(table.queryByRole("textbox")).not.toBeInTheDocument()
      expect(saved).not.toHaveBeenCalled()
    })

    it("saves when focus leaves the input", async () => {
      const typist = userEvent.setup()
      const store = openVersions()
      const saved = serveVersionSaves(store)
      await startRenaming(typist)

      await typist.keyboard("{End}!")
      await typist.tab()

      await waitFor(() => expect(saved).toHaveBeenCalled())
      expect(saved.mock.calls[0][0]).toMatchObject({ name: "Forecast!" })
    })

    it("does not save a name that has not changed", async () => {
      const typist = userEvent.setup()
      const store = openVersions()
      const saved = serveVersionSaves(store)
      const table = await startRenaming(typist)

      await typist.tab()

      await waitFor(() => expect(table.queryByRole("textbox")).not.toBeInTheDocument())
      expect(saved).not.toHaveBeenCalled()
    })

    it("asks for a name and stays in the input", async () => {
      const typist = userEvent.setup()
      const store = openVersions()
      const saved = serveVersionSaves(store)
      const table = await startRenaming(typist)

      await typist.keyboard("{Backspace}{Enter}")

      expect(await table.findByText("Name is required.")).toBeVisible()
      const input = table.getByRole("textbox", { name: "Name of Forecast" })
      expect(input).toBeInvalid()
      expect(input).toHaveAccessibleDescription("Name is required.")
      expect(input).toHaveFocus()
      expect(saved).not.toHaveBeenCalled()
    })

    it("shows a name that is taken under the input", async () => {
      const typist = userEvent.setup()
      openVersions()
      server.use(
        http.put(`${api}/versions/:versionId`, () =>
          problem(409, "structure.name_taken", "Version name already in use: Budget."),
        ),
      )
      const table = await startRenaming(typist)

      await typist.keyboard("Budget{Enter}")

      expect(await table.findByText("Version name already in use: Budget.")).toBeVisible()
      expect(table.getByRole("textbox", { name: "Name of Forecast" })).toBeInvalid()
      expect(toast.error).not.toHaveBeenCalled()
    })

    it("says so in a toast, and keeps the input, when the name cannot be saved for another reason", async () => {
      const typist = userEvent.setup()
      openVersions()
      server.use(
        http.put(`${api}/versions/:versionId`, () =>
          problem(500, "internal", "The database is starting up."),
        ),
      )
      const table = await startRenaming(typist)

      await typist.keyboard("{End}!{Enter}")

      await waitFor(() => expect(toast.error).toHaveBeenCalledWith("The database is starting up."))
      expect(table.getByRole("textbox", { name: "Name of Forecast" })).toHaveValue("Forecast!")
    })

    it("shows a version that cannot be renamed in production mode as text", async () => {
      openVersions(undefined, { mode: "prod" })
      const table = await findTable()

      expect(table.getByText("Forecast")).toBeVisible()
      expect(table.queryByRole("button", { name: /^Rename/ })).not.toBeInTheDocument()
    })
  })

  describe("choosing the actual and current version", () => {
    it("makes a version the actual one, and clears its switchover", async () => {
      const typist = userEvent.setup()
      const store = openVersions()
      const saved = serveVersionSaves(store)
      const table = await findTable()

      await typist.click(table.getByRole("radio", { name: "Budget, actual version" }))

      await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Actual version updated"))
      expect(saved).toHaveBeenCalledWith(
        { name: "Budget", is_actual: true, is_current: true, switchover: null },
        budget.id,
      )
      expect(table.getByRole("radio", { name: "Budget, actual version" })).toBeChecked()
      expect(table.getByRole("radio", { name: "Actual, actual version" })).not.toBeChecked()
      expect(table.getByRole("row", { name: /^Budget/ })).toHaveTextContent("Not applicable")
    })

    it("makes a version the current one, and keeps its switchover", async () => {
      const typist = userEvent.setup()
      const store = openVersions([
        actual,
        { ...budget, is_current: false },
        { ...forecast, is_current: true, switchover: 6 },
      ])
      const saved = serveVersionSaves(store)
      const table = await findTable()

      await typist.click(table.getByRole("radio", { name: "Budget, current version" }))

      await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Current version updated"))
      expect(saved).toHaveBeenCalledWith(
        { name: "Budget", is_actual: false, is_current: true, switchover: "Apr 26" },
        budget.id,
      )
      expect(table.getByRole("radio", { name: "Budget, current version" })).toBeChecked()
      expect(table.getByRole("radio", { name: "Forecast, current version" })).not.toBeChecked()
    })

    it("shows the choice while it is saved", async () => {
      const typist = userEvent.setup()
      openVersions()
      server.use(
        http.put(`${api}/versions/:versionId`, async ({ params, request }) => {
          await delay(300)
          return HttpResponse.json({ id: params.versionId, ...((await request.json()) as object) })
        }),
      )
      const table = await findTable()

      await typist.click(table.getByRole("radio", { name: "Forecast, current version" }))

      expect(table.getByRole("radio", { name: "Forecast, current version" })).toBeChecked()
      expect(table.getByRole("radio", { name: "Budget, current version" })).not.toBeChecked()
      expect(table.getByRole("status", { name: "Saving Forecast" })).toBeVisible()
      await waitFor(() => expect(toast.success).toHaveBeenCalled())
    })

    it("ignores a second choice while one is saved", async () => {
      const typist = userEvent.setup()
      openVersions()
      const requests = vi.fn()
      server.use(
        http.put(`${api}/versions/:versionId`, async ({ params, request }) => {
          requests()
          await delay(200)
          return HttpResponse.json({ id: params.versionId, ...((await request.json()) as object) })
        }),
      )
      const table = await findTable()

      await typist.click(table.getByRole("radio", { name: "Forecast, current version" }))
      await typist.click(table.getByRole("radio", { name: "Forecast, actual version" }))

      await waitFor(() => expect(toast.success).toHaveBeenCalled())
      expect(requests).toHaveBeenCalledTimes(1)
    })

    it("says so in a toast when the choice is refused", async () => {
      const typist = userEvent.setup()
      openVersions()
      server.use(
        http.put(`${api}/versions/:versionId`, () =>
          problem(422, "structure.invalid", "Exactly one version must be the current version."),
        ),
      )
      const table = await findTable()

      await typist.click(table.getByRole("radio", { name: "Forecast, current version" }))

      await waitFor(() =>
        expect(toast.error).toHaveBeenCalledWith(
          "Exactly one version must be the current version.",
        ),
      )
      expect(table.getByRole("radio", { name: "Budget, current version" })).toBeChecked()
    })
  })

  describe("the switchover", () => {
    it("sets the month a version switches over in", async () => {
      const typist = userEvent.setup()
      const store = openVersions()
      const saved = serveVersionSaves(store)
      const table = await findTable()

      await chooseOption(
        typist,
        table.getByRole("combobox", { name: "Switchover for Forecast" }),
        "Jul 26",
      )

      await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Switchover updated"))
      expect(saved).toHaveBeenCalledWith(
        { name: "Forecast", is_actual: false, is_current: false, switchover: "Jul 26" },
        forecast.id,
      )
      expect(table.getByRole("combobox", { name: "Switchover for Forecast" })).toHaveTextContent(
        "Jul 26",
      )
    })

    it("clears it with None", async () => {
      const typist = userEvent.setup()
      const store = openVersions()
      const saved = serveVersionSaves(store)
      const table = await findTable()

      await chooseOption(
        typist,
        table.getByRole("combobox", { name: "Switchover for Budget" }),
        "None",
      )

      await waitFor(() => expect(saved).toHaveBeenCalled())
      expect(saved).toHaveBeenCalledWith(
        { name: "Budget", is_actual: false, is_current: true, switchover: null },
        budget.id,
      )
      expect(table.getByRole("combobox", { name: "Switchover for Budget" })).toHaveTextContent(
        "None",
      )
    })
  })

  describe("adding", () => {
    it("adds a version by its name", async () => {
      const typist = userEvent.setup()
      const store = openVersions()
      const posted = vi.fn()
      server.use(
        http.post(`${api}/versions`, async ({ request }) => {
          const body = (await request.json()) as VersionRequest
          posted(body)
          const created = {
            id: "0192f3a0-0000-7000-8000-000000000204",
            name: body.name,
            is_actual: false,
            is_current: false,
          }
          store.structure = { ...store.structure, versions: [...store.structure.versions, created] }
          return HttpResponse.json(created, { status: 201 })
        }),
      )
      await findTable()
      await typist.click(screen.getByRole("button", { name: "Add version" }))

      const dialog = within(await screen.findByRole("dialog", { name: "Add version" }))
      expect(dialog.getByLabelText("Name")).toHaveFocus()
      await typist.type(dialog.getByLabelText("Name"), "  Downside ")
      await typist.click(dialog.getByRole("button", { name: "Add version" }))

      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
      expect(posted).toHaveBeenCalledWith({
        name: "Downside",
        is_actual: false,
        is_current: false,
        switchover: null,
      })
      expect(toast.success).toHaveBeenCalledWith("Version added")
      expect(await screen.findByRole("button", { name: "Rename Downside" })).toBeVisible()
      expect(screen.getByRole("button", { name: "Add version" })).toHaveFocus()
    })

    it("asks for a name", async () => {
      const typist = userEvent.setup()
      openVersions()
      const posted = vi.fn()
      server.use(http.post(`${api}/versions`, () => posted()))
      await findTable()
      await typist.click(screen.getByRole("button", { name: "Add version" }))
      const dialog = within(await screen.findByRole("dialog"))

      await typist.click(dialog.getByRole("button", { name: "Add version" }))

      expect(await dialog.findByText("Name is required.")).toBeVisible()
      expect(posted).not.toHaveBeenCalled()
    })

    it("shows a name that is taken under the name", async () => {
      const typist = userEvent.setup()
      openVersions()
      server.use(
        http.post(`${api}/versions`, () =>
          problem(409, "structure.name_taken", "Version name already in use: Budget."),
        ),
      )
      await findTable()
      await typist.click(screen.getByRole("button", { name: "Add version" }))
      const dialog = within(await screen.findByRole("dialog"))
      await typist.type(dialog.getByLabelText("Name"), "Budget")

      await typist.click(dialog.getByRole("button", { name: "Add version" }))

      expect(await dialog.findByText("Version name already in use: Budget.")).toBeVisible()
      expect(dialog.getByLabelText("Name")).toHaveFocus()
    })

    it("keeps the dialog while the version is added", async () => {
      const typist = userEvent.setup()
      openVersions()
      server.use(
        http.post(`${api}/versions`, async () => {
          await delay(300)
          return HttpResponse.json({ ...forecast, name: "Downside" }, { status: 201 })
        }),
      )
      await findTable()
      await typist.click(screen.getByRole("button", { name: "Add version" }))
      const dialog = within(await screen.findByRole("dialog"))
      await typist.type(dialog.getByLabelText("Name"), "Downside")

      await typist.click(dialog.getByRole("button", { name: "Add version" }))

      expect(dialog.getByRole("button", { name: "Add version" })).toBeDisabled()
      expect(dialog.getByRole("button", { name: "Cancel" })).toBeDisabled()
      await typist.keyboard("{Escape}")
      expect(screen.getByRole("dialog")).toBeVisible()
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
    })
  })

  describe("deleting", () => {
    it("deletes a version after asking", async () => {
      const typist = userEvent.setup()
      const store = openVersions()
      const deleted = vi.fn()
      server.use(
        http.delete(`${api}/versions/:versionId`, ({ params }) => {
          deleted(params.versionId)
          store.structure = {
            ...store.structure,
            versions: store.structure.versions.filter((version) => version.id !== params.versionId),
          }
          return new HttpResponse(null, { status: 204 })
        }),
      )
      const table = await findTable()
      await typist.click(table.getByRole("button", { name: "Delete Forecast" }))

      const dialog = within(await screen.findByRole("alertdialog", { name: "Delete Forecast?" }))
      expect(deleted).not.toHaveBeenCalled()
      await typist.click(dialog.getByRole("button", { name: "Delete version" }))

      await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument())
      expect(deleted).toHaveBeenCalledWith(forecast.id)
      expect(toast.success).toHaveBeenCalledWith("Version deleted")
      expect(table.queryByRole("row", { name: /^Forecast/ })).not.toBeInTheDocument()
      expect(table.getByRole("button", { name: "Delete Budget" })).toBeDisabled()
      expect(screen.getByRole("heading", { level: 1, name: "Versions" })).toBeVisible()
    })

    it("keeps focus on the page after the last version that can go", async () => {
      const typist = userEvent.setup()
      const store = openVersions()
      server.use(
        http.delete(`${api}/versions/:versionId`, ({ params }) => {
          store.structure = {
            ...store.structure,
            versions: store.structure.versions.filter((version) => version.id !== params.versionId),
          }
          return new HttpResponse(null, { status: 204 })
        }),
      )
      const table = await findTable()
      await typist.click(table.getByRole("button", { name: "Delete Forecast" }))
      await typist.click(
        within(await screen.findByRole("alertdialog")).getByRole("button", {
          name: "Delete version",
        }),
      )

      await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument())
      expect(screen.getByRole("heading", { level: 1, name: "Versions" })).toHaveFocus()
    })

    it.each([
      ["Actual", "The actual version can't be deleted."],
      ["Budget", "The current version can't be deleted. Make another version current first."],
    ])("does not let the %s version be deleted", async (name, reason) => {
      const typist = userEvent.setup()
      openVersions()
      const table = await findTable()

      const button = table.getByRole("button", { name: `Delete ${name}` })
      expect(button).toBeDisabled()
      expect(button).toHaveAccessibleDescription(reason)
      await typist.hover(button.parentElement as HTMLElement)
      expect(await screen.findByRole("tooltip")).toHaveTextContent(reason)
    })

    it("keeps a version that a line item uses and says why", async () => {
      const typist = userEvent.setup()
      openVersions()
      server.use(
        http.delete(`${api}/versions/:versionId`, () =>
          problem(
            409,
            "structure.in_use",
            "Version 'Forecast' is used by line item 'Revenue.Amount'.",
          ),
        ),
      )
      const table = await findTable()
      await typist.click(table.getByRole("button", { name: "Delete Forecast" }))

      await typist.click(
        within(await screen.findByRole("alertdialog")).getByRole("button", {
          name: "Delete version",
        }),
      )

      await waitFor(() =>
        expect(toast.error).toHaveBeenCalledWith(
          "Version 'Forecast' is used by line item 'Revenue.Amount'.",
        ),
      )
      const dialog = within(screen.getByRole("alertdialog"))
      expect(dialog.getByRole("button", { name: "Delete version" })).toBeEnabled()
      await typist.click(dialog.getByRole("button", { name: "Cancel" }))
      expect(await table.findByRole("row", { name: /^Forecast/ })).toBeVisible()
    })
  })

  describe("who can change them", () => {
    it.each(["viewer", "planner"] as const)("shows a %s the versions as text", async (role) => {
      openVersions(undefined, { role })
      const table = await findTable()

      expect(table.getAllByRole("columnheader").map((header) => header.textContent)).toEqual([
        "Name",
        "Actual",
        "Current",
        "Switchover",
      ])
      const rows = table.getAllByRole("row").slice(1)
      expect(
        rows.map((row) =>
          within(row)
            .getAllByRole("cell")
            .map((cell) => cell.textContent),
        ),
      ).toEqual([
        ["Actual", "Yes", "No", "Not applicable"],
        ["Budget", "No", "Yes", "Apr 26"],
        ["Forecast", "No", "No", "None"],
      ])
      expect(screen.queryByRole("radio")).not.toBeInTheDocument()
      expect(screen.queryByRole("combobox")).not.toBeInTheDocument()
      expect(screen.queryByRole("textbox")).not.toBeInTheDocument()
      expect(screen.queryByRole("button", { name: /^(Add|Delete|Rename)/ })).not.toBeInTheDocument()
    })

    it("keeps the controls of a production model disabled and explains why", async () => {
      const typist = userEvent.setup()
      openVersions(undefined, { mode: "prod" })
      const table = await findTable()

      expect(await screen.findByText(PRODUCTION_MESSAGE)).toBeVisible()
      for (const radio of table.getAllByRole("radio")) {
        expect(radio).toBeDisabled()
      }
      expect(table.getByRole("combobox", { name: "Switchover for Forecast" })).toBeDisabled()
      expect(table.getByRole("button", { name: "Delete Forecast" })).toBeDisabled()
      expect(screen.getByRole("button", { name: "Add version" })).toBeDisabled()

      await typist.hover(
        screen.getByRole("button", { name: "Add version" }).parentElement as HTMLElement,
      )
      expect(await screen.findByRole("tooltip")).toHaveTextContent(PRODUCTION_MESSAGE)
    })

    it("does not mention production mode for a model in dev mode or to a viewer", async () => {
      openVersions()
      await findTable()
      expect(screen.queryByText(PRODUCTION_MESSAGE)).not.toBeInTheDocument()
    })

    it("does not mention production mode to a viewer", async () => {
      openVersions(undefined, { role: "viewer", mode: "prod" })
      await findTable()
      expect(screen.queryByText(PRODUCTION_MESSAGE)).not.toBeInTheDocument()
    })
  })

  describe("while it loads or fails", () => {
    it("shows placeholders while the structure loads", async () => {
      mockSession()
      serveModels([model])
      let release!: () => void
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      server.use(
        http.get(`${api}/structure`, async () => {
          await gate
          return HttpResponse.json(makeStructure({ versions: [actual, budget, forecast] }))
        }),
      )
      renderApp(`/m/${model.id}/versions`)

      expect(await screen.findByRole("heading", { level: 1, name: "Versions" })).toBeVisible()
      expect(await screen.findByRole("status", { name: "Loading versions" })).toBeVisible()
      release()

      expect(await screen.findByRole("table", { name: "Versions" })).toBeVisible()
      expect(screen.queryByRole("status", { name: "Loading versions" })).not.toBeInTheDocument()
    })

    it("says so and offers a retry when the versions cannot be loaded", async () => {
      const typist = userEvent.setup()
      mockSession()
      serveModels([model])
      server.use(
        http.get(`${api}/structure`, () =>
          problem(500, "internal", "The database is starting up."),
        ),
      )
      renderApp(`/m/${model.id}/versions`)
      const page = within(await screen.findByRole("main"))
      expect(await page.findByRole("alert")).toHaveTextContent("The database is starting up.")
      serveStructureStore(makeStructure({ versions: [actual, budget, forecast] }))

      await typist.click(page.getByRole("button", { name: "Retry" }))

      expect(await screen.findByRole("table", { name: "Versions" })).toBeVisible()
    })

    it("says so when the model has no versions", async () => {
      openVersions([])

      expect(
        await screen.findByRole("heading", { level: 2, name: "No versions yet" }),
      ).toBeVisible()
      expect(screen.queryByRole("table")).not.toBeInTheDocument()
    })
  })
})
