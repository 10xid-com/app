import { pathToFileURL } from "node:url";

const EXPECTED = Object.freeze({
  database: "portal_ci",
  port: "5432",
  ownerUser: "ci_owner",
  appUser: "portal_app",
});

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost"]);

function fail(message) {
  throw new Error(`CI database guard refused target: ${message}`);
}

function decodeUrlPart(name, label, value) {
  try {
    return decodeURIComponent(value);
  } catch {
    fail(`${name} has malformed percent-encoding in ${label}`);
  }
}

export function parseDatabaseUrl(name, raw, expectedUser) {
  if (!raw) fail(`${name} is missing`);

  let url;
  try {
    url = new URL(raw);
  } catch {
    fail(`${name} is malformed`);
  }

  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    fail(`${name} must use postgres:// or postgresql://`);
  }
  if (!LOOPBACK_HOSTS.has(url.hostname)) {
    fail(`${name} host must be exactly localhost or 127.0.0.1`);
  }
  if ((url.port || "5432") !== EXPECTED.port) {
    fail(`${name} port must be ${EXPECTED.port}`);
  }
  const username = decodeUrlPart(name, "username", url.username);
  const pathname = decodeUrlPart(name, "database name", url.pathname);

  if (username !== expectedUser) {
    fail(`${name} username must be ${expectedUser}`);
  }
  if (!url.password) {
    fail(`${name} must contain a disposable CI-only password`);
  }
  if (pathname !== `/${EXPECTED.database}`) {
    fail(`${name} database must be exactly ${EXPECTED.database}`);
  }
  if (url.search || url.hash) {
    fail(`${name} must not contain query parameters or fragments`);
  }

  return {
    raw,
    hostClass: "loopback",
    port: url.port || "5432",
    database: pathname.slice(1),
    username,
  };
}

export function validateTargetUrls(env = process.env) {
  const owner = parseDatabaseUrl("DATABASE_URL", env.DATABASE_URL, EXPECTED.ownerUser);
  const app = parseDatabaseUrl(
    "DATABASE_APP_URL",
    env.DATABASE_APP_URL,
    EXPECTED.appUser,
  );

  if (
    owner.hostClass !== app.hostClass ||
    owner.port !== app.port ||
    owner.database !== app.database
  ) {
    fail("DATABASE_URL and DATABASE_APP_URL do not point at the same local target");
  }

  return { owner, app };
}

async function connectChecked(connectionString, makeClient) {
  const client = await makeClient({ connectionString });
  await client.connect();
  return client;
}

async function queryOne(client, sql) {
  const result = await client.query(sql);
  if (result.rows.length !== 1) {
    fail("database verification query returned an unexpected row count");
  }
  return result.rows[0];
}

async function verifyOwnerConnection(owner, makeClient, mode) {
  const client = await connectChecked(owner.raw, makeClient);
  try {
    const facts = await queryOne(
      client,
      `
        /* ci-db-guard:owner-facts */
        select
          current_database() as database,
          current_user as role,
          session_user as session_role,
          inet_server_addr()::text as server_addr,
          inet_server_port()::int as server_port
      `,
    );

    if (facts.database !== EXPECTED.database) {
      fail("live owner connection is not connected to portal_ci");
    }
    if (facts.role !== EXPECTED.ownerUser || facts.session_role !== EXPECTED.ownerUser) {
      fail("live owner connection is not authenticated directly as ci_owner");
    }
    if (!["127.0.0.1", "::1"].includes(facts.server_addr)) {
      fail("live owner connection is not served from a loopback address");
    }
    if (Number(facts.server_port) !== Number(EXPECTED.port)) {
      fail("live owner connection is not served from port 5432");
    }

    if (mode === "pre-migrate") {
      const blank = await queryOne(
        client,
        `
          /* ci-db-guard:blank-target */
          select count(*)::int as user_tables
          from pg_tables
          where schemaname not in ('pg_catalog', 'information_schema')
        `,
      );
      if (Number(blank.user_tables) !== 0) {
        fail("pre-migrate target is not blank");
      }
    }
  } finally {
    await client.end();
  }
}

