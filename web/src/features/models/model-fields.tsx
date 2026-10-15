import { useFormContext } from "react-hook-form"
import { FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"

export function ModelNameField({ autoFocus }: { autoFocus?: boolean }) {
  const { control } = useFormContext<{ name: string }>()
  return (
    <FormField
      control={control}
      name="name"
      render={({ field }) => (
        <FormItem>
          <FormLabel>Name</FormLabel>
          <FormControl>
            <Input placeholder="FY27 Budget" autoComplete="off" autoFocus={autoFocus} {...field} />
          </FormControl>
          <FormMessage />
        </FormItem>
      )}
    />
  )
}

export function ModelDescriptionField() {
  const { control } = useFormContext<{ description: string }>()
  return (
    <FormField
      control={control}
      name="description"
      render={({ field }) => (
        <FormItem>
          <FormLabel>Description</FormLabel>
          <FormControl>
            <Textarea placeholder="What is this model for? (optional)" {...field} />
          </FormControl>
          <FormMessage />
        </FormItem>
      )}
    />
  )
}
