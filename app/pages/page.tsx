import type { Metadata } from "next";
import Link from "next/link";
import { requireSession } from "@/lib/auth/require";
import { liveGrantForSession, organizationById } from "@/lib/db/identity";
import { GROUPS, hiddenFrom, pagesFor, type PageRecord } from "@/lib/pages";
import { PortalShell } from "../portal-shell";

export const metadata: Metadata = { title: "Pages" };

/**
 * The pages desk.
 *
 * An index of the whole service: every page, and the iD each one answers to.
 *
 * The iD is the thing this screen is actually for, which is why it is set
 * larger than the path and sits first in the row. A path is an implementation
 * detail that moves — `/dashboard` may well become `/desk` — and the iD is what
 * survives the move. Putting the path first would teach people to quote the
 * thing that changes, which is the habit this whole product exists to break.
 *
 * Read from lib/pages.ts rather than from the filesystem at request time. It
 * could be globbed live, and that would never drift, but it would mean reading
 * the app directory on every request in production to render a list that
 * changes only when somebody deploys. The honesty is bought by a test instead:
 * test/pages-desk.test.ts fails if app/ and the inventory disagree.
 */

const AUDIENCE: Record<PageRecord["audience"], { label: string; className: string }> = {
  public: {
    label: "No sign-in",
    className: "bg-sunk text-ink-faint",
  },
  member: {
    label: "Signed in",
    className: "bg-brand-soft text-brand",
  },
  staff: {
    label: "Staff only",
    className: "bg-warn/15 text-warn",
  },
};

function Badge({ children, className }: { children: React.ReactNode; className: string }) {
  return (
    <span
      className={`inline-flex flex-none items-center rounded-full px-2 py-0.5
                  text-[11px] font-[560] ${className}`}
    >
      {children}
    </span>
  );
}

/**
 * The path, as a link when following it would actually work.
 *
 * Machinery is never a link. `/auth/sso/start` in a browser bounces you through
 * a handoff, and `/api/v1/jobs` answers a GET with a 405 on purpose — offering
 * either as something to click would be offering a broken link that looks
 * deliberate.
 *
 * `/jobs/[id]` is not a link either, for the plain reason that there is no id
 * to put in it. The segment is left in its source spelling rather than filled
 * with a fake one, because a made-up UUID in an inventory is the kind of thing
 * somebody eventually pastes somewhere real.
 */
function PathCell({ page }: { page: PageRecord }) {
  const code = (
    <code className="break-all font-mono text-[12.5px] text-ink-soft">{page.path}</code>
  );

  if (page.kind === "machinery" || page.path.includes("[")) {
    return code;
  }
  return (
    <Link
      href={page.path}
      className="break-all font-mono text-[12.5px] text-brand underline
                 decoration-line underline-offset-2 transition-colors
                 hover:decoration-brand"
    >
      {page.path}
    </Link>
  );
}

function Row({ page }: { page: PageRecord }) {
  return (
    <li className="rounded-xl border border-line bg-surface p-4 shadow-card">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        {/*
          The iD, and it is the loudest thing in the row on purpose. 15px mono
          on a tinted plate — near enough the weight of the row's name, because
          the two are equals: one is what a person calls it, the other is what
          the system calls it, and neither is the subtitle of the other.
        */}
        <code
          className="flex-none rounded-md bg-sunk px-2 py-1 font-mono text-[15px]
                     font-[560] tracking-tight text-ink"
        >
          {page.id}
        </code>
        <span className="text-[15px] font-[560] text-ink">{page.name}</span>
        <Badge className={AUDIENCE[page.audience].className}>
          {AUDIENCE[page.audience].label}
        </Badge>
        {page.kind === "machinery" ? (
          <Badge className="bg-sunk text-ink-faint">
            {page.methods?.length ? page.methods.join(" ") : "No screen"}
          </Badge>
        ) : null}
      </div>

      <p className="mt-2 max-w-prose text-sm text-ink-soft">{page.purpose}</p>

      <div className="mt-2">
        <PathCell page={page} />
      </div>
    </li>
  );
}

export default async function PagesDesk() {
  const ctx = await requireSession("/pages");

  const grant = await liveGrantForSession(ctx.sessionId);
  const actingOrg = grant ? await organizationById(grant.organizationId) : null;

  const visible = pagesFor(ctx.scope.isStaff);
  const hidden = hiddenFrom(ctx.scope.isStaff);

  return (
    <PortalShell
      email={ctx.email}
      isStaff={ctx.scope.isStaff}
      actingOn={
        actingOrg && grant ? { name: actingOrg.name, reason: grant.reason } : null
      }
    >
      <h1 className="text-2xl font-semibold tracking-tight text-ink">Pages</h1>
      <p className="mt-1 max-w-prose text-sm text-ink-soft">
        Every page in the service, and the iD each one answers to. The iD is the
        stable name: a path can move, and when it does the iD stays put and
        keeps pointing at the right thing.
      </p>

      <p className="mt-3 text-sm text-ink-faint">
        {visible.length} {visible.length === 1 ? "page" : "pages"}
        {hidden > 0 ? (
          <>
            {" "}
            — {hidden} more {hidden === 1 ? "is" : "are"} staff only and not
            listed here.
          </>
        ) : null}
      </p>

      {GROUPS.map((group) => {
        const rows = visible.filter((p) => p.group === group);
        if (rows.length === 0) return null;
        return (
          <section key={group} className="mt-8">
            <h2 className="text-xs font-[620] uppercase tracking-[0.08em] text-ink-faint">
              {group}
            </h2>
            <ul className="mt-3 grid gap-3">
              {rows.map((page) => (
                <Row key={page.id} page={page} />
              ))}
            </ul>
          </section>
        );
      })}
    </PortalShell>
  );
}
