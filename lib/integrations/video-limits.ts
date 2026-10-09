/**
 * Instagram's video limits, and how a video comes up to the portal. Shared by
 * the composer and the upload routes, so both refuse the same things.
 */

/** Reels: MP4 or MOV, 3 seconds to 15 minutes, 300MB. */
export const VIDEO_TYPES = ["video/mp4", "video/quicktime"] as const;
export const VIDEO_MAX_BYTES = 300 * 1024 * 1024;
export const VIDEO_MIN_MS = 3_000;
export const VIDEO_MAX_MS = 15 * 60_000;
/** A video inside a carousel is held to a minute, as in the Instagram app. */
export const CAROUSEL_VIDEO_MAX_MS = 60_000;

/**
 * Each part of an upload: under the portal's 10MB request limit, over the
 * store's 5MB minimum for every part but the last.
 */
export const VIDEO_PART_BYTES = 8 * 1024 * 1024;

export const partsFor = (byteSize: number) => Math.ceil(byteSize / VIDEO_PART_BYTES);

/** The exact size part `n` (from 1) must be. */
export const partSize = (byteSize: number, n: number) => Math.min(VIDEO_PART_BYTES, byteSize - (n - 1) * VIDEO_PART_BYTES);
