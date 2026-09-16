import { defineConfig, devices } from "@playwright/test";

/**
 * Browser proofs for Phase 1.
 *
 * The brief asks for results in Chrome, Chrome Incognito, Firefox and Firefox
 * Private. Two honesty notes that belong in the config rather than buried in a
 * report:
 *
 * 1. "Chrome Incognito" is not literally reproducible by Playwright. Incognito
 *    is a browser-level profile mode; what a test can create is a fresh, empty
 *    browser context with no stored state, which is the property that actually
 *    matters here — nothing carried over from a previous session. The projects
 *    below are named for what they really are, so no result claims more than it
 *    proves.
 *
 * 2. Safari is absent by decision, and could not be run honestly from Linux
 *    anyway. No Safari result is reported or implied.
 */

const PRIMARY = process.env.E2E_PRIMARY_HOST ?? "login.portal-a.test:3000";

/**
 * This environment ships a Chromium build from an older Playwright revision.
 * Pointing at it directly is preferred over downloading a second copy — the
 * test is about our sign-in flow, not about which Chromium patch level runs it.
 */
const CHROMIUM =
  process.env.E2E_CHROMIUM_PATH ??
  "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";

/**
 * Firefox honours the system proxy; Chromium here does not. With an HTTPS proxy
 * set in the environment, Firefox sends requests for the local .test hostnames
 * to a proxy that cannot resolve them, and every navigation hangs until the
 * test times out. Turning the proxy off inside the browser profile keeps the
 * two engines testing the same thing.
 *
 *   network.proxy.type = 0   no proxy
 *   network.dns.native... .  resolve through the OS, so /etc/hosts applies
 *   network.trr.mode = 5     DNS-over-HTTPS fully disabled, for the same reason
 */
const FIREFOX_LAUNCH = {
  firefoxUserPrefs: {
    "network.proxy.type": 0,
    "network.trr.mode": 5,
    "network.dns.disablePrefetch": true,
  },
};

export default defineConfig({
  testDir: "./test/e2e",
  globalSetup: "./test/e2e/global-setup.ts",
  fullyParallel: false, // sign-in state and the code sink are shared
  workers: 1,
  reporter: [["list"]],
  timeout: 60_000,
  expect: { timeout: 10_000 },

  use: {
    baseURL: `http://${PRIMARY}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    // The existing storefront blocks headless browsers by user-agent. Anything
    // pointed at a host with that middleware needs a real browser string or it
    // is answered with 403 before it reaches a single page.
    userAgent:
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
  },

  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], launchOptions: { executablePath: CHROMIUM } },
    },
    {
      name: "chromium-fresh-profile",
      use: {
        ...devices["Desktop Chrome"],
        launchOptions: { executablePath: CHROMIUM },
        storageState: { cookies: [], origins: [] },
      },
    },
    {
      name: "firefox",
      use: { ...devices["Desktop Firefox"], launchOptions: FIREFOX_LAUNCH },
    },
    {
      name: "firefox-fresh-profile",
      use: {
        ...devices["Desktop Firefox"],
        launchOptions: FIREFOX_LAUNCH,
        storageState: { cookies: [], origins: [] },
      },
    },
  ],
});
