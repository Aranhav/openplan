import { zodResolver } from "@hookform/resolvers/zod"
import { useNavigate } from "@tanstack/react-router"
import { CircleAlert, Loader2 } from "lucide-react"
import { useForm } from "react-hook-form"
import { toast } from "sonner"
import { z } from "zod"
import { Alert, AlertDescription } from "@/components/ui/alert"
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
import { ApiError, errorDetail } from "@/lib/api/client"
import { useLogin } from "./api"
import { rateLimitMessage } from "./rate-limit"
import { safeRedirectPath } from "./redirect"

const schema = z.object({
  email: z.string().trim().min(1, "Enter your email."),
  password: z.string().min(1, "Enter your password."),
})

type LoginValues = z.infer<typeof schema>

interface LoginFormProps {
  /** Where to go after signing in; anything outside this app is ignored. */
  redirectTo?: string
}

function failureAlert(error: unknown): string | undefined {
  if (error instanceof ApiError && error.code === "auth.invalid_credentials") {
    return "Email or password is incorrect."
  }
  return rateLimitMessage(error)
}

export function LoginForm({ redirectTo }: LoginFormProps) {
  const login = useLogin()
  const navigate = useNavigate()
  const form = useForm<LoginValues>({
    resolver: zodResolver(schema),
    defaultValues: { email: "", password: "" },
  })
  const alert = failureAlert(login.error)

  async function onSubmit(values: LoginValues) {
    try {
      await login.mutateAsync(values)
    } catch (error) {
      if (error instanceof ApiError && error.code === "auth.invalid_credentials") {
        form.setFocus("password", { shouldSelect: true })
      } else if (!failureAlert(error)) {
        toast.error(errorDetail(error))
      }
      return
    }
    await navigate({ href: safeRedirectPath(redirectTo) })
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} noValidate className="flex flex-col gap-4">
        {alert && (
          <Alert variant="destructive">
            <CircleAlert />
            <AlertDescription>{alert}</AlertDescription>
          </Alert>
        )}
        <FormField
          control={form.control}
          name="email"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Email</FormLabel>
              <FormControl>
                <Input type="email" autoComplete="username" autoFocus {...field} />
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
              <FormLabel>Password</FormLabel>
              <FormControl>
                <Input type="password" autoComplete="current-password" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <Button type="submit" disabled={form.formState.isSubmitting}>
          {form.formState.isSubmitting && <Loader2 className="animate-spin" />}
          Sign in
        </Button>
      </form>
    </Form>
  )
}
