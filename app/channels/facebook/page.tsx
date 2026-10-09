import type { Metadata } from "next";
import { Suspense } from "react";
import { cookies } from "next/headers";
import { requirePage } from "@/lib/auth/authorize";
import { allows } from "@/lib/auth/permissions";
import { resolveIdentity } from "@/lib/auth/session";
import { channelToken, socialConnectionFor, type SocialConnection } from "@/lib/db/social";
import {
  facebookConfig,
  managedPages,
  pageProfile,
  recentPagePosts,
  type FacebookPage,
  type FacebookPageProfile,
  type FacebookPost,
} from "@/lib/integrations/facebook";
import { FB_PENDING_COOKIE, openPending } from "@/lib/integrations/facebook-pending";
import { mediaBucketConfigured } from "@/lib/integrations/media-bucket";
import { MetaError } from "@/lib/integrations/meta";
import { PortalShell } from "../../portal-shell";
import { CsrfField } from "../../_components/csrf-field";
import { Icon } from "../../_components/icons";
import { SocialComposer } from "../../_components/social-composer";
import { SubmitButton } from "../../_components/submit-button";
import { chooseFacebookPageAction, disconnectFacebookAction } from "./actions";

export const metadata: Metadata = { title: "Facebook" };

/**
 * The Facebook channel: one Facebook Page, connected through Facebook Login
 * (app/api/facebook/connect), posted to from here (the shared composer,
 * app/api/facebook/posts): text, photos or a video, with how recent posts did.
 *
 * Owners and managers connect, choose the Page and disconnect
 * (social.connect); owners, managers and publishers post (social.publish);
 * everyone who can open the business sees the Page and its posts.
 */

const ERRORS: Record<string, string> = {
  role: "Your role cannot connect Facebook. An owner or manager can.",
  notconfigured: "Facebook is not switched on in 10XiD yet.",
  state: "That sign-in did not start here, or took too long. Try connecting again.",
  cancelled: "Facebook was not connected.",
  permissions:
    "Facebook was connected without permission to post to your Pages. Connect again and leave every Page permission switched on.",
  nopages:
    "Facebook did not list a Page you can post to. You need to be an admin or editor of the business's Page, and to choose it when Facebook asks which Pages 10XiD may use.",
  taken: "That Facebook Page is already connected to another business in 10XiD.",
};

const DONE: Record<string, string> = {
  connected: "Facebook is connected.",
  disconnected: "Facebook is disconnected. Its access has been deleted from 10XiD.",
};

type Live =
  | { ok: true; page: FacebookPageProfile; posts: FacebookPost[] }
  | { ok: false; signedOut: boolean; message: string };

