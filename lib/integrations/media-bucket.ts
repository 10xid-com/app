import "server-only";
import { AwsClient } from "aws4fetch";

/**
 * The bucket social photos and videos wait in until a channel fetches them
 * (Railway's "social-media" bucket, S3-compatible and private).
 *
 * Instagram takes media only from an address it can fetch. Nothing in the
 * bucket is public: each post hands Instagram a presigned address for each
 * file, good for a few hours, and the file is deleted once posted.
 *
 * Uploads come through the portal, never straight from the browser: a photo
 * in one request, a video in parts (S3 multipart), each part small enough to
 * pass the portal's 10MB request limit. So the bucket needs no CORS rules and
 * the browser never holds a bucket credential.
 *
 * Configuration, on the app service, as references to the bucket's own
 * variables:
 *   MEDIA_BUCKET_ENDPOINT          ${{social-media.ENDPOINT}}
 *   MEDIA_BUCKET_NAME              ${{social-media.BUCKET}}
 *   MEDIA_BUCKET_REGION            ${{social-media.REGION}}
 *   MEDIA_BUCKET_ACCESS_KEY_ID     ${{social-media.ACCESS_KEY_ID}}
 *   MEDIA_BUCKET_SECRET_ACCESS_KEY ${{social-media.SECRET_ACCESS_KEY}}
 *   MEDIA_BUCKET_PATH_STYLE        "true" only for a bucket that needs path-style addresses
 */

export class BucketError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BucketError";
  }
}

type Bucket = { client: AwsClient; base: string };

function bucket(): Bucket | null {
  const endpoint = process.env.MEDIA_BUCKET_ENDPOINT?.trim().replace(/\/+$/, "");
  const name = process.env.MEDIA_BUCKET_NAME?.trim();
  const accessKeyId = process.env.MEDIA_BUCKET_ACCESS_KEY_ID?.trim();
  const secretAccessKey = process.env.MEDIA_BUCKET_SECRET_ACCESS_KEY?.trim();
  if (!endpoint || !name || !accessKeyId || !secretAccessKey) return null;
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return null;
  }
  const base =
    process.env.MEDIA_BUCKET_PATH_STYLE === "true"
      ? `${url.origin}/${encodeURIComponent(name)}`
      : `${url.protocol}//${name}.${url.host}`;
  const client = new AwsClient({
    accessKeyId,
    secretAccessKey,
    service: "s3",
    region: process.env.MEDIA_BUCKET_REGION?.trim() || "auto",
  });
  return { client, base };
}

export function mediaBucketConfigured(): boolean {
  return bucket() !== null;
}

function need(): Bucket {
  const b = bucket();
  if (!b) throw new BucketError("The portal has no media bucket configured (MEDIA_BUCKET_*).");
  return b;
}

/** Keys are ours (lib/db/social.ts makes them); each path segment is encoded anyway. */
const objectUrl = (b: Bucket, key: string, query = "") =>
  `${b.base}/${key.split("/").map(encodeURIComponent).join("/")}${query}`;

async function send(b: Bucket, url: string, init: RequestInit, what: string): Promise<Response> {
  let response: Response;
  try {
    response = await b.client.fetch(url, { ...init, signal: AbortSignal.timeout(120_000) });
  } catch {
    throw new BucketError(`The media store did not answer (${what}).`);
  }
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    const code = /<Code>([^<]+)<\/Code>/.exec(text)?.[1];
    throw new BucketError(`The media store refused ${what} (${response.status}${code ? ` ${code}` : ""}).`);
  }
  return response;
}

export async function putObject(key: string, body: Uint8Array<ArrayBuffer>, contentType: string): Promise<void> {
  const b = need();
  await send(b, objectUrl(b, key), { method: "PUT", body, headers: { "content-type": contentType } }, "the upload");
}

export async function deleteObject(key: string): Promise<void> {
  const b = need();
  const url = objectUrl(b, key);
  try {
    const response = await b.client.fetch(url, { method: "DELETE", signal: AbortSignal.timeout(30_000) });
    // Already gone is gone.
    if (!response.ok && response.status !== 404) throw new BucketError(`The media store refused a delete (${response.status}).`);
  } catch (err) {
    if (err instanceof BucketError) throw err;
    throw new BucketError("The media store did not answer (a delete).");
  }
}

/** The object's size in bytes, or null if there is none. */
export async function objectSize(key: string): Promise<number | null> {
  const b = need();
  const response = await b.client.fetch(objectUrl(b, key), { method: "HEAD", signal: AbortSignal.timeout(30_000) });
  if (response.status === 404) return null;
  if (!response.ok) throw new BucketError(`The media store refused a lookup (${response.status}).`);
  return Number(response.headers.get("content-length") ?? "0");
}

/** A time-limited address anyone holding it can download the object from. */
export async function presignedGet(key: string, seconds: number): Promise<string> {
  const b = need();
  const url = new URL(objectUrl(b, key));
  url.searchParams.set("X-Amz-Expires", String(seconds));
  const signed = await b.client.sign(url.toString(), { method: "GET", aws: { signQuery: true } });
  return signed.url;
}

/* ------------------------------------------------------------------ */
/* Multipart, for videos                                                */
/* ------------------------------------------------------------------ */

export async function startMultipart(key: string, contentType: string): Promise<string> {
  const b = need();
  const response = await send(b, objectUrl(b, key, "?uploads"), { method: "POST", headers: { "content-type": contentType } }, "a video upload");
  const id = /<UploadId>([^<]+)<\/UploadId>/.exec(await response.text())?.[1];
  if (!id) throw new BucketError("The media store did not start the upload.");
  return id;
}

/** One part (1 to 10,000). Answers with the part's ETag, which completing needs. */
export async function uploadPart(key: string, uploadId: string, part: number, body: Uint8Array<ArrayBuffer>): Promise<string> {
  const b = need();
  const response = await send(
    b,
    objectUrl(b, key, `?partNumber=${part}&uploadId=${encodeURIComponent(uploadId)}`),
    { method: "PUT", body },
    `part ${part}`,
  );
  const etag = response.headers.get("etag");
  if (!etag) throw new BucketError(`The media store did not confirm part ${part}.`);
  return etag;
}

const xmlEscape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export async function completeMultipart(key: string, uploadId: string, parts: { part: number; etag: string }[]): Promise<void> {
  const b = need();
  const body =
    "<CompleteMultipartUpload>" +
    [...parts]
      .sort((x, y) => x.part - y.part)
      .map((p) => `<Part><PartNumber>${p.part}</PartNumber><ETag>${xmlEscape(p.etag)}</ETag></Part>`)
      .join("") +
    "</CompleteMultipartUpload>";
  const response = await send(
    b,
    objectUrl(b, key, `?uploadId=${encodeURIComponent(uploadId)}`),
    { method: "POST", body, headers: { "content-type": "application/xml" } },
    "finishing the video upload",
  );
  // S3 can answer 200 with an error inside the body.
  const text = await response.text();
  if (/<Error>/.test(text)) throw new BucketError("The media store could not put the video together. Upload it again.");
}

export async function abortMultipart(key: string, uploadId: string): Promise<void> {
  const b = need();
  try {
    await b.client.fetch(objectUrl(b, key, `?uploadId=${encodeURIComponent(uploadId)}`), {
      method: "DELETE",
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    // Best effort: an abandoned upload costs storage, not correctness.
  }
}
