import type { ReactNode } from "react";

/**
 * An answer's text, drawn without ever building HTML from it.
 *
 * Model output is untrusted, so nothing here is set as markup: fenced code
 * becomes a <pre> with its filename shown above it, citations like
 * [JOB ROT-0042] become labelled chips, and `path:line` references are set in
 * code type. Everything else is plain text with its line breaks kept.
 */

const FENCE = /```([^\n`]*)\n([\s\S]*?)```/g;
const INLINE = /(\[JOB [A-Za-z0-9]{2,8}-\d{1,6}\]|`[^`\n]+`)/g;

export function MessageText({ text }: { text: string }) {
  const parts: ReactNode[] = [];
  let last = 0;
  let i = 0;
  for (const match of text.matchAll(FENCE)) {
    const start = match.index ?? 0;
    if (start > last) parts.push(<Prose key={i++} text={text.slice(last, start)} />);
    parts.push(<CodeBlock key={i++} info={match[1]!.trim()} code={match[2]!} />);
    last = start + match[0].length;
  }
  // An unclosed fence while streaming: show it as code so far.
  const rest = text.slice(last);
  const open = rest.indexOf("```");
  if (open >= 0) {
    if (open > 0) parts.push(<Prose key={i++} text={rest.slice(0, open)} />);
    const body = rest.slice(open + 3);
    const nl = body.indexOf("\n");
    parts.push(<CodeBlock key={i++} info={nl >= 0 ? body.slice(0, nl).trim() : body} code={nl >= 0 ? body.slice(nl + 1) : ""} />);
  } else if (rest) {
    parts.push(<Prose key={i++} text={rest} />);
  }
  return <div className="space-y-3">{parts}</div>;
}

function Prose({ text }: { text: string }) {
  const pieces = text.split(INLINE);
  return (
    <p className="whitespace-pre-wrap break-words">
      {pieces.map((piece, i) => {
        if (/^\[JOB /.test(piece)) {
          return (
            <span
              key={i}
              className="mx-0.5 inline-flex items-center rounded-md border border-brand/30 bg-brand-soft px-1.5 py-0.5
                         align-baseline font-mono text-[11px] font-semibold text-brand"
              title="A 10XiD job this answer cites — listed under Sources"
            >
              {piece.slice(1, -1)}
            </span>
          );
        }
        if (piece.startsWith("`") && piece.endsWith("`") && piece.length > 2) {
          return (
            <code key={i} className="rounded bg-sunk px-1 py-0.5 font-mono text-[12px]">
              {piece.slice(1, -1)}
            </code>
          );
        }
        return piece;
      })}
    </p>
  );
}

/**
 * The info string is "lang" or "lang path/to/file.ts" or "path/to/file.ts:12-30";
 * whichever word looks like a path is shown as the filename.
 */
function CodeBlock({ info, code }: { info: string; code: string }) {
  const words = info.split(/\s+/).filter(Boolean);
  const file = words.find((w) => /[/.]/.test(w));
  const lang = words.find((w) => w !== file);
  return (
    <figure className="overflow-hidden rounded-lg border border-line bg-sunk">
      {file || lang ? (
        <figcaption className="flex items-center justify-between border-b border-line px-3 py-1.5 font-mono text-[11px] text-ink-soft">
          <span className="truncate">{file ?? ""}</span>
          <span className="text-ink-faint">{lang ?? ""}</span>
        </figcaption>
      ) : null}
      <pre className="overflow-x-auto p-3 font-mono text-[12.5px] leading-relaxed text-ink">
        <code>{code}</code>
      </pre>
    </figure>
  );
}
