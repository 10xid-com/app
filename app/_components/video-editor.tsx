"use client";

import { useEffect, useRef, useState } from "react";
import {
  drawableText,
  MAX_TEXTS,
  TEXT_MAX_CHARS,
  type TextOverlay,
  type VideoEdit,
} from "@/lib/integrations/video-edit-spec";

/**
 * Editing a video in the composer: trim, shape and framing, sound, text. The
 * edits are only a description here; the server makes them with ffmpeg once
 * the video has uploaded (app/api/social/videos/[id]/edit). The preview
 * (VideoPreview) shows the same thing the server will make: only the kept
 * part plays, cropped where chosen, with the text on screen when it will be.
 */

const MIN_LENGTH_MS = 3000;

export const clock = (ms: number) => {
  const s = Math.max(0, ms) / 1000;
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(1).padStart(4, "0")}`;
};

export type VideoShape = { label: string; ratio: number | null };

const input = "rounded-lg border border-line bg-surface px-2 py-1 text-[13px] text-ink";

export function VideoEditor({
  durationMs,
  edit,
  onChange,
  shapes,
  shapeFixed,
  disabled,
}: {
  durationMs: number;
  edit: VideoEdit;
  onChange: (next: VideoEdit) => void;
  /** The shapes this video may take; omitted when the post's shape decides it (a carousel). */
  shapes: VideoShape[] | null;
  /** Whether the post's own shape crops this video (so the framing slider applies). */
  shapeFixed: boolean;
  disabled: boolean;
}) {
  const set = (patch: Partial<VideoEdit>) => onChange({ ...edit, ...patch });
  const setText = (i: number, patch: Partial<TextOverlay>) =>
    set({ texts: edit.texts.map((t, j) => (j === i ? { ...t, ...patch } : t)) });
  const length = edit.endMs - edit.startMs;
  const cropped = shapeFixed || edit.crop.ratio !== null;

  return (
    <fieldset className="grid gap-4 rounded-xl border border-line p-3 text-sm" disabled={disabled}>
      <legend className="px-1 font-medium text-ink">Edit video</legend>

      <div className="grid gap-1.5">
        <span className="text-ink-soft">
          Trim: keep {clock(edit.startMs)} to {clock(edit.endMs)} <span className="text-ink-faint">({clock(length)})</span>
        </span>
        <label className="grid grid-cols-[3rem_1fr] items-center gap-2 text-xs text-ink-faint">
          Start
          <input
            type="range"
            min={0}
            max={Math.max(0, durationMs - MIN_LENGTH_MS)}
            step={100}
            value={edit.startMs}
            onChange={(e) => {
              const startMs = Math.min(Number(e.target.value), edit.endMs - MIN_LENGTH_MS);
              set({ startMs: Math.max(0, startMs) });
            }}
            aria-label="Trim start"
          />
        </label>
        <label className="grid grid-cols-[3rem_1fr] items-center gap-2 text-xs text-ink-faint">
          End
          <input
            type="range"
            min={Math.min(durationMs, MIN_LENGTH_MS)}
            max={durationMs}
            step={100}
            value={edit.endMs}
            onChange={(e) => set({ endMs: Math.max(Number(e.target.value), edit.startMs + MIN_LENGTH_MS) })}
            aria-label="Trim end"
          />
        </label>
      </div>

      {shapes ? (
        <div className="grid gap-1.5">
          <span className="text-ink-soft">Shape</span>
          <div className="flex flex-wrap gap-1 rounded-lg bg-sunk p-0.5">
            {shapes.map((s) => {
              const on = edit.crop.ratio === s.ratio;
              return (
                <button
                  key={s.label}
                  type="button"
                  onClick={() => set({ crop: { ...edit.crop, ratio: s.ratio } })}
                  aria-pressed={on}
                  className={`rounded-md px-3 py-1 text-[13px] font-semibold ${on ? "bg-surface text-ink shadow-card" : "text-ink-soft hover:text-ink"}`}
                >
                  {s.label}
                </button>
              );
            })}
          </div>
        </div>
      ) : null}
      {cropped ? (
        <label className="grid gap-1.5">
          <span className="text-ink-soft">Framing: slide to choose what stays in the shot</span>
          <input
            type="range"
            min={0}
            max={100}
            value={Math.round(edit.crop.position * 100)}
            onChange={(e) => set({ crop: { ...edit.crop, position: Number(e.target.value) / 100 } })}
            aria-label="Framing"
          />
        </label>
      ) : null}

      <label className="flex items-center gap-2 text-ink">
        <input type="checkbox" checked={!edit.mute} onChange={(e) => set({ mute: !e.target.checked })} />
        Keep the video’s own sound
      </label>

      <div className="grid gap-2">
        <span className="text-ink-soft">Text on the video</span>
        {edit.texts.map((t, i) => (
          <div key={i} className="grid gap-2 rounded-lg bg-sunk p-2">
            <textarea
              value={t.text}
              rows={2}
              maxLength={TEXT_MAX_CHARS}
              onChange={(e) => setText(i, { text: e.target.value })}
              placeholder="Text to show"
              aria-label={`Text ${i + 1}`}
              className={input}
            />
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <select value={t.position} onChange={(e) => setText(i, { position: e.target.value as TextOverlay["position"] })} aria-label="Position" className={input}>
                <option value="top">Top</option>
                <option value="middle">Middle</option>
                <option value="bottom">Bottom</option>
              </select>
              <select value={t.style} onChange={(e) => setText(i, { style: e.target.value as TextOverlay["style"] })} aria-label="Style" className={input}>
                <option value="shadow">White, outlined</option>
                <option value="box">White on a dark box</option>
              </select>
              <button type="button" onClick={() => set({ texts: edit.texts.filter((_, j) => j !== i) })} className="ml-auto text-ink-soft hover:text-bad">
                Remove
              </button>
            </div>
            <label className="grid grid-cols-[5.5rem_1fr] items-center gap-2 text-xs text-ink-faint">
              From {clock(t.startMs)}
              <input
                type="range"
                min={edit.startMs}
                max={edit.endMs}
                step={100}
                value={Math.min(Math.max(t.startMs, edit.startMs), edit.endMs)}
                onChange={(e) => setText(i, { startMs: Math.min(Number(e.target.value), t.endMs) })}
                aria-label={`Text ${i + 1} from`}
              />
            </label>
            <label className="grid grid-cols-[5.5rem_1fr] items-center gap-2 text-xs text-ink-faint">
              To {clock(t.endMs)}
              <input
                type="range"
                min={edit.startMs}
                max={edit.endMs}
                step={100}
                value={Math.min(Math.max(t.endMs, edit.startMs), edit.endMs)}
                onChange={(e) => setText(i, { endMs: Math.max(Number(e.target.value), t.startMs) })}
                aria-label={`Text ${i + 1} to`}
              />
            </label>
          </div>
        ))}
        {edit.texts.length < MAX_TEXTS ? (
          <button
            type="button"
            onClick={() =>
              set({
                texts: [
                  ...edit.texts,
                  { text: "", position: edit.texts.length ? "top" : "bottom", style: "box", startMs: edit.startMs, endMs: edit.endMs },
                ],
              })
            }
            className="justify-self-start rounded-lg border border-line bg-surface px-3 py-1 text-[13px] font-semibold text-ink hover:bg-sunk"
          >
            + Add text
          </button>
        ) : null}
        {edit.texts.length ? <span className="text-xs text-ink-faint">Emoji are left out of text on the video; they work in the caption.</span> : null}
      </div>
    </fieldset>
  );
}

/**
 * The video as it will come out: a box of the post's shape, the video cropped
 * into it at the chosen framing (or fitted, when its own shape is kept),
 * playing only the kept part, with the text on screen when it will be.
 */
export function VideoPreview({
  url,
  width,
  height,
  edit,
  box,
  fit,
  seekMs,
}: {
  url: string;
  width: number;
  height: number;
  edit: VideoEdit;
  /** The preview's shape, width÷height. */
  box: number;
  /** cover: cropped to the box; contain: the whole video, bars around it. */
  fit: "cover" | "contain";
  /** Show this frame (the Reel's cover) when it changes. */
  seekMs?: number;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const [now, setNow] = useState(edit.startMs);

  // Wider than the box: the cut is left and right, so framing moves sideways.
  const along = width / height > box ? `${edit.crop.position * 100}% 50%` : `50% ${edit.crop.position * 100}%`;

  useEffect(() => {
    const v = video.current;
    if (v && (v.currentTime * 1000 < edit.startMs || v.currentTime * 1000 > edit.endMs)) v.currentTime = edit.startMs / 1000;
  }, [edit.startMs, edit.endMs]);

  useEffect(() => {
    if (seekMs !== undefined && video.current) video.current.currentTime = seekMs / 1000;
  }, [seekMs]);

  return (
    <div className="absolute inset-0" style={{ containerType: "size" }}>
      <video
        ref={video}
        src={url}
        muted={edit.mute}
        playsInline
        controls
        preload="metadata"
        onTimeUpdate={(e) => {
          const v = e.currentTarget;
          const t = v.currentTime * 1000;
          if (t < edit.startMs - 50 || t > edit.endMs) v.currentTime = edit.startMs / 1000;
          setNow(t);
        }}
        style={{ objectPosition: fit === "cover" ? along : undefined }}
        className={`absolute inset-0 h-full w-full ${fit === "cover" ? "object-cover" : "object-contain"}`}
      />
      {edit.texts.map((t, i) => {
        const text = drawableText(t.text);
        if (!text || now < t.startMs || now > t.endMs) return null;
        return (
          <span
            key={i}
            className={`pointer-events-none absolute inset-x-[6%] whitespace-pre-wrap text-center font-bold leading-tight text-white ${
              t.position === "top" ? "top-[8%]" : t.position === "middle" ? "top-1/2 -translate-y-1/2" : "bottom-[14%]"
            }`}
            style={{ fontSize: "6.25cqh" }}
          >
            <span
              className={t.style === "box" ? "box-decoration-clone rounded bg-black/60 px-[0.3em] py-[0.1em]" : ""}
              style={t.style === "shadow" ? { textShadow: "0 0 3px rgba(0,0,0,.8), 2px 2px 2px rgba(0,0,0,.6)" } : undefined}
            >
              {text}
            </span>
          </span>
        );
      })}
    </div>
  );
}
