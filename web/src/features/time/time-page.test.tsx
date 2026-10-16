import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { HttpResponse, delay, http } from "msw"
import { toast } from "sonner"
import { describe, expect, it, vi } from "vitest"
import type { StructureDto } from "@/features/structure/types"
import type { components } from "@/lib/api/schema"
import { makeModel, me, mockSession, renderApp, serveModels, workspace } from "@/test/app"
import { problem } from "@/test/problem"
import { server } from "@/test/server"
import { makeStructure } from "@/test/structure"
import { monthLabelsFor } from "@/features/time/timeline"
import { serveStructureStore } from "@/test/structure-edits"

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

type CalendarDto = components["schemas"]["CalendarDto"]
type CreateTimeRangeRequest = components["schemas"]["CreateTimeRangeRequest"]

const model = makeModel({ name: "Revenue plan" })
const api = `/api/v1/models/${model.id}`
const PRODUCTION_MESSAGE =
  "This model is in production mode. Structural changes arrive through ALM sync."

const forecastYears = {
  id: "0192f3a0-0000-7000-8000-000000000501",
  name: "Forecast years",
  first_year: 2027,
  years: 2,
}
const longRange = {
  id: "0192f3a0-0000-7000-8000-000000000502",
  name: "Long range",
  first_year: 2026,
  years: 10,
}

function openTime(
  initial: StructureDto = makeStructure(),
  {
    role = "admin",
    mode = "dev",
  }: { role?: components["schemas"]["WorkspaceRole"]; mode?: "dev" | "prod" } = {},
) {
  mockSession({ me: { ...me, workspaces: [{ ...workspace, role }] } })
  serveModels([{ ...model, mode }])
  const store = serveStructureStore(initial)
  renderApp(`/m/${model.id}/time`)
  return store
}

async function findCard(name: string) {
  const heading = await screen.findByRole("heading", { level: 2, name })
  return within(heading.closest("[data-slot=card]") as HTMLElement)
}

async function chooseOption(
  typist: ReturnType<typeof userEvent.setup>,
  combobox: HTMLElement,
  option: string,
) {
  await typist.click(combobox)
  await typist.click(await screen.findByRole("option", { name: option }))
}

/** What the server answers to a calendar change, and how the structure is then. */
function serveCalendar(store: { structure: StructureDto }, onBody = vi.fn()) {
  server.use(
    http.put(`${api}/calendar`, async ({ request }) => {
      const body = (await request.json()) as CalendarDto
      onBody(body)
      const calendar = {
        first_year: body.first_year,
        fiscal_year_start_month: body.fiscal_year_start_month,
        years: body.years,
      }
      const month_labels = monthLabelsFor(calendar)
      const current = body.current_period ? month_labels.indexOf(body.current_period) : -1
      store.structure = {
        ...store.structure,
        calendar: { ...calendar, current_month: current < 0 ? null : current },
        month_labels,
      }
      return HttpResponse.json(body)
    }),
  )
  return onBody
}

