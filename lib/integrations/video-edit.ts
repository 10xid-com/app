import "server-only";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drawableText, type VideoEdit } from "./video-edit-spec";

/**
 * Making a video's edits — trim, crop to a shape, mute, text — with ffmpeg on
 * the app server, and turning every video into one Instagram and Facebook
 * take without argument: MP4, H.264 (high profile, yuv420p), 30 frames a
 * second, AAC at 48kHz, at most 1080 pixels wide for a tall or square video
 * and 1920 for a wide one, the index at the front of the file. A phone's
 * HEVC or 120fps video comes out of it postable.
 *
 * ffmpeg and the DejaVu fonts are installed in the app's image by
 * railpack.json. One video is processed at a time: re-encoding is the
 * heaviest thing the app does, and two at once on one instance would slow
 * both and risk its memory.
 */

export const FONT = process.env.VIDEO_FONT_FILE ?? "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf";
const TIMEOUT_MS = 12 * 60_000;

export class VideoEditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VideoEditError";
  }
}

export type Probe = { width: number; height: number; durationMs: number; hasAudio: boolean };

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const secs = (ms: number) => (ms / 1000).toFixed(3);

/**
 * The ffmpeg arguments for one edit, from the source's size (as it displays,
 * rotation applied) and the files the overlay texts were written to. Pure, so
 * it can be read and tested without running anything.
 */
export function ffmpegArgs(input: string, output: string, probe: Probe, edit: VideoEdit, textFiles: string[]): string[] {
  const start = clamp(edit.startMs, 0, probe.durationMs);
  const end = clamp(edit.endMs, start, probe.durationMs);
  const filters: string[] = [];

  let w = probe.width;
  let h = probe.height;
  if (edit.crop.ratio) {
    const r = edit.crop.ratio;
    const pos = clamp(edit.crop.position, 0, 1);
    if (w / h > r) {
      const cw = Math.min(w, even(h * r));
      filters.push(`crop=${cw}:${h}:${Math.round((w - cw) * pos)}:0`);
      w = cw;
    } else {
      const ch = Math.min(h, even(w / r));
      filters.push(`crop=${w}:${ch}:0:${Math.round((h - ch) * pos)}`);
      h = ch;
    }
  }
  // At most 1080 wide when tall or square, 1920 when wide.
  const maxW = w / h > 1 ? 1920 : 1080;
  if (w > maxW) {
    filters.push(`scale=${maxW}:-2`);
  } else if (w % 2 || h % 2) {
    filters.push(`scale=${even(w)}:${even(h)}`);
  }
  filters.push("fps=30");

  edit.texts.forEach((t, i) => {
    const from = Math.max(0, t.startMs - start);
    const to = Math.max(from, t.endMs - start);
    const y = t.position === "top" ? "h*0.08" : t.position === "middle" ? "(h-text_h)/2" : "h*0.86-text_h";
    const look =
      t.style === "box"
        ? "box=1:boxcolor=black@0.6:boxborderw=18"
        : "borderw=3:bordercolor=black@0.55:shadowcolor=black@0.6:shadowx=2:shadowy=2";
    filters.push(
      `drawtext=fontfile='${FONT}':textfile='${textFiles[i]}':fontcolor=white:fontsize=h/16:line_spacing=10:` +
        `x=(w-text_w)/2:y=${y}:${look}:enable='between(t,${secs(from)},${secs(to)})'`,
    );
  });
  filters.push("format=yuv420p");

  return [
    "-hide_banner",
    "-nostdin",
    "-y",
    "-ss",
    secs(start),
    "-to",
    secs(end),
    "-i",
    input,
    "-map",
    "0:v:0",
    ...(edit.mute || !probe.hasAudio ? ["-an"] : ["-map", "0:a:0", "-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-ac", "2"]),
    "-vf",
    filters.join(","),
    "-c:v",
    "libx264",
    "-profile:v",
    "high",
    "-preset",
    "veryfast",
    "-crf",
    "21",
    "-maxrate",
    "20M",
    "-bufsize",
    "40M",
    "-movflags",
    "+faststart",
    output,
  ];
}

function run(cmd: string, args: string[], timeoutMs = TIMEOUT_MS): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err = (err + d).slice(-4000)));
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new VideoEditError((e as NodeJS.ErrnoException).code === "ENOENT" ? "Video editing is not installed on this server." : e.message));
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new VideoEditError(signal ? "The video took too long to process." : `The video could not be processed. ${err.trim().split("\n").pop() ?? ""}`));
    });
  });
}

/** The video's size as it displays (a phone's rotation applied), length, and whether it has sound. */
export async function probe(input: string): Promise<Probe> {
  const out = await run(
    "ffprobe",
    ["-v", "error", "-show_entries", "stream=codec_type,width,height:stream_side_data=rotation:format=duration", "-of", "json", input],
    60_000,
  );
  type Stream = { codec_type?: string; width?: number; height?: number; side_data_list?: { rotation?: number }[] };
  const data = JSON.parse(out) as { streams?: Stream[]; format?: { duration?: string } };
  const video = data.streams?.find((s) => s.codec_type === "video");
  if (!video?.width || !video.height) throw new VideoEditError("That file has no video in it.");
  const rotation = Math.abs(video.side_data_list?.find((s) => s.rotation !== undefined)?.rotation ?? 0) % 180;
  return {
    width: rotation === 90 ? video.height : video.width,
    height: rotation === 90 ? video.width : video.height,
    durationMs: Math.round(Number(data.format?.duration ?? 0) * 1000),
    hasAudio: Boolean(data.streams?.some((s) => s.codec_type === "audio")),
  };
}

let queue: Promise<unknown> = Promise.resolve();

/**
 * Make the edit: read the source (a path, or an address ffmpeg can fetch),
 * write the result to a temporary file, and hand it to `withResult` with its
 * probe. The temporary files are removed once `withResult` returns.
 */
export async function editVideo<T>(
  input: string,
  edit: VideoEdit,
  withResult: (path: string, result: Probe & { bytes: number }) => Promise<T>,
): Promise<T> {
  const job = queue.then(async () => {
    const dir = await mkdtemp(join(tmpdir(), "10xid-video-"));
    try {
      const source = await probe(input);
      const textFiles: string[] = [];
      for (const t of edit.texts) {
        const file = join(dir, `text-${randomBytes(6).toString("hex")}.txt`);
        await writeFile(file, drawableText(t.text));
        textFiles.push(file);
      }
      const output = join(dir, "out.mp4");
      await run("ffmpeg", ffmpegArgs(input, output, source, edit, textFiles));
      const result = await probe(output);
      return await withResult(output, { ...result, bytes: (await stat(output)).size });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  // The next job waits for this one, whether it worked or not.
  queue = job.catch(() => undefined);
  return job;
}
