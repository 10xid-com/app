import "server-only";
import { appOrigin } from "@/lib/auth/origin";
import { channelTokenKey, MetaError } from "./meta";

/**
 * Instagram, through Meta's "Instagram API with Instagram Login".
 *
 * A business connects its Instagram professional account (Business or
 * Creator) by signing in to Instagram from the Instagram channel; Instagram
 * hands back a code, which becomes a token good for an hour, which becomes one
 * good for 60 days. The portal keeps that one, sealed (./meta.ts),
 * and refreshes it as it is used.
 *
 * Configuration, on the app service:
 *   INSTAGRAM_APP_ID       the Instagram app id from Meta's developer dashboard
 *   INSTAGRAM_APP_SECRET   its secret: exchanges codes, extends tokens, and
 *                          checks Instagram's signed notices
 *   CHANNEL_TOKEN_KEY      32 random bytes, base64url: encrypts stored tokens
 *
 * Every call carries the token in an Authorization header, never in the
 * address, except the two token endpoints that only take it in the query.
 */

const AUTHORIZE = "https://www.instagram.com/oauth/authorize";
const TOKEN = "https://api.instagram.com/oauth/access_token";
const GRAPH = "https://graph.instagram.com";

/** What the channel asks for: who the account is, posting, and how posts did. */
export const SCOPES = [
  "instagram_business_basic",
  "instagram_business_content_publish",
  "instagram_business_manage_insights",
] as const;

/** Instagram's own limit on a caption. */
export const CAPTION_LIMIT = 2200;
/** A carousel holds 2 to 10; one photo or video is a post of its own. */
export const MAX_PHOTOS = 10;
/** Instagram's feed takes 4:5 (portrait) to 1.91:1 (landscape). */
export const RATIO_MIN = 0.8;
export const RATIO_MAX = 1.91;

export class InstagramError extends MetaError {}

export type InstagramConfig = { appId: string; appSecret: string };

export function instagramConfig(): InstagramConfig | null {
  const appId = process.env.INSTAGRAM_APP_ID?.trim();
  const appSecret = process.env.INSTAGRAM_APP_SECRET?.trim();
  if (!appId || !/^\d{5,25}$/.test(appId) || !appSecret || !channelTokenKey()) return null;
  return { appId, appSecret };
}

export function redirectUri(): string {
  return `${appOrigin()}/api/instagram/callback`;
}

export function authorizeUrl(config: InstagramConfig, state: string): string {
  const url = new URL(AUTHORIZE);
  url.searchParams.set("client_id", config.appId);
  url.searchParams.set("redirect_uri", redirectUri());
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", SCOPES.join(","));
  url.searchParams.set("state", state);
  // Straight to Instagram's own sign-in, not Facebook's.
  url.searchParams.set("enable_fb_login", "false");
  return url.toString();
}

/* ------------------------------------------------------------------ */
/* Calls                                                                */
/* ------------------------------------------------------------------ */

type GraphError = { error?: { message?: string; code?: number; error_user_msg?: string } };

async function call<T>(url: string | URL, init: RequestInit = {}, token?: string): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(init.headers ?? {}) },
      cache: "no-store",
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new InstagramError("Instagram did not answer. Try again in a moment.");
  }
  const body = (await response.json().catch(() => ({}))) as T & GraphError & { error_message?: string; code?: number };
  if (!response.ok || body.error) {
    const e = body.error;
    const message = e?.error_user_msg || e?.message || body.error_message || `Instagram answered ${response.status}.`;
    throw new InstagramError(message, e?.code ?? (typeof body.code === "number" ? body.code : null));
  }
  return body;
}

/** The code from the sign-in, for a short-lived token and the person's app-scoped id. */
export async function exchangeCode(config: InstagramConfig, code: string): Promise<{ token: string; scopedId: string; permissions: string[] }> {
  const form = new URLSearchParams({
    client_id: config.appId,
    client_secret: config.appSecret,
    grant_type: "authorization_code",
    redirect_uri: redirectUri(),
    code,
  });
  type Answer = {
    access_token?: string;
    user_id?: string | number;
    permissions?: string[] | string;
    data?: { access_token: string; user_id: string | number; permissions?: string[] | string }[];
  };
  const body = await call<Answer>(TOKEN, { method: "POST", body: form });
  const one = body.data?.[0] ?? body;
  if (!one.access_token || one.user_id === undefined) throw new InstagramError("Instagram did not return a token.");
  const permissions = Array.isArray(one.permissions)
    ? one.permissions
    : typeof one.permissions === "string"
      ? one.permissions.split(",")
      : [];
  return { token: one.access_token, scopedId: String(one.user_id), permissions };
}

