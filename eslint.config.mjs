import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,

  /**
   * The tenancy rule, enforced by the build rather than by review.
   *
   * `lib/db/connection.ts` holds the only database pool in the application.
   * Anything that imports it directly can run an unscoped query, which is
   * precisely the mistake this project cannot afford — so importing it from
   * anywhere outside `lib/db/` is an error, not a warning.
   *
   * The message names the alternative, because a rule that only says "no"
   * gets worked around by whoever is in a hurry.
   */
  {
    files: ["**/*.{ts,tsx}"],
    ignores: ["lib/db/**", "scripts/**", "test/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "**/lib/db/connection",
                "**/db/connection",
                "@/lib/db/connection",
              ],
              message:
                "Import the scoped helpers from '@/lib/db' instead. " +
                "lib/db/connection.ts holds the raw pool and can run unscoped " +
                "queries; every read and write must go through a helper that " +
                "takes the session, so one client cannot be served another's data.",
            },
            {
              group: ["drizzle-orm/node-postgres", "pg"],
              message:
                "Only lib/db/connection.ts may open a database connection. " +
                "Use the scoped helpers exported from '@/lib/db'.",
            },
          ],
        },
      ],
    },
  },

  globalIgnores([
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "drizzle/**",
  ]),
]);

export default eslintConfig;
