// End-to-end test of the built-in copy editor + blog engine via headless Chrome + CDP.
// Run:  node tools/e2e/e2e_test.mjs   (from anywhere; paths self-locate)
// Requires: node 22+ (native WebSocket/fetch), Chrome, py launcher (http.server).
// The harness starts its own local server and Chrome, and cleans both up.
import { spawn } from "node:child_process";
import { readFileSync, mkdtempSync, writeFileSync, copyFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SERVER_PORT = 8123;
const PAGE = `http://127.0.0.1:${SERVER_PORT}/index.html`;
const BLOGPAGE = `http://127.0.0.1:${SERVER_PORT}/blog.html`;
const CHROME = "c:/Program Files/Google/Chrome/Application/chrome.exe";
const DEBUG_PORT = 9225;

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail: detail || "" });
  console.log((ok ? "PASS" : "FAIL") + "  " + name + (detail ? "  [" + detail + "]" : ""));
}

// self-contained: serve the repo ourselves for the duration of the run
// The suite serves a COPY of the repo, not the repo, so the blog page can be
// emptied without touching the site. Everything else is linked through.
const SERVE = mkdtempSync(join(tmpdir(), "ced-serve-"));
for (const f of ["index.html", "gallery.html", "site.css", "site.js", "work.js",
                 "blog.js", "markdown.js", "gallery.js", "tool.js", "publish.js",
                 "aaron-portfolio-portrait-transparent.png"]) {
  try { copyFileSync(join(REPO, f), join(SERVE, f)); } catch {}
}
writeFileSync(join(SERVE, "blog.html"),
  emptyBlogPage(readFileSync(join(REPO, "blog.html"), "utf-8")));
for (const d of ["img", "tools"]) {
  try { cpSync(join(REPO, d), join(SERVE, d), { recursive: true }); } catch {}
}
const server = spawn("py", ["-3", "-m", "http.server", String(SERVER_PORT), "--bind", "127.0.0.1"],
  { cwd: SERVE, stdio: "ignore" });
await new Promise((r) => setTimeout(r, 1500));

const profile = mkdtempSync(join(tmpdir(), "ced-e2e-"));
const chrome = spawn(CHROME, [
  "--headless=new", "--disable-gpu", "--no-first-run", "--mute-audio",
  "--remote-debugging-port=" + DEBUG_PORT,
  "--user-data-dir=" + profile,
  PAGE,
], { stdio: "ignore" });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// minimal STORE-zip reader: buffer -> { name: Buffer }
function unzipStore(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const out = {};
  let off = 0;
  while (off + 4 <= buf.length && dv.getUint32(off, true) === 0x04034b50) {
    const size = dv.getUint32(off + 22, true);
    const nameLen = dv.getUint16(off + 26, true);
    const extraLen = dv.getUint16(off + 28, true);
    const name = buf.slice(off + 30, off + 30 + nameLen).toString("utf8");
    const start = off + 30 + nameLen + extraLen;
    out[name] = buf.slice(start, start + size);
    off = start + size;
  }
  return out;
}

// page-side patch: capture the next download's bytes as base64 in window.__zipB64
const ZIP_CAPTURE = `
  window.__zipB64 = null;
  HTMLAnchorElement.prototype.click = function () {
    if (!this.download) return;
    fetch(this.href).then(r => r.blob()).then(b => new Promise(res => {
      var fr = new FileReader();
      fr.onload = () => res(fr.result.split(',')[1]);
      fr.readAsDataURL(b);
    })).then(b64 => { window.__zipB64 = b64; });
  };`;

// The search index, read out of the file a publish wrote. Since V057 the
// file is one assignment holding readable JSON, so the table is the object
// in it and there is nothing to decompress.
function searchTable(fileText) {
  const t = String(fileText);
  const open = t.indexOf("{"), close = t.lastIndexOf("}");
  if (open < 0 || close < open) return { error: "no table in search.js" };
  try { return JSON.parse(t.slice(open, close + 1)); }
  catch (e) { return { error: e.message }; }
}
// A run of base64 long enough to be a payload rather than a word. A
// thumbnail is a data: URI and is base64 by its nature, so it is taken out
// first: what must not be in the file is a payload, which is what made a
// scanner call the old packed index a dangerous file.
function hasBase64Blob(text) {
  const withoutThumbs = String(text)
    .replace(/data:[a-z/+.-]+;base64,[A-Za-z0-9+/=]+/g, "");
  return /[A-Za-z0-9+/]{60,}={0,2}/.test(withoutThumbs);
}

// remove the CONTENT of the named regions from a source string, so two files
// can be compared for byte-identity everywhere outside those regions.
// note: a slug whose span nests other markers (deepdive) covers them too.
function stripSpans(txt, slugs) {
  let out = txt;
  for (const s of slugs) {
    const open = `<!--[edit:${s}]-->`, close = `<!--[/edit:${s}]-->`;
    const a = out.indexOf(open);
    const b = out.indexOf(close, a);
    if (a < 0 || b < 0) return null;
    out = out.slice(0, a + open.length) + out.slice(b);
  }
  return out;
}


// ============ THE CONTRACT ============
// What the file split must not break. index.html is one file today. Parts 2
// and 3 move its style and its script out, and Phases 3 and 4 add two more
// pages. Each of those steps can break a fact below with no visible symptom,
// so each fact is pinned here while the monofile is still whole and green.

// Every page the editor and the publish engine manage. Order matches
// MANAGED_PAGES in tool.js, which is the list the site is generated from.
const MANAGED_PAGES = ["index.html", "gallery.html", "blog.html"];

// The exact marked regions of each page, in the order the open markers appear
// in the source. A part that adds, removes or renames a region must edit this
// list on purpose, which is the point of listing them.
const EXPECTED_REGIONS = {
  "index.html": [
    "brand-title", "brand-sub", "nav-work", "nav-gallery", "nav-blog",
    "nav-about", "nav-contact",
    "hero-eyebrow", "hero-h1", "hero-sub", "hero-note", "hero-cta-work",
    "hero-cta-contact", "work-eyebrow", "work-h2", "work-intro",
    "fr3-gallery", "fr3-title", "fr3-meta", "fr3-lead", "fr3-desc",
    "fr3-stats", "fr3-spec-role", "fr3-spec-stack", "fr3-more",
    "fr3-deepdive", "fr3-dd-gallery", "fr2-gallery", "fr2-title",
    "fr2-meta", "fr2-lead", "fr2-desc", "fr2-stats", "fr2-spec-role",
    "fr2-spec-stack", "fr2-more", "fr2-deepdive", "fr2-dd-gallery",
    "phl-gallery", "phl-title", "phl-meta", "phl-lead", "phl-desc",
    "phl-stats", "phl-spec-role", "phl-spec-stack", "aiw-gallery",
    "aiw-title", "aiw-meta", "aiw-lead", "aiw-desc", "aiw-highlights",
    "aiw-spec-role", "aiw-spec-stack", "cog-gallery", "cog-title",
    "cog-meta", "cog-lead", "cog-desc", "cog-stats", "cog-spec-role",
    "cog-spec-stack", "cvr-gallery", "cvr-title", "cvr-meta", "cvr-lead",
    "cvr-desc", "cvr-stats", "cvr-spec-role", "cvr-spec-stack",
    "br-gallery", "br-title", "br-meta", "br-lead", "br-desc", "br-stats",
    "br-spec-role", "br-spec-tech",
    "latest-eyebrow", "latest-h2", "blog-highlights",
    "about-eyebrow", "about-lede",
    "about-p1", "about-p2", "about-p3", "about-place", "about-link",
    "contact-eyebrow", "contact-h2", "contact-email", "contact-btn-email",
    "contact-btn-call", "contact-btn-txt", "contact-btn-resume", "endbar",
  ],
  "blog.html": [
    "brand-title", "brand-sub", "nav-work", "nav-gallery", "nav-blog",
    "nav-about", "nav-contact", "blog-eyebrow", "blog-h2", "blog-stream",
    "contact-eyebrow", "contact-h2", "contact-email", "contact-btn-email",
    "contact-btn-call", "contact-btn-txt", "contact-btn-resume", "endbar",
    "blog-manifest",
  ],
  "gallery.html": [
    "brand-title", "brand-sub", "nav-work", "nav-gallery", "nav-blog",
    "nav-about", "nav-contact",
    "gallery-eyebrow", "gallery-h2", "gallery-intro", "gallery-note",
    "gal-br",
    "contact-eyebrow", "contact-h2", "contact-email", "contact-btn-email",
    "contact-btn-call", "contact-btn-txt", "contact-btn-resume", "endbar",
  ],
};

// The declared script set of each page, in load order. site.js creates the
// namespace, so it is always first; tool.js reaches into the others, so it is
// always last. A page declares only the trunks it needs: blog.js is on the
// blog page and nowhere else. A wrong order fails here, not in the browser.
const EXPECTED_SCRIPTS = {
  "index.html": ["site.js", "work.js", "tool.js"],
  "blog.html": ["site.js", "work.js", "blog.js", "markdown.js", "tool.js", "publish.js"],
  "gallery.html": ["site.js", "work.js", "tool.js", "gallery.js"],
};

// blog.html with no posts: the manifest reset to its counters and the index
// back to its placeholder.
//
// The suite must not depend on what the live blog holds. Every check here was
// written while the manifest was empty, and the first real post made four of
// them false. This keeps the page's structure - its chrome, its regions, its
// scripts - and makes only its content deterministic.
function emptyBlogPage(src) {
  const man = src.replace(
    /(<script id="blogManifest"[^>]*>)[\s\S]*?(<\/script>)/,
    '$1\nnext-post:0001\nnext-img:0001\n\n$2');
  return man.replace(
    /(<!--\[edit:blog-stream\]-->)[\s\S]*?(<!--\[\/edit:blog-stream\]-->)/,
    '$1\n        <div class="bs-stream" id="blogStream" data-ced="generated">\n' +
    '          <p class="bs-note">No posts yet - check back soon.</p>\n' +
    '        </div>\n        $2');
}

// Read the open-marker slugs of a page source, in document order.
function regionSlugs(text) {
  const out = [];
  const re = /<!--\[edit:([\w-]+)\]-->/g;
  let m;
  while ((m = re.exec(text)) !== null) out.push(m[1]);
  return out;
}

// Read the src of every classic script tag of a page source, in document
// order. A tag with no src carries inline code and is not part of load order.
function scriptSrcs(text) {
  const out = [];
  const re = /<script\b([^>]*)>/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    const src = /\bsrc\s*=\s*"([^"]*)"/i.exec(m[1]);
    if (src) out.push(src[1]);
  }
  return out;
}

// Report where two strings first differ, with a short window of each side.
// A bare "not identical" costs an hour of bisecting; an offset costs a minute.
function firstDiff(a, b) {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  if (i === a.length && i === b.length) return "";
  const win = (s) => JSON.stringify(s.slice(i, i + 60));
  return "differ at " + i + ": src=" + win(a) + " exp=" + win(b);
}

// Compare an exported page against the source of that page on disk, ignoring
// the content of the named regions. Export must leave every byte outside a
// marked region alone, so this is the assertion the whole publish model rests
// on. The page is a parameter because Phases 3 and 4 export three pages.
// The source the suite SERVES. That is the repo's page for everything except
// the blog, whose content is reset so no check depends on what the live site
// happens to hold. Comparing an export against the repo's copy would fail for
// a reason that has nothing to do with the export.
function servedSource(page) {
  const src = readFileSync(join(REPO, page), "utf-8");
  return page === "blog.html" ? emptyBlogPage(src) : src;
}

function exportIsByteExact(page, exported, editedSlugs) {
  const src = servedSource(page);
  const a = stripSpans(src, editedSlugs);
  const b = stripSpans(exported, editedSlugs);
  if (a === null) return { ok: false, detail: page + ": a slug is missing from the source" };
  if (b === null) return { ok: false, detail: page + ": a slug is missing from the export" };
  return { ok: a === b, detail: a === b ? page + " clean" : page + " " + firstDiff(a, b) };
}