/** A short-lived token for one that lasts 60 days. */
export async function longLivedToken(config: InstagramConfig, shortToken: string): Promise<{ token: string; expiresAt: Date }> {
  const url = new URL(`${GRAPH}/access_token`);
  url.searchParams.set("grant_type", "ig_exchange_token");
  url.searchParams.set("client_secret", config.appSecret);
  url.searchParams.set("access_token", shortToken);
  const body = await call<{ access_token: string; expires_in: number }>(url);
  return { token: body.access_token, expiresAt: new Date(Date.now() + body.expires_in * 1000) };
}

/** Another 60 days. Instagram allows it once the token is a day old. */
export async function refreshToken(token: string): Promise<{ token: string; expiresAt: Date }> {
  const url = new URL(`${GRAPH}/refresh_access_token`);
  url.searchParams.set("grant_type", "ig_refresh_token");
  url.searchParams.set("access_token", token);
  const body = await call<{ access_token: string; expires_in: number }>(url);
  return { token: body.access_token, expiresAt: new Date(Date.now() + body.expires_in * 1000) };
}

export type InstagramProfile = {
  accountId: string;
  scopedId: string;
  username: string;
  name: string | null;
  accountType: string | null;
  picture: string | null;
  followers: number | null;
  posts: number | null;
};

export async function profile(token: string): Promise<InstagramProfile> {
  const url = new URL(`${GRAPH}/me`);
  url.searchParams.set("fields", "id,user_id,username,name,account_type,profile_picture_url,followers_count,media_count");
  const b = await call<{
    id: string;
    user_id?: string | number;
    username: string;
    name?: string;
    account_type?: string;
    profile_picture_url?: string;
    followers_count?: number;
    media_count?: number;
  }>(url, {}, token);
  return {
    accountId: String(b.user_id ?? b.id),
    scopedId: String(b.id),
    username: b.username,
    name: b.name ?? null,
    accountType: b.account_type ?? null,
    picture: b.profile_picture_url ?? null,
    followers: b.followers_count ?? null,
    posts: b.media_count ?? null,
  };
}

export type InstagramPost = {
  id: string;
  caption: string | null;
  type: string;
  image: string | null;
  permalink: string | null;
  postedAt: string | null;
  likes: number | null;
  comments: number | null;
  reach: number | null;
};

