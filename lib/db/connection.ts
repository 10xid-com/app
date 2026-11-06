import "server-only";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import * as schema from "./schema";

/**
 * THE ONLY MODULE THAT OPENS A DATABASE CONNECTION.
 *
 * Nothing outside `lib/db/` may import this file — an ESLint rule fails the
 * build if anything tries. Everything else goes through the scoped helpers in
 * `lib/db/index.ts`, which cannot be called without a scope.
 *
 * The application connects as a RESTRICTED role. If it were to connect as the
 * table owner or a superuser, Postgres would silently ignore every row-level
 * security policy and the tenant isolation would evaporate without a single
 * error — so `assertRestrictedRole()` refuses to let the app boot in that case.
 */

if (!process.env.DATABASE_APP_URL) {
  throw new Error(
    "DATABASE_APP_URL is not set. The application must connect as the " +
      "restricted role, not as the migration owner in DATABASE_URL.",
  );
}

const pool = new Pool({
  connectionString: process.env.DATABASE_APP_URL,
  max: Number(process.env.DATABASE_POOL_MAX ?? 10),
  // Every scoped query runs inside a transaction, so a connection is held for
  // the duration of one request's work and released immediately after.
  idleTimeoutMillis: 30_000,
});

export const db = drizzle(pool, { schema });

const prototypeUrl = process.env.DATABASE_PROTOTYPE_URL;
const prototypePool = prototypeUrl
  ? new Pool({
      connectionString: prototypeUrl,
      max: Number(process.env.DATABASE_POOL_MAX ?? 10),
      idleTimeoutMillis: 30_000,
    })
  : null;
const prototypeDb = prototypePool ? drizzle(prototypePool, { schema }) : db;

export type Database = typeof db;
export type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

let assertionRun = false;

/**
 * Fails loudly at boot rather than quietly at runtime.
 *
 * This is the check that catches the single most common way tenant isolation is
 * lost: connecting as a role that bypasses the rules, writing an isolation test,
 * watching it pass, and shipping with no protection at all.
 */
export async function assertRestrictedRole(): Promise<void> {
  if (assertionRun) return;
  await checkRole(pool);
  if (prototypePool) {
    await checkRole(prototypePool);
    const { rows } = await prototypePool.query<{ ready: boolean }>(
      "select current_database() in ('app_prototype','app_prototype_rehearsal') and to_regclass('public.prototype_act_as_ref') is not null as ready",
    );
    if (!rows[0]?.ready) throw new Error("DATABASE_PROTOTYPE_URL must use a prepared App prototype database.");
  }
  assertionRun = true;
}

async function checkRole(connectionPool: Pool): Promise<void> {
  const { rows } = await connectionPool.query<{
    role: string;
    is_super: boolean;
    can_bypass: boolean;
    owns_tenant_tables: number;
  }>(`
    select
      current_user as role,
      r.rolsuper as is_super,
      r.rolbypassrls as can_bypass,
      (select count(*)::int
         from pg_tables
        where schemaname = 'public'
          and tablename in ('jobs','job_events','api_keys','invitations')
          and tableowner = current_user) as owns_tenant_tables
    from pg_roles r
    where r.rolname = current_user
  `);

  const row = rows[0];
  if (!row) throw new Error("Could not determine the database role.");

  const faults: string[] = [];
  if (row.is_super) faults.push("it is a SUPERUSER");
  if (row.can_bypass) faults.push("it has BYPASSRLS");
  if (row.owns_tenant_tables > 0) faults.push("it OWNS the tenant tables");

  if (faults.length > 0) {
    throw new Error(
      `Refusing to start: the application is connecting as "${row.role}", and ` +
        `${faults.join(", ")}. Postgres ignores row-level security in that case, ` +
        `so every client would be able to read every other client's data with no ` +
        `error raised. Point DATABASE_APP_URL at the restricted role.`,
    );
  }

}

/**
 * Applies the per-request tenant setting and runs the callback inside one
 * transaction.
 *
 * The third argument to set_config is `true`, meaning TRANSACTION-LOCAL. That
 * is not a stylistic choice: with a connection pool, a session-level setting
 * stays on the connection after the request ends and is inherited by whoever
 * borrows that connection next — which may be a different client. That failure
 * mode leaks data rather than blocking it, so it is closed here, in the one
 * place every query passes through.
 */
