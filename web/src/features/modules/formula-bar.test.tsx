import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { HttpResponse, http } from "msw"
import { useState } from "react"
import { toast } from "sonner"
import { describe, expect, it, vi } from "vitest"
import { useStructure } from "@/features/structure/api"
import { formulaText, formulaView, setFormula } from "@/test/formula"
import { serveModuleStore } from "@/test/module-edits"
import { problem } from "@/test/problem"
import { renderWithProviders } from "@/test/render"
import { server } from "@/test/server"
import { revenueAmount, structure, unitsSold } from "@/test/structure"
import { FormulaBar } from "./formula-bar"

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const MODEL = "0192f3a0-0000-7000-8000-000000000010"

/** The bar as a screen has it: the line item comes from the structure, which a save makes new. */
function Screen({
  canEdit = true,
  locked = false,
  initial = revenueAmount.id,
}: {
  canEdit?: boolean
  locked?: boolean
  /** The line item selected at first; none for `null`. */
  initial?: string | null
}) {
  const [selected, setSelected] = useState(initial)
  const { data } = useStructure(MODEL)
  if (!data) {
    return null
  }
  return (
    <>
      <button type="button" onClick={() => setSelected(unitsSold.id)}>
        Select units
      </button>
      <button type="button" onClick={() => setSelected(revenueAmount.id)}>
        Select revenue
      </button>
      <FormulaBar
        modelId={MODEL}
        lineItem={data.line_items.find((item) => item.id === selected)}
        canEdit={canEdit}
        locked={locked}
      />
    </>
  )
}

function renderBar(props: Parameters<typeof Screen>[0] = {}) {
  const store = serveModuleStore(structure)
  renderWithProviders(<Screen {...props} />)
  return store
}

const editor = (name = "Formula of Revenue amount") => screen.findByRole("textbox", { name })

/** Whether a button shows the spinner that says its request is running. */
function spinning(button: HTMLElement) {
  return button.querySelector("svg.animate-spin") !== null
}

