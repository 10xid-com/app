import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { editVideo, ffmpegArgs, probe } from "@/lib/integrations/video-edit";
import { drawableText, wholeVideo, type VideoEdit } from "@/lib/integrations/video-edit-spec";

/**
 * Video edits, made by the real ffmpeg on sample videos it generates: what
 * comes out is the length, shape, sound and format Instagram and Facebook
 * take. Skipped where ffmpeg is not installed (the app's image installs it,
 * railpack.json).
 */

const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;
const dir = mkdtempSync(join(tmpdir(), "video-edit-test-"));

/** A sample: `seconds` long, w×h, 60fps, with a tone, optionally rotated as a phone records. */
function sample(name: string, w: number, h: number, seconds: number, extra: string[] = []): string {
  const file = join(dir, name);
  execFileSync("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", `testsrc2=size=${w}x${h}:rate=60:duration=${seconds}`,
    "-f", "lavfi", "-i", `sine=frequency=440:duration=${seconds}`,
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac",
    ...extra, file,
  ]);
  return file;
}

function streams(file: string) {
  const out = execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,codec_name,profile,pix_fmt,r_frame_rate,sample_rate", "-of", "json", file]);
  return (JSON.parse(String(out)) as { streams: Record<string, string>[] }).streams;
}

let landscape = "";
beforeAll(() => {
  if (hasFfmpeg) landscape = sample("landscape.mp4", 1280, 720, 5);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("the ffmpeg command", () => {
  const source = { width: 1920, height: 1080, durationMs: 10_000, hasAudio: true };

  test("crops to the shape at the chosen position, scales, and keeps the sound", () => {
    const edit: VideoEdit = { ...wholeVideo(10_000), startMs: 2000, endMs: 7500, crop: { ratio: 9 / 16, position: 0 } };
    const args = ffmpegArgs("in.mp4", "out.mp4", source, edit, []);
    expect(args.slice(args.indexOf("-ss"), args.indexOf("-ss") + 4)).toEqual(["-ss", "2.000", "-to", "7.500"]);
    const vf = args[args.indexOf("-vf") + 1];
    expect(vf).toMatch(/^crop=608:1080:0:0,fps=30,format=yuv420p$/);
    expect(args).toContain("aac");
    expect(args).not.toContain("-an");
  });

  test("mutes, and draws text only while it is on screen, on the trimmed timeline", () => {
    const edit: VideoEdit = {
      ...wholeVideo(10_000),
      startMs: 2000,
      mute: true,
      texts: [{ text: "Full wrap", position: "bottom", style: "box", startMs: 3000, endMs: 5000 }],
    };
    const args = ffmpegArgs("in.mp4", "out.mp4", source, edit, ["/tmp/t0.txt"]);
    expect(args).toContain("-an");
    const vf = args[args.indexOf("-vf") + 1];
    expect(vf).toContain("textfile='/tmp/t0.txt'");
    expect(vf).toContain("enable='between(t,1.000,3.000)'");
    expect(vf).toContain("box=1");
  });

  test("a 4K wide video comes down to 1920 wide", () => {
    const args = ffmpegArgs("in.mp4", "out.mp4", { ...source, width: 3840, height: 2160 }, wholeVideo(10_000), []);
    expect(args[args.indexOf("-vf") + 1]).toContain("scale=1920:-2");
  });

  test("text loses the emoji the font cannot draw", () => {
    expect(drawableText("Bet you've never seen a flatbed edit before 👀🔥")).toBe("Bet you've never seen a flatbed edit before");
  });
});

describe.skipIf(!hasFfmpeg)("edited by ffmpeg", () => {
  test("trimmed, cropped to a Reel, with text: postable MP4", async () => {
    const edit: VideoEdit = {
      startMs: 1000,
      endMs: 4500,
      crop: { ratio: 9 / 16, position: 0.3 },
      mute: false,
      texts: [{ text: "Before 👀", position: "top", style: "shadow", startMs: 1000, endMs: 3000 }],
    };
    const result = await editVideo(landscape, edit, async (path, r) => ({ ...r, s: streams(path) }));
    expect(result.durationMs).toBeGreaterThan(3300);
    expect(result.durationMs).toBeLessThan(3700);
    expect(result.height).toBe(720);
    // 720 × 9/16 = 405, rounded to an even 406 as H.264 needs.
    expect(result.width).toBe(406);
    expect(result.hasAudio).toBe(true);
    const video = result.s.find((s) => s.codec_type === "video")!;
    expect(video).toMatchObject({ codec_name: "h264", pix_fmt: "yuv420p", r_frame_rate: "30/1" });
    expect(result.s.find((s) => s.codec_type === "audio")).toMatchObject({ codec_name: "aac", sample_rate: "48000" });
  }, 120_000);

  test("muted", async () => {
    const result = await editVideo(landscape, { ...wholeVideo(5000), mute: true }, async (_p, r) => r);
    expect(result.hasAudio).toBe(false);
    expect(result.width).toBe(1280);
  }, 120_000);

  test("a phone's rotated video is read as it displays, and cropped that way", async () => {
    // A phone stores its video sideways with a rotation flag; this marks the sample the same way.
    const rotated = join(dir, "rotated.mp4");
    execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-display_rotation", "90", "-i", sample("flat.mp4", 1280, 720, 4), "-c", "copy", rotated]);
    expect(await probe(rotated)).toMatchObject({ width: 720, height: 1280 });
    const result = await editVideo(rotated, { ...wholeVideo(4000), crop: { ratio: 4 / 5, position: 0.5 } }, async (_p, r) => r);
    expect(result.width).toBe(720);
    expect(result.height).toBe(900);
  }, 120_000);

  test("a file with no video is refused", async () => {
    const audio = join(dir, "audio.m4a");
    execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=duration=3", audio]);
    await expect(editVideo(audio, wholeVideo(3000), async () => null)).rejects.toThrow(/no video/);
  }, 60_000);
});