export async function inTenantTransaction<T>(
  organizationId: string | null,
  isStaff: boolean,
  fn: (tx: Transaction) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`
      select
        set_config('app.org_id', ${organizationId ?? ""}, true),
        set_config('app.is_staff', ${isStaff ? "on" : "off"}, true)
    `);
    return fn(tx);
  });
}

/**
 * The one transaction that is allowed to read a row before a scope exists.
 *
 * An API key has to be looked up before anyone knows which company it belongs
 * to — the key is what PRODUCES the scope, so it cannot require one, the same
 * circular problem sessions and memberships have. Those tables resolve it by
 * sitting outside row-level security entirely, with the reason written down in
 * scripts/check-rls.ts.
 *
 * Keys do not, because the same table is also managed through the ordinary
 * screens, and that management must be isolated per client like everything
 * else. So the table keeps its tenant policy, and this adds one narrow,
 * named exception: a SELECT-only policy that only applies while this flag is
 * set. The flag is transaction-local, is set here and nowhere else, and the
 * only query that runs inside it is a lookup by the hash of the presented key.
 *
 * It admits every key row, which sounds worse than it is: the rows hold hashes,
 * so what it can see is not a credential. Nothing may write inside it.
 */
/**
 * A transaction scoped to one client AND one person.
 *
 * The workspace tables (0018) filter by both: a conversation belongs to the
 * staff member who had it, not to everyone working on that client. This sets
 * app.user_id beside app.org_id. The cross-client staff flag is always off —
 * no workspace table has a survey policy, and passing it here would be a
 * promise the policies do not keep.
 *
 * A separate function rather than a fourth argument to inTenantTransaction, so
 * the dozens of existing callers are untouched and none of them can pass a
 * user id by accident.
 */
export async function inOwnerTransaction<T>(
  organizationId: string,
  userId: string,
  fn: (tx: Transaction) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`
      select
        set_config('app.org_id', ${organizationId}, true),
        set_config('app.is_staff', 'off', true),
        set_config('app.user_id', ${userId}, true)
    `);
    return fn(tx);
  });
}

