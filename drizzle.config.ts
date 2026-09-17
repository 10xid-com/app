import { defineConfig } from "drizzle-kit";

// Node 22 can read a dotenv file natively, so this needs no dependency.
// In production the variables come from the platform and the file is absent.
try {
  process.loadEnvFile(".env.local");
} catch {
  /* no local env file — expected in CI and on the deployed app */
}

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL is not set. Migrations connect as the table OWNER; " +
      "the application connects as the restricted role in DATABASE_APP_URL.",
  );
}

export default defineConfig({
  schema: "./lib/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  // Migrations deliberately use the owner connection, never the app's
  // restricted role — the app role cannot and must not create tables.
  dbCredentials: { url: process.env.DATABASE_URL },
  strict: true,
  verbose: true,
});
