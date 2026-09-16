import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

/**
 * Apply migrations on deploy.
 *
 * Plain JavaScript, using only production dependencies. The drizzle-kit CLI is
 * a devDependency and a production image may not carry it, so a pre-deploy step
 * that shells out to it fails exactly where it is least convenient to debug.
 * drizzle-orm's migrator ships in the runtime package and reads the same SQL
 * files, so this works from the deployed image as it stands.
 *
 * Connects as the OWNER: migrations create tables and policies, which the
 * application's restricted role cannot and must not be able to do.
 */

const url = process.env.DATABASE_URL;
if (!url) {
  console.error(
    "DATABASE_URL is not set. Migrations run as the table owner; the " +
      "application connects separately as the restricted role.",
  );
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: url, max: 1 });

try {
  await migrate(drizzle(pool), { migrationsFolder: "./drizzle" });
  console.log("Migrations applied.");

  /**
   * Give the restricted role its password.
   *
   * The migration creates `portal_app` with no password, because a password
   * does not belong in a file committed to a repository. It is set here from
   * the environment, by the one connection that is allowed to — the owner's.
   *
   * This runs on every deploy and is idempotent: ALTER ROLE simply sets the
   * password again to the same value.
   */
  const appPassword = process.env.PORTAL_APP_PASSWORD;
  if (appPassword) {
    const client = await pool.connect();
    try {
      // ALTER ROLE will not take a bind parameter for a password, and building
      // the statement by concatenation is how SQL injection gets in. So the
      // value is passed as a parameter into a session setting, and the server
      // quotes it itself via format(%L) — the password never appears in any
      // string this script assembles.
      await client.query("SELECT set_config('portal.app_password', $1, false)", [
        appPassword,
      ]);
      await client.query(
        `DO $$ BEGIN
           EXECUTE format(
             'ALTER ROLE portal_app WITH LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD %L',
             current_setting('portal.app_password')
           );
         END $$;`,
      );
      await client.query("SELECT set_config('portal.app_password', '', false)");
      console.log("Restricted application role configured.");
    } finally {
      client.release();
    }
  } else {
    console.warn(
      "PORTAL_APP_PASSWORD is not set — the restricted role has no password, " +
        "so the application will not be able to connect.",
    );
  }
} catch (error) {
  console.error("Migration failed:", error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
