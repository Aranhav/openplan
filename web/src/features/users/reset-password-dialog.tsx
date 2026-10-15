import { zodResolver } from "@hookform/resolvers/zod"
import { Loader2 } from "lucide-react"
import { useForm } from "react-hook-form"
import { toast } from "sonner"
import { z } from "zod"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form"
import { Input } from "@/components/ui/input"
import type { components } from "@/lib/api/schema"
import { closeUnlessBusy } from "@/lib/close-unless-busy"
import { reportFormError } from "@/lib/form-errors"
import { passwordSchema } from "@/lib/validation"
import { useUpdateUser } from "./api"

const schema = z.object({ password: passwordSchema })

type ResetPasswordValues = z.infer<typeof schema>

interface ResetPasswordDialogProps {
  user: Pick<components["schemas"]["UserDto"], "id" | "name">
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Called as the dialog closes; preventing the event stops focus returning to where it was. */
  onCloseAutoFocus?: (event: Event) => void
}

export function ResetPasswordDialog({
  user,
  open,
  onOpenChange,
  onCloseAutoFocus,
}: ResetPasswordDialogProps) {
  const updateUser = useUpdateUser()
  return (
    <Dialog open={open} onOpenChange={closeUnlessBusy(updateUser.isPending, onOpenChange)}>
      <DialogContent onCloseAutoFocus={onCloseAutoFocus} showCloseButton={!updateUser.isPending}>
        <DialogHeader>
          <DialogTitle>Reset password</DialogTitle>
          <DialogDescription>
            {`Set a new password for ${user.name}. They will be signed out everywhere and can change it from their profile.`}
          </DialogDescription>
        </DialogHeader>
        <ResetPasswordForm
          user={user}
          updateUser={updateUser}
          onClose={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  )
}

// A separate component, so the form starts empty each time the dialog opens.
function ResetPasswordForm({
  user,
  updateUser,
  onClose,
}: {
  user: ResetPasswordDialogProps["user"]
  updateUser: ReturnType<typeof useUpdateUser>
  onClose: () => void
}) {
  const form = useForm<ResetPasswordValues>({
    resolver: zodResolver(schema),
    defaultValues: { password: "" },
  })

  async function onSubmit({ password }: ResetPasswordValues) {
    try {
      await updateUser.mutateAsync({ id: user.id, password })
      toast.success("Password reset")
      onClose()
    } catch (error) {
      reportFormError(form, error)
    }
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} noValidate className="flex flex-col gap-4">
        <FormField
          control={form.control}
          name="password"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Temporary password</FormLabel>
              <FormControl>
                <Input autoComplete="off" spellCheck={false} autoFocus {...field} />
              </FormControl>
              <FormDescription>At least 10 characters.</FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />
        <DialogFooter>
          <Button type="button" variant="outline" disabled={updateUser.isPending} onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={updateUser.isPending}>
            {updateUser.isPending && <Loader2 className="animate-spin" />}
            Reset password
          </Button>
        </DialogFooter>
      </form>
    </Form>
  )
}
