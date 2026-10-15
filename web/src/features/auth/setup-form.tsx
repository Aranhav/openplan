import { zodResolver } from "@hookform/resolvers/zod"
import { useNavigate } from "@tanstack/react-router"
import { Loader2 } from "lucide-react"
import { type UseFormReturn, useForm } from "react-hook-form"
import { toast } from "sonner"
import { z } from "zod"
import { Button } from "@/components/ui/button"
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
import { ApiError, type FieldError, errorDetail } from "@/lib/api/client"
import { useSetup } from "./api"

// Field names match the API's, so server validation errors map straight onto them.
const schema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, "Name is required.")
      .max(100, "Name must be at most 100 characters."),
    email: z
      .string()
      .trim()
      .max(254, "Email must be at most 254 characters.")
      .regex(/^[^@]+@[^@]+$/, "Enter a valid email address."),
    password: z
      .string()
      .min(10, "Password must be at least 10 characters.")
      .max(256, "Password must be at most 256 characters."),
    confirm_password: z.string(),
    workspace_name: z
      .string()
      .trim()
      .min(1, "Workspace name is required.")
      .max(80, "Workspace name must be at most 80 characters."),
  })
  .refine((values) => values.password === values.confirm_password, {
    path: ["confirm_password"],
    message: "Passwords don't match.",
  })

type SetupValues = z.infer<typeof schema>

const DEFAULT_VALUES: SetupValues = {
  name: "",
  email: "",
  password: "",
  confirm_password: "",
  workspace_name: "",
}

function isFormField(field: string): field is keyof SetupValues {
  return field in DEFAULT_VALUES
}

/** Shows the server's field errors under their inputs; returns whether any matched. */
function showFieldErrors(form: UseFormReturn<SetupValues>, errors: FieldError[]): boolean {
  let shown = false
  for (const { field, message } of errors) {
    if (isFormField(field)) {
      form.setError(field, { message }, { shouldFocus: !shown })
      shown = true
    }
  }
  return shown
}

export function SetupForm() {
  const setup = useSetup()
  const navigate = useNavigate()
  const form = useForm<SetupValues>({
    resolver: zodResolver(schema),
    defaultValues: DEFAULT_VALUES,
  })

  async function onSubmit(values: SetupValues) {
    try {
      await setup.mutateAsync({
        name: values.name,
        email: values.email,
        password: values.password,
        workspace_name: values.workspace_name,
      })
    } catch (error) {
      if (!(error instanceof ApiError && showFieldErrors(form, error.errors))) {
        toast.error(errorDetail(error))
      }
      return
    }
    await navigate({ to: "/" })
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} noValidate className="flex flex-col gap-4">
        <FormField
          control={form.control}
          name="name"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Your name</FormLabel>
              <FormControl>
                <Input autoComplete="name" autoFocus {...field} />
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
              <FormLabel>Work email</FormLabel>
              <FormControl>
                <Input type="email" autoComplete="email" {...field} />
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
              <FormLabel>Confirm password</FormLabel>
              <FormControl>
                <Input type="password" autoComplete="new-password" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="workspace_name"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Workspace name</FormLabel>
              <FormControl>
                <Input placeholder="Acme Corp" autoComplete="organization" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <Button type="submit" disabled={form.formState.isSubmitting}>
          {form.formState.isSubmitting && <Loader2 className="animate-spin" />}
          Create account
        </Button>
      </form>
    </Form>
  )
}
