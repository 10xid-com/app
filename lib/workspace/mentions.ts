/**
 * `@path/to/file.ts` and `@folder:path/to/dir` in a message, as context.
 *
 * Client-safe: the composer uses the same parser to show what will be added.
 * A mention must start the message or follow whitespace, so an email address
 * (name@example.com) is never taken for one. The paths are only candidates —
 * the runner checks each against the repository's policy and tree.
 */

export type Mention = { kind: "file" | "folder"; path: string };

const MAX_MENTIONS = 10;
const MENTION = /(?:^|\s)@(folder:)?([A-Za-z0-9_.\-][A-Za-z0-9_.\-/]*)/g;

export function parseMentions(text: string): Mention[] {
  const out: Mention[] = [];
  for (const m of text.matchAll(MENTION)) {
    const folder = Boolean(m[1]);
    // Trailing punctuation belongs to the sentence, not the path.
    const path = m[2]!.replace(/[.\-]+$/, "").replace(/\/+$/, "");
    if (!folder && !/[./]/.test(path)) continue; // "@alex" is a person, not a file
    if (!path && !folder) continue;
    if (out.some((x) => x.path === path && x.kind === (folder ? "folder" : "file"))) continue;
    out.push({ kind: folder ? "folder" : "file", path });
    if (out.length >= MAX_MENTIONS) break;
  }
  return out;
}
