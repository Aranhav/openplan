import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import type { ListOption } from "../edit-reference"
import { ListEditor } from "./list-editor"

const options: ListOption[] = [
  { id: "r-emea", name: "EMEA", code: "EU" },
  { id: "r-apac", name: "Asia Pacific", code: "AP" },
  { id: "r-na", name: "North America", code: "NA" },
  { id: "r-latam", name: "Latin America" },
]

function setup(props: Partial<Parameters<typeof ListEditor>[0]> = {}) {
  const onPick = vi.fn()
  const onCancel = vi.fn()
  const onLeave = vi.fn()
  render(
    <ListEditor
      label="Region, Widget"
      options={options}
      current={null}
      initialSearch=""
      onPick={onPick}
      onCancel={onCancel}
      onLeave={onLeave}
      {...props}
    />,
  )
  return { onPick, onCancel, onLeave, search: screen.getByRole("combobox") }
}

const names = () => screen.getAllByRole("option").map((option) => option.textContent)

describe("ListEditor", () => {
  it("lists the items of the list with the search box focused", () => {
    const { search } = setup()

    expect(search).toHaveFocus()
    expect(screen.getByRole("listbox")).toBeInTheDocument()
    expect(names()).toEqual(["EMEAEU", "Asia PacificAP", "North AmericaNA", "Latin America"])
  })

  it("narrows the items by name", async () => {
    setup()

    await userEvent.keyboard("america")

    expect(names()).toEqual(["North AmericaNA", "Latin America"])
  })

  it("narrows the items by code", async () => {
    setup()

    await userEvent.keyboard("ap")

    expect(names()).toEqual(["Asia PacificAP"])
  })

  it("puts the names that start with the search before the ones that only contain it", async () => {
    setup()

    await userEvent.keyboard("a")

    expect(names()[0]).toBe("Asia PacificAP")
    expect(names()).toHaveLength(4)
  })

  it("opens with the text that was typed to start it", () => {
    const { search } = setup({ initialSearch: "nor" })

    expect(search).toHaveValue("nor")
    expect(names()).toEqual(["North AmericaNA"])
  })

  it("says so when nothing matches", async () => {
    setup()

    await userEvent.keyboard("zzz")

    expect(screen.getByText("No matching items.")).toBeInTheDocument()
  })

  it("picks an item with a click", async () => {
    const { onPick } = setup()

    await userEvent.click(screen.getByRole("option", { name: /North America/ }))

    expect(onPick).toHaveBeenCalledExactlyOnceWith("r-na", null)
  })

  it("picks the highlighted item with Enter", async () => {
    const { onPick } = setup()

    await userEvent.keyboard("{ArrowDown}{Enter}")

    expect(onPick).toHaveBeenCalledExactlyOnceWith("r-apac", null)
  })

  it("picks the item whose code was typed", async () => {
    const { onPick } = setup()

    await userEvent.keyboard("eu{Enter}")

    expect(onPick).toHaveBeenCalledExactlyOnceWith("r-emea", null)
  })

  it("picks the highlighted item with Tab and moves right", async () => {
    const { onPick } = setup()

    await userEvent.keyboard("lat{Tab}")

    expect(onPick).toHaveBeenCalledExactlyOnceWith("r-latam", "right")
  })

  it("picks with Shift+Tab and moves left", async () => {
    const { onPick } = setup()

    await userEvent.keyboard("{Shift>}{Tab}{/Shift}")

    expect(onPick).toHaveBeenCalledExactlyOnceWith("r-emea", "left")
  })

  it("starts on the item the cell holds, and marks it", async () => {
    const { onPick } = setup({ current: "r-na" })

    expect(
      within(screen.getByRole("option", { name: /North America/ })).getByText("Current value"),
    ).toBeInTheDocument()
    await userEvent.keyboard("{Enter}")

    expect(onPick).toHaveBeenCalledExactlyOnceWith("r-na", null)
  })

  it("gives up with Escape", async () => {
    const { onPick, onCancel } = setup()

    await userEvent.keyboard("{Escape}")

    expect(onCancel).toHaveBeenCalledOnce()
    expect(onPick).not.toHaveBeenCalled()
  })

  it("is left when the click is outside it, without giving up the focus", async () => {
    const { onCancel, onLeave } = setup()

    await userEvent.click(document.body)

    expect(onLeave).toHaveBeenCalledOnce()
    expect(onCancel).not.toHaveBeenCalled()
  })

  it("explains a list without items", () => {
    setup({ options: [] })

    expect(screen.getByText("This list has no items.")).toBeInTheDocument()
  })
})
