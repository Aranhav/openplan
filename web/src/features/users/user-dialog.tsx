import { zodResolver } from "@hookform/resolvers/zod"
import { Loader2 } from "lucide-react"
import { useForm, useFormContext } from "react-hook-form"
import { toast } from "sonner"
import { z } from "zod"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
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
import { reportFormError } from "@/lib/form-errors"
import { emailSchema, passwordSchema, personNameSchema } from "@/lib/validation"
import { useCreateUser, useUpdateUser } from "./api"

type UserDto = components["schemas"]["UserDto"]

const OWN_ACCOUNT = "You can't change this for your own account."

const createSchema = z.object({
  name: personNameSchema,
  email: emailSchema,
  password: passwordSchema,
  is_instance_admin: z.boolean(),
})

const editSchema = z.object({
  name: personNameSchema,
  is_instance_admin: z.boolean(),
})

type CreateValues = z.infer<typeof createSchema>
type EditValues = z.infer<typeof editSchema>

interface UserDialogProps {
  /** The user to edit; without one the dialog creates a user. */
  user?: UserDto
  /** Whether `user` is the signed-in user, whose instance admin role they can't take away. */
  isSelf?: boolean
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Called as the dialog closes; preventing the event stops focus returning to where it was. */
  onCloseAutoFocus?: (event: Event) => void
}

export function UserDialog({
  user,
  isSelf = false,
  open,
  onOpenChange,
  onCloseAutoFocus,
}: UserDialogProps) {
  const createUser = useCreateUser()
  const updateUser = useUpdateUser()
  const pending = createUser.isPending || updateUser.isPending
  const onClose = () => onOpenChange(false)

  return (
    // Escape, the close button and a click outside all end up here; none may drop a request in flight.
    <Dialog open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
      <DialogContent onCloseAutoFocus={onCloseAutoFocus}>
        <DialogHeader>
          <DialogTitle>{user ? "Edit user" : "Create user"}</DialogTitle>
          <DialogDescription>
            {user
              ? `Change the name or role of ${user.name}.`
              : "Create an account. Share the temporary password with them; they can change it from their profile."}
          </DialogDescription>
        </DialogHeader>
        {user ? (
          <EditUserForm user={user} isSelf={isSelf} updateUser={updateUser} onClose={onClose} />
        ) : (
          <CreateUserForm createUser={createUser} onClose={onClose} />
        )}
      </DialogContent>
    </Dialog>
  )
}

function InstanceAdminField({
  disabled = false,
  description,
}: {
  disabled?: boolean
  description: string
}) {
  const { control } = useFormContext<{ is_instance_admin: boolean }>()
  return (
    <FormField
      control={control}
      name="is_instance_admin"
      render={({ field }) => (
        <FormItem>
          <div className="flex items-start gap-3">
            <FormControl>
              <Checkbox
                ref={field.ref}
                checked={field.value}
                onCheckedChange={field.onChange}
                onBlur={field.onBlur}
                disabled={disabled}
                className="mt-0.5"
              />
            </FormControl>
            <div className="grid gap-1">
              <FormLabel>Instance admin</FormLabel>
              <FormDescription>{description}</FormDescription>
            </div>
          </div>
          <FormMessage />
        </FormItem>
      )}
    />
  )
}

// A separate component, so the form starts empty each time the dialog opens.
function CreateUserForm({
  createUser,
  onClose,
}: {
  createUser: ReturnType<typeof useCreateUser>
  onClose: () => void
}) {
  const form = useForm<CreateValues>({
    resolver: zodResolver(createSchema),
    defaultValues: { name: "", email: "", password: "", is_instance_admin: false },
  })

  async function onSubmit(values: CreateValues) {
    try {
      const created = await createUser.mutateAsync(values)
      toast.success(`${created.name} created`)
      onClose()
    } catch (error) {
      reportFormError(form, error, { "user.email_taken": "email" })
    }
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} noValidate className="flex flex-col gap-4">
        <FormField
          control={form.control}
          name="name"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Name</FormLabel>
              <FormControl>
                <Input autoComplete="off" autoFocus {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="email"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Email</FormLabel>
              <FormControl>
                <Input type="email" autoComplete="off" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="password"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Temporary password</FormLabel>
              <FormControl>
                <Input autoComplete="off" spellCheck={false} {...field} />
              </FormControl>
              <FormDescription>At least 10 characters.</FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />
        <InstanceAdminField description="Can create and manage user accounts, and is an admin of every workspace." />
        <DialogFooter>
          <Button type="button" variant="outline" disabled={createUser.isPending} onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={createUser.isPending}>
            {createUser.isPending && <Loader2 className="animate-spin" />}
            Create user
          </Button>
        </DialogFooter>
      </form>
    </Form>
  )
}

// A separate component, so the form starts from the user's details each time the dialog opens.
function EditUserForm({
  user,
  isSelf,
  updateUser,
  onClose,
}: {
  user: UserDto
  isSelf: boolean
  updateUser: ReturnType<typeof useUpdateUser>
  onClose: () => void
}) {
  const form = useForm<EditValues>({
    resolver: zodResolver(editSchema),
    // Follows the user as the list refreshes, but never overwrites what is being typed.
    values: { name: user.name, is_instance_admin: user.is_instance_admin },
    resetOptions: { keepDirtyValues: true },
  })

  async function onSubmit(values: EditValues) {
    // Only what changed is sent, so an edit never undoes a change made somewhere else meanwhile.
    const changes: Partial<EditValues> = {}
    if (values.name !== user.name) {
      changes.name = values.name
    }
    if (values.is_instance_admin !== user.is_instance_admin) {
      changes.is_instance_admin = values.is_instance_admin
    }
    if (Object.keys(changes).length === 0) {
      onClose()
      return
    }
    try {
      await updateUser.mutateAsync({ id: user.id, ...changes })
      toast.success("User updated")
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
          name="name"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Name</FormLabel>
              <FormControl>
                <Input autoComplete="off" autoFocus {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <InstanceAdminField
          disabled={isSelf}
          description={
            isSelf
              ? OWN_ACCOUNT
              : "Can create and manage user accounts, and is an admin of every workspace."
          }
        />
        <DialogFooter>
          <Button type="button" variant="outline" disabled={updateUser.isPending} onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={updateUser.isPending}>
            {updateUser.isPending && <Loader2 className="animate-spin" />}
            Save changes
          </Button>
        </DialogFooter>
      </form>
    </Form>
  )
}