async function getPageWs() {
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`);
      const targets = await res.json();
      const t = targets.find((x) => x.type === "page" && x.url.startsWith(PAGE.slice(0, 30)));
      if (t) return t.webSocketDebuggerUrl;
    } catch {}
    await sleep(300);
  }
  throw new Error("no debuggable page target found");
}

let msgId = 0;
const pending = new Map();
const exceptions = [];
let dialogCount = 0;          // how many window.confirm/alert dialogs the page has opened
let ws;

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression, { awaitPromise = false } = {}) {
  const r = await send("Runtime.evaluate", {
    expression, returnByValue: true, awaitPromise,
  });
  if (r.exceptionDetails) {
    throw new Error("page exception: " + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  }
  return r.result?.value;
}

// Wait until the current page has finished loading. A fixed sleep races the
// home page, which is one 320 KB file.
async function waitLoaded(ms = 10000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      if (await evaluate(`document.readyState === "complete"`)) return true;
    } catch {}
    await sleep(200);
  }
  return false;
}

async function main() {
  const wsUrl = await getPageWs();
  ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
    } else if (msg.method === "Runtime.exceptionThrown") {
      exceptions.push(msg.params.exceptionDetails?.exception?.description || "unknown");
    } else if (msg.method === "Page.javascriptDialogOpening") {
      dialogCount++;
      send("Page.handleJavaScriptDialog", { accept: true });
    }
  };

  await send("Runtime.enable");
  await send("Page.enable");

  // ============ CONTRACT TESTS ============
  // These run first. They describe the site as it is now, so that a later part
  // that changes the shape of the site has to say so here before it can pass.

  for (const page of MANAGED_PAGES) {
    const src = readFileSync(join(REPO, page), "utf-8");

    // C1. the marked regions are exactly the ones we expect, in order
    const found = regionSlugs(src);
    const want = EXPECTED_REGIONS[page];
    const sameList = JSON.stringify(found) === JSON.stringify(want);
    check("contract: " + page + " holds the expected " + want.length + " regions, in order",
      sameList, sameList ? "" : "found=" + found.length + " want=" + want.length +
      " first mismatch=" + (found.find((s, i) => s !== want[i]) || "(order only)"));

    // C2. every expected region resolves on its own, so the byte-exact helper
    // can name any of them. One at a time, because stripping a parent region
    // removes its nested child with it. Phases 3 and 4 add pages here.
    const unresolved = want.filter((s) => stripSpans(src, [s]) === null);
    check("contract: " + page + " regions all resolve for the byte-exact helper",
      unresolved.length === 0, unresolved.join(", ").slice(0, 200));

    // C3. the page parses and boots with no console error
    exceptions.length = 0;
    await send("Page.navigate", { url: `http://127.0.0.1:${SERVER_PORT}/${page}` });
    const loaded = await waitLoaded();
    await sleep(600);
    const booted = await evaluate(`({ body: !!document.body, title: document.title })`);
    check("contract: " + page + " boots with no console error",
      loaded && booted.body && exceptions.length === 0,
      "loaded=" + loaded + " " + exceptions.join(" | ").slice(0, 200));

    // C4. exactly one managed page carries the manifest
    const hasManifest = /<script id="blogManifest"/.test(src);
    check("contract: " + page + (hasManifest ? " carries" : " does not carry") + " the blog manifest",
      hasManifest === (page === "blog.html"),
      hasManifest ? "found on " + page : "");

    // C5. the classic script tags load in the declared order
    const srcs = scriptSrcs(src);
    const wantSrcs = EXPECTED_SCRIPTS[page];
    const sameOrder = JSON.stringify(srcs) === JSON.stringify(wantSrcs);
    check("contract: " + page + " loads " + wantSrcs.length + " scripts in the declared order",
      sameOrder, sameOrder ? "" : "found=" + JSON.stringify(srcs));

    // C6. the composer is a blog-page trunk. The console name is on every
    // page, because people learn one name; off the blog page it says where
    // to go rather than opening something that cannot publish. Calling it
    // is safe here for exactly that reason, so only the refusing pages are
    // called - opening a real composer would leave a panel over the tests
    // that follow.
    const wantTrunk = page === "blog.html";
    const composer = await evaluate(`({
      trunk: typeof (window.AMH && window.AMH.publish),
      name: typeof (window.edit && window.edit.blog),
      says: ${wantTrunk ? '""' : "String(window.edit.blog())"},
      panel: !!document.querySelector('.bc-panel'),
    })`);
    check("contract: " + page + (wantTrunk ? " loads" : " does not load") + " the composer",
      (composer.trunk === "object") === wantTrunk && composer.name === "function",
      JSON.stringify(composer));
    if (!wantTrunk) {
      check("contract: edit.blog() on " + page + " says where the composer lives",
        !composer.panel && /blog\.html/.test(composer.says), composer.says);
    }
  }

  // C-gallery. The grid invariant: within a train, the widths of each row
  // add to exactly six, and only the LAST row may be short. That is what
  // makes an interior hole impossible rather than merely avoided, and it is
  // the assumption Phase 4 Part 2's packer is built on.
  {
    const src = readFileSync(join(REPO, "gallery.html"), "utf-8");
    const trains = src.split('<div class="gal-train"').slice(1);
    const faults = [];
    for (const train of trains) {
      const id = (/data-project="([^"]+)"/.exec(train) || [, "?"])[1];
      const spans = [...train.matchAll(/data-span="(\d)"/g)].map((m) => +m[1]);
      let row = 0, rows = [];
      for (const s of spans) {
        if (row + s > 6) { rows.push(row); row = 0; }
        row += s;
      }
      rows.push(row);
      // every row but the last must be exactly six
      rows.slice(0, -1).forEach((r, i) => {
        if (r !== 6) faults.push(id + " row " + (i + 1) + " = " + r);
      });
      if (!spans.length) faults.push(id + " has no tiles");
      if (rows[rows.length - 1] > 6) faults.push(id + " last row overflows");
    }
    check("gallery: every row of a train adds to six, last row may be short",
      trains.length > 0 && faults.length === 0,
      faults.length ? faults.join("; ") : trains.length + " train(s) checked");
  }

  // Every tile carries all three numbers. data-w and data-priority are the
  // author's; data-span is the packer's answer at six columns, baked in so a
  // reader with no script gets the same layout as a reader with one.
  {
    const src = readFileSync(join(REPO, "gallery.html"), "utf-8");
    const tiles = [...src.matchAll(
      /data-w="(\d)" data-priority="(\d+)" data-span="(\d)"/g)];
    const count = (src.match(/class="gal-tile"/g) || []).length;
    check("gallery: every tile carries a preference, a priority and a span",
      tiles.length === count && count > 0, tiles.length + " of " + count + " tiles");
    // an <img> whose width/height attributes lie is a layout shift on load
    const imgs = [...src.matchAll(/<img src="img\/(seed\/[^"]+)"[\s\S]*?width="(\d+)" height="(\d+)"/g)];
    const wrong = imgs.filter(([, f, w, h]) => {
      const buf = readFileSync(join(REPO, "img", f));
      let i = 2;
      while (i < buf.length) {
        if (buf[i] !== 0xFF) { i++; continue; }
        const m = buf[i + 1];
        if (m === 0xC0 || m === 0xC1 || m === 0xC2) {
          return buf.readUInt16BE(i + 5) !== +h || buf.readUInt16BE(i + 7) !== +w;
        }
        i += 2 + buf.readUInt16BE(i + 2);
      }
      return true;
    });
    check("gallery: every tile's width and height match its file",
      imgs.length === count && wrong.length === 0,
      wrong.length ? wrong.map((m) => m[1]).join(", ") : imgs.length + " images");
  }

  // C-packer. The two pure functions, called with numbers. Every rule the
  // layout obeys is in them, so this is where the rules are checked: no
  // rendering, no measurement, no waiting for images.
  await send("Page.navigate", { url: `http://127.0.0.1:${SERVER_PORT}/gallery.html` });
  await waitLoaded();
  await sleep(1200);

  const packer = await evaluate(`(() => {
    const G = window.AMH.gallery;
    const T = (prefer, priority, maxSpan) => ({ prefer, priority, maxSpan: maxSpan || 4 });
    const shape = (rows) => rows.map(r => r.map(c => c.span).join("+")).join(" | ");
    const how = (rows) => rows.map(r => r.map(c => c.how || "-").join("+")).join(" | ");
    const sums = (rows, cols) => rows.map(r => r.reduce((a, c) => a + c.span, 0));

    const out = {};

    // rule 2: preferences that already tile exactly are left alone
    out.exact = shape(G.pack([T(2,1),T(2,1),T(2,1),T(3,1),T(3,1)], 6));

    // rule 3: the next tile does not fit, so a later one that fits exactly
    // is pulled up. The pulled tile keeps its own preferred width.
    const reorder = G.pack([T(2,1),T(2,1),T(3,1),T(2,1)], 6);
    out.reorderShape = shape(reorder);
    out.reorderHow = how(reorder);

    // rule 4 before rule 3: a gap nothing wants is closed by widening,
    // which keeps the author's order.
    const widen = G.pack([T(2,1),T(3,1),T(3,1)], 6);
    out.widenShape = shape(widen);
    out.widenHow = how(widen);

    // the zoom cap: a tile that may not exceed 2 is never drawn wider
    const capped = G.pack([T(4,1,2),T(4,1,2),T(4,1,2)], 6);
    out.cappedShape = shape(capped);
    out.cappedMax = Math.max(...capped.flat().map(c => c.span));

    // rule 5: the last row may be short, and nothing is widened into it
    const trail = G.pack([T(2,1),T(2,1),T(2,1),T(2,1)], 6);
    out.trailShape = shape(trail);
    out.trailHow = how(trail);

    // rule 1: priority beats document order, ties keep it
    out.priority = G.pack(
      [T(2,3),T(2,1),T(2,2)], 6)[0].map(c => c.tile.priority).join(",");

    // no interior hole, ever - including a pathological set
    const mixed = [T(4,1),T(4,1),T(3,1),T(4,1),T(3,1),T(4,1),T(3,1)];
    const rows6 = G.pack(mixed, 6);
    out.holes = sums(rows6).slice(0, -1).filter(s => s !== 6).length;
    out.mixedShape = shape(rows6);

    // determinism: same input, same output
    out.deterministic = shape(G.pack(mixed, 6)) === shape(G.pack(mixed, 6));

    // every breakpoint stays valid
    out.byCols = [6,3,1].map(cols => {
      const rows = G.pack(mixed, cols);
      const bad = sums(rows).slice(0, -1).filter(s => s !== cols).length;
      const over = rows.flat().filter(c => c.span > cols).length;
      return cols + ":" + (bad + over === 0 ? "ok" : "BAD");
    }).join(" ");

    // the collapse table agrees with what site.css does
    out.collapse = [6,3,1].map(c => [1,2,3,4].map(p => G.preferIn(p, c)).join("")).join(" ");

    // the cap itself, in geometry
    const geom = { cols: 6, width: 1385, gap: 14, rowH: 224, dpr: 1 };
    out.wideOk = G.maxSpan(1600, 900, geom);          // 1600px: fine at x4
    out.tallCapped = G.maxSpan(600, 1800, geom);      // portrait: narrower
    out.tinyFloor = G.maxSpan(32, 32, geom);          // cannot fit anything
    out.retina = G.maxSpan(1600, 900, { ...geom, dpr: 3 });
    out.cap = G.ZOOM_CAP;
    return out;
  })()`);

  check("packer: preferences that already tile exactly are left alone",
    packer.exact === "2+2+2 | 3+3", packer.exact);
  check("packer: rule 3 pulls up a later tile that fits the gap",
    packer.reorderShape === "2+2+2 | 3" && packer.reorderHow === "-+-+moved | -",
    packer.reorderShape + "  " + packer.reorderHow);
  check("packer: rule 4 widens to close a gap nothing else wants",
    packer.widenShape === "2+4 | 3" && packer.widenHow === "-+widened | -",
    packer.widenShape + "  " + packer.widenHow);
  check("packer: a tile is never drawn wider than its zoom cap allows",
    packer.cappedMax <= 2, "widest span used = " + packer.cappedMax);
  check("packer: the last row may be short, and is not widened into",
    packer.trailShape === "2+2+2 | 2" && !/widened/.test(packer.trailHow),
    packer.trailShape + "  " + packer.trailHow);
  check("packer: priority beats document order", packer.priority === "1,2,3",
    packer.priority);
  check("packer: no interior hole, whatever the preferences",
    packer.holes === 0, packer.mixedShape);
  check("packer: the same input gives the same output", packer.deterministic === true);
  check("packer: every breakpoint produces a valid layout",
    packer.byCols === "6:ok 3:ok 1:ok", packer.byCols);
  check("packer: the collapse table matches the one in site.css",
    packer.collapse === "1234 1123 1111", packer.collapse);
  check("cap: a 1600px image fills an x4 slot, a portrait does not",
    packer.wideOk === 4 && packer.tallCapped < 4 && packer.cap === 1.35,
    "x4=" + packer.wideOk + " portrait=" + packer.tallCapped + " cap=" + packer.cap);
  check("cap: a tiny image still gets a span rather than a hole",
    packer.tinyFloor === 1, String(packer.tinyFloor));
  check("cap: a denser display narrows the span it allows",
    packer.retina < packer.wideOk, "dpr3=" + packer.retina + " dpr1=" + packer.wideOk);

  // C-packed. The authored markup IS the packer's answer at six columns.
  // That is what lets the CSS lay the page out until the packer runs, and
  // nothing move when it does.
  //
  // Six columns has to be asked for: the harness window is narrower than the
  // 880px breakpoint, so the page is in three-column mode by default.
  async function atWidth(width, fn) {
    await send("Emulation.setDeviceMetricsOverride",
      { width, height: 1000, deviceScaleFactor: 1, mobile: false });
    await send("Page.navigate", { url: `http://127.0.0.1:${SERVER_PORT}/gallery.html` });
    await waitLoaded();
    await sleep(1600);
    const out = await fn();
    await send("Emulation.clearDeviceMetricsOverride");
    return out;
  }

  const READ_TRAIN = `(() => {
    const train = document.querySelector('.gal-train');
    const tiles = [...train.querySelectorAll('.gal-tile')];
    const cols = parseInt(getComputedStyle(train).getPropertyValue('--gal-cols'), 10);
    const spans = tiles.map(t => parseInt(t.style.gridColumn.replace('span ', ''), 10));
    const rows = [];
    let row = 0;
    for (const s of spans) { row += s; if (row >= cols) { rows.push(row); row = 0; } }
    if (row) rows.push(row);
    return {
      cols,
      order: tiles.map(t => t.querySelector('img').getAttribute('src').split('/').pop()).join(","),
      spans: spans.join(","),
      authored: tiles.map(t => +t.getAttribute('data-span')).join(","),
      packedAttr: tiles.filter(t => t.hasAttribute('data-packed')).length,
      rows: rows.join(","),
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
    };
  })()`;

  const wide = await atWidth(1600, () => evaluate(READ_TRAIN));
  check("gallery: at six columns the packer reproduces the authored spans",
    wide.cols === 6 && wide.spans === wide.authored,
    "live=" + wide.spans + " authored=" + wide.authored);
  check("gallery: and every full row adds to six",
    wide.rows.split(",").slice(0, -1).every((r) => r === "6"), wide.rows);

  // Both sides of each breakpoint. 900 is worth naming: it reads like a
  // tablet number and the grid does NOT collapse there - the line is 880 -
  // so a check at 900 alone would say nothing about the collapse at all.
  for (const [w, want] of [[900, 6], [880, 3], [640, 3], [560, 1], [390, 1]]) {
    const r = await atWidth(w, () => evaluate(READ_TRAIN));
    const full = r.rows.split(",").slice(0, -1);
    check("gallery: at " + w + "px it is " + want + " columns, every full row filled",
      r.cols === want && full.every((x) => +x === want) &&
      r.scrollWidth <= r.innerWidth,
      "cols=" + r.cols + " rows=" + r.rows + " sw=" + r.scrollWidth + " iw=" + r.innerWidth);
  }

  // A resize, not a reload. The packer listens for it, debounces, and only
  // repacks when the answer would change - so this also proves the debounce
  // fires at all rather than swallowing the event.
  await send("Emulation.setDeviceMetricsOverride",
    { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
  await send("Page.navigate", { url: `http://127.0.0.1:${SERVER_PORT}/gallery.html` });
  await waitLoaded();
  await sleep(1600);
  const beforeResize = await evaluate(READ_TRAIN);
  await send("Emulation.setDeviceMetricsOverride",
    { width: 640, height: 1000, deviceScaleFactor: 1, mobile: false });
  await sleep(900);
  const afterResize = await evaluate(READ_TRAIN);
  await send("Emulation.clearDeviceMetricsOverride");
  check("gallery: a resize across a breakpoint repacks the train",
    beforeResize.cols === 6 && afterResize.cols === 3 &&
    afterResize.rows.split(",").slice(0, -1).every((r) => r === "3"),
    beforeResize.cols + " -> " + afterResize.cols + " rows=" + afterResize.rows);

  const packedLive = await atWidth(1600, () => evaluate(READ_TRAIN));
  check("gallery: the packer marks the tiles it moved or widened",
    packedLive.packedAttr > 0, packedLive.packedAttr + " marked");

  // ============ THE EDIT LAUNCHER ============
  // The way into the editor for anyone who does not open a console. It is
  // built at load by tool.js, so it is on every page tool.js is on and it is
  // in no page's markup.
  for (const page of MANAGED_PAGES) {
    await send("Page.navigate", { url: `http://127.0.0.1:${SERVER_PORT}/${page}` });
    await waitLoaded();
    await sleep(1200);
    const lx = await evaluate(`(() => {
      const b = document.querySelector('.amh-edit');
      if (!b) return { there: false };
      const cs = getComputedStyle(b);
      const r = b.getBoundingClientRect();
      const vh = document.documentElement.clientHeight;
      // the corner is flush with the page corner, because that is the corner
      // it is pretending to be
      return {
        there: true,
        tag: b.tagName,
        z: +cs.zIndex,
        corner: b.getAttribute('data-corner'),
        atLeft: Math.abs(r.left) <= 1,
        atBottom: Math.abs(vh - r.bottom) <= 1,
        label: b.getAttribute('aria-label'),
        pressed: b.getAttribute('aria-pressed'),
        words: b.querySelectorAll('text.amh-edit__word').length,
      };
    })()`);
    check("launcher: " + page + " carries it, in the corner and above everything",
      lx.there && lx.tag === "BUTTON" && lx.z === 4000 &&
      lx.corner === "bottom-left" && lx.atLeft && lx.atBottom && lx.words === 2,
      JSON.stringify(lx));
    // in the markup of no page: it is runtime scaffolding, like the chips
    const src = readFileSync(join(REPO, page), "utf-8");
    check("launcher: " + page + " does not carry it in the file",
      !src.includes("amh-edit"),
      src.includes("amh-edit") ? "the file mentions amh-edit" : "runtime only");
  }

  // it is above the editor's own layers, so the way out is never behind the
  // thing it closes
  const lxStack = await evaluate(`(() => {
    const zOf = (sel) => {
      const el = document.querySelector(sel);
      return el ? +getComputedStyle(el).zIndex : null;
    };
    window.edit();
    return { launcher: zOf('.amh-edit'), panel: zOf('.ced-panel') };
  })()`);
  check("launcher: it sits above the editor panel it opens",
    lxStack.launcher > lxStack.panel, JSON.stringify(lxStack));

  // the console and the button are the same switch, so they cannot disagree
  const lxToggle = await evaluate(`(() => {
    const b = document.querySelector('.amh-edit');
    const onNow = { pressed: b.getAttribute('aria-pressed'), label: b.getAttribute('aria-label'),
                    exit: getComputedStyle(b.querySelector('.amh-edit__word--exit')).display };
    b.click();                       // the button turns it off
    const offAfter = { pressed: b.getAttribute('aria-pressed'),
                       label: b.getAttribute('aria-label'), panel: !!document.querySelector('.ced-panel') };
    window.edit();                   // the console turns it back on
    const onAgain = { pressed: b.getAttribute('aria-pressed'), panel: !!document.querySelector('.ced-panel') };
    window.edit();
    return { onNow, offAfter, onAgain };
  })()`);
  check("launcher: it reads EXIT and says so while the editor is on",
    lxToggle.onNow.pressed === "true" && /Close/.test(lxToggle.onNow.label) &&
    lxToggle.onNow.exit !== "none", JSON.stringify(lxToggle.onNow));
  check("launcher: clicking it closes the editor",
    lxToggle.offAfter.pressed === "false" && /Open/.test(lxToggle.offAfter.label) &&
    lxToggle.offAfter.panel === false, JSON.stringify(lxToggle.offAfter));
  check("launcher: the console and the button never disagree",
    lxToggle.onAgain.pressed === "true" && lxToggle.onAgain.panel === true,
    JSON.stringify(lxToggle.onAgain));

  // the word is painted BEFORE the flap, so the curl uncovers it. SVG draws
  // in document order, which is why there is no z-index inside the button:
  // put the word after the flap and it would float on top of the paper.
  const lxOrder = await evaluate(`(() => {
    const art = document.querySelector('.amh-edit__art');
    const kids = [...art.children];
    const word = art.querySelector('.amh-edit__word--edit');
    const group = word && word.closest('g[clip-path]');
    const idx = (el) => kids.indexOf(el);
    const wordStyle = word ? getComputedStyle(word) : null;
    return {
      hole: kids.findIndex(k => k.matches('.amh-edit__hole')),
      word: group ? idx(group) : -1,
      flap: kids.findIndex(k => k.matches('.amh-edit__flap')),
      clipped: !!(group && /amhPeel/.test(group.getAttribute('clip-path') || '')),
      // the reveal must be geometry, not a second animation on a timer
      fades: wordStyle ? /opacity/.test(wordStyle.transitionProperty) : null,
    };
  })()`);
  check("launcher: the word is painted under the flap, so the peel reveals it",
    lxOrder.hole >= 0 && lxOrder.word > lxOrder.hole && lxOrder.flap > lxOrder.word,
    "hole=" + lxOrder.hole + " word=" + lxOrder.word + " flap=" + lxOrder.flap);
  check("launcher: the word is clipped to the hole, and does not fade on a timer",
    lxOrder.clipped === true && lxOrder.fades === false,
    "clipped=" + lxOrder.clipped + " fades=" + lxOrder.fades);

  // any corner, from one attribute. The art is drawn for the bottom left and
  // the other three mirror it, so each corner touches two viewport edges.
  const lxCorners = await evaluate(`(() => {
    const b = document.querySelector('.amh-edit');
    const out = {};
    // documentElement.clientWidth, not innerWidth: innerWidth counts the
    // scrollbar and getBoundingClientRect does not, so a right-anchored
    // element measured against innerWidth reads one scrollbar out.
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    const near = (a, b2) => Math.abs(a - b2) <= 1;
    for (const c of ['bottom-left', 'bottom-right', 'top-left', 'top-right']) {
      b.setAttribute('data-corner', c);
      const r = b.getBoundingClientRect();
      out[c] = [
        near(r.left, 0) ? 'L' : (near(r.right, vw) ? 'R' : '?'),
        near(r.top, 0) ? 'T' : (near(r.bottom, vh) ? 'B' : '?'),
      ].join("");
    }
    b.setAttribute('data-corner', 'bottom-left');
    return out;
  })()`);
  check("launcher: every corner is positioned from the one attribute",
    lxCorners["bottom-left"] === "LB" && lxCorners["bottom-right"] === "RB" &&
    lxCorners["top-left"] === "LT" && lxCorners["top-right"] === "RT",
    JSON.stringify(lxCorners));

  // ============ ONE PAGE CHANGED, ONE PAGE WRITTEN ============
  // The publish story, stated once for all three pages. An edit to a region
  // that belongs to one page downloads that page by itself: no zip, and no
  // page the user never touched.
  {
    const only = [
      ["index.html", "hero-h1", "SOLO HOME EDIT"],
      ["gallery.html", "gallery-h2", "SOLO GALLERY EDIT"],
      ["blog.html", "blog-h2", "SOLO BLOG EDIT"],
    ];
    for (const [page, slug, marker] of only) {
      await send("Page.navigate", { url: `http://127.0.0.1:${SERVER_PORT}/${page}` });
      await waitLoaded();
      await sleep(1500);
      await evaluate(ZIP_CAPTURE);
      await evaluate(`(() => {
        window.edit();
        const chip = [...document.querySelectorAll('.ced-chip')]
          .find(c => c.title === ${JSON.stringify(slug)});
        chip.click();
        const ta = document.querySelector('.ced-modal textarea');
        // appended, not substituted: two of these three regions hold plain
        // text with no tags to substitute inside, and appending keeps the
        // markup balanced for the editor's own tag check
        ta.value = ta.value + ' ${marker}';
        document.querySelector('.ced-modal__btns .ced-btn--accent').click();
        document.querySelector('.ced-modal__x').click();
        window.__zipB64 = null;
        window.__exportSaid = String(window.edit.export());
      })()`);
      let got = null;
      for (let i = 0; i < 25 && !got; i++) { await sleep(400); got = await evaluate(`window.__zipB64`); }
      const text = got ? Buffer.from(got, "base64").toString("utf8") : "";
      const isZip = text.startsWith("PK");
      check("publish: an edit on " + page + " downloads " + page + " and nothing else",
        !!text && !isZip && text.includes(marker) && text.includes("<!DOCTYPE html>"),
        isZip ? "a zip came back, so more than one page was written"
              : (text ? text.length + " chars of html"
                      : "nothing captured; export said: " +
                        (await evaluate(`window.__exportSaid`))));
      if (text) {
        const x = exportIsByteExact(page, text, [slug]);
        check("publish: " + page + " byte-identical outside the one region it changed",
          x.ok, x.detail);
      }
      await evaluate(`window.edit.pending.clear(); window.edit()`);
      await sleep(300);
    }
  }

  // ============ THE LIGHTBOX ON THE GRID ============
  // Phase 2 Part 2 extracted the lightbox with an items list of
  // {src, caption, alt}, chosen to match what the image-region core already
  // produces. This is the consumer it was extracted for, so the checks are
  // about reuse: one viewer, the whole photograph, and one train at a time.
  await send("Emulation.setDeviceMetricsOverride",
    { width: 1500, height: 950, deviceScaleFactor: 1, mobile: false });
  await send("Page.navigate", { url: `http://127.0.0.1:${SERVER_PORT}/gallery.html` });
  await waitLoaded();
  await sleep(1800);

  const lbOpen = await evaluate(`(() => {
    const tiles = [...document.querySelectorAll('.gal-tile')];
    const fig = tiles[3];
    const nat = fig.querySelector('img');
    fig.click();
    const root = document.querySelector('.lightbox');
    const shown = document.querySelector('.lightbox__img--active');
    return {
      open: !!(root && !root.hidden),
      lock: document.body.classList.contains('lb-open'),
      count: tiles.length,
      index: shown ? shown.getAttribute('src') === nat.currentSrc : null,
      fit: shown ? getComputedStyle(shown).objectFit : "",
      tileFit: getComputedStyle(nat).objectFit,
      caption: (document.querySelector('.lightbox__caption') || {}).textContent || '',
      role: fig.getAttribute('role'),
      tabindex: fig.getAttribute('tabindex'),
      viewers: document.querySelectorAll('.lightbox').length,
    };
  })()`);
  check("lightbox: a tile click opens the shared viewer on that tile",
    lbOpen.open === true && lbOpen.index === true && lbOpen.lock === true,
    JSON.stringify(lbOpen));
  check("lightbox: the tile crops, the viewer shows the whole photograph",
    lbOpen.tileFit === "cover" && lbOpen.fit === "contain",
    "tile=" + lbOpen.tileFit + " viewer=" + lbOpen.fit);
  check("lightbox: one viewer exists, not one per consumer",
    lbOpen.viewers === 1, lbOpen.viewers + " .lightbox elements");
  check("lightbox: a tile is reachable and labelled for a keyboard",
    lbOpen.role === "button" && lbOpen.tabindex === "0",
    "role=" + lbOpen.role + " tabindex=" + lbOpen.tabindex);

  // navigation stays inside the train it was opened from
  const lbNav = await evaluate(`(() => {
    const items = [...document.querySelectorAll('.gal-tile img')]
      .map(i => i.currentSrc);
    const next = document.querySelector('.lightbox__nav--next');
    next.click(); next.click();
    const shown = document.querySelector('.lightbox__img--active').getAttribute('src');
    return { at: items.indexOf(shown), of: items.length };
  })()`);
  check("lightbox: next moves within the train, and no further",
    lbNav.at === 5 && lbNav.of === 8, JSON.stringify(lbNav));

  // close returns focus to the tile that opened it, and releases the lock
  const lbClose = await evaluate(`(() => {
    document.querySelector('.lightbox__close').click();
    const root = document.querySelector('.lightbox');
    return {
      closed: !!(root && root.hidden),
      lock: document.body.classList.contains('lb-open'),
      focus: document.activeElement && document.activeElement.className,
    };
  })()`);
  check("lightbox: close releases the scroll lock and returns focus to the tile",
    lbClose.closed === true && lbClose.lock === false &&
    /gal-tile/.test(lbClose.focus || ""), JSON.stringify(lbClose));

  await send("Emulation.clearDeviceMetricsOverride");

  // ============ GALLERY EDITING ============
  // The tile grid is the third consumer of the image-region core. A drop here
  // is the same code as a drop on a carousel, so these mirror those checks
  // and then cover what is new: the two per-tile numbers, and the rule that a
  // packing decision never reaches the file.
  await send("Emulation.setDeviceMetricsOverride",
    { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
  await send("Page.navigate", { url: `http://127.0.0.1:${SERVER_PORT}/gallery.html` });
  await waitLoaded();
  await sleep(1600);
  await evaluate(ZIP_CAPTURE);

  const galReg = await evaluate(`(() => {
    window.edit();
    const g = window.AMH.tool.imageRegion;
    const list = window.edit.list();
    return {
      kind: (window.__gal = [...document.querySelectorAll('.gal-train')]).length,
      seeds: [...document.querySelectorAll('.gal-tile')].length,
      chips: document.querySelectorAll('.gal-tile__chip').length,
      seedChips: [...document.querySelectorAll('.gal-tile__chip')]
        .filter(c => c.textContent === 'SEED').length,
      listed: /galler|tiles/i.test(String(list)) || String(list),
    };
  })()`);
  check("gallery edit: the train registers as one image region of seed tiles",
    galReg.kind === 1 && galReg.seeds === 8 && galReg.chips === 8 &&
    galReg.seedChips === 8, JSON.stringify(galReg));

  // GE1. a drop. Same path as a carousel: the first real image replaces the
  // whole seed set, records img/work/<name>, and HEAD-checks it.
  const galDrop = await evaluate(`(async () => {
    const train = document.querySelector('.gal-train');
    const tile = train.querySelector('.gal-tile');
    const cv = document.createElement('canvas');
    cv.width = 1600; cv.height = 900;
    const cx = cv.getContext('2d');
    cx.fillStyle = '#2b6cb0'; cx.fillRect(0, 0, 1600, 900);
    const blob = await new Promise(r => cv.toBlob(r, 'image/png'));
    const file = new File([blob], 'tile-one.png', { type: 'image/png' });
    const dt = new DataTransfer();
    dt.items.add(file);
    tile.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true }));
    await new Promise(r => setTimeout(r, 600));
    const modal = document.querySelector('.ced-modal');
    if (modal) document.querySelector('.ced-modal__x').click();
    await new Promise(r => setTimeout(r, 300));
    const tiles = [...train.querySelectorAll('.gal-tile')];
    // The model is what the export reads. The DOM shows a blob preview, so
    // reading the DOM would not tell us what a publish would write.
    const model = window.AMH.gallery.regions()[0].model;
    return {
      count: tiles.length,
      shown: tiles[0].querySelector('img').src.slice(0, 5),
      recorded: model.map(e => e.src).join(","),
      missing: model[0].missing,
      chip: tiles[0].querySelector('.gal-tile__chip').textContent,
      hasCtl: !!tiles[0].querySelector('.gal-tile__ctl'),
      prefer: model[0].prefer,
    };
  })()`, { awaitPromise: true });
  check("gallery edit: a drop records img/work/ and previews the dropped file",
    galDrop.count === 1 && galDrop.recorded === "img/work/tile-one.png" &&
    galDrop.shown === "blob:" && galDrop.chip !== "SEED" &&
    galDrop.hasCtl === true && galDrop.prefer === 2,
    JSON.stringify(galDrop));
  check("gallery edit: the dropped file is HEAD-checked, as a carousel drop is",
    galDrop.missing === true,
    "missing=" + galDrop.missing + " - the probe file is not in img/work/, " +
    "so true here is the check doing its job");

  // GE2. the two controls that are new here
  const galCtl = await evaluate(`(() => {
    const fig = document.querySelector('.gal-tile');
    const x4 = [...fig.querySelectorAll('.gal-w')].find(b => b.textContent === 'x4');
    x4.click();
    const pri = document.querySelector('.gal-tile .gal-tile__pri');
    pri.value = '7';
    pri.dispatchEvent(new Event('change', { bubbles: true }));
    const now = document.querySelector('.gal-tile');
    return {
      w: now.getAttribute('data-w'),
      priority: now.getAttribute('data-priority'),
      on: now.querySelector('.gal-w.on').textContent,
      span: now.style.gridColumn,
    };
  })()`);
  check("gallery edit: the prefer and priority controls change the tile",
    galCtl.w === "4" && galCtl.priority === "7" && galCtl.on === "x4",
    JSON.stringify(galCtl));

  // GE3. export. Clean <figure> lines with both attributes, and everything
  // outside the region byte-identical.
  const galZip = await evaluate(`(() => {
    window.__zipB64 = null;
    return String(window.edit.export());
  })()`);
  let galOut = null;
  for (let i = 0; i < 25 && !galOut; i++) {
    await sleep(400);
    galOut = await evaluate(`window.__zipB64`);
  }
  const galHtml = galOut ? Buffer.from(galOut, "base64").toString("utf8") : "";
  check("gallery edit: the export downloads gallery.html", galHtml.includes("<!DOCTYPE html>"),
    galHtml ? galHtml.length + " chars" : "nothing captured: " + galZip);

  if (galHtml) {
    const span = galHtml.slice(galHtml.indexOf("<!--[edit:gal-br]-->"),
      galHtml.indexOf("<!--[/edit:gal-br]-->"));
    check("gallery edit: the export writes one figure with both attributes",
      /<figure class="gal-tile" data-w="4" data-priority="7" data-span="4">/.test(span) &&
      /<img src="img\/work\/tile-one\.png"/.test(span) &&
      (span.match(/<figure/g) || []).length === 1,
      span.replace(/\s+/g, " ").slice(0, 170));
    check("gallery edit: no seed and no empty slot reaches the file",
      !/img\/seed/.test(span) && !/data:image/.test(span),
      /img\/seed/.test(span) ? "a seed was exported" : "clean");
    const gx = exportIsByteExact("gallery.html", galHtml, ["gal-br"]);
    check("gallery edit: byte-identical outside the gallery region", gx.ok, gx.detail);
  }

  // GE4. the rule from Part 2 section 5, worth its own check: a packing
  // decision is about one viewport and never reaches the markup.
  const galPacked = await evaluate(`(() => {
    const fig = document.querySelector('.gal-tile');
    return { drawn: fig.style.gridColumn, authored: fig.getAttribute('data-span'),
             packed: fig.getAttribute('data-packed') || '' };
  })()`);
  check("gallery edit: what the packer draws is not what the file records",
    galPacked.authored === "4", JSON.stringify(galPacked));

  // GE5. deleting the last real image restores the seeds. Same rule as a
  // carousel, and the same code, because the core owns it.
  const galRestore = await evaluate(`(() => {
    const region = window.AMH.gallery.regions()[0];
    const before = region.model.length;
    const realConfirm = window.confirm;
    window.confirm = () => true;
    window.AMH.tool.openImage(region, 0);
    const del = [...document.querySelectorAll('.ced-modal__btns button')]
      .find(b => /delete/i.test(b.textContent));
    if (del) del.click();
    window.confirm = realConfirm;
    const tiles = [...document.querySelectorAll('.gal-tile')];
    return {
      before, after: region.model.length, tiles: tiles.length,
      seeds: tiles.filter(t => {
        const c = t.querySelector('.gal-tile__chip');
        return c && c.textContent === 'SEED';
      }).length,
    };
  })()`);
  check("gallery edit: deleting the last real image restores the seeds",
    galRestore.before === 1 && galRestore.after === 0 &&
    galRestore.tiles === 8 && galRestore.seeds === 8,
    JSON.stringify(galRestore));

  // GE6. the two new fields have to survive the pending store, which is the
  // path an edit takes when the user walks to another page and back. They go
  // through the export form, so a field the core dropped would come back as
  // undefined and the tile would silently lose its width.
  await evaluate(`(() => {
    const region = window.AMH.gallery.regions()[0];
    const en = window.AMH.tool.imageRegion.fromFile(
      new File([new Uint8Array([1])], 'carried.png', { type: 'image/png' }),
      null, region.kind);
    en.prefer = 3; en.priority = 5; en.caption = 'Carried';
    window.AMH.tool.imageRegion.append(region, en);
    window.AMH.tool.changed(region);
  })()`);
  await sleep(300);
  await send("Page.navigate", { url: PAGE });
  await waitLoaded();
  await sleep(1400);
  const carriedAway = await evaluate(`window.edit.pending()`);
  await send("Page.navigate", { url: `http://127.0.0.1:${SERVER_PORT}/gallery.html` });
  await waitLoaded();
  await sleep(1600);
  const carriedBack = await evaluate(`(() => {
    window.edit();
    const m = window.AMH.gallery.regions()[0].model;
    const t = m[m.length - 1];
    return { count: m.length, src: t.src, prefer: t.prefer,
             priority: t.priority, caption: t.caption };
  })()`);
  check("gallery edit: an edit survives the walk to another page",
    /1 unsaved change on 1 page/.test(carriedAway), carriedAway);
  check("gallery edit: and brings its width and priority back with it",
    carriedBack.src === "img/work/carried.png" && carriedBack.prefer === 3 &&
    carriedBack.priority === 5 && carriedBack.caption === "Carried",
    JSON.stringify(carriedBack));

  await evaluate(`window.edit.pending.clear(); window.edit()`);
  await sleep(400);
  await send("Emulation.clearDeviceMetricsOverride");

  // C-serve. The suite serves its OWN copy, with the blog emptied, so no check
  // depends on what the live site holds. If a stale server from an earlier run
  // still owns the port, the new one fails to bind in silence and every page
  // comes from the repo instead. That looks exactly like a code bug and is not
  // one, so it is caught here, once, by name.
  await send("Page.navigate", { url: BLOGPAGE });
  await waitLoaded();
  await sleep(900);
  const served = await evaluate(`(() => {
    const m = document.getElementById('blogManifest');
    return { manifest: m ? m.textContent.trim() : 'missing',
             posts: document.querySelectorAll('.bs-post').length };
  })()`);
  check("harness: the blog page under test is the suite's own empty copy",
    /^next-post:0001\s+next-img:0001$/.test(served.manifest) && served.posts === 0,
    JSON.stringify(served));

  // C-nav. A shared header means a nav link names its page. site.js has to
  // put that back: on the page a link names it is an in-page anchor, and the
  // URL bar shows the bare fragment, exactly as before the chrome was shared.
  await send("Page.navigate", { url: PAGE });
  await waitLoaded();
  await sleep(900);
  const navHome = await evaluate(`(() => {
    const work = [...document.querySelectorAll('.nav__links a')]
      .find((a) => a.textContent.trim() === 'Work');
    work.click();
    return {
      href: work.getAttribute('href'),
      hash: location.hash,
      scrolled: window.scrollY > 100,
      workTop: Math.round(document.getElementById('work').getBoundingClientRect().top),
      current: (document.querySelector('.nav__links a[aria-current="page"]') || {}).textContent || '',
    };
  })()`);
  check("nav: a page-qualified link is an in-page jump on the page it names",
    navHome.href === "index.html#work" && navHome.hash === "#work" &&
    navHome.scrolled && navHome.workTop >= 0 && navHome.workTop < 140,
    JSON.stringify(navHome));
  check("nav: the home page marks no nav item current",
    navHome.current === "", navHome.current);

  await send("Page.navigate", { url: BLOGPAGE });
  await waitLoaded();
  await sleep(900);
  const navBlog = await evaluate(`({
    current: (document.querySelector('.nav__links a[aria-current="page"]') || {}).textContent || '',
    contact: !!document.querySelector('#contact'),
  })`);
  check("nav: the blog page marks its own item current at load",
    navBlog.current === "Blog" && navBlog.contact, JSON.stringify(navBlog));

  // C-seo. Each page identifies itself, and every absolute URL agrees with
  // CNAME. A page that carried another page's canonical would look correct
  // and be invisible to a search engine.
  {
    const domain = readFileSync(join(REPO, "CNAME"), "utf-8").trim();
    const root = "https://" + domain + "/";
    const want = { "index.html": root, "gallery.html": root + "gallery.html",
                   "blog.html": root + "blog.html" };
    const seen = { canonical: [], og: [], title: [] };
    for (const page of MANAGED_PAGES) {
      const src = readFileSync(join(REPO, page), "utf-8");
      const can = (/<link rel="canonical" href="([^"]+)"/.exec(src) || [])[1];
      const og = (/<meta property="og:url" content="([^"]+)"/.exec(src) || [])[1];
      const title = (/<title>([^<]*)<\/title>/.exec(src) || [])[1];
      seen.canonical.push(can); seen.og.push(og); seen.title.push(title);
      check("seo: " + page + " has its own canonical and og:url, both at " + domain,
        can === want[page] && og === want[page], "canonical=" + can + " og=" + og);
    }
    check("seo: no two pages share a canonical, a URL or a title",
      new Set(seen.canonical).size === MANAGED_PAGES.length &&
      new Set(seen.og).size === MANAGED_PAGES.length &&
      new Set(seen.title).size === MANAGED_PAGES.length,
      seen.title.join(" | "));
  }

  // C7. the shared chrome is one set of bytes.
  //
  // The header and the contact section are on every managed page. Nothing
  // generates them: each page holds its own copy, and the editor writes an
  // edit to a shared region onto every page at once. That only works while
  // the copies are identical to begin with, so the suite holds them to it.
  const CHROME_SPANS = [
    ["header", '<header class="site-header"', "</header>"],
    ["contact section", '<section class="contact"', "</section>"],
  ];
  for (const [label, open, close] of CHROME_SPANS) {
    const spans = MANAGED_PAGES.map((page) => {
      const src = readFileSync(join(REPO, page), "utf-8");
      const i = src.indexOf(open);
      return i === -1 ? null : src.slice(i, src.indexOf(close, i) + close.length);
    });
    const same = spans.every((s) => s !== null && s === spans[0]);
    check("contract: every managed page carries the same " + label,
      same, same ? spans[0].length + " chars on " + MANAGED_PAGES.length + " pages"
                 : "differs: " + MANAGED_PAGES.join(" vs "));
  }

  // C8. the highlights block is marked machine-owned in the source. What
  // that marking DOES is covered further down, against a fixture region.
  const hlSrc = readFileSync(join(REPO, "index.html"), "utf-8");
  const hlOpen = hlSrc.slice(hlSrc.indexOf("<!--[edit:blog-highlights]-->"));
  check("contract: the highlights region is marked machine-owned",
    /^<!--\[edit:blog-highlights\]-->\s*<div[^>]*data-ced="generated"/.test(hlOpen),
    hlOpen.slice(0, 90).replace(/\s+/g, " "));

  // leave the browser on the home page for the groups that follow
  await send("Page.navigate", { url: PAGE });
  await waitLoaded();
  await sleep(800);
  exceptions.length = 0;

  // fresh load with exception collection active
  await send("Page.reload", { ignoreCache: true });
  await sleep(2500);

  // 1. page healthy, no editor UI for casual visitors
  const base = await evaluate(`({
    galleries: document.querySelectorAll('.gallery.is-ready').length,
    chips: document.querySelectorAll('.ced-chip').length,
    panel: !!document.querySelector('.ced-panel'),
    hasEdit: typeof window.edit === 'function',
  })`);
  check("page enhanced (galleries built)", base.galleries >= 7, "galleries=" + base.galleries);
  check("no page JS exceptions on load", exceptions.length === 0, exceptions.join(" | ").slice(0, 200));
  check("editor invisible for visitors", base.chips === 0 && !base.panel);
  check("edit() defined", base.hasEdit);

  // 2. activate editor mode
  const on = await evaluate(`window.edit()`);
  await sleep(400);   // let the badge overlay settle before querying chips
  const ui = await evaluate(`({
    chips: document.querySelectorAll('.ced-chip').length,
    rows: document.querySelectorAll('.ced-panel__row:not(.ced-panel__row--img)').length,
    imgRows: document.querySelectorAll('.ced-panel__row--img').length,
    imgChips: document.querySelectorAll('.ced-chip--img').length,
    plusChips: document.querySelectorAll('.ced-chip--plus').length,
    panel: !!document.querySelector('.ced-panel'),
  })`);
  check("edit() returns ON", on === "editor mode ON", String(on));
  check("panel lists all 87 text regions", ui.rows === 87, "rows=" + ui.rows);
  check("panel lists 9 gallery rows (all SEED)", ui.imgRows === 9, "imgRows=" + ui.imgRows);
  check("9 IMG chips + 9 plus chips built", ui.imgChips === 9 && ui.plusChips === 9,
    "img=" + ui.imgChips + " plus=" + ui.plusChips);
  check("badges shown for visible regions", ui.chips >= 70, "chips=" + ui.chips);
  // The site header is fixed, so a chip that scrolls to the top of the window
  // must pass BEHIND it rather than over the navigation. The fixed band runs
  // from 900 to 1000: header 900, drawer 940, progress bar 1000.
  const chipLayer = await evaluate(`(function () {
    var chip = getComputedStyle(document.querySelector('.ced-chip')).zIndex;
    var head = getComputedStyle(document.querySelector('.site-header')).zIndex;
    var panel = getComputedStyle(document.querySelector('.ced-panel')).zIndex;
    return { chip: +chip, head: +head, panel: +panel };
  })()`);
  check("badges pass behind the fixed header, and the panel still passes over it",
    chipLayer.chip < chipLayer.head && chipLayer.panel > chipLayer.head,
    JSON.stringify(chipLayer));
  // and a chip whose region is tall enough stops under the header rather than
  // sliding out of reach with it
  const chipFloor = await evaluate(`(function () {
    window.scrollTo(0, 1200);
    return new Promise(function (res) { setTimeout(function () {
      var hb = document.querySelector('.site-header').getBoundingClientRect().bottom;
      var seen = [...document.querySelectorAll('.ced-chip')]
        .filter(function (c) { return c.style.display !== 'none'; })
        .map(function (c) { return c.getBoundingClientRect(); })
        .filter(function (r) { return r.top >= 0 && r.top < innerHeight; });
      window.scrollTo(0, 0);
      res({ onScreen: seen.length, headerBottom: Math.round(hb),
            highest: seen.length ? Math.round(Math.min.apply(null, seen.map(function (r) { return r.top; }))) : -1 });
    }, 500); });
  })()`, { awaitPromise: true });
  check("a badge stops under the header instead of scrolling past it",
    chipFloor.onScreen > 0 && chipFloor.highest >= chipFloor.headerBottom - 2,
    JSON.stringify(chipFloor));
  await sleep(300);

  // 3. open hero-h1 modal via its badge chip
  await evaluate(`[...document.querySelectorAll('.ced-chip')].find(c => c.title === 'hero-h1').click()`);
  const modal = await evaluate(`({
    open: !!document.querySelector('.ced-modal'),
    value: document.querySelector('.ced-modal textarea')?.value || '',
    tools: document.querySelectorAll('.ced-tool').length,
  })`);
  check("modal opens from badge", modal.open);
  check("textarea prefilled with region innerHTML", modal.value.includes('ship the impossible'), modal.value.slice(0, 60));
  check("toolbar has 10 buttons", modal.tools === 10, "tools=" + modal.tools);

  // 4. apply an edit
  const NEW = 'I help ambitious teams <span class="hl">ship the TESTED impossible</span>.';
  await evaluate(`document.querySelector('.ced-modal textarea').value = ${JSON.stringify(NEW)}`);
  await evaluate(`document.querySelector('.ced-modal__btns .ced-btn--accent').click()`);
  const afterApply = await evaluate(`({
    h1: document.querySelector('.hero h1').textContent,
    status: document.querySelector('.ced-modal__status').textContent,
    dirtyRows: document.querySelectorAll('.ced-panel__row.ced-edited').length,
  })`);
  check("Apply updates live page", afterApply.h1.includes("TESTED"), afterApply.h1.trim().slice(0, 60));
  check("dirty indicator on region row", afterApply.dirtyRows === 1, "dirty=" + afterApply.dirtyRows);

  // 5. tag-balance check blocks a broken apply (auto-accepted confirm applies anyway; test detection text instead)
  await evaluate(`document.querySelector('.ced-modal textarea').value = '<strong>broken'`);
  // dialogs are auto-accepted, so it will apply; verify the confirm fired by checking the applied state then undo
  await evaluate(`document.querySelector('.ced-modal__btns .ced-btn--accent').click()`);
  await sleep(300);
  const broken = await evaluate(`document.querySelector('.hero h1').textContent`);
  check("unbalanced HTML still applies after confirm (dialog fired + accepted)", broken.includes("broken"), broken.trim().slice(0, 40));
  // restore good edit
  await evaluate(`document.querySelector('.ced-modal textarea').value = ${JSON.stringify(NEW)}`);
  await evaluate(`document.querySelector('.ced-modal__btns .ced-btn--accent').click()`);

  // 6. quicksave + restore
  await evaluate(`[...document.querySelectorAll('.ced-modal__btns .ced-btn')].find(b => b.textContent === 'Quicksave').click()`);
  const qs = await evaluate(`!!localStorage.getItem('amh-copy-editor-quicksave')`);
  check("quicksave writes the universal slot", qs);
  await evaluate(`document.querySelector('.ced-modal textarea').value = 'junk'`);
  await evaluate(`[...document.querySelectorAll('.ced-modal__btns .ced-btn')].find(b => b.textContent === 'Restore').click()`);
  await sleep(300);
  const restored = await evaluate(`document.querySelector('.ced-modal textarea').value`);
  check("restore pastes quicksave into textarea", restored.includes("TESTED"), restored.slice(0, 50));

  // close modal
  await evaluate(`[...document.querySelectorAll('.ced-modal__btns .ced-btn')].find(b => b.textContent === 'Cancel').click()`);

  // 6b. (X) close button — clean close (textarea unchanged) must NOT prompt
  await evaluate(`[...document.querySelectorAll('.ced-chip')].find(c => c.title === 'hero-h1').click()`);
  await sleep(150);
  const hasX = await evaluate(`!!document.querySelector('.ced-modal__x')`);
  check("modal has an (X) close button", hasX);
  let dc = dialogCount;
  await evaluate(`document.querySelector('.ced-modal__x').click()`);
  await sleep(200);
  const cleanClosed = await evaluate(`!document.querySelector('.ced-modal')`);
  check("X closes with NO prompt when textarea is unchanged", dialogCount === dc && cleanClosed,
    "dialogs=" + (dialogCount - dc) + " closed=" + cleanClosed);

  // 6c. (X) close button — unapplied changes must prompt, then close and discard
  await evaluate(`[...document.querySelectorAll('.ced-chip')].find(c => c.title === 'hero-h1').click()`);
  await sleep(150);
  await evaluate(`document.querySelector('.ced-modal textarea').value = 'unapplied scratch text that was never applied'`);
  dc = dialogCount;
  await evaluate(`document.querySelector('.ced-modal__x').click()`);
  await sleep(250);
  const afterX = await evaluate(`({
    closed: !document.querySelector('.ced-modal'),
    h1: document.querySelector('.hero h1').textContent,
  })`);
  check("X prompts once when there are unapplied changes", dialogCount === dc + 1, "dialogs=" + (dialogCount - dc));
  check("X (after confirm) closes and discards without applying", afterX.closed && afterX.h1.includes("TESTED"),
    "closed=" + afterX.closed + " h1=" + afterX.h1.trim().slice(0, 40));

  // 7. before/after view toggle
  const before = await evaluate(`window.edit.before() && document.querySelector('.hero h1').textContent`);
  check("edit.before() shows published copy", !before.includes("TESTED"), before.trim().slice(0, 50));
  const after = await evaluate(`window.edit.after() && document.querySelector('.hero h1').textContent`);
  check("edit.after() restores edits", after.includes("TESTED"));

  // 8. export: intercept the download anchor, capture the blob text
  await evaluate(`
    window.__exported = null;
    HTMLAnchorElement.prototype.click = function () {
      if (this.download) {
        fetch(this.href).then(r => r.text()).then(t => { window.__exported = t; });
      }
    };
    window.edit.export();
  `);
  let exported = null;
  for (let i = 0; i < 20 && !exported; i++) { await sleep(400); exported = await evaluate(`window.__exported`); }
  check("export produced output", !!exported, exported ? exported.length + " chars" : "none");

  if (exported) {
    const OPEN = "<!--[edit:hero-h1]-->", CLOSE = "<!--[/edit:hero-h1]-->";
    const eA = exported.indexOf(OPEN) + OPEN.length, eB = exported.indexOf(CLOSE);
    const innerNew = exported.slice(eA, eB);
    const exact = exportIsByteExact("index.html", exported, ["hero-h1"]);
    check("export: everything outside edited region byte-identical", exact.ok, exact.detail);
    check("export: edited innerHTML spliced in", innerNew.includes("TESTED") && innerNew.includes("<h1>") && innerNew.includes("</h1>"),
      innerNew.trim().slice(0, 80));
  }

  // ============ GALLERY / IMAGE TESTS ============
  const DROP_HELPER = `
    window.__drop = function (sel, names) {
      var holder = document.querySelector(sel);
      if (!holder) return "no holder: " + sel;
      var dt = new DataTransfer();
      names.forEach(function (n) {
        dt.items.add(new File([new Uint8Array(64)], n, { type: "image/png" }));
      });
      var ev;
      try { ev = new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }); } catch (e) {}
      if (!ev || !ev.dataTransfer) {
        ev = new Event("drop", { bubbles: true, cancelable: true });
        Object.defineProperty(ev, "dataTransfer", { value: dt });
      }
      holder.dispatchEvent(ev);
      return "dropped";
    };`;
  await evaluate(DROP_HELPER);
  const FR3 = `document.querySelectorAll('.work .gallery')[0]`;

  // G1. drop a file on the fr3 carousel: seeds vanish, modal opens in image mode
  const dropRes = await evaluate(`window.__drop('.work .gallery .gallery__holder', ['fr3-real.png'])`);
  await sleep(400);
  const g1 = await evaluate(`({
    stage: ${FR3}.querySelectorAll('.gallery__stage img').length,
    src: ${FR3}.querySelector('.gallery__stage img')?.src || '',
    modal: !!document.querySelector('.ced-modal--image'),
    chip: document.querySelector('.ced-chip--img')?.textContent || '',
  })`);
  check("drop replaces seeds with the real image (all-or-nothing)", dropRes === "dropped" && g1.stage === 1,
    "stage=" + g1.stage);
  check("dropped image previews from blob", g1.src.startsWith("blob:"), g1.src.slice(0, 24));
  check("image modal opens on drop", g1.modal);
  check("IMG chip tracks the new image", /^IMG\d\d$/.test(g1.chip), "chip=" + g1.chip);

  // G2. caption + alt via the modal
  await evaluate(`document.querySelector('.ced-modal textarea').value = 'Live capture of the real UI'`);
  await evaluate(`document.querySelector('.ced-modal__alt input').value = 'Forerunner 3 real interface'`);
  await evaluate(`document.querySelector('.ced-modal__btns .ced-btn--accent').click()`);
  await sleep(300);
  const g2 = await evaluate(`({
    cap: ${FR3}.querySelector('.gallery__stage img')?.getAttribute('data-caption') || '',
    alt: ${FR3}.querySelector('.gallery__stage img')?.getAttribute('alt') || '',
  })`);
  check("Apply writes caption + alt into the live gallery",
    g2.cap === "Live capture of the real UI" && g2.alt === "Forerunner 3 real interface",
    "cap=" + g2.cap + " alt=" + g2.alt);
  await evaluate(`[...document.querySelectorAll('.ced-modal__btns .ced-btn')].find(b => b.textContent === 'Cancel').click()`);

  // G3. (+) adds an empty slot and navigates to it
  await evaluate(`document.querySelector('.ced-chip--plus').click()`);
  await sleep(400);
  const g3 = await evaluate(`({
    stage: ${FR3}.querySelectorAll('.gallery__stage img').length,
    active: ${FR3}.querySelector('.gallery__stage img.is-active')?.src.slice(0, 14) || '',
    chip: document.querySelector('.ced-chip--img')?.textContent || '',
  })`);
  check("(+) adds an empty slot", g3.stage === 2, "stage=" + g3.stage);
  check("carousel navigates to the slot (drop-here tile active)",
    g3.active.startsWith("data:image/svg") && g3.chip === "DROP",
    "active=" + g3.active + " chip=" + g3.chip);

  // G4. delete the empty slot from its modal
  await evaluate(`document.querySelector('.ced-chip--img').click()`);
  await sleep(200);
  await evaluate(`document.querySelector('.ced-modal__btns .ced-btn--danger').click()`);
  await sleep(300);
  const g4 = await evaluate(`${FR3}.querySelectorAll('.gallery__stage img').length`);
  check("Delete removes the empty slot", g4 === 1, "stage=" + g4);

  // G5. export splices the gallery; everything outside edited regions intact
  await evaluate(`window.__exported = null; window.edit.export();`);
  let exported2 = null;
  for (let i = 0; i < 20 && !exported2; i++) { await sleep(400); exported2 = await evaluate(`window.__exported`); }
  check("gallery export produced output", !!exported2, exported2 ? exported2.length + " chars" : "none");
  if (exported2) {
    const galA = exported2.indexOf("<!--[edit:fr3-gallery]-->");
    const galB = exported2.indexOf("<!--[/edit:fr3-gallery]-->");
    const galSpan = exported2.slice(galA, galB);
    check("exported gallery holds the img/work path + caption + alt",
      galSpan.includes('src="img/work/fr3-real.png"') &&
      galSpan.includes('data-caption="Live capture of the real UI"') &&
      galSpan.includes('alt="Forerunner 3 real interface"') &&
      !galSpan.includes("img/seed/"),
      galSpan.replace(/\s+/g, " ").slice(0, 140));
    const exact2 = exportIsByteExact("index.html", exported2, ["hero-h1", "fr3-gallery"]);
    check("gallery export: byte-identical outside edited regions", exact2.ok, exact2.detail);
  }

  // G6. deep-dive: open drawer, drop, check template; then edit dd text too
  await evaluate(`[...document.querySelectorAll('.project__more')][0].click()`);
  await sleep(600);
  const dd0 = await evaluate(`({
    open: document.body.classList.contains('dd-open'),
    built: !!document.querySelector('.dd__body .gallery.is-ready'),
    seedShown: (document.querySelector('.dd__body .gallery__stage img')?.getAttribute('src') || '').includes('img/seed/'),
  })`);
  check("drawer opens with its seed gallery built", dd0.open && dd0.built && dd0.seedShown,
    JSON.stringify(dd0));
  await evaluate(`window.__drop('.dd__body .gallery .gallery__holder', ['dd-real.png'])`);
  await sleep(400);
  const dd1 = await evaluate(`({
    tplSrc: document.querySelectorAll('template.deepdive')[0].content.querySelector('.gallery img')?.getAttribute('src') || '',
    drawerSrc: document.querySelector('.dd__body .gallery__stage img')?.src || '',
    modal: !!document.querySelector('.ced-modal--image'),
  })`);
  check("dd drop updates the template with the img/work path", dd1.tplSrc === "img/work/dd-real.png", dd1.tplSrc);
  check("dd drop previews live in the drawer", dd1.drawerSrc.startsWith("blob:"), dd1.drawerSrc.slice(0, 24));
  check("dd drop opens the image modal", dd1.modal);
  await evaluate(`document.querySelector('.ced-modal textarea').value = 'Real orbital scene'`);
  await evaluate(`document.querySelector('.ced-modal__btns .ced-btn--accent').click()`);
  await sleep(200);
  await evaluate(`[...document.querySelectorAll('.ced-modal__btns .ced-btn')].find(b => b.textContent === 'Cancel').click()`);
  // also edit the deepdive TEXT region (nested-marker case)
  await evaluate(`[...document.querySelectorAll('.ced-panel__row')].find(r => r.textContent.includes('fr3-deepdive')).click()`);
  await sleep(200);
  await evaluate(`
    var t = document.querySelector('.ced-modal textarea');
    t.value = t.value.replace('Forerunner 3 is built', 'Forerunner 3 is TESTEDDD built');
  `);
  await evaluate(`document.querySelector('.ced-modal__btns .ced-btn--accent').click()`);
  await sleep(200);
  await evaluate(`[...document.querySelectorAll('.ced-modal__btns .ced-btn')].find(b => b.textContent === 'Cancel').click()`);

  // G7. export with nested regions both edited
  await evaluate(`window.__exported = null; window.edit.export();`);
  let exported3 = null;
  for (let i = 0; i < 20 && !exported3; i++) { await sleep(400); exported3 = await evaluate(`window.__exported`); }
  check("nested export produced output", !!exported3);
  if (exported3) {
    const ddA = exported3.indexOf("<!--[edit:fr3-deepdive]-->");
    const ddB = exported3.indexOf("<!--[/edit:fr3-deepdive]-->");
    const ddSpan = exported3.slice(ddA, ddB);
    check("deepdive span carries the text edit AND the dd image",
      ddSpan.includes("TESTEDDD built") &&
      ddSpan.includes('src="img/work/dd-real.png"') &&
      ddSpan.includes('data-caption="Real orbital scene"'),
      ddSpan.replace(/\s+/g, " ").slice(0, 120));
    const exact3 = exportIsByteExact("index.html", exported3,
      ["hero-h1", "fr3-gallery", "fr3-deepdive"]);
    check("nested export: byte-identical outside edited regions", exact3.ok, exact3.detail);
  }
  // close the drawer for the remaining tests
  await evaluate(`document.querySelector('.dd__close')?.click()`);
  await sleep(300);

  // G8. delete the last real project image: seeds return
  await evaluate(`document.querySelector('.ced-chip--img').click()`);
  await sleep(200);
  await evaluate(`document.querySelector('.ced-modal__btns .ced-btn--danger').click()`);
  await sleep(400);
  const g8 = await evaluate(`({
    stage: ${FR3}.querySelectorAll('.gallery__stage img').length,
    firstSrc: ${FR3}.querySelector('.gallery__stage img')?.getAttribute('src') || '',
  })`);
  check("deleting the last real image restores the seed placeholders",
    g8.stage === 3 && g8.firstSrc.includes("img/seed/"),
    "stage=" + g8.stage + " src=" + g8.firstSrc);

  // 9. revertAll (confirm auto-accepted)
  await evaluate(`window.edit.revertAll()`);
  await sleep(300);
  const reverted = await evaluate(`({
    h1: document.querySelector('.hero h1').textContent,
    dirty: document.querySelectorAll('.ced-panel__row.ced-edited').length,
    ddTplSrc: document.querySelectorAll('template.deepdive')[0].content.querySelector('.gallery img')?.getAttribute('src') || '',
    ddText: document.querySelectorAll('template.deepdive')[0].innerHTML.includes('TESTEDDD'),
  })`);
  check("revertAll restores published copy", !reverted.h1.includes("TESTED") && reverted.dirty === 0,
    "dirty=" + reverted.dirty);
  check("revertAll restores the dd gallery seed + dd text",
    reverted.ddTplSrc.includes("img/seed/") && !reverted.ddText,
    "src=" + reverted.ddTplSrc);

  // 10. clear + exit
  const cleared = await evaluate(`window.edit.clear() && !localStorage.getItem('amh-copy-editor-quicksave')`);
  check("edit.clear() wipes quicksave", !!cleared);
  await evaluate(`window.edit()`);
  const off = await evaluate(`({
    chips: document.querySelectorAll('.ced-chip').length,
    panel: !!document.querySelector('.ced-panel'),
  })`);
  check("exit removes all editor UI", off.chips === 0 && !off.panel);

  // ============ LIGHTBOX INTERFACE ============
  // Phase 2 Part 2 gave the viewer an interface that takes a list of items
  // rather than DOM nodes, so the Phase 4 tile grid can reuse it. These pin
  // that shape before the tile grid exists.
  const lb = await evaluate(`({
    open: typeof AMH.work.lightbox.open,
    close: typeof AMH.work.lightbox.close,
    isOpen: typeof AMH.work.lightbox.isOpen,
    closedNow: AMH.work.lightbox.isOpen(),
  })`);
  check("lightbox: published with open, close and isOpen",
    lb.open === "function" && lb.close === "function" && lb.isOpen === "function" && lb.closedNow === false,
    JSON.stringify(lb));

  // the tile-grid case: plain items, navigation suppressed, own label
  const lbOpened = await evaluate(`AMH.work.lightbox.open(
    [{ src: "img/seed/forerunner-01.jpg", caption: "Tile caption", alt: "Tile alt" },
     { src: "img/seed/forerunner-02.jpg", caption: "Second", alt: "Second alt" }],
    0, { nav: false, label: "Gallery viewer" })`);
  await sleep(500);
  const lbTile = await evaluate(`({
    isOpen: AMH.work.lightbox.isOpen(),
    caption: document.querySelector('.lightbox__caption').textContent,
    alt: document.querySelector('.lightbox__img--active').getAttribute('alt'),
    src: document.querySelector('.lightbox__img--active').getAttribute('src'),
    navHidden: document.querySelector('.lightbox__nav--next').style.display === "none",
    label: document.querySelector('.lightbox').getAttribute('aria-label'),
    locked: document.body.classList.contains('lb-open'),
  })`);
  check("lightbox: opens on a plain item list, with no DOM node involved",
    lbOpened === true && lbTile.isOpen && lbTile.caption === "Tile caption" &&
    lbTile.alt === "Tile alt" && lbTile.src === "img/seed/forerunner-01.jpg" && lbTile.locked,
    JSON.stringify(lbTile));
  check("lightbox: opts.nav false hides navigation, opts.label names the dialog",
    lbTile.navHidden && lbTile.label === "Gallery viewer",
    "navHidden=" + lbTile.navHidden + " label=" + lbTile.label);
  await evaluate(`AMH.work.lightbox.close()`);
  await sleep(300);
  check("lightbox: close releases the scroll lock",
    (await evaluate(`AMH.work.lightbox.isOpen() || document.body.classList.contains('lb-open')`)) === false);
  check("lightbox: open with nothing to show returns false and stays closed",
    (await evaluate(`AMH.work.lightbox.open([], 0, {}) === false && !AMH.work.lightbox.isOpen()`)) === true);

  // it layers over the drawer rather than replacing it: both locks are held,
  // and closing the viewer leaves the drawer where it was
  await evaluate(`document.querySelectorAll('.project__more')[0].click()`);
  await sleep(1000);
  await evaluate(`document.querySelector('.dd__body .gallery__holder').click()`);
  await sleep(600);
  const lbNested = await evaluate(`["dd-open","lb-open"].filter(function (c) {
    return document.body.classList.contains(c); }).join("+")`);
  await evaluate(`document.querySelector('.lightbox__close').click()`);
  await sleep(500);
  const lbAfter = await evaluate(`["dd-open","lb-open"].filter(function (c) {
    return document.body.classList.contains(c); }).join("+")`);
  check("lightbox: layers over the drawer, and closing it leaves the drawer open",
    lbNested === "dd-open+lb-open" && lbAfter === "dd-open",
    "nested=" + lbNested + " after=" + lbAfter);
  await evaluate(`document.querySelector('.dd__close').click()`);
  await sleep(400);

  // ============ MULTI-PAGE PUBLISH ============
  // Phase 2 Part 3 turned a page editor into a site editor. gallery.html and
  // blog.html do not exist yet, so a fixture page stands in for the second
  // page and these checks prove the paths before Phase 3 depends on them.
  const FX = "tools/e2e/fixtures/page2.html";
  await send("Page.navigate", { url: PAGE });
  await waitLoaded();
  await sleep(1000);
  await evaluate(ZIP_CAPTURE);

  // a machine-owned region, injected before the editor's one-time scan
  await evaluate(`(function () {
    var host = document.querySelector('main') || document.body;
    host.appendChild(document.createComment('[edit:fx-generated]'));
    var el = document.createElement('div');
    el.id = 'fxGenerated';
    el.setAttribute('data-ced', 'generated');
    el.textContent = 'Written by the publisher.';
    host.appendChild(el);
    host.appendChild(document.createComment('[/edit:fx-generated]'));
  })()`);
  await evaluate(`window.edit()`);
  await sleep(500);
  await evaluate(`AMH.tool.pages.push({ path: ${JSON.stringify(FX)}, label: "Fixture" })`);

  // M1. the list is enforced
  check("multi-page: staging an edit for an unmanaged page is refused",
    (await evaluate(`AMH.tool.stage("not-a-page.html", "fx-one", "<p>x</p>")`)) === false);
  check("multi-page: staging for a listed page is accepted",
    (await evaluate(`AMH.tool.stage(${JSON.stringify(FX)}, "fx-one", '<p class="fx">STAGED ONE</p>')`)) === true);

  // M2. a page nobody edited is never written
  await evaluate(`window.__zipB64 = null; window.edit.export()`);
  let m2 = null;
  for (let i = 0; i < 25 && !m2; i++) { await sleep(400); m2 = await evaluate(`window.__zipB64`); }
  const m2text = m2 ? Buffer.from(m2, "base64").toString("utf8") : "";
  check("multi-page: only the staged page is written when the current page is clean",
    m2text.indexOf("STAGED ONE") >= 0 && m2text.indexOf("<!--[edit:fx-two]-->") >= 0 &&
    m2text.indexOf("PK") !== 0,
    m2text ? m2text.length + " chars, html not zip" : "nothing captured");
  const fxSrc = readFileSync(join(REPO, FX), "utf-8");
  check("multi-page: the staged page is byte-identical outside its edited region",
    stripSpans(m2text, ["fx-one"]) === stripSpans(fxSrc, ["fx-one"]));

  // M3. two pages changed travel together in one zip
  await evaluate(`[...document.querySelectorAll('.ced-chip')].find(c => c.title === 'hero-h1').click()`);
  await sleep(200);
  await evaluate(`document.querySelector('.ced-modal textarea').value =
    'I help ambitious teams <span class="hl">ship the MULTIPAGE impossible</span>.'`);
  await evaluate(`document.querySelector('.ced-modal__btns .ced-btn--accent').click()`);
  await sleep(300);
  await evaluate(`document.querySelector('.ced-modal__x').click()`);
  await sleep(200);
  await evaluate(`window.__zipB64 = null; window.edit.export()`);
  let m3 = null;
  for (let i = 0; i < 25 && !m3; i++) { await sleep(400); m3 = await evaluate(`window.__zipB64`); }
  const m3zip = m3 ? unzipStore(Buffer.from(m3, "base64")) : null;
  const m3names = m3zip ? Object.keys(m3zip).sort() : [];
  check("multi-page: two changed pages ship in one publish.zip",
    JSON.stringify(m3names) === JSON.stringify([FX, "index.html"].sort()), m3names.join(", "));
  if (m3zip) {
    const idxOut = m3zip["index.html"].toString("utf8");
    const fxOut = m3zip[FX].toString("utf8");
    check("multi-page: each page in the zip carries its own edit",
      idxOut.indexOf("MULTIPAGE") >= 0 && fxOut.indexOf("STAGED ONE") >= 0);
    const exact = exportIsByteExact("index.html", idxOut, ["hero-h1"]);
    check("multi-page: index.html byte-identical outside its edited region", exact.ok, exact.detail);
    check("multi-page: the fixture page byte-identical outside its edited region",
      stripSpans(fxOut, ["fx-one"]) === stripSpans(fxSrc, ["fx-one"]));
  }

  // M4. a machine-owned region is listed, read-only, and refuses Apply
  const genRow = await evaluate(`(function () {
    var row = [...document.querySelectorAll('.ced-panel__row')]
      .find(function (r) { return r.textContent.indexOf('fx-generated') >= 0; });
    if (!row) return null;
    var note = row.textContent.indexOf('(generated)') >= 0;
    row.click();
    return { note: note };
  })()`);
  await sleep(300);
  const gen = await evaluate(`({
    found: !!document.querySelector('.ced-modal'),
    readOnly: document.querySelector('.ced-modal textarea').readOnly,
    status: document.querySelector('.ced-modal__status').textContent,
  })`);
  const modalTools = await evaluate(`(() => {
    const tools = [...document.querySelectorAll('.ced-modal__tools .ced-tool')];
    return { count: tools.length, stops: tools.filter(b => b.tabIndex !== -1).length };
  })()`);
  check("region modal: it shares the toolbar, so that is skipped here too",
    modalTools.count > 0 && modalTools.stops === 0,
    modalTools.count + " buttons, " + modalTools.stops + " of them tab stops");

  check("machine-owned: the panel marks the region generated", !!(genRow && genRow.note));
  check("machine-owned: the editor opens it read-only and says who owns it",
    gen.found && gen.readOnly === true && /publisher/i.test(gen.status),
    "readOnly=" + gen.readOnly + " status=" + gen.status.slice(0, 60));
  await evaluate(`document.querySelector('.ced-modal textarea').readOnly = false;
    document.querySelector('.ced-modal textarea').value = 'HAND EDITED'`);
  await evaluate(`document.querySelector('.ced-modal__btns .ced-btn--accent').click()`);
  await sleep(300);
  const genAfter = await evaluate(`({
    live: document.getElementById('fxGenerated').textContent,
    status: document.querySelector('.ced-modal__status').textContent,
  })`);
  check("machine-owned: Apply is refused and the block is untouched",
    genAfter.live === "Written by the publisher." && /publisher owns/i.test(genAfter.status),
    "live=" + genAfter.live + " status=" + genAfter.status.slice(0, 60));
  await evaluate(`document.querySelector('.ced-modal__x').click()`);
  await sleep(200);

  // ---- pending edits across pages ----
  // The hero-h1 edit above is still applied. From here it has to survive a
  // reload, be counted, be listed, and then be cleared, because the blog tests
  // that follow expect the published bytes.
  const pend1 = await evaluate(`({
    stored: !!sessionStorage.getItem('amh-pending-edits'),
    count: window.edit.pending(),
    chip: document.querySelector('.ced-pending') ?
      { text: document.querySelector('.ced-pending').textContent,
        hidden: document.querySelector('.ced-pending').hidden } : null,
  })`);
  check("pending: an applied edit is written to sessionStorage",
    pend1.stored === true && /1 unsaved change on 1 page/.test(pend1.count), pend1.count);
  check("pending: the chip shows the count and is visible",
    !!pend1.chip && pend1.chip.hidden === false && /1 unsaved change on 1 page/.test(pend1.chip.text),
    JSON.stringify(pend1.chip));

  // it survives a reload, and the page comes back showing the edit
  await send("Page.navigate", { url: PAGE });
  await waitLoaded();
  await sleep(1800);
  const pend2 = await evaluate(`({
    h1: document.querySelector('.hero h1').textContent,
    stored: !!sessionStorage.getItem('amh-pending-edits'),
  })`);
  check("pending: the edit is re-applied to the page after a reload",
    pend2.h1.indexOf("MULTIPAGE") >= 0 && pend2.stored, pend2.h1.trim().slice(0, 50));

  // a stale slug that no longer exists is dropped rather than applied
  await evaluate(`(function () {
    var all = JSON.parse(sessionStorage.getItem('amh-pending-edits'));
    all["index.html"].text["no-such-slug"] = "<p>orphan</p>";
    sessionStorage.setItem('amh-pending-edits', JSON.stringify(all));
  })()`);
  await send("Page.navigate", { url: PAGE });
  await waitLoaded();
  await sleep(1800);
  const pend3 = await evaluate(`({
    h1: document.querySelector('.hero h1').textContent,
    hasOrphan: (sessionStorage.getItem('amh-pending-edits') || "").indexOf("no-such-slug") >= 0,
  })`);
  check("pending: a slug that no longer exists is dropped, not applied",
    pend3.hasOrphan === false && pend3.h1.indexOf("MULTIPAGE") >= 0,
    "orphanKept=" + pend3.hasOrphan);

  // clear-all empties the store and puts the page back
  await evaluate(`window.edit()`);
  await sleep(400);
  const pendCleared = await evaluate(`window.edit.pending.clear()`);
  await sleep(400);
  const pend4 = await evaluate(`({
    h1: document.querySelector('.hero h1').textContent,
    stored: !!sessionStorage.getItem('amh-pending-edits'),
    chipHidden: document.querySelector('.ced-pending') ?
      document.querySelector('.ced-pending').hidden : null,
  })`);
  check("pending: clear-all empties the store and restores the published page",
    /discarded/.test(pendCleared) && pend4.stored === false &&
    pend4.h1.indexOf("MULTIPAGE") === -1, pendCleared + " | " + pend4.h1.trim().slice(0, 40));
  check("pending: the chip hides again at zero", pend4.chipHidden === true);
  await evaluate(`window.edit()`);

  // ---- the round trip: edit here, navigate, edit there, publish once ----
  const FXURL = `http://127.0.0.1:${SERVER_PORT}/` + FX;
  const registerFx = `AMH.tool.pages.push({ path: ${JSON.stringify(FX)}, label: "Fixture" })`;

  // an edit on the home page
  await evaluate(`window.edit()`);
  await sleep(400);
  await evaluate(`[...document.querySelectorAll('.ced-chip')].find(c => c.title === 'hero-h1').click()`);
  await sleep(200);
  await evaluate(`document.querySelector('.ced-modal textarea').value =
    'I help ambitious teams <span class="hl">ship the ROUNDTRIP impossible</span>.'`);
  await evaluate(`document.querySelector('.ced-modal__btns .ced-btn--accent').click()`);
  await sleep(300);
  await evaluate(`document.querySelector('.ced-modal__x').click()`);
  await sleep(200);

  // walk to the second page and edit that one
  await send("Page.navigate", { url: FXURL });
  await waitLoaded();
  await sleep(1600);
  await evaluate(registerFx);
  const onFx = await evaluate(`({
    page: AMH.tool.pages.length,
    regions: (window.edit(), document.querySelectorAll('.ced-panel__row').length),
  })`);
  await sleep(400);
  await evaluate(`[...document.querySelectorAll('.ced-panel__row')]
    .find(r => r.textContent.indexOf('fx-two') >= 0).click()`);
  await sleep(300);
  await evaluate(`document.querySelector('.ced-modal textarea').value = '<p class="fx">EDITED ON PAGE TWO</p>'`);
  await evaluate(`document.querySelector('.ced-modal__btns .ced-btn--accent').click()`);
  await sleep(300);
  await evaluate(`document.querySelector('.ced-modal__x').click()`);
  await sleep(200);
  const fxPend = await evaluate(`window.edit.pending()`);
  check("round trip: the editor runs on the second page and both edits are pending",
    onFx.regions >= 2 && /2 unsaved changes on 2 pages/.test(fxPend),
    "rows=" + onFx.regions + " pending=" + fxPend);

  // walk back, and the home page edit is still there
  await send("Page.navigate", { url: PAGE });
  await waitLoaded();
  await sleep(1800);
  await evaluate(registerFx);
  await evaluate(ZIP_CAPTURE);
  const back = await evaluate(`({
    h1: document.querySelector('.hero h1').textContent,
    pending: window.edit.pending(),
  })`);
  check("round trip: walking back restores the home page edit and still counts both",
    back.h1.indexOf("ROUNDTRIP") >= 0 && /2 unsaved changes on 2 pages/.test(back.pending),
    back.pending);

  // one publish, both pages
  await evaluate(`window.__zipB64 = null; window.edit.export()`);
  let rt = null;
  for (let i = 0; i < 25 && !rt; i++) { await sleep(400); rt = await evaluate(`window.__zipB64`); }
  const rtzip = rt ? unzipStore(Buffer.from(rt, "base64")) : null;
  const rtnames = rtzip ? Object.keys(rtzip).sort() : [];
  check("round trip: one publish.zip carries both pages",
    JSON.stringify(rtnames) === JSON.stringify([FX, "index.html"].sort()), rtnames.join(", "));
  if (rtzip) {
    const idx = rtzip["index.html"].toString("utf8");
    const fx = rtzip[FX].toString("utf8");
    check("round trip: each page carries the edit made on it",
      idx.indexOf("ROUNDTRIP") >= 0 && fx.indexOf("EDITED ON PAGE TWO") >= 0);
    const e1 = exportIsByteExact("index.html", idx, ["hero-h1"]);
    check("round trip: home page byte-identical outside its region", e1.ok, e1.detail);
    check("round trip: second page byte-identical outside its region",
      stripSpans(fx, ["fx-two"]) === stripSpans(readFileSync(join(REPO, FX), "utf-8"), ["fx-two"]));
  }

  // ---- the file hand-off, the path a page opened from disk takes ----
  // A1. the first hand-off dialog of a page load points at the folder button
  await evaluate(`window.__handoff = AMH.tool.handOff("index.html", new Error("fetch refused"))`);
  await sleep(1400);
  const firstAsk = await evaluate(`(function () {
    var pt = document.querySelector('.ced-point');
    if (!pt) return { arrow: false };
    var btn = [...document.querySelectorAll('.ced-handoff .ced-modal__btns button')]
      .find(function (b) { return /repo folder/.test(b.textContent); });
    var b = btn.getBoundingClientRect();
    var curve = pt.querySelector('.ced-point__curve');
    var tipLocal = curve.getPointAtLength(curve.getTotalLength());
    var tip = tipLocal.matrixTransform(curve.getScreenCTM());
    var lbl = pt.querySelector('.ced-point__label').getBoundingClientRect();
    return { arrow: true, on: pt.classList.contains('is-on'),
             dx: Math.round(tip.x - (b.left + b.width / 2)), dy: Math.round(tip.y - b.bottom),
             label: pt.querySelector('.ced-point__label').textContent,
             inView: lbl.left >= 0 && lbl.right <= innerWidth && lbl.top >= 0 && lbl.bottom <= innerHeight,
             offset: getComputedStyle(curve).strokeDashoffset };
  })()`);
  check("arrow: the first hand-off points at \"Use my repo folder\", tip under its centre, label on screen",
    firstAsk.arrow && firstAsk.on && Math.abs(firstAsk.dx) <= 2 && firstAsk.dy >= 4 && firstAsk.dy <= 9 &&
    firstAsk.label === "Click and choose root of repo folder!" && firstAsk.inView &&
    parseFloat(firstAsk.offset) === 0,
    JSON.stringify(firstAsk));

  const wrongName = await evaluate(`(function () {
    var zone = document.querySelector('.ced-handoff__zone');
    if (!zone) return "no zone";
    var dt = new DataTransfer();
    dt.items.add(new File(["<html></html>"], "wrong-name.html", { type: "text/html" }));
    zone.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
    return document.querySelector('.ced-handoff__zone').className;
  })()`);
  await sleep(300);
  const wrongNote = await evaluate(`document.querySelector('.ced-modal__status').textContent`);
  check("hand-off: a file with the wrong name is rejected and named",
    /is-wrong/.test(wrongName) && /wrong-name\.html/.test(wrongNote) && /index\.html/.test(wrongNote),
    wrongNote.slice(0, 80));

  await evaluate(`(function () {
    var zone = document.querySelector('.ced-handoff__zone');
    var dt = new DataTransfer();
    dt.items.add(new File(["<html>HANDED OVER</html>"], "index.html", { type: "text/html" }));
    zone.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
  })()`);
  await sleep(600);
  const handed = await evaluate(`window.__handoff.then(function (txt) {
    return { text: txt, gone: !document.querySelector('.ced-handoff__zone') }; })`,
    { awaitPromise: true });
  check("hand-off: the right file is read with the File API and closes the prompt",
    handed && handed.text === "<html>HANDED OVER</html>" && handed.gone === true,
    JSON.stringify(handed).slice(0, 90));
  const leaving = await evaluate(`(function () {
    var p = document.querySelector('.ced-point');
    return !p || p.classList.contains('is-off'); })()`);
  await sleep(720);
  check("arrow: it leaves with the dialog, through its exit",
    leaving && await evaluate(`!document.querySelector('.ced-point')`));

  // A2. placement and geometry, on targets the page has. The head is turned
  // to the curve's direction at the tip, and the label never leaves the screen.
  const geo = await evaluate(`(function () {
    function measure(target) {
      AMH.tool.point(target, "Click here first");
      var pt = document.querySelector('.ced-point');
      var curve = pt.querySelector('.ced-point__curve');
      var L = curve.getTotalLength();
      var m = curve.getScreenCTM();
      var tip = curve.getPointAtLength(L).matrixTransform(m);
      var near = curve.getPointAtLength(L - 2).matrixTransform(m);
      var want = Math.atan2(tip.y - near.y, tip.x - near.x) * 180 / Math.PI;
      var rot = parseFloat(/rotate\\(([-\\d.]+)/.exec(pt.querySelector('.ced-point__head').getAttribute('transform'))[1]);
      var lbl = pt.querySelector('.ced-point__label').getBoundingClientRect();
      var b = target.getBoundingClientRect();
      var side = Math.abs(tip.y - b.bottom - 6) < 3 ? "below" : Math.abs(tip.y - b.top + 6) < 3 ? "above"
        : tip.x > b.right ? "right" : "left";
      var diff = Math.abs(((rot - want) + 540) % 360 - 180);
      // where the head is DRAWN, not where its attribute says: a CSS
      // transform once overrode the attribute and left it at the box origin
      var hb = pt.querySelector('.ced-point__head').getBoundingClientRect();
      var headDist = Math.hypot(hb.left + hb.width / 2 - tip.x, hb.top + hb.height / 2 - tip.y);
      // the words must not touch the stroke or the target: sample the curve
      // every 3px and look for a sample inside the label's box, grown by 3px
      var hit = 0;
      for (var q = 0; q <= L; q += 3) {
        var sp = curve.getPointAtLength(q).matrixTransform(m);
        if (sp.x >= lbl.left - 3 && sp.x <= lbl.right + 3 && sp.y >= lbl.top - 3 && sp.y <= lbl.bottom + 3) hit++;
      }
      var overTarget = !(lbl.right < b.left || lbl.left > b.right || lbl.bottom < b.top || lbl.top > b.bottom);
      return { side: side, headOff: Math.round(diff * 10) / 10, headDist: Math.round(headDist),
               strokeHits: hit, overTarget: overTarget,
               inView: lbl.left >= 0 && lbl.right <= innerWidth && lbl.top >= 0 && lbl.bottom <= innerHeight,
               tipDx: Math.round(tip.x - (b.left + b.width / 2)) };
    }
    var out = {};
    // a target near the right edge: the tail must swing to the open side
    var edge = document.createElement('button');
    edge.textContent = 'edge'; edge.style.cssText = 'position:fixed;right:6px;top:200px;';
    document.body.appendChild(edge);
    out.edge = measure(edge);
    // a target at the bottom of the screen: no room below, so a side
    var low = document.createElement('button');
    low.textContent = 'low'; low.style.cssText = 'position:fixed;left:40%;bottom:4px;';
    document.body.appendChild(low);
    out.low = measure(low);
    // a plain target with room below
    var mid = document.createElement('button');
    mid.textContent = 'mid'; mid.style.cssText = 'position:fixed;left:40%;top:200px;';
    document.body.appendChild(mid);
    out.mid = measure(mid);
    AMH.tool.unpoint(true);
    edge.remove(); low.remove(); mid.remove();
    out.gone = !document.querySelector('.ced-point');
    return out;
  })()`);
  check("arrow: below when there is room, mirrored at an edge, a side when there is none",
    geo.mid.side === "below" && geo.edge.side === "below" && geo.edge.inView &&
    (geo.low.side === "right" || geo.low.side === "left") && Math.abs(geo.mid.tipDx) <= 2,
    JSON.stringify(geo));
  check("arrow: the head is turned to the curve's own direction at the tip",
    geo.mid.headOff <= 2 && geo.edge.headOff <= 2 && geo.low.headOff <= 2,
    JSON.stringify({ mid: geo.mid.headOff, edge: geo.edge.headOff, low: geo.low.headOff }));
  check("arrow: the head is drawn at the tip, not at the box origin",
    geo.mid.headDist <= 14 && geo.edge.headDist <= 14 && geo.low.headDist <= 14,
    JSON.stringify({ mid: geo.mid.headDist, edge: geo.edge.headDist, low: geo.low.headDist }));
  check("arrow: the label stays on screen in every placement",
    geo.mid.inView && geo.edge.inView && geo.low.inView && geo.gone, JSON.stringify(geo));
  check("arrow: the words never touch the stroke or cover the target",
    geo.mid.strokeHits === 0 && geo.edge.strokeHits === 0 && geo.low.strokeHits === 0 &&
    !geo.mid.overTarget && !geo.edge.overTarget && !geo.low.overTarget,
    JSON.stringify({ mid: [geo.mid.strokeHits, geo.mid.overTarget], edge: [geo.edge.strokeHits, geo.edge.overTarget],
                     low: [geo.low.strokeHits, geo.low.overTarget] }));

  // A4. the entrance is staged: head, then the stroke from the tip back to
  // the tail, then the label written out under a clip that opens
  const staged = await evaluate(`(function () {
    var b = document.createElement('button');
    b.textContent = 'stage'; b.style.cssText = 'position:fixed;left:40%;top:220px;';
    document.body.appendChild(b);
    AMH.tool.point(b, "Click here first");
    var pt = document.querySelector('.ced-point');
    var curve = pt.querySelector('.ced-point__curve'), head = pt.querySelector('.ced-point__head');
    var lbl = pt.querySelector('.ced-point__label');
    var L = curve.getTotalLength();
    function snap() {
      return { head: parseFloat(getComputedStyle(head).opacity),
               drawn: 1 - Math.abs(parseFloat(getComputedStyle(curve).strokeDashoffset)) / L,
               clip: getComputedStyle(lbl).clipPath };
    }
    var out = { len: Math.round(L), t0: snap() };
    return new Promise(function (res) {
      setTimeout(function () { out.t1 = snap(); }, 120);
      setTimeout(function () { out.t2 = snap(); }, 480);
      setTimeout(function () { out.t3 = snap(); b.remove(); res(out); }, 1400);
    });
  })()`, { awaitPromise: true });
  // Chrome serializes the open inset as its two-value shorthand
  const clipOpen = /inset\(-30% -6%( -30% -6%)?\)/.test(staged.t3.clip);
  const clipShut = /inset\(-30% 100% -30% -6%\)/.test(staged.t0.clip);
  check("arrow: head first, then the stroke draws back to the tail, then the label writes out",
    staged.t0.head === 0 && staged.t0.drawn <= 0.02 && clipShut &&
    staged.t1.head > 0.3 && staged.t1.drawn < 0.5 &&
    staged.t2.head === 1 && staged.t2.drawn > 0.6 && !/-6% -30% -6%\)/.test(staged.t2.clip) &&
    staged.t3.head === 1 && staged.t3.drawn > 0.999 && clipOpen,
    JSON.stringify(staged));

  // A3. a click on the target takes the arrow away, through its exit
  const clicked = await evaluate(`(function () {
    var b = document.createElement('button');
    b.textContent = 'go'; b.style.cssText = 'position:fixed;left:40%;top:300px;';
    document.body.appendChild(b);
    AMH.tool.point(b, "Now this");
    var had = !!document.querySelector('.ced-point');
    b.click();
    var leaving = document.querySelector('.ced-point');
    return new Promise(function (res) { setTimeout(function () {
      res({ had: had, leavingOn: leaving ? leaving.classList.contains('is-on') : null,
            gone: !document.querySelector('.ced-point') });
      b.remove();
    }, 800); });
  })()`, { awaitPromise: true });
  check("arrow: a click on the target takes it away, and it is gone after its exit",
    clicked.had && clicked.leavingOn === false && clicked.gone, JSON.stringify(clicked));

  // W1. the fault that made a real drag look frozen: a drop that carries no
  // file used to return with no message at all.
  const noFile = await evaluate(`(function () {
    window.__h2 = AMH.tool.handOff("blog/2605.html", new Error("fetch refused"));
    var zone = document.querySelector('.ced-handoff__zone');
    if (!zone) return { zone: false };
    // a drag that carries a link and no file, which is what several sources
    // hand over. dataTransfer.files is empty.
    var dt = new DataTransfer();
    dt.setData("text/uri-list", "file:///c:/repo/index.html");
    zone.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
    return {
      zone: true,
      note: document.querySelector('.ced-modal__status').textContent,
      cls: document.querySelector('.ced-handoff__zone').className,
      stillOpen: !!document.querySelector('.ced-handoff__zone'),
    };
  })()`);
  check("wizard: a drop with no file says so, and does not sit silent",
    noFile.zone && /BLG-E02/.test(noFile.note) && /is-wrong/.test(noFile.cls) &&
    noFile.stillOpen, JSON.stringify(noFile).slice(0, 130));

  // W2. the heading. ced-modal__title has no rules anywhere, which is why the
  // badge and the file name used to run together with no padding.
  const head = await evaluate(`(() => {
    const h = document.querySelector('.ced-handoff .ced-modal__head');
    if (!h) return { there: false };
    const cs = getComputedStyle(h);
    return { there: true, display: cs.display, gap: cs.columnGap,
             padded: parseFloat(cs.paddingLeft) > 0,
             text: h.textContent };
  })()`);
  check("wizard: the heading is laid out, so FILE and the name are apart",
    head.there && head.display === "flex" && parseFloat(head.gap) > 0 && head.padded,
    JSON.stringify(head));

  // W3. a file with no markers is taken, and warned about. Better verifies;
  // it does not refuse. The editor holds edits that are not in the file yet,
  // so the bytes alone cannot prove a file wrong. The splice is the gate.
  const bare = await evaluate(`(function () {
    var zone = document.querySelector('.ced-handoff__zone');
    var dt = new DataTransfer();
    dt.items.add(new File(["<html>no markers here</html>"], "2605.html", { type: "text/html" }));
    zone.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
    return true;
  })()`);
  await sleep(500);
  const bareOut = await evaluate(`window.__h2.then(function (txt) {
    return { text: txt, gone: !document.querySelector('.ced-handoff__zone') }; })`,
    { awaitPromise: true });
  check("wizard: a file with no markers is warned about, not refused",
    bare && bareOut.text === "<html>no markers here</html>" && bareOut.gone === true,
    JSON.stringify(bareOut).slice(0, 90));

  // W4. it keeps what it was given, so a publish asks once for each file
  const kept = await evaluate(`AMH.tool.handOff("blog/2605.html", null).then(function (txt) {
    return { text: txt, asked: !!document.querySelector('.ced-handoff__zone') }; })`,
    { awaitPromise: true });
  check("wizard: a file already handed over is not asked for again",
    kept.text === "<html>no markers here</html>" && kept.asked === false,
    JSON.stringify(kept).slice(0, 80));

  // W4b. a file that may not exist is asked for differently: it gets an
  // answer that is not "give up", it resolves rather than rejecting, and the
  // answer is remembered.
  const optional = await evaluate(`(function () {
    AMH.tool.expectFiles(["index.html", "blog/2699.html"]);
    AMH.tool.expectOptional(["blog/2699.html"]);
    window.__h4 = AMH.tool.handOff("blog/2699.html", new Error("fetch refused"));
    const btns = [...document.querySelectorAll('.ced-handoff .ced-modal__btns button')]
      .map(b => b.textContent);
    const head = document.querySelector('.ced-handoff .ced-modal__head').textContent;
    const absent = [...document.querySelectorAll('.ced-handoff .ced-modal__btns button')]
      .find(b => /Not on disk/.test(b.textContent));
    if (absent) absent.click();
    return { btns, head, clicked: !!absent };
  })()`);
  const optionalOut = await evaluate(`window.__h4`, { awaitPromise: true });
  check("wizard: a file that may be absent offers an answer that is not Cancel",
    optional.clicked === true && optional.btns.some(b => /Not on disk/.test(b)),
    optional.btns.join(" | "));
  check("wizard: saying it is not there resolves with null, and does not reject",
    optionalOut === null, JSON.stringify(optionalOut));
  check("wizard: an optional file is not counted as a step",
    !/file \d+ of/.test(optional.head), optional.head);

  const remembered = await evaluate(`AMH.tool.handOff("blog/2699.html", null).then(
    function (v) { return { value: v, asked: !!document.querySelector('.ced-handoff__zone') }; })`,
    { awaitPromise: true });
  check("wizard: a file already said to be absent is not asked for again",
    remembered.value === null && remembered.asked === false,
    JSON.stringify(remembered));

  // W5. progress, when the caller says what it will need
  const steps = await evaluate(`(function () {
    AMH.tool.expectFiles(["index.html", "blog/2607.html", "blog/2606.html"]);
    window.__h3 = AMH.tool.handOff("blog/2607.html", new Error("fetch refused"));
    var head = document.querySelector('.ced-handoff .ced-modal__head').textContent;
    var items = [...document.querySelectorAll('.ced-handoff__item')]
      .map(function (i) { return i.className.replace('ced-handoff__item is-', '') + ':' + i.textContent; });
    document.querySelector('.ced-handoff .ced-modal__btns button:last-child').click();
    return { head: head, items: items };
  })()`);
  check("wizard: it shows the step and the whole list, with what it holds ticked",
    /file 2 of 3/.test(steps.head) &&
    steps.items.join(" ") === "done:index.html now:2607.html wait:2606.html",
    steps.head + " | " + steps.items.join(" "));

  // W6. cancelling rejects with a code a caller can catch
  const cancelled = await evaluate(`window.__h3.then(
    function () { return "resolved"; },
    function (e) { return { code: e.code, msg: e.message }; })`, { awaitPromise: true });
  check("wizard: cancel rejects with BLG-E07, which a caller can catch",
    cancelled && cancelled.code === "BLG-E07" && /BLG-E07/.test(cancelled.msg),
    JSON.stringify(cancelled).slice(0, 90));

  // F1. the fallback folder input matches on the full path under the picked
  // folder. The tree holds tools/e2e/fixtures/2607.html, and a match on the
  // bare name let whichever file came last win over blog/2607.html.
  const byPath = await evaluate(`(function () {
    AMH.tool.expectFiles(["blog/2607.html"]);
    window.__f1 = AMH.tool.handOff("blog/2607.html", new Error("fetch refused"));
    var folder = document.querySelector('.ced-handoff input[webkitdirectory]');
    if (!folder) return "no folder input";
    function withPath(text, rel) {
      var f = new File([text], rel.replace(/^.*\\//, ""), { type: "text/html" });
      Object.defineProperty(f, "webkitRelativePath", { value: rel });
      return f;
    }
    var dt = new DataTransfer();
    dt.items.add(withPath("<!--[edit:a]--><p>REAL MONTH</p><!--[/edit:a]-->", "repo/blog/2607.html"));
    dt.items.add(withPath("<!--[edit:a]--><p>FIXTURE</p><!--[/edit:a]-->", "repo/tools/e2e/fixtures/2607.html"));
    folder.files = dt.files;
    folder.dispatchEvent(new Event("change", { bubbles: true }));
    return "dispatched";
  })()`);
  await sleep(400);
  const f1 = await evaluate(`window.__f1.then(function (txt) {
    return { text: txt, gone: !document.querySelector('.ced-handoff__zone') }; })`,
    { awaitPromise: true });
  check("repo folder (input): matched by full path, so the fixture with the same name loses",
    byPath === "dispatched" && f1 && /REAL MONTH/.test(f1.text) && f1.gone === true,
    byPath + " " + JSON.stringify(f1).slice(0, 90));

  // F2. the File System Access path opens only the named files, keeps the
  // folder, marks an optional file that is not there, and answers every
  // later ask from the folder with no dialog.
  const picked = await evaluate(`(function () {
    // a fake directory tree with the API's own surface
    function fileH(text, name) {
      return { kind: "file", getFile: function () {
        return Promise.resolve(new File([text], name, { type: "text/html" })); } };
    }
    function dirH(entries) {
      return {
        kind: "directory",
        getDirectoryHandle: function (n) {
          return entries[n] && entries[n].kind === "directory" ? Promise.resolve(entries[n])
            : Promise.reject(new DOMException("no " + n, "NotFoundError"));
        },
        getFileHandle: function (n) {
          return entries[n] && entries[n].kind === "file" ? Promise.resolve(entries[n])
            : Promise.reject(new DOMException("no " + n, "NotFoundError"));
        }
      };
    }
    window.__opened = [];
    /* index.html and blog.html are the marks that say a folder is the root
       of this site. The pick is refused without them, so the stand-in tree
       carries them, as a real repo root does. */
    var tree = dirH({
      "index.html": fileH("<html>root mark</html>", "index.html"),
      "blog.html": fileH('<script id="blogManifest">stamp:' +
        ((/stamp:([0-9a-z]{6})/.exec(document.getElementById('blogManifest')
          ? document.getElementById('blogManifest').textContent : '') || [])[1] || 'aaaaaa') +
        '</scr' + 'ipt>', "blog.html"),
      // nothing the suite has handed over already: those answer from memory
      "gallery.html": fileH("<!--[edit:a]--><p>GALLERY FROM FOLDER</p><!--[/edit:a]-->", "gallery.html"),
      "blog": dirH({ "2608.html": fileH("<!--[edit:a]--><p>AUGUST</p><!--[/edit:a]-->", "2608.html") })
    });
    window.__realPicker = window.showDirectoryPicker;
    window.showDirectoryPicker = function (opts) {
      window.__opened.push(opts && opts.mode);
      return Promise.resolve(tree);
    };
    AMH.tool.expectFiles(["gallery.html", "blog/2606.html"]);
    AMH.tool.expectOptional(["blog/2606.html"]);
    window.__f2 = AMH.tool.handOff("gallery.html", new Error("fetch refused"));
    var btn = [...document.querySelectorAll('.ced-handoff .ced-modal__btns button')]
      .find(function (b) { return /repo folder/.test(b.textContent); });
    if (!btn) return "no button";
    btn.click();
    return "clicked";
  })()`);
  await sleep(500);
  const f2 = await evaluate(`window.__f2.then(function (txt) {
    return { text: txt, gone: !document.querySelector('.ced-handoff__zone'),
             opened: window.__opened }; })`, { awaitPromise: true });
  check("repo folder (API): the named file is read, the picker asked read-only, the dialog closes",
    picked === "clicked" && f2 && /GALLERY FROM FOLDER/.test(f2.text) && f2.gone === true &&
    JSON.stringify(f2.opened) === '["read"]', picked + " " + JSON.stringify(f2).slice(0, 120));

  const later = await evaluate(`Promise.all([
    AMH.tool.handOff("blog/2608.html", new Error("fetch refused")),
    AMH.tool.handOff("blog/2606.html", new Error("fetch refused")),
  ]).then(function (r) {
    return { august: r[0], absent: r[1],
             asked: !!document.querySelector('.ced-handoff__zone') }; })`,
    { awaitPromise: true });
  check("repo folder (API): every later ask is answered from the kept folder with no dialog",
    later && /AUGUST/.test(later.august) && later.absent === null &&
    later.asked === false, JSON.stringify(later).slice(0, 140));

  // F3. a required file the folder lacks still opens the dialog for that file
  const fallsThrough = await evaluate(`(function () {
    // 2698, not 2699: the wizard checks above marked 2699 absent, and a
    // skip is remembered for the page load
    window.__f3 = AMH.tool.handOff("blog/2698.html", new Error("fetch refused"));
    return new Promise(function (res) { setTimeout(function () {
      var head = document.querySelector('.ced-handoff .ced-modal__head');
      res({ asked: !!head, head: head ? head.textContent : "" });
    }, 200); });
  })()`, { awaitPromise: true });
  check("repo folder (API): a required file the folder lacks is still asked for",
    fallsThrough.asked && /2698\.html/.test(fallsThrough.head), JSON.stringify(fallsThrough));

  // F4. without the API the button falls back to the folder input
  const fallback = await evaluate(`(function () {
    window.showDirectoryPicker = undefined;
    var clicked = [];
    var real = HTMLInputElement.prototype.click;
    HTMLInputElement.prototype.click = function () { clicked.push(this.hasAttribute("webkitdirectory")); };
    var btn = [...document.querySelectorAll('.ced-handoff .ced-modal__btns button')]
      .find(function (b) { return /repo folder/.test(b.textContent); });
    if (btn) btn.click();
    HTMLInputElement.prototype.click = real;
    window.showDirectoryPicker = window.__realPicker;
    document.querySelector('.ced-handoff .ced-modal__btns button:last-child').click();
    return clicked;
  })()`);
  await evaluate(`window.__f3.then(function () { return 1; }, function () { return 0; })`,
    { awaitPromise: true });
  check("repo folder: with no API the button opens the folder input instead",
    JSON.stringify(fallback) === "[true]", JSON.stringify(fallback));

  // W7. every code the wizard can answer with is declared and worded
  const codes = await evaluate(`(() => {
    const E = AMH.tool.errorCodes;
    const keys = Object.keys(E);
    return { keys, allNamed: keys.every(k => /^BLG-E[0-9][0-9]$/.test(k)),
             allWorded: keys.every(k => typeof E[k] === "string" && E[k].length > 20) };
  })()`);
  check("wizard: every code is BLG-E## and carries a sentence",
    codes.keys.length >= 8 && codes.allNamed && codes.allWorded,
    codes.keys.join(" "));

  // W8. the document guard: a file dropped away from a target must not make
  // the browser open it and take every unexported edit with it.
  const guard = await evaluate(`(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(["x"], "index.html", { type: "text/html" }));
    const ev = new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt });
    document.body.dispatchEvent(ev);
    return { prevented: ev.defaultPrevented };
  })()`);
  check("wizard: a file dropped away from a target cannot navigate the page",
    guard.prevented === true, JSON.stringify(guard));

  await evaluate(`AMH.tool.expectFiles([])`);

  // put the pages back for the blog tests
  await evaluate(`window.edit.pending.clear()`);
  await sleep(400);
  await evaluate(`window.edit()`);

  // leave the page as the blog tests expect it: published bytes, no editor
  await send("Page.navigate", { url: PAGE });
  await waitLoaded();
  await sleep(1200);

  // ============ BLOG PAGE SHELL ============
  // Phase 3 Part 1 added blog.html: shared chrome, a placeholder, and a place
  // on the managed-page list. The reading engine arrives in Part 2.
  await send("Page.navigate", { url: PAGE });
  await waitLoaded();
  await sleep(1200);

  const navLink = await evaluate(`(function () {
    var a = [...document.querySelectorAll('.nav__links a')]
      .find(function (x) { return x.textContent.trim() === 'Blog'; });
    return a ? { href: a.getAttribute('href'), order: [...document.querySelectorAll('.nav__links a')]
      .map(function (x) { return x.textContent.trim(); }).join(",") } : null;
  })()`);
  check("blog page: the home page links to it from the nav",
    !!navLink && navLink.href === "blog.html", navLink ? navLink.order : "no link");

  await send("Page.navigate", { url: BLOGPAGE });
  await waitLoaded();
  await sleep(1600);
  const shell = await evaluate(`({
    title: document.title,
    canonical: document.querySelector('link[rel="canonical"]').getAttribute('href'),
    ogUrl: document.querySelector('meta[property="og:url"]').getAttribute('content'),
    header: !!document.getElementById('header'),
    brand: (document.querySelector('.brand__title') || {}).textContent,
    endbar: !!document.querySelector('.endbar'),
    note: (document.querySelector('.bs-note') || {}).textContent,
    feed: !!document.getElementById('blogStream'),
    current: (document.querySelector('.nav__links a[aria-current="page"]') || {}).textContent,
    workHref: document.querySelector('.nav__links a').getAttribute('href'),
    edit: typeof window.edit,
  })`);
  check("blog page: carries its own title, canonical and og:url",
    /^Blog/.test(shell.title) &&
    shell.canonical === "https://aaronmichaelharris.com/blog.html" &&
    shell.ogUrl === "https://aaronmichaelharris.com/blog.html",
    shell.canonical + " | " + shell.ogUrl);
  check("blog page: carries the shared chrome and marks itself current",
    shell.header && shell.brand === "AARON M. HARRIS" && shell.endbar &&
    shell.current === "Blog", JSON.stringify({ b: shell.brand, c: shell.current }));
  check("blog page: in-page anchors of the home page become cross-page links",
    shell.workHref === "index.html#work", shell.workHref);
  check("blog page: the index is on the page, with no posts to show",
    shell.feed && /No posts yet/i.test(shell.note || ""), (shell.note || "").trim());
  check("blog page: the editor is available here too", shell.edit === "function");

  // edit it, then walk to the home page and publish both
  await evaluate(`window.edit()`);
  await sleep(500);
  const blogUI = await evaluate(`({
    rows: document.querySelectorAll('.ced-panel__row').length,
    chips: document.querySelectorAll('.ced-chip').length,
  })`);
  check("blog page: its regions get panel rows and badges",
    blogUI.rows === 18 && blogUI.chips > 0, JSON.stringify(blogUI));

  await evaluate(`[...document.querySelectorAll('.ced-panel__row')]
    .find(r => r.textContent.indexOf('blog-h2') >= 0).click()`);
  await sleep(300);
  await evaluate(`document.querySelector('.ced-modal textarea').value = '<h2>NOTES FROM THE BLOG PAGE</h2>'`);
  await evaluate(`document.querySelector('.ced-modal__btns .ced-btn--accent').click()`);
  await sleep(300);
  await evaluate(`document.querySelector('.ced-modal__x').click()`);
  await sleep(200);

  await send("Page.navigate", { url: PAGE });
  await waitLoaded();
  await sleep(1800);
  await evaluate(ZIP_CAPTURE);
  const carried = await evaluate(`window.edit.pending()`);
  check("blog page: an edit made there survives the walk to the home page",
    /1 unsaved change on 1 page/.test(carried), carried);

  // and a home-page edit alongside it publishes as one zip
  await evaluate(`window.edit()`);
  await sleep(400);
  await evaluate(`[...document.querySelectorAll('.ced-chip')].find(c => c.title === 'hero-h1').click()`);
  await sleep(200);
  await evaluate(`document.querySelector('.ced-modal textarea').value =
    'I help ambitious teams <span class="hl">ship the TWOPAGE impossible</span>.'`);
  await evaluate(`document.querySelector('.ced-modal__btns .ced-btn--accent').click()`);
  await sleep(300);
  await evaluate(`document.querySelector('.ced-modal__x').click()`);
  await sleep(200);
  await evaluate(`window.__zipB64 = null; window.edit.export()`);
  let bz = null;
  for (let i = 0; i < 25 && !bz; i++) { await sleep(400); bz = await evaluate(`window.__zipB64`); }
  const bzip = bz ? unzipStore(Buffer.from(bz, "base64")) : null;
  const bnames = bzip ? Object.keys(bzip).sort() : [];
  check("blog page: publishes with the home page in one zip",
    JSON.stringify(bnames) === JSON.stringify(["blog.html", "index.html"]), bnames.join(", "));
  if (bzip) {
    const bOut = bzip["blog.html"].toString("utf8");
    const iOut = bzip["index.html"].toString("utf8");
    check("blog page: each page carries its own edit",
      bOut.indexOf("NOTES FROM THE BLOG PAGE") >= 0 && iOut.indexOf("TWOPAGE") >= 0);
    const bx = exportIsByteExact("blog.html", bOut, ["blog-h2"]);
    check("blog page: byte-identical outside its edited region", bx.ok, bx.detail);
    const ix = exportIsByteExact("index.html", iOut, ["hero-h1"]);
    check("blog page: the home page is byte-identical outside its edited region", ix.ok, ix.detail);
  }

  await evaluate(`window.edit.pending.clear()`);
  await sleep(400);

  // BL-shared. The header and the contact section are on every managed page.
  // Editing one of their regions is one act that writes every page, which is
  // what keeps the pages from drifting without generating the markup.
  await evaluate(`[...document.querySelectorAll('.ced-chip')].find(c => c.title === 'nav-work').click()`);
  await sleep(200);
  await evaluate(`document.querySelector('.ced-modal textarea').value =
    '<a href="index.html#work">Projects</a>'`);
  await evaluate(`document.querySelector('.ced-modal__btns .ced-btn--accent').click()`);
  await sleep(300);
  await evaluate(`document.querySelector('.ced-modal__x').click()`);
  await sleep(200);
  const sharedPending = await evaluate(`window.edit.pending()`);
  check("shared: one edit to a shared region is waiting on every managed page",
    /3 unsaved changes on 3 pages/.test(sharedPending), sharedPending);

  await evaluate(`window.__zipB64 = null; window.edit.export()`);
  let sz = null;
  for (let i = 0; i < 25 && !sz; i++) { await sleep(400); sz = await evaluate(`window.__zipB64`); }
  const szip = sz ? unzipStore(Buffer.from(sz, "base64")) : null;
  check("shared: every managed page ships in one zip",
    !!szip && JSON.stringify(Object.keys(szip).sort()) ===
      JSON.stringify([...MANAGED_PAGES].sort()),
    szip ? Object.keys(szip).sort().join(", ") : "no zip");
  if (szip) {
    const outs = MANAGED_PAGES.map((f) => szip[f].toString("utf8"));
    const heads = outs.map((s) =>
      s.slice(s.indexOf('<header class="site-header"'), s.indexOf("</header>")));
    check("shared: the new label is on every page, and the headers still match",
      outs.every((s) => s.includes('<a href="index.html#work">Projects</a>')) &&
      heads.every((h) => h === heads[0]),
      outs.map((s) => s.includes("Projects")).join("/"));
    for (const [i, f] of MANAGED_PAGES.entries()) {
      const x = exportIsByteExact(f, outs[i], ["nav-work"]);
      check("shared: " + f + " byte-identical outside the shared region", x.ok, x.detail);
    }
  }
  await evaluate(`window.edit.pending.clear()`);
  await sleep(400);

  await evaluate(`window.edit()`);
  await send("Page.navigate", { url: PAGE });
  await waitLoaded();
  await sleep(1200);

  // ============ BLOG TESTS ============
  // BL1. the blog is a page now: the home page carries none of its machinery,
  // old "?b=" links redirect to it, and an empty manifest says so plainly.
  const homeClean = await evaluate(`({
    engine: typeof (window.AMH && window.AMH.blog),
    takeover: document.body.classList.contains('blog-open'),
    feed: !!document.getElementById('blogStream'),
    manifest: !!document.getElementById('blogManifest'),
  })`);
  check("home page carries no blog machinery",
    homeClean.engine === "undefined" && !homeClean.takeover &&
    !homeClean.feed && !homeClean.manifest, JSON.stringify(homeClean));

  await send("Page.navigate", { url: PAGE + "?b=p0001" });
  await waitLoaded();
  await sleep(1600);
  const redirected = await evaluate(`location.pathname + location.search`);
  check("an old index.html?b= link redirects to the blog page",
    /blog\.html\?b=p0001$/.test(redirected), redirected);

  await send("Page.navigate", { url: BLOGPAGE });
  await waitLoaded();
  await sleep(1800);
  const degrade = await evaluate(`({
    note: document.querySelector('.bs-note')?.textContent || '',
    feed: !!document.getElementById('blogStream'),
  })`);
  check("blog page with an empty manifest shows the no-posts note",
    degrade.feed && degrade.note.includes("No posts yet"), JSON.stringify(degrade));
  await sleep(1800);

  // BL2. composer opens; draft save/restore round-trip
  const bootState = await evaluate(`({
    edit: typeof window.edit,
    tool: typeof (window.AMH && window.AMH.tool),
    publish: typeof (window.AMH && window.AMH.publish),
    blog: typeof (window.AMH && window.AMH.blog),
    href: location.href,
  })`);
  check("blog page: every trunk on it has loaded before the composer opens",
    bootState.edit === "function" && bootState.publish === "object",
    JSON.stringify(bootState) + " exceptions=" + exceptions.join(" | ").slice(0, 200));
  await evaluate(`window.edit.blog()`);
  await sleep(300);
  // The panel's own rules live in publish.js and are handed to the editor's
  // one <style>. Read the computed values, not the markup: a registration
  // that never ran leaves every element present and the panel unusable.
  const composerUI = await evaluate(`(() => {
    const p = document.querySelector('.bc-panel');
    if (!p) return { panel: false };
    return {
      panel: true,
      tabs: document.querySelectorAll('.bc-tab').length,
      position: getComputedStyle(p).position,
      write: getComputedStyle(document.querySelector('.bc-write')).display,
      images: getComputedStyle(document.querySelector('.bc-images')).display,
    };
  })()`);
  check("composer opens with tabs and fields, and its own styles applied",
    composerUI.panel && composerUI.tabs === 3 && composerUI.position === "fixed" &&
    composerUI.write === "flex" && composerUI.images === "none",
    JSON.stringify(composerUI));
  // The layout reads top to bottom: the title row with the posted group on
  // the right, the toolbar and body, the tags, the view row below, the
  // buttons. The eleven toolbar buttons are by click.
  const layout = await evaluate(`(() => {
    const panel = document.querySelector('.bc-panel');
    const order = [...panel.children].map(el => el.className.split(' ')[0]);
    const title = panel.querySelector('.bc-title'), posted = panel.querySelector('.bc-posted');
    const t = title.getBoundingClientRect(), p = posted.getBoundingClientRect();
    return {
      order, tools: panel.querySelectorAll('.bc-write .ced-tool').length,
      toolStops: [...panel.querySelectorAll('.ced-tool')].filter(b => b.tabIndex !== -1).length,
      toolLabels: [...panel.querySelectorAll('.bc-write .ced-tool')].map(b => b.textContent),
      placeholder: title.placeholder,
      postedRight: p.left > t.right && Math.abs(p.bottom - t.bottom) < 4,
      widths: ['.bc-date', '.bc-time', '.bc-zone'].map(s => Math.round(panel.querySelector(s).getBoundingClientRect().width)),
      counts: !!panel.querySelector('.bc-counts'), tags: !!panel.querySelector('.bc-tags input'),
    };
  })()`);
  check("composer: the layout is head, title row, write, images, preview, tags, view row, status, buttons",
    layout.order.join(" ") === "bc-head ced-modal__x bc-fields bc-write bc-images bc-preview bc-tags bc-tabs bc-status bc-btns",
    layout.order.join(" "));
  check("composer: the title is optional, and the posted group sits to its right with room for three inputs",
    layout.placeholder === "Title (optional)" && layout.postedRight &&
    layout.widths.every((w, i) => w >= [70, 80, 55][i]) && layout.counts && layout.tags,
    JSON.stringify(layout).slice(0, 200));
  check("composer: the Markdown toolbar has the eleven buttons, none of them a tab stop",
    layout.tools === 11 && layout.toolStops === 0 &&
    layout.toolLabels.join("|") === "H|• list|1. list|B|I|S|Link|Table|Expand|Break|Clear",
    layout.tools + " buttons, " + layout.toolStops + " stops: " + layout.toolLabels.join("|"));

  // The ring: title, body, the images area, Publish, Close, and nothing
  // else. Landing on the images area shows that view; landing back on the
  // title shows the write view. Shift walks it backwards.
  const ring = await evaluate(`(() => {
    const panel = document.querySelector('.bc-panel');
    const press = (shift) => {
      const e = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: shift, bubbles: true, cancelable: true });
      document.dispatchEvent(e);
      return e.defaultPrevented;
    };
    const name = (el) => el.className.split(' ')[0] || el.tagName.toLowerCase();
    panel.querySelector('.bc-title').focus();
    const fwd = [], views = [], prevented = [];
    for (let i = 0; i < 5; i++) { prevented.push(press(false)); fwd.push(name(document.activeElement)); views.push(panel.getAttribute('data-tab')); }
    const back = [];
    for (let i = 0; i < 5; i++) { press(true); back.push(name(document.activeElement)); }
    const stops = [...panel.querySelectorAll('input, textarea, button, [tabindex]')].filter(el => el.tabIndex !== -1);
    return { fwd, views, back, prevented: prevented.every(Boolean), stops: stops.map(name), modal: panel.getAttribute('aria-modal') };
  })()`);
  check("composer: TAB walks title, body, images, Publish, Close and back to the title",
    ring.modal === "true" && ring.prevented &&
    ring.fwd.join(" ") === "textarea bc-drop ced-btn ced-btn bc-title" &&
    ring.views.join(" ") === "write images images images write",
    JSON.stringify(ring).slice(0, 220));
  check("composer: shift and TAB walks the ring backwards, and nothing else in the panel is a stop",
    ring.back.join(" ") === "ced-btn ced-btn bc-drop textarea bc-title" &&
    ring.stops.join(" ") === "bc-title textarea bc-drop ced-btn ced-btn",
    JSON.stringify(ring).slice(0, 220));

  // The time field follows the clock until touched, holds what is typed,
  // and follows the clock again when blanked and left.
  const ticker = await evaluate(`(() => {
    const t = document.querySelector('.bc-time');
    const start = t.value;
    t.value = 'x'; AMH.publish.tick(); const ticked = t.value !== 'x' && /^\\d{1,2}:\\d{2} [ap]m$/.test(t.value);
    t.dispatchEvent(new Event('focus')); t.value = '9:15 pm'; t.dispatchEvent(new Event('input', { bubbles: true }));
    AMH.publish.tick(); const held = t.value === '9:15 pm';
    t.value = ''; t.dispatchEvent(new Event('blur'));
    const restarted = /^\\d{1,2}:\\d{2} [ap]m$/.test(t.value);
    return { start, ticked, held, restarted, zone: document.querySelector('.bc-zone').value,
             parse: [AMH.publish.timeParse('3:07 pm'), AMH.publish.timeParse('15:07'), AMH.publish.timeParse('12:00 am'),
                     AMH.publish.timeParse('12:30pm'), AMH.publish.timeParse('nope')],
             label: AMH.publish.timeLabel('1507') };
  })()`);
  check("composer: the time follows the clock, stops when touched, and follows it again when blanked",
    /^\d{1,2}:\d{2} [ap]m$/.test(ticker.start) && ticker.ticked && ticker.held && ticker.restarted && ticker.zone.length >= 2,
    JSON.stringify(ticker).slice(0, 200));
  check("composer: the two time forms round-trip",
    JSON.stringify(ticker.parse) === '["1507","1507","0000","1230",""]' && ticker.label === "3:07 pm",
    JSON.stringify(ticker.parse) + " " + ticker.label);

  // The counts: characters as typed, words as runs of letters and digits
  const counts = await evaluate(`(() => {
    const ta = document.querySelector('.bc-write textarea');
    ta.value = 'One two, three\\nhttps://x.io/a [img0001,Cap] **four**';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    return document.querySelector('.bc-counts').textContent;
  })()`);
  check("composer: the counts are live and count a tag or a URL once each",
    counts === "52 characters, 10 words", counts);

  // Every toolbar button writes its mark; a flag lands alone on its line
  const tools = await evaluate(`(() => {
    const ta = document.querySelector('.bc-write textarea');
    const btn = (l) => [...document.querySelectorAll('.bc-write .ced-tool')].find(b => b.textContent === l);
    const out = {};
    ta.value = 'Title line'; ta.focus(); ta.setSelectionRange(3, 3);
    btn('H').click(); out.h1 = ta.value; btn('H').click(); out.h2 = ta.value;
    btn('H').click(); out.h3 = ta.value; btn('H').click(); out.h0 = ta.value;
    ta.value = 'item'; ta.setSelectionRange(0, 0);
    btn('• list').click(); out.ul = ta.value; btn('1. list').click(); out.ol = ta.value; btn('1. list').click(); out.off = ta.value;
    ta.value = 'some word here'; ta.setSelectionRange(5, 9); btn('B').click(); out.b = ta.value;
    ta.value = 'some word here'; ta.setSelectionRange(5, 9); btn('I').click(); out.i = ta.value;
    ta.value = 'some word here'; ta.setSelectionRange(5, 9); btn('S').click(); out.s = ta.value;
    const realPrompt = window.prompt; window.prompt = () => 'https://x.io';
    ta.value = 'some word here'; ta.setSelectionRange(5, 9); btn('Link').click(); out.link = ta.value;
    window.prompt = realPrompt;
    ta.value = 'end'; ta.setSelectionRange(3, 3); btn('Table').click(); out.table = ta.value;
    ta.value = 'before after'; ta.setSelectionRange(6, 6); btn('Expand').click(); out.expand = ta.value;
    ta.value = 'line'; ta.setSelectionRange(4, 4); btn('Break').click(); out.brk = ta.value;
    ta.value = '# Head **b** *i* ~~s~~ [t](https://x.io) x'; ta.setSelectionRange(0, ta.value.length); btn('Clear').click(); out.clear = ta.value;
    return out;
  })()`);
  check("composer: heading cycles H2, H3, H4, plain; list buttons toggle; marks wrap the selection",
    tools.h1 === "# Title line" && tools.h2 === "## Title line" && tools.h3 === "### Title line" && tools.h0 === "Title line" &&
    tools.ul === "- item" && tools.ol === "1. item" && tools.off === "item" &&
    tools.b === "some **word** here" && tools.i === "some *word* here" && tools.s === "some ~~word~~ here" &&
    tools.link === "some [word](https://x.io) here",
    JSON.stringify(tools).slice(0, 260));
  check("composer: table, the two flags alone on a line, and clear formatting",
    tools.table === "end\n| Column | Column |\n| --- | --- |\n| cell | cell |\n" &&
    tools.expand === "before\n{expandformore}\n after" && tools.brk === "line\n{pagebreak}" &&
    tools.clear === "Head b i s t x",
    JSON.stringify({ table: tools.table, expand: tools.expand, brk: tools.brk, clear: tools.clear }));

  // The whole row holds at 720px: nothing overflows, nothing is scrunched
  await send("Emulation.setDeviceMetricsOverride", { width: 720, height: 900, deviceScaleFactor: 1, mobile: false });
  await sleep(300);
  const narrow = await evaluate(`(() => {
    const panel = document.querySelector('.bc-panel');
    const f = panel.querySelector('.bc-fields');
    return { w: innerWidth, overflow: f.scrollWidth > f.clientWidth + 1 || panel.scrollWidth > panel.clientWidth + 1,
             title: Math.round(panel.querySelector('.bc-title').getBoundingClientRect().width),
             widths: ['.bc-date', '.bc-time', '.bc-zone'].map(s => Math.round(panel.querySelector(s).getBoundingClientRect().width)) };
  })()`);
  await send("Emulation.clearDeviceMetricsOverride");
  await sleep(300);
  check("composer: at 720px the title row holds with no overflow and the three inputs at full width",
    narrow.w === 720 && !narrow.overflow && narrow.title >= 150 && narrow.widths.every((w, i) => w >= [70, 80, 55][i]),
    JSON.stringify(narrow));

  // An empty title is not refused: Publish goes on to the confirm step
  await evaluate(`document.querySelector('.bc-title').value = ''`);
  await evaluate(`document.querySelector('.bc-write textarea').value = 'No title on this one.'`);
  await evaluate(`[...document.querySelectorAll('.bc-btns .ced-btn')].find(b => b.textContent === 'Publish').click()`);
  await sleep(300);
  const untitled = await evaluate(`(() => {
    const box = document.querySelector('.bc-wizard');
    const r = { step: box && box.getAttribute('data-step'), status: document.querySelector('.bc-status').textContent };
    if (box) [...box.querySelectorAll('.ced-modal__btns button')].find(b => b.textContent === 'Cancel').click();
    return r;
  })()`);
  check("composer: an empty title is allowed, and Publish reaches the confirm step",
    untitled.step === "confirm" && !/title/i.test(untitled.status), JSON.stringify(untitled));

  // The draft carries the tags, the time and the zone, and an old draft
  // without them restores with the fields at their defaults
  await evaluate(`document.querySelector('.bc-title').value = 'Draft probe'`);
  await evaluate(`document.querySelector('.bc-write textarea').value = '<p>Draft body.</p>'`);
  await evaluate(`document.querySelector('.bc-tags').querySelector('input').value = 'xr planetarium'`);
  await evaluate(`(() => { const t = document.querySelector('.bc-time'); t.dispatchEvent(new Event('focus')); t.value = '9:15 pm'; t.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('.bc-zone').value = 'Paris'; })()`);
  await evaluate(`[...document.querySelectorAll('.bc-btns .ced-btn')].find(b => b.textContent === 'Save Draft').click()`);
  await evaluate(`[...document.querySelectorAll('.bc-btns .ced-btn')].find(b => b.textContent === 'Close').click()`);   // confirm auto-accepted
  await sleep(300);
  await evaluate(`window.edit.blog()`);
  await sleep(300);
  await evaluate(`[...document.querySelectorAll('.bc-btns .ced-btn')].find(b => b.textContent === 'Restore Draft').click()`);
  await sleep(300);
  const draft = await evaluate(`({
    title: document.querySelector('.bc-title').value,
    body: document.querySelector('.bc-write textarea').value,
    tags: document.querySelector('.bc-tags input').value,
    time: document.querySelector('.bc-time').value,
    zone: document.querySelector('.bc-zone').value,
  })`);
  check("Save/Restore Draft round-trips the title, body, tags, time and zone",
    draft.title === "Draft probe" && draft.body === "<p>Draft body.</p>" && draft.tags === "xr planetarium" &&
    draft.time === "9:15 pm" && draft.zone === "Paris",
    JSON.stringify(draft));
  const oldDraft = await evaluate(`(() => {
    localStorage.setItem('amh-blog-draft', JSON.stringify({ date: '260101', title: 'Old', body: 'old body', when: Date.now() }));
    [...document.querySelectorAll('.bc-btns .ced-btn')].find(b => b.textContent === 'Restore Draft').click();
    const t = document.querySelector('.bc-time');
    const before = t.value; t.value = 'x'; AMH.publish.tick();
    return { title: document.querySelector('.bc-title').value, tags: document.querySelector('.bc-tags input').value,
             ticking: t.value !== 'x', zone: document.querySelector('.bc-zone').value.length >= 2, before };
  })()`);
  check("composer: a draft from before the new fields restores with the clock ticking and no tags",
    oldDraft.title === "Old" && oldDraft.tags === "" && oldDraft.ticking && oldDraft.zone,
    JSON.stringify(oldDraft));
  await evaluate(`document.querySelector('.bc-time').value = ''; document.querySelector('.bc-time').dispatchEvent(new Event('blur'));`);

  // BL3. compose the real post: two dropped canvas images, one toggled to png
  await evaluate(`
    window.__dropImage = function (sel, w, h, color, name, type) {
      return new Promise(function (res) {
        var cv = document.createElement('canvas'); cv.width = w; cv.height = h;
        var cx = cv.getContext('2d'); cx.fillStyle = color; cx.fillRect(0, 0, w, h);
        cx.fillStyle = '#fff'; cx.fillRect(0, 0, 60, 60);
        cv.toBlob(function (b) {
          var f = new File([b], name, { type: type || 'image/png' });
          var dt = new DataTransfer(); dt.items.add(f);
          var ev;
          try { ev = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }); } catch (e) {}
          if (!ev || !ev.dataTransfer) {
            ev = new Event('drop', { bubbles: true, cancelable: true });
            Object.defineProperty(ev, 'dataTransfer', { value: dt });
          }
          document.querySelector(sel).dispatchEvent(ev);
          res(true);
        }, 'image/png');
      });
    };`);
  await evaluate(`document.querySelector('.bc-date').value = '260711'`);
  await evaluate(`document.querySelector('.bc-title').value = 'E2E first post'`);
  await evaluate(`document.querySelector('.bc-write textarea').value =
    '<p>First e2e post. Escape probe: &lt;/scr' + 'ipt&gt; as text.</p>\\n' +
    '[img0001,Cap one|Alt one][png0002,Cap two]\\n' +
    '<p>Tail paragraph with <strong>bold</strong>.</p>'`);
  await evaluate(`window.__dropImage('.bc-drop', 2400, 1200, '#336699', 'first.png')`, { awaitPromise: true });
  await evaluate(`window.__dropImage('.bc-drop', 900, 1400, '#996633', 'second.png')`, { awaitPromise: true });
  for (let i = 0; i < 20; i++) {
    if ((await evaluate(`document.querySelectorAll('.bc-card').length`)) === 2) break;
    await sleep(300);
  }
  const cards = await evaluate(`({
    n: document.querySelectorAll('.bc-card').length,
    meta0: document.querySelectorAll('.bc-card .bc-card__meta')[0]?.textContent || '',
    meta1: document.querySelectorAll('.bc-card .bc-card__meta')[1]?.textContent || '',
  })`);
  check("two images intake (resized to 1600 long edge)",
    cards.n === 2 && cards.meta0.includes("0001") && cards.meta0.includes("1600x800") &&
    cards.meta1.includes("0002") && cards.meta1.includes("900x1400"),
    cards.meta0 + " || " + cards.meta1);
  // toggle second card to png (tag says [png0002...])
  await evaluate(`[...document.querySelectorAll('.bc-card')][1].querySelectorAll('button')[1].click()`);
  await sleep(700);
  check("second image re-encoded as png",
    await evaluate(`document.querySelectorAll('.bc-card .bc-card__meta')[1].textContent.includes('.png')`));
  // rejection: a text file drop shows an error card
  await evaluate(`(function () {
    var f = new File(['nope'], 'notes.txt', { type: 'text/plain' });
    var dt = new DataTransfer(); dt.items.add(f);
    var ev;
    try { ev = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }); } catch (e) {}
    if (!ev || !ev.dataTransfer) {
      ev = new Event('drop', { bubbles: true, cancelable: true });
      Object.defineProperty(ev, 'dataTransfer', { value: dt });
    }
    document.querySelector('.bc-drop').dispatchEvent(ev);
  })()`);
  await sleep(400);
  check("non-image drop rejected with an error note",
    await evaluate(`!!document.querySelector('.bc-err')`));

  // ---- the Markdown renderer, against its fixture ----
  // MD1. every case in tools/e2e/fixtures/markdown.txt renders byte for
  // byte in the page. The fixture is the contract: a feature outside it
  // is text, and the last case proves that for three common ones.
  const mdRaw = readFileSync(join(REPO, "tools/e2e/fixtures/markdown.txt"), "utf8").replace(/\r\n/g, "\n");
  const mdCases = mdRaw.split("\n====\n").slice(1).map((c) => {
    const nl = c.indexOf("\n");
    const [src, exp] = c.slice(nl + 1).split("\n----\n");
    return { name: c.slice(0, nl), src, exp: exp.replace(/\n$/, "") };
  });
  const mdOut = await evaluate(`(function (cases) {
    return cases.map(function (c) { return AMH.markdown.render(c.src); });
  })(${JSON.stringify(mdCases.map((c) => ({ src: c.src })))})`);
  const mdBad = mdCases.filter((c, i) => mdOut[i] !== c.exp);
  check("markdown: every fixture case renders byte for byte (" + mdCases.length + " cases)",
    mdCases.length >= 16 && mdBad.length === 0,
    mdBad.length ? mdBad[0].name + ": " + firstDiff(mdOut[mdCases.indexOf(mdBad[0])], mdBad[0].exp) : "");
  check("markdown: the fixture holds the out-of-set case and the mixed case",
    mdCases.some((c) => /out of the set/.test(c.name)) && mdCases.some((c) => /^mixed/.test(c.name)));
  // MD2. with a date, an image tag run becomes figures through the same
  // tag renderer an HTML post uses; a tag inside code stays code
  const mdFig = await evaluate(`(function () {
    var html = AMH.markdown.render("Text.\\n\\n[img0001,Cap one|Alt one]\\n\\n\`[img0002]\` in code.", { date: "260711" });
    return html;
  })()`);
  check("markdown: with a date the tag run becomes figures, and a tag in code does not",
    /<p>Text\.<\/p>\n<figure class="bp-fig"><img src="\.\.\/blog\/260711_img0001\.jpg" loading="lazy" alt="Alt one" \/><figcaption>Cap one<\/figcaption><\/figure>\n?<p><code>&#91;img0002\]<\/code> in code\.<\/p>$/.test(mdFig),
    mdFig.slice(0, 220));
  // MD3. the plain-text form of the mixed case, for excerpts and search
  const mdMixed = mdCases.find((c) => /^mixed/.test(c.name));
  const mdText = await evaluate(`AMH.markdown.text(${JSON.stringify(mdMixed.src)})`);
  check("markdown: text() strips every mark, keeps code and link text, and names captions",
    mdText === "A day at the dome We ran the planetarium test with the new headset. See the notes. " +
      "(Dome and headset The dome at dusk) What worked Tracking held for ten twenty minutes " +
      "The sync() call, at last even on the old rig Ship it. Rig Frames old 58 new 90 $ run --dome ok " +
      "The rest is for another day.",
    mdText.slice(0, 200));
  // MD4. raw HTML passes through, so the tag check before a publish is
  // still what catches an unbalanced tag
  const mdTag = await evaluate(`(function () {
    var html = AMH.markdown.render("A <b>bold start.\\n\\nNo close.");
    return { html: html, problem: AMH.tool.tagCheck(html) };
  })()`);
  check("markdown: raw HTML passes through and the tag check still catches an unbalanced tag",
    mdTag.html === "<p>A <b>bold start.</p>\n<p>No close.</p>" && !!mdTag.problem,
    JSON.stringify(mdTag).slice(0, 160));
  // MD5. the trunk names its seven sections in its header
  const mdSrc = readFileSync(join(REPO, "markdown.js"), "utf8");
  const mdSections = (mdSrc.slice(0, mdSrc.indexOf("(function")).match(/\b[1-7]\. [A-Z][A-Z ]+/g) || []).length;
  check("markdown: the trunk is a seven-section manifold, named in its header", mdSections === 7, String(mdSections));

  // BL4. publish: capture the zip via the patched anchor click
  await evaluate(ZIP_CAPTURE);

  // PW1. a publish that fails shows the failedStep step and keeps the post. Done
  // first, on the same page load, because a failedStep build sets no flag and
  // the real publish below must still be allowed.
  await evaluate(`(function () {
    window.__realPristine = AMH.tool.pristine;
    AMH.tool.pristine = function () { return Promise.reject(new Error("forced failure for the suite")); };
  })()`);
  const failStep = await pressPublish();
  await sleep(700);
  const failedStep = await evaluate(`(function () {
    var box = document.querySelector('.bc-wizard');
    var r = { step: box ? box.getAttribute('data-step') : 'none',
              head: box ? box.querySelector('.ced-modal__head').textContent : '',
              body: box ? box.querySelector('.bc-wiz__body').textContent : '',
              title: document.querySelector('.bc-title').value,
              publishEnabled: ![...document.querySelectorAll('.bc-btns .ced-btn')].find(function (b) { return b.textContent === 'Publish'; }).disabled };
    var close = box && [...box.querySelectorAll('.ced-modal__btns button')].find(function (b) { return b.textContent === 'Close'; });
    if (close) close.click();
    r.closed = !document.querySelector('.bc-wizard');
    AMH.tool.pristine = window.__realPristine;
    return r;
  })()`);
  check("wizard: a failed publish shows the failed step, and the composer keeps the post",
    failStep !== "timeout" && failedStep.step === "failed" && /Publish failed/.test(failedStep.head) &&
    /forced failure/.test(failedStep.body) && /Nothing was written/.test(failedStep.body) &&
    failedStep.title === "E2E first post" && failedStep.publishEnabled && failedStep.closed,
    failStep + " " + JSON.stringify(failedStep).slice(0, 220));

  // PW2. the confirm step replaces the browser box: the two lists, the
  // reminder, the checkbox, and no window.confirm at all
  const dcBefore = dialogCount;
  await evaluate(`[...document.querySelectorAll('.bc-btns .ced-btn')].find(b => b.textContent === 'Publish').click()`);
  await sleep(400);
  const confirmStep = await evaluate(`(function () {
    var box = document.querySelector('.bc-wizard');
    if (!box) return { step: 'none' };
    return {
      step: box.getAttribute('data-step'),
      spliced: [...box.querySelectorAll('.bc-wiz__file[data-how=spliced]')].map(function (f) { return f.textContent; }),
      regen: [...box.querySelectorAll('.bc-wiz__file[data-how=regenerated]')].map(function (f) { return f.textContent; }),
      reminder: /clean and synced/.test(box.textContent),
      checkbox: !!box.querySelector('.bc-wiz__noremind'),
      route: !!box.querySelector('.bc-wiz__route'),
      btns: [...box.querySelectorAll('.ced-modal__btns button')].map(function (b) { return b.textContent; }),
      disabled: [...box.querySelectorAll('.ced-modal__btns button')]
        .filter(function (b) { return b.disabled; }).map(function (b) { return b.textContent; }),
      focused: document.activeElement && document.activeElement.textContent,
    };
  })()`);
  check("wizard: the confirm step names what is spliced and what is regenerated",
    confirmStep.step === "confirm" && confirmStep.spliced.indexOf("blog.html") !== -1 &&
    confirmStep.regen.indexOf("blog/2607.html") !== -1 && confirmStep.regen.indexOf("sitemap.xml") !== -1 &&
    confirmStep.reminder && confirmStep.checkbox,
    JSON.stringify(confirmStep).slice(0, 240));
  // WR1. the delivery choice is on the step that starts the build, so the
  // route is picked with the file lists in view. Headless Chrome has the
  // folder picker, so both buttons are live here.
  check("wizard: the confirm step offers both ways for the bundle to land",
    JSON.stringify(confirmStep.btns) ===
      '["Cancel","Download a .zip","Write into my repo folder"]' &&
    confirmStep.route === true && confirmStep.disabled.length === 0 &&
    confirmStep.focused === "Write into my repo folder",
    JSON.stringify({ btns: confirmStep.btns, disabled: confirmStep.disabled,
                     focused: confirmStep.focused }));

  await evaluate(`[...document.querySelectorAll('.bc-wizard .ced-modal__btns button')].find(b => /Download a \.zip/.test(b.textContent)).click()`);
  await sleep(200);
  const progressStep = await evaluate(`(function () {
    var box = document.querySelector('.bc-wizard');
    return { step: box && box.getAttribute('data-step'),
             rows: box ? box.querySelectorAll('.bc-wiz__rows li').length : 0,
             now: box ? [...box.querySelectorAll('.bc-wiz__rows li')].filter(function (l) { return l.className === 'is-now'; }).length : 0 };
  })()`);
  check("wizard: the progress step lists the work in seven rows and paces itself",
    progressStep.step === "progress" && progressStep.rows === 7 && progressStep.now === 1,
    JSON.stringify(progressStep));
  // the Files step exists for a page opened from disk; over HTTP the build
  // reads its own bytes and Build goes straight to the progress step
  check("wizard: over HTTP there is no Files step between Confirm and the build",
    progressStep.step !== "files" && progressStep.step === "progress", progressStep.step);

  let zipB64 = null;
  for (let i = 0; i < 30 && !zipB64; i++) { await sleep(500); zipB64 = await evaluate(`window.__zipB64`); }
  const pubStatus = await evaluate(`document.querySelector('.bc-status').textContent`);
  check("publish produced a bundle", !!zipB64, pubStatus.slice(0, 80));
  check("wizard: the browser confirm box is gone from the publish path",
    dialogCount === dcBefore, "dialogs=" + (dialogCount - dcBefore));

  // PW3. the done step: what happened, where the zip went, the list
  let doneStep = null;
  for (let i = 0; i < 20 && !(doneStep && doneStep.step === "done"); i++) {
    await sleep(300);
    doneStep = await evaluate(`(function () {
      var box = document.querySelector('.bc-wizard');
      if (!box) return { step: 'none' };
      return {
        step: box.getAttribute('data-step'),
        head: box.querySelector('.ced-modal__head').textContent,
        body: box.querySelector('.bc-wiz__body').textContent,
        elapsed: parseInt(box.getAttribute('data-elapsed') || '0', 10),
        spliced: [...box.querySelectorAll('.bc-wiz__file[data-how=spliced]')].map(function (f) { return f.textContent; }).sort(),
        regen: [...box.querySelectorAll('.bc-wiz__file[data-how=regenerated]')].map(function (f) { return f.textContent; }).sort(),
        added: [...box.querySelectorAll('.bc-wiz__file[data-how=added]')].length,
        checks: [...box.querySelectorAll('.bc-wiz__checks input')].map(function (c) { return c.getAttribute('data-check') + (c.disabled ? '!' : ''); }),
        btns: [...box.querySelectorAll('.ced-modal__btns button')].map(function (b) { return b.textContent; }),
        url: (box.querySelector('.bc-wiz__body a') || {}).textContent || '',
        focused: document.activeElement && document.activeElement.textContent,
        publishDisabled: [...document.querySelectorAll('.bc-btns .ced-btn')].find(function (b) { return b.textContent === 'Publish'; }).disabled,
      };
    })()`);
  }
  check("wizard: the done step says what was published, where the zip went, and what is in it",
    doneStep.step === "done" && /Published p0001/.test(doneStep.head) &&
    /blog-publish-260711\.zip/.test(doneStep.body) && /Downloads folder/.test(doneStep.body) &&
    JSON.stringify(doneStep.spliced) === '["blog.html","index.html"]' &&
    JSON.stringify(doneStep.regen) ===
      '["blog/2607.html","feed.xml","robots.txt","search.js","sitemap.xml"]' &&
    /* Publish stays live now: the staging layer means the next bundle
       builds on this one rather than fighting it */
    doneStep.added === 4 && /blog\/2607\.html#p0001$/.test(doneStep.url) &&
    !doneStep.publishDisabled,
    JSON.stringify(doneStep).slice(0, 300));
  check("wizard: the seven rows each held for the minimum, so the steps could be read",
    doneStep.elapsed >= 7 * 350 - 100, "elapsed " + doneStep.elapsed + "ms");
  check("wizard: the list is extract, review, commit, push, and a live box the page owns",
    JSON.stringify(doneStep.checks) === '["extract","review","commit","push","live!"]' &&
    JSON.stringify(doneStep.btns) ===
      '["Download again","Compose another","Resume editing this post","All done, close the post!"]',
    JSON.stringify(doneStep.checks) + " " + JSON.stringify(doneStep.btns));
  // WD1. the last step ends in two plain choices: go back to this post, or
  // finish with it. The quieter buttons stay for the times they are wanted.
  check("wizard: the done step's two clear choices are last, and finishing is the default",
    doneStep.btns[doneStep.btns.length - 2] === "Resume editing this post" &&
    doneStep.btns[doneStep.btns.length - 1] === "All done, close the post!" &&
    doneStep.focused === "All done, close the post!",
    JSON.stringify({ btns: doneStep.btns, focused: doneStep.focused }));

  // PW4. a tick is remembered in the record, and the panel line reads it
  const ticked = await evaluate(`(function () {
    var cb = document.querySelector('.bc-wizard .bc-wiz__checks input[data-check=extract]');
    cb.click();
    var rec = JSON.parse(sessionStorage.getItem('amh-publish-pending') || 'null');
    if (!AMH.tool.editorOn()) window.edit();
    var line = document.querySelector('.ced-publish');
    return { checked: cb.checked, rec: rec && rec.checks.extract, id: rec && rec.id,
             line: line ? line.textContent : '', hidden: line ? line.hidden : true };
  })()`);
  check("wizard: a tick is kept in the record, and the panel line counts it",
    ticked.checked && ticked.rec === true && ticked.id === "0001" && !ticked.hidden &&
    /p0001 is in a bundle that is not live yet\. 1 of 4 steps ticked\./.test(ticked.line),
    JSON.stringify(ticked).slice(0, 200));
  await evaluate(`[...document.querySelectorAll('.bc-wizard .ced-modal__btns button')].find(b => b.textContent === 'All done, close the post!').click()`);
  // PW4b. Finishing does not close the wizard: it says what to do next, and
  // that is not the same for the two routes. This publish went to a zip, so
  // a refresh now would show the reader the same page they are already on.
  const lastWord = await evaluate(`(function () {
    var box = document.querySelector('.bc-wizard');
    return { step: box && box.getAttribute('data-step'),
             text: box ? box.querySelector('.bc-wiz__body').textContent : '',
             btns: box ? [...box.querySelectorAll('.ced-modal__btns button')].map(function (b) { return b.textContent; }) : [] };
  })()`);
  check("wizard: the last step tells you what to do next, and it fits the route taken",
    lastWord.step === "refresh" && /Downloads folder/.test(lastWord.text) &&
    /Extract it at the repo root/.test(lastWord.text) &&
    /Ctrl\+F5/.test(lastWord.text) && JSON.stringify(lastWord.btns) === '["Got it"]',
    JSON.stringify(lastWord).slice(0, 220));
  await evaluate(`[...document.querySelectorAll('.bc-wizard .ced-modal__btns button')].find(b => b.textContent === 'Got it')?.click()`);

  // PW5. the record clears itself when the page carries the bundle's stamp.
  // The served page's manifest is empty, so the stamp is put on it by hand,
  // and a wrong stamp first, which must not clear anything.
  const live = await evaluate(`(function () {
    var rec = JSON.parse(sessionStorage.getItem('amh-publish-pending'));
    var man = document.getElementById('blogManifest');
    var before = AMH.publish.checkLive();
    /* the record clears on the stamp the page ARRIVED with, so the layer
       can never answer yes to its own reflection. arrive() is the page's
       own lifecycle hook, run again because the manifest changed under it. */
    man.textContent = man.textContent.replace(/\\n*$/, '') + '\\nstamp:zzzzzz\\n';
    AMH.publish.arrive();
    var wrong = !sessionStorage.getItem('amh-publish-pending');
    man.textContent = man.textContent.replace('stamp:zzzzzz', 'stamp:' + rec.stamp);
    AMH.publish.arrive();
    var after = !sessionStorage.getItem('amh-publish-pending');
    var line = document.querySelector('.ced-publish');
    return { stamp: rec.stamp, before: before, wrong: wrong, after: after,
             rec: sessionStorage.getItem('amh-publish-pending'), hidden: line ? line.hidden : null };
  })()`);
  check("wizard: the record clears when the page carries this bundle's stamp, and not before",
    /^[0-9a-z]{6}$/.test(live.stamp) && live.before === false && live.wrong === false &&
    live.after === true && live.rec === null && live.hidden === true,
    JSON.stringify(live).slice(0, 160));

  let zipFiles = {};
  if (zipB64) {
    zipFiles = unzipStore(Buffer.from(zipB64, "base64"));
    const names = Object.keys(zipFiles).sort();
    check("bundle has the full publish layout", JSON.stringify(names) === JSON.stringify([
      "blog/260711_img0001.jpg", "blog/260711_img0002.png", "blog/2607.html",
      "imgsources/260711_img0001_original.png", "imgsources/260711_img0002_original.png",
      "blog.html", "index.html", "robots.txt", "sitemap.xml", "search.js", "feed.xml",
    ].sort()), names.join(", "));

    // The home page is in this bundle because the highlights block changed.
    // It is written through the editor's multi-page path, so the byte-exact
    // rule applies to it as much as to a page someone edited by hand.
    const outHome = zipFiles["index.html"].toString("utf8");
    const srcHome = readFileSync(join(REPO, "index.html"), "utf-8");
    const hlSpan = outHome.slice(outHome.indexOf("<!--[edit:blog-highlights]-->"),
      outHome.indexOf("<!--[/edit:blog-highlights]-->"));
    check("highlights: the published post is listed, linked at its month file",
      hlSpan.includes('href="blog/2607.html#p0001"') &&
      hlSpan.includes("E2E first post") &&
      hlSpan.includes('<time datetime="2026-07-11">July 11, 2026</time>'),
      hlSpan.replace(/\s+/g, " ").slice(0, 150));
    check("highlights: the placeholder is gone and All posts is offered",
      !hlSpan.includes("latest__empty") && hlSpan.includes('href="blog.html">All posts'),
      hlSpan.includes("latest__empty") ? "placeholder still there" : "");
    check("highlights: the region element and its data-ced survive the splice",
      hlSpan.includes('<div class="latest__list reveal d1" data-ced="generated">'),
      (/<div[^>]*>/.exec(hlSpan) || [])[0]);
    check("highlights: index.html byte-identical outside the block",
      stripSpans(outHome, ["blog-highlights"]) === stripSpans(srcHome, ["blog-highlights"]));

    const outIdx = zipFiles["blog.html"].toString("utf8");
    // the served page, not the repo's: the suite publishes into its own copy
    const srcIdx = servedSource("blog.html");
    const manSpan = outIdx.slice(outIdx.indexOf("<!--[edit:blog-manifest]-->"),
      outIdx.indexOf("<!--[/edit:blog-manifest]-->"));
    check("manifest spliced: counters + entry",
      manSpan.includes("next-post:0002") && manSpan.includes("next-img:0003") &&
      manSpan.includes("2607110001E2E first post"),
      manSpan.replace(/\s+/g, " "));

    // ST1. every generated file carries the stamp it was built under: the
    // manifest names the publish and the month, and sitemap.xml, robots.txt
    // and the month file each say which one wrote them
    const pubStamp = (/\nstamp:([0-9a-z]{6})\n/.exec(manSpan) || [])[1];
    const moStamp = (/\nmonth:2607=([0-9a-z]{6})\n/.exec(manSpan) || [])[1];
    const month0 = zipFiles["blog/2607.html"].toString("utf8");
    const monthHead = (/<!-- GENERATED[^>]*stamp:([0-9a-z]{6})/.exec(month0) || [])[1];
    const smHead = (/<!-- GENERATED[^>]*stamp:([0-9a-z]{6})/.exec(zipFiles["sitemap.xml"].toString("utf8")) || [])[1];
    const rbHead = (/# GENERATED[^\n]*stamp:([0-9a-z]{6})/.exec(zipFiles["robots.txt"].toString("utf8")) || [])[1];
    check("stamp: the manifest names the publish and the month, and the record holds the publish stamp",
      !!pubStamp && !!moStamp && live.stamp === pubStamp,
      JSON.stringify({ pubStamp, moStamp, rec: live.stamp }));
    check("stamp: sitemap.xml, robots.txt and the month file each carry the stamp that wrote them",
      smHead === pubStamp && rbHead === pubStamp && monthHead === moStamp,
      JSON.stringify({ smHead, rbHead, monthHead }));
    // the two stamps are what the plan says: the month's is the hash of its
    // joined blocks, the publish's is the hash of the payload without its
    // own stamp line, chained to the previous stamp (none, on a first publish)
    const joined = month0.slice(month0.indexOf("<main>\n") + 7, month0.indexOf("\n    </main>"));
    const payload = (/<script id="blogManifest"[^>]*>([\s\S]*?)<\/script>/.exec(manSpan) || [])[1] || "";
    const recomputed = await evaluate(`({
      month: AMH.tool.stamp(${JSON.stringify(joined)}),
      publish: AMH.tool.stamp("\\n" + ${JSON.stringify(payload.replace(/\nstamp:[^\n]*/, ""))}),
      known: [AMH.tool.stamp(""), AMH.tool.stamp("a"), AMH.tool.stamp("hello world")],
    })`);
    check("stamp: six base36 characters from FNV-1a, checked against three known inputs",
      JSON.stringify(recomputed.known) === '["ztntfp","r9wi7g","n91413"]', JSON.stringify(recomputed.known));
    check("stamp: the month stamp hashes the joined blocks; the publish stamp hashes the payload, chained",
      recomputed.month === moStamp && recomputed.publish === pubStamp,
      JSON.stringify({ recomputed, moStamp, pubStamp }));

    // SR0. the two generators on a known post: the words with the image
    // tags taken out, the captions as their own field, and a pack that
    // round-trips through the one unpacker
    const unit = await evaluate(`(function () {
      var post = { id: "0042", date: "260903", time: "1839", zone: "EDT",
                   title: "A day", tags: "xr planetarium", format: "md",
                   source: "Words **here**.\\n\\n[img0001,Cap one|Alt one][png0002,Cap two]\\n\\nMore.",
                   staticBody: "" };
      var entry = AMH.publish.searchEntry(post, "");
      var text = AMH.publish.searchPack({ v: 1, stamp: "zzz999", posts: [entry] }, "zzz999");
      return AMH.search.unpack(text).then(function (back) {
        return { entry: entry, text: text,
                 same: JSON.stringify(back.posts[0]) === JSON.stringify(entry),
                 stamp: back.stamp, head: text.split("\\n")[0],
                 readable: text.indexOf('"title":"A day"') !== -1 };
      });
    })()`, { awaitPromise: true });
    check("search: an entry holds the words without the image tags, and the captions apart",
      unit.entry.text === "Words here. More." &&
      JSON.stringify(unit.entry.caps) === '["Cap one Alt one","Cap two"]' &&
      unit.entry.tags === "xr planetarium" && unit.entry.time === "1839" && unit.entry.zone === "EDT",
      JSON.stringify(unit.entry).slice(0, 220));
    check("search: pack and unpack round-trip a table, with the stamp in the header",
      unit.same && unit.stamp === "zzz999" && unit.readable && /stamp:zzz999/.test(unit.head),
      JSON.stringify({ same: unit.same, stamp: unit.stamp, head: unit.head }).slice(0, 180));
    // SR0. the file a scanner sees. A packed payload is what made Windows
    // call search.js a dangerous file, so the absence of one is the fix.
    check("search: the packed table is readable JSON, with no base64 payload in it",
      !hasBase64Blob(unit.text) && unit.text.indexOf("window.AMH_SEARCH = {") !== -1,
      unit.text.slice(0, 150));

    // SR1. the index the publish ships: a classic script assigning the table
    // as readable JSON, with the publish stamp in its header comment
    const searchFile = zipFiles["search.js"].toString("utf8");
    const searchStamp = (/GENERATED[^*]*stamp:([0-9a-z]{6})/.exec(searchFile) || [])[1];
    const shipped = searchTable(searchFile);
    check("search: the file is one readable assignment, stamped by the publish that wrote it",
      searchStamp === pubStamp && !hasBase64Blob(searchFile) &&
      shipped && shipped.v === 1 && shipped.stamp === pubStamp,
      JSON.stringify({ searchStamp, pubStamp, bytes: searchFile.length,
                       err: shipped.error }).slice(0, 160));
    const e1 = (shipped.posts || [])[0] || {};
    check("search: the entry carries the post's words, captions, tags, time and zone",
      (shipped.posts || []).length === 1 && e1.id === "0001" && e1.date === "260711" &&
      /^\d{4}$/.test(e1.time) && e1.zone.length >= 2 && e1.title === "E2E first post" &&
      /^First e2e post/.test(e1.text) && !/\[img0001/.test(e1.text) &&
      JSON.stringify(e1.caps) === '["Cap one Alt one","Cap two"]',
      JSON.stringify(e1).slice(0, 220));
    check("search: the thumbnail is a small WebP made from the post's first image",
      /^data:image\/webp;base64,/.test(e1.thumb || "") && e1.thumb.length < 2048,
      (e1.thumb || "").slice(0, 40) + " len " + (e1.thumb || "").length);

    // FD1. the feed: Atom, the post's own anchor as its id, the time at
    // its zone, and a summary cut from the index's own text
    const feed = zipFiles["feed.xml"].toString("utf8");
    const feedStamp = (/GENERATED[^>]*stamp:([0-9a-z]{6})/.exec(feed) || [])[1];
    check("feed: it is Atom, names the site and itself, and carries the publish stamp",
      feedStamp === pubStamp && /^<\?xml version="1\.0" encoding="UTF-8"\?>/.test(feed) &&
      feed.includes('<feed xmlns="http://www.w3.org/2005/Atom">') &&
      feed.includes("<title>AARON M. HARRIS - Blog</title>") &&
      feed.includes('<link rel="self" href="https://aaronmichaelharris.com/feed.xml" />') &&
      feed.includes("<id>https://aaronmichaelharris.com/feed.xml</id>"),
      feed.slice(0, 240).replace(/\n/g, " "));
    const entry = (/<entry>[\s\S]*?<\/entry>/.exec(feed) || [""])[0];
    check("feed: the entry's id and link are the post's own anchor, with the title and a summary",
      (feed.match(/<entry>/g) || []).length === 1 &&
      entry.includes("<title>E2E first post</title>") &&
      entry.includes('<link href="https://aaronmichaelharris.com/blog/2607.html#p0001" />') &&
      entry.includes("<id>https://aaronmichaelharris.com/blog/2607.html#p0001</id>") &&
      /<summary type="text">First e2e post/.test(entry),
      entry.replace(/\n/g, " ").slice(0, 220));
    check("feed: the entry's time is the post's own, at the zone it names",
      /<updated>2026-07-11T\d\d:\d\d:00-0[45]:00<\/updated>/.test(entry),
      (entry.match(/<updated>[^<]*/) || [""])[0]);

    // ST2. one fixture, both parsers: the pristine-source parser in
    // publish.js and the live-tag parser in blog.js must agree line for
    // line, and a line neither understands is reported, not lost
    const FIXTURE = "\nnext-post:0007\nnext-img:0012\nstamp:abc123\nmonth:2607=k9d2m1\nmonth:2606=zz00aa\n" +
      "months:2607 2606\n2606100002June post|2607110001E2E first post\nbogus line here\n";
    const parsers = await evaluate(`(function () {
      var warned = [];
      var ow = console.warn;
      console.warn = function (m) { warned.push(String(m)); };
      var fx = ${JSON.stringify(FIXTURE)};
      var a = AMH.publish.manifest('<script id="blogManifest" type="text/plain">' + fx + '</scr' + 'ipt>');
      var tag = document.getElementById('blogManifest');
      var saved = tag.textContent;
      tag.textContent = fx;
      var b = AMH.blog.parseManifest();
      tag.textContent = saved;
      console.warn = ow;
      function pick(o) { return { nextPost: o.nextPost, nextImg: o.nextImg, stamp: o.stamp,
        monthStamps: o.monthStamps, months: o.months,
        ids: o.entries.map(function (e) { return e.date + e.id + e.title; }) }; }
      return { a: pick(a), b: pick(b), warned: warned };
    })()`);
    const wantParsed = JSON.stringify({ nextPost: 7, nextImg: 12, stamp: "abc123",
      monthStamps: { "2606": "zz00aa", "2607": "k9d2m1" }, months: ["2607", "2606"],
      ids: ["2606100002June post", "2607110001E2E first post"] });
    check("manifest: both parsers read counters, stamp, month lines and entries alike from one fixture",
      JSON.stringify(parsers.a) === wantParsed && JSON.stringify(parsers.b) === wantParsed,
      JSON.stringify(parsers.a) + " | " + JSON.stringify(parsers.b));
    check("manifest: a line neither parser understands is reported by both, and skipped",
      parsers.warned.length === 2 && parsers.warned.every((w) => /bogus line here/.test(w)),
      JSON.stringify(parsers.warned));
    // a publish writes two regions on this page now: the manifest and the
    // index card for the post. Everything else must still be untouched.
    check("bundle blog.html byte-identical outside the manifest and the index",
      stripSpans(outIdx, ["blog-stream", "blog-manifest"]) ===
      stripSpans(srcIdx, ["blog-stream", "blog-manifest"]));
    const streamSpan = outIdx.slice(outIdx.indexOf("<!--[edit:blog-stream]-->"),
      outIdx.indexOf("<!--[/edit:blog-stream]-->"));
    // ST-A. the stream is the newest month in full, in the A markup: the
    // "s" id, the byline with the time as the permanent link, the body
    // with root-relative image paths, and no source block anywhere.
    check("stream: the post is written in full, with an s id and the byline",
      /<article class="bs-post" id="s0001" data-id="0001" data-date="260711"/.test(streamSpan) &&
      /<img class="bs-post__avatar" src="aaron-portfolio-portrait-transparent\.png" alt="" \/>/.test(streamSpan) &&
      streamSpan.includes("<b>AARON M. HARRIS</b>") &&
      /<a class="bs-post__when" href="blog\/2607\.html#p0001"><time datetime="2026-07-11T\d\d:\d\d">July 11, 2026 · \d{1,2}:\d\d [ap]m<\/time><span class="bs-post__zone">[^<]+<\/span><\/a>/.test(streamSpan) &&
      /<h3 class="bs-post__title">E2E first post<\/h3>/.test(streamSpan),
      streamSpan.replace(/\s+/g, " ").slice(0, 260));
    check("stream: the body is the whole post, with root paths and no source block",
      streamSpan.includes('<div class="bs-post__body">') &&
      streamSpan.includes('<figure class="bp-fig"><img src="blog/260711_img0001.jpg"') &&
      !streamSpan.includes('src="../blog/') && !streamSpan.includes("x-blog-source") &&
      streamSpan.includes("Tail paragraph with <strong>bold</strong>") &&
      streamSpan.includes('<p class="bm-older bm-older--end">This is the first month.</p>'),
      streamSpan.replace(/\s+/g, " ").slice(0, 200));

    const month = zipFiles["blog/2607.html"].toString("utf8");
    const srcM = /<scr[i]pt type="text\/x-blog-source" data-format="md">\n([\s\S]*?)\n<\/scr[i]pt>/.exec(month);
    const decoded = srcM ? srcM[1].replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&") : "";
    check("month file: article shell + static figures + head parity",
      month.includes('id="p0001"') && month.includes('data-date="260711"') &&
      month.includes('<figure class="bp-fig">') &&
      month.includes('alt="Alt one"') && month.includes("<figcaption>Cap two</figcaption>") &&
      month.includes('name="twitter:card"') && month.includes("fonts.googleapis.com") &&
      month.includes('href="../site.css"'),
      month.length + " chars");
    check("x-blog-source round-trips exactly",
      decoded.includes("[img0001,Cap one|Alt one][png0002,Cap two]") &&
      decoded.includes("Escape probe: &lt;/scr" + "ipt&gt; as text"),
      decoded.slice(0, 90));
    // the only month is the first month: no prev, the end note, and the
    // the trunks, in the site's order. The editor comes last, as it does on
    // every managed page, because a consumer that claims its own regions has
    // to have claimed before the editor scans.
    check("chain: the first month says so, carries no prev, and loads the trunks in order",
      !/rel="prev"/.test(month) && month.includes('<p class="bm-older bm-older--end">This is the first month.</p>') &&
      /<script defer src="\.\.\/site\.js"><\/script>\n\s*<script defer src="\.\.\/work\.js"><\/script>\n\s*<script defer src="\.\.\/blog\.js"><\/script>\n\s*<script defer src="\.\.\/tool\.js"><\/script>\n\s*<script defer src="\.\.\/publish\.js"><\/script>/.test(month),
      (month.match(/bm-older[^\n]*/) || [""])[0]);

    check("bundle ships no stylesheet (site.css is a repo file)",
      !Object.keys(zipFiles).some((n) => n.endsWith(".css")),
      Object.keys(zipFiles).filter((n) => n.endsWith(".css")).join(", ") || "none");
    // Read exactly, not by substring: a base URL with the page still on the
    // end of it contains every right-looking path and is wrong at every one.
    const sm = zipFiles["sitemap.xml"].toString("utf8");
    const locs = [...sm.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
    const ROOT = "https://aaronmichaelharris.com/";
    const wantLocs = [ROOT, ROOT + "gallery.html", ROOT + "blog.html",
                      ROOT + "blog/2607.html"];
    check("sitemap lists every managed page and every month, and nothing else",
      JSON.stringify(locs) === JSON.stringify(wantLocs), JSON.stringify(locs));
    check("robots points at the sitemap at the site root",
      zipFiles["robots.txt"].toString("utf8").includes("Sitemap: " + ROOT + "sitemap.xml"),
      zipFiles["robots.txt"].toString("utf8").trim().split("\n").pop());
    check("month page canonical and og:url sit at the site root",
      month.includes('<link rel="canonical" href="' + ROOT + 'blog/2607.html" />') &&
      month.includes('property="og:url" content="' + ROOT + 'blog/2607.html"'),
      (/canonical" href="([^"]+)"/.exec(month) || [])[1]);
    // MC1. A month file is a page of this site, not a leaf of it. It cannot
    // hold marked regions, because it is generated, so it holds the BYTES of
    // the shared spans, lifted whole from the managed page that published it.
    // The editor keeps those spans byte-identical across managed pages, so
    // one comparison against the blog page proves the month file agrees with
    // all of them. Paths get one step up, because the file sits in blog/.
    const blogSrc = zipFiles["blog.html"].toString("utf8");
    const liftPaths = (html) => html.replace(/\b(src|href)="([^"]*)"/g, (all, at, v) => {
      if (!v || v.charAt(0) === "#" || v.charAt(0) === "/") return all;
      if (/^[a-z][a-z0-9+.-]*:/i.test(v)) return all;
      if (v.slice(0, 3) === "../") return all;
      return at + '="../' + v + '"';
    });
    const cut = (src, open, close) => {
      const a = src.indexOf(open);
      if (a === -1) return "";
      const b = src.indexOf(close, a);
      return b === -1 ? "" : src.slice(a, b + close.length);
    };
    const wantHeader = liftPaths(cut(blogSrc, '<header class="site-header"', "</header>"));
    const wantContact = liftPaths(cut(blogSrc, '<section class="contact"', "</section>"));
    // the comparison is against the blog.html of THIS bundle, so it proves
    // the two files the publish just wrote agree with each other
    check("month page carries the site header, byte-identical to the page that published it",
      wantHeader.length > 200 && month.includes(wantHeader),
      wantHeader ? (month.includes(wantHeader) ? "header " + wantHeader.length + " bytes"
        : firstDiff(wantHeader, month.slice(month.indexOf('<header class="site-header"'))))
        : "no header found in the bundle's blog.html");
    check("month page carries the contact block, byte-identical to the page that published it",
      wantContact.length > 200 && month.includes(wantContact) &&
      /class="endbar"/.test(month),
      wantContact ? (month.includes(wantContact) ? "contact " + wantContact.length + " bytes"
        : firstDiff(wantContact, month.slice(month.indexOf('<section class="contact"'))))
        : "no contact found in the bundle's blog.html");
    // the drawer needs its scrim, or the nav is unusable on a phone
    check("month page carries the nav scrim and the progress bar",
      month.includes('id="navOverlay"') && month.includes('id="progress"'),
      JSON.stringify({ scrim: month.includes('id="navOverlay"'),
                       progress: month.includes('id="progress"') }));
    // MC2. every relative path in the lifted chrome steps up one folder, and
    // a scheme, a root path and a bare fragment are left alone
    check("month page: the lifted chrome's paths are written for a page in blog/",
      month.includes('href="../index.html#work"') && month.includes('href="../gallery.html"') &&
      month.includes('href="../blog.html"') && month.includes('href="#contact"') &&
      month.includes('src="../aaron-portfolio-portrait-transparent.png"') &&
      month.includes('href="mailto:contact@aaronmichaelharris.com"'),
      (month.match(/href="\.\.\/[^"]*"/g) || []).slice(0, 6).join(" "));
    check("month page links back to the blog page in its heading",
      month.includes('href="../blog.html?b=2607"'),
      (/bm-top__stream" href="([^"]+)"/.exec(month) || [])[1]);
    // MC3b. The editor comes to a month page too, so the corner mark is on
    // every page of the site rather than on three of them. It cannot publish
    // from here, which the composer says for itself; see the runtime checks.
    check("month page: it loads the editor as well as the reading engine",
      month.includes('src="../tool.js"') && month.includes('src="../publish.js"') &&
      month.includes('src="../site.js"') && month.includes('src="../blog.js"'),
      (month.match(/<script defer src="[^"]*"><\/script>/g) || []).join(" "));

    // MC3. the bar carries the two controls and no label. The header above
    // names the site and the heading names the month, so a third name in the
    // bar would say nothing new.
    const barBlock = (month.match(/<div class="bs-bar"[\s\S]*?\n    <\/div>/) || [""])[0];
    check("month page: the bar is the two controls, with no label of its own",
      /id="blogFind"/.test(barBlock) && /id="blogMonth"/.test(barBlock) &&
      !/bs-bar__name|bs-bar__full|bs-bar__short/.test(month) &&
      !/class="bm-foot"/.test(month),
      barBlock.replace(/\s+/g, " ").slice(0, 150));
    // MP1. the month page is the stream's own design: the same bar, the
    // same post markup with "p" ids, and its own month list for the picker
    check("month page: the same bar as the stream, with the find slot and the picker",
      /<div class="bs-bar" id="blogBar">/.test(month) && month.includes('id="blogFind"') &&
      month.includes('<select class="bs-bar__month" id="blogMonth"'),
      (month.match(/<div class="bs-bar"[\s\S]*?<\/div>/) || [""])[0].replace(/\s+/g, " ").slice(0, 200));
    // MP1b. the bar holds three items and no more. The month name and the
    // stream link live in the heading above it, because a 600px measure
    // cannot fit five items on one row and the bar then wraps at every width.
    const barHTML = (month.match(/<div class="bs-bar"[\s\S]*?\n    <\/div>/) || [""])[0];
    check("month page: the bar holds three items, and the month heading holds the rest",
      !/bs-bar__label/.test(barHTML) && !/bs-bar__stream/.test(barHTML) &&
      /<div class="bm-top">/.test(month) &&
      month.includes('<h1 class="bm-top__month">July 2026</h1>') &&
      // the eyebrow is read from the blog page's own marked region, like the
      // wordmark, so a rename in the editor reaches every month file
      month.includes('<span class="eyebrow">' +
        /\[edit:blog-eyebrow\]-->\s*<span class="eyebrow">([^<]*)</
          .exec(readFileSync(join(REPO, "blog.html"), "utf-8"))[1] + "</span>") &&
      month.indexOf('class="bm-top"') < month.indexOf('class="bs-bar"'),
      barHTML.replace(/\s+/g, " ").slice(0, 160));
    check("month page: the posts are the stream's markup with p ids, and keep their source",
      /<article class="bs-post" id="p0001" data-id="0001" data-date="260711"/.test(month) &&
      month.includes('<a class="bs-post__when" href="#p0001">') &&
      month.includes('<img class="bs-post__avatar" src="../aaron-portfolio-portrait-transparent.png"') &&
      month.includes('<div class="bs-post__body">') && month.includes('data-format="md"') &&
      !/class="blog-post"/.test(month),
      (month.match(/<article[^>]*>/) || [""])[0]);
    check("month page: it states its own month list, for the picker",
      /<script id="blogManifest" type="text\/plain" data-ced="blog">\nmonths:2607\n<\/script>/.test(month),
      (month.match(/months:[^\n]*/) || [""])[0]);
    check("published images are real files (jpg magic + png magic)",
      zipFiles["blog/260711_img0001.jpg"][0] === 0xFF && zipFiles["blog/260711_img0001.jpg"][1] === 0xD8 &&
      zipFiles["blog/260711_img0002.png"][1] === 0x50);
  }

  // BL5. serve the extracted bundle and read it like a visitor
  const { mkdirSync, rmSync } = await import("node:fs");
  const bdir = mkdtempSync(join(tmpdir(), "blog-bundle-"));
  let bs = null;
  const B = "http://127.0.0.1:8124/";
  function writeBundle(files) {
    for (const [name, data] of Object.entries(files)) {
      mkdirSync(join(bdir, dirname(name)), { recursive: true });
      writeFileSync(join(bdir, name), data);
    }
  }
  // Click one of the two delivery buttons on whatever step is showing.
  // Returns true when it was there to click. The suite drives the zip route
  // almost everywhere, because a zip is what it can read back; the folder
  // route has its own checks against a stubbed writer.
  async function pressRoute(label = "Download a .zip") {
    return await evaluate(`(function () {
      var box = document.querySelector('.bc-wizard');
      if (!box) return false;
      var b = [...box.querySelectorAll('.ced-modal__btns button')]
        .find(function (x) { return x.textContent === ${JSON.stringify(label)}; });
      if (!b || b.disabled) return false;
      b.click();
      return true;
    })()`);
  }
  // Wait for the route step a delete or a rebuild shows, then take the zip.
  async function passRouteStep(label = "Download a .zip") {
    for (let i = 0; i < 30; i++) {
      await sleep(150);
      const step = await evaluate(`(document.querySelector('.bc-wizard') || {getAttribute(){return null}}).getAttribute('data-step')`);
      if (step === "route") return await pressRoute(label);
      if (step === "progress" || step === "done" || step === "failed") return true;
    }
    return false;
  }
  // Publish through the wizard. Clicks Publish, then the confirm step's
  // delivery button when it appears. With the reminder switched off the step
  // is a notice that proceeds on its own, so the helper also returns when the
  // wizard has moved past the confirm step by itself.
  async function pressPublish() {
    await evaluate(`[...document.querySelectorAll('.bc-btns .ced-btn')].find(b => b.textContent === 'Publish').click()`);
    for (let i = 0; i < 30; i++) {
      await sleep(150);
      const r = await evaluate(`(function () {
        var box = document.querySelector('.bc-wizard');
        if (!box) return "none";
        var step = box.getAttribute('data-step');
        if (step === 'confirm') {
          var b = [...box.querySelectorAll('.ced-modal__btns button')].find(function (x) { return x.textContent === 'Download a .zip'; });
          if (b) { b.click(); return "built"; }
        }
        return step;
      })()`);
      if (r === "built" || r === "progress" || r === "done" || r === "failed") return r;
    }
    return "timeout";
  }
  async function capturePublish() {
    let b64 = null;
    for (let i = 0; i < 30 && !b64; i++) { await sleep(500); b64 = await evaluate(`window.__zipB64`); }
    return b64 ? unzipStore(Buffer.from(b64, "base64")) : null;
  }
  if (zipB64) {
    writeBundle(zipFiles);
    // The stylesheet and the four script trunks are repo files, not bundle
    // files. Copy them in so the served bundle behaves like the deployed site.
    for (const f of ["site.css", "site.js", "work.js", "blog.js", "markdown.js", "tool.js",
                     "publish.js", "index.html"]) {
      writeFileSync(join(bdir, f), readFileSync(join(REPO, f)));
    }
    // blog.html is NOT copied from the repo here: this directory is the
    // extracted bundle, so its blog.html is the one the publish just wrote.
    bs = spawn("py", ["-3", "-m", "http.server", "8124", "--bind", "127.0.0.1"], { cwd: bdir, stdio: "ignore" });
    await sleep(1500);
    await send("Page.navigate", { url: "http://127.0.0.1:8124/blog.html" });
    await sleep(2200);
    check("bundle: the blog page shows its stream",
      await evaluate(`!!document.getElementById('blogStream')`));
    await sleep(600);
    // No fetch happens here at all: the posts are in the page. That is what
    // makes this page readable when it is opened from disk.
    await evaluate(`window.__blogFetches = 0; (function () { const of = window.fetch;
      window.fetch = function () { window.__blogFetches++; return of.apply(this, arguments); }; })();`);
    const stream = await evaluate(`({
      posts: document.querySelectorAll('.bs-post').length,
      post: !!document.getElementById('s0001'),
      title: (document.querySelector('#s0001 .bs-post__title') || {}).textContent || '',
      when: (document.querySelector('#s0001 .bs-post__when') || { getAttribute: () => '' }).getAttribute('href') || '',
      figs: document.querySelectorAll('#s0001 .bs-post__body figure.bp-fig img').length,
      imgOk: [...document.querySelectorAll('#s0001 .bs-post__body img')].every(i => i.naturalWidth > 0),
      body: (document.querySelector('#s0001 .bs-post__body') || {}).textContent || '',
      fetches: window.__blogFetches,
    })`);
    check("bundle: the stream carries the published post in full, images and all",
      stream.posts === 1 && stream.post && stream.title === "E2E first post" &&
      stream.when === "blog/2607.html#p0001" && stream.figs === 2 && stream.imgOk &&
      /Tail paragraph with bold/.test(stream.body) && stream.fetches === 0,
      JSON.stringify(stream).slice(0, 240));
    // FN1. the grammar, every case in tools/e2e/fixtures/queries.txt run
    // through the page's own parser
    const qRaw = readFileSync(join(REPO, "tools/e2e/fixtures/queries.txt"), "utf8").replace(/\r/g, "");
    const qCases = qRaw.split("\n").filter((l) => l.indexOf("\t") !== -1)
      .map((l) => ({ q: l.slice(0, l.indexOf("\t")), want: l.slice(l.indexOf("\t") + 1) }));
    const parsed = await evaluate(`(function (qs) {
      return qs.map(function (q) { return JSON.stringify(AMH.search.parse(q)); });
    })(${JSON.stringify(qCases.map((c) => c.q))})`);
    const qBad = qCases.filter((c, i) => parsed[i] !== c.want);
    check("find: every query in the fixture parses as the fixture says (" + qCases.length + " cases)",
      qCases.length >= 10 && qBad.length === 0,
      qBad.length ? JSON.stringify(qBad[0].q) + " got " + parsed[qCases.indexOf(qBad[0])] : "");

    // FN2. the matcher and the passage, on a table built here so every
    // rule is exercised whatever the blog happens to hold
    const matched = await evaluate(`(function () {
      var posts = [
        { id: "0001", date: "260711", title: "Planetarium test run", tags: "xr planetarium",
          text: "We ran the dome projection test today and the headset finally agreed with it.",
          caps: ["Dome and headset, same frame."], thumb: "" },
        { id: "0002", date: "260712", title: "Quiet week", tags: "notes",
          text: "Nothing to report.", caps: [], thumb: "" }
      ];
      function ids(q) {
        var g = AMH.search.parse(q);
        return posts.filter(function (p) { return AMH.search.match(p, g); })
          .map(function (p) { return p.id; }).join(",");
      }
      function pass(q, i) { return AMH.search.passage(posts[i || 0], AMH.search.parse(q)); }
      return {
        word: ids("dome"), caption: ids("frame"), tagWord: ids("planetarium"),
        tagOnly: ids("#xr"), tagMiss: ids("#dome"),
        phrase: ids('"dome projection"'), phraseApart: ids('"projection dome"'),
        andBoth: ids("dome headset"), andMiss: ids("dome nothing"),
        or: ids("dome, nothing"), none: ids("absent"),
        passWord: pass("projection"), passCap: pass("frame"), passTag: pass("#xr"),
        /* case: a word ignores it, a quoted phrase keeps it */
        wordUpper: ids("DOME"), wordMixed: ids("Dome"), tagUpper: ids("#XR"),
        titleMixed: ids("planetarium"),
        phraseSameCase: ids('"dome projection"'),
        phraseWrongCase: ids('"Dome Projection"'),
        phraseCapCase: ids('"Dome and headset"'),
        passPhraseCase: pass('"Dome and headset"')
      };
    })()`);
    check("find: a word, a caption and a tag each find the right posts, and or and and hold",
      matched.word === "0001" && matched.caption === "0001" && matched.tagWord === "0001" &&
      matched.tagOnly === "0001" && matched.tagMiss === "" &&
      matched.andBoth === "0001" && matched.andMiss === "" &&
      matched.or === "0001,0002" && matched.none === "",
      JSON.stringify(matched).slice(0, 240));
    check("find: a phrase matches in order and not apart",
      matched.phrase === "0001" && matched.phraseApart === "",
      matched.phrase + " | " + matched.phraseApart);
    // FN2b. Case. A plain word and a tag ignore it, so a reader who types
    // omg finds OMG. A quoted phrase keeps it, which is how a reader asks
    // for exactly what they typed.
    check("find: a plain word and a tag ignore case",
      matched.wordUpper === "0001" && matched.wordMixed === "0001" &&
      matched.tagUpper === "0001" && matched.titleMixed === "0001",
      JSON.stringify({ upper: matched.wordUpper, mixed: matched.wordMixed,
                       tag: matched.tagUpper, title: matched.titleMixed }));
    check("find: a quoted phrase keeps case, and the passage marks the same text",
      matched.phraseSameCase === "0001" && matched.phraseWrongCase === "" &&
      matched.phraseCapCase === "0001" &&
      matched.passPhraseCase.hit === "Dome and headset",
      JSON.stringify({ same: matched.phraseSameCase, wrong: matched.phraseWrongCase,
                       cap: matched.phraseCapCase,
                       hit: matched.passPhraseCase.hit }));
    check("find: the passage marks the hit, reaches into a caption, and stands in for a tag query",
      matched.passWord.hit === "projection" && /dome $/.test(matched.passWord.before) &&
      matched.passCap.hit === "frame" && /Dome and headset/.test(matched.passCap.before) &&
      matched.passTag.hit === "" && /^We ran the dome/.test(matched.passTag.before),
      JSON.stringify(matched.passWord) + " " + JSON.stringify(matched.passTag).slice(0, 90));

    // FN3. the pill: it is in the bar, it loads nothing until it is
    // focused, and typing brings the list up
    const pill = await evaluate(`(function () {
      var before = [].slice.call(document.querySelectorAll('script[src]'))
        .filter(function (s) { return /search\.js$/.test(s.getAttribute('src')); }).length;
      var input = document.querySelector('.bs-find__pill input');
      input.focus();
      return new Promise(function (res) { setTimeout(function () {
        var after = [].slice.call(document.querySelectorAll('script[src]'))
          .filter(function (s) { return /search\.js$/.test(s.getAttribute('src')); }).length;
        input.value = 'e2e';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        setTimeout(function () {
          var list = document.querySelector('.bs-find__list');
          var hit = list.querySelector('.bs-find__hit');
          res({ inBar: !!document.querySelector('#blogBar .bs-find'),
                placeholder: input.placeholder, before: before, after: after,
                open: !list.hidden,
                count: (list.querySelector('.bs-find__count') || {}).textContent || '',
                href: hit ? hit.getAttribute('href') : '',
                title: hit ? hit.querySelector('b').textContent : '',
                date: hit ? hit.querySelector('small').textContent : '',
                thumb: hit ? hit.querySelector('.bs-find__thumb').tagName : '',
                mark: hit ? (hit.querySelector('mark') || {}).textContent || '' : '',
                role: list.getAttribute('role') });
        }, 500);
      }, 900); });
    })()`, { awaitPromise: true });
    check("find: the pill sits in the bar and loads the index only when it is focused",
      pill.inBar && pill.before === 0 && pill.after === 1 &&
      pill.placeholder === "Search posts, tags, captions" && pill.role === "listbox",
      JSON.stringify(pill).slice(0, 200));
    check("find: typing opens the list with the count, the post, its date and the marked hit",
      pill.open && pill.count === "1 post" && pill.href === "blog/2607.html#p0001" &&
      pill.title === "E2E first post" && /July 11, 2026/.test(pill.date) &&
      pill.thumb === "IMG" && pill.mark === "e2e",
      JSON.stringify(pill).slice(0, 240));

    // FN4. a hit for a post that is on this page scrolls to it; Escape
    // and a click outside close the list
    const click = await evaluate(`(function () {
      var list = document.querySelector('.bs-find__list');
      var input = document.querySelector('.bs-find__pill input');
      var hit = list.querySelector('.bs-find__hit');
      var ev = new MouseEvent('click', { bubbles: true, cancelable: true });
      hit.dispatchEvent(ev);
      return new Promise(function (res) { setTimeout(function () {
        var out = { prevented: ev.defaultPrevented, closed: list.hidden,
                    path: location.pathname,
                    target: !!document.querySelector('.bs-post.is-target#s0001') };
        /* and the two ways it closes */
        input.value = 'e2e'; input.dispatchEvent(new Event('input', { bubbles: true }));
        setTimeout(function () {
          out.reopened = !list.hidden;
          input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
          out.escaped = list.hidden;
          input.dispatchEvent(new Event('input', { bubbles: true }));
          setTimeout(function () {
            document.body.click();
            out.outside = list.hidden;
            res(out);
          }, 400);
        }, 400);
      }, 400); });
    })()`, { awaitPromise: true });
    check("find: a hit for a post on this page scrolls to it rather than leaving",
      click.prevented && click.closed && /blog\.html$/.test(click.path) && click.target,
      JSON.stringify(click).slice(0, 200));
    check("find: Escape closes the list, and so does a click outside it",
      click.reopened && click.escaped && click.outside, JSON.stringify(click).slice(0, 200));

    // FN5. the arrows walk the list and Enter takes the one they are on
    const keys = await evaluate(`(function () {
      var input = document.querySelector('.bs-find__pill input');
      var list = document.querySelector('.bs-find__list');
      input.value = 'e2e'; input.dispatchEvent(new Event('input', { bubbles: true }));
      return new Promise(function (res) { setTimeout(function () {
        function press(k) { input.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true })); }
        press('ArrowDown');
        var at = list.querySelectorAll('.bs-find__hit.is-at').length;
        press('Enter');
        setTimeout(function () {
          res({ at: at, closed: list.hidden, target: !!document.querySelector('.is-target#s0001') });
        }, 300);
      }, 400); });
    })()`, { awaitPromise: true });
    check("find: the arrows move through the hits and Enter opens the one they are on",
      keys.at === 1 && keys.closed && keys.target, JSON.stringify(keys));

    // SR2. the loader: nothing is fetched until something asks, then the
    // script tag brings the index in and it is unpacked once
    const loaded = await evaluate(`(function () {
      var before = [].slice.call(document.querySelectorAll('script[src]')).map(function (s) { return s.getAttribute('src'); });
      return AMH.search.load().then(function (table) {
        var after = [].slice.call(document.querySelectorAll('script[src]')).map(function (s) { return s.getAttribute('src'); });
        return AMH.search.load().then(function (again) {
          return AMH.search.tags().then(function (tags) {
            return { before: before.indexOf('search.js') !== -1,
                     after: after.indexOf('search.js') !== -1,
                     tagsCount: after.filter(function (s) { return s === 'search.js'; }).length,
                     posts: table.posts.length, same: table === again,
                     id: table.posts[0].id, text: table.posts[0].text.slice(0, 20),
                     tags: tags };
          });
        });
      });
    })()`, { awaitPromise: true });
    // the pill above already proved nothing loads until it is asked for;
    // what matters here is that asking twice loads once
    check("search: the index is fetched once however many times it is asked for",
      loaded.after === true && loaded.tagsCount === 1 && loaded.same,
      JSON.stringify(loaded).slice(0, 200));
    check("search: load() gives the table and tags() counts the tags",
      loaded.posts === 1 && loaded.id === "0001" && /^First e2e post/.test(loaded.text) &&
      JSON.stringify(loaded.tags) === "[]",
      JSON.stringify(loaded).slice(0, 200));

    await send("Page.navigate", { url: "http://127.0.0.1:8124/blog.html?b=p0001" });
    await sleep(2200);
    check("bundle: ?b=p0001 deep link lands on the post in the stream",
      await evaluate(`!!document.querySelector('.bs-post.is-target#s0001')`));
    const postCanon = await evaluate(`document.querySelector('link[rel="canonical"]').getAttribute('href')`);
    check("bundle: the blog page stays canonical for itself",
      /\/blog\.html$/.test(postCanon), postCanon);

    await send("Page.navigate", { url: "http://127.0.0.1:8124/blog.html?b=p9999" });
    await sleep(2200);
    const unknown = await evaluate(`({
      note: (document.querySelector('.bs-note') || {}).textContent || '',
      post: !!document.getElementById('s0001'),
    })`);
    check("bundle: an unknown target says so and shows the latest",
      /wasn't found/.test(unknown.note) && unknown.post, JSON.stringify(unknown));
    await send("Page.navigate", { url: "http://127.0.0.1:8124/blog/2607.html" });
    await sleep(1800);
    const monthPage = await evaluate(`({
      cls: document.body.className,
      figs: document.querySelectorAll('figure.bp-fig').length,
      brand: !!document.querySelector('.site-header .brand__title'),
    })`);
    // the figures and the brand are in the file; the classes on the body
    // are the two trunks saying they ran, and nothing else
    check("bundle: standalone month page renders statically",
      /^blog-month(?: ga-[dm]-\w+| loaded)*$/.test(monthPage.cls) &&
      monthPage.figs === 2 && monthPage.brand,
      JSON.stringify(monthPage));

    // MC4. the chrome is not only present, it works: site.js wires the nav on
    // a month page the same way it does everywhere else.
    const chrome = await evaluate(`(function () {
      var nav = document.getElementById('nav');
      var links = nav ? [...nav.querySelectorAll('a')].map(function (a) { return a.getAttribute('href'); }) : [];
      var current = nav ? [...nav.querySelectorAll('a[aria-current="page"]')].map(function (a) { return a.getAttribute('href'); }) : [];
      var bar = document.getElementById('blogBar');
      var head = document.querySelector('.site-header');
      return {
        links: links, current: current,
        toggle: !!document.getElementById('navToggle'),
        scrim: !!document.getElementById('navOverlay'),
        contact: !!document.getElementById('contact'),
        endbar: !!document.querySelector('.endbar'),
        headerH: getComputedStyle(document.documentElement).getPropertyValue('--header-h').trim(),
        headerTop: getComputedStyle(document.documentElement).getPropertyValue('--header-top').trim(),
        /* the column must START below the fixed header, and the bar must be
           in the flow rather than pinned to anything */
        barPosition: bar ? getComputedStyle(bar).position : 'none',
        barTop: bar ? Math.round(bar.getBoundingClientRect().top) : -1,
        headBottom: head ? Math.round(head.getBoundingClientRect().bottom) : -1,
        clears: head && bar ? bar.getBoundingClientRect().top >= head.getBoundingClientRect().bottom - 2 : false
      };
    })()`);
    check("month page: the full site nav is there and Blog is the current item",
      chrome.links.length === 5 && chrome.links.indexOf("../gallery.html") !== -1 &&
      chrome.links.indexOf("../index.html#work") !== -1 &&
      JSON.stringify(chrome.current) === '["../blog.html"]' &&
      chrome.toggle && chrome.scrim,
      JSON.stringify({ links: chrome.links, current: chrome.current }));
    check("month page: the contact block and its endbar are on the page",
      chrome.contact && chrome.endbar, JSON.stringify(chrome).slice(0, 160));
    // MC4c. The corner mark, on a month page as on every other page. It
    // cannot publish from here: a month page carries its month list and not
    // the counters, so the composer refuses and says where its home is.
    const corner = await evaluate(`(function () {
      var el = document.querySelector('.amh-edit');
      if (!el) return { present: false };
      var r = el.getBoundingClientRect();
      var cs = getComputedStyle(el);
      var top = document.elementFromPoint(Math.round(r.left + r.width / 2),
                                          Math.round(r.top + r.height / 2));
      if (!AMH.tool.editorOn()) window.edit();
      return { present: true, visible: cs.visibility === 'visible' && cs.display !== 'none',
               clickable: !!top && (top === el || el.contains(top)),
               composerSays: String(window.edit.blog()),
               composerOpened: !!document.querySelector('.bc-write'),
               postButtons: [...document.querySelectorAll('.bs-post button')]
                 .filter(function (b) { return /^Edit p/.test(b.textContent); }).length };
    })()`);
    check("month page: the corner mark is there, seen and clickable, as on every page",
      corner.present && corner.visible && corner.clickable,
      JSON.stringify(corner));
    check("month page: the composer refuses here and names the page that can publish",
      /blog\.html/.test(corner.composerSays) && corner.composerOpened === false &&
      corner.postButtons > 0,
      JSON.stringify({ says: corner.composerSays, opened: corner.composerOpened,
                       buttons: corner.postButtons }));

    // MC4d. Editing a post from a month page moves the work to the page that
    // has the manifest, rather than refusing. The address is tidied on
    // arrival, so a reload is a plain blog page.
    const handed = await evaluate(`String(window.edit.blog.edit('0001'))`);
    await sleep(2600);
    const handedTo = await evaluate(`({
      path: location.pathname, search: location.search,
      composer: !!document.querySelector('.bc-write'),
      date: (document.querySelector('.bc-date') || {}).value || ''
    })`);
    check("month page: Edit hands the post to the blog page and the address is tidied",
      /opening blog\.html/.test(handed) && /blog\.html$/.test(handedTo.path) &&
      handedTo.search === "" && handedTo.composer === true && /^\d{6}$/.test(handedTo.date),
      JSON.stringify({ handed, ...handedTo }));
    await evaluate(`[...document.querySelectorAll('.bc-btns .ced-btn')].find(function (b) { return b.textContent === 'Close'; })?.click()`);
    await sleep(400);
    await send("Page.navigate", { url: "http://127.0.0.1:8124/blog/2607.html" });
    await sleep(1600);

    // MC4b. Only the site header is pinned. The bar scrolls away with the
    // page, which is the whole point of it not being sticky, so scrolling
    // past it must actually move it off the top of the window.
    const scrolled = await evaluate(`(function () {
      var bar = document.getElementById('blogBar');
      var head = document.querySelector('.site-header');
      var before = Math.round(bar.getBoundingClientRect().top);
      window.scrollTo(0, 600);
      return new Promise(function (res) { setTimeout(function () {
        res({ before: before,
              after: Math.round(bar.getBoundingClientRect().top),
              headerStill: Math.round(head.getBoundingClientRect().top),
              /* the search results must still paint over the cards below */
              barZ: getComputedStyle(bar).zIndex });
      }, 400); });
    })()`, { awaitPromise: true });
    check("month page: the bar scrolls away while the site header stays put",
      scrolled.after < scrolled.before - 400 && scrolled.headerStill === 0 &&
      scrolled.barZ === "5",
      JSON.stringify(scrolled));
    await evaluate(`window.scrollTo(0, 0)`);
    await sleep(400);
    // the header is fixed, so the column must start below it. The clearance
    // reads --header-top, the height BEFORE the header shrinks, or the page
    // would be pulled up by the difference in the middle of a scroll.
    check("month page: the column clears the fixed header, by its unscrolled height",
      /^\d+px$/.test(chrome.headerH) && /^\d+px$/.test(chrome.headerTop) && chrome.clears,
      JSON.stringify({ headerH: chrome.headerH, headerTop: chrome.headerTop,
                       barTop: chrome.barTop, headBottom: chrome.headBottom }));

    // MC5. Contact resolves. Every page carries the block today, so the link
    // is an in-page jump; with the block gone it must follow the site's own
    // copy rather than silently doing nothing, which is the hinge for making
    // contact a page of its own later.
    const contactJump = await evaluate(`(function () {
      var before = window.scrollY;
      [...document.querySelectorAll('#nav a')].find(function (a) { return a.getAttribute('href') === '#contact'; }).click();
      return { moved: window.scrollY > before, still: location.pathname };
    })()`);
    check("month page: Contact jumps to the block on this page",
      contactJump.moved === true && /2607\.html$/.test(contactJump.still),
      JSON.stringify(contactJump));
    await evaluate(`document.getElementById('contact').remove()`);
    await evaluate(`[...document.querySelectorAll('#nav a')].find(function (a) { return a.getAttribute('href') === '#contact'; }).click()`);
    await sleep(1500);
    const contactAway = await evaluate(`location.pathname + location.hash`);
    check("month page: with no block on the page, Contact follows the site's own copy",
      /\/index\.html#contact$/.test(contactAway), contactAway);
    await send("Page.navigate", { url: "http://127.0.0.1:8124/blog/2607.html" });
    await sleep(1500);

    // MB1. The two surfaces are one column. A post used to be 504px wide on
    // its own page against the stream's 550px, because the month wrapper
    // took its gutter out of the 600px measure instead of adding it on.
    // Rows are counted by vertical overlap, not by matching tops: the bar
    // centres its items, so a short span and a taller select share a row
    // without sharing a top edge. Two items are on one row when their
    // vertical ranges meet.
    const COLUMN = `(function () {
      var post = document.querySelector('.bs-post');
      var bar = document.getElementById('blogBar');
      var boxes = Array.prototype.map.call(bar.children, function (c) {
        return c.getBoundingClientRect();
      }).sort(function (a, b) { return a.top - b.top; });
      var rows = 0, edge = -Infinity;
      boxes.forEach(function (b) {
        if (b.top >= edge) rows++;
        edge = Math.max(edge, b.bottom);
      });
      var input = document.querySelector('.bs-find__pill input');
      return { post: Math.round(post.getBoundingClientRect().width),
               barH: Math.round(bar.getBoundingClientRect().height),
               rows: rows,
               input: input ? Math.round(input.getBoundingClientRect().width) : 0 };
    })()`;
    for (const [w, mobile] of [[1280, false], [768, false], [390, true]]) {
      await send("Emulation.setDeviceMetricsOverride",
        { width: w, height: 900, deviceScaleFactor: 1, mobile });
      await send("Page.navigate", { url: "http://127.0.0.1:8124/blog.html" });
      await sleep(1500);
      const onStream = await evaluate(COLUMN);
      await send("Page.navigate", { url: "http://127.0.0.1:8124/blog/2607.html" });
      await sleep(1500);
      const onMonth = await evaluate(COLUMN);
      check("month page @" + w + ": a post is the same width as it is in the stream",
        Math.abs(onStream.post - onMonth.post) <= 1,
        "stream " + onStream.post + " vs month " + onMonth.post);
      // MB2. one row, at every width. Five items in the bar wrapped at every
      // width from 390 to 1600, which is what made the page look scrunched.
      // Both bars are checked: the search box's floor is wide enough to push
      // the picker onto a second row, and the stream's bar is the one with
      // the least slack, because its picker carries a count.
      check("month page @" + w + ": the bar holds one row, and so does the stream's",
        onMonth.rows === 1 && onStream.rows === 1,
        "stream " + onStream.barH + "px/" + onStream.rows + " row vs month " +
        onMonth.barH + "px/" + onMonth.rows + " row");
      // MB3. the search box is the only item that can give, so it needs a floor
      check("month page @" + w + ": the search box stays wide enough to read",
        onMonth.input >= 60, onMonth.input + "px of input");
    }
    await send("Emulation.clearDeviceMetricsOverride");

    // MB4. The loop. "Read in the full stream" on a month page points at
    // blog.html?b=YYMM. From disk that used to bounce the reader straight
    // back to the month page they had just left, because blogGoMonth asked
    // the protocol before it asked whether the month was already on the
    // page. This runs over file:, which is the only place the loop closed.
    const monthFile = pathToFileURL(join(bdir, "blog", "2607.html")).href;
    await send("Page.navigate", { url: monthFile });
    await sleep(2000);
    const streamLink = await evaluate(
      `(document.querySelector('.bm-top__stream') || {}).href || ''`);
    await evaluate(`document.querySelector('.bm-top__stream').click()`);
    await sleep(2200);
    const landed = await evaluate(`({
      path: location.pathname,
      query: location.search,
      stream: !!document.getElementById('blogStream'),
      post: !!document.getElementById('s0001')
    })`);
    check("month page from disk: the stream link reaches the stream and stays there",
      /blog\.html$/.test(landed.path) && !/blog\/2607\.html$/.test(landed.path) &&
      landed.stream === true && landed.post === true,
      "from " + streamLink.split("/").slice(-2).join("/") + " to " +
      landed.path.split("/").pop() + landed.query);
  }

  // ============ PHASE 2 LIFECYCLE TESTS (against the served bundle) ============
  if (zipB64) {
    // P2-1. publish a second post into an EARLIER month (no images)
    await send("Page.navigate", { url: B + "blog.html" });
    await sleep(2200);
    await evaluate(ZIP_CAPTURE);
    await evaluate(`window.edit.blog()`);
    await sleep(300);
    await evaluate(`document.querySelector('.bc-date').value = '260610'`);
    await evaluate(`document.querySelector('.bc-title').value = 'June post'`);
    await evaluate(`document.querySelector('.bc-write textarea').value = '<p>June body.</p>'`);
    // PW6. with the reminder switched off the confirm step is a notice that
    // proceeds on its own, and the done step offers the reminder back
    await evaluate(`localStorage.setItem('amh-publish-noremind', '1')`);
    await evaluate(`[...document.querySelectorAll('.bc-btns .ced-btn')].find(b => b.textContent === 'Publish').click()`);
    await sleep(300);
    const notice = await evaluate(`(function () {
      var box = document.querySelector('.bc-wizard');
      return { step: box && box.getAttribute('data-step'),
               text: box ? box.querySelector('.bc-wiz__body').textContent : '',
               regen: box ? [...box.querySelectorAll('.bc-wiz__file[data-how=regenerated]')].map(function (f) { return f.textContent; }) : [],
               btns: box ? [...box.querySelectorAll('.ced-modal__btns button')].map(function (b) { return b.textContent; }) : [] };
    })()`);
    // a backdated month leaves the month after it with a wrong prev, so
    // that month is written again and the lists say so before the build
    check("chain: a publish that creates a month names its neighbour among the files written whole",
      notice.regen.indexOf("blog/2606.html") !== -1 && notice.regen.indexOf("blog/2607.html") !== -1,
      notice.regen.join(", "));
    // The notice still proceeds on its own, by the route used last time,
    // because it has no one to ask. The choice is offered all the same, so
    // taking the other route is one click rather than a settings hunt.
    check("wizard: with the reminder off, a notice says so and proceeds on its own",
      notice.step === "notice" && /You chose not to see the reminder/.test(notice.text) &&
      /lands where it landed last time/.test(notice.text) &&
      JSON.stringify(notice.btns) ===
        '["Cancel","Download a .zip","Write into my repo folder"]',
      JSON.stringify(notice).slice(0, 200));
    const zip2 = await capturePublish();
    let done2 = null;
    for (let i = 0; i < 20 && !(done2 && done2.step === "done"); i++) {
      await sleep(300);
      done2 = await evaluate(`(function () {
        var box = document.querySelector('.bc-wizard');
        return { step: box && box.getAttribute('data-step'),
                 btns: box ? [...box.querySelectorAll('.ced-modal__btns button')].map(function (b) { return b.textContent; }) : [] };
      })()`);
    }
    const remindAgain = await evaluate(`(function () {
      var b = [...document.querySelectorAll('.bc-wizard .ced-modal__btns button')].find(function (x) { return /Show the reminder again/.test(x.textContent); });
      if (b) b.click();
      return { cleared: localStorage.getItem('amh-publish-noremind') === null,
               gone: ![...document.querySelectorAll('.bc-wizard .ced-modal__btns button')].some(function (x) { return /Show the reminder again/.test(x.textContent); }) };
    })()`);
    check("wizard: the done step can switch the reminder back on",
      done2.step === "done" && done2.btns.indexOf("Show the reminder again") !== -1 &&
      remindAgain.cleared && remindAgain.gone, JSON.stringify(done2) + " " + JSON.stringify(remindAgain));
    await evaluate(`[...document.querySelectorAll('.bc-wizard .ced-modal__btns button')].find(b => b.textContent === 'All done, close the post!').click()`);
    await evaluate(`[...document.querySelectorAll('.bc-wizard .ced-modal__btns button')].find(b => b.textContent === 'Got it')?.click()`);
    check("P2: second post published into an earlier month", !!zip2 && !!zip2["blog/2606.html"],
      zip2 ? Object.keys(zip2).sort().join(", ") : "no zip");
    if (zip2) {
      const man2 = zip2["blog.html"].toString("utf8");
      check("P2: manifest entries date-sorted with permanent ids",
        man2.includes("2606100002June post|2607110001E2E first post") && man2.includes("next-post:0003"));
      // the month this publish did not touch keeps the line it had, the new
      // month gets one, and the publish stamp moves on
      const before2 = readFileSync(join(bdir, "blog.html"), "utf8");
      const kept2607 = (/\nmonth:2607=([0-9a-z]{6})/.exec(before2) || [])[1];
      const prevStamp = (/\nstamp:([0-9a-z]{6})/.exec(before2) || [])[1];
      check("stamp: a publish into another month keeps the untouched month's line and adds its own",
        !!kept2607 && man2.includes("month:2607=" + kept2607) && /\nmonth:2606=[0-9a-z]{6}\n/.test(man2) &&
        !!prevStamp && !man2.includes("stamp:" + prevStamp),
        (man2.match(/\n(stamp|month)[^\n]*/g) || []).join(" ") + " was " + kept2607 + "/" + prevStamp);
      writeBundle(zip2);
      // the chain after a backdated month: the new month is the first, and
      // the month after it was written again to point at it
      const m2606c = zip2["blog/2606.html"].toString("utf8");
      const m2607c = zip2["blog/2607.html"] ? zip2["blog/2607.html"].toString("utf8") : "";
      // the index keeps every other post and gains this one
      const t2 = searchTable(zip2["search.js"].toString("utf8"));
      check("search: a second publish adds its entry and keeps the first, oldest first",
        t2.posts.length === 2 && t2.posts[0].id === "0002" && t2.posts[1].id === "0001" &&
        t2.posts[0].title === "June post" && t2.posts[1].thumb.length > 100,
        t2.posts.map((e) => e.id + ":" + e.date).join(" "));
      check("chain: the backdated month is the first month, and its neighbour now points at it",
        m2606c.includes('class="bm-older bm-older--end"') && !/rel="prev"/.test(m2606c) &&
        m2607c.includes('<link rel="prev" href="2606.html" />') && m2607c.includes('<link rel="prefetch" href="2606.html" />') &&
        m2607c.includes('<a class="bm-older" href="2606.html" rel="prev">Older posts: June 2026</a>') &&
        m2607c.includes('id="p0001"'),
        (m2607c.match(/bm-older[^\n]*/) || ["no 2607 in the bundle"])[0]);
    }

    // PW7. arriving on a page that carries the bundle's own stamp clears
    // the layer: the upload has happened, and there is nothing to stage.
    await send("Page.navigate", { url: B + "blog.html" });
    await sleep(2200);
    const arrived = await evaluate(`({
      rec: sessionStorage.getItem('amh-publish-pending'),
      lineHidden: (document.querySelector('.ced-publish') || { hidden: true }).hidden,
      chips: document.querySelectorAll('.bs-post__staged').length,
    })`);
    check("layer: arriving on a page that carries the bundle clears the layer and its chips",
      arrived.rec === null && arrived.lineHidden === true && arrived.chips === 0,
      JSON.stringify(arrived).slice(0, 200));
    await evaluate(`sessionStorage.removeItem('amh-publish-pending'); window.edit();`);

    // ---- the month chain, on the served bundle: 2607 points at 2606 ----
    // CH1. a month page boots with the two scripts and no console error,
    // and site.js is inert there: it has no chrome to drive
    exceptions.length = 0;
    await send("Page.navigate", { url: B + "blog/2607.html" });
    await waitLoaded();
    await sleep(800);
    const monthBoot = await evaluate(`({
      site: !!(window.AMH && AMH.site && AMH.site.requestTick), blog: !!(window.AMH && AMH.blog),
      work: !!(window.AMH && AMH.work && AMH.work.lightbox),
      index: !!document.getElementById('blogStream'), month: document.body.classList.contains('blog-month'),
      link: (document.querySelector('.bm-older') || {}).textContent || '',
      scripts: [...document.querySelectorAll('script[src]')].map(s => s.getAttribute('src')).join(' '),
    })`);
    check("chain: a month page boots with every trunk and no console error",
      exceptions.length === 0 && monthBoot.site && monthBoot.blog && monthBoot.work &&
      !monthBoot.index && monthBoot.month &&
      monthBoot.scripts === "../site.js ../work.js ../blog.js ../tool.js ../publish.js" &&
      monthBoot.link === "Older posts: June 2026",
      JSON.stringify(monthBoot).slice(0, 200) + " " + exceptions.join(" | ").slice(0, 120));
    // MP2. a month page has the bar with its own picker, folds nothing,
    // and zooms
    const monthPage = await evaluate(`(function () {
      var sel = document.getElementById('blogMonth');
      var img = document.querySelector('.bp-fig img');
      var out = {
        bar: !!document.getElementById('blogBar'),
        barPosition: getComputedStyle(document.querySelector('.bs-bar')).position,
        options: [].map.call(sel.options, function (o) { return o.value; }),
        posts: document.querySelectorAll('.bs-post').length,
        old: document.querySelectorAll('.blog-post').length,
        buttons: document.querySelectorAll('.bs-more').length,
        cursor: img ? getComputedStyle(img).cursor : ''
      };
      if (img) img.click();
      return new Promise(function (res) { setTimeout(function () {
        out.zoomed = !!(window.AMH.work && AMH.work.lightbox.isOpen());
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        /* the viewer marks the rest of the page inert while it is up, so
           the next check waits for it to be gone before it clicks */
        setTimeout(function () { out.closed = !AMH.work.lightbox.isOpen(); res(out); }, 600);
      }, 700); });
    })()`, { awaitPromise: true });
    check("month page: the bar is in the flow, the picker lists its months, nothing is folded",
      monthPage.bar && monthPage.barPosition === "relative" &&
      JSON.stringify(monthPage.options) === '["","2607","2606"]' &&
      monthPage.posts === 1 && monthPage.old === 0 && monthPage.buttons === 0,
      JSON.stringify(monthPage).slice(0, 220));
    const monthFind = await evaluate(`(function () {
      var input = document.querySelector('.bs-find__pill input');
      if (!input) return Promise.resolve({ pill: false });
      input.focus();
      return new Promise(function (res) { setTimeout(function () {
        input.value = 'e2e'; input.dispatchEvent(new Event('input', { bubbles: true }));
        setTimeout(function () {
          var hit = document.querySelector('.bs-find__hit');
          res({ pill: true, href: hit ? hit.getAttribute('href') : '',
                open: !document.querySelector('.bs-find__list').hidden });
        }, 600);
      }, 1200); });
    })()`, { awaitPromise: true });
    check("month page: the pill is there too, and its hits are sibling month files",
      monthFind.pill && monthFind.open && monthFind.href === "2607.html#p0001",
      JSON.stringify(monthFind));
    check("month page: an image zooms there too, and Escape closes the viewer",
      monthPage.cursor === "zoom-in" && monthPage.zoomed && monthPage.closed,
      JSON.stringify(monthPage).slice(0, 180));

    // CH2. the click appends the older month under a divider, moves the
    // link on, replaces the URL and the title, and puts focus on the divider
    await evaluate(`document.querySelector('.bm-older').click()`);
    /* Wait for the month to arrive rather than guessing at a delay. A month
       page loads five trunks now, and the suite's server answers one request
       at a time, so the chain's own fetch can queue behind them. */
    for (let i = 0; i < 30; i++) {
      await sleep(250);
      if (await evaluate(`!!document.querySelector('.bm-divider')`)) break;
    }
    const walked = await evaluate(`({
      divider: (document.querySelector('.bm-divider') || {}).textContent || '',
      posts: [...document.querySelectorAll('main .bs-post')].map(a => a.id).join(' '),
      sources: document.querySelectorAll('main script[type="text/x-blog-source"]').length,
      older: (document.querySelector('.bm-older') || {}).textContent || '',
      end: !!document.querySelector('.bm-older--end'),
      path: location.pathname, title: document.title,
      focused: document.activeElement && document.activeElement.className,
      dividerBorder: (function (el) { return el ? getComputedStyle(el).borderTopWidth : "none"; })(document.querySelector('.bm-divider')),
      /* a post is a card now: it carries its own border on all four sides,
         so the divider has none to cancel */
      firstAppended: (function (el) { return el ? getComputedStyle(el).borderTopWidth : "none"; })(document.querySelector('.bm-divider + .bs-post')),
      cardRadius: (function (el) { return el ? getComputedStyle(el).borderRadius : "none"; })(document.querySelector('.bs-post')),
    })`);
    check("chain: Older posts appends June under a divider and the link becomes the end note",
      walked.divider === "June 2026" && walked.posts === "p0001 p0002" && walked.sources === 1 &&
      walked.end && /first month/.test(walked.older),
      JSON.stringify(walked).slice(0, 240));
    check("chain: the URL and the title follow the month reached, and focus lands on the divider",
      /\/blog\/2606\.html$/.test(walked.path) && /June 2026/.test(walked.title) && walked.focused === "bm-divider" &&
      walked.dividerBorder === "1px" && walked.firstAppended === "1px",
      JSON.stringify(walked).slice(0, 240));
    // CH3. a month that cannot be loaded says so in the link's place and
    // stays a link; a second click while busy does nothing
    await send("Page.navigate", { url: B + "blog/2607.html" });
    await sleep(800);
    const failed = await evaluate(`(function () {
      var a = document.querySelector('.bm-older');
      a.setAttribute('href', '2605.html');
      a.click();
      return new Promise(function (res) { setTimeout(function () {
        var b = document.querySelector('.bm-older');
        res({ text: b.textContent, href: b.getAttribute('href'), busy: b.getAttribute('aria-busy'), tag: b.tagName });
      }, 700); });
    })()`, { awaitPromise: true });
    check("chain: a month that cannot be loaded says so and the link still works",
      failed.text === "Could not load May 2026. Open it instead." && failed.href === "2605.html" &&
      failed.busy === null && failed.tag === "A", JSON.stringify(failed));
    const busy = await evaluate(`(function () {
      var a = document.querySelector('.bm-older');
      a.setAttribute('href', '2606.html');
      var calls = 0;
      var real = window.fetch;
      window.fetch = function () { calls++; return new Promise(function () {}); };
      a.click(); a.click(); a.click();
      var r = { calls: calls, busy: a.getAttribute('aria-busy'), text: a.textContent };
      window.fetch = real;
      return r;
    })()`);
    check("chain: a second click while a month is loading does nothing",
      busy.calls === 1 && busy.busy === "true" && busy.text === "Loading June 2026...", JSON.stringify(busy));
    // CH4. from disk the click is a navigation: the page after it is the
    // older month as a page of its own
    await send("Page.navigate", { url: pathToFileURL(join(bdir, "blog/2607.html")).href });
    await sleep(800);
    await evaluate(`document.querySelector('.bm-older').click()`);
    await sleep(800);
    const onDisk = await evaluate(`({ protocol: location.protocol, path: location.pathname,
      end: !!document.querySelector('.bm-older--end'), divider: !!document.querySelector('.bm-divider') })`);
    check("chain: from disk Older posts opens the older month as a page",
      onDisk.protocol === "file:" && /2606\.html$/.test(onDisk.path) && onDisk.end && !onDisk.divider,
      JSON.stringify(onDisk));
    // CH5. a month emptied by a delete: the month after it points back
    // past it. First a post that creates May, then its deletion.
    await send("Page.navigate", { url: B + "blog.html" });
    await sleep(2200);
    await evaluate(ZIP_CAPTURE);
    await evaluate(`window.edit.blog()`);
    await sleep(300);
    await evaluate(`document.querySelector('.bc-date').value = '260501'`);
    await evaluate(`document.querySelector('.bc-title').value = 'May post'`);
    await evaluate(`document.querySelector('.bc-write textarea').value = '<p>May.</p>'`);
    await pressPublish();
    const zipMay = await capturePublish();
    const mayId = zipMay ? (/\n(?:[^\n]*\|)?260501(\d{4})May post/.exec(zipMay["blog.html"].toString("utf8")) || [])[1] : null;
    check("chain: a new first month is written as the first, and the month after it points at it",
      !!zipMay && !!mayId && zipMay["blog/2605.html"].toString("utf8").includes("bm-older--end") &&
      !!zipMay["blog/2606.html"] && zipMay["blog/2606.html"].toString("utf8").includes('href="2605.html" rel="prev">Older posts: May 2026'),
      zipMay ? Object.keys(zipMay).sort().join(", ") + " id " + mayId : "no zip");
    if (zipMay) writeBundle(zipMay);
    await send("Page.navigate", { url: B + "blog.html" });
    await sleep(2200);
    await evaluate(ZIP_CAPTURE);
    await evaluate(`window.edit.blog.edit(${JSON.stringify(mayId || "0000")})`);
    await sleep(1200);
    await evaluate(`[...document.querySelectorAll('.bc-btns .ced-btn')].find(b => b.textContent === 'Delete post').click()`);
    await passRouteStep();
    const zipMayGone = await capturePublish();
    check("chain: a delete that empties the first month repairs the month after it",
      !!zipMayGone && !zipMayGone["blog/2605.html"] &&
      (zipMayGone["ORPHANS.txt"] || Buffer.from("")).toString("utf8").includes("blog/2605.html") &&
      !!zipMayGone["blog/2606.html"] && zipMayGone["blog/2606.html"].toString("utf8").includes("This is the first month."),
      zipMayGone ? Object.keys(zipMayGone).sort().join(", ") : "no zip");
    if (zipMayGone) {
      writeBundle(zipMayGone);
      rmSync(join(bdir, "blog/2605.html"), { force: true });
      rmSync(join(bdir, "ORPHANS.txt"), { force: true });
    }
    await evaluate(`[...document.querySelectorAll('.bc-wizard .ced-modal__btns button')].find(b => b.textContent === 'All done, close the post!')?.click()`);
    await evaluate(`[...document.querySelectorAll('.bc-wizard .ced-modal__btns button')].find(b => b.textContent === 'Got it')?.click()`);

    // P2-2. the stream shows the newest month and loads nothing until it
    // is asked to. Two months are deployed now, so the stream is July and
    // the way back to June is a link.
    await send("Page.navigate", { url: B + "blog.html" });
    await sleep(2200);
    await evaluate(`
      window.__blogFetches = 0;
      const of = window.fetch;
      window.fetch = function (u) {
        if (String(u).indexOf('blog/') !== -1) window.__blogFetches++;
        return of.apply(this, arguments);
      };`);
    await evaluate(`AMH.blog.show("", false)`);
    await sleep(1200);
    const nav2 = await evaluate(`({
      posts: [...document.querySelectorAll('.bs-post')].map(a => a.id),
      older: (document.querySelector('.bm-older') || { getAttribute: () => '' }).getAttribute('href'),
      label: (document.querySelector('.bm-older') || {}).textContent || '',
      fetches: window.__blogFetches,
    })`);
    check("P2: the stream is the newest month, and the way back to June is a link",
      JSON.stringify(nav2.posts) === '["s0001"]' && nav2.older === "blog/2606.html" &&
      /Older posts: June 2026/.test(nav2.label) && nav2.fetches === 0,
      JSON.stringify(nav2));
    // ---- the cuts ----
    // CUT1. the rules, one post per rule. The bodies are built here so the
    // limits are the only thing under test: CUT_SOFT is 12 lines or 900
    // characters, CUT_HARD is 40 lines or 3000 characters.
    const cuts = await evaluate(`(function () {
      var stream = document.getElementById('blogStream');
      function post(id, inner) {
        var a = document.createElement('article');
        a.className = 'bs-post';
        a.id = 's' + id;
        a.setAttribute('data-id', id);
        a.setAttribute('data-date', '260711');
        a.innerHTML = '<div class="bs-post__body">' + inner + '</div>';
        stream.appendChild(a);
        return a;
      }
      function ps(n, word) { var o = ''; for (var i = 0; i < n; i++) o += '<p>' + (word || 'line ' + i) + '</p>'; return o; }
      var made = {
        short: post('9001', ps(3)),
        soft: post('9002', ps(20)),
        flag: post('9003', ps(3) + '<span class="bp-cut" data-cut="soft"></span>' + ps(6)),
        hard: post('9004', ps(60)),
        both: post('9005', ps(3) + '<span class="bp-cut" data-cut="hard"></span>' + ps(6) +
                            '<span class="bp-cut" data-cut="soft"></span>' + ps(6)),
        fig: post('9006', ps(11) + '<figure class="bp-fig"><img alt="" /><figcaption>cap</figcaption></figure>' + ps(6)),
        head: post('9007', ps(11) + '<h3>A heading</h3>' + ps(6)),
        chars: post('9008', '<p>' + new Array(200).join('word ') + '</p><p>a</p><p>b</p>')
      };
      var folded = AMH.blog.cut();
      function look(el) {
        var body = el.querySelector('.bs-post__body');
        var blocks = [].slice.call(body.children);
        var btn = body.querySelector('.bs-more');
        var shown = blocks.filter(function (b) { return !b.hidden && b.tagName !== 'BUTTON'; });
        return {
          kind: btn ? btn.getAttribute('data-more') : '',
          label: btn ? btn.textContent : '',
          shown: shown.length,
          lastShown: shown.length ? shown[shown.length - 1].tagName : '',
          hidden: blocks.filter(function (b) { return b.hidden; }).length
        };
      }
      var out = { folded: folded };
      Object.keys(made).forEach(function (k) { out[k] = look(made[k]); });
      return out;
    })()`);
    check("cuts: a short post is not folded, and a long one gets Expand for more",
      cuts.short.kind === "" && cuts.short.hidden === 0 &&
      cuts.soft.kind === "soft" && cuts.soft.label === "Expand for more" &&
      cuts.soft.shown === 12 && cuts.soft.hidden === 8,
      JSON.stringify({ short: cuts.short, soft: cuts.soft }));
    check("cuts: a soft flag puts the cut where the flag is, whatever the length",
      cuts.flag.kind === "soft" && cuts.flag.shown === 3 && cuts.flag.hidden === 7,
      JSON.stringify(cuts.flag));
    check("cuts: a post past both limits folds at the soft one first",
      cuts.hard.kind === "soft" && cuts.hard.shown === 12 && cuts.hard.hidden === 48,
      JSON.stringify(cuts.hard));
    check("cuts: a hard flag before the soft cut wins, and the soft cut is dropped",
      cuts.both.kind === "hard" && cuts.both.shown === 3, JSON.stringify(cuts.both));
    check("cuts: the block that crosses the limit is shown whole, so a figure is never split",
      cuts.fig.kind === "soft" && cuts.fig.lastShown === "FIGURE" && cuts.fig.shown === 12,
      JSON.stringify(cuts.fig));
    check("cuts: a heading is never left with nothing under it",
      cuts.head.kind === "soft" && cuts.head.lastShown === "P" && cuts.head.shown === 13,
      JSON.stringify(cuts.head));
    check("cuts: the character limit folds a post that is short in lines",
      cuts.chars.kind === "soft" && cuts.chars.shown === 1 && cuts.chars.hidden === 2,
      JSON.stringify(cuts.chars));
    check("cuts: every folded post was counted once", cuts.folded === 7, String(cuts.folded));

    // CUT2. the reveal: Expand opens as far as the hard cut and hands over
    // to Read more; Read more opens the rest; the buttons go with the press
    const reveal = await evaluate(`(function () {
      var stream = document.getElementById('blogStream');
      var a = document.createElement('article');
      a.className = 'bs-post'; a.id = 's9009'; a.setAttribute('data-id', '9009');
      a.setAttribute('data-date', '260711');
      var ps = '';
      for (var i = 0; i < 70; i++) ps += '<p>line ' + i + '</p>';
      a.innerHTML = '<div class="bs-post__body">' + ps + '</div>';
      stream.appendChild(a);
      /* a soft flag early and the hard limit later: both controls, in turn */
      var body = a.querySelector('.bs-post__body');
      var flag = document.createElement('span');
      flag.className = 'bp-cut'; flag.setAttribute('data-cut', 'soft');
      body.insertBefore(flag, body.children[4]);
      AMH.blog.cut();
      function state() {
        var blocks = [].slice.call(body.children);
        var btn = body.querySelector('.bs-more');
        return { kind: btn ? btn.getAttribute('data-more') : '',
                 shown: blocks.filter(function (b) { return !b.hidden && b.tagName === 'P'; }).length,
                 buttons: body.querySelectorAll('.bs-more').length };
      }
      var first = state();
      body.querySelector('.bs-more').click();
      var second = state();
      body.querySelector('.bs-more').click();
      var third = state();
      a.remove();
      return { first: first, second: second, third: third };
    })()`);
    check("cuts: Expand opens as far as the hard cut and hands over to Read more",
      reveal.first.kind === "soft" && reveal.first.shown === 4 &&
      reveal.second.kind === "hard" && reveal.second.shown === 40 && reveal.second.buttons === 1,
      JSON.stringify(reveal).slice(0, 200));
    check("cuts: Read more opens the rest and the last button goes with it",
      reveal.third.kind === "" && reveal.third.shown === 70 && reveal.third.buttons === 0,
      JSON.stringify(reveal.third));

    // ZM1. a click on any image in a post opens the shared viewer at that
    // image, and the set is that post's own images in order
    const zoom = await evaluate(`(function () {
      var stream = document.getElementById('blogStream');
      var a = document.createElement('article');
      a.className = 'bs-post'; a.id = 's9100'; a.setAttribute('data-id', '9100');
      a.setAttribute('data-date', '260711');
      a.innerHTML = '<div class="bs-post__body">' +
        '<figure class="bp-fig"><img src="blog/260711_img0001.jpg" alt="Alt one" />' +
        '<figcaption>Cap one</figcaption></figure>' +
        '<figure class="bp-fig"><img src="blog/260711_img0002.png" alt="Alt two" />' +
        '<figcaption>Cap two</figcaption></figure></div>';
      stream.appendChild(a);
      var second = a.querySelectorAll('.bp-fig img')[1];
      second.click();
      return new Promise(function (res) { setTimeout(function () {
        var lb = document.querySelector('.lightbox');
        var out = { open: !!lb && AMH.work.lightbox.isOpen(),
                    cursor: getComputedStyle(second).cursor,
                    caption: (document.querySelector('.lightbox__caption') || {}).textContent || '',
                    src: (document.querySelector('.lightbox__img--active') || {}).getAttribute('src') || '' };
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        setTimeout(function () {
          out.closed = !AMH.work.lightbox.isOpen();
          a.remove();
          res(out);
        }, 500);
      }, 700); });
    })()`, { awaitPromise: true });
    check("zoom: a click on a figure opens the viewer at that image, and Escape closes it",
      zoom.open && /260711_img0002\.png$/.test(zoom.src) && /Cap two/.test(zoom.caption) &&
      zoom.cursor === "zoom-in" && zoom.closed,
      JSON.stringify(zoom).slice(0, 200));

    // FT1. a tag chip filters the feed in place: it does not leave the
    // page, the posts without the tag go, and the line says what is on
    const tagFilter = await evaluate(`(function () {
      var stream = document.getElementById('blogStream');
      function post(id, tags) {
        var a = document.createElement('article');
        a.className = 'bs-post'; a.id = 's' + id;
        a.setAttribute('data-id', id); a.setAttribute('data-date', '260711');
        a.setAttribute('data-tags', tags);
        a.innerHTML = '<div class="bs-post__body"><p>body</p></div>' +
          '<div class="bs-post__tags"><a href="blog.html?t=' + tags.split(' ')[0] + '">#' +
          tags.split(' ')[0] + '</a></div>';
        stream.appendChild(a);
        return a;
      }
      var a = post('9201', 'xr planetarium'), b = post('9202', 'notes');
      var chip = a.querySelector('.bs-post__tags a');
      var ev = new MouseEvent('click', { bubbles: true, cancelable: true });
      chip.dispatchEvent(ev);
      return new Promise(function (res) { setTimeout(function () {
        var line = document.querySelector('.bs-showing');
        var out = { prevented: ev.defaultPrevented, search: location.search,
                    kept: !a.hidden, gone: b.hidden,
                    line: line ? line.textContent : '',
                    clear: !!(line && line.querySelector('.bs-showing__clear')) };
        if (line) line.querySelector('.bs-showing__clear').click();
        setTimeout(function () {
          out.afterClear = { kept: !a.hidden, shown: !b.hidden,
                             line: !!document.querySelector('.bs-showing'),
                             search: location.search };
          a.remove(); b.remove();
          res(out);
        }, 300);
      }, 400); });
    })()`, { awaitPromise: true });
    check("tags: a chip filters the feed in place and the address carries the filter",
      tagFilter.prevented && tagFilter.search === "?t=xr" && tagFilter.kept && tagFilter.gone,
      JSON.stringify(tagFilter).slice(0, 200));
    check("tags: the line says what is showing, and clear puts every post back",
      /Showing/.test(tagFilter.line) && /#xr/.test(tagFilter.line) && /1 post here/.test(tagFilter.line) &&
      tagFilter.clear && tagFilter.afterClear.shown && tagFilter.afterClear.kept &&
      !tagFilter.afterClear.line && tagFilter.afterClear.search === "",
      JSON.stringify(tagFilter).slice(0, 240));

    // FT2. ?t= on arrival filters the same way, and lists the posts with
    // that tag that this page does not hold
    await send("Page.navigate", { url: "http://127.0.0.1:8124/blog.html?t=e2e" });
    await sleep(2200);
    const onArrival = await evaluate(`({
      line: (document.querySelector('.bs-showing') || {}).textContent || '',
      shown: [...document.querySelectorAll('.bs-post')].filter(p => !p.hidden).length,
      hidden: [...document.querySelectorAll('.bs-post')].filter(p => p.hidden).length,
    })`);
    check("tags: ?t= on arrival filters the page, and an unknown tag hides every post",
      /Showing/.test(onArrival.line) && onArrival.shown === 0 && onArrival.hidden === 1,
      JSON.stringify(onArrival));
    await send("Page.navigate", { url: "http://127.0.0.1:8124/blog.html" });
    await sleep(2200);

    // CUT3. the bar: it scrolls away with the page, leaving the site header
    // as the only thing pinned, and the picker lists the months newest first
    // with All months at the top
    const bar = await evaluate(`(function () {
      var el = document.getElementById('blogBar');
      var sel = document.getElementById('blogMonth');
      var before = el.getBoundingClientRect().top;
      window.scrollTo(0, 1200);
      return new Promise(function (res) { setTimeout(function () {
        var after = el.getBoundingClientRect().top;
        var head = document.getElementById('header').getBoundingClientRect().bottom;
        window.scrollTo(0, 0);
        res({ position: getComputedStyle(el).position, before: Math.round(before),
              after: Math.round(after), head: Math.round(head),
              options: [].map.call(sel.options, function (o) { return o.value + ':' + o.textContent; }),
              find: !!document.getElementById('blogFind'),
              pill: !!document.querySelector('#blogFind .bs-find__pill input') });
      }, 800); });
    })()`, { awaitPromise: true });
    check("bar: it scrolls away with the page, and only the site header stays",
      bar.position === "relative" && bar.after < bar.before - 400 && bar.head > 0,
      JSON.stringify(bar).slice(0, 200));
    check("bar: the picker lists All months and then each month, newest first",
      JSON.stringify(bar.options) === '[":All months","2607:July 2026 (1)","2606:June 2026 (1)"]' &&
      bar.find && bar.pill, JSON.stringify(bar.options) + " pill=" + bar.pill);
    // CUT3b. The bar is a panel whether or not it moves. Its ground came off
    // with the sticky positioning once, which was not the point of that
    // change, and the bar read as a strip of bare page above a list of cards.
    const barLook = await evaluate(`(function () {
      var bar = document.getElementById('blogBar');
      var sel = document.getElementById('blogMonth');
      var cs = getComputedStyle(bar), ss = getComputedStyle(sel);
      return { ground: cs.backgroundColor, image: cs.backgroundImage !== 'none',
               radius: cs.borderTopLeftRadius,
               /* the picker is the browser's own control: nothing is redrawn,
                  and color-scheme is what makes its popup list dark too */
               pickerAppearance: ss.appearance || ss.webkitAppearance,
               pickerDrawn: ss.backgroundImage !== 'none',
               pickerScheme: ss.colorScheme };
    })()`);
    check("bar: it has a ground of its own, like the cards under it",
      /rgba?\(/.test(barLook.ground) &&
      barLook.ground !== "rgba(0, 0, 0, 0)" && barLook.image === true,
      JSON.stringify(barLook));
    check("bar: the month picker is the browser's own control, drawn dark, not redrawn",
      barLook.pickerAppearance !== "none" && barLook.pickerDrawn === false &&
      /dark/.test(barLook.pickerScheme),
      JSON.stringify(barLook));

    // CUT3c. The trace: the wizard's steps are always printed, and the notes
    // are printed only when they are asked for.
    const traceSwitch = await evaluate(`({
      on: String(window.edit.blog.trace(true)),
      off: String(window.edit.blog.trace(false))
    })`);
    check("trace: it can be turned up for a hunt and down again",
      /trace on/.test(traceSwitch.on) && /trace off/.test(traceSwitch.off),
      JSON.stringify(traceSwitch));


    // the injected posts go before the loader tests read the stream
    await evaluate(`[...document.querySelectorAll('.bs-post')].forEach(function (p) {
      if (p.id >= 's9000') p.remove(); });`);

    // ST-B. the loader at the root: the older month is appended into the
    // stream, its paths lose the step up, its ids become "s", and the
    // address bar stays on blog.html
    await evaluate(`document.querySelector('.bm-older').click()`);
    await sleep(1200);
    const walkedRoot = await evaluate(`({
      posts: [...document.querySelectorAll('.bs-post')].map(a => a.id),
      shapes: [...document.querySelectorAll('.bs-post')].map(a => a.className),
      divider: (document.querySelector('.bm-divider') || {}).textContent || '',
      byline: (document.querySelector('#s0002 .bs-post__by b') || {}).textContent || '',
      when: (document.querySelector('#s0002 .bs-post__when') || { getAttribute: () => '' }).getAttribute('href'),
      title: (document.querySelector('#s0002 .bs-post__title') || {}).textContent || '',
      end: !!document.querySelector('.bm-older--end'),
      path: location.pathname, search: location.search,
      sources: document.querySelectorAll('script[type="text/x-blog-source"]').length,
      up: [...document.querySelectorAll('#blogStream [src],#blogStream [href]')]
        .filter(e => (e.getAttribute('src') || e.getAttribute('href') || '').indexOf('../') === 0).length,
      old: document.querySelectorAll('.blog-post').length,
    })`);
    check("P2: the loader appends June into the stream, in the stream's own markup",
      JSON.stringify(walkedRoot.posts) === '["s0001","s0002"]' &&
      walkedRoot.shapes.every((c) => c === "bs-post") && walkedRoot.old === 0 &&
      walkedRoot.divider === "June 2026" && walkedRoot.byline === "AARON M. HARRIS" &&
      walkedRoot.when === "blog/2606.html#p0002" && walkedRoot.title === "June post",
      JSON.stringify(walkedRoot).slice(0, 260));
    check("P2: it rewrites the paths and the ids, keeps no source, and stays on blog.html",
      walkedRoot.up === 0 && walkedRoot.sources === 0 && walkedRoot.end &&
      /blog\.html$/.test(walkedRoot.path) && walkedRoot.search === "",
      JSON.stringify(walkedRoot).slice(0, 260));
    // the appended post's images resolve from the root: a path left at
    // "../blog/..." would 404 here and nowhere else
    const appendedImgs = await evaluate(`[...document.querySelectorAll('#blogStream img')].map(i => i.getAttribute('src')).join(' ')`);
    check("P2: no appended path keeps the step up out of blog/",
      !/\.\.\//.test(appendedImgs), appendedImgs.slice(0, 160));

    // CUT4. the picker, with June already on the page: it scrolls to that
    // month's first post rather than leaving the page
    const pickLoaded = await evaluate(`(function () {
      var sel = document.getElementById('blogMonth');
      sel.value = '2606';
      sel.dispatchEvent(new Event('change'));
      return new Promise(function (res) { setTimeout(function () {
        var post = document.querySelector('.bs-post[data-date^="2606"]');
        var top = post ? post.getBoundingClientRect().top : 9999;
        res({ path: location.pathname, scrolled: window.scrollY > 0, top: Math.round(top) });
      }, 500); });
    })()`, { awaitPromise: true });
    check("bar: picking a month that is on the page scrolls to it and stays put",
      pickLoaded.path.endsWith("/blog.html") && pickLoaded.scrolled && Math.abs(pickLoaded.top) < 200,
      JSON.stringify(pickLoaded));

    // P2-3. edit a published post's body (same title/date)
    await send("Page.navigate", { url: B + "blog.html" });
    await sleep(2200);
    await evaluate(ZIP_CAPTURE);
    await evaluate(`window.edit.blog.edit("0001")`);
    await sleep(1200);
    const loaded = await evaluate(`({
      head: document.querySelector('.bc-head .ced-slug')?.textContent || '',
      date: document.querySelector('.bc-date')?.value,
      title: document.querySelector('.bc-title')?.value,
      body: document.querySelector('.bc-write textarea')?.value || '',
      cards: document.querySelectorAll('.bc-card').length,
      pubMeta: document.querySelector('.bc-card .bc-card__meta')?.textContent || '',
      delBtn: [...document.querySelectorAll('.bc-btns .ced-btn')].some(b => b.textContent === 'Delete post' && b.style.display !== 'none'),
    })`);
    check("P2: published post loads losslessly into the composer",
      loaded.head === "Edit post p0001" && loaded.date === "260711" && loaded.title === "E2E first post" &&
      loaded.body.includes("[img0001,Cap one|Alt one][png0002,Cap two]") &&
      loaded.cards === 2 && loaded.pubMeta.includes("published") && loaded.delBtn,
      JSON.stringify(loaded).slice(0, 200));
    await evaluate(`
      var t = document.querySelector('.bc-write textarea');
      t.value = t.value + '\\n<p>EDITED BODY</p>';`);
    await pressPublish();
    const zip3 = await capturePublish();
    // index.html is absent because the manifest entry did not change, so the
    // highlights block renders the same bytes it already has. A publish that
    // changes nothing on a page must not put that page in the diff.
    check("P2: body republish regenerates only the month file, home page left out",
      !!zip3 && !!zip3["blog/2607.html"] && zip3["blog/2607.html"].toString("utf8").includes("EDITED BODY") &&
      !zip3["index.html"] &&
      !zip3["ORPHANS.txt"] && !Object.keys(zip3).some((n) => /img\d{4}\.(jpg|png)$/.test(n)),
      zip3 ? Object.keys(zip3).sort().join(", ") : "no zip");
    if (zip3) {
      // the manifest's stamp and the month's line change at every publish,
      // and the post's own card follows its body; nothing else on the page
      // does
      const stampLines = /\n(stamp|month):[^\n]*/g;
      const was = readFileSync(join(bdir, "blog.html"), "utf8");
      const now = zip3["blog.html"].toString("utf8");
      check("P2: body republish changes only the stamp lines and the post in the stream",
        stripSpans(was, ["blog-stream"]).replace(stampLines, "") === stripSpans(now, ["blog-stream"]).replace(stampLines, "") &&
        (was.match(stampLines) || []).join() !== (now.match(stampLines) || []).join() &&
        /bs-post__body[\s\S]*EDITED BODY/.test(now),
        firstDiff(stripSpans(was, ["blog-stream"]).replace(stampLines, ""), stripSpans(now, ["blog-stream"]).replace(stampLines, "")));
      writeBundle(zip3);
    }

    // P2-4. retitle + cross-month date move (2607 -> 2606) with image renames
    await send("Page.navigate", { url: B + "blog.html" });
    await sleep(2200);
    await evaluate(ZIP_CAPTURE);
    await evaluate(`window.edit.blog.edit("0001")`);
    await sleep(1200);
    await evaluate(`document.querySelector('.bc-date').value = '260609'`);
    await evaluate(`document.querySelector('.bc-title').value = 'Moved post'`);
    await pressPublish();
    const zip4 = await capturePublish();
    check("P2: cross-month move produced a bundle", !!zip4,
      zip4 ? Object.keys(zip4).sort().join(", ") : "no zip");
    if (zip4) {
      const man4 = zip4["blog.html"].toString("utf8");
      const m2606 = zip4["blog/2606.html"].toString("utf8");
      const orph = (zip4["ORPHANS.txt"] || Buffer.from("")).toString("utf8");
      check("P2: move keeps the permanent id, re-sorts the manifest",
        man4.includes("2606090001Moved post|2606100002June post") && !man4.includes("2607110001"));
      check("P2: target month holds both posts, date-desc",
        m2606.indexOf('id="p0002"') < m2606.indexOf('id="p0001"') && m2606.includes("EDITED BODY"));
      check("P2: old month + old image names orphaned; no 2607 file shipped",
        !zip4["blog/2607.html"] && orph.includes("blog/2607.html") &&
        orph.includes("blog/260711_img0001.jpg") && orph.includes("blog/260711_img0002.png"));
      check("P2: published images re-emitted under the new date prefix",
        !!zip4["blog/260609_img0001.jpg"] && zip4["blog/260609_img0001.jpg"][0] === 0xFF &&
        !!zip4["blog/260609_img0002.png"] && zip4["blog/260609_img0002.png"][1] === 0x50);
      writeBundle(zip4);
      // honor the orphan checklist, like the human workflow demands
      for (const o of ["blog/2607.html", "blog/260711_img0001.jpg", "blog/260711_img0002.png"]) {
        rmSync(join(bdir, o), { force: true });
      }
      rmSync(join(bdir, "ORPHANS.txt"), { force: true });
    }

    // P2-5. stream after the move: one month, two posts, edit buttons in editor mode
    await send("Page.navigate", { url: B + "blog.html" });
    await sleep(2200);
    await evaluate(`window.edit()`);
    await sleep(400);
    await sleep(600);
    const after4 = await evaluate(`({
      posts: [...document.querySelectorAll('.bs-post')].map(a => a.id),
      title: (document.querySelector('#s0001 .bs-post__title') || {}).textContent,
      when: [...document.querySelectorAll('.bs-post__when')].map(a => a.getAttribute('href')),
      editBtns: document.querySelectorAll('.bs-post .bs-retry').length,
      end: !!document.querySelector('.bm-older--end'),
    })`);
    check("P2: after the move the stream is the one June month, both posts relinked",
      JSON.stringify(after4.posts) === '["s0002","s0001"]' &&
      after4.title === "Moved post" && after4.editBtns === 2 && after4.end &&
      after4.when.every(h => h.indexOf("blog/2606.html#") === 0),
      JSON.stringify(after4));

    // P2-6. delete a post (keeps the month, which still has p0001)
    await send("Page.navigate", { url: B + "blog.html" });
    await sleep(2200);
    await evaluate(ZIP_CAPTURE);
    await evaluate(`window.edit.blog.edit("0002")`);
    await sleep(1200);
    await evaluate(`[...document.querySelectorAll('.bc-btns .ced-btn')].find(b => b.textContent === 'Delete post').click()`);
    await passRouteStep();
    const zip5 = await capturePublish();
    if (zip5 && zip5["search.js"]) {
      const t5 = searchTable(zip5["search.js"].toString("utf8"));
      check("search: a delete takes that post out of the index and leaves the rest",
        !t5.posts.some((e) => e.id === "0002") && t5.posts.some((e) => e.id === "0001"),
        t5.posts.map((e) => e.id).join(" "));
    }
    check("P2: delete bundle removes entry, regenerates month",
      !!zip5 && !zip5["blog.html"].toString("utf8").includes("June post") &&
      !!zip5["blog/2606.html"] && !zip5["blog/2606.html"].toString("utf8").includes('id="p0002"') &&
      zip5["blog/2606.html"].toString("utf8").includes('id="p0001"'),
      zip5 ? Object.keys(zip5).sort().join(", ") : "no zip");
    if (zip5) writeBundle(zip5);

    // P2-7. rebuild: idempotent re-render of every month with current chrome
    await send("Page.navigate", { url: B + "blog.html" });
    await sleep(2200);
    await evaluate(ZIP_CAPTURE);
    await evaluate(`window.edit.blog.rebuild()`);
    await passRouteStep();
    const zip6 = await capturePublish();
    // blog.html is in every rebuild bundle now: the manifest is written
    // again from the month files and carries a new stamp. index.html is
    // not, because no entry changed and the highlights are the same bytes.
    check("P2: rebuild ships all months, the shared files and blog.html, not index.html",
      !!zip6 && !!zip6["blog/2606.html"] && !!zip6["sitemap.xml"] &&
      !!zip6["robots.txt"] && !!zip6["blog.html"] && !zip6["index.html"],
      zip6 ? Object.keys(zip6).sort().join(", ") : "no zip");
    if (zip6) {
      const t6 = searchTable(zip6["search.js"].toString("utf8"));
      const t6prev = searchTable(readFileSync(join(bdir, "search.js"), "utf8"));
      check("search: a rebuild writes the index again from the sources, keeping the thumbnails",
        t6.posts.length === t6prev.posts.length &&
        JSON.stringify(t6.posts.map((e) => e.id + e.text)) ===
          JSON.stringify(t6prev.posts.map((e) => e.id + e.text)) &&
        t6.posts.every((e, i) => e.thumb === t6prev.posts[i].thumb) &&
        t6.stamp !== t6prev.stamp,
        t6.posts.map((e) => e.id + ":" + e.thumb.length).join(" "));
      check("P2: rebuild is idempotent (matches the deployed month byte-for-byte)",
        zip6["blog/2606.html"].equals(readFileSync(join(bdir, "blog/2606.html"))));
      writeBundle(zip6);
    }

    // P2-8. the manifest is derivable. A rebuild takes the entry list from
    // the month files, so a title changed by hand in the file reaches the
    // manifest, the console names the difference, and the highlights
    // follow. The counters never go down, even when the manifest holds a
    // larger one than the posts need.
    const m2606h = readFileSync(join(bdir, "blog/2606.html"), "utf8");
    writeFileSync(join(bdir, "blog/2606.html"), m2606h.replace('data-title="Moved post"', 'data-title="Hand title"'));
    const idx8 = readFileSync(join(bdir, "blog.html"), "utf8");
    writeFileSync(join(bdir, "blog.html"), idx8.replace(/next-post:\d{4}/, "next-post:0009"));
    await send("Page.navigate", { url: B + "blog.html" });
    await sleep(2200);
    await evaluate(ZIP_CAPTURE);
    await evaluate(`window.__warned = []; (function () { var ow = console.warn;
      console.warn = function (m) { window.__warned.push(String(m)); ow.apply(console, arguments); }; })()`);
    await evaluate(`window.edit.blog.rebuild()`);
    await passRouteStep();
    const zip8 = await capturePublish();
    const warned8 = await evaluate(`window.__warned`);
    const man8 = zip8 && zip8["blog.html"] ? zip8["blog.html"].toString("utf8") : "";
    check("rebuild: a title changed by hand in the month file wins, and the manifest is written from the files",
      !!zip8 && man8.includes("2606090001Hand title") && !man8.includes("Moved post"),
      (man8.match(/\d{10}[^|\n<]*/g) || []).join(" | ") || "no zip");
    check("rebuild: every difference it writes is named on the console",
      warned8.some((w) => /p0001 is "Hand title"/.test(w) && /The month file wins/.test(w)),
      JSON.stringify(warned8).slice(0, 220));
    check("rebuild: the counters never go down",
      man8.includes("next-post:0009") && man8.includes("next-img:0003"),
      (man8.match(/next-(post|img):\d{4}/g) || []).join(" "));
    check("rebuild: a changed entry reaches the home page highlights",
      !!zip8 && !!zip8["index.html"] && zip8["index.html"].toString("utf8").includes("Hand title"),
      zip8 ? Object.keys(zip8).sort().join(", ") : "no zip");
    if (zip8) {
      const mo8 = zip8["blog/2606.html"].toString("utf8");
      const ms8 = (/GENERATED[^>]*stamp:([0-9a-z]{6})/.exec(mo8) || [])[1];
      check("rebuild: the rebuilt month file carries the title and a month stamp the manifest repeats",
        mo8.includes('<h3 class="bs-post__title">Hand title</h3>') && !!ms8 && man8.includes("month:2606=" + ms8),
        "stamp " + ms8);
      writeBundle(zip8);
    }

    // P2-9. the two codes. BLG-E10: a month file from another publish is
    // warned about at the hand-off, with both stamps, and taken anyway.
    // BLG-E11: a manifest that changed under the composer stops the publish
    // with the code, and the composer keeps the post.
    await send("Page.navigate", { url: B + "blog.html" });
    await sleep(2200);
    await evaluate(ZIP_CAPTURE);
    const e10 = await evaluate(`(function () {
      var warned = [];
      var ow = console.warn;
      console.warn = function (m) { warned.push(String(m)); };
      var p = AMH.tool.handOff("blog/2606.html", new Error("fetch refused"));
      var zone = document.querySelector('.ced-handoff__zone');
      var dt = new DataTransfer();
      dt.items.add(new File(["<!DOCTYPE html>\\n<!-- GENERATED by the blog.html publish engine on 2026-01-01; " +
        "stamp:000000; hand edits are overwritten -->\\n<html></html>"], "2606.html", { type: "text/html" }));
      zone.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
      return p.then(function (txt) {
        console.warn = ow;
        return { took: /stamp:000000/.test(txt), gone: !document.querySelector('.ced-handoff__zone'),
                 warned: warned.filter(function (w) { return /BLG-E10/.test(w); }) };
      });
    })()`, { awaitPromise: true });
    check("BLG-E10: a month file from another publish is warned about, with both stamps, and taken",
      e10.took && e10.gone && e10.warned.length === 1 &&
      /2606\.html says 000000, the page says [0-9a-z]{6}\./.test(e10.warned[0]),
      JSON.stringify(e10).slice(0, 220));
    await sleep(800);
    await evaluate(`window.edit.blog()`);
    await sleep(300);
    await evaluate(`document.querySelector('.bc-date').value = '260615'`);
    await evaluate(`document.querySelector('.bc-title').value = 'Stale manifest post'`);
    await evaluate(`document.querySelector('.bc-write textarea').value = '<p>Never built.</p>'`);
    const idx9 = readFileSync(join(bdir, "blog.html"), "utf8");
    writeFileSync(join(bdir, "blog.html"), idx9.replace("next-img:0003", "next-img:0004"));
    const step9 = await pressPublish();
    await sleep(900);
    const e11 = await evaluate(`(function () {
      var box = document.querySelector('.bc-wizard');
      var r = { step: box ? box.getAttribute('data-step') : 'none',
                body: box ? box.querySelector('.bc-wiz__body').textContent : '',
                title: document.querySelector('.bc-title').value, zip: window.__zipB64 };
      var close = box && [...box.querySelectorAll('.ced-modal__btns button')].find(function (b) { return b.textContent === 'Close'; });
      if (close) close.click();
      return r;
    })()`);
    writeFileSync(join(bdir, "blog.html"), idx9);
    check("BLG-E11: a manifest that changed under the composer stops the publish with the code; the composer keeps the post",
      step9 !== "timeout" && e11.step === "failed" && /BLG-E11/.test(e11.body) &&
      /Reload the page and compose again/.test(e11.body) && /Save the draft, reload/.test(e11.body) &&
      e11.title === "Stale manifest post" && !e11.zip,
      step9 + " " + JSON.stringify(e11).slice(0, 220));
    await evaluate(`[...document.querySelectorAll('.bc-btns .ced-btn')].find(b => b.textContent === 'Close').click()`);
    await sleep(300);

    // P2-10. an old HTML post opens in HTML mode and republishes as HTML.
    // The served month is put into the pre-V047 shape first: no format on
    // the source block, which is what every post published before it has.
    const m2606x = readFileSync(join(bdir, "blog/2606.html"), "utf8");
    writeFileSync(join(bdir, "blog/2606.html"), m2606x.replace(/ data-format="(?:md|html)"/g, ""));
    await send("Page.navigate", { url: B + "blog.html" });
    await sleep(2200);
    await evaluate(ZIP_CAPTURE);
    await evaluate(`window.edit.blog.edit("0001")`);
    await sleep(1200);
    const htmlMode = await evaluate(`({
      mode: document.querySelector('.bc-panel').getAttribute('data-mode'),
      status: document.querySelector('.bc-status').textContent,
      tools: [...document.querySelectorAll('.bc-write .ced-tool')].map(b => b.textContent).join('|'),
      title: document.querySelector('.bc-title').value,
    })`);
    check("HTML mode: a post from before V047 opens as HTML, with the HTML toolbar and the note",
      htmlMode.mode === "html" && /written in HTML\. It stays HTML/.test(htmlMode.status) &&
      /^B\|I\|Link\|BR\|/.test(htmlMode.tools) && /H3\|P$/.test(htmlMode.tools) && htmlMode.title === "Hand title",
      JSON.stringify(htmlMode).slice(0, 220));
    await pressPublish();
    const zip10 = await capturePublish();
    const mo10 = zip10 && zip10["blog/2606.html"] ? zip10["blog/2606.html"].toString("utf8") : "";
    const blk10 = (/<article class="bs-post" id="p0001"[\s\S]*?<\/article>/.exec(mo10) || [])[0] || "";
    check("HTML mode: it republishes as html, with the body, the title and the source unchanged",
      /data-format="html"/.test(blk10) && blk10.includes("EDITED BODY") && blk10.includes('data-title="Hand title"') &&
      blk10.includes('<h3 class="bs-post__title">Hand title</h3>') &&
      blk10.includes("[img0001,Cap one|Alt one][png0002,Cap two]"),
      blk10.slice(0, 220).replace(/\s+/g, " ") || "no block");
    if (zip10) writeBundle(zip10);

    // P2-11. a Markdown post with a table, a flag, an image, tags, a time
    // and a zone, and no title. The image number is the manifest's next.
    const nextImg = (/next-img:(\d{4})/.exec(readFileSync(join(bdir, "blog.html"), "utf8")) || [])[1];
    const MD_SRC = "We ran the **dome** test.\n\n| Rig | Frames |\n| --- | ---: |\n| new | 90 |\n\n" +
      "{expandformore}\n\n[img" + nextImg + ",Dome at dusk|The dome]\n\nThe rest.";
    await send("Page.navigate", { url: B + "blog.html" });
    await sleep(2200);
    await evaluate(ZIP_CAPTURE);
    await evaluate(`window.edit.blog()`);
    await sleep(300);
    await evaluate(`document.querySelector('.bc-date').value = '260615'`);
    await evaluate(`document.querySelector('.bc-title').value = ''`);
    await evaluate(`document.querySelector('.bc-write textarea').value = ${JSON.stringify(MD_SRC)}`);
    await evaluate(`document.querySelector('.bc-tags input').value = '#xr, planetarium xr'`);
    await evaluate(`(() => { const t = document.querySelector('.bc-time'); t.dispatchEvent(new Event('focus'));
      t.value = '6:39 pm'; t.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('.bc-zone').value = 'EDT'; })()`);
    await evaluate(`(function () {
      var cv = document.createElement('canvas'); cv.width = 800; cv.height = 600;
      var cx = cv.getContext('2d'); cx.fillStyle = '#224466'; cx.fillRect(0, 0, 800, 600);
      return new Promise(function (res) { cv.toBlob(function (b) {
        var dt = new DataTransfer(); dt.items.add(new File([b], 'dome.png', { type: 'image/png' }));
        document.querySelector('.bc-drop').dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
        res(true);
      }, 'image/png'); });
    })()`, { awaitPromise: true });
    for (let i = 0; i < 20; i++) {
      if ((await evaluate(`document.querySelectorAll('.bc-card').length`)) === 1) break;
      await sleep(300);
    }
    await evaluate(`[...document.querySelectorAll('.bc-tab')].find(b => b.textContent === 'Preview').click()`);
    await sleep(400);
    const preview = await evaluate(`({
      table: !!document.querySelector('.bc-preview table'), strong: !!document.querySelector('.bc-preview strong'),
      img: (document.querySelector('.bc-preview .bs-post__body img') || {}).src || '',
      h2: !!document.querySelector('.bc-preview .bs-post__title'),
      time: (document.querySelector('.bc-preview time') || {}).textContent || '',
      zone: (document.querySelector('.bc-preview .bs-post__zone') || {}).textContent || '' })`);
    check("Markdown: the preview renders through the renderer, the image in place, no h2 without a title",
      preview.table && preview.strong && /^blob:/.test(preview.img) && !preview.h2 &&
      /6:39 pm/.test(preview.time) && /EDT/.test(preview.zone),
      JSON.stringify(preview).slice(0, 200));
    await pressPublish();
    const zip11 = await capturePublish();
    const man11 = zip11 && zip11["blog.html"] ? zip11["blog.html"].toString("utf8") : "";
    const mo11 = zip11 && zip11["blog/2606.html"] ? zip11["blog/2606.html"].toString("utf8") : "";
    const newId = (/\n(?:[^\n]*\|)?260615(\d{4})We ran the dome test\. Rig\.\.\./.exec(man11) || [])[1];
    const blk11 = newId ? (new RegExp('<article class="bs-post" id="p' + newId + '"[\\s\\S]*?</article>').exec(mo11) || [])[0] || "" : "";
    check("Markdown: a titleless post gets a derived manifest title, an empty data-title and no h2",
      !!newId && blk11.includes('data-title=""') && !/bs-post__title/.test(blk11),
      "id " + newId + " " + (man11.match(/\n[^\n]*We ran[^\n]*/) || [""])[0].slice(0, 120));
    check("Markdown: the month file carries the rendered HTML, the facts and the Markdown source",
      blk11.includes('data-time="1839"') && blk11.includes('data-zone="EDT"') && blk11.includes('data-tags="xr planetarium"') &&
      blk11.includes('<time datetime="2026-06-15T18:39">June 15, 2026 · 6:39 pm</time>' +
        '<span class="bs-post__zone">EDT</span>') &&
      blk11.includes("<table>") && blk11.includes('<span class="bp-cut" data-cut="soft"></span>') &&
      blk11.includes('<figure class="bp-fig"><img src="../blog/260615_img' + nextImg + '.jpg"') &&
      blk11.includes('data-format="md"') && blk11.includes(MD_SRC),
      blk11.slice(0, 300).replace(/\s+/g, " ") || "no block");
    // the stream shows the newest month, which is June, and this post is
    // in it: the whole post, rendered, with no title and so no h3
    const stream11 = man11.slice(man11.indexOf("<!--[edit:blog-stream]-->"),
      man11.indexOf("<!--[/edit:blog-stream]-->"));
    check("Markdown: the stream carries the new post whole, with no title and no h3",
      stream11.includes('<article class="bs-post" id="s' + newId + '"') &&
      stream11.includes('data-tags="xr planetarium"') && stream11.includes("<table>") &&
      stream11.includes('<span class="bp-cut" data-cut="soft"></span>') &&
      !/id="s0004"[\s\S]*?bs-post__title/.test(stream11) &&
      stream11.includes('<a href="blog.html?t=xr">#xr</a>'),
      stream11.replace(/\s+/g, " ").slice(0, 240));
    if (zip11) writeBundle(zip11);

    // P2-12. a rebuild of a month with both kinds regenerates both kinds, the
    // same bytes, and the post reopens as the Markdown that was typed
    await send("Page.navigate", { url: B + "blog.html" });
    await sleep(2200);
    await evaluate(ZIP_CAPTURE);
    await evaluate(`window.edit.blog.rebuild()`);
    await passRouteStep();
    const zip12 = await capturePublish();
    const mo12 = zip12 && zip12["blog/2606.html"] ? zip12["blog/2606.html"].toString("utf8") : "";
    check("rebuild: a month with both kinds regenerates both kinds, byte for byte",
      (mo12.match(/data-format="html"/g) || []).length === 1 && (mo12.match(/data-format="md"/g) || []).length === 1 &&
      !!zip12 && zip12["blog/2606.html"].equals(readFileSync(join(bdir, "blog/2606.html"))),
      mo12 ? firstDiff(mo12, readFileSync(join(bdir, "blog/2606.html"), "utf8")) : "no zip");
    await send("Page.navigate", { url: B + "blog.html" });
    await sleep(2200);
    await evaluate(`window.edit.blog.edit(${JSON.stringify(newId || "0000")})`);
    await sleep(1200);
    const reopened = await evaluate(`(() => {
      const t = document.querySelector('.bc-time'); const before = t.value; AMH.publish.tick();
      return { body: document.querySelector('.bc-write textarea').value, title: document.querySelector('.bc-title').value,
        tags: document.querySelector('.bc-tags input').value, time: t.value, held: t.value === before,
        zone: document.querySelector('.bc-zone').value, mode: document.querySelector('.bc-panel').getAttribute('data-mode') };
    })()`);
    check("Markdown: a post reopens as the Markdown that was typed, with its tags, time and zone, and the clock off",
      reopened.body === MD_SRC && reopened.title === "" && reopened.tags === "xr planetarium" &&
      reopened.time === "6:39 pm" && reopened.held && reopened.zone === "EDT" && reopened.mode === "md",
      JSON.stringify(reopened).slice(0, 200));
    await evaluate(`[...document.querySelectorAll('.bc-btns .ced-btn')].find(b => b.textContent === 'Close').click()`);
    await sleep(300);

    // FT3. the composer offers the blog's tags with their counts, takes
    // one on a click, and still keeps anything typed that is not on the list
    await send("Page.navigate", { url: B + "blog.html" });
    await sleep(2200);
    await evaluate(`window.edit.blog()`);
    await sleep(400);
    const tagMenu = await evaluate(`(function () {
      var input = document.querySelector('.bc-tags input');
      input.focus();
      return new Promise(function (res) { setTimeout(function () {
        input.value = 'x'; input.dispatchEvent(new Event('input', { bubbles: true }));
        setTimeout(function () {
          var menu = document.querySelector('.bc-tags__menu');
          var opts = [].map.call(menu.querySelectorAll('.bc-tags__opt'),
            function (o) { return o.getAttribute('data-tag') + ':' + o.querySelector('small').textContent; });
          var first = menu.querySelector('.bc-tags__opt');
          if (first) first.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
          var took = input.value;
          input.value = took + 'brandnew';
          input.dispatchEvent(new Event('input', { bubbles: true }));
          setTimeout(function () {
            res({ opts: opts, took: took, hidden: menu.hidden, kept: input.value });
          }, 200);
        }, 300);
      }, 900); });
    })()`, { awaitPromise: true });
    check("tags: the composer offers the blog's tags with counts and takes one on a click",
      JSON.stringify(tagMenu.opts) === '["xr:1"]' && tagMenu.took === "xr ",
      JSON.stringify(tagMenu).slice(0, 200));
    check("tags: a tag the blog has never used is not refused",
      tagMenu.kept === "xr brandnew" && tagMenu.hidden,
      JSON.stringify(tagMenu).slice(0, 160));
    await evaluate(`[...document.querySelectorAll('.bc-btns .ced-btn')].find(b => b.textContent === 'Close').click()`);
    await sleep(300);

    // P2-7. the highlights region is optional. Someone who deletes it from
    // index.html has changed their mind about the block, not about blogging:
    // the publish reports the missing region and ships the post regardless.
    const homeNoBlock = readFileSync(join(bdir, "index.html"), "utf-8")
      .replace("<!--[edit:blog-highlights]-->", "")
      .replace("<!--[/edit:blog-highlights]-->", "");
    writeFileSync(join(bdir, "index.html"), homeNoBlock);
    await send("Page.navigate", { url: B + "blog.html" });
    await sleep(2200);
    await evaluate(ZIP_CAPTURE);
    await evaluate(`window.edit.blog()`);
    await sleep(300);
    await evaluate(`document.querySelector('.bc-date').value = '260620'`);
    await evaluate(`document.querySelector('.bc-title').value = 'Post with no highlights block'`);
    await evaluate(`document.querySelector('.bc-write textarea').value = '<p>Still published.</p>'`);
    await pressPublish();
    const zip7 = await capturePublish();
    check("P2: a deleted highlights region does not fail the publish",
      !!zip7 && !!zip7["blog/2606.html"] &&
      zip7["blog/2606.html"].toString("utf8").includes("Still published."),
      zip7 ? Object.keys(zip7).sort().join(", ") : "no zip");
    check("P2: and the home page is left out rather than written wrong",
      !!zip7 && !zip7["index.html"],
      zip7 && zip7["index.html"] ? "index.html was written anyway" : "left out");

    // ---- the staging layer ----
    // LY1. two posts in one page load. The second bundle is built on the
    // first, so the newest zip is the whole of what is not yet uploaded.
    await send("Page.navigate", { url: B + "blog.html" });
    await sleep(2200);
    await evaluate(ZIP_CAPTURE);
    await evaluate(`window.edit.blog()`);
    await sleep(300);
    await evaluate(`document.querySelector('.bc-date').value = '260720'`);
    await evaluate(`document.querySelector('.bc-title').value = 'Layer one'`);
    await evaluate(`document.querySelector('.bc-write textarea').value = 'The first of two.'`);
    await pressPublish();
    const zipL1 = await capturePublish();
    const doneL1 = await evaluate(`(function () {
      var box = document.querySelector('.bc-wizard');
      var btns = box ? [...box.querySelectorAll('.ced-modal__btns button')].map(function (b) { return b.textContent; }) : [];
      var rec = JSON.parse(sessionStorage.getItem('amh-publish-pending') || 'null');
      return { btns: btns, files: rec ? Object.keys(rec.files || {}).sort() : [],
               images: rec ? rec.images : null, stamp: rec ? rec.stamp : "" };
    })()`);
    check("layer: a bundle leaves its text files staged, and names the images it cannot keep",
      !!zipL1 && doneL1.files.indexOf("blog.html") !== -1 && doneL1.files.indexOf("search.js") !== -1 &&
      doneL1.files.indexOf("feed.xml") !== -1 && doneL1.files.indexOf("blog/2607.html") !== -1 &&
      JSON.stringify(doneL1.images) === "[]" && /^[0-9a-z]{6}$/.test(doneL1.stamp),
      JSON.stringify(doneL1).slice(0, 240));
    /* the zip lands before the paced rows finish, so the Done step and
       its Compose another button are not there yet */
    for (let i = 0; i < 25; i++) {
      const step = await evaluate(`(document.querySelector('.bc-wizard') || { getAttribute: () => '' }).getAttribute('data-step')`);
      if (step === "done") break;
      await sleep(300);
    }
    // the post is on the page at once, and says it is not uploaded
    const staged = await evaluate(`(function () {
      var box = document.querySelector('.bc-wizard');
      var again = box && [...box.querySelectorAll('.ced-modal__btns button')].find(function (b) { return /Compose another/.test(b.textContent); });
      var out = { chips: document.querySelectorAll('.bs-post__staged').length,
                  onPage: !!document.querySelector('.bs-post[data-date="260720"]'),
                  again: !!again };
      if (again) again.click();
      return out;
    })()`);
    check("layer: the new post is on the page at once, wearing the chip that says so",
      staged.chips === 1 && staged.onPage && staged.again, JSON.stringify(staged));
    await sleep(600);
    const second = await evaluate(`({
      panels: document.querySelectorAll('.bc-panel').length,
      wizard: !!document.querySelector('.bc-wizard'),
      title: (document.querySelector('.bc-title') || {}).value,
    })`);
    /* the capture holds the first zip until it is cleared, and a stale
       one returns at once and reads the page mid-build */
    await evaluate(`window.__zipB64 = null`);
    await evaluate(`document.querySelector('.bc-date').value = '260721'`);
    await evaluate(`document.querySelector('.bc-title').value = 'Layer two'`);
    await evaluate(`document.querySelector('.bc-write textarea').value = 'The second of two.'`);
    const pressed = await pressPublish();
    const why = await evaluate(`({
      step: (document.querySelector('.bc-wizard') || { getAttribute: () => 'none' }).getAttribute('data-step'),
      body: (document.querySelector('.bc-wiz__body') || {}).textContent || '',
      status: (document.querySelector('.bc-status') || {}).textContent || '',
    })`);
    const zipL2 = await capturePublish();
    const manL2 = zipL2 && zipL2["blog.html"] ? zipL2["blog.html"].toString("utf8") : "";
    check("layer: a second publish in the same page load carries the first one too",
      !!zipL2 && /Layer one/.test(manL2) && /Layer two/.test(manL2) &&
      !!zipL2["blog/2607.html"] &&
      /Layer one/.test(zipL2["blog/2607.html"].toString("utf8")) &&
      /Layer two/.test(zipL2["blog/2607.html"].toString("utf8")),
      manL2 ? (manL2.match(/\n\d{10}[^\n<]*/g) || []).join(" | ").slice(0, 200)
        : "no zip: " + pressed + " " + JSON.stringify(second) + " " + JSON.stringify(why).slice(0, 300));
    for (let i = 0; i < 25; i++) {
      const step = await evaluate(`(document.querySelector('.bc-wizard') || { getAttribute: () => '' }).getAttribute('data-step')`);
      if (step === "done") break;
      await sleep(300);
    }
    const twoChips = await evaluate(`(function () {
      var box = document.querySelector('.bc-wizard');
      var out = { chips: document.querySelectorAll('.bs-post__staged').length,
                  posts: document.querySelectorAll('.bs-post').length };
      /* the zip again, from the layer alone */
      var dl = box && [...box.querySelectorAll('.ced-modal__btns button')].find(function (b) { return /Download again/.test(b.textContent); });
      window.__zipB64 = null;
      if (dl) dl.click();
      return out;
    })()`);
    check("layer: both staged posts wear the chip",
      twoChips.chips === 2 && twoChips.posts === 2, JSON.stringify(twoChips));
    const again = await capturePublish();
    check("layer: Download again rebuilds the zip from the layer, text and all",
      !!again && !!again["blog.html"] && !!again["search.js"] &&
      /Layer two/.test(again["blog.html"].toString("utf8")) &&
      !Object.keys(again).some((n) => /\.(jpg|png)$/.test(n)),
      again ? Object.keys(again).sort().join(", ") : "no zip");
    await evaluate(`[...document.querySelectorAll('.bc-wizard .ced-modal__btns button')].find(b => b.textContent === 'All done, close the post!').click()`);
    await evaluate(`[...document.querySelectorAll('.bc-wizard .ced-modal__btns button')].find(b => b.textContent === 'Got it')?.click()`);

    // LY2. an authored region is never replaced from the layer
    const authored = await evaluate(`(function () {
      var h2 = document.querySelector('.blog-page h2');
      var was = h2.textContent;
      h2.textContent = 'AUTHORED, NOT STAGED';
      AMH.publish.staged();
      return { after: h2.textContent, was: was };
    })()`);
    check("layer: it replaces the machine-owned regions and leaves an authored one alone",
      authored.after === "AUTHORED, NOT STAGED", JSON.stringify(authored));

    // LY3. the layer is dropped when the page arrives carrying its stamp
    if (zipL2) writeBundle(zipL2);
    await send("Page.navigate", { url: B + "blog.html" });
    await sleep(2200);
    const cleared = await evaluate(`({
      rec: sessionStorage.getItem('amh-publish-pending'),
      posts: document.querySelectorAll('.bs-post').length,
      chips: document.querySelectorAll('.bs-post__staged').length,
    })`);
    check("layer: the upload clears it, and the posts stay because the server has them now",
      cleared.rec === null && cleared.posts === 2 && cleared.chips === 0,
      JSON.stringify(cleared));

    // LY4. a layer over the size rule is refused, and says why
    const tooBig = await evaluate(`(function () {
      var warned = [];
      var ow = console.warn;
      console.warn = function (m) { warned.push(String(m)); };
      var big = new Array(2200).join("x".repeat(2000));
      var rec = { kind: "publish", id: "9999", zip: "big.zip", stamp: "aaaaaa", checks: {} };
      var kept = AMH.tool.layerKeep(rec, { "blog.html": big }, []);
      console.warn = ow;
      var back = AMH.tool.layer();
      AMH.tool.layerSave(null);
      return { kept: kept, files: Object.keys(back.files || {}).length,
               over: !!back.overSize, warned: warned.join(" ") };
    })()`);
    check("layer: a bundle over the size rule is not staged, and says so",
      tooBig.kept === false && tooBig.files === 0 && tooBig.over &&
      /over the .* the staging layer keeps/.test(tooBig.warned),
      JSON.stringify(tooBig).slice(0, 200));

    // ============ THE FOLDER ROUTE ============
    // A real folder pick needs a user gesture and opens a picker no headless
    // browser can answer, so the two calls that touch the disk are stubbed.
    // What is under test is everything else: that choosing the folder button
    // sends the bundle to the writer and not to the download, that ORPHANS.txt
    // is held back, and that the Done step describes what actually happened.
    await send("Page.navigate", { url: B + "blog.html" });
    await sleep(2200);
    await evaluate(ZIP_CAPTURE);
    await evaluate(`(function () {
      window.__wrote = null;
      AMH.tool.repoWriteReady = function () { return false; };
      AMH.tool.pickRepoWrite = function () { return Promise.resolve({ stub: true }); };
      AMH.tool.writeRepo = function (files) {
        window.__wrote = Object.keys(files).sort();
        return Promise.resolve(window.__wrote);
      };
    })()`);
    await evaluate(`window.edit.blog()`);
    await sleep(300);
    await evaluate(`document.querySelector('.bc-date').value = '260815'`);
    await evaluate(`document.querySelector('.bc-title').value = 'Folder route'`);
    await evaluate(`document.querySelector('.bc-write textarea').value = 'Written into the folder.'`);
    await evaluate(`[...document.querySelectorAll('.bc-btns .ced-btn')].find(b => b.textContent === 'Publish').click()`);
    await sleep(400);
    const tookFolder = await pressRoute("Write into my repo folder");
    let folderDone = null;
    for (let i = 0; i < 40 && !(folderDone && folderDone.step === "done"); i++) {
      await sleep(300);
      folderDone = await evaluate(`(function () {
        var box = document.querySelector('.bc-wizard');
        if (!box) return { step: 'none' };
        return {
          step: box.getAttribute('data-step'),
          body: box.querySelector('.bc-wiz__body').textContent,
          checks: [...box.querySelectorAll('.bc-wiz__checks input')].map(function (c) { return c.getAttribute('data-check'); }),
          wrote: window.__wrote,
          zipped: window.__zipB64 !== null,
          fell: !!box.querySelector('.bc-wiz__fell'),
          route: (AMH.publish.record() || {}).route
        };
      })()`);
    }
    check("folder route: the chosen button sends the bundle to the writer, not the download",
      tookFolder === true && folderDone.step === "done" && folderDone.route === "folder" &&
      folderDone.zipped === false && folderDone.fell === false &&
      (folderDone.wrote || []).indexOf("blog.html") !== -1 &&
      (folderDone.wrote || []).indexOf("blog/2608.html") !== -1 &&
      (folderDone.wrote || []).indexOf("search.js") !== -1,
      JSON.stringify({ took: tookFolder, route: folderDone.route, zipped: folderDone.zipped,
                       wrote: folderDone.wrote }).slice(0, 240));
    // ORPHANS.txt is the zip's own file. Writing it into the repo would add a
    // file to delete to the list of files to delete.
    check("folder route: ORPHANS.txt is never written into the repo",
      (folderDone.wrote || []).indexOf("ORPHANS.txt") === -1,
      JSON.stringify(folderDone.wrote));
    // and the reader's list loses the step that only a zip has
    // and the last word after a folder write is the other one: the files ARE
    // in the repo, so a hard refresh is the next thing and there is nothing
    // to extract.
    await evaluate(`[...document.querySelectorAll('.bc-wizard .ced-modal__btns button')].find(function (b) { return b.textContent === 'All done, close the post!'; })?.click()`);
    const folderLastWord = await evaluate(`(function () {
      var box = document.querySelector('.bc-wizard');
      return { step: box && box.getAttribute('data-step'),
               text: box ? box.querySelector('.bc-wiz__body').textContent : '' };
    })()`);
    check("folder route: the last step says the files are in the repo, and to hard refresh",
      folderLastWord.step === "refresh" &&
      /files are in your repo/.test(folderLastWord.text) &&
      /Ctrl\+F5/.test(folderLastWord.text) &&
      !/Downloads folder/.test(folderLastWord.text),
      JSON.stringify(folderLastWord).slice(0, 200));
    await evaluate(`[...document.querySelectorAll('.bc-wizard .ced-modal__btns button')].find(function (b) { return b.textContent === 'Got it'; })?.click()`);

    check("folder route: the done step drops the extract step and says the files are in place",
      /written straight into your repo folder/.test(folderDone.body) &&
      folderDone.checks.indexOf("extract") === -1 &&
      folderDone.checks.indexOf("review") !== -1 &&
      folderDone.checks.indexOf("commit") !== -1,
      JSON.stringify(folderDone.checks));

    // FR2. a refused folder must not lose the bundle: it falls back to the zip
    // and the Done step says so, because the bundle is already built by then.
    await send("Page.navigate", { url: B + "blog.html" });
    await sleep(2200);
    await evaluate(ZIP_CAPTURE);
    await evaluate(`(function () {
      AMH.tool.repoWriteReady = function () { return false; };
      AMH.tool.pickRepoWrite = function () {
        return Promise.reject(Object.assign(new Error("BLG-E13 - not the repo root"), { code: "BLG-E13" }));
      };
    })()`);
    await evaluate(`window.edit.blog()`);
    await sleep(300);
    await evaluate(`document.querySelector('.bc-date').value = '260816'`);
    await evaluate(`document.querySelector('.bc-title').value = 'Refused folder'`);
    await evaluate(`document.querySelector('.bc-write textarea').value = 'Falls back to the zip.'`);
    await evaluate(`[...document.querySelectorAll('.bc-btns .ced-btn')].find(b => b.textContent === 'Publish').click()`);
    await sleep(400);
    await pressRoute("Write into my repo folder");
    let refused = null;
    for (let i = 0; i < 40 && !(refused && refused.step === "done"); i++) {
      await sleep(300);
      refused = await evaluate(`(function () {
        var box = document.querySelector('.bc-wizard');
        if (!box) return { step: 'none' };
        return { step: box.getAttribute('data-step'),
                 fell: (box.querySelector('.bc-wiz__fell') || {}).textContent || '',
                 zipped: window.__zipB64 !== null,
                 route: (AMH.publish.record() || {}).route,
                 checks: [...box.querySelectorAll('.bc-wiz__checks input')].map(function (c) { return c.getAttribute('data-check'); }) };
      })()`);
    }
    check("folder route: a refused folder falls back to the zip and says so",
      refused.step === "done" && refused.route === "zip" && refused.zipped === true &&
      /BLG-E13/.test(refused.fell) && /downloaded instead/.test(refused.fell) &&
      refused.checks.indexOf("extract") !== -1,
      JSON.stringify({ route: refused.route, zipped: refused.zipped,
                       fell: refused.fell }).slice(0, 200));

    // ============ THE REMEMBERED REPO FOLDER ============
    // Picking the folder for every page load is one pick too many, so the
    // handle is kept in IndexedDB. It cannot be a path: no browser opens a
    // folder by name, and no browser tells a page where a folder is. That
    // last point is also why nothing here can carry a path into the repo.
    //
    // A fresh page load is needed, because the remembered folder is offered
    // once per load.
    await send("Page.navigate", { url: B + "blog.html" });
    await sleep(2200);
    const remembered = await evaluate(`(function () {
      /* a stand-in that answers the three calls the check makes, and that
         survives the structured clone IndexedDB puts it through */
      var pageStamp = (/stamp:([0-9a-z]{6})/
        .exec(document.getElementById('blogManifest').textContent) || [])[1] || '';
      var stand = { name: 'aaron-harris-portfolio', __stamp: pageStamp };
      window.__pickerCalls = 0;
      window.showDirectoryPicker = function () { window.__pickerCalls++; return Promise.reject(Object.assign(new Error('x'), { name: 'AbortError' })); };
      return AMH.tool.repoForget().then(function () {
        return new Promise(function (res) {
          var q = indexedDB.open('amh-editor', 1);
          q.onupgradeneeded = function () { q.result.createObjectStore('repo'); };
          q.onsuccess = function () {
            var tx = q.result.transaction('repo', 'readwrite');
            tx.objectStore('repo').put({ handle: stand, name: stand.name }, 'folder');
            tx.oncomplete = function () {
              AMH.tool.repoRecall().then(function (h) {
                res({ recalled: h ? h.name : null, stamp: h ? h.__stamp : null,
                      pageStamp: pageStamp });
              });
            };
          };
        });
      });
    })()`, { awaitPromise: true });
    check("repo memory: the folder handle survives in IndexedDB and comes back by name",
      remembered.recalled === "aaron-harris-portfolio" &&
      /^[0-9a-z]{6}$/.test(remembered.pageStamp),
      JSON.stringify(remembered));

    // the check that replaces the path you cannot see: the folder's own
    // blog.html stamp, against the page asking for it
    const verdicts = await evaluate(`(function () {
      var mine = (/stamp:([0-9a-z]{6})/
        .exec(document.getElementById('blogManifest').textContent) || [])[1];
      function fileH(text, name) {
        return { kind: 'file', getFile: function () {
          return Promise.resolve(new File([text], name, { type: 'text/html' })); } };
      }
      function folder(name, blogText) {
        var files = { 'index.html': fileH('<html></html>', 'index.html') };
        if (blogText !== null) files['blog.html'] = fileH(blogText, 'blog.html');
        return { name: name,
          queryPermission: function () { return Promise.resolve('granted'); },
          getFileHandle: function (n) {
            return files[n] ? Promise.resolve(files[n])
                            : Promise.reject(new Error('NotFoundError'));
          } };
      }
      var man = '<scr' + 'ipt id="blogManifest">stamp:';
      return Promise.all([
        AMH.tool.repoVerify(folder('same', man + mine + '</scr' + 'ipt>')),
        AMH.tool.repoVerify(folder('stale', man + 'zzzzzz</scr' + 'ipt>')),
        AMH.tool.repoVerify(folder('noblog', null))
      ]).then(function (v) {
        return { same: v[0], stale: v[1], notRoot: v[2], mine: mine };
      });
    })()`, { awaitPromise: true });
    check("repo memory: a folder whose blog page matches this page is accepted and says so",
      verdicts.same.ok === true && !verdicts.same.warn &&
      verdicts.same.why.indexOf(verdicts.mine) !== -1,
      JSON.stringify(verdicts.same));
    // two clones share one origin on disk and one folder name, so the stamp
    // is the only thing that can tell them apart
    check("repo memory: a clone from a different publish is flagged, not silently used",
      verdicts.stale.ok === true && verdicts.stale.warn === true &&
      /DIFFERENT publish/.test(verdicts.stale.why) && /zzzzzz/.test(verdicts.stale.why),
      JSON.stringify(verdicts.stale));
    check("repo memory: a folder without the root marks is refused",
      verdicts.notRoot.ok === false && /not the root/.test(verdicts.notRoot.why),
      JSON.stringify(verdicts.notRoot));
    // and forgetting it really forgets it
    const forgotten = await evaluate(
      `AMH.tool.repoForget().then(function () { return AMH.tool.repoRecall(); })
        .then(function (h) { return h === null; })`, { awaitPromise: true });
    check("repo memory: forgetting the folder leaves nothing to recall",
      forgotten === true, String(forgotten));

    // RF1. One folder, two permissions. Read and write are two permissions on
    // one handle, not two folders, so a folder picked for reading must not
    // send the reader back to the picker when the publish comes to write it.
    const reuse = await evaluate(`(function () {
      function fileH(text, name) {
        return { kind: 'file', getFile: function () {
          return Promise.resolve(new File([text], name, { type: 'text/html' })); } };
      }
      var stamp = (/stamp:([0-9a-z]{6})/
        .exec(document.getElementById('blogManifest').textContent) || [])[1] || '';
      var files = { 'index.html': fileH('<html></html>', 'index.html'),
                    'blog.html': fileH('<scr' + 'ipt id="blogManifest">stamp:' + stamp + '</scr' + 'ipt>', 'blog.html') };
      window.__picks = [];
      window.__asked = [];
      window.__perm = 'granted';
      var dir = { kind: 'directory', name: 'aaron-harris-portfolio',
        queryPermission: function (o) { return Promise.resolve(window.__perm); },
        requestPermission: function (o) { window.__asked.push(o.mode); return Promise.resolve(window.__grant || 'granted'); },
        getFileHandle: function (n) {
          return files[n] ? Promise.resolve(files[n]) : Promise.reject(new Error('NotFound'));
        },
        getDirectoryHandle: function () { return Promise.reject(new Error('NotFound')); } };
      window.showDirectoryPicker = function (o) { window.__picks.push(o && o.mode); return Promise.resolve(dir); };
      return AMH.tool.repoForget().then(function () {
        return AMH.tool.pickRepo(['blog.html']);
      }).then(function () {
        /* the browser holds the handle but not write permission, which is
           what it does in life: the raise is asked for, not a new pick */
        window.__perm = 'prompt';
        return AMH.tool.pickRepoWrite();
      }).then(function (h) {
        return { got: h ? h.name : null, picks: window.__picks.slice(),
                 asked: window.__asked.slice(), ready: AMH.tool.repoWriteReady() };
      });
    })()`, { awaitPromise: true });
    check("repo folder: a folder picked for reading is raised to write, not picked again",
      reuse.got === "aaron-harris-portfolio" && reuse.ready === true &&
      JSON.stringify(reuse.picks) === '["read"]' &&
      JSON.stringify(reuse.asked) === '["readwrite"]',
      JSON.stringify(reuse));

    // RF2. A refused raise is a real answer, and the picker is how the reader
    // gives a different folder or the same one with more permission.
    const raiseRefused = await evaluate(`(function () {
      window.__perm = 'prompt';
      window.__grant = 'denied';
      window.__picks.length = 0;
      /* the picker returns the same folder, which still cannot be written,
         so the refusal carries its code up to the caller. bcDeliver catches
         it and falls back to the zip rather than losing a built bundle. */
      return AMH.tool.pickRepoWrite().then(
        function (h) { return { picks: window.__picks.slice(), got: h ? h.name : null, code: "" }; },
        function (err) { return { picks: window.__picks.slice(), got: null, code: err.code || "" }; });
    })()`, { awaitPromise: true });
    check("repo folder: a refused raise goes back to the picker, and a refusal is reported",
      JSON.stringify(raiseRefused.picks) === '["readwrite"]' &&
      raiseRefused.code === "BLG-E12",
      JSON.stringify(raiseRefused));
    await evaluate(`AMH.tool.repoForget()`);

    /* the layer is the tab's, so it is cleared before anything else runs */
    await evaluate(`AMH.tool.layerSave(null)`);
  }
  // ST-C. the index's markup and its styles are retired: no page, no
  // script and no stylesheet names them any more.
  const retired = ["bs-card", "bs-index", "bs-months", "bm-head", "bs-month ", "bs-end"];
  const searched = ["index.html", "gallery.html", "blog.html", "site.css", "site.js",
                    "work.js", "blog.js", "markdown.js", "tool.js", "publish.js"];
  const stillThere = [];
  for (const f of searched) {
    const text = readFileSync(join(REPO, f), "utf-8");
    for (const cls of retired) if (text.includes(cls)) stillThere.push(f + ":" + cls.trim());
  }
  check("style: the retired index classes appear in no page, script or stylesheet",
    stillThere.length === 0, stillThere.join(", "));

  try { bs?.kill(); } catch {}

  // ============ THE FILES STEP (a page opened from disk) ============
  // The suite opens its served copy of blog.html as a file. A fetch from a
  // file page is refused by the browser, which is the real trigger for the
  // hand-off, so nothing on this path is simulated.
  const DISK = pathToFileURL(join(SERVE, "blog.html")).href;
  exceptions.length = 0;
  const diskBlog = readFileSync(join(SERVE, "blog.html"), "utf8");
  const diskHome = readFileSync(join(SERVE, "index.html"), "utf8");
  // a blob URL cannot be fetched back on a file page, so the bytes are taken
  // where the publish hands them to the browser
  const ZIP_DIRECT = `window.__zipB64 = null; AMH.tool.download = function (name, blob) {
    var fr = new FileReader();
    fr.onload = function () { window.__zipB64 = String(fr.result).split(',')[1]; };
    fr.readAsDataURL(blob); };`;
  async function composeOnDisk() {
    await send("Page.navigate", { url: DISK });
    await sleep(2200);
    await evaluate(ZIP_DIRECT);
    await evaluate(`window.__hand = []; document.addEventListener('ced:handoff', function (e) {
      window.__hand.push((e.detail.open ? '+' : '-') + e.detail.path); });`);
    await evaluate(`window.edit.blog()`);
    await sleep(300);
    await evaluate(`document.querySelector('.bc-date').value = '260711'`);
    await evaluate(`document.querySelector('.bc-title').value = 'From disk'`);
    await evaluate(`document.querySelector('.bc-write textarea').value = '<p>Written from a file page.</p>'`);
    await evaluate(`[...document.querySelectorAll('.bc-btns .ced-btn')].find(b => b.textContent === 'Publish').click()`);
    await sleep(300);
    await evaluate(`[...document.querySelectorAll('.bc-wizard .ced-modal__btns button')].find(b => b.textContent === 'Download a .zip').click()`);
    await sleep(1400);   /* the arrow's entrance */
  }
  async function dropInto(selector, name, text) {
    await evaluate(`(function () {
      var zone = document.querySelector(${JSON.stringify(selector)});
      var dt = new DataTransfer();
      dt.items.add(new File([${JSON.stringify(text)}], ${JSON.stringify(name)}, { type: "text/html" }));
      zone.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
    })()`);
  }
  async function waitDone() {
    let d = null;
    for (let i = 0; i < 25 && !(d && d.step === "done"); i++) {
      await sleep(300);
      d = await evaluate(`(function () {
        var box = document.querySelector('.bc-wizard');
        return { step: box && box.getAttribute('data-step'), hand: window.__hand,
                 dialog: !!document.querySelector('.ced-handoff__zone'),
                 stampLine: /Publish stamp: [0-9a-z]{6}/.test(box ? box.textContent : '') };
      })()`);
    }
    return d;
  }

  // D1. the step names every file first and points at the folder button.
  // Continue hands the reads to the hand-off, and the progress row says so
  // while each dialog is up.
  await composeOnDisk();
  const filesStep = await evaluate(`(function () {
    var box = document.querySelector('.bc-wizard');
    var pt = document.querySelector('.ced-point');
    var btn = box && [...box.querySelectorAll('.ced-modal__btns button')].find(function (b) { return /repo folder/.test(b.textContent); });
    var b = btn && btn.getBoundingClientRect();
    var curve = pt && pt.querySelector('.ced-point__curve');
    var tip = curve && curve.getPointAtLength(curve.getTotalLength()).matrixTransform(curve.getScreenCTM());
    return { protocol: location.protocol, step: box && box.getAttribute('data-step'),
      items: box ? [...box.querySelectorAll('.ced-handoff__item')].map(function (i) { return i.className.replace('ced-handoff__item ', '') + ':' + i.textContent; }) : [],
      btns: box ? [...box.querySelectorAll('.ced-modal__btns button')].map(function (b) { return b.textContent; }) : [],
      zone: !!(box && box.querySelector('.bc-wiz__zone')),
      label: pt ? pt.querySelector('.ced-point__label').textContent : '',
      /* the tip touches the button: below it when there is room, at a side
         when the box sits low, so the measure is "on the button's edge" */
      near: !!(tip && b) && tip.x >= b.left - 12 && tip.x <= b.right + 12 &&
            tip.y >= b.top - 12 && tip.y <= b.bottom + 12,
      focused: document.activeElement && document.activeElement.textContent };
  })()`);
  check("files step: from disk the wizard names every file the publish reads before it builds",
    filesStep.protocol === "file:" && filesStep.step === "files" &&
    JSON.stringify(filesStep.items) ===
      '["is-wait:blog.html","is-wait:index.html","is-wait is-opt:search.js"]' &&
    JSON.stringify(filesStep.btns) === '["Cancel","Use my repo folder","Continue"]' && filesStep.zone,
    JSON.stringify(filesStep).slice(0, 260));
  check("files step: the arrow points at the folder button and says what to choose",
    filesStep.label === "Click and choose root of repo folder!" && filesStep.near &&
    filesStep.focused === "Use my repo folder",
    JSON.stringify({ label: filesStep.label, near: filesStep.near, focused: filesStep.focused }));
  await evaluate(`[...document.querySelectorAll('.bc-wizard .ced-modal__btns button')].find(b => b.textContent === 'Continue').click()`);
  await sleep(500);
  const waiting = await evaluate(`(function () {
    var box = document.querySelector('.bc-wizard');
    var row = box && box.querySelector('.bc-wiz__rows li.is-now');
    var note = document.querySelector('.ced-handoff .ced-modal__status');
    return { step: box && box.getAttribute('data-step'), row: row ? row.textContent : '',
             dialog: !!document.querySelector('.ced-handoff__zone'), note: note ? note.textContent : '' };
  })()`);
  check("files step: Continue starts the build, and the progress row says it waits for the hand-off",
    waiting.step === "progress" && waiting.row === "Waiting for you: hand over blog.html" && waiting.dialog &&
    /This publish needs the deployed bytes of these files/.test(waiting.note),
    JSON.stringify(waiting).slice(0, 240));
  await dropInto(".ced-handoff__zone", "blog.html", diskBlog);
  await sleep(1900);   /* the rows pace themselves at STEP_MS while the work waits again */
  const second = await evaluate(`(function () {
    var box = document.querySelector('.bc-wizard');
    var row = box && box.querySelector('.bc-wiz__rows li.is-now');
    var head = document.querySelector('.ced-handoff .ced-modal__head');
    return { row: row ? row.textContent : '', head: head ? head.textContent : '' };
  })()`);
  check("files step: the second read asks the same way, and the row follows it",
    /index\.html/.test(second.head) && second.row === "Waiting for you: hand over index.html",
    JSON.stringify(second));
  await dropInto(".ced-handoff__zone", "index.html", diskHome);
  await sleep(1400);
  // the packed index is the third read, and this site has none yet: the
  // dialog offers the answer that is not "give up", and the build carries on
  const absent = await evaluate(`(function () {
    var head = document.querySelector('.ced-handoff .ced-modal__head');
    var btn = [...document.querySelectorAll('.ced-handoff .ced-modal__btns button')]
      .find(function (b) { return /Not on disk/.test(b.textContent); });
    if (btn) btn.click();
    return { head: head ? head.textContent : '', answered: !!btn };
  })()`);
  check("files step: a file that may not exist is asked for last and answered without giving up",
    /search\.js/.test(absent.head) && absent.answered, JSON.stringify(absent));
  const zipD1 = await capturePublish();
  const doneD1 = await waitDone();
  check("files step: a publish from disk builds through the hand-offs and reaches Done with a stamp",
    !!zipD1 && !!zipD1["blog.html"] && !!zipD1["blog/2607.html"] && !!zipD1["search.js"] &&
    /\nstamp:[0-9a-z]{6}\n/.test(zipD1["blog.html"].toString("utf8")) &&
    doneD1 && doneD1.step === "done" && doneD1.stampLine &&
    JSON.stringify(doneD1.hand) ===
      '["+blog.html","-blog.html","+index.html","-index.html","+search.js","-search.js"]',
    JSON.stringify(doneD1).slice(0, 240) + (zipD1 ? " " + Object.keys(zipD1).sort().join(",") : " no zip"));

  // D2. with the folder given, the step closes itself and the build runs
  // through with no dialog at all
  await composeOnDisk();
  await evaluate(`(function () {
    function fileH(text, name) { return { kind: "file", getFile: function () {
      return Promise.resolve(new File([text], name, { type: "text/html" })); } }; }
    function dirH(entries) { return { kind: "directory",
      getDirectoryHandle: function (n) { return entries[n] && entries[n].kind === "directory"
        ? Promise.resolve(entries[n]) : Promise.reject(new DOMException("no " + n, "NotFoundError")); },
      getFileHandle: function (n) { return entries[n] && entries[n].kind === "file"
        ? Promise.resolve(entries[n]) : Promise.reject(new DOMException("no " + n, "NotFoundError")); } }; }
    window.__picked = 0;
    window.showDirectoryPicker = function () { window.__picked++; return Promise.resolve(dirH({
      "blog.html": fileH(${JSON.stringify(diskBlog)}, "blog.html"),
      "index.html": fileH(${JSON.stringify(diskHome)}, "index.html") })); };
    [...document.querySelectorAll('.bc-wizard .ced-modal__btns button')]
      .find(function (b) { return /repo folder/.test(b.textContent); }).click();
  })()`);
  await sleep(600);
  const throughD2 = await evaluate(`(function () {
    var box = document.querySelector('.bc-wizard');
    return { step: box && box.getAttribute('data-step'), picked: window.__picked,
             dialog: !!document.querySelector('.ced-handoff__zone'),
             arrowOn: !!document.querySelector('.ced-point.is-on') };
  })()`);
  const zipD2 = await capturePublish();
  const doneD2 = await waitDone();
  check("files step: the folder closes the step by itself and the build runs through with no dialog",
    throughD2.picked === 1 && throughD2.step === "progress" && !throughD2.dialog && !throughD2.arrowOn &&
    doneD2 && doneD2.step === "done" && doneD2.hand.length === 0 &&
    !!zipD2 && !!zipD2["blog/2607.html"] && !!zipD2["index.html"],
    JSON.stringify(throughD2) + " " + JSON.stringify(doneD2).slice(0, 160));
  check("files step: no page exception on the file page",
    exceptions.length === 0, exceptions.slice(0, 2).join(" | "));

  // ============ EDITING A PUBLISHED POST FROM DISK ============
  // A post's source lives in its month file, so opening one to edit means
  // reading that file. bcLoadPost used a raw fetch, which a page opened from
  // disk cannot do, and swallowed the failure into console.error: clicking
  // Edit did nothing at all, on screen or anywhere else.
  // the bundle directory, opened as a file: it holds a real published post
  // and the month file that carries its source, which the served copy of the
  // blog page does not
  await send("Page.navigate", { url: pathToFileURL(join(bdir, "blog.html")).href });
  await sleep(2400);
  await evaluate(`if (!AMH.tool.editorOn()) window.edit();`);
  await sleep(700);
  const editBtn = await evaluate(`(function () {
    var b = [...document.querySelectorAll('button,a')]
      .find(function (x) { return /Edit p0001/.test(x.textContent || ''); });
    if (!b) return 'no edit button';
    b.click();
    return 'clicked';
  })()`);
  await sleep(2200);
  const askedForIt = await evaluate(`({
    handOff: !!document.querySelector('.ced-handoff__zone'),
    head: (document.querySelector('.ced-handoff .ced-modal__head') || {}).textContent || '',
    composer: !!document.querySelector('.bc-write'),
    silent: !document.querySelector('.ced-handoff__zone') && !document.querySelector('.bc-wizard')
  })`);
  // The dialog must be asking for a MONTH file, because that is where the
  // post's source lives. Which month is not fixed: earlier lifecycle tests
  // backdate and move posts, so the file is read from the ask rather than
  // assumed.
  const wantMonth = (/(\d{4})\.html/.exec(askedForIt.head) || [])[1] || "";
  check("edit from disk: the post asks for its month file instead of failing in silence",
    editBtn === "clicked" && askedForIt.handOff === true && askedForIt.silent === false &&
    /^\d{4}$/.test(wantMonth),
    JSON.stringify({ editBtn, wantMonth, ...askedForIt }));
  // and the file, once handed over, opens the post in the composer
  if (askedForIt.handOff) {
    await dropInto(".ced-handoff__zone", wantMonth + ".html",
      readFileSync(join(bdir, "blog", wantMonth + ".html"), "utf8"));
    /* the file is read and the post extracted before the composer appears,
       so this waits for the composer rather than guessing at a delay */
    let opened = null;
    for (let i = 0; i < 25 && !(opened && opened.composer); i++) {
      await sleep(250);
      opened = await evaluate(`({
        composer: !!document.querySelector('.bc-write'),
        title: (document.querySelector('.bc-title') || {}).value || '',
        date: (document.querySelector('.bc-date') || {}).value || '',
        body: ((document.querySelector('.bc-write textarea') || {}).value || '').slice(0, 40),
        refused: (document.querySelector('.ced-handoff__note') || {}).textContent || ''
      })`);
    }
    check("edit from disk: the handed file opens the post with its own source",
      opened.composer && opened.date.slice(0, 4) === wantMonth && opened.body.length > 0,
      JSON.stringify({ wantMonth, ...opened }).slice(0, 220));
    await evaluate(`[...document.querySelectorAll('.bc-btns .ced-btn')].find(function (b) { return b.textContent === 'Close'; })?.click()`);
    await sleep(400);
  }
  // an id the manifest does not know says so on screen, rather than in the console
  await evaluate(`AMH.publish.edit('9999')`);
  await sleep(600);
  const unknownId = await evaluate(`({
    step: (document.querySelector('.bc-wizard') || {getAttribute(){return null}}).getAttribute('data-step'),
    text: ((document.querySelector('.bc-wizard .bc-wiz__body') || {}).textContent || '').slice(0, 80)
  })`);
  check("edit: an id the manifest does not know is reported on screen",
    unknownId.step === "failed" && /p9999/.test(unknownId.text),
    JSON.stringify(unknownId));
  await evaluate(`[...document.querySelectorAll('.bc-wizard .ced-modal__btns button')].find(function (b) { return b.textContent === 'Close'; })?.click()`);
  await sleep(300);

  const failed = results.filter((r) => !r.ok).length;
  console.log("\n" + (results.length - failed) + "/" + results.length + " checks passed" + (failed ? " - " + failed + " FAILED" : ""));
  process.exitCode = failed ? 1 : 0;
}

main().catch((e) => { console.error("TEST HARNESS ERROR:", e.message); process.exitCode = 2; })
  .finally(() => {
    try { ws?.close(); } catch {}
    try { chrome.kill(); } catch {}
    try { server.kill(); } catch {}
    process.exit(process.exitCode || 0);   // the open CDP socket otherwise keeps node alive
  });
