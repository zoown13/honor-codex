import { defineConfig, devices } from "@playwright/test";

const slug = process.env.NEXT_PUBLIC_PILOT_SLUG ?? "honor-family-pilot-demo";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: `http://127.0.0.1:4173/pilot/${slug}/`,
    trace: "on-first-retry"
  },
  webServer: {
    command: "pnpm dev --hostname 127.0.0.1 --port 4173",
    url: `http://127.0.0.1:4173/pilot/${slug}/`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000
  },
  projects: [
    { name: "mobile-chromium", use: { ...devices["Pixel 7"] } },
    { name: "desktop-chromium", use: { ...devices["Desktop Chrome"] } }
  ]
});
