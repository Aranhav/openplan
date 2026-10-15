import { zodResolver } from "@hookform/resolvers/zod"
import { Loader2 } from "lucide-react"
import { useId } from "react"
import { useForm } from "react-hook-form"
import { toast } from "sonner"
import { z } from "zod"
import { Button } from "@/components/ui/button"
import { CardContent, CardFooter } from "@/components/ui/card"
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import type { components } from "@/lib/api/schema"
import { reportFormError } from "@/lib/form-errors"
import { personNameSchema } from "@/lib/validation"
import { useUpdateProfile } from "@/features/users/api"

const schema = z.object({ name: personNameSchema })

type ProfileValues = z.infer<typeof schema>

/** The contents of the "Profile" card. */
export function ProfileForm({ user }: { user: components["schemas"]["CurrentUser"] }) {
  const updateProfile = useUpdateProfile()
  const emailId = useId()
  // The form follows the name: untouched, it takes the latest saved one (a rename from elsewhere
  // shows up); being edited, it keeps what was typed.
  const form = useForm<ProfileValues>({
    resolver: zodResolver(schema),
    values: { name: user.name },
    resetOptions: { keepDirtyValues: true },
  })

  async function onSubmit({ name }: ProfileValues) {
    // Nothing to send when only spaces were added around the name.
    if (name === user.name) {
      form.reset({ name }, { keepDirtyValues: false })
      return
    }
    try {
      const saved = await updateProfile.mutateAsync({ name })
      // Starts over from what the server kept (the name, trimmed), so the form is clean again;
      // without the option, the form's own `keepDirtyValues` would keep what was typed.
      form.reset({ name: saved.name }, { keepDirtyValues: false })
      toast.success("Changes saved")
    } catch (error) {
      reportFormError(form, error)
    }
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} noValidate className="flex flex-col gap-6">
        <CardContent className="flex flex-col gap-6">
          <FormField
            control={form.control}
            name="name"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Name</FormLabel>
                <FormControl>
                  <Input autoComplete="name" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <div className="grid gap-2">
            <Label htmlFor={emailId}>Email</Label>
            <Input
              id={emailId}
              value={user.email}
              readOnly
              aria-describedby={`${emailId}-hint`}
              className="bg-muted/50 text-muted-foreground"
            />
            <p id={`${emailId}-hint`} className="text-sm text-muted-foreground">
              You sign in with this email. It can't be changed here.
            </p>
          </div>
        </CardContent>
        <CardFooter className="justify-end">
          <Button type="submit" disabled={!form.formState.isDirty || updateProfile.isPending}>
            {updateProfile.isPending && <Loader2 className="animate-spin" />}
            Save changes
          </Button>
        </CardFooter>
      </form>
    </Form>
  )
}
