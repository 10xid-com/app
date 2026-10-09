import "server-only";
import { appOrigin } from "@/lib/auth/origin";
import { channelTokenKey, MetaError } from "./meta";

/**
 * Facebook Pages, through Facebook Login and the Graph API.
 *
 * A business connects one Facebook Page: the person signs in to Facebook
 * from the Facebook channel and grants 10XiD the Page permissions; their
 * short-lived token becomes a long-lived one, and from that the Page's own
 * access token, which does not expire. The portal keeps only the Page token,
 * sealed (./meta.ts); the person's token is never stored (while they choose
 * between several Pages it waits, sealed, in their own browser's cookie).
 *
 * Configuration, on the app service:
 *   FACEBOOK_APP_ID       the Meta app's App ID
 *   FACEBOOK_APP_SECRET   its App secret
 *   CHANNEL_TOKEN_KEY     shared with Instagram: seals stored tokens
 *   FACEBOOK_GRAPH_VERSION  optional, default v25.0
 */

const version = () => process.env.FACEBOOK_GRAPH_VERSION?.trim() || "v25.0";
const GRAPH = () => `https://graph.facebook.com/${version()}`;

/** List the Pages, post to them (text, photos, video), read how posts did. */
export const SCOPES = ["pages_show_list", "pages_read_engagement", "pages_manage_posts", "publish_video", "business_management"] as const;

/** Facebook's own limit on a post's text. */
export const MESSAGE_LIMIT = 63_206;
/** Photos in one post. */
export const MAX_PHOTOS = 10;

export class FacebookError extends MetaError {}

export type FacebookConfig = { appId: string; appSecret: string };

export function facebookConfig(): FacebookConfig | null {
  const appId = process.env.FACEBOOK_APP_ID?.trim();
  const appSecret = process.env.FACEBOOK_APP_SECRET?.trim();
  if (!appId || !/^\d{5,25}$/.test(appId) || !appSecret || !channelTokenKey()) return null;
  return { appId, appSecret };
}

export function redirectUri(): string {
  return `${appOrigin()}/api/facebook/callback`;
}

export function authorizeUrl(config: FacebookConfig, state: string): string {
  const url = new URL(`https://www.facebook.com/${version()}/dialog/oauth`);
  url.searchParams.set("client_id", config.appId);
  url.searchParams.set("redirect_uri", redirectUri());
  url.searchParams.set("state", state);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", SCOPES.join(","));
  return url.toString();
}

type GraphError = { error?: { message?: string; code?: number; error_user_msg?: string } };

async function call<T>(url: string | URL, init: RequestInit = {}, token?: string): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(init.headers ?? {}) },
      cache: "no-store",
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new FacebookError("Facebook did not answer. Try again in a moment.");
  }
  const body = (await response.json().catch(() => ({}))) as T & GraphError;
  if (!response.ok || body.error) {
    const e = body.error;
    throw new FacebookError(e?.error_user_msg || e?.message || `Facebook answered ${response.status}.`, e?.code ?? null);
  }
  return body;
}

/** The sign-in's code, for a long-lived token for the person (about 60 days). */
export async function personToken(config: FacebookConfig, code: string): Promise<string> {
  const short = new URL(`${GRAPH()}/oauth/access_token`);
  short.searchParams.set("client_id", config.appId);
  short.searchParams.set("redirect_uri", redirectUri());
  short.searchParams.set("client_secret", config.appSecret);
  short.searchParams.set("code", code);
  const first = await call<{ access_token: string }>(short);

  const long = new URL(`${GRAPH()}/oauth/access_token`);
  long.searchParams.set("grant_type", "fb_exchange_token");
  long.searchParams.set("client_id", config.appId);
  long.searchParams.set("client_secret", config.appSecret);
  long.searchParams.set("fb_exchange_token", first.access_token);
  return (await call<{ access_token: string }>(long)).access_token;
}

/** Who signed in (their app-scoped id), and which permissions they granted. */
export async function whoSignedIn(token: string): Promise<{ id: string; name: string; granted: string[] }> {
  const [me, perms] = await Promise.all([
    call<{ id: string; name?: string }>(`${GRAPH()}/me?fields=id,name`, {}, token),
    call<{ data?: { permission: string; status: string }[] }>(`${GRAPH()}/me/permissions`, {}, token),
  ]);
  return {
    id: me.id,
    name: me.name ?? "",
    granted: (perms.data ?? []).filter((p) => p.status === "granted").map((p) => p.permission),
  };
}

export type FacebookPage = { id: string; name: string; category: string | null; picture: string | null; token: string; canPost: boolean };

