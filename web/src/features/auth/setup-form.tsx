import { zodResolver } from "@hookform/resolvers/zod"
import { useNavigate } from "@tanstack/react-router"
import { Loader2 } from "lucide-react"
import { useForm } from "react-hook-form"
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
import { ApiError } from "@/lib/api/client"
import { reportFormError } from "@/lib/form-errors"
import {
  emailSchema,
  passwordSchema,
  personNameSchema,
  workspaceNameSchema,
} from "@/lib/validation"
import { useSetup } from "./api"

// Field names match the API's, so server validation errors map straight onto them.
const schema = z
  .object({
    name: personNameSchema,
    email: emailSchema,
    password: passwordSchema,
    confirm_password: z.string(),
    workspace_name: workspaceNameSchema,
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
      if (error instanceof ApiError && error.code === "setup.already_done") {
        toast.info("OpenPlan is already set up. Sign in to continue.")
        await navigate({ to: "/login" })
      } else {
        reportFormError(form, error)
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
