import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import { z } from "zod"
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog"
import { ApiError } from "@/lib/api/client"
import { isEditingInlineText } from "@/lib/inline-text"
import { InlineText } from "./inline-text"

const name = z.string().trim().min(1, "Name is required.")

function renderText(onSave = vi.fn().mockResolvedValue(undefined), value = "France") {
  render(
    <InlineText
      value={value}
      label={`Rename ${value}`}
      inputLabel={`Name of ${value}`}
      schema={name}
      onSave={onSave}
    />,
  )
  return onSave
}

describe("text that is edited in place", () => {
  it("is a button that turns into a focused input, with the text selected", async () => {
    const typist = userEvent.setup()
    renderText()
    await typist.click(screen.getByRole("button", { name: "Rename France" }))

    const input = screen.getByRole("textbox", { name: "Name of France" })
    expect(input).toHaveFocus()
    expect(input).toHaveValue("France")
  })

  it("saves on Enter and gives focus back to the text", async () => {
    const typist = userEvent.setup()
    const onSave = renderText()
    await typist.click(screen.getByRole("button", { name: "Rename France" }))
    await typist.clear(screen.getByRole("textbox", { name: "Name of France" }))
    await typist.type(screen.getByRole("textbox", { name: "Name of France" }), " Spain {Enter}")

    await waitFor(() => expect(onSave).toHaveBeenCalledWith("Spain"))
    expect(await screen.findByRole("button", { name: "Rename France" })).toHaveFocus()
  })

  it("puts the old text back on Escape, without saving", async () => {
    const typist = userEvent.setup()
    const onSave = renderText()
    await typist.click(screen.getByRole("button", { name: "Rename France" }))
    await typist.type(screen.getByRole("textbox", { name: "Name of France" }), "!{Escape}")

    expect(screen.getByRole("button", { name: "Rename France" })).toHaveFocus()
    expect(onSave).not.toHaveBeenCalled()
  })

  it("saves when focus moves on, and leaves focus where it went", async () => {
    const typist = userEvent.setup()
    const onSave = renderText()
    await typist.click(screen.getByRole("button", { name: "Rename France" }))
    await typist.type(screen.getByRole("textbox", { name: "Name of France" }), "!")
    await typist.tab()

    await waitFor(() => expect(onSave).toHaveBeenCalledWith("France!"))
    expect(await screen.findByRole("button", { name: "Rename France" })).not.toHaveFocus()
  })

  it("shows what the schema or the server refuses under the input and stays open", async () => {
    const typist = userEvent.setup()
    const onSave = renderText(
      vi.fn().mockRejectedValue(new ApiError(409, "structure.name_taken", "The name is taken.")),
    )
    await typist.click(screen.getByRole("button", { name: "Rename France" }))
    const input = screen.getByRole("textbox", { name: "Name of France" })
    await typist.clear(input)
    await typist.keyboard("{Enter}")

    expect(await screen.findByText("Name is required.")).toBeVisible()
    expect(onSave).not.toHaveBeenCalled()
    await typist.type(input, "Spain{Enter}")

    expect(await screen.findByText("The name is taken.")).toBeVisible()
    expect(input).toBeInvalid()
  })

  it("shows the placeholder of an empty value", () => {
    render(
      <InlineText
        value=""
        label="Add code for France"
        inputLabel="Code of France"
        schema={z.string()}
        placeholder="Add code"
        onSave={vi.fn()}
      />,
    )

    expect(screen.getByRole("button", { name: "Add code for France" })).toHaveTextContent(
      "Add code",
    )
  })
})

describe("text edited inside a dialog", () => {
  it("lets the first Escape end the edit and the second close the dialog", async () => {
    const typist = userEvent.setup()
    const onOpenChange = vi.fn()
    render(
      <Dialog open onOpenChange={onOpenChange}>
        <DialogContent
          onEscapeKeyDown={(event) => {
            if (isEditingInlineText(event.target)) {
              event.preventDefault()
            }
          }}
        >
          <DialogTitle>Names</DialogTitle>
          <DialogDescription>Rename one.</DialogDescription>
          <InlineText
            value="France"
            label="Rename France"
            inputLabel="Name of France"
            schema={name}
            onSave={vi.fn()}
          />
        </DialogContent>
      </Dialog>,
    )
    await typist.click(screen.getByRole("button", { name: "Rename France" }))
    await typist.keyboard("{Escape}")

    expect(screen.getByRole("button", { name: "Rename France" })).toBeVisible()
    expect(onOpenChange).not.toHaveBeenCalled()
    await typist.keyboard("{Escape}")

    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("only counts the input of the text as editing it", () => {
    expect(isEditingInlineText(null)).toBe(false)
    expect(isEditingInlineText(document.body)).toBe(false)
  })
})
