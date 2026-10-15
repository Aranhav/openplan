import { zodResolver } from "@hookform/resolvers/zod"
import { CircleAlert, Loader2 } from "lucide-react"
import { useForm } from "react-hook-form"
import { toast } from "sonner"
import { z } from "zod"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { CardContent, CardFooter } from "@/components/ui/card"
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
import { rateLimitMessage } from "@/features/auth/rate-limit"
import { useChangePassword } from "@/features/users/api"
import { reportFormError } from "@/lib/form-errors"
import { passwordSchema } from "@/lib/validation"

// Field names match the API's, so server validation errors map straight onto them.
const schema = z
  .object({
    current_password: z.string().min(1, "Enter your current password."),
    new_password: passwordSchema,
    confirm_password: z.string(),
  })
  .refine((values) => values.new_password === values.confirm_password, {
    path: ["confirm_password"],
    message: "Passwords don't match.",
  })

type PasswordValues = z.infer<typeof schema>

const EMPTY: PasswordValues = { current_password: "", new_password: "", confirm_password: "" }

/** The contents of the "Password" card. */
export function PasswordForm() {
  const changePassword = useChangePassword()
  const form = useForm<PasswordValues>({ resolver: zodResolver(schema), defaultValues: EMPTY })
  const rateLimited = rateLimitMessage(changePassword.error)

  async function onSubmit({ current_password, new_password }: PasswordValues) {
    try {
      await changePassword.mutateAsync({ current_password, new_password })
      form.reset(EMPTY)
      toast.success("Password changed")
    } catch (error) {
      if (!rateLimitMessage(error)) {
        reportFormError(form, error)
      }
    }
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} noValidate className="flex flex-col gap-6">
        <CardContent className="flex flex-col gap-6">
          {rateLimited && (
            <Alert variant="destructive">
              <CircleAlert />
              <AlertDescription>{rateLimited}</AlertDescription>
            </Alert>
          )}
          <FormField
            control={form.control}
            name="current_password"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Current password</FormLabel>
                <FormControl>
                  <Input type="password" autoComplete="current-password" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="new_password"
            render={({ field }) => (
              <FormItem>
                <FormLabel>New password</FormLabel>
                <FormControl>
                  <Input type="password" autoComplete="new-password" {...field} />
                </FormControl>
                <FormDescription>At least 10 characters.</FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="confirm_password"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Confirm new password</FormLabel>
                <FormControl>
                  <Input type="password" autoComplete="new-password" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </CardContent>
        <CardFooter className="justify-end">
          <Button type="submit" disabled={changePassword.isPending}>
            {changePassword.isPending && <Loader2 className="animate-spin" />}
            Change password
          </Button>
        </CardFooter>
      </form>
    </Form>
  )
}