export async function inAuthenticationTransaction<T>(
  fn: (tx: Transaction) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select set_config('app.authenticating', 'on', true)`,
    );
    return fn(tx);
  });
}

type PrototypeReferences = {
  companies: unknown[];
  accounts: unknown[];
  roles: unknown[];
  act_as: unknown[];
};

type CompanyReferences = {
  departments: unknown[];
  agencies: unknown[];
};

/** Mirror foreign-key references without copying Core sign-in data. */
async function refreshPrototypeReferences(organizationId: string | null): Promise<void> {
  await prototypeDb.transaction(async (tx) => {
    // Serialize the short reference refresh, then release the lock before doing app work.
    await tx.execute(sql`select pg_advisory_xact_lock(1010, 731)`);
    const { rows } = await db.execute<PrototypeReferences>(sql`
      select
        coalesce((select jsonb_agg(to_jsonb(c)) from
          (select id, type, name, slug, brand_primary_hex, deleted_at, job_counter from public.organizations) c), '[]') as companies,
        coalesce((select jsonb_agg(to_jsonb(u)) from
          (select id, full_name, is_service, deleted_at from public.users) u), '[]') as accounts,
        coalesce((select jsonb_agg(to_jsonb(r)) from
          (select id, user_id, organization_id, role from public.memberships) r), '[]') as roles,
        coalesce((select jsonb_agg(id) from public.act_as_grants), '[]') as act_as
    `);
    const references = rows[0]!;
    await tx.execute(sql`
      insert into public."CiD" as c (id, type, name, slug, brand_primary_hex, deleted_at, job_counter)
      select id, type, name, slug, brand_primary_hex, deleted_at, job_counter
      from jsonb_populate_recordset(null::public."CiD", ${JSON.stringify(references.companies)}::jsonb)
      on conflict (id) do update
        set name = excluded.name, brand_primary_hex = excluded.brand_primary_hex, deleted_at = excluded.deleted_at
      where (c.name, c.brand_primary_hex, c.deleted_at)
        is distinct from (excluded.name, excluded.brand_primary_hex, excluded.deleted_at)
    `);
    await tx.execute(sql`
      insert into public.users as u (id, email, full_name, is_service, deleted_at)
      select id, id::text || '@prototype.invalid', full_name, is_service, deleted_at
      from jsonb_populate_recordset(null::public.users, ${JSON.stringify(references.accounts)}::jsonb)
      on conflict (id) do update set full_name = excluded.full_name, deleted_at = excluded.deleted_at
      where (u.full_name, u.deleted_at) is distinct from (excluded.full_name, excluded.deleted_at)
    `);
    const roles = JSON.stringify(references.roles);
    await tx.execute(sql`
      insert into public."role" as r (id, user_id, organization_id, role)
      select id, user_id, organization_id, role
      from jsonb_populate_recordset(null::public."role", ${roles}::jsonb)
      order by (role::text = 'owner') desc
      on conflict (user_id, organization_id) do update set role = excluded.role
      where r.role is distinct from excluded.role
    `);
    await tx.execute(sql`
      with current_roles as (
        select user_id, organization_id, role
        from jsonb_populate_recordset(null::public."role", ${roles}::jsonb)
      )
      delete from public."role" as r
      where not exists (
        select 1 from current_roles c where c.user_id = r.user_id and c.organization_id = r.organization_id
      )
      and (r.role::text <> 'owner' or exists (
        select 1 from current_roles c where c.organization_id = r.organization_id and c.role::text = 'owner'
      ))
    `);
    await tx.execute(sql`
      insert into public.prototype_act_as_ref (id)
      select id::uuid from jsonb_array_elements_text(${JSON.stringify(references.act_as)}::jsonb) as ref(id)
      on conflict (id) do nothing
    `);

    if (organizationId) {
      const { rows: companies } = await inTenantTransaction(organizationId, false, (core) =>
        core.execute<CompanyReferences>(sql`
          select
            coalesce((select jsonb_agg(to_jsonb(d)) from public.departments d where organization_id = ${organizationId}), '[]') as departments,
            coalesce((select jsonb_agg(id) from public.agency_grants where client_organization_id = ${organizationId}), '[]') as agencies
        `),
      );
      const company = companies[0]!;
      await tx.execute(sql`select set_config('app.org_id', ${organizationId}, true)`);
      await tx.execute(sql`
        insert into public.departments as d (id, organization_id, name, slug, created_at, updated_at, deleted_at)
        select id, organization_id, name, slug, created_at, updated_at, deleted_at
        from jsonb_populate_recordset(null::public.departments, ${JSON.stringify(company.departments)}::jsonb)
        on conflict (id) do update set name = excluded.name, deleted_at = excluded.deleted_at
        where (d.name, d.deleted_at) is distinct from (excluded.name, excluded.deleted_at)
      `);
      await tx.execute(sql`
        insert into public.prototype_agency_ref (id)
        select id::uuid from jsonb_array_elements_text(${JSON.stringify(company.agencies)}::jsonb) as ref(id)
        on conflict (id) do nothing
      `);
    }
  });
}

async function prototypeTransaction<T>(
  organizationId: string | null,
  isStaff: boolean,
  userId: string,
  fn: (tx: Transaction) => Promise<T>,
): Promise<T> {
  if (prototypePool) await refreshPrototypeReferences(organizationId);

  return prototypeDb.transaction(async (tx) => {
    if (!prototypePool && process.env.PROTOTYPE_CUTOVER_MODE === "read-only") {
      await tx.execute(sql`set transaction read only`);
    }
    await tx.execute(sql`
      select
        set_config('app.org_id', ${organizationId ?? ""}, true),
        set_config('app.is_staff', ${isStaff ? "on" : "off"}, true),
        set_config('app.user_id', ${userId}, true)
    `);
    return fn(tx);
  });
}

export function inPrototypeTenantTransaction<T>(
  organizationId: string | null,
  isStaff: boolean,
  fn: (tx: Transaction) => Promise<T>,
): Promise<T> {
  return prototypeTransaction(organizationId, isStaff, "", fn);
}

export function inPrototypeOwnerTransaction<T>(
  organizationId: string,
  userId: string,
  fn: (tx: Transaction) => Promise<T>,
): Promise<T> {
  return prototypeTransaction(organizationId, false, userId, fn);
}

/** For tests and scripts that need to close cleanly. */
export async function closePool(): Promise<void> {
  await Promise.all([pool.end(), prototypePool?.end()]);
}