describe("the time page", () => {
  it("titles the page and sits in the Build navigation", async () => {
    openTime()

    expect(await screen.findByRole("heading", { level: 1, name: "Time" })).toBeVisible()
    expect(document.title).toBe("Time · OpenPlan")
    const nav = within(await screen.findByRole("navigation", { name: "Build" }))
    expect(nav.getByRole("link", { name: "Time" })).toHaveAttribute("aria-current", "page")
    const crumbs = within(screen.getByRole("navigation", { name: "breadcrumb" }))
    expect(await crumbs.findByText("Time")).toHaveAttribute("aria-current", "page")
  })

  it("outlines the page: a heading for the calendar, the preview and the time ranges", async () => {
    openTime()
    await screen.findByRole("heading", { level: 1, name: "Time" })

    expect(
      (await screen.findAllByRole("heading", { level: 2 })).map((heading) => heading.textContent),
    ).toEqual(["Calendar", "Timeline preview", "Time ranges"])
  })

  describe("the calendar", () => {
    it("shows the saved calendar", async () => {
      openTime(
        makeStructure({
          calendar: {
            first_year: 2027,
            fiscal_year_start_month: 4,
            years: 2,
            current_month: 5,
          },
          month_labels: monthLabelsFor({ first_year: 2027, fiscal_year_start_month: 4, years: 2 }),
        }),
      )
      const calendar = await findCard("Calendar")

      expect(calendar.getByRole("combobox", { name: "Fiscal year starts" })).toHaveTextContent(
        "April",
      )
      expect(calendar.getByRole("spinbutton", { name: "First fiscal year" })).toHaveValue(2027)
      expect(calendar.getByRole("spinbutton", { name: "Years" })).toHaveValue(2)
      expect(calendar.getByRole("combobox", { name: "Current period" })).toHaveTextContent("Sep 26")
    })

    it("shows no current period as None", async () => {
      openTime()
      const calendar = await findCard("Calendar")

      expect(calendar.getByRole("combobox", { name: "Current period" })).toHaveTextContent("None")
    })

    it("names the label of the first fiscal year as it is typed", async () => {
      const typist = userEvent.setup()
      openTime()
      const calendar = await findCard("Calendar")
      const firstYear = calendar.getByRole("spinbutton", { name: "First fiscal year" })

      expect(calendar.getByText(/Shown as FY26\./)).toBeVisible()
      await typist.clear(firstYear)
      await typist.type(firstYear, "2127")
      expect(calendar.getByText(/Shown as FY27\./)).toBeVisible()
      await typist.clear(firstYear)
      expect(calendar.queryByText(/Shown as/)).not.toBeInTheDocument()
    })

    it("lists the twelve months to start the fiscal year in and every month of the calendar for the current period", async () => {
      const typist = userEvent.setup()
      openTime()
      const calendar = await findCard("Calendar")

      await typist.click(calendar.getByRole("combobox", { name: "Fiscal year starts" }))
      expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual([
        "January",
        "February",
        "March",
        "April",
        "May",
        "June",
        "July",
        "August",
        "September",
        "October",
        "November",
        "December",
      ])
      await typist.keyboard("{Escape}")
      await typist.click(calendar.getByRole("combobox", { name: "Current period" }))
      const options = screen.getAllByRole("option").map((option) => option.textContent)
      expect(options).toHaveLength(37)
      expect(options.slice(0, 3)).toEqual(["None", "Jan 26", "Feb 26"])
      expect(options.at(-1)).toBe("Dec 28")
    })

    it("keeps Save changes disabled until something changes", async () => {
      const typist = userEvent.setup()
      openTime()
      const calendar = await findCard("Calendar")

      const save = calendar.getByRole("button", { name: "Save changes" })
      expect(save).toBeDisabled()
      await typist.type(calendar.getByRole("spinbutton", { name: "Years" }), "0")
      expect(save).toBeEnabled()
    })

    it("refuses 21 years before asking the server", async () => {
      const typist = userEvent.setup()
      const store = openTime()
      const put = serveCalendar(store)
      const calendar = await findCard("Calendar")
      const years = calendar.getByRole("spinbutton", { name: "Years" })

      await typist.clear(years)
      await typist.type(years, "21")
      await typist.click(calendar.getByRole("button", { name: "Save changes" }))

      expect(await calendar.findByText("Years must be between 1 and 20.")).toBeVisible()
      expect(years).toBeInvalid()
      expect(years).toHaveAccessibleDescription(expect.stringContaining("Years must be between"))
      expect(put).not.toHaveBeenCalled()
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument()
    })

    it.each([
      ["First fiscal year", "0", "First fiscal year must be between 1 and 9999."],
      ["First fiscal year", "10000", "First fiscal year must be between 1 and 9999."],
      ["Years", "0", "Years must be between 1 and 20."],
      ["First fiscal year", "", "First fiscal year is required."],
      ["Years", "1.5", "Years must be a whole number."],
    ])("refuses %s of %j", async (label, value, message) => {
      const typist = userEvent.setup()
      const store = openTime()
      const put = serveCalendar(store)
      const calendar = await findCard("Calendar")
      const input = calendar.getByRole("spinbutton", { name: label })

      await typist.clear(input)
      if (value) {
        await typist.type(input, value)
      }
      await typist.click(calendar.getByRole("button", { name: "Save changes" }))

      expect(await calendar.findByText(message)).toBeVisible()
      expect(put).not.toHaveBeenCalled()
    })

    it("saves a new first year or current period without asking", async () => {
      const typist = userEvent.setup()
      const store = openTime()
      const put = serveCalendar(store)
      const calendar = await findCard("Calendar")

      await chooseOption(
        typist,
        calendar.getByRole("combobox", { name: "Current period" }),
        "Jun 26",
      )
      await typist.click(calendar.getByRole("button", { name: "Save changes" }))

      await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Calendar saved"))
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument()
      expect(put).toHaveBeenCalledWith({
        fiscal_year_start_month: 1,
        first_year: 2026,
        years: 3,
        current_period: "Jun 26",
      })
      expect(calendar.getByRole("combobox", { name: "Current period" })).toHaveTextContent("Jun 26")
      expect(calendar.getByRole("button", { name: "Save changes" })).toBeDisabled()
    })

    it("clears the current period when None is chosen", async () => {
      const typist = userEvent.setup()
      const store = openTime(
        makeStructure({ calendar: { ...makeStructure().calendar, current_month: 2 } }),
      )
      const put = serveCalendar(store)
      const calendar = await findCard("Calendar")
      expect(calendar.getByRole("combobox", { name: "Current period" })).toHaveTextContent("Mar 26")

      await chooseOption(typist, calendar.getByRole("combobox", { name: "Current period" }), "None")
      await typist.click(calendar.getByRole("button", { name: "Save changes" }))

      await waitFor(() => expect(put).toHaveBeenCalled())
      expect(put).toHaveBeenCalledWith(expect.objectContaining({ current_period: null }))
    })

    it.each([
      ["the month the fiscal year starts in", "Fiscal year starts", "April"],
      ["the number of years", "Years", "5"],
    ])("asks before changing %s", async (_, label, value) => {
      const typist = userEvent.setup()
      const store = openTime()
      const put = serveCalendar(store)
      const calendar = await findCard("Calendar")

      if (label === "Years") {
        const years = calendar.getByRole("spinbutton", { name: label })
        await typist.clear(years)
        await typist.type(years, value)
      } else {
        await chooseOption(typist, calendar.getByRole("combobox", { name: label }), value)
      }
      await typist.click(calendar.getByRole("button", { name: "Save changes" }))

      const dialog = await screen.findByRole("alertdialog", { name: "Change the timeline?" })
      expect(
        within(dialog).getByText(
          "Changing the timeline clears input values on line items that use Time.",
        ),
      ).toBeVisible()
      expect(put).not.toHaveBeenCalled()
    })

    it("drops nothing when the change of timeline is cancelled", async () => {
      const typist = userEvent.setup()
      const store = openTime()
      const put = serveCalendar(store)
      const calendar = await findCard("Calendar")
      await chooseOption(
        typist,
        calendar.getByRole("combobox", { name: "Fiscal year starts" }),
        "April",
      )
      await typist.click(calendar.getByRole("button", { name: "Save changes" }))

      await typist.click(
        within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Cancel" }),
      )

      await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument())
      expect(put).not.toHaveBeenCalled()
      expect(calendar.getByRole("combobox", { name: "Fiscal year starts" })).toHaveTextContent(
        "April",
      )
      expect(calendar.getByRole("button", { name: "Save changes" })).toBeEnabled()
      expect(calendar.getByRole("button", { name: "Save changes" })).toHaveFocus()
    })

    it("changes the timeline once confirmed, and the preview follows", async () => {
      const typist = userEvent.setup()
      const store = openTime()
      const put = serveCalendar(store)
      const calendar = await findCard("Calendar")
      await chooseOption(
        typist,
        calendar.getByRole("combobox", { name: "Fiscal year starts" }),
        "April",
      )
      const first = calendar.getByRole("spinbutton", { name: "First fiscal year" })
      await typist.clear(first)
      await typist.type(first, "2027")
      await typist.click(calendar.getByRole("button", { name: "Save changes" }))

      await typist.click(
        within(await screen.findByRole("alertdialog", { name: "Change the timeline?" })).getByRole(
          "button",
          { name: "Change timeline" },
        ),
      )

      await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Calendar saved"))
      expect(put).toHaveBeenCalledWith({
        fiscal_year_start_month: 4,
        first_year: 2027,
        years: 3,
        current_period: null,
      })
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument()
      const table = within(screen.getByRole("table", { name: "Timeline preview" }))
      expect(table.getByRole("row", { name: /^FY27/ })).toHaveTextContent("Apr 26 – Mar 27")
      expect(calendar.getByRole("combobox", { name: "Fiscal year starts" })).toHaveTextContent(
        "April",
      )
    })

    it("keeps the dialog open while the change is saved", async () => {
      const typist = userEvent.setup()
      openTime()
      server.use(
        http.put(`${api}/calendar`, async () => {
          await delay(300)
          return HttpResponse.json({
            fiscal_year_start_month: 4,
            first_year: 2026,
            years: 3,
            current_period: null,
          })
        }),
      )
      const calendar = await findCard("Calendar")
      await chooseOption(
        typist,
        calendar.getByRole("combobox", { name: "Fiscal year starts" }),
        "April",
      )
      await typist.click(calendar.getByRole("button", { name: "Save changes" }))
      const dialog = within(await screen.findByRole("alertdialog"))

      await typist.click(dialog.getByRole("button", { name: "Change timeline" }))

      expect(dialog.getByRole("button", { name: "Change timeline" })).toBeDisabled()
      expect(dialog.getByRole("button", { name: "Cancel" })).toBeDisabled()
      await typist.keyboard("{Escape}")
      expect(screen.getByRole("alertdialog")).toBeVisible()
      await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument())
    })

    it("disables Save changes while the change is saved", async () => {
      const typist = userEvent.setup()
      openTime()
      server.use(
        http.put(`${api}/calendar`, async () => {
          await delay(300)
          return HttpResponse.json({
            fiscal_year_start_month: 1,
            first_year: 2030,
            years: 3,
            current_period: null,
          })
        }),
      )
      const calendar = await findCard("Calendar")
      const first = calendar.getByRole("spinbutton", { name: "First fiscal year" })
      await typist.clear(first)
      await typist.type(first, "2030")

      await typist.click(calendar.getByRole("button", { name: "Save changes" }))

      expect(calendar.getByRole("button", { name: "Save changes" })).toBeDisabled()
      await waitFor(() => expect(toast.success).toHaveBeenCalled())
    })

    it("shows what the server refuses under the input it names", async () => {
      const typist = userEvent.setup()
      openTime(makeStructure({ calendar: { ...makeStructure().calendar, current_month: 2 } }))
      server.use(
        http.put(`${api}/calendar`, () =>
          problem(422, "validation", "Some fields are invalid.", {
            errors: [
              {
                field: "current_period",
                message: "Current period must be a month of the calendar, such as Jan 26.",
              },
            ],
          }),
        ),
      )
      const calendar = await findCard("Calendar")
      const first = calendar.getByRole("spinbutton", { name: "First fiscal year" })
      await typist.clear(first)
      await typist.type(first, "2030")
      await typist.click(calendar.getByRole("button", { name: "Save changes" }))

      expect(
        await calendar.findByText(
          "Current period must be a month of the calendar, such as Jan 26.",
        ),
      ).toBeVisible()
      expect(calendar.getByRole("combobox", { name: "Current period" })).toBeInvalid()
      expect(toast.error).not.toHaveBeenCalled()
    })

    it("closes the dialog and shows a refusal of a timeline change", async () => {
      const typist = userEvent.setup()
      openTime(makeStructure({ calendar: { ...makeStructure().calendar, current_month: 2 } }))
      server.use(
        http.put(`${api}/calendar`, () =>
          problem(422, "validation", "Some fields are invalid.", {
            errors: [
              { field: "current_period", message: "Current period is not on the timeline." },
            ],
          }),
        ),
      )
      const calendar = await findCard("Calendar")
      await chooseOption(
        typist,
        calendar.getByRole("combobox", { name: "Fiscal year starts" }),
        "April",
      )
      await typist.click(calendar.getByRole("button", { name: "Save changes" }))
      await typist.click(
        within(await screen.findByRole("alertdialog")).getByRole("button", {
          name: "Change timeline",
        }),
      )

      expect(await calendar.findByText("Current period is not on the timeline.")).toBeVisible()
      await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument())
      expect(calendar.getByRole("combobox", { name: "Current period" })).toHaveFocus()
    })

    it("says so in a toast when the calendar cannot be saved", async () => {
      const typist = userEvent.setup()
      openTime()
      server.use(
        http.put(`${api}/calendar`, () => problem(500, "internal", "The database is starting up.")),
      )
      const calendar = await findCard("Calendar")
      const first = calendar.getByRole("spinbutton", { name: "First fiscal year" })
      await typist.clear(first)
      await typist.type(first, "2030")
      await typist.click(calendar.getByRole("button", { name: "Save changes" }))

      await waitFor(() => expect(toast.error).toHaveBeenCalledWith("The database is starting up."))
      expect(calendar.getByRole("button", { name: "Save changes" })).toBeEnabled()
    })
  })

  describe("the timeline preview while the calendar is edited", () => {
    function previewRows() {
      return within(screen.getByRole("table", { name: "Timeline preview" }))
        .getAllByRole("row")
        .slice(1)
    }

    function previewDescription() {
      const heading = screen.getByRole("heading", { level: 2, name: "Timeline preview" })
      return (heading.closest("[data-slot=card]") as HTMLElement).querySelector(
        "[data-slot=card-description]",
      )
    }

    it("follows the form before it is saved", async () => {
      const typist = userEvent.setup()
      const store = openTime()
      const put = serveCalendar(store)
      const calendar = await findCard("Calendar")
      await screen.findByRole("table", { name: "Timeline preview" })
      expect(previewRows()).toHaveLength(3)
      expect(previewRows()[0]).toHaveTextContent("Jan 26 – Dec 26")
      expect(previewDescription()).toHaveTextContent("The timeline, one row per fiscal year.")

      await chooseOption(
        typist,
        calendar.getByRole("combobox", { name: "Fiscal year starts" }),
        "April",
      )
      const years = calendar.getByRole("spinbutton", { name: "Years" })
      await typist.clear(years)
      await typist.type(years, "2")
      const first = calendar.getByRole("spinbutton", { name: "First fiscal year" })
      await typist.clear(first)
      await typist.type(first, "2027")

      expect(previewRows()).toHaveLength(2)
      expect(previewRows()[0]).toHaveTextContent("FY27")
      expect(previewRows()[0]).toHaveTextContent("Apr 26 – Mar 27")
      expect(previewRows()[0]).toHaveTextContent("Q1 FY27")
      expect(previewRows()[1]).toHaveTextContent("FY28")
      expect(previewRows()[1]).toHaveTextContent("Apr 27 – Mar 28")
      expect(previewDescription()).toHaveTextContent(
        "One row per fiscal year. Follows the form; save to keep it.",
      )
      expect(put).not.toHaveBeenCalled()
    })

    it("falls back to the saved years while the field is not a valid number", async () => {
      const typist = userEvent.setup()
      openTime()
      const calendar = await findCard("Calendar")
      const years = calendar.getByRole("spinbutton", { name: "Years" })
      await typist.clear(years)
      await typist.type(years, "2")
      expect(previewRows()).toHaveLength(2)

      await typist.type(years, "1")
      expect(previewRows()).toHaveLength(3)

      await typist.clear(years)
      expect(previewRows()).toHaveLength(3)

      await typist.type(years, "4")
      expect(previewRows()).toHaveLength(4)
    })

    it("goes back to the saved timeline when the changes are undone", async () => {
      const typist = userEvent.setup()
      openTime()
      const calendar = await findCard("Calendar")
      const years = calendar.getByRole("spinbutton", { name: "Years" })
      await typist.clear(years)
      await typist.type(years, "5")
      expect(previewRows()).toHaveLength(5)

      await typist.clear(years)
      await typist.type(years, "3")

      expect(previewRows()).toHaveLength(3)
      expect(previewDescription()).toHaveTextContent("The timeline, one row per fiscal year.")
    })

    it("does not move for a change of the current period alone", async () => {
      const typist = userEvent.setup()
      openTime()
      const calendar = await findCard("Calendar")

      await chooseOption(
        typist,
        calendar.getByRole("combobox", { name: "Current period" }),
        "Jun 26",
      )

      expect(previewDescription()).toHaveTextContent("The timeline, one row per fiscal year.")
    })

    it("shows a viewer the saved timeline", async () => {
      openTime(
        makeStructure({
          calendar: { first_year: 2027, fiscal_year_start_month: 4, years: 2 },
          month_labels: monthLabelsFor({ first_year: 2027, fiscal_year_start_month: 4, years: 2 }),
        }),
        { role: "viewer" },
      )
      await screen.findByRole("table", { name: "Timeline preview" })

      expect(previewRows()).toHaveLength(2)
      expect(previewRows()[0]).toHaveTextContent("Apr 26 – Mar 27")
      expect(previewDescription()).toHaveTextContent("The timeline, one row per fiscal year.")
    })
  })

  describe("the timeline preview", () => {
    it("shows a row for each fiscal year of a calendar that starts in January", async () => {
      openTime()
      const table = within(await screen.findByRole("table", { name: "Timeline preview" }))

      expect(table.getAllByRole("columnheader").map((header) => header.textContent)).toEqual([
        "Fiscal year",
        "Months",
        "Quarters",
      ])
      const rows = table.getAllByRole("row").slice(1)
      expect(rows).toHaveLength(3)
      expect(within(rows[0]).getAllByRole("cell")[0]).toHaveTextContent(/^FY26/)
      expect(within(rows[1]).getAllByRole("cell")[0]).toHaveTextContent(/^FY27/)
      expect(within(rows[2]).getAllByRole("cell")[0]).toHaveTextContent(/^FY28/)
      expect(within(rows[0]).getAllByRole("cell")[1]).toHaveTextContent("Jan 26 – Dec 26")
      expect(within(rows[2]).getAllByRole("cell")[1]).toHaveTextContent("Jan 28 – Dec 28")
    })

    it("labels the months and quarters of a fiscal year that starts in April", async () => {
      openTime(
        makeStructure({
          calendar: { first_year: 2027, fiscal_year_start_month: 4, years: 2 },
          month_labels: monthLabelsFor({ first_year: 2027, fiscal_year_start_month: 4, years: 2 }),
        }),
      )
      const table = within(await screen.findByRole("table", { name: "Timeline preview" }))

      const rows = table.getAllByRole("row").slice(1)
      expect(rows).toHaveLength(2)
      const [year, months, quarters] = within(rows[0]).getAllByRole("cell")
      expect(year).toHaveTextContent("FY27")
      expect(months).toHaveTextContent("Apr 26 – Mar 27")
      expect(
        within(quarters)
          .getAllByText(/^Q\d FY27$/)
          .map((quarter) => quarter.textContent),
      ).toEqual(["Q1 FY27", "Q2 FY27", "Q3 FY27", "Q4 FY27"])
      expect(within(rows[1]).getAllByRole("cell")[1]).toHaveTextContent("Apr 27 – Mar 28")
      expect(within(rows[1]).getAllByRole("cell")[0]).toHaveTextContent("FY28")
    })

    it("labels fiscal years across a century with two digits", async () => {
      openTime(
        makeStructure({
          calendar: { first_year: 2099, fiscal_year_start_month: 1, years: 2 },
          month_labels: monthLabelsFor({ first_year: 2099, fiscal_year_start_month: 1, years: 2 }),
        }),
      )
      const table = within(await screen.findByRole("table", { name: "Timeline preview" }))

      const rows = table.getAllByRole("row").slice(1)
      expect(within(rows[0]).getAllByRole("cell")[0]).toHaveTextContent(/^FY99/)
      expect(within(rows[1]).getAllByRole("cell")[0]).toHaveTextContent(/^FY00/)
    })
  })

  describe("the time ranges", () => {
    it("lists each range with its first year and years", async () => {
      openTime(makeStructure({ time_ranges: [forecastYears, longRange] }))
      const ranges = await findCard("Time ranges")

      const table = within(ranges.getByRole("table", { name: "Time ranges" }))
      expect(table.getAllByRole("columnheader").map((header) => header.textContent)).toEqual([
        "Name",
        "First year",
        "Years",
        "Actions",
      ])
      const rows = table.getAllByRole("row").slice(1)
      expect(
        rows.map((row) =>
          within(row)
            .getAllByRole("cell")
            .map((cell) => cell.textContent),
        ),
      ).toEqual([
        ["Forecast years", "2027", "2", ""],
        ["Long range", "2026", "10", ""],
      ])
    })

    it("sets the numbers right-aligned", async () => {
      openTime(makeStructure({ time_ranges: [forecastYears] }))
      const ranges = await findCard("Time ranges")

      const table = within(ranges.getByRole("table", { name: "Time ranges" }))
      expect(table.getByRole("columnheader", { name: "First year" })).toHaveClass("text-right")
      expect(table.getByRole("columnheader", { name: "Years" })).toHaveClass("text-right")
      const row = within(table.getByRole("row", { name: /Forecast years/ }))
      expect(row.getByRole("cell", { name: "2027" })).toHaveClass("text-right")
      expect(row.getByRole("cell", { name: "2" })).toHaveClass("text-right")
    })

    it("says there are none yet, with the one button to add a range", async () => {
      openTime()
      const ranges = await findCard("Time ranges")

      expect(ranges.getByRole("heading", { level: 3, name: "No time ranges yet" })).toBeVisible()
      expect(
        ranges.getByText(
          "A time range is a run of fiscal years that a module can use instead of the calendar.",
        ),
      ).toBeVisible()
      expect(ranges.getAllByRole("button", { name: "Add time range" })).toHaveLength(1)
      expect(ranges.queryByRole("table")).not.toBeInTheDocument()
    })

    it("adds a range from the empty list, starting from the calendar", async () => {
      const typist = userEvent.setup()
      const store = openTime()
      const posted = vi.fn()
      server.use(
        http.post(`${api}/time-ranges`, async ({ request }) => {
          const body = (await request.json()) as CreateTimeRangeRequest
          posted(body)
          const created = { id: longRange.id, ...body }
          store.structure = {
            ...store.structure,
            time_ranges: [...store.structure.time_ranges, created],
          }
          return HttpResponse.json(created, { status: 201 })
        }),
      )
      const ranges = await findCard("Time ranges")
      await typist.click(ranges.getByRole("button", { name: "Add time range" }))

      const dialog = within(await screen.findByRole("dialog", { name: "Add time range" }))
      expect(dialog.getByLabelText("Name")).toHaveFocus()
      expect(dialog.getByLabelText("First year")).toHaveValue(2026)
      expect(dialog.getByLabelText("Years")).toHaveValue(3)
      await typist.type(dialog.getByLabelText("Name"), "  Long range ")
      await typist.clear(dialog.getByLabelText("Years"))
      await typist.type(dialog.getByLabelText("Years"), "10")
      await typist.click(dialog.getByRole("button", { name: "Add time range" }))

      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
      expect(posted).toHaveBeenCalledWith({ name: "Long range", first_year: 2026, years: 10 })
      expect(toast.success).toHaveBeenCalledWith("Time range added")
      expect(await ranges.findByRole("row", { name: /Long range/ })).toBeVisible()
      expect(ranges.getByRole("button", { name: "Add time range" })).toHaveFocus()
    })

    it("refuses a range without a name or with too many years", async () => {
      const typist = userEvent.setup()
      openTime()
      const posted = vi.fn()
      server.use(http.post(`${api}/time-ranges`, () => posted()))
      const ranges = await findCard("Time ranges")
      await typist.click(ranges.getByRole("button", { name: "Add time range" }))
      const dialog = within(await screen.findByRole("dialog"))
      await typist.clear(dialog.getByLabelText("Years"))
      await typist.type(dialog.getByLabelText("Years"), "21")

      await typist.click(dialog.getByRole("button", { name: "Add time range" }))

      expect(await dialog.findByText("Name is required.")).toBeVisible()
      expect(dialog.getByText("Years must be between 1 and 20.")).toBeVisible()
      expect(posted).not.toHaveBeenCalled()
    })

    it("shows a name that is taken under the name", async () => {
      const typist = userEvent.setup()
      openTime(makeStructure({ time_ranges: [forecastYears] }))
      server.use(
        http.post(`${api}/time-ranges`, () =>
          problem(409, "structure.name_taken", "Time range name already in use: Forecast years."),
        ),
      )
      const ranges = await findCard("Time ranges")
      await typist.click(ranges.getByRole("button", { name: "Add time range" }))
      const dialog = within(await screen.findByRole("dialog"))
      await typist.type(dialog.getByLabelText("Name"), "Forecast years")

      await typist.click(dialog.getByRole("button", { name: "Add time range" }))

      expect(
        await dialog.findByText("Time range name already in use: Forecast years."),
      ).toBeVisible()
      expect(dialog.getByLabelText("Name")).toBeInvalid()
      expect(dialog.getByLabelText("Name")).toHaveFocus()
    })

    it("keeps the dialog while the range is added", async () => {
      const typist = userEvent.setup()
      openTime()
      server.use(
        http.post(`${api}/time-ranges`, async () => {
          await delay(300)
          return HttpResponse.json(longRange, { status: 201 })
        }),
      )
      const ranges = await findCard("Time ranges")
      await typist.click(ranges.getByRole("button", { name: "Add time range" }))
      const dialog = within(await screen.findByRole("dialog"))
      await typist.type(dialog.getByLabelText("Name"), "Long range")

      await typist.click(dialog.getByRole("button", { name: "Add time range" }))

      expect(dialog.getByRole("button", { name: "Add time range" })).toBeDisabled()
      expect(dialog.getByRole("button", { name: "Cancel" })).toBeDisabled()
      await typist.keyboard("{Escape}")
      expect(screen.getByRole("dialog")).toBeVisible()
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
    })

    it("deletes a range after asking", async () => {
      const typist = userEvent.setup()
      const store = openTime(makeStructure({ time_ranges: [forecastYears, longRange] }))
      const deleted = vi.fn()
      server.use(
        http.delete(`${api}/time-ranges/:rangeId`, ({ params }) => {
          deleted(params.rangeId)
          store.structure = {
            ...store.structure,
            time_ranges: store.structure.time_ranges.filter((range) => range.id !== params.rangeId),
          }
          return new HttpResponse(null, { status: 204 })
        }),
      )
      const ranges = await findCard("Time ranges")

      await typist.click(ranges.getByRole("button", { name: "Delete Forecast years" }))

      const dialog = within(
        await screen.findByRole("alertdialog", { name: "Delete Forecast years?" }),
      )
      expect(deleted).not.toHaveBeenCalled()
      await typist.click(dialog.getByRole("button", { name: "Delete time range" }))

      await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument())
      expect(deleted).toHaveBeenCalledWith(forecastYears.id)
      expect(toast.success).toHaveBeenCalledWith("Time range deleted")
      expect(ranges.queryByRole("row", { name: /Forecast years/ })).not.toBeInTheDocument()
      expect(ranges.getByRole("button", { name: "Delete Long range" })).toHaveFocus()
    })

    it("keeps a range that a module uses and says why", async () => {
      const typist = userEvent.setup()
      openTime(makeStructure({ time_ranges: [forecastYears] }))
      server.use(
        http.delete(`${api}/time-ranges/:rangeId`, () =>
          problem(
            409,
            "structure.in_use",
            "Time range 'Forecast years' is used by module 'Revenue'.",
          ),
        ),
      )
      const ranges = await findCard("Time ranges")
      await typist.click(ranges.getByRole("button", { name: "Delete Forecast years" }))

      await typist.click(
        within(await screen.findByRole("alertdialog")).getByRole("button", {
          name: "Delete time range",
        }),
      )

      await waitFor(() =>
        expect(toast.error).toHaveBeenCalledWith(
          "Time range 'Forecast years' is used by module 'Revenue'.",
        ),
      )
      const dialog = within(screen.getByRole("alertdialog"))
      expect(dialog.getByRole("button", { name: "Delete time range" })).toBeEnabled()
      await typist.click(dialog.getByRole("button", { name: "Cancel" }))
      expect(await ranges.findByRole("row", { name: /Forecast years/ })).toBeVisible()
    })
  })

  describe("who can change it", () => {
    it.each(["viewer", "planner"] as const)("shows a %s the settings as text", async (role) => {
      openTime(
        makeStructure({
          calendar: { first_year: 2027, fiscal_year_start_month: 4, years: 2, current_month: 5 },
          month_labels: monthLabelsFor({ first_year: 2027, fiscal_year_start_month: 4, years: 2 }),
          time_ranges: [forecastYears],
        }),
        { role },
      )
      const calendar = await findCard("Calendar")

      expect(
        calendar.getByText("Only workspace admins and builders can change the calendar."),
      ).toBeVisible()
      const terms = calendar.getAllByRole("term").map((term) => term.textContent)
      expect(terms).toEqual(["Fiscal year starts", "First fiscal year", "Years", "Current period"])
      const details = calendar.getAllByRole("definition").map((detail) => detail.textContent)
      expect(details).toEqual(["April", "FY27 (2027)", "2", "Sep 26"])
      expect(screen.queryByRole("combobox")).not.toBeInTheDocument()
      expect(screen.queryByRole("spinbutton")).not.toBeInTheDocument()
      expect(
        screen.queryByRole("button", { name: /Save changes|Add time range|Delete/ }),
      ).not.toBeInTheDocument()
      const ranges = within(screen.getByRole("table", { name: "Time ranges" }))
      expect(ranges.getAllByRole("columnheader").map((header) => header.textContent)).toEqual([
        "Name",
        "First year",
        "Years",
      ])
      expect(ranges.getByRole("row", { name: /Forecast years/ })).toBeVisible()
      expect(screen.getByRole("table", { name: "Timeline preview" })).toBeVisible()
    })

    it("says None for no current period, and no time ranges, without a button to add one", async () => {
      openTime(makeStructure(), { role: "viewer" })
      const calendar = await findCard("Calendar")

      expect(calendar.getAllByRole("definition")[3]).toHaveTextContent("None")
      const ranges = await findCard("Time ranges")
      expect(ranges.getByRole("heading", { level: 3, name: "No time ranges yet" })).toBeVisible()
      expect(ranges.queryByRole("button")).not.toBeInTheDocument()
    })

    it("keeps the controls of a production model disabled and explains why", async () => {
      const typist = userEvent.setup()
      openTime(makeStructure({ time_ranges: [forecastYears] }), { mode: "prod" })
      const calendar = await findCard("Calendar")

      expect(await screen.findByText(PRODUCTION_MESSAGE)).toBeVisible()
      expect(calendar.getByRole("combobox", { name: "Fiscal year starts" })).toBeDisabled()
      expect(calendar.getByRole("spinbutton", { name: "First fiscal year" })).toBeDisabled()
      expect(calendar.getByRole("spinbutton", { name: "Years" })).toBeDisabled()
      expect(calendar.getByRole("combobox", { name: "Current period" })).toBeDisabled()
      expect(calendar.getByRole("button", { name: "Save changes" })).toBeDisabled()
      const ranges = await findCard("Time ranges")
      expect(ranges.getByRole("button", { name: "Add time range" })).toBeDisabled()
      expect(ranges.getByRole("button", { name: "Delete Forecast years" })).toBeDisabled()

      await typist.hover(
        ranges.getByRole("button", { name: "Add time range" }).parentElement as HTMLElement,
      )
      expect(await screen.findByRole("tooltip")).toHaveTextContent(PRODUCTION_MESSAGE)
    })

    it("does not mention production mode for a model in dev mode", async () => {
      openTime()
      await findCard("Calendar")

      expect(screen.queryByText(PRODUCTION_MESSAGE)).not.toBeInTheDocument()
    })

    it("does not mention production mode to a viewer", async () => {
      openTime(makeStructure(), { role: "viewer", mode: "prod" })
      await findCard("Calendar")

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
          return HttpResponse.json(makeStructure())
        }),
      )
      renderApp(`/m/${model.id}/time`)

      expect(await screen.findByRole("heading", { level: 1, name: "Time" })).toBeVisible()
      expect(await screen.findByRole("status", { name: "Loading time settings" })).toBeVisible()
      release()

      expect(await screen.findByRole("table", { name: "Timeline preview" })).toBeVisible()
      expect(
        screen.queryByRole("status", { name: "Loading time settings" }),
      ).not.toBeInTheDocument()
    })

    it("waits for the user's role before it draws the calendar, rather than showing a builder text", async () => {
      mockSession()
      serveModels([model])
      serveStructureStore(makeStructure())
      let release!: () => void
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      server.use(
        http.get(`/api/v1/models/${model.id}`, async () => {
          await gate
          return HttpResponse.json(model)
        }),
      )
      renderApp(`/m/${model.id}/time`)

      expect(await screen.findByRole("status", { name: "Loading time settings" })).toBeVisible()
      expect(screen.queryByText(/Only workspace admins and builders/)).not.toBeInTheDocument()
      release()

      expect(await screen.findByRole("combobox", { name: "Fiscal year starts" })).toBeVisible()
    })

    it("says so and offers a retry when the structure cannot be loaded", async () => {
      const typist = userEvent.setup()
      mockSession()
      serveModels([model])
      server.use(
        http.get(`${api}/structure`, () =>
          problem(500, "internal", "The database is starting up."),
        ),
      )
      renderApp(`/m/${model.id}/time`)
      const page = within(await screen.findByRole("main"))
      expect(await page.findByRole("alert")).toHaveTextContent("The database is starting up.")
      serveStructureStore(makeStructure())

      await typist.click(page.getByRole("button", { name: "Retry" }))

      expect(await screen.findByRole("table", { name: "Timeline preview" })).toBeVisible()
    })
  })
})