describe("the formula bar", () => {
  it("shows fx, the name of the line item and its formula", async () => {
    renderBar()

    const input = await editor()
    expect(formulaText(input)).toBe("Units sold * Pricing.Unit price")
    const bar = screen.getByRole("group", { name: "Formula bar" })
    expect(within(bar).getByText("fx")).toBeVisible()
    expect(within(bar).getByText("Revenue amount")).toBeVisible()
    expect(within(bar).queryByRole("button")).toBeNull()
  })

  it("asks to select a line item when there is none", async () => {
    renderBar({ initial: null })

    expect(await screen.findByText("Select a line item to see its formula.")).toBeVisible()
    expect(screen.queryByRole("textbox")).toBeNull()
  })

  it("offers Save and Cancel only once the formula is edited", async () => {
    renderBar()
    const input = await editor()

    setFormula(input, "Units sold * 2")
    expect(await screen.findByRole("button", { name: "Save" })).toBeEnabled()
    expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled()

    setFormula(input, "Units sold * Pricing.Unit price")
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull()
  })

  it("saves on Save, says so, and leaves the formula as saved", async () => {
    const typist = userEvent.setup()
    const store = renderBar()
    setFormula(await editor(), "Units sold * 2")

    await typist.click(await screen.findByRole("button", { name: "Save" }))

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Formula saved"))
    expect(store.requests).toEqual([
      { action: "update line item", id: revenueAmount.id, body: { formula: "Units sold * 2" } },
    ])
    await waitFor(() => expect(screen.queryByRole("button", { name: "Save" })).toBeNull())
    expect(formulaText(await editor())).toBe("Units sold * 2")
  })

  it("saves on Enter", async () => {
    const typist = userEvent.setup()
    const store = renderBar()
    const input = await editor()
    setFormula(input, "Units sold * 3")

    await typist.click(input)
    await typist.keyboard("{Enter}")

    await waitFor(() => expect(store.requests).toHaveLength(1))
    expect(store.requests[0].body).toEqual({ formula: "Units sold * 3" })
  })

  describe("a formula for an input line item", () => {
    async function typeFormula() {
      const typist = userEvent.setup()
      const store = renderBar({ initial: unitsSold.id })
      setFormula(await editor("Formula of Units sold"), "1 + 1")
      await typist.click(await screen.findByRole("button", { name: "Save" }))
      return { typist, store, confirm: await screen.findByRole("alertdialog") }
    }

    it("is confirmed first, since it clears the values typed into the line item", async () => {
      const { typist, store, confirm } = await typeFormula()

      expect(within(confirm).getByText("Clear input values?")).toBeVisible()
      expect(store.requests).toEqual([])
      await typist.click(within(confirm).getByRole("button", { name: "Save and clear values" }))

      await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Formula saved"))
      expect(store.requests).toEqual([
        { action: "update line item", id: unitsSold.id, body: { formula: "1 + 1" } },
      ])
      await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull())
    })

    it("is kept, unsaved, when the question is answered with Cancel", async () => {
      const { typist, store, confirm } = await typeFormula()

      await typist.click(within(confirm).getByRole("button", { name: "Cancel" }))

      await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull())
      expect(store.requests).toEqual([])
      expect(formulaText(await editor("Formula of Units sold"))).toBe("1 + 1")
      expect(screen.getByRole("button", { name: "Save" })).toBeVisible()
    })

    it("is not asked about when the line item already has a formula", async () => {
      const typist = userEvent.setup()
      const store = renderBar()
      setFormula(await editor(), "")
      await typist.click(await screen.findByRole("button", { name: "Save" }))

      await waitFor(() => expect(store.requests).toHaveLength(1))
      expect(screen.queryByRole("alertdialog")).toBeNull()
    })
  })

  it("makes the line item an input again when the formula is emptied", async () => {
    const typist = userEvent.setup()
    const store = renderBar()
    setFormula(await editor(), "")

    await typist.click(await screen.findByRole("button", { name: "Save" }))

    await waitFor(() => expect(store.requests[0].body).toEqual({ formula: null }))
  })

  it("shows that it is saving, and keeps what was typed until the server answers", async () => {
    const typist = userEvent.setup()
    const store = renderBar()
    const release = store.hold()
    setFormula(await editor(), "Units sold * 2")

    await typist.click(await screen.findByRole("button", { name: "Save" }))

    await waitFor(() => expect(screen.getByRole("button", { name: "Save" })).toBeDisabled())
    expect(spinning(screen.getByRole("button", { name: "Save" }))).toBe(true)
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled()
    release()
    await waitFor(() => expect(toast.success).toHaveBeenCalled())
  })

  it("gives up the change on Cancel and on Escape", async () => {
    const typist = userEvent.setup()
    const store = renderBar()
    const input = await editor()

    setFormula(input, "Units sold * 2")
    await typist.click(await screen.findByRole("button", { name: "Cancel" }))
    expect(formulaText(input)).toBe("Units sold * Pricing.Unit price")
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull()

    setFormula(input, "Units sold * 5")
    await typist.click(input)
    await typist.keyboard("{Escape}")
    expect(formulaText(input)).toBe("Units sold * Pricing.Unit price")
    expect(store.requests).toEqual([])
  })

  it("shows what the server refuses a formula for, in the formula, and selects the first problem", async () => {
    const typist = userEvent.setup()
    const store = renderBar()
    store.checkFormula = () => [
      {
        code: "formula.unknown_name",
        message: "Unknown name 'Revnue'.",
        start: 4,
        end: 10,
        suggestion: "Revenue",
      },
      { code: "formula.arity", message: "SUM takes 1 argument.", start: 13, end: 20 },
    ]
    const input = await editor()
    setFormula(input, "1 + Revnue + SUM(1, 2)")

    await typist.click(await screen.findByRole("button", { name: "Save" }))

    const alert = within(await screen.findByRole("alert"))
    expect(alert.getByText("The formula has 2 problems.")).toBeVisible()
    expect(alert.getByText(/Did you mean 'Revenue'\?/)).toBeVisible()
    expect(input).toHaveAttribute("aria-invalid", "true")
    expect(input).toHaveFocus()
    const { from, to } = formulaView(input).state.selection.main
    expect([from, to]).toEqual([4, 10])
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled()
    expect(toast.error).not.toHaveBeenCalled()
    // The formula is marked where the problems are, as the list says.
    await waitFor(() => {
      const marked = [...document.querySelectorAll(".cm-lintRange-error")].map((mark) => mark.textContent)
      expect(marked).toEqual(["Revnue", "SUM(1, "])
    })
  })

  it("says in a toast when the save fails for another reason", async () => {
    const typist = userEvent.setup()
    renderBar()
    server.use(
      http.patch("/api/v1/models/:id/line-items/:lineItemId", () =>
        problem(500, "internal", "The database is starting up."),
      ),
    )
    setFormula(await editor(), "Units sold * 2")

    await typist.click(await screen.findByRole("button", { name: "Save" }))

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("The database is starting up."))
    expect(screen.queryByRole("alert")).toBeNull()
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled()
  })

  it("shows the problems the model found in the saved formula", async () => {
    const store = serveModuleStore(structure)
    store.formulaErrors[revenueAmount.id] = [
      {
        code: "formula.unknown_name",
        message: "Unknown name 'Pricing.Unit price'.",
        start: 13,
        end: 31,
        suggestion: null,
      },
    ]
    renderWithProviders(<Screen />)

    const input = await editor()
    expect(await screen.findByText("The formula has a problem.")).toBeVisible()
    expect(input).toHaveAttribute("aria-invalid", "true")
    expect(screen.queryByRole("alert")).toBeNull()
    await waitFor(() =>
      expect(document.querySelector(".cm-lintRange-error")).toHaveTextContent("Pricing.Unit price"),
    )
  })

  it("asks the server to check once for a formula typed with pauses of less than 300 ms", async () => {
    const asked: string[] = []
    renderBar()
    server.use(
      http.post("/api/v1/models/:id/formula/check", async ({ request }) => {
        asked.push(((await request.json()) as { formula: string }).formula)
        return HttpResponse.json({ ok: true, type: { type: "number" } })
      }),
    )
    const input = await editor()
    input.focus()

    for (const text of ["Units sold * 2", "Units sold * 20", "Units sold * 200", "Units sold * 2000"]) {
      setFormula(input, text)
      await new Promise((resolve) => setTimeout(resolve, 40))
    }
    await new Promise((resolve) => setTimeout(resolve, 600))

    expect(asked).toEqual(["Units sold * 2000"])
  })

  it("keeps what was typed while the save runs, which was not what was saved", async () => {
    const typist = userEvent.setup()
    const store = renderBar()
    const release = store.hold()
    const input = await editor()
    setFormula(input, "Units sold * 2")
    await typist.click(await screen.findByRole("button", { name: "Save" }))
    await waitFor(() => expect(screen.getByRole("button", { name: "Save" })).toBeDisabled())

    setFormula(input, "Units sold * 3")
    release()
    await waitFor(() => expect(toast.success).toHaveBeenCalled())

    expect(store.requests[0].body).toEqual({ formula: "Units sold * 2" })
    expect(formulaText(input)).toBe("Units sold * 3")
    expect(await screen.findByRole("button", { name: "Save" })).toBeEnabled()
  })

  describe("the keyboard focus", () => {
    it("is in the formula after the question about clearing values is answered with Cancel", async () => {
      const typist = userEvent.setup()
      renderBar({ initial: unitsSold.id })
      const input = await editor("Formula of Units sold")
      setFormula(input, "1 + 1")
      await typist.click(input)
      await typist.keyboard("{Enter}")
      const confirm = await screen.findByRole("alertdialog")

      await typist.click(within(confirm).getByRole("button", { name: "Cancel" }))

      await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull())
      expect(input).toHaveFocus()
    })

    it("is in the formula after the question is answered with Escape", async () => {
      const typist = userEvent.setup()
      renderBar({ initial: unitsSold.id })
      const input = await editor("Formula of Units sold")
      setFormula(input, "1 + 1")
      await typist.click(input)
      await typist.keyboard("{Enter}")
      await screen.findByRole("alertdialog")

      await typist.keyboard("{Escape}")

      await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull())
      expect(input).toHaveFocus()
    })

    it("is in the formula after the question is confirmed", async () => {
      const typist = userEvent.setup()
      renderBar({ initial: unitsSold.id })
      const input = await editor("Formula of Units sold")
      setFormula(input, "1 + 1")
      await typist.click(await screen.findByRole("button", { name: "Save" }))
      const confirm = await screen.findByRole("alertdialog")

      await typist.click(within(confirm).getByRole("button", { name: "Save and clear values" }))

      await waitFor(() => expect(toast.success).toHaveBeenCalled())
      await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull())
      expect(input).toHaveFocus()
    })

    it("is in the formula after Save and after Cancel, whose buttons go", async () => {
      const typist = userEvent.setup()
      renderBar()
      const input = await editor()

      setFormula(input, "Units sold * 2")
      await typist.click(await screen.findByRole("button", { name: "Cancel" }))
      expect(input).toHaveFocus()

      setFormula(input, "Units sold * 3")
      await typist.click(await screen.findByRole("button", { name: "Save" }))
      await waitFor(() => expect(toast.success).toHaveBeenCalled())
      await waitFor(() => expect(screen.queryByRole("button", { name: "Save" })).toBeNull())
      expect(input).toHaveFocus()
    })
  })

  it("keeps what was typed for a line item while another is selected", async () => {
    const typist = userEvent.setup()
    renderBar()
    setFormula(await editor(), "Units sold * 2")

    await typist.click(screen.getByRole("button", { name: "Select units" }))
    const units = await editor("Formula of Units sold")
    expect(formulaText(units)).toBe("")
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull()
    await typist.click(screen.getByRole("button", { name: "Select revenue" }))

    expect(formulaText(await editor())).toBe("Units sold * 2")
    expect(screen.getByRole("button", { name: "Save" })).toBeVisible()
  })
})

describe("who may change a formula", () => {
  it("shows a planner or viewer the formula, and takes no typing", async () => {
    renderBar({ canEdit: false })

    const input = await editor()
    expect(formulaText(input)).toBe("Units sold * Pricing.Unit price")
    expect(input).toHaveAttribute("aria-readonly", "true")
    expect(input).toHaveAttribute("aria-readonly", "true")
    expect(within(screen.getByRole("group", { name: "Formula bar" })).queryByRole("button")).toBeNull()
  })

  it("switches the bar off in production mode", async () => {
    renderBar({ locked: true })

    expect(await editor()).toHaveAttribute("aria-readonly", "true")
  })

  it("says what an input line item holds to someone who cannot change it", async () => {
    renderBar({ canEdit: false, initial: unitsSold.id })

    const input = await editor("Formula of Units sold")
    expect(input.closest(".cm-editor")).toHaveTextContent(
      "No formula: this line item holds typed values.",
    )
  })

  it("never asks the server to check a formula it cannot change", async () => {
    // A request without a handler fails the test.
    renderBar({ canEdit: false })
    const input = await editor()
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(formulaText(input)).toBe("Units sold * Pricing.Unit price")
  })
})
