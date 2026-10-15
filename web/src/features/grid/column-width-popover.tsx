import { zodResolver } from "@hookform/resolvers/zod"
import { type CSSProperties } from "react"
import { useForm } from "react-hook-form"
import { z } from "zod"
import { Button } from "@/components/ui/button"
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form"
import { Input } from "@/components/ui/input"
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover"
import { MAX_COLUMN_WIDTH, MIN_COLUMN_WIDTH } from "./grid-layout"

const MESSAGE = `Enter a whole number from ${MIN_COLUMN_WIDTH} to ${MAX_COLUMN_WIDTH}.`

const schema = z.object({
  width: z
    .string()
    .trim()
    .regex(/^\d+$/, MESSAGE)
    .refine(
      (text) => Number(text) >= MIN_COLUMN_WIDTH && Number(text) <= MAX_COLUMN_WIDTH,
      MESSAGE,
    ),
})

type Values = z.infer<typeof schema>

type ColumnWidthPopoverProps = {
  /** Where the popover points: the active cell, in the grid's own coordinates. */
  anchor: CSSProperties
  /** The width the column has now. */
  width: number
  onSubmit: (width: number) => void
  onClose: () => void
}

/** A small form under the active cell to type the width of its column in pixels. */
export function ColumnWidthPopover({ anchor, width, onSubmit, onClose }: ColumnWidthPopoverProps) {
  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { width: String(width) },
  })

  return (
    <Popover open onOpenChange={(open) => !open && onClose()}>
      <PopoverAnchor asChild>
        <div aria-hidden className="pointer-events-none absolute" style={anchor} />
      </PopoverAnchor>
      <PopoverContent
        aria-label="Column width"
        align="start"
        className="w-60"
        onCloseAutoFocus={(event) => {
          // The keyboard goes back to the grid, which the close handler of the grid does.
          event.preventDefault()
        }}
      >
        <Form {...form}>
          <form
            noValidate
            className="flex flex-col gap-3"
            onSubmit={form.handleSubmit((values) => onSubmit(Number(values.width)))}
          >
            <FormField
              control={form.control}
              name="width"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Column width (px)</FormLabel>
                  <FormControl>
                    <Input
                      type="number"
                      inputMode="numeric"
                      min={MIN_COLUMN_WIDTH}
                      max={MAX_COLUMN_WIDTH}
                      step={1}
                      autoComplete="off"
                      autoFocus
                      onFocus={(event) => event.currentTarget.select()}
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <Button type="submit" size="sm" className="self-end">
              Set width
            </Button>
          </form>
        </Form>
      </PopoverContent>
    </Popover>
  )
}