export default async function FacebookPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; detail?: string; done?: string; choose?: string }>;
}) {
  const granted = await requirePage("business.view", { returnPath: "/channels/facebook" });
  const { ctx, businessId, role, via } = granted;
  const owner = { organizationId: businessId, userId: ctx.userId };
  const params = await searchParams;

  const config = mediaBucketConfigured() ? facebookConfig() : null;
  const connection = config ? await socialConnectionFor(owner, "facebook") : null;
  const mayConnect = allows(role, "social.connect", via);
  const mayPost = allows(role, "social.publish", via);
  const identity = connection && mayPost ? await resolveIdentity() : null;
  const csrf = identity?.state === "active" ? identity.csrfToken : "";

  // Choosing a Page: the Pages come from Facebook, with the token waiting in this browser.
  let choices: FacebookPage[] | null = null;
  if (config && mayConnect && params.choose === "1") {
    const pending = openPending((await cookies()).get(FB_PENDING_COOKIE)?.value, businessId);
    if (pending) {
      try {
        choices = (await managedPages(pending.token)).filter((p) => p.canPost);
      } catch (err) {
        if (!(err instanceof MetaError)) throw err;
      }
    }
  }

  const live: Promise<Live> | null = connection
    ? (async () => {
        try {
          const token = await channelToken(owner, connection);
          const [page, posts] = await Promise.all([pageProfile(token, connection.accountId), recentPagePosts(token, connection.accountId)]);
          return { ok: true as const, page, posts };
        } catch (err) {
          if (err instanceof MetaError) return { ok: false as const, signedOut: err.signedOut, message: err.message };
          throw err;
        }
      })()
    : null;

  return (
    <PortalShell email={ctx.email} isStaff={ctx.scope.isStaff} actingOn={null}>
      <h1 className="text-2xl font-semibold tracking-tight text-ink">Facebook</h1>
      <p className="mt-1 max-w-prose text-sm text-ink-soft">Post to your Facebook Page and see what lands.</p>

      {params.error ? (
        <p role="alert" className="mt-4 rounded-lg border border-bad/30 bg-bad/5 px-3 py-2 text-sm text-bad">
          {params.error === "facebook" ? `Facebook said: ${params.detail ?? "no."}` : (ERRORS[params.error] ?? "That did not work.")}
        </p>
      ) : null}
      {params.done && DONE[params.done] ? (
        <p role="status" className="mt-4 rounded-lg border border-good/30 bg-good/5 px-3 py-2 text-sm text-good">
          {DONE[params.done]}
        </p>
      ) : null}

      {!config ? (
        <section className="mt-6 rounded-2xl border border-line bg-surface p-6 shadow-card">
          <Heading title="Facebook is being set up" text="10XiD needs its Meta app keys and media store before a Page can be connected. Nothing for you to do here yet." />
        </section>
      ) : choices ? (
        <section className="mt-6 rounded-2xl border border-line bg-surface p-6 shadow-card">
          <Heading title="Which Page?" text="You manage more than one Facebook Page. Choose the one this business posts to." />
          {choices.length ? (
            <form action={chooseFacebookPageAction} className="mt-5 grid gap-2 sm:max-w-lg">
              <CsrfField />
              {choices.map((p, i) => (
                <label key={p.id} className="flex cursor-pointer items-center gap-3 rounded-xl border border-line px-3 py-2.5 hover:bg-sunk has-[:checked]:border-brand has-[:checked]:bg-brand-soft">
                  <input type="radio" name="pageId" value={p.id} defaultChecked={i === 0} className="sr-only" />
                  {p.picture ? (
                    // eslint-disable-next-line @next/next/no-img-element -- the Page's own picture
                    <img src={p.picture} alt="" className="h-9 w-9 rounded-full border border-line object-cover" />
                  ) : (
                    <span className="grid h-9 w-9 place-items-center rounded-full bg-sunk text-sm font-semibold text-ink-soft">{p.name.slice(0, 1)}</span>
                  )}
                  <span className="grid">
                    <span className="text-sm font-medium text-ink">{p.name}</span>
                    {p.category ? <span className="text-xs text-ink-faint">{p.category}</span> : null}
                  </span>
                </label>
              ))}
              <SubmitButton
                pendingLabel="Connecting…"
                className="mt-2 justify-self-start rounded-lg bg-brand-surface px-4 py-2 text-sm font-semibold text-brand-on-surface hover:bg-brand-surface-hover disabled:opacity-60"
              >
                Connect this Page
              </SubmitButton>
            </form>
          ) : (
            <p className="mt-4 text-sm text-ink-soft">{ERRORS.nopages}</p>
          )}
        </section>
      ) : !connection ? (
        <section className="mt-6 rounded-2xl border border-line bg-surface p-6 shadow-card">
          <Heading title="Connect your Facebook Page" text="Once it is connected, your team can post text, photos and videos to the Page from here and see how they did." />
          <ul className="mt-5 grid gap-2 text-sm text-ink-soft sm:max-w-lg">
            <li className="flex gap-2">
              <span aria-hidden className="text-ink-faint">•</span>
              You need to be an admin or editor of the business’s Facebook Page.
            </li>
            <li className="flex gap-2">
              <span aria-hidden className="text-ink-faint">•</span>
              You sign in on Facebook itself and choose the Page. 10XiD never sees the password.
            </li>
          </ul>
          {mayConnect ? (
            <a
              href="/api/facebook/connect"
              className="mt-5 inline-flex items-center gap-2 rounded-lg bg-brand-surface px-4 py-2 text-sm font-semibold text-brand-on-surface hover:bg-brand-surface-hover"
            >
              <Icon name="facebook" /> Connect Facebook
            </a>
          ) : (
            <p className="mt-5 text-sm text-ink-soft">An owner or manager can connect it.</p>
          )}
        </section>
      ) : (
        <>
          <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
            <section className="rounded-2xl border border-line bg-surface p-5 shadow-card">
              <h2 className="text-base font-semibold text-ink">New post</h2>
              {mayPost ? (
                <SocialComposer channel="facebook" csrf={csrf} username={connection.username} />
              ) : (
                <p className="mt-2 text-sm text-ink-soft">A publisher, manager or owner can post to Facebook.</p>
              )}
            </section>
            <aside className="grid content-start gap-4">
              <Suspense fallback={<PageCard connection={connection} page={null} />}>
                <PageFromLive live={live!} connection={connection} />
              </Suspense>
              {mayConnect ? (
                <form action={disconnectFacebookAction} className="rounded-xl border border-line bg-surface p-4 text-sm shadow-card">
                  <CsrfField />
                  <input type="hidden" name="connectionId" value={connection.id} />
                  <p className="text-ink-soft">Disconnecting deletes 10XiD’s access. Posts already on Facebook stay there.</p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <SubmitButton
                      pendingLabel="Disconnecting…"
                      className="rounded-lg border border-line px-3 py-1.5 text-[13px] font-semibold text-ink hover:bg-sunk disabled:opacity-60"
                    >
                      Disconnect
                    </SubmitButton>
                    <a href="/api/facebook/connect" className="rounded-lg border border-line px-3 py-1.5 text-[13px] font-semibold text-ink hover:bg-sunk">
                      Switch Page
                    </a>
                  </div>
                </form>
              ) : null}
            </aside>
          </div>

          <section className="mt-8">
            <h2 className="text-base font-semibold text-ink">Recent posts</h2>
            <Suspense fallback={<PostsLoading />}>
              <PostsFromLive live={live!} mayConnect={mayConnect} />
            </Suspense>
          </section>
        </>
      )}
    </PortalShell>
  );
}