export async function recentPosts(token: string, limit = 12): Promise<InstagramPost[]> {
  const url = new URL(`${GRAPH}/me/media`);
  url.searchParams.set(
    "fields",
    "id,caption,media_type,media_url,thumbnail_url,permalink,timestamp,like_count,comments_count",
  );
  url.searchParams.set("limit", String(limit));
  type Media = {
    id: string;
    caption?: string;
    media_type?: string;
    media_url?: string;
    thumbnail_url?: string;
    permalink?: string;
    timestamp?: string;
    like_count?: number;
    comments_count?: number;
  };
  const body = await call<{ data?: Media[] }>(url, {}, token);
  const media = body.data ?? [];
  // Reach is per post; one call each, side by side. A post Instagram has no
  // figure for (too old, or a kind it does not count) shows without one.
  const reach = await Promise.all(
    media.map(async (m) => {
      try {
        const r = await call<{ data?: { name: string; values?: { value: number }[]; total_value?: { value: number } }[] }>(
          `${GRAPH}/${encodeURIComponent(m.id)}/insights?metric=reach`,
          {},
          token,
        );
        const row = r.data?.find((d) => d.name === "reach");
        return row?.total_value?.value ?? row?.values?.[0]?.value ?? null;
      } catch {
        return null;
      }
    }),
  );
  return media.map((m, i) => ({
    id: m.id,
    caption: m.caption ?? null,
    type: m.media_type ?? "IMAGE",
    image: (m.media_type === "VIDEO" ? m.thumbnail_url : m.media_url) ?? m.thumbnail_url ?? null,
    permalink: m.permalink ?? null,
    postedAt: m.timestamp ?? null,
    likes: m.like_count ?? null,
    comments: m.comments_count ?? null,
    reach: reach[i],
  }));
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Wait for Instagram to finish fetching and processing a container. A photo
 * takes seconds; a video can take minutes, so the wait grows: every 2 seconds
 * for the first half-minute, then every 10, for up to 6 minutes in all.
 */
async function ready(token: string, container: string): Promise<void> {
  const started = Date.now();
  for (let i = 0; Date.now() - started < 6 * 60_000; i++) {
    const s = await call<{ status_code?: string; status?: string }>(
      `${GRAPH}/${encodeURIComponent(container)}?fields=status_code,status`,
      {},
      token,
    );
    if (s.status_code === "FINISHED" || s.status_code === "PUBLISHED") return;
    if (s.status_code === "ERROR" || s.status_code === "EXPIRED") {
      throw new InstagramError(
        `Instagram could not use one of the files${s.status ? ` (${s.status})` : ""}. Videos must be MP4 or MOV (H.264 or HEVC), 23 to 60 frames a second, at most 1920 pixels wide.`,
      );
    }
    await wait(i < 15 ? 2000 : 10_000);
  }
  throw new InstagramError("Instagram is still processing. Check the account in a few minutes before posting again.");
}

export type MediaItem = { kind: "photo" | "video"; url: string };
export type ReelOptions = { shareToFeed: boolean; coverMs: number | null };

/**
 * Post to the account: one photo, one video (as a Reel), or a carousel of 2
 * to 10 photos and videos, with a caption. Each address must be one Instagram
 * can fetch now. Answers with the new post's id and address.
 */
export async function publishMedia(
  token: string,
  accountId: string,
  input: { caption: string; items: MediaItem[]; reel?: ReelOptions },
): Promise<{ id: string; permalink: string | null }> {
  const media = `${GRAPH}/${encodeURIComponent(accountId)}/media`;
  const create = (params: Record<string, string>) =>
    call<{ id: string }>(media, { method: "POST", body: new URLSearchParams(params) }, token).then((r) => r.id);

  let container: string;
  if (input.items.length === 1) {
    const [item] = input.items;
    if (item.kind === "photo") {
      container = await create({ image_url: item.url, caption: input.caption });
    } else {
      const params: Record<string, string> = {
        media_type: "REELS",
        video_url: item.url,
        caption: input.caption,
        share_to_feed: String(input.reel?.shareToFeed ?? true),
      };
      if (input.reel?.coverMs !== null && input.reel?.coverMs !== undefined) params.thumb_offset = String(Math.round(input.reel.coverMs));
      container = await create(params);
    }
  } else {
    const children: string[] = [];
    for (const item of input.items) {
      children.push(
        await create(
          item.kind === "photo"
            ? { image_url: item.url, is_carousel_item: "true" }
            : { media_type: "VIDEO", video_url: item.url, is_carousel_item: "true" },
        ),
      );
    }
    for (const child of children) await ready(token, child);
    container = await create({ media_type: "CAROUSEL", children: children.join(","), caption: input.caption });
  }
  await ready(token, container);

  const done = await call<{ id: string }>(
    `${GRAPH}/${encodeURIComponent(accountId)}/media_publish`,
    { method: "POST", body: new URLSearchParams({ creation_id: container }) },
    token,
  );
  let permalink: string | null = null;
  try {
    permalink = (await call<{ permalink?: string }>(`${GRAPH}/${encodeURIComponent(done.id)}?fields=permalink`, {}, token)).permalink ?? null;
  } catch {
    // Posted; the link is a nicety.
  }
  return { id: done.id, permalink };
}

/* ------------------------------------------------------------------ */
/* Photos and notices                                                   */
/* ------------------------------------------------------------------ */

/** A JPEG's width and height, read from its frame header; null if it is not a JPEG. */
export function jpegSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < bytes.length) {
    if (bytes[i] !== 0xff) return null;
    const marker = bytes[i + 1];
    if (marker === 0xff) {
      i++;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null;
    const length = (bytes[i + 2] << 8) | bytes[i + 3];
    // Start-of-frame markers, less the three that are not frames (DHT, JPG, DAC).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const height = (bytes[i + 5] << 8) | bytes[i + 6];
      const width = (bytes[i + 7] << 8) | bytes[i + 8];
      return width > 0 && height > 0 ? { width, height } : null;
    }
    i += 2 + length;
  }
  return null;
}

