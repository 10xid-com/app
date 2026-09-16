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
  await bootstrap(pool);
  await registerClientDomains(pool);
} catch (error) {
  console.error("Migration failed:", error);
  process.exitCode = 1;
} finally {
  await pool.end();
}

/**
 * First-run seed.
 *
 * Accounts are invitation-only — there is no sign-up form — so a brand new
 * deployment has no way in. This creates the first staff account, and a client
 * account alongside it so both sides of the portal can be seen.
 *
 * Runs ONLY when the users table is completely empty. It is not an "upsert the
 * admin" step: once anybody exists, this does nothing at all, so it can never
 * resurrect a removed account or quietly re-grant staff to an address.
 */
async function bootstrap(pool) {
  const staffEmail = process.env.BOOTSTRAP_EMAIL?.trim().toLowerCase();
  if (!staffEmail) return;

  const { rows: existing } = await pool.query(
    "select count(*)::int as n from users",
  );
  if (existing[0].n > 0) {
    console.log("Bootstrap skipped: accounts already exist.");
    return;
  }

  // A plus-address by default, so both accounts land in the same inbox while
  // remaining two distinct people to the system.
  const [local, domain] = staffEmail.split("@");
  const clientEmail =
    process.env.BOOTSTRAP_CLIENT_EMAIL?.trim().toLowerCase() ??
    `${local}+rotary@${domain}`;

  const client = await pool.connect();
  try {
    await client.query("begin");

    const org = async (type, name, slug, hex) =>
      (
        await client.query(
          `insert into organizations (type, name, slug, brand_primary_hex)
           values ($1,$2,$3,$4) returning id`,
          [type, name, slug, hex],
        )
      ).rows[0].id;

    const internal = await org("internal", "Branding Centres", "branding-centres", "#26467F");
    const rotary = await org("client", "Rotary", "rotary", "#003F87");
    const northstar = await org("client", "Northstar Roofing", "northstar", "#B5441F");

    const user = async (email, name, isStaff) =>
      (
        await client.query(
          `insert into users (email, full_name, is_staff, email_verified_at)
           values ($1,$2,$3, now()) returning id`,
          [email, name, isStaff],
        )
      ).rows[0].id;

    const staffId = await user(staffEmail, "Paolo", true);
    const clientId = await user(clientEmail, "Rotary contact", false);

    await client.query(
      `insert into memberships (user_id, organization_id, role) values ($1,$2,'staff')`,
      [staffId, internal],
    );
    await client.query(
      `insert into memberships (user_id, organization_id, role) values ($1,$2,'owner')`,
      [clientId, rotary],
    );

    // Two clients with jobs, so tenant isolation has something to demonstrate:
    // the Rotary account must never see the Northstar rows.
    const job = async (orgId, ref, direction, title, createdBy, status) => {
      const { rows } = await client.query(
        `insert into jobs (id, organization_id, ref, direction, title, status, created_by)
         values (gen_random_uuid(), $1,$2,$3,$4,$5,$6) returning id`,
        [orgId, ref, direction, title, status, createdBy],
      );
      await client.query(
        `insert into job_events (job_id, organization_id, actor_id, actor_email_at_time, action, after)
         values ($1,$2,$3,$4,'created',$5)`,
        [rows[0].id, orgId, createdBy, staffEmail, JSON.stringify({ title, status })],
      );
    };

    await job(rotary, "ROT-0001", "from_client", "District 7070 banner artwork", staffId, "open");
    await job(rotary, "ROT-0002", "to_client", "Club pin proof — second round", staffId, "in_progress");
    await job(northstar, "NOR-0001", "from_client", "Fleet vehicle wrap — 3 vans", staffId, "open");

    await client.query("update organizations set job_counter = 2 where type = 'client'");
    await client.query("commit");

    console.log(`Bootstrapped. Staff: ${staffEmail}  Client: ${clientEmail}`);
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Register client-facing hostnames.
 *
 * PORTAL_CLIENT_DOMAINS is "slug=hostname" pairs, comma separated:
 *
 *   rotary=portal-rotary.up.railway.app,northstar=jobs.northstar.example
 *
 * This table is what the cross-domain handoff redeems against — a destination
 * is the id of a row here, never a URL from the request — so adding a hostname
 * is deliberately a deployment decision rather than something a form can do.
 *
 * Idempotent: a hostname already pointing at the right company is left alone,
 * and one pointing at a different company is corrected rather than duplicated.
 */
async function registerClientDomains(pool) {
  const spec = process.env.PORTAL_CLIENT_DOMAINS?.trim();
  if (!spec) return;

  for (const pair of spec.split(",")) {
    const [slug, hostname] = pair.split("=").map((s) => s?.trim().toLowerCase());
    if (!slug || !hostname) {
      console.warn(`Skipping malformed domain entry: "${pair}"`);
      continue;
    }

    const { rows } = await pool.query(
      "select id from organizations where slug = $1 and type = 'client'",
      [slug],
    );
    if (rows.length === 0) {
      console.warn(`Skipping "${hostname}": no client company with slug "${slug}".`);
      continue;
    }

    await pool.query(
      `insert into organization_domains (organization_id, hostname, is_primary, verified_at)
       values ($1, $2, true, now())
       on conflict (hostname) do update
         set organization_id = excluded.organization_id,
             verified_at = now()`,
      [rows[0].id, hostname],
    );
    console.log(`Domain registered: ${hostname} → ${slug}`);
  }
}
