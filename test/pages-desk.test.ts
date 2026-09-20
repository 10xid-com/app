import { readdirSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, test } from "vitest";
import { PAGES, GROUPS } from "@/lib/pages";

/**
 * The pages desk has to still be true tomorrow.
 *
 * A hand-maintained inventory of anything is wrong within a month — somebody
 * adds a screen and does not think to add the row, or deletes one and leaves
 * it. A desk that lists pages which no longer exist is worse than no desk,
 * because it is believed.
 *
 * So the inventory is not trusted here; it is checked against app/ itself. If
 * these two disagree, the suite fails and whoever added the page is told
 * exactly which row to write, while the change is still in front of them.
 */

const APP = join(import.meta.dirname, "..", "app");

/**
 * Walk app/ and turn every page.tsx and route.ts into the URL it serves.
 *
 * Next's rules are more involved than this — route groups `(name)` vanish from
 * the path, `@slot` folders are parallel routes, `_private` folders serve
 * nothing — and none of them are used in this app today. They are handled
 * anyway rather than ignored, because the day somebody does add a route group
 * the failure mode of ignoring them is this test inventing a URL that does not
 * exist and demanding a row for it.
 */
function routesOnDisk(dir = APP): string[] {
  const found: string[] = [];

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);

    if (entry.isDirectory()) {
      if (entry.name.startsWith("_")) continue;
      found.push(...routesOnDisk(full));
      continue;
    }

    if (entry.name !== "page.tsx" && entry.name !== "route.ts") continue;

    const segments = relative(APP, dir)
      .split(/[\\/]/)
      .filter(Boolean)
      .filter((s) => !(s.startsWith("(") && s.endsWith(")")))
      .filter((s) => !s.startsWith("@"));

    found.push("/" + segments.join("/"));
  }

  return found.map((p) => (p === "/" ? "/" : p.replace(/\/$/, "")));
}

describe("the desk matches what is actually deployed", () => {
  const onDisk = routesOnDisk().sort();
  const listed = PAGES.map((p) => p.path).sort();

  test("every page on disk has a row on the desk", () => {
    const missing = onDisk.filter((p) => !listed.includes(p));
    expect(
      missing,
      `These routes exist in app/ but nothing lists them. Add a row to ` +
        `lib/pages.ts, giving each one an iD that has never been used before.`,
    ).toEqual([]);
  });

  test("every row on the desk is a page that exists", () => {
    const phantom = listed.filter((p) => !onDisk.includes(p));
    expect(
      phantom,
      `lib/pages.ts lists these, but there is no such route in app/. If the ` +
        `page was deleted, remove the row — but never hand its iD to anything else.`,
    ).toEqual([]);
  });

  test("the file named in each row is the file that is there", () => {
    const wrong = PAGES.filter(
      (p) => !existsSync(join(import.meta.dirname, "..", p.file)),
    ).map((p) => `${p.id} -> ${p.file}`);
    expect(wrong).toEqual([]);
  });
});

describe("an iD is an iD", () => {
  test("no two pages share one", () => {
    const seen = new Map<string, string>();
    const clashes: string[] = [];
    for (const p of PAGES) {
      const already = seen.get(p.id);
      if (already) clashes.push(`${p.id}: ${already} and ${p.path}`);
      seen.set(p.id, p.path);
    }
    expect(clashes).toEqual([]);
  });

  test("they are lowercase, and safe to put in a URL or type down the phone", () => {
    const bad = PAGES.filter((p) => !/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(p.id)).map(
      (p) => p.id,
    );
    expect(bad).toEqual([]);
  });

  test("an iD is never the path, because then it would move when the path did", () => {
    // Not a style rule. `/dashboard` is expected to become `/desk`; an iD that
    // was literally "/dashboard" would have to change with it, which is the one
    // thing an iD must not do.
    const pathish = PAGES.filter((p) => p.id.startsWith("/")).map((p) => p.id);
    expect(pathish).toEqual([]);
  });
});

describe("every row is legible", () => {
  test("each one has a name, a purpose and a group we render", () => {
    for (const p of PAGES) {
      expect(p.name.length, `${p.id} has no name`).toBeGreaterThan(0);
      expect(p.purpose.length, `${p.id} has no purpose`).toBeGreaterThan(20);
      expect(GROUPS, `${p.id} sits under a heading the desk does not draw`).toContain(
        p.group,
      );
    }
  });

  test("machinery says which methods it answers", () => {
    const silent = PAGES.filter(
      (p) => p.kind === "machinery" && p.path.startsWith("/api") && !p.methods?.length,
    ).map((p) => p.id);
    expect(silent).toEqual([]);
  });
});
