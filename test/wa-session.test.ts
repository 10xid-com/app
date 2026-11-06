import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@/lib/db/connection', () => ({ db: state.db }));
let pg: PGlite;
let live: (user: string, session: string) => Promise<boolean>;
const user='10000000-0000-4000-8000-000000000001', other='10000000-0000-4000-8000-000000000002', session='20000000-0000-4000-8000-000000000001';
beforeAll(async () => {
  pg=new PGlite(); state.db=drizzle(pg);
  await pg.exec(`create table users(id uuid primary key,deleted_at timestamptz,is_service boolean default false);
    create table sessions(id uuid primary key,user_id uuid,revoked_at timestamptz,second_factor_at timestamptz,
      source_session_id uuid,source_auth_session_id text,absolute_expires_at timestamptz,last_seen_at timestamptz,idle_seconds int);`);
  live=(await import('../lib/db/identity')).portalSessionLiveForWrapAuthority;
});
beforeEach(async () => {
  await pg.exec('truncate sessions,users');
  await pg.query('insert into users(id) values($1),($2)',[user,other]);
  await pg.query("insert into sessions(id,user_id,second_factor_at,absolute_expires_at,last_seen_at) values($1,$2,now(),now()+interval '1 day',now())",[session,user]);
});
afterAll(async () => { await pg.close(); });
describe('live portal session predicate for WA purchase requests', () => {
  it('requires both the subject and the session to match', async () => {
    expect(await live(user,session)).toBe(true); expect(await live(other,session)).toBe(false);
  });
  it('refuses revoked, expired and idle sessions', async () => {
    for (const assignment of ["revoked_at=now()","absolute_expires_at=now()-interval '1 second'","last_seen_at=now()-interval '49 hours'"]) {
      await pg.exec('begin');
      try { await pg.exec('update sessions set '+assignment); expect(await live(user,session)).toBe(false); }
      finally { await pg.exec('rollback'); }
    }
  });
  it('refuses pending MFA and retired handoff sessions', async () => {
    for (const assignment of ["second_factor_at=null","source_session_id='20000000-0000-4000-8000-000000000002'","source_auth_session_id='retired'"]) {
      await pg.exec('begin');
      try { await pg.exec('update sessions set '+assignment); expect(await live(user,session)).toBe(false); }
      finally { await pg.exec('rollback'); }
    }
  });
  it('refuses disabled/deleted people and service identities', async () => {
    await pg.exec('update users set is_service=true'); expect(await live(user,session)).toBe(false);
    await pg.exec('update users set is_service=false,deleted_at=now()'); expect(await live(user,session)).toBe(false);
  });
  it('refuses a removed session on the next lookup', async () => {
    await pg.exec('delete from sessions'); expect(await live(user,session)).toBe(false);
  });
});
