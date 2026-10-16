import { EditorView } from "@codemirror/view"
import { act, fireEvent, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { HttpResponse, http } from "msw"
import { useState } from "react"
import { describe, expect, it, vi } from "vitest"
import { setFormula } from "@/test/formula"
import { problem } from "@/test/problem"
import { renderWithProviders } from "@/test/render"
import { server } from "@/test/server"
import { FormulaEditor, type FormulaEditorProps } from "./formula-editor"
import type { KnownProblems } from "./lint"

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

/** A moment of real time, for what the editor waits for before it asks the server. */
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const ACCEPTED = () => HttpResponse.json({ ok: true, type: { type: "number" } })

/** An editor whose value is kept by the test, as a form keeps it. */
function Harness(
  props: Partial<FormulaEditorProps> & {
    initial?: string
    /** Hands the editor a new `known` object at every render, as a parent that builds it in its body does. */
    freshKnown?: boolean
  },
) {
  const { initial = "", onChange, freshKnown, ...rest } = props
  const [value, setValue] = useState(initial)
  return (
    <FormulaEditor
      modelId={MODEL}
      lineItemId={LINE_ITEM}
      aria-label="Formula"
      {...rest}
      known={freshKnown ? { formula: "saved", problems: [] } : rest.known}
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
  it("is shown, can be reached and selected with the keyboard, and takes no typing", async () => {
    const onChange = vi.fn()
    const onSubmit = vi.fn()
    const input = await renderEditor({ initial: "Revenue * 2", readOnly: true, onChange, onSubmit })
    const user = userEvent.setup()

    expect(input).toHaveTextContent("Revenue * 2")
    expect(input).toHaveAttribute("aria-readonly", "true")
    await user.tab()
    expect(input).toHaveFocus()
    await user.keyboard("{Control>}a{/Control}")
    const { from, to } = viewOf(input).state.selection.main
    expect([from, to]).toEqual([0, 11])
    await user.keyboard("xyz{Enter}{Backspace}")

    expect(onChange).not.toHaveBeenCalled()
    expect(onSubmit).not.toHaveBeenCalled()
    expect(input).toHaveTextContent("Revenue * 2")
  })

  it("never asks the server anything", async () => {
    // A request without a handler fails the test.
    const input = await renderEditor({ initial: "ROUND(1", readOnly: true })
    input.focus()
    await wait(400)
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
      http.get(`/api/v1/models/${MODEL}/formula/completions`, () => HttpResponse.json([])),
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
    // The attribute follows the list from an effect, not in the render that shows the list.
    await waitFor(() => expect(input).toHaveAttribute("aria-invalid", "true"))
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

describe("how often the server is asked", () => {
  it("is asked once for a formula typed with pauses of less than 300 ms, even by a parent that makes `known` anew at every render", async () => {
    const asked: string[] = []
    server.use(
      http.post(`/api/v1/models/${MODEL}/formula/check`, async ({ request }) => {
        asked.push(((await request.json()) as { formula: string }).formula)
        return ACCEPTED()
      }),
    )
    const input = await renderEditor({ freshKnown: true })
    const view = viewOf(input)
    view.focus()

    for (const text of ["1", " +", " ", "2"]) {
      type(view, text)
      await wait(40)
    }
    await wait(600)

    expect(asked).toEqual(["1 + 2"])
  })

  it("is asked once for what completes a prefix typed with pauses of less than 150 ms", async () => {
    const asked: string[] = []
    server.use(
      http.get(`/api/v1/models/${MODEL}/formula/completions`, ({ request }) => {
        asked.push(new URL(request.url).searchParams.get("prefix") ?? "")
        return HttpResponse.json([{ label: "Revenue", kind: "line_item", detail: "Number" }])
      }),
      http.post(`/api/v1/models/${MODEL}/formula/check`, ACCEPTED),
    )
    const input = await renderEditor()
    const view = viewOf(input)
    view.focus()

    type(view, "R")
    await wait(50)
    type(view, "e")
    await screen.findAllByRole("option")

    expect(asked).toEqual(["Re"])
  })
})

describe("the marks in the formula", () => {
  const unknown = {
    code: "formula.unknown_name",
    message: "Unknown name 'Revnue'.",
    start: 0,
    end: 6,
    suggestion: null,
  }

  /** An editor whose parent learns of a problem with the saved formula while it is idle. */
  function Learning() {
    const [problems, setProblems] = useState<(typeof unknown)[]>([])
    return (
      <>
        <button type="button" onClick={() => setProblems([unknown])}>
          Break it
        </button>
        <FormulaEditor
          modelId={MODEL}
          lineItemId={LINE_ITEM}
          aria-label="Formula"
          value="Revnue"
          onChange={() => {}}
          known={{ formula: "Revnue", problems }}
        />
      </>
    )
  }

  it("follow what is known of the formula while the editor is idle", async () => {
    renderWithProviders(<Learning />)
    await screen.findByRole("textbox", { name: "Formula" })
    await wait(400)
    expect(document.querySelector(".cm-lintRange-error")).toBeNull()

    await userEvent.setup().click(screen.getByRole("button", { name: "Break it" }))

    await waitFor(() =>
      expect(document.querySelector(".cm-lintRange-error")).toHaveTextContent("Revnue"),
    )
  })

  it("are reached from the keyboard: F8 selects the next one, and Ctrl+Shift+M lists them with the fix", async () => {
    const input = await renderEditor({
      initial: "Revnue * 2",
      known: {
        formula: "Revnue * 2",
        problems: [{ ...unknown, message: "Unknown name 'Revnue'.", suggestion: "Revenue" }],
      },
    })
    await waitFor(() => expect(document.querySelector(".cm-lintRange-error")).not.toBeNull())
    const view = viewOf(input)
    const user = userEvent.setup()
    await user.click(input)
    act(() => view.dispatch({ selection: { anchor: view.state.doc.length } }))

    await user.keyboard("{F8}")
    const { from, to } = view.state.selection.main
    expect(view.state.sliceDoc(from, to)).toBe("Revnue")

    // user-event gives a key no key code, which CodeMirror and its panel read.
    fireEvent.keyDown(input, { key: "M", keyCode: 77, ctrlKey: true, shiftKey: true })
    await waitFor(() =>
      expect(document.querySelector(".cm-panel-lint")).toHaveTextContent("Unknown name 'Revnue'."),
    )
    // The fix is taken with the letter that is underlined in its name.
    fireEvent.keyDown(screen.getByRole("listbox", { name: "Diagnostics" }), { key: "u", keyCode: 85 })

    expect(view.state.doc.toString()).toBe("Revenue * 2")
  })
})

describe("what a screen reader is told", () => {
  it("is the number of problems a check finds, once for each time it changes", async () => {
    let found = 1
    server.use(
      http.get(`/api/v1/models/${MODEL}/formula/completions`, () => HttpResponse.json([])),
      http.post(`/api/v1/models/${MODEL}/formula/check`, () =>
        HttpResponse.json(
          found === 0
            ? { ok: true, type: { type: "number" } }
            : {
                ok: false,
                errors: Array.from({ length: found }, (_, index) => ({
                  code: "formula.unknown_name",
                  message: `Unknown name ${index}.`,
                  start: 0,
                  end: 1,
                })),
              },
        ),
      ),
    )
    const announce = vi.spyOn(EditorView.announce, "of")
    const input = await renderEditor()
    const view = viewOf(input)
    view.focus()
    const said = () => announce.mock.calls.map(([text]) => text)

    type(view, "a")
    await waitFor(() => expect(said()).toEqual(["Checked: 1 problem found."]))
    // The next check finds one problem again, which was said.
    type(view, "b")
    await screen.findByText("Unknown name 0.")
    await wait(500)
    expect(said()).toEqual(["Checked: 1 problem found."])
    found = 2
    type(view, "c")
    await waitFor(() => expect(said()).toHaveLength(2))
    found = 0
    type(view, "d")
    await waitFor(() => expect(said()).toHaveLength(3))

    expect(said()).toEqual([
      "Checked: 1 problem found.",
      "Checked: 2 problems found.",
      "Checked: no problems found.",
    ])
  })

  it("counts the problems of a refused save as told, so that fixing them is announced", async () => {
    server.use(
      http.get(`/api/v1/models/${MODEL}/formula/completions`, () => HttpResponse.json([])),
      http.post(`/api/v1/models/${MODEL}/formula/check`, ACCEPTED),
    )
    const refusal: KnownProblems = {
      formula: "Revnue",
      refused: true,
      problems: [{ code: "formula.unknown_name", message: "Unknown name 'Revnue'.", start: 0, end: 6 }],
    }
    function Refusing() {
      const [value, setValue] = useState("Revnue")
      const [known, setKnown] = useState<KnownProblems>({ formula: "Revnue", problems: [] })
      return (
        <>
          <button type="button" onClick={() => setKnown(refusal)}>
            Refuse it
          </button>
          <FormulaEditor
            modelId={MODEL}
            lineItemId={LINE_ITEM}
            aria-label="Formula"
            value={value}
            onChange={setValue}
            known={known}
          />
        </>
      )
    }
    const announce = vi.spyOn(EditorView.announce, "of")
    renderWithProviders(<Refusing />)
    const input = await screen.findByRole("textbox", { name: "Formula" })
    await userEvent.setup().click(screen.getByRole("button", { name: "Refuse it" }))
    // The refusal is announced by the list of problems; the marks follow from `known`.
    await screen.findByRole("alert")
    await waitFor(() => expect(document.querySelector(".cm-lintRange-error")).not.toBeNull())

    setFormula(input, "Revenue")

    await waitFor(() => expect(announce).toHaveBeenCalledWith("Checked: no problems found."))
  })

  it("is nothing for the problems that were there when the editor opened", async () => {
    const announce = vi.spyOn(EditorView.announce, "of")
    await renderEditor({
      initial: "Revnue",
      known: {
        formula: "Revnue",
        problems: [
          { code: "formula.unknown_name", message: "Unknown name 'Revnue'.", start: 0, end: 6 },
        ],
      },
    })
    await wait(500)

    expect(announce).not.toHaveBeenCalled()
  })
})

describe("when the server cannot be reached", () => {
  it("says a check could not be made, and no longer when one can", async () => {
    let up = false
    server.use(
      http.post(`/api/v1/models/${MODEL}/formula/check`, () =>
        up ? ACCEPTED() : problem(503, "server.busy", "The server is busy."),
      ),
    )
    const input = await renderEditor()
    const view = viewOf(input)

    type(view, "1")
    expect(await screen.findByText("The formula could not be checked just now.")).toBeVisible()
    up = true
    type(view, "2")

    await waitFor(() => expect(screen.queryByText(/could not be checked/)).toBeNull())
  })

  it("says suggestions are not available when the completions fail", async () => {
    server.use(
      http.get(`/api/v1/models/${MODEL}/formula/completions`, () =>
        problem(503, "server.busy", "The server is busy."),
      ),
      http.post(`/api/v1/models/${MODEL}/formula/check`, ACCEPTED),
    )
    const input = await renderEditor()
    const view = viewOf(input)
    view.focus()

    type(view, "Re")

    expect(await screen.findByText("Suggestions are not available just now.")).toBeVisible()
  })

  it("keeps saying signatures are not available when a completion is had after", async () => {
    server.use(
      http.get("/api/v1/formula/functions", () => problem(503, "server.busy", "The server is busy.")),
      http.get(`/api/v1/models/${MODEL}/formula/completions`, () =>
        HttpResponse.json([{ label: "Revenue", kind: "line_item", detail: "Number" }]),
      ),
      http.post(`/api/v1/models/${MODEL}/formula/check`, ACCEPTED),
    )
    const input = await renderEditor({ initial: "ROUND(" })
    const view = viewOf(input)
    view.focus()
    act(() => view.dispatch({ selection: { anchor: 6 } }))
    await screen.findByText("Suggestions are not available just now.")

    type(view, "Re")
    await screen.findAllByRole("option")
    await wait(100)

    expect(screen.getByText("Suggestions are not available just now.")).toBeVisible()
  })

  it("says nothing of what could not be had once the editor can no longer be changed", async () => {
    server.use(
      http.get(`/api/v1/models/${MODEL}/formula/completions`, () =>
        problem(503, "server.busy", "The server is busy."),
      ),
      http.post(`/api/v1/models/${MODEL}/formula/check`, () =>
        problem(503, "server.busy", "The server is busy."),
      ),
    )
    function Locking() {
      const [readOnly, setReadOnly] = useState(false)
      return (
        <>
          <button type="button" onClick={() => setReadOnly(true)}>
            Lock it
          </button>
          <FormulaEditor
            modelId={MODEL}
            lineItemId={LINE_ITEM}
            aria-label="Formula"
            value="a"
            onChange={() => {}}
            readOnly={readOnly}
          />
        </>
      )
    }
    renderWithProviders(<Locking />)
    const view = viewOf(await screen.findByRole("textbox", { name: "Formula" }))
    view.focus()
    type(view, "b")
    await screen.findByText(/Suggestions are not available just now\./)
    await screen.findByText(/The formula could not be checked just now\./)

    await userEvent.setup().click(screen.getByRole("button", { name: "Lock it" }))

    await waitFor(() =>
      expect(screen.queryByText(/not available just now|could not be checked/)).toBeNull(),
    )
  })

  it("asks for the functions once, and not again at every key when that fails", async () => {
    let asked = 0
    server.use(
      http.get("/api/v1/formula/functions", () => {
        asked += 1
        return problem(503, "server.busy", "The server is busy.")
      }),
      http.post(`/api/v1/models/${MODEL}/formula/check`, ACCEPTED),
    )
    const input = await renderEditor({ initial: "ROUND(" })
    const view = viewOf(input)
    view.focus()
    act(() => view.dispatch({ selection: { anchor: 6 } }))
    await screen.findByText("Suggestions are not available just now.")

    for (const text of ["1", ",", " 2"]) {
      type(view, text)
      await wait(30)
    }

    expect(asked).toBe(1)
  })
})
