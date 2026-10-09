/**
 * The edits a person can make to a video before it is posted, shared by the
 * composer (which previews them) and the server (which makes them with
 * ffmpeg, lib/integrations/video-edit.ts). Times are in milliseconds on the
 * original video's own timeline.
 */

export type TextPosition = "top" | "middle" | "bottom";
export type TextStyle = "shadow" | "box";

export type TextOverlay = {
  text: string;
  position: TextPosition;
  style: TextStyle;
  startMs: number;
  endMs: number;
};

export type VideoEdit = {
  /** Keep from here… */
  startMs: number;
  /** …to here. */
  endMs: number;
  /**
   * Reframe to this width÷height, keeping `position` of the way along the
   * axis that is cut (0 = left or top, 0.5 = centre, 1 = right or bottom);
   * null keeps the video's own shape.
   */
  crop: { ratio: number | null; position: number };
  /** Drop the video's own sound. */
  mute: boolean;
  texts: TextOverlay[];
};

export const MAX_TEXTS = 3;
export const TEXT_MAX_CHARS = 120;
/** The shapes a video can be cropped to: Instagram's feed range, and a Reel's 9:16. */
export const CROP_MIN = 0.5;
export const CROP_MAX = 1.92;

export function wholeVideo(durationMs: number): VideoEdit {
  return { startMs: 0, endMs: durationMs, crop: { ratio: null, position: 0.5 }, mute: false, texts: [] };
}

/**
 * Emoji and other pictographs have no glyph in the font the server draws
 * text with; they would come out as boxes, so they are left out, here and in
 * the preview alike.
 */
export function drawableText(text: string): string {
  return text.replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, "").replace(/[ \t]+/g, " ").trim();
}
