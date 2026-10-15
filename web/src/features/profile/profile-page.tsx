import { PageHeader } from "@/components/page-header"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { useMe } from "@/features/auth/api"
import { PasswordForm } from "./password-form"
import { ProfileForm } from "./profile-form"

export function ProfilePage() {
  const { data: me } = useMe()

  if (!me) {
    return (
      <>
        <PageHeader title="Profile" />
        <div role="status" aria-label="Loading profile" className="flex max-w-2xl flex-col gap-6">
          {[2, 3].map((fields) => (
            <Card key={fields}>
              <CardHeader>
                <Skeleton className="h-5 w-24" />
              </CardHeader>
              <CardContent className="grid gap-4">
                {Array.from({ length: fields }, (_, index) => (
                  <Skeleton key={index} className="h-9 w-full" />
                ))}
              </CardContent>
            </Card>
          ))}
        </div>
      </>
    )
  }

  return (
    <>
      <PageHeader title="Profile" description="Your name and password." />
      <div className="flex max-w-2xl flex-col gap-6">
        <Card>
          <CardHeader>
            <CardTitle role="heading" aria-level={2}>
              Profile
            </CardTitle>
            <CardDescription>The name other people see next to your work.</CardDescription>
          </CardHeader>
          <ProfileForm user={me.user} />
        </Card>
        <Card>
          <CardHeader>
            <CardTitle role="heading" aria-level={2}>
              Password
            </CardTitle>
            <CardDescription>Changing it signs you out on every other device.</CardDescription>
          </CardHeader>
          <PasswordForm email={me.user.email} />
        </Card>
      </div>
    </>
  )
}
