// Emulated-iPhone evidence for app#41 — "Add new product" beside Inventory in
// the top bar, and the unsaved-item note — on a local production build of the
// branch head (SMOKE_APP_COMMIT). Chromium with Playwright's devices["iPhone 13"]
// (390x664 CSS px, DPR 3, touch, iOS Safari user agent), and the same descriptor
// narrowed to 375x548, 360x640 and 320x480. DESKTOP EMULATION, not Safari on an
// iPhone: no real iOS keyboard, toolbar or safe area. Scrolling is a synthesized
// finger drag (CDP Input.dispatchTouchEvent) over main. The owner, the
// business and every photo are synthetic; the database is disposable.
//
// Writes $SMOKE_OUT/results.json, $SMOKE_OUT/README.md and $SMOKE_OUT/screens/*.png.
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
const require = createRequire("/home/claude/10xid-com/app/package.json");
const { chromium, devices } = require("playwright-core");
const { Client } = require("pg");

const DIR = "/home/claude/app-login-snapshot/smoke";
const OUT = process.env.SMOKE_OUT ?? `${DIR}/artifacts-addnew`;
mkdirSync(`${OUT}/screens`, { recursive: true });
const env = Object.fromEntries(readFileSync(`${DIR}/session.env`, "utf8").trim().split("\n").map((l) => l.split(/=(.*)/s).slice(0, 2)));
const BASE = "http://localhost:3005";
const PHOTOS = ["k-1.jpg", "k-2.jpg", "k-3.jpg"].map((f) => `${DIR}/${f}`);