async function verifyAppConnection(app, makeClient) {
  const client = await connectChecked(app.raw, makeClient);
  try {
    const role = await queryOne(
      client,
      `
        /* ci-db-guard:app-role */
        select
          current_database() as database,
          current_user as role,
          session_user as session_role,
          inet_server_addr()::text as server_addr,
          inet_server_port()::int as server_port,
          r.rolsuper,
          r.rolbypassrls,
          r.rolcreatedb,
          r.rolcreaterole,
          r.rolreplication
        from pg_roles r
        where r.rolname = current_user
      `,
    );

    if (role.database !== EXPECTED.database) {
      fail("live app connection is not connected to portal_ci");
    }
    if (role.role !== EXPECTED.appUser || role.session_role !== EXPECTED.appUser) {
      fail("live app connection is not authenticated directly as portal_app");
    }
    if (!["127.0.0.1", "::1"].includes(role.server_addr)) {
      fail("live app connection is not served from a loopback address");
    }
    if (Number(role.server_port) !== Number(EXPECTED.port)) {
      fail("live app connection is not served from port 5432");
    }

    const forbiddenAttributes = [];
    if (role.rolsuper) forbiddenAttributes.push("SUPERUSER");
    if (role.rolbypassrls) forbiddenAttributes.push("BYPASSRLS");
    if (role.rolcreatedb) forbiddenAttributes.push("CREATEDB");
    if (role.rolcreaterole) forbiddenAttributes.push("CREATEROLE");
    if (role.rolreplication) forbiddenAttributes.push("REPLICATION");
    if (forbiddenAttributes.length > 0) {
      fail(`portal_app has forbidden role attributes: ${forbiddenAttributes.join(", ")}`);
    }

    const ownership = await queryOne(
      client,
      `
        /* ci-db-guard:app-ownership */
        with app as (
          select oid from pg_roles where rolname = 'portal_app'
        )
        select
          (select count(*)::int
             from pg_database d, app
            where d.datdba = app.oid) as databases,
          (select count(*)::int
             from pg_namespace n, app
            where n.nspowner = app.oid
              and n.nspname in ('public', 'drizzle')) as schemas,
          (select count(*)::int
             from pg_class c
             join pg_namespace n on n.oid = c.relnamespace
             cross join app
            where c.relowner = app.oid
              and n.nspname in ('public', 'drizzle')) as relations,
          (select count(*)::int
             from pg_proc p
             join pg_namespace n on n.oid = p.pronamespace
             cross join app
            where p.proowner = app.oid
              and n.nspname in ('public', 'drizzle')) as routines,
          (select count(*)::int
             from pg_type t
             join pg_namespace n on n.oid = t.typnamespace
             cross join app
            where t.typowner = app.oid
              and n.nspname in ('public', 'drizzle')
              and t.typtype in ('e', 'd')) as types
      `,
    );

    const owned =
      Number(ownership.databases) +
      Number(ownership.schemas) +
      Number(ownership.relations) +
      Number(ownership.routines) +
      Number(ownership.types);
    if (owned !== 0) {
      fail("portal_app owns database/application schema objects");
    }

    const memberships = await client.query(`
      /* ci-db-guard:privilege-memberships */
      with recursive inherited_roles(roleid, path) as (
        select
          m.roleid,
          array[m.member, m.roleid]::oid[]
        from pg_auth_members m
        where m.member = (select oid from pg_roles where rolname = 'portal_app')

        union all

        select
          m.roleid,
          ir.path || m.roleid
        from pg_auth_members m
        join inherited_roles ir on m.member = ir.roleid
        where not m.roleid = any(ir.path)
      )
      select distinct r.rolname
      from inherited_roles ir
      join pg_roles r on r.oid = ir.roleid
      order by r.rolname
    `);

    if (memberships.rows.length > 0) {
      const names = memberships.rows.map((row) => row.rolname).join(", ");
      fail(
        `portal_app has unexpected role membership(s), treated as privilege-escalating: ${names}`,
      );
    }
  } finally {
    await client.end();
  }
}

async function defaultClientFactory(config) {
  const { default: pg } = await import("pg");
  return new pg.Client(config);
}

export async function runGuard(
  mode,
  {
    env = process.env,
    makeClient = defaultClientFactory,
    log = console.log,
  } = {},
) {
  if (mode !== "pre-migrate" && mode !== "post-migrate") {
    fail("mode must be pre-migrate or post-migrate");
  }

  const { owner, app } = validateTargetUrls(env);

  await verifyOwnerConnection(owner, makeClient, mode);

  if (mode === "post-migrate") {
    await verifyAppConnection(app, makeClient);
  }

  log(`CI database guard passed (${mode}): local disposable portal_ci target verified.`);
}

async function main() {
  const mode = process.argv[2];
  try {
    await runGuard(mode);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "CI database guard failed");
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (invokedPath === import.meta.url) {
  await main();
}
