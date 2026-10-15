import { defineConfig, devices } from "@playwright/test"

const BASE_URL = "http://localhost:8090"

// The specs share one server and one database, so they run one at a time. `onboarding` creates
// the instance's admin and workspace, which the other specs sign in with; they depend on it.
export default defineConfig({
  testDir: "./tests",
  workers: 1,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
  },
  webServer: {
    command: "bash scripts/start-server.sh",
    url: `${BASE_URL}/api/health`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
  projects: [
    {
      name: "setup",
      testMatch: "onboarding.spec.ts",
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "app",
      testIgnore: "onboarding.spec.ts",
      dependencies: ["setup"],
      use: { ...devices["Desktop Chrome"] },
    },
  ],
})
