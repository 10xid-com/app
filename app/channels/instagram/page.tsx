import type { Metadata } from "next";
import { Suspense } from "react";
import { requirePage } from "@/lib/auth/authorize";
import { allows } from "@/lib/auth/permissions";
import { resolveIdentity } from "@/lib/auth/session";
import { channelToken, socialConnectionFor, type SocialConnection } from "@/lib/db/social";
import {
  instagramConfig,
  profile,
  recentPosts,
  type InstagramPost,
  type InstagramProfile,
} from "@/lib/integrations/instagram";
import { mediaBucketConfigured } from "@/lib/integrations/media-bucket";
import { MetaError } from "@/lib/integrations/meta";
import { PortalShell } from "../../portal-shell";
import { CsrfField } from "../../_components/csrf-field";
import { Icon } from "../../_components/icons";
import { SubmitButton } from "../../_components/submit-button";
import { disconnectInstagramAction } from "./actions";
import { SocialComposer } from "../../_components/social-composer";

export const metadata: Metadata = { title: "Instagram" };

/**
 * The Instagram channel: the business's Instagram account, connected through
 * Instagram's own sign-in (app/api/instagram/connect), posted to from here
 * (app/_components/social-composer.tsx, app/api/instagram/posts): photos, Reels and carousels,
 * with how recent posts did.
 *
 * Owners and managers connect and disconnect (social.connect); owners,
 * managers and publishers post (social.publish); everyone who can open the
 * business sees the account and its posts.
 */

const ERRORS: Record<string, string> = {
  role: "Your role cannot connect Instagram. An owner or manager can.",
  notconfigured: "Instagram is not switched on in 10XiD yet.",
  state: "That sign-in did not start here, or took too long. Try connecting again.",
  cancelled: "Instagram was not connected.",
  personal:
    "That is a personal Instagram account. Switch it to a Business or Creator account in the Instagram app (Settings → Account type and tools), then connect again. It keeps every post and follower.",
  taken: "That Instagram account is already connected to another business in 10XiD.",
};

const DONE: Record<string, string> = {
  connected: "Instagram is connected.",
  disconnected: "Instagram is disconnected. Its access has been deleted from 10XiD.",
};

