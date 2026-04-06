import { defineConfig, devices } from "playwright/test";

export default defineConfig({
  testDir: "./tests",
  timeout: 30_000,

  use: {
    baseURL: "http://127.0.0.1:14434",
    headless: false,
  },

  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        launchOptions: {
          args: [],
        },
      },
    },
  ],

  // Re-use an already-running tile server; start one if not present.
  // Assumes `deno task bundle` has been run first.
  webServer: {
    // Use the version from .dvmrc explicitly so Playwright gets the right Deno.
    command: "PATH=/home/work/.dvm/versions/2.7.11:$PATH deno task tile",
    url: "http://127.0.0.1:14434/health",
    timeout: 30_000,
    reuseExistingServer: true,
    stdout: "pipe",
    stderr: "pipe",
  },
});