const results = [];
function check(id, name, ok, detail = "") {
  results.push({ id, name, ok: !!ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${id}  ${name}${detail ? `  — ${detail}` : ""}`);
}
const shots = [];
async function shot(page, name, caption) {
  const file = `screens/${name}.png`;
  await page.screenshot({ path: `${OUT}/${file}`, scale: "css" });
  shots.push({ file, caption, width: page.viewportSize().width });
}

const db = new Client({ connectionString: "postgresql://ci_owner:ci-owner-local-only@127.0.0.1:5433/portal_ci" });
await db.connect();
const captures = async () => (await db.query("select count(*)::int as n from inventory_captures")).rows[0].n;
const captureRow = async (id) => (await db.query("select status, container_id from inventory_captures where id = $1", [id])).rows[0] ?? null;

const consoleErrors = [];
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", args: ["--no-proxy-server"] });
const browserVersion = browser.version();
async function phone(label, size) {
  const d = devices["iPhone 13"];
  const viewport = size ?? d.viewport;
  const context = await browser.newContext({ ...d, viewport, screen: { width: viewport.width, height: viewport.height + 180 }, baseURL: BASE });
  await context.addCookies([{ name: "portal_session", value: env.TOKEN, domain: "localhost", path: "/", httpOnly: true }]);
  const page = await context.newPage();
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(`${label}: ${m.text()}`);
  });
  page.on("pageerror", (e) => consoleErrors.push(`${label}: ${String(e)}`));
  return { context, page };
}

/** Where everything in the top bar is, and whether anything overflows. */
const header = (page) =>
  page.evaluate(() => {
    const main = document.querySelector("main");
    const bar = main.parentElement.firstElementChild;
    const box = (el) => {
      const r = el.getBoundingClientRect();
      return { left: +r.left.toFixed(1), right: +r.right.toFixed(1), top: +r.top.toFixed(1), bottom: +r.bottom.toFixed(1) };
    };
    const shown = (el) => !!el && getComputedStyle(el).display !== "none" && el.getBoundingClientRect().width > 0;
    const toggle = bar.querySelector('button[aria-label="Show navigation"]');
    const mark = bar.querySelector("img");
    const title = bar.querySelector("p span.truncate");
    const action = [...bar.querySelectorAll("a")].find((a) => a.textContent.trim() === "Add new product") ?? null;
    const preview = bar.querySelector('a[href="/channels/id"]');
    return {
      width: window.innerWidth,
      bar: box(bar),
      barOverflow: bar.scrollWidth - bar.clientWidth,
      pageOverflow: document.documentElement.scrollWidth - window.innerWidth,
      toggle: shown(toggle) ? box(toggle) : null,
      mark: shown(mark) ? box(mark) : null,
      title: title ? box(title) : null,
      titleText: title?.textContent ?? null,
      titleCut: title ? title.scrollWidth > title.clientWidth : null,
      action: shown(action) ? box(action) : null,
      actionHref: action?.getAttribute("href") ?? null,
      preview: shown(preview) ? box(preview) : null,
      previewLabelShown: preview ? getComputedStyle(preview.querySelector("span")).position !== "absolute" : null,
      viewportMeta: document.querySelector('meta[name="viewport"]')?.getAttribute("content") ?? null,
    };
  });

function headerProblems(m) {
  const p = [];
  if (!m.toggle) p.push("no Show navigation");
  if (!m.action) p.push("no Add new product");
  if (m.titleText !== "Inventory") p.push(`title is "${m.titleText}"`);
  if (m.titleCut) p.push("title cut off");
  if (m.action && m.title) {
    const gap = m.action.left - m.title.right;
    if (gap < 0 || gap > 12) p.push(`${gap.toFixed(1)}px between the title and the action`);
    const mid = (r) => (r.top + r.bottom) / 2;
    if (Math.abs(mid(m.action) - mid(m.title)) > 2) p.push("action not on the title's line");
  }
  for (const [k, r] of Object.entries({ toggle: m.toggle, mark: m.mark, action: m.action, preview: m.preview })) {
    if (r && (r.left < 0 || r.right > m.width)) p.push(`${k} runs off the screen`);
  }
  if (m.barOverflow > 0) p.push(`top bar overflows by ${m.barOverflow}px`);
  if (m.pageOverflow > 0) p.push(`page scrolls sideways by ${m.pageOverflow}px`);
  return p;
}
const layout = (m) =>
  `title ${m.title?.left}–${m.title?.right}, Add new product ${m.action?.left}–${m.action?.right} ` +
  `(${m.action && m.title ? (m.action.left - m.title.right).toFixed(0) : "?"}px after the title), ` +
  `Preview iD ${m.preview ? `${m.preview.left}–${m.preview.right}, ${m.previewLabelShown ? "with its label" : "icon only"}` : "not in the bar"}, ` +
  `mark ${m.mark ? "shown" : "hidden"}, overflow ${m.barOverflow}/${m.pageOverflow}`;
const headerCheck = (id, where, m) => {
  const problems = headerProblems(m);
  check(id, `${m.width} px, ${where}: Add new product immediately right of Inventory, one line, nothing cut off or off the screen`, problems.length === 0, problems.join("; ") || layout(m));
};

/** A finger dragged up or down over main (CDP touch events), repeated until main stops moving. */
async function swipe(page, direction) {
  const cdp = await page.context().newCDPSession(page);
  const box = await page.locator("main").boundingBox();
  const x = Math.round(box.x + box.width / 2);
  const from = Math.round(box.y + box.height * (direction === "down" ? 0.7 : 0.3));
  const step = (direction === "down" ? -1 : 1) * 30;
  for (let i = 0; i < 25; i++) {
    const before = await page.evaluate(() => document.querySelector("main").scrollTop);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y: from }] });
    for (let k = 1; k <= 8; k++) {
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: from + k * step }] });
      await page.waitForTimeout(16);
    }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await page.waitForTimeout(450);
    const after = await page.evaluate(() => document.querySelector("main").scrollTop);
    if (Math.abs(after - before) < 1) break;
  }
  await cdp.detach();
  await page.waitForTimeout(250);
}
const scroll = (page) =>
  page.evaluate(() => {
    const main = document.querySelector("main");
    const bar = main.parentElement.firstElementChild;
    return {
      barTop: bar.getBoundingClientRect().top,
      mainTop: Math.round(main.getBoundingClientRect().top),
      scrollTop: Math.round(main.scrollTop),
      max: main.scrollHeight - main.clientHeight,
      pageScroll: document.scrollingElement.scrollTop,
      frameScroll: main.parentElement.parentElement.scrollTop,
    };
  });
const pinned = (s, end) => s.barTop === 0 && s.pageScroll === 0 && s.frameScroll === 0 && s.mainTop === 56 && (end === "top" ? s.scrollTop === 0 : s.scrollTop >= s.max - 2);
const at = (s) => `bar top ${s.barTop}px, main from ${s.mainTop}px scrolled ${s.scrollTop}/${s.max}px, frame scrolled ${s.frameScroll}px, page scrolled ${s.pageScroll}px`;

/** The note, the buttons around it, and the form, as they are after a tap on Add new product. */
const noteState = (page) =>
  page.evaluate(() => {
    const note = document.getElementById("finish-this-item");
    const main = document.querySelector("main");
    const bar = main.parentElement.firstElementChild;
    const button = (text) => [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === text);
    const m = main.getBoundingClientRect();
    const inView = (el) => {
      const r = el.getBoundingClientRect();
      return r.height > 0 && r.top >= m.top - 1 && r.bottom <= m.bottom + 1;
    };
    return {
      path: location.pathname,
      hash: location.hash,
      shown: getComputedStyle(note).display !== "none",
      focused: document.activeElement === note,
      inView: inView(note),
      barOnScreen: bar.getBoundingClientRect().top === 0,
      belowBar: note.getBoundingClientRect().top >= bar.getBoundingClientRect().bottom,
      nextInView: inView(button("Save and add another")),
      discardInView: inView(button("Discard this item")),
      name: document.getElementById("productName")?.value ?? null,
      photos: document.querySelectorAll('section[aria-labelledby="photos-heading"] img[src^="/api/inventory/documents/"]').length,
      text: note.innerText.replace(/\s+/g, " ").trim(),
    };
  });

const ITEM = "Synthetic cacao powder (test)";

/* ------------------------------------------------------------------ */
/* 390 px                                                              */
/* ------------------------------------------------------------------ */
const { context: c390, page } = await phone("390");
await page.goto("/inventory");
let m = await header(page);
headerCheck("H1", "inventory list", m);
check("H2", "390 px: Preview iD keeps its icon, and its name for screen readers", m.preview && m.previewLabelShown === false && (await page.getByRole("link", { name: "Preview iD" }).isVisible()), layout(m));
check("H3", "The page asks for no full-bleed layout: Safari keeps it inside the safe area", m.viewportMeta === "width=device-width, initial-scale=1", `viewport meta "${m.viewportMeta}"`);
await shot(page, "390-list-empty", "390 px · Inventory, nothing catalogued yet: Add new product right of Inventory; Preview iD as its icon");

// From the list: the start page, which only reads.
const before = await captures();
await page.getByRole("link", { name: "Add new product" }).tap();
await page.waitForURL("**/inventory/capture");
for (let i = 0; i < 3; i++) await page.getByRole("link", { name: "Add new product" }).tap();
await page.waitForTimeout(1200);
const viaGet = await page.request.get("/inventory/capture");
check(
  "S1",
  "From the list, Add new product opens the start page; 4 taps and a plain GET make no item",
  page.url().endsWith("/inventory/capture") && (await captures()) === before && viaGet.status() === 200,
  `items ${before} before, ${await captures()} after; GET /inventory/capture ${viaGet.status()}`,
);
headerCheck("H4", "start page", await header(page));
await shot(page, "390-start-page", "390 px · Add new product from the list: the existing start page (Start, and items started and not saved)");

await page.getByRole("button", { name: "Start" }).tap();
await page.waitForURL(/\/inventory\/capture\/[0-9a-f-]{36}$/);
const c1 = new URL(page.url()).pathname.split("/").pop();
check("S2", "Start (the existing button) makes one item and opens its camera", (await captures()) === before + 1 && (await captureRow(c1))?.status === "open");

// A long item: three photos, a name, More details open.
await page.locator("input[type=file][multiple]").setInputFiles(PHOTOS);
await page.waitForFunction(() => document.querySelectorAll('section[aria-labelledby="photos-heading"] img[src^="/api/inventory/documents/"]').length === 3, null, { timeout: 60_000 });
await page.waitForFunction(() => [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Save")?.disabled === false, null, { timeout: 60_000 });
await page.fill("#productName", ITEM);
await page.fill("#brand", "Synthetic Co.");
await page.getByText("More details", { exact: true }).tap();
await page.fill("#lotCode", "SYN-0001");
headerCheck("H5", "item being catalogued", (m = await header(page)));
check("H6", "On an unsaved item, Add new product is the jump to the note on the same page", m.actionHref === "#finish-this-item", `href ${m.actionHref}`);

await swipe(page, "up");
let s = await scroll(page);
check("P1", "390 px, long item page at the top: bar at the top, main below it", pinned(s, "top"), at(s));
await shot(page, "390-capture-top", "390 px · An item being catalogued, top: three synthetic photos sent, name typed");
await swipe(page, "down");
s = await scroll(page);
check("P2", "Swiped to the bottom: only main scrolled; the bar is still at the top", pinned(s, "bottom") && s.max > 600, at(s));
await shot(page, "390-capture-bottom", "390 px · Same item, bottom: Save and add another, Save, Discard; the bar is still at the top");

// The guard: Add new product on an unsaved item, from the top of the page.
await swipe(page, "up");
const itemsBefore = await captures();
await page.getByRole("link", { name: "Add new product" }).tap();
await page.waitForTimeout(600);
let note = await noteState(page);
check(
  "U1",
  "Unsaved item, Add new product from the top of the page: same page, scrolled to the note above Save and add another",
  note.path === `/inventory/capture/${c1}` && note.hash === "#finish-this-item" && note.shown && note.inView && note.nextInView && note.discardInView,
  `${note.path}${note.hash}; note shown ${note.shown}, in view ${note.inView}; Save and add another in view ${note.nextInView}; Discard in view ${note.discardInView}`,
);
check("U2", "The note has focus (read out by a screen reader); the bar stays on screen, above it", note.focused && note.barOnScreen && note.belowBar, `focused ${note.focused}, bar on screen ${note.barOnScreen}, note below the bar ${note.belowBar}`);
check(
  "U3",
  "Nothing lost or started: typed name, 3 photos and the open item as they were; no new item",
  note.name === ITEM && note.photos === 3 && (await captures()) === itemsBefore && (await captureRow(c1))?.status === "open",
  `name "${note.name}", photos ${note.photos}, items ${await captures()} (was ${itemsBefore})`,
);
check("U4", "The note says to finish it with Save and add another, or discard it", /Save and add another/.test(note.text) && /discard this item/i.test(note.text), note.text);
s = await scroll(page);
check("P3", "After the jump the bar is still at the top: only main moved", s.barTop === 0 && s.pageScroll === 0 && s.frameScroll === 0 && s.mainTop === 56, at(s));
await shot(page, "390-capture-note", "390 px · Add new product on an unsaved item: the page stays, the note says to finish it or discard it");
for (let i = 0; i < 2; i++) await page.getByRole("link", { name: "Add new product" }).tap();
await page.waitForTimeout(500);
note = await noteState(page);
check("U5", "Tapped twice more: still the same item and form, still no new item", note.path === `/inventory/capture/${c1}` && note.name === ITEM && note.inView && (await captures()) === itemsBefore);

// A field near the end gets focus: it comes into view inside main, below the bar.
await swipe(page, "up");
await page.locator("#notes").focus();
await page.waitForTimeout(300);
const f = await page.evaluate(() => {
  const main = document.querySelector("main");
  const bar = main.parentElement.firstElementChild;
  const r = document.getElementById("notes").getBoundingClientRect();
  return { top: Math.round(r.top), bottom: Math.round(r.bottom), barBottom: bar.getBoundingClientRect().bottom, mainBottom: Math.round(main.getBoundingClientRect().bottom), active: document.activeElement?.id };
});
check("F1", "Notes (near the end) focused from the top: scrolled into view in main, below the bar", f.active === "notes" && f.top >= f.barBottom && f.bottom <= f.mainBottom, JSON.stringify(f));
await page.locator("#notes").blur();

// Save and add another, as before.
await page.getByText("Sealed", { exact: true }).tap();
await page.getByRole("button", { name: "Save and add another" }).tap();
await page.waitForURL(/\/inventory\/capture\/[0-9a-f-]{36}\?saved=/);
const c2 = new URL(page.url()).pathname.split("/").pop();
const container = (await captureRow(c1))?.container_id;
check(
  "N1",
  "Save and add another still saves, and opens the next item saying what was saved",
  (await captureRow(c1))?.status === "confirmed" && c2 !== c1 && (await page.getByText("Now the next one.").isVisible()) && (await captures()) === itemsBefore + 1,
  `item 1 ${(await captureRow(c1))?.status}; next item ${(await captureRow(c2))?.status}`,
);
check("N2", "The next item arrives with the note hidden", !(await page.locator("#finish-this-item").isVisible()));
await shot(page, "390-next-item", "390 px · After Save and add another: the next item, “Saved: … Now the next one.”");

// The other way the note gives: discard, then start over.
await page.getByRole("link", { name: "Add new product" }).tap();
await page.waitForTimeout(500);
check("U6", "On the next item (still empty) Add new product shows the note too, and starts nothing", (await page.locator("#finish-this-item").isVisible()) && (await captures()) === itemsBefore + 1);
await page.getByRole("button", { name: "Discard this item" }).tap();
await page.waitForURL("**/inventory");
check("U7", "Discard this item discards it and returns to the list", (await captureRow(c2))?.status === "abandoned");
headerCheck("H7", "list with an item", await header(page));
await shot(page, "390-list", "390 px · Inventory with the saved item");

// A saved item's page starts the usual way.
await page.goto(`/inventory/capture/${c1}`);
m = await header(page);
check("H8", "A saved item's page: Add new product goes to the start page", m.actionHref === "/inventory/capture", `href ${m.actionHref}`);

// The container page: long, the bar pinned, the menu from the bottom, starting from it.
await page.goto("/inventory");
await page.getByRole("link", { name: new RegExp(ITEM.replace(/[()]/g, "\\$&")) }).tap();
await page.waitForURL(/\/inventory\/containers\/[0-9a-f-]{36}/);
const containerUrl = new URL(page.url()).pathname;
headerCheck("H9", "container page", await header(page));
s = await scroll(page);
check("P4", "390 px, container page at the top: bar at the top", pinned(s, "top"), at(s));
await shot(page, "390-container-top", "390 px · A container's page, top");
await swipe(page, "down");
s = await scroll(page);
check("P5", "Swiped to the bottom of the container page: the bar is still at the top", pinned(s, "bottom") && s.max > 600, at(s));
await shot(page, "390-container-bottom", "390 px · Same page, bottom (History); the bar is still at the top");
await page.getByRole("button", { name: "Show navigation" }).tap();
const nav = page.getByRole("complementary", { name: "Navigation" });
await nav.waitFor({ state: "visible" });
const navLinks = (await nav.getByRole("link").allTextContents()).map((t) => t.trim());
check("M1", "From the bottom of the page the menu opens, with Inventory and iD", navLinks.includes("Inventory") && navLinks.includes("iD"), navLinks.join(", "));
await shot(page, "390-menu", "390 px · The menu, opened from the bottom of the container page");
await page.getByRole("button", { name: "Hide navigation" }).tap();
await nav.waitFor({ state: "hidden" });
const n0 = await captures();
await page.getByRole("link", { name: "Add new product" }).tap();
await page.waitForURL("**/inventory/capture");
check("S3", "From the bottom of a container page, Add new product opens the start page; no item made", (await captures()) === n0, `items ${n0} → ${await captures()}`);
await c390.close();

/* ------------------------------------------------------------------ */
/* Narrower                                                            */
/* ------------------------------------------------------------------ */
for (const size of [
  { width: 375, height: 548 },
  { width: 360, height: 640 },
  { width: 320, height: 480 },
]) {
  const w = size.width;
  const { context, page: p } = await phone(String(w), size);
  await p.goto("/inventory");
  const lm = await header(p);
  headerCheck(`W${w}a`, "inventory list", lm);
  if (w < 360) {
    check(`W${w}b`, `${w} px: Preview iD leaves the bar, and iD is in the menu`, lm.preview === null && (await p.locator('aside[aria-label="Navigation"] a[href="/channels/id"]').count()) === 1, layout(lm));
  } else {
    check(`W${w}b`, `${w} px: Preview iD as its icon`, lm.preview !== null && lm.previewLabelShown === false, layout(lm));
  }
  await shot(p, `${w}-list`, `${w} px · Inventory`);
  await p.goto(containerUrl);
  headerCheck(`W${w}c`, "container page", await header(p));
  if (w === 320) {
    await shot(p, `${w}-container-top`, `${w} px · A container's page, top`);
    await swipe(p, "down");
    const ss = await scroll(p);
    check(`W${w}d`, `${w} px, container page swiped to the bottom: the bar is still at the top`, pinned(ss, "bottom"), at(ss));
    await shot(p, `${w}-container-bottom`, `${w} px · Same page, bottom`);
    // An unsaved item at 320: start one, type, then Add new product.
    await p.goto("/inventory/capture");
    await p.getByRole("button", { name: "Start" }).tap();
    await p.waitForURL(/\/inventory\/capture\/[0-9a-f-]{36}$/);
    const c3 = new URL(p.url()).pathname.split("/").pop();
    await p.fill("#productName", "Synthetic matcha (test)");
    headerCheck(`W${w}e`, "item being catalogued", await header(p));
    const n3 = await captures();
    await p.getByRole("link", { name: "Add new product" }).tap();
    await p.waitForTimeout(600);
    const ns = await noteState(p);
    check(
      `W${w}f`,
      `${w} px, unsaved item: Add new product stays, the note is in view with Save and add another, the name is kept`,
      ns.path === `/inventory/capture/${c3}` && ns.shown && ns.inView && ns.nextInView && ns.barOnScreen && ns.name === "Synthetic matcha (test)" && (await captures()) === n3,
      `note in view ${ns.inView}, Save and add another in view ${ns.nextInView}, bar on screen ${ns.barOnScreen}, name "${ns.name}"`,
    );
    await shot(p, `${w}-capture-note`, `${w} px · Add new product on an unsaved item`);
  } else {
    await shot(p, `${w}-container-top`, `${w} px · A container's page, top`);
  }
  await context.close();
}

/* ------------------------------------------------------------------ */
/* Resuming, and the run                                               */
/* ------------------------------------------------------------------ */
{
  const { context, page: p } = await phone("390-end");
  await p.goto("/inventory/capture");
  const started = await p.getByText(/Item started/).count();
  check("R1", "The start page lists the item left unsaved at 320 px, to carry on with", started === 1, `${started} listed`);
  await shot(p, "390-start-page-resume", "390 px · The start page lists the item left unsaved, to carry on with");
  await context.close();
}
const total = await captures();
check("X1", "Items in the database: only the 3 started with Start or Save and add another (none from Add new product)", total === 3, `${total} items`);
check("X2", "No errors in the browser console", consoleErrors.length === 0, consoleErrors.slice(0, 5).join(" | "));

await browser.close();
await db.end();

/* ------------------------------------------------------------------ */
/* Report                                                              */
/* ------------------------------------------------------------------ */
const passed = results.filter((r) => r.ok).length;
const meta = {
  app: process.env.SMOKE_APP_COMMIT ?? "?",
  build: process.env.SMOKE_BUILD_ID ?? "?",
  database: process.env.SMOKE_DB_NOTE ?? "?",
  browser: `Chromium ${browserVersion}`,
  when: new Date().toISOString(),
};
writeFileSync(`${OUT}/results.json`, JSON.stringify({ meta, passed, total: results.length, results, shots, consoleErrors }, null, 2));
const esc = (t) => String(t).replace(/\|/g, "\\|").replace(/\n/g, " ");
const md = [
  `# app#41 · Add new product in the top bar — emulated iPhone evidence`,
  ``,
  `**${passed}/${results.length} checks passed** · app \`${meta.app.slice(0, 7)}\` (production build \`${meta.build}\`, \`next build --webpack\`) · ${meta.when}`,
  ``,
  `- Browser: ${meta.browser} (Playwright \`devices["iPhone 13"]\`: 390×664 CSS px, DPR 3, touch, iOS Safari user agent), and the same descriptor at 375×548, 360×640 and 320×480. **Desktop emulation, not Safari on an iPhone**: no real iOS keyboard, toolbar or safe area.`,
  `- Scrolling: a finger dragged over \`main\` (CDP \`Input.dispatchTouchEvent\`), repeated until it stops moving.`,
  `- Database: ${meta.database}. Media store and label reader are local stand-ins. Owner, business and photos are synthetic.`,
  ``,
  `| | Check | Detail |`,
  `|---|---|---|`,
  ...results.map((r) => `| ${r.ok ? "✅" : "❌"} ${r.id} | ${esc(r.name)} | ${esc(r.detail)} |`),
  ``,
  `## Screens`,
  ``,
  ...shots.map((s) => `**${esc(s.caption)}**<br><img src="${s.file}" width="${Math.min(s.width, 390)}">\n`),
].join("\n");
writeFileSync(`${OUT}/README.md`, md);
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
