import { EditorView } from "@codemirror/view"
import { act, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { HttpResponse, http } from "msw"
import { useState } from "react"
import { describe, expect, it, vi } from "vitest"
import { renderWithProviders } from "@/test/render"
import { server } from "@/test/server"
import { FormulaEditor, type FormulaEditorProps } from "./formula-editor"

const MODEL = "model-1"
const LINE_ITEM = "line-item-1"

function viewOf(input: HTMLElement) {
  const editor = input.closest<HTMLElement>(".cm-editor")
  const view = editor && EditorView.findFromDOM(editor)
  if (!view) {
    throw new Error("no editor on the page")
  }
  return view
}

/** Types into the editor the way a person does, which is what makes the completions open. */
function type(view: EditorView, text: string) {
  const end = view.state.doc.length
  act(() => {
    view.dispatch({
      changes: { from: end, insert: text },
      selection: { anchor: end + text.length },
      userEvent: "input.type",
    })
  })
}

/** The list of completions ignores keys for a moment after it opens, so that a key typed on is not taken for a choice. */
const waitForTheListToAcceptKeys = () => new Promise((resolve) => setTimeout(resolve, 100))

/** An editor whose value is kept by the test, as a form keeps it. */
function Harness(props: Partial<FormulaEditorProps> & { initial?: string }) {
  const { initial = "", onChange, ...rest } = props
  const [value, setValue] = useState(initial)
  return (
    <FormulaEditor
      modelId={MODEL}
      lineItemId={LINE_ITEM}
      aria-label="Formula"
      {...rest}
      value={value}
      onChange={(next) => {
        setValue(next)
        onChange?.(next)
      }}
    />
  )
}

function renderEditor(props: Parameters<typeof Harness>[0] = {}) {
  renderWithProviders(<Harness {...props} />)
  return screen.findByRole("textbox", { name: "Formula" })
}

describe("the keys", () => {
  it("submits on Enter and keeps the formula on one line", async () => {
    const onSubmit = vi.fn()
    const onChange = vi.fn()
    const input = await renderEditor({ initial: "Revenue * 2", onSubmit, onChange })
    const user = userEvent.setup()

    await user.click(input)
    await user.keyboard("{Enter}")

    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(onChange).not.toHaveBeenCalled()
    expect(input).toHaveTextContent("Revenue * 2")
  })

  it("breaks the line on Shift+Enter", async () => {
    const onSubmit = vi.fn()
    const onChange = vi.fn()
    const input = await renderEditor({ initial: "a", onSubmit, onChange })
    const user = userEvent.setup()

    await user.click(input)
    await user.keyboard("{Shift>}{Enter}{/Shift}")

    expect(onSubmit).not.toHaveBeenCalled()
    expect(onChange).toHaveBeenLastCalledWith(expect.stringContaining("\n"))
  })

  it("cancels on Escape", async () => {
    const onCancel = vi.fn()
    const input = await renderEditor({ initial: "a", onCancel })
    const user = userEvent.setup()

    await user.click(input)
    await user.keyboard("{Escape}")

    expect(onCancel).toHaveBeenCalledTimes(1)
  })
})

describe("a formula that cannot be changed", () => {
  it("is shown, takes no focus and takes no typing", async () => {
    const onChange = vi.fn()
    const input = await renderEditor({ initial: "Revenue * 2", readOnly: true, onChange })

    expect(input).toHaveTextContent("Revenue * 2")
    expect(input).toHaveAttribute("contenteditable", "false")
    expect(input).toHaveAttribute("aria-readonly", "true")
    const user = userEvent.setup()
    await user.type(input, "xyz")
    expect(onChange).not.toHaveBeenCalled()
  })

  it("never asks the server anything", async () => {
    // A request without a handler fails the test.
    const input = await renderEditor({ initial: "ROUND(1", readOnly: true })
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(input).toHaveTextContent("ROUND(1")
  })
})

describe("the problems of a formula", () => {
  it("shows what the server already said without asking it again", async () => {
    await renderEditor({
      initial: "Revnue * 2",
      known: {
        formula: "Revnue * 2",
        problems: [
          {
            code: "formula.unknown_name",
            message: "Unknown name 'Revnue'.",
            start: 0,
            end: 6,
            suggestion: "Revenue",
          },
        ],
      },
    })

    expect(screen.getByText("The formula has a problem.")).toBeVisible()
    expect(screen.getByText(/Did you mean 'Revenue'\?/)).toBeVisible()
    expect(screen.getByRole("textbox", { name: "Formula" })).toHaveAttribute("aria-invalid", "true")
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
    await waitFor(() => expect(document.querySelector(".cm-lintRange-error")).toHaveTextContent("Revnue"))
  })

  it("announces the problems of a save the server refused", async () => {
    await renderEditor({
      initial: "Revnue",
      known: {
        formula: "Revnue",
        refused: true,
        problems: [
          { code: "formula.unknown_name", message: "Unknown name 'Revnue'.", start: 0, end: 6, suggestion: null },
        ],
      },
    })

    expect(screen.getByRole("alert")).toHaveTextContent("The formula has a problem.")
  })

  it("checks a formula after a pause and marks the part with the problem where the text is", async () => {
    const requests: unknown[] = []
    server.use(
      http.post(`/api/v1/models/${MODEL}/formula/check`, async ({ request }) => {
        requests.push(await request.json())
        return HttpResponse.json({
          ok: false,
          errors: [
            {
              code: "formula.unknown_name",
              message: "Unknown name 'Revnue'.",
              // "Umsätze + " takes 11 bytes and 10 UTF-16 units.
              start: 11,
              end: 17,
              suggestion: "Revenue",
            },
          ],
        })
      }),
    )
    const input = await renderEditor()
    const view = viewOf(input)

    type(view, "Umsätze + ")
    type(view, "Revnue")

    await waitFor(() => expect(screen.getByText("The formula has a problem.")).toBeVisible())
    // One check, for the formula as it stood when the typing paused.
    expect(requests).toEqual([{ line_item_id: LINE_ITEM, formula: "Umsätze + Revnue" }])
    expect(document.querySelector(".cm-lintRange-error")).toHaveTextContent("Revnue")
    expect(screen.getByText(/Did you mean 'Revenue'\?/)).toBeVisible()
  })

  it("lists the problems of the formula as it stands, and takes them off the page while it is edited", async () => {
    server.use(
      http.post(`/api/v1/models/${MODEL}/formula/check`, async ({ request }) => {
        const { formula } = (await request.json()) as { formula: string }
        return HttpResponse.json({
          ok: false,
          errors: [
            {
              code: "formula.unknown_name",
              message: `Unknown name '${formula}'.`,
              start: 0,
              end: formula.length,
            },
          ],
        })
      }),
    )
    const input = await renderEditor()
    const view = viewOf(input)
    view.focus()

    type(view, "Re")
    expect(await screen.findByText("Unknown name 'Re'.")).toBeVisible()
    // The mark is in the formula too, and it stays while the formula is edited.
    expect(document.querySelector(".cm-lintRange-error")).toHaveTextContent("Re")

    type(view, "v")
    expect(screen.queryByText("The formula has a problem.")).toBeNull()
    expect(input).not.toHaveAttribute("aria-invalid", "true")
    expect(await screen.findByText("Unknown name 'Rev'.")).toBeVisible()
    expect(input).toHaveAttribute("aria-invalid", "true")
    expect(input).toHaveAccessibleDescription(/The formula has a problem\./)
  })

  it("does not change the list when the editor is left, which would move what a click is aimed at", async () => {
    server.use(
      http.post(`/api/v1/models/${MODEL}/formula/check`, () =>
        HttpResponse.json({
          ok: false,
          errors: [{ code: "formula.unknown_name", message: "Unknown name 'Re'.", start: 0, end: 2 }],
        }),
      ),
    )
    const input = await renderEditor()
    const view = viewOf(input)
    view.focus()
    type(view, "Re")
    const list = (await screen.findByText("The formula has a problem.")).parentElement as HTMLElement
    const before = list.outerHTML

    act(() => view.contentDOM.blur())

    expect(screen.getByText("The formula has a problem.").parentElement?.outerHTML).toBe(before)
  })

  it("lists nothing for an emptied formula at once", async () => {
    server.use(
      http.post(`/api/v1/models/${MODEL}/formula/check`, () =>
        HttpResponse.json({
          ok: false,
          errors: [{ code: "formula.unknown_name", message: "Unknown name 'Re'.", start: 0, end: 2 }],
        }),
      ),
    )
    const input = await renderEditor()
    const view = viewOf(input)
    type(view, "Re")
    await screen.findByText("The formula has a problem.")

    act(() => view.dispatch({ changes: { from: 0, to: 2, insert: "" } }))

    expect(screen.queryByText("The formula has a problem.")).toBeNull()
  })

  it("shows nothing for a formula the server accepts", async () => {
    server.use(
      http.post(`/api/v1/models/${MODEL}/formula/check`, () =>
        HttpResponse.json({ ok: true, type: { type: "number" } }),
      ),
    )
    const input = await renderEditor()
    type(viewOf(input), "1 + 2")

    await new Promise((resolve) => setTimeout(resolve, 600))

    expect(screen.queryByText(/The formula has/)).not.toBeInTheDocument()
    expect(document.querySelector(".cm-lintRange-error")).toBeNull()
  })

  it("does not ask about a formula that is empty", async () => {
    // A request without a handler fails the test.
    const input = await renderEditor({ initial: "a" })
    const view = viewOf(input)
    view.dispatch({ changes: { from: 0, to: 1, insert: "  " } })
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(screen.queryByText(/The formula has/)).not.toBeInTheDocument()
  })
})

describe("completions", () => {
  it("offers what the server says, in its order, and inserts the one chosen", async () => {
    const asked: string[] = []
    server.use(
      http.get(`/api/v1/models/${MODEL}/formula/completions`, ({ request }) => {
        const url = new URL(request.url)
        asked.push(`${url.searchParams.get("line_item_id")}:${url.searchParams.get("prefix")}`)
        return HttpResponse.json([
          { label: "Revenue", kind: "line_item", detail: "Number" },
          { label: "Plan.Revenue", kind: "line_item", detail: "Number in Plan" },
          { label: "Regions", kind: "list", detail: "List" },
        ])
      }),
      http.post(`/api/v1/models/${MODEL}/formula/check`, () =>
        HttpResponse.json({ ok: true, type: { type: "number" } }),
      ),
    )
    const input = await renderEditor()
    const view = viewOf(input)
    view.focus()

    type(view, "Re")

    const options = await screen.findAllByRole("option")
    expect(options.map((option) => option.textContent)).toEqual([
      expect.stringContaining("Revenue"),
      expect.stringContaining("Plan.Revenue"),
      expect.stringContaining("Regions"),
    ])
    expect(asked).toEqual([`${LINE_ITEM}:Re`])
    // The list is announced as a list of options the Enter key chooses from.
    expect(screen.getByRole("listbox")).toBeVisible()

    await waitForTheListToAcceptKeys()
    const user = userEvent.setup()
    await user.keyboard("{ArrowDown}{Enter}")

    expect(view.state.doc.toString()).toBe("Plan.Revenue")
  })

  it("asks once for a prefix", async () => {
    let calls = 0
    server.use(
      http.get(`/api/v1/models/${MODEL}/formula/completions`, () => {
        calls += 1
        return HttpResponse.json([{ label: "Revenue", kind: "line_item", detail: "Number" }])
      }),
      http.post(`/api/v1/models/${MODEL}/formula/check`, () =>
        HttpResponse.json({ ok: true, type: { type: "number" } }),
      ),
    )
    const input = await renderEditor()
    const view = viewOf(input)
    view.focus()
    type(view, "Re")
    await screen.findAllByRole("option")
    view.dispatch({ changes: { from: 0, to: 2, insert: "" } })
    type(view, "Re")
    await screen.findAllByRole("option")

    expect(calls).toBe(1)
  })

  it("inserts a function with its parenthesis opened and closed, the cursor inside", async () => {
    server.use(
      http.get(`/api/v1/models/${MODEL}/formula/completions`, () =>
        HttpResponse.json([{ label: "ROUND", kind: "function", detail: "Rounds a number." }]),
      ),
      http.post(`/api/v1/models/${MODEL}/formula/check`, () =>
        HttpResponse.json({ ok: true, type: { type: "number" } }),
      ),
      http.get("/api/v1/formula/functions", () => HttpResponse.json([])),
    )
    const input = await renderEditor()
    const view = viewOf(input)
    view.focus()
    type(view, "ROU")
    await screen.findAllByRole("option")
    await waitForTheListToAcceptKeys()

    await userEvent.setup().keyboard("{Enter}")

    expect(view.state.doc.toString()).toBe("ROUND()")
    expect(view.state.selection.main.head).toBe(6)
  })

  it("closes the list on Escape before it cancels", async () => {
    const onCancel = vi.fn()
    server.use(
      http.get(`/api/v1/models/${MODEL}/formula/completions`, () =>
        HttpResponse.json([{ label: "Revenue", kind: "line_item", detail: "Number" }]),
      ),
      http.post(`/api/v1/models/${MODEL}/formula/check`, () =>
        HttpResponse.json({ ok: true, type: { type: "number" } }),
      ),
    )
    const input = await renderEditor({ onCancel })
    const view = viewOf(input)
    view.focus()
    type(view, "Re")
    await screen.findAllByRole("option")
    await waitForTheListToAcceptKeys()
    const user = userEvent.setup()

    await user.keyboard("{Escape}")
    expect(screen.queryByRole("option")).not.toBeInTheDocument()
    expect(onCancel).not.toHaveBeenCalled()

    await user.keyboard("{Escape}")
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it("offers nothing without a line item to ask about", async () => {
    // A request without a handler fails the test.
    const input = await renderEditor({ lineItemId: undefined })
    const view = viewOf(input)
    view.focus()
    type(view, "Re")
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(screen.queryByRole("option")).not.toBeInTheDocument()
  })
})

describe("the signature of a function", () => {
  const round = {
    name: "ROUND",
    category: "Math",
    min_args: 1,
    max_args: 3,
    doc: "Rounds a number to a number of decimals.",
    example: "ROUND(1.234, 2)",
  }

  it("is shown above the call the cursor is in, and said to a screen reader", async () => {
    server.use(
      http.get("/api/v1/formula/functions", () => HttpResponse.json([round])),
      http.post(`/api/v1/models/${MODEL}/formula/check`, () =>
        HttpResponse.json({ ok: true, type: { type: "number" } }),
      ),
    )
    const input = await renderEditor({ initial: "ROUND(" })
    const view = viewOf(input)
    view.focus()
    view.dispatch({ selection: { anchor: 6 } })

    const tip = await screen.findByText("Rounds a number to a number of decimals.")
    expect(tip.closest(".cm-formulaSignature")).toHaveTextContent("ROUND(1.234, 2)")
    expect(tip.closest(".cm-formulaSignature")).toHaveTextContent("Takes 1 to 3 arguments.")
    await waitFor(() =>
      expect(document.querySelector("[aria-live]")).toHaveTextContent(/ROUND\. Rounds a number/),
    )

    view.dispatch({ changes: { from: 6, insert: "1)" }, selection: { anchor: 8 } })
    await waitFor(() => expect(screen.queryByText("Rounds a number to a number of decimals.")).toBeNull())
  })
})