function Heading({ title, text }: { title: string; text: string }) {
  return (
    <div className="flex items-center gap-3">
      <span className="grid h-10 w-10 flex-none place-items-center rounded-xl bg-sunk text-ink-soft">
        <Icon name="facebook" />
      </span>
      <div>
        <h2 className="text-base font-semibold text-ink">{title}</h2>
        <p className="text-sm text-ink-soft">{text}</p>
      </div>
    </div>
  );
}

const number = (n: number | null | undefined) => (n === null || n === undefined ? "—" : n.toLocaleString("en-CA"));

async function PageFromLive({ live, connection }: { live: Promise<Live>; connection: SocialConnection }) {
  const result = await live;
  return <PageCard connection={connection} page={result.ok ? result.page : null} />;
}

function PageCard({ connection, page }: { connection: SocialConnection; page: FacebookPageProfile | null }) {
  return (
    <div className="rounded-xl border border-line bg-surface p-4 shadow-card">
      <div className="flex items-center gap-3">
        {page?.picture ? (
          // eslint-disable-next-line @next/next/no-img-element -- the Page's own picture
          <img src={page.picture} alt="" className="h-12 w-12 flex-none rounded-full border border-line object-cover" />
        ) : (
          <span className="grid h-12 w-12 flex-none place-items-center rounded-full bg-sunk text-lg font-semibold text-ink-soft">
            {connection.username.slice(0, 1).toUpperCase()}
          </span>
        )}
        <a
          href={page?.link ?? `https://www.facebook.com/${encodeURIComponent(connection.accountId)}`}
          target="_blank"
          rel="noreferrer"
          className="min-w-0 truncate font-semibold text-ink hover:underline"
        >
          {page?.name ?? connection.username}
        </a>
      </div>
      <dl className="mt-4 grid grid-cols-2 gap-2 text-sm">
        <div className="rounded-lg bg-sunk px-3 py-2">
          <dt className="text-xs text-ink-faint">Followers</dt>
          <dd className="font-semibold text-ink">{number(page?.followers)}</dd>
        </div>
        <div className="rounded-lg bg-sunk px-3 py-2">
          <dt className="text-xs text-ink-faint">Likes</dt>
          <dd className="font-semibold text-ink">{number(page?.likes)}</dd>
        </div>
      </dl>
      <p className="mt-3 text-xs text-ink-faint">
        Connected {connection.connectedAt.toLocaleDateString("en-CA", { year: "numeric", month: "long", day: "numeric" })}
      </p>
    </div>
  );
}

async function PostsFromLive({ live, mayConnect }: { live: Promise<Live>; mayConnect: boolean }) {
  const result = await live;
  if (!result.ok) {
    return (
      <div role="alert" className="mt-3 rounded-lg border border-bad/30 bg-bad/5 px-3 py-2 text-sm text-bad">
        {result.signedOut ? "Facebook has signed this connection out." : `Facebook did not answer: ${result.message}`}
        {result.signedOut && mayConnect ? (
          <>
            {" "}
            <a href="/api/facebook/connect" className="font-semibold underline">
              Connect again
            </a>
          </>
        ) : null}
      </div>
    );
  }
  if (result.posts.length === 0) return <p className="mt-3 text-sm text-ink-soft">No posts yet.</p>;
  return (
    <ul className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
      {result.posts.map((p) => (
        <li key={p.id} className="overflow-hidden rounded-xl border border-line bg-surface shadow-card">
          <a href={p.permalink ?? undefined} target="_blank" rel="noreferrer" className="block">
            {p.image ? (
              // eslint-disable-next-line @next/next/no-img-element -- Facebook's own media address
              <img src={p.image} alt={p.message?.slice(0, 120) ?? ""} loading="lazy" className="aspect-square w-full bg-sunk object-cover" />
            ) : (
              <p className="line-clamp-6 aspect-square w-full bg-sunk p-3 text-xs text-ink-soft">{p.message ?? ""}</p>
            )}
          </a>
          <div className="grid gap-1 p-3 text-xs">
            <div className="flex flex-wrap gap-x-3 gap-y-1 text-ink">
              <span title="Reactions">👍 {number(p.reactions)}</span>
              <span title="Comments">💬 {number(p.comments)}</span>
              <span title="Shares" className="text-ink-soft">
                ↗ {number(p.shares)}
              </span>
            </div>
            {p.postedAt ? (
              <span className="text-ink-faint">
                {new Date(p.postedAt).toLocaleDateString("en-CA", { month: "short", day: "numeric", year: "numeric" })}
              </span>
            ) : null}
            {p.image && p.message ? <p className="line-clamp-2 text-ink-soft">{p.message}</p> : null}
          </div>
        </li>
      ))}
    </ul>
  );
}

function PostsLoading() {
  return (
    <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4" aria-busy="true" aria-label="Asking Facebook">
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="aspect-square animate-pulse rounded-xl bg-sunk" />
      ))}
    </div>
  );
}