export default async function InstagramPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; detail?: string; done?: string }>;
}) {
  const granted = await requirePage("business.view", { returnPath: "/channels/instagram" });
  const { ctx, businessId, role, via } = granted;
  const owner = { organizationId: businessId, userId: ctx.userId };
  const params = await searchParams;

  // Posting needs both the Meta app and somewhere to keep media until Instagram fetches it.
  const config = mediaBucketConfigured() ? instagramConfig() : null;
  const connection = config ? await socialConnectionFor(owner, "instagram") : null;
  const mayConnect = allows(role, "social.connect", via);
  const mayPost = allows(role, "social.publish", via);
  const identity = connection && mayPost ? await resolveIdentity() : null;
  const csrf = identity?.state === "active" ? identity.csrfToken : "";

  // One request to Instagram for the page, shared by the account card and the
  // posts: the token (refreshed if it is due), then both reads side by side.
  const live: Promise<Live> | null = connection
    ? (async () => {
        try {
          const token = await channelToken(owner, connection);
          const [account, posts] = await Promise.all([profile(token), recentPosts(token)]);
          return { ok: true as const, account, posts };
        } catch (err) {
          if (err instanceof MetaError) return { ok: false as const, signedOut: err.signedOut, message: err.message };
          throw err;
        }
      })()
    : null;

  return (
    <PortalShell email={ctx.email} isStaff={ctx.scope.isStaff} actingOn={null}>
      <h1 className="text-2xl font-semibold tracking-tight text-ink">Instagram</h1>
      <p className="mt-1 max-w-prose text-sm text-ink-soft">Post to Instagram and see what lands.</p>

      {params.error ? (
        <p role="alert" className="mt-4 rounded-lg border border-bad/30 bg-bad/5 px-3 py-2 text-sm text-bad">
          {params.error === "instagram" ? `Instagram said: ${params.detail ?? "no."}` : (ERRORS[params.error] ?? "That did not work.")}
        </p>
      ) : null}
      {params.done && DONE[params.done] ? (
        <p role="status" className="mt-4 rounded-lg border border-good/30 bg-good/5 px-3 py-2 text-sm text-good">
          {DONE[params.done]}
        </p>
      ) : null}

      {!config ? (
        <section className="mt-6 rounded-2xl border border-line bg-surface p-6 shadow-card">
          <Heading title="Instagram is being set up" text="10XiD needs its Meta app keys and media store before an account can be connected. Nothing for you to do here yet." />
        </section>
      ) : !connection ? (
        <section className="mt-6 rounded-2xl border border-line bg-surface p-6 shadow-card">
          <Heading title="Connect your Instagram account" text="Once it is connected, your team can post photos, videos and carousels from here and see how they did." />
          <ul className="mt-5 grid gap-2 text-sm text-ink-soft sm:max-w-lg">
            <li className="flex gap-2">
              <span aria-hidden className="text-ink-faint">•</span>
              It must be a Business or Creator account. In the Instagram app: Settings → Account type and tools. Switching is free and keeps everything.
            </li>
            <li className="flex gap-2">
              <span aria-hidden className="text-ink-faint">•</span>
              You sign in on Instagram itself. 10XiD never sees the password.
            </li>
          </ul>
          {mayConnect ? (
            <a
              href="/api/instagram/connect"
              className="mt-5 inline-flex items-center gap-2 rounded-lg bg-brand-surface px-4 py-2 text-sm font-semibold text-brand-on-surface hover:bg-brand-surface-hover"
            >
              <Icon name="instagram" /> Connect Instagram
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
                <SocialComposer channel="instagram" csrf={csrf} username={connection.username} />
              ) : (
                <p className="mt-2 text-sm text-ink-soft">A publisher, manager or owner can post to Instagram.</p>
              )}
            </section>
            <aside className="grid content-start gap-4">
              <Suspense fallback={<AccountCard connection={connection} account={null} />}>
                <AccountFromLive live={live!} connection={connection} />
              </Suspense>
              {mayConnect ? (
                <form action={disconnectInstagramAction} className="rounded-xl border border-line bg-surface p-4 text-sm shadow-card">
                  <CsrfField />
                  <input type="hidden" name="connectionId" value={connection.id} />
                  <p className="text-ink-soft">Disconnecting deletes 10XiD’s access. Posts already on Instagram stay there.</p>
                  <SubmitButton
                    pendingLabel="Disconnecting…"
                    className="mt-3 rounded-lg border border-line px-3 py-1.5 text-[13px] font-semibold text-ink hover:bg-sunk disabled:opacity-60"
                  >
                    Disconnect
                  </SubmitButton>
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

type Live =
  | { ok: true; account: InstagramProfile; posts: InstagramPost[] }
  | { ok: false; signedOut: boolean; message: string };

function Heading({ title, text }: { title: string; text: string }) {
  return (
    <div className="flex items-center gap-3">
      <span className="grid h-10 w-10 flex-none place-items-center rounded-xl bg-sunk text-ink-soft">
        <Icon name="instagram" />
      </span>
      <div>
        <h2 className="text-base font-semibold text-ink">{title}</h2>
        <p className="text-sm text-ink-soft">{text}</p>
      </div>
    </div>
  );
}

const number = (n: number | null | undefined) => (n === null || n === undefined ? "—" : n.toLocaleString("en-CA"));

async function AccountFromLive({ live, connection }: { live: Promise<Live>; connection: SocialConnection }) {
  const result = await live;
  return <AccountCard connection={connection} account={result.ok ? result.account : null} />;
}

function AccountCard({ connection, account }: { connection: SocialConnection; account: InstagramProfile | null }) {
  return (
    <div className="rounded-xl border border-line bg-surface p-4 shadow-card">
      <div className="flex items-center gap-3">
        {account?.picture ? (
          // eslint-disable-next-line @next/next/no-img-element -- Instagram's own picture address
          <img src={account.picture} alt="" className="h-12 w-12 flex-none rounded-full border border-line object-cover" />
        ) : (
          <span className="grid h-12 w-12 flex-none place-items-center rounded-full bg-sunk text-lg font-semibold text-ink-soft">
            {connection.username.slice(0, 1).toUpperCase()}
          </span>
        )}
        <div className="min-w-0">
          <a
            href={`https://www.instagram.com/${encodeURIComponent(connection.username)}/`}
            target="_blank"
            rel="noreferrer"
            className="block truncate font-semibold text-ink hover:underline"
          >
            @{connection.username}
          </a>
          {account?.name ? <p className="truncate text-sm text-ink-soft">{account.name}</p> : null}
        </div>
      </div>
      <dl className="mt-4 grid grid-cols-2 gap-2 text-sm">
        <div className="rounded-lg bg-sunk px-3 py-2">
          <dt className="text-xs text-ink-faint">Followers</dt>
          <dd className="font-semibold text-ink">{number(account?.followers)}</dd>
        </div>
        <div className="rounded-lg bg-sunk px-3 py-2">
          <dt className="text-xs text-ink-faint">Posts</dt>
          <dd className="font-semibold text-ink">{number(account?.posts)}</dd>
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
        {result.signedOut ? "Instagram has signed this connection out." : `Instagram did not answer: ${result.message}`}
        {result.signedOut && mayConnect ? (
          <>
            {" "}
            <a href="/api/instagram/connect" className="font-semibold underline">
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
              // eslint-disable-next-line @next/next/no-img-element -- Instagram's own media address
              <img src={p.image} alt={p.caption?.slice(0, 120) ?? ""} loading="lazy" className="aspect-square w-full bg-sunk object-cover" />
            ) : (
              <div className="grid aspect-square w-full place-items-center bg-sunk text-xs text-ink-faint">{p.type.toLowerCase()}</div>
            )}
          </a>
          <div className="grid gap-1 p-3 text-xs">
            <div className="flex flex-wrap gap-x-3 gap-y-1 text-ink">
              <span title="Likes">♥ {number(p.likes)}</span>
              <span title="Comments">💬 {number(p.comments)}</span>
              <span title="Accounts reached" className="text-ink-soft">
                Reach {number(p.reach)}
              </span>
            </div>
            {p.postedAt ? (
              <span className="text-ink-faint">
                {new Date(p.postedAt).toLocaleDateString("en-CA", { month: "short", day: "numeric", year: "numeric" })}
              </span>
            ) : null}
            {p.caption ? <p className="line-clamp-2 text-ink-soft">{p.caption}</p> : null}
          </div>
        </li>
      ))}
    </ul>
  );
}

function PostsLoading() {
  return (
    <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4" aria-busy="true" aria-label="Asking Instagram">
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="aspect-square animate-pulse rounded-xl bg-sunk" />
      ))}
    </div>
  );
}