/** The Pages the person manages, each with its own access token. */
export async function managedPages(token: string): Promise<FacebookPage[]> {
  const pages: FacebookPage[] = [];
  let url: string | null = `${GRAPH()}/me/accounts?fields=id,name,category,access_token,tasks,picture{url}&limit=100`;
  for (let i = 0; url && i < 5; i++) {
    type Answer = {
      data?: { id: string; name: string; category?: string; access_token: string; tasks?: string[]; picture?: { data?: { url?: string } } }[];
      paging?: { next?: string };
    };
    const body: Answer = await call<Answer>(url, {}, token);
    for (const p of body.data ?? []) {
      pages.push({
        id: p.id,
        name: p.name,
        category: p.category ?? null,
        picture: p.picture?.data?.url ?? null,
        token: p.access_token,
        // Posting needs the Page task CREATE_CONTENT; a Page with no tasks listed is one the person administers.
        canPost: !p.tasks || p.tasks.includes("CREATE_CONTENT") || p.tasks.includes("MANAGE"),
      });
    }
    url = body.paging?.next ?? null;
  }
  return pages;
}

export type FacebookPageProfile = { name: string; followers: number | null; likes: number | null; picture: string | null; link: string | null };

export async function pageProfile(token: string, pageId: string): Promise<FacebookPageProfile> {
  const b = await call<{ name: string; followers_count?: number; fan_count?: number; link?: string; picture?: { data?: { url?: string } } }>(
    `${GRAPH()}/${encodeURIComponent(pageId)}?fields=name,followers_count,fan_count,link,picture.type(large){url}`,
    {},
    token,
  );
  return {
    name: b.name,
    followers: b.followers_count ?? null,
    likes: b.fan_count ?? null,
    picture: b.picture?.data?.url ?? null,
    link: b.link ?? null,
  };
}

export type FacebookPost = {
  id: string;
  message: string | null;
  image: string | null;
  permalink: string | null;
  postedAt: string | null;
  reactions: number | null;
  comments: number | null;
  shares: number | null;
};

export async function recentPagePosts(token: string, pageId: string, limit = 12): Promise<FacebookPost[]> {
  const url = new URL(`${GRAPH()}/${encodeURIComponent(pageId)}/published_posts`);
  url.searchParams.set(
    "fields",
    "id,message,created_time,permalink_url,full_picture,reactions.summary(total_count).limit(0),comments.summary(total_count).limit(0),shares",
  );
  url.searchParams.set("limit", String(limit));
  type Post = {
    id: string;
    message?: string;
    created_time?: string;
    permalink_url?: string;
    full_picture?: string;
    reactions?: { summary?: { total_count?: number } };
    comments?: { summary?: { total_count?: number } };
    shares?: { count?: number };
  };
  const body = await call<{ data?: Post[] }>(url, {}, token);
  return (body.data ?? []).map((p) => ({
    id: p.id,
    message: p.message ?? null,
    image: p.full_picture ?? null,
    permalink: p.permalink_url ?? null,
    postedAt: p.created_time ?? null,
    reactions: p.reactions?.summary?.total_count ?? null,
    comments: p.comments?.summary?.total_count ?? null,
    shares: p.shares?.count ?? 0,
  }));
}

/**
 * Post to the Page: text alone, text with photos (one, or several in one
 * post), or a video with its description. Each address must be one Facebook
 * can fetch now. Answers with the post's id and address when Facebook gives
 * one (a video's post appears once Facebook has processed it).
 */
export async function publishToPage(
  token: string,
  pageId: string,
  input: { message: string; photos: string[]; video: string | null },
): Promise<{ id: string; permalink: string | null }> {
  const page = `${GRAPH()}/${encodeURIComponent(pageId)}`;
  const post = <T>(path: string, params: Record<string, string>) =>
    call<T>(`${page}/${path}`, { method: "POST", body: new URLSearchParams(params) }, token);

  let id: string;
  if (input.video) {
    const done = await post<{ id: string }>("videos", { file_url: input.video, description: input.message });
    // A video is its own object; its post on the Page is made as it is processed.
    return { id: done.id, permalink: `https://www.facebook.com/${encodeURIComponent(pageId)}/videos/${encodeURIComponent(done.id)}` };
  } else if (input.photos.length === 1) {
    id = (await post<{ id: string; post_id?: string }>("photos", { url: input.photos[0], message: input.message })).post_id ?? "";
  } else if (input.photos.length > 1) {
    // Several photos in one post: each uploaded unpublished, then attached to one feed post.
    const ids: string[] = [];
    for (const url of input.photos) ids.push((await post<{ id: string }>("photos", { url, published: "false" })).id);
    const params: Record<string, string> = { message: input.message };
    ids.forEach((media, i) => (params[`attached_media[${i}]`] = JSON.stringify({ media_fbid: media })));
    id = (await post<{ id: string }>("feed", params)).id;
  } else {
    id = (await post<{ id: string }>("feed", { message: input.message })).id;
  }

  let permalink: string | null = null;
  if (id) {
    try {
      permalink = (await call<{ permalink_url?: string }>(`${GRAPH()}/${encodeURIComponent(id)}?fields=permalink_url`, {}, token)).permalink_url ?? null;
    } catch {
      // Posted; the link is a nicety.
    }
  }
  return { id, permalink };
}
