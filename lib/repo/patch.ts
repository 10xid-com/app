import { createTwoFilesPatch } from "diff";
import { RepoError } from "./types";

/**
 * A proposed change, shown as a unified diff and never applied.
 *
 * Plan and Ask modes may suggest code; nothing in this milestone writes to a
 * repository. The preview is text the person reads and copies — the same
 * diff a pull request would show — produced against the exact commit the run
 * read, so it applies cleanly to what the model actually saw.
 */

export const PATCH_LIMITS = {
  maxReplacements: 20,
  maxNewContentBytes: 200_000,
  maxPatchBytes: 60_000,
} as const;

export type PatchEdit =
  | { kind: "replace"; replacements: { find: string; replace: string }[] }
  | { kind: "create"; content: string };

/**
 * Apply edits to a file's text in memory. Each `find` must occur exactly once,
 * so a replacement can never silently land in the wrong place.
 */
export function applyEdit(original: string | null, edit: PatchEdit): string {
  if (edit.kind === "create") {
    if (original !== null) throw new RepoError("That file already exists. Use replacements to change it.");
    if (Buffer.byteLength(edit.content) > PATCH_LIMITS.maxNewContentBytes) {
      throw new RepoError("The new file is too large to preview.");
    }
    return edit.content;
  }
  if (original === null) throw new RepoError("That file does not exist. Create it with new content instead.");
  if (edit.replacements.length === 0 || edit.replacements.length > PATCH_LIMITS.maxReplacements) {
    throw new RepoError(`Give between 1 and ${PATCH_LIMITS.maxReplacements} replacements.`);
  }
  let text = original;
  for (const [i, r] of edit.replacements.entries()) {
    if (!r.find) throw new RepoError(`Replacement ${i + 1} has nothing to find.`);
    const first = text.indexOf(r.find);
    if (first === -1) throw new RepoError(`Replacement ${i + 1}: the text to find is not in the file.`);
    if (text.indexOf(r.find, first + 1) !== -1) {
      throw new RepoError(`Replacement ${i + 1}: the text to find appears more than once. Include more surrounding lines.`);
    }
    text = text.slice(0, first) + r.replace + text.slice(first + r.find.length);
  }
  return text;
}

/** The unified diff between two versions of one file. */
export function unifiedDiff(path: string, before: string | null, after: string): string {
  const patch = createTwoFilesPatch(
    before === null ? "/dev/null" : `a/${path}`,
    `b/${path}`,
    before ?? "",
    after,
    undefined,
    undefined,
    { context: 3 },
  );
  // createTwoFilesPatch opens with a rule (and sometimes an "Index:" line); git does not.
  const body = patch.replace(/^(Index: .*\n)?=+\n/, "");
  if (Buffer.byteLength(body) > PATCH_LIMITS.maxPatchBytes) {
    throw new RepoError("That change is too large to preview. Propose it in smaller parts.");
  }
  return body;
}
