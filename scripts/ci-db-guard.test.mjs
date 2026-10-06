import assert from "node:assert/strict";
import test from "node:test";
import {
  parseDatabaseUrl,
  runGuard,
  validateTargetUrls,
} from "./ci-db-guard.mjs";

const OWNER = "postgresql://ci_owner:owner-pass@127.0.0.1:5432/portal_ci";
const APP = "postgresql://portal_app:app-pass@localhost:5432/portal_ci";

function result(rows) {
  return { rows };
}

function fakeClientFactory({
  ownerFacts = {
    database: "portal_ci",
    role: "ci_owner",
    session_role: "ci_owner",
    server_addr: "127.0.0.1",
    server_port: 5432,
  },
  blank = { user_tables: 0 },
  appRole = {
    database: "portal_ci",
    role: "portal_app",
    session_role: "portal_app",
    server_addr: "127.0.0.1",
    server_port: 5432,
    rolsuper: false,
    rolbypassrls: false,
    rolcreatedb: false,
    rolcreaterole: false,
  },
  ownership = {
    databases: 0,
    schemas: 0,
    relations: 0,
    routines: 0,
  },
  memberships = [],
} = {}) {
  return ({ connectionString }) => ({
    async connect() {},
    async end() {},
    async query(sql) {
      if (sql.includes("ci-db-guard:owner-facts")) return result([ownerFacts]);
      if (sql.includes("ci-db-guard:blank-target")) return result([blank]);
      if (sql.includes("ci-db-guard:app-role")) return result([appRole]);
      if (sql.includes("ci-db-guard:app-ownership")) return result([ownership]);
      if (sql.includes("ci-db-guard:privilege-memberships")) return result(memberships);
      throw new Error(`unexpected query for ${connectionString}`);
    },
  });
}

const env = (owner = OWNER, app = APP) => ({
  DATABASE_URL: owner,
  DATABASE_APP_URL: app,
});

test("accepts the exact disposable local owner/app target pair", () => {
  const parsed = validateTargetUrls(env());
  assert.equal(parsed.owner.database, "portal_ci");
  assert.equal(parsed.owner.username, "ci_owner");
  assert.equal(parsed.app.username, "portal_app");
});

test("accepts localhost and 127.0.0.1 as the same loopback target class", () => {
  assert.doesNotThrow(() => validateTargetUrls(env()));
});

for (const [name, owner, app, pattern] of [
  ["missing owner URL", undefined, APP, /DATABASE_URL is missing/],
  ["missing app URL", OWNER, undefined, /DATABASE_APP_URL is missing/],
  ["malformed owner URL", "not a url", APP, /DATABASE_URL is malformed/],
  [
    "remote owner host",
    "postgresql://ci_owner:x@db.example.com:5432/portal_ci",
    APP,
    /host must be exactly localhost or 127\.0\.0\.1/,
  ],
  [
    "wrong owner database",
    "postgresql://ci_owner:x@127.0.0.1:5432/postgres",
    APP,
    /database must be exactly portal_ci/,
  ],
  [
    "wrong owner user",
    "postgresql://postgres:x@127.0.0.1:5432/portal_ci",
    APP,
    /username must be ci_owner/,
  ],
  [
    "wrong app user",
    OWNER,
    "postgresql://postgres:x@127.0.0.1:5432/portal_ci",
    /username must be portal_app/,
  ],
  [
    "non-CI port",
    "postgresql://ci_owner:x@127.0.0.1:15432/portal_ci",
    APP,
    /port must be 5432/,
  ],
  [
    "query parameters",
    "postgresql://ci_owner:x@127.0.0.1:5432/portal_ci?sslmode=disable",
    APP,
    /must not contain query parameters/,
  ],
]) {
  test(`rejects ${name}`, () => {
    assert.throws(
      () => validateTargetUrls(env(owner, app)),
      pattern,
    );
  });
}

test("rejects a URL without a disposable password", () => {
  assert.throws(
    () =>
      parseDatabaseUrl(
        "DATABASE_URL",
        "postgresql://ci_owner@127.0.0.1:5432/portal_ci",
        "ci_owner",
      ),
    /disposable CI-only password/,
  );
});

test("pre-migrate accepts a blank live local portal_ci target", async () => {
  const logs = [];
  await runGuard("pre-migrate", {
    env: env(),
    makeClient: fakeClientFactory(),
    log: (line) => logs.push(line),
  });
  assert.match(logs[0], /pre-migrate/);
});

test("pre-migrate rejects a nonblank target before migration", async () => {
  await assert.rejects(
    runGuard("pre-migrate", {
      env: env(),
      makeClient: fakeClientFactory({ blank: { user_tables: 1 } }),
      log() {},
    }),
    /target is not blank/,
  );
});

test("rejects a live owner connection that is not loopback", async () => {
  await assert.rejects(
    runGuard("pre-migrate", {
      env: env(),
      makeClient: fakeClientFactory({
        ownerFacts: {
          database: "portal_ci",
          role: "ci_owner",
          session_role: "ci_owner",
          server_addr: "10.0.0.5",
          server_port: 5432,
        },
      }),
      log() {},
    }),
    /not served from a loopback address/,
  );
});

test("post-migrate accepts a restricted non-owner portal_app with no escalating memberships", async () => {
  const logs = [];
  await runGuard("post-migrate", {
    env: env(),
    makeClient: fakeClientFactory(),
    log: (line) => logs.push(line),
  });
  assert.match(logs[0], /post-migrate/);
});

for (const [field, label] of [
  ["rolsuper", "SUPERUSER"],
  ["rolbypassrls", "BYPASSRLS"],
  ["rolcreatedb", "CREATEDB"],
  ["rolcreaterole", "CREATEROLE"],
]) {
  test(`post-migrate rejects portal_app with ${label}`, async () => {
    await assert.rejects(
      runGuard("post-migrate", {
        env: env(),
        makeClient: fakeClientFactory({
          appRole: {
            database: "portal_ci",
            role: "portal_app",
            session_role: "portal_app",
            server_addr: "127.0.0.1",
            server_port: 5432,
            rolsuper: false,
            rolbypassrls: false,
            rolcreatedb: false,
            rolcreaterole: false,
            [field]: true,
          },
        }),
        log() {},
      }),
      new RegExp(label),
    );
  });
}

test("post-migrate rejects any application-object ownership", async () => {
  await assert.rejects(
    runGuard("post-migrate", {
      env: env(),
      makeClient: fakeClientFactory({
        ownership: {
          databases: 0,
          schemas: 0,
          relations: 1,
          routines: 0,
        },
      }),
      log() {},
    }),
    /owns database\/application schema objects/,
  );
});

test("post-migrate rejects privilege-escalating role memberships", async () => {
  await assert.rejects(
    runGuard("post-migrate", {
      env: env(),
      makeClient: fakeClientFactory({
        memberships: [{ rolname: "ci_owner" }],
      }),
      log() {},
    }),
    /privilege-escalating role membership\(s\): ci_owner/,
  );
});

test("rejects unknown modes before connecting", async () => {
  let connected = false;
  await assert.rejects(
    runGuard("anything-else", {
      env: env(),
      makeClient() {
        connected = true;
        throw new Error("should not connect");
      },
      log() {},
    }),
    /mode must be pre-migrate or post-migrate/,
  );
  assert.equal(connected, false);
});
