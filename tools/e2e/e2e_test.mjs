// End-to-end test of the built-in copy editor + blog engine via headless Chrome + CDP.
// Run:  node tools/e2e/e2e_test.mjs   (from anywhere; paths self-locate)
// Requires: node 22+ (native WebSocket/fetch), Chrome, py launcher (http.server).
// The harness starts its own local server and Chrome, and cleans both up.
import { spawn } from "node:child_process";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
const server = spawn("py", ["-3", "-m", "http.server", String(SERVER_PORT), "--bind", "127.0.0.1"],
  { cwd: REPO, stdio: "ignore" });
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
    "nav-about", "nav-contact", "blog-eyebrow", "blog-h2",
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
  "blog.html": ["site.js", "work.js", "blog.js", "tool.js", "publish.js"],
  "gallery.html": ["site.js", "work.js", "tool.js", "gallery.js"],
};

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
function exportIsByteExact(page, exported, editedSlugs) {
  const src = readFileSync(join(REPO, page), "utf-8");
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
  const wrongName = await evaluate(`(function () {
    window.__handoff = AMH.tool.handOff("index.html", new Error("fetch refused"));
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
    feed: !!document.getElementById('blogFeed'),
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
  check("blog page: the reading engine renders into it",
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
    blogUI.rows === 17 && blogUI.chips > 0, JSON.stringify(blogUI));

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
    feed: !!document.getElementById('blogFeed'),
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
    feed: !!document.getElementById('blogFeed'),
  })`);
  check("blog page with an empty manifest shows the no-posts note",
    degrade.feed && degrade.note.includes("No posts yet"), JSON.stringify(degrade));
  await sleep(1800);

  // BL2. composer opens; draft save/restore round-trip
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
  // The tab order: date, title, the three view tabs, the body, then the
  // buttons at the bottom. The twelve formatting buttons are not stops.
  const tabOrder = await evaluate(`(() => {
    const panel = document.querySelector('.bc-panel');
    const stops = [...panel.querySelectorAll('input, textarea, button')]
      .filter(el => el.tabIndex !== -1 && !el.disabled &&
                    (el.offsetWidth > 0 || el.offsetHeight > 0));
    const name = (el) => el.className.split(' ')[0] || el.tagName.toLowerCase();
    return {
      order: stops.map(name),
      tools: panel.querySelectorAll('.ced-tool').length,
      toolStops: [...panel.querySelectorAll('.ced-tool')]
        .filter(b => b.tabIndex !== -1).length,
      first: stops.length ? name(stops[0]) : "",
      focused: document.activeElement.className.split(' ')[0],
    };
  })()`);
  check("composer: the formatting toolbar is not in the tab order",
    tabOrder.tools === 12 && tabOrder.toolStops === 0,
    tabOrder.tools + " buttons, " + tabOrder.toolStops + " of them tab stops");
  // The close X is first, which is where a dialog usually puts it. After that
  // the order is the one the panel reads in, and the twelve toolbar buttons
  // that used to sit between the body and Publish are gone from it.
  check("composer: TAB runs close, date, title, the view tabs, the body, the buttons",
    tabOrder.order.join(" ") ===
      "ced-modal__x bc-date bc-title bc-tab bc-tab bc-tab textarea " +
      "ced-btn ced-btn ced-btn ced-btn",
    tabOrder.order.join(" "));

  // aria-modal promises the focus stays inside, so TAB has to wrap
  const trap = await evaluate(`(() => {
    const panel = document.querySelector('.bc-panel');
    const stops = [...panel.querySelectorAll('input, textarea, button')]
      .filter(el => el.tabIndex !== -1 && !el.disabled &&
                    (el.offsetWidth > 0 || el.offsetHeight > 0));
    const first = stops[0], last = stops[stops.length - 1];
    const press = (shift) => {
      const e = new KeyboardEvent('keydown',
        { key: 'Tab', shiftKey: shift, bubbles: true, cancelable: true });
      document.dispatchEvent(e);
      return e.defaultPrevented;
    };
    last.focus();
    const wrapped = press(false);
    const toFirst = document.activeElement === first;
    first.focus();
    const wrappedBack = press(true);
    const toLast = document.activeElement === last;
    return { modal: panel.getAttribute('aria-modal'), wrapped, toFirst,
             wrappedBack, toLast, stops: stops.length };
  })()`);
  check("composer: TAB off the last control returns to the first, not the page",
    trap.modal === "true" && trap.wrapped === true && trap.toFirst === true,
    JSON.stringify(trap));
  check("composer: shift and TAB off the first control returns to the last",
    trap.wrappedBack === true && trap.toLast === true, JSON.stringify(trap));

  await evaluate(`document.querySelector('.bc-title').value = 'Draft probe'`);
  await evaluate(`document.querySelector('.bc-write textarea').value = '<p>Draft body.</p>'`);
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
  })`);
  check("Save/Restore Draft round-trips", draft.title === "Draft probe" && draft.body === "<p>Draft body.</p>",
    JSON.stringify(draft));

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

  // BL4. publish: capture the zip via the patched anchor click
  await evaluate(ZIP_CAPTURE);
  await evaluate(`[...document.querySelectorAll('.bc-btns .ced-btn')].find(b => b.textContent === 'Publish').click()`);
  let zipB64 = null;
  for (let i = 0; i < 30 && !zipB64; i++) { await sleep(500); zipB64 = await evaluate(`window.__zipB64`); }
  const pubStatus = await evaluate(`document.querySelector('.bc-status').textContent`);
  check("publish produced a bundle", !!zipB64, pubStatus.slice(0, 80));

  let zipFiles = {};
  if (zipB64) {
    zipFiles = unzipStore(Buffer.from(zipB64, "base64"));
    const names = Object.keys(zipFiles).sort();
    check("bundle has the full publish layout", JSON.stringify(names) === JSON.stringify([
      "blog/260711_img0001.jpg", "blog/260711_img0002.png", "blog/2607.html",
      "imgsources/260711_img0001_original.png", "imgsources/260711_img0002_original.png",
      "blog.html", "index.html", "robots.txt", "sitemap.xml",
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
    const srcIdx = readFileSync(join(REPO, "blog.html"), "utf-8");
    const manSpan = outIdx.slice(outIdx.indexOf("<!--[edit:blog-manifest]-->"),
      outIdx.indexOf("<!--[/edit:blog-manifest]-->"));
    check("manifest spliced: counters + entry",
      manSpan.includes("next-post:0002") && manSpan.includes("next-img:0003") &&
      manSpan.includes("2607110001E2E first post"),
      manSpan.replace(/\s+/g, " ").slice(0, 120));
    check("bundle blog.html byte-identical outside the manifest",
      stripSpans(outIdx, ["blog-manifest"]) === stripSpans(srcIdx, ["blog-manifest"]));

    const month = zipFiles["blog/2607.html"].toString("utf8");
    const srcM = /<scr[i]pt type="text\/x-blog-source">\n([\s\S]*?)\n<\/scr[i]pt>/.exec(month);
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
    // The month page has its own smaller header: a standalone page with no
    // site nav. The one thing it shares with the site chrome is the wordmark,
    // which is editable copy, so it is read from the page rather than written
    // out here. A rename in the editor reaches every month file at rebuild.
    const brand = /class="brand__title full">([^<]*)</.exec(
      readFileSync(join(REPO, "index.html"), "utf-8"))[1];
    check("month page carries the site wordmark, not a copy of the words",
      month.includes('<a class="bm-head__brand" href="../index.html">' + brand + "</a>"),
      (/bm-head__brand[^>]*>([^<]*)</.exec(month) || [])[1] + " vs " + brand);
    check("month page links back to the blog page, brand still home",
      month.includes('href="../blog.html?b=2607"') && month.includes('href="../index.html"'),
      (/bm-head__stream" href="([^"]+)"/.exec(month) || [])[1]);
    check("published images are real files (jpg magic + png magic)",
      zipFiles["blog/260711_img0001.jpg"][0] === 0xFF && zipFiles["blog/260711_img0001.jpg"][1] === 0xD8 &&
      zipFiles["blog/260711_img0002.png"][1] === 0x50);
  }

  // BL5. serve the extracted bundle and read it like a visitor
  const { mkdirSync, writeFileSync, rmSync } = await import("node:fs");
  const bdir = mkdtempSync(join(tmpdir(), "blog-bundle-"));
  let bs = null;
  const B = "http://127.0.0.1:8124/";
  function writeBundle(files) {
    for (const [name, data] of Object.entries(files)) {
      mkdirSync(join(bdir, dirname(name)), { recursive: true });
      writeFileSync(join(bdir, name), data);
    }
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
    for (const f of ["site.css", "site.js", "work.js", "blog.js", "tool.js",
                     "publish.js", "index.html"]) {
      writeFileSync(join(bdir, f), readFileSync(join(REPO, f)));
    }
    bs = spawn("py", ["-3", "-m", "http.server", "8124", "--bind", "127.0.0.1"], { cwd: bdir, stdio: "ignore" });
    await sleep(1500);
    await send("Page.navigate", { url: "http://127.0.0.1:8124/blog.html" });
    await sleep(2200);
    check("bundle: the blog page renders its feed",
      await evaluate(`!!document.getElementById('blogFeed')`));
    await sleep(600);
    const stream = await evaluate(`({
      article: !!document.getElementById('p0001'),
      carousel: document.querySelector('#p0001 .gallery.is-ready')?.querySelectorAll('.gallery__stage img').length || 0,
      caption: document.querySelector('#p0001 .gallery__stage img')?.getAttribute('data-caption') || '',
      esc: (document.querySelector('#p0001 .blog-post__body')?.textContent || '').includes('</scr' + 'ipt>'),
    })`);
    check("bundle: stream renders the published post with a 2-image carousel",
      stream.article && stream.carousel === 2 && stream.caption === "Cap one" && stream.esc,
      JSON.stringify(stream));
    await send("Page.navigate", { url: "http://127.0.0.1:8124/blog.html?b=p0001" });
    await sleep(2200);
    check("bundle: ?b=p0001 deep link lands on the post",
      await evaluate(`!!document.getElementById('blogFeed') && !!document.getElementById('p0001')`));
    const postCanon = await evaluate(`document.querySelector('link[rel="canonical"]').getAttribute('href')`);
    check("bundle: a month in view makes the month file canonical",
      /\/blog\/2607\.html$/.test(postCanon), postCanon);

    await send("Page.navigate", { url: "http://127.0.0.1:8124/blog.html?b=2607" });
    await sleep(2200);
    const byMonth = await evaluate(`({
      post: !!document.getElementById('p0001'),
      on: (document.querySelector('.bs-months button.on') || {}).textContent || '',
      note: (document.querySelector('.bs-note') || {}).textContent || '',
    })`);
    check("bundle: ?b=2607 deep link lands on the month",
      byMonth.post && /July/.test(byMonth.on) && !byMonth.note, JSON.stringify(byMonth));

    await send("Page.navigate", { url: "http://127.0.0.1:8124/blog.html?b=p9999" });
    await sleep(2200);
    const unknown = await evaluate(`({
      note: (document.querySelector('.bs-note') || {}).textContent || '',
      post: !!document.getElementById('p0001'),
    })`);
    check("bundle: an unknown target says so and shows the latest",
      /wasn't found/.test(unknown.note) && unknown.post, JSON.stringify(unknown));
    await send("Page.navigate", { url: "http://127.0.0.1:8124/blog/2607.html" });
    await sleep(1800);
    const monthPage = await evaluate(`({
      cls: document.body.className,
      figs: document.querySelectorAll('figure.bp-fig').length,
      brand: !!document.querySelector('.bm-head__brand'),
    })`);
    check("bundle: standalone month page renders statically",
      monthPage.cls === "blog-month" && monthPage.figs === 2 && monthPage.brand,
      JSON.stringify(monthPage));
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
    await evaluate(`[...document.querySelectorAll('.bc-btns .ced-btn')].find(b => b.textContent === 'Publish').click()`);
    const zip2 = await capturePublish();
    check("P2: second post published into an earlier month", !!zip2 && !!zip2["blog/2606.html"],
      zip2 ? Object.keys(zip2).sort().join(", ") : "no zip");
    if (zip2) {
      const man2 = zip2["blog.html"].toString("utf8");
      check("P2: manifest entries date-sorted with permanent ids",
        man2.includes("2606100002June post|2607110001E2E first post") && man2.includes("next-post:0003"));
      writeBundle(zip2);
    }

    // P2-2. month cache: reopening the stream refetches nothing
    await send("Page.navigate", { url: B + "blog.html" });
    await sleep(2200);
    await evaluate(`
      window.__blogFetches = 0;
      const of = window.fetch;
      window.fetch = function (u) {
        if (String(u).indexOf('blog/') === 0) window.__blogFetches++;
        return of.apply(this, arguments);
      };`);
    await evaluate(`AMH.blog.show("", false)`);
    await sleep(1800);
    const nav2 = await evaluate(`({
      months: document.querySelectorAll('.bs-months button').length,
      posts: [...document.querySelectorAll('#blogFeed article.blog-post')].map(a => a.id),
      fetches: window.__blogFetches,
    })`);
    check("P2: jump nav lists both months; stream newest-first across months",
      nav2.months === 2 && JSON.stringify(nav2.posts) === '["p0001","p0002"]', JSON.stringify(nav2));
    // there is no close on a page; re-showing clears the feed and renders it
    // again, which is what has to come from the cache rather than the network
    await evaluate(`AMH.blog.show("2606", false)`);
    await sleep(900);
    await evaluate(`AMH.blog.show("", false)`);
    await sleep(1200);
    const again = await evaluate(`({
      fetches: window.__blogFetches,
      posts: [...document.querySelectorAll('#blogFeed article.blog-post')].map(a => a.id),
    })`);
    check("P2: re-showing the stream uses the month cache (no refetch)",
      again.fetches === nav2.fetches &&
      JSON.stringify(again.posts) === '["p0001","p0002"]',
      "fetches " + nav2.fetches + " -> " + again.fetches + " posts=" + again.posts.join(","));

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
    await evaluate(`[...document.querySelectorAll('.bc-btns .ced-btn')].find(b => b.textContent === 'Publish').click()`);
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
      check("P2: body republish leaves blog.html byte-identical (no manifest change)",
        zip3["blog.html"].equals(readFileSync(join(bdir, "blog.html"))));
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
    await evaluate(`[...document.querySelectorAll('.bc-btns .ced-btn')].find(b => b.textContent === 'Publish').click()`);
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
      months: document.querySelectorAll('.bs-months button').length,
      posts: [...document.querySelectorAll('#blogFeed article.blog-post')].map(a => a.id),
      title: document.querySelector('#p0001 header h2')?.textContent,
      editBtns: document.querySelectorAll('#blogFeed article header .bs-retry').length,
    })`);
    check("P2: post-move stream is one June month with both posts + edit buttons",
      after4.months === 1 && JSON.stringify(after4.posts) === '["p0002","p0001"]' &&
      after4.title === "Moved post" && after4.editBtns === 2, JSON.stringify(after4));

    // P2-6. delete a post (keeps the month, which still has p0001)
    await send("Page.navigate", { url: B + "blog.html" });
    await sleep(2200);
    await evaluate(ZIP_CAPTURE);
    await evaluate(`window.edit.blog.edit("0002")`);
    await sleep(1200);
    await evaluate(`[...document.querySelectorAll('.bc-btns .ced-btn')].find(b => b.textContent === 'Delete post').click()`);
    const zip5 = await capturePublish();
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
    const zip6 = await capturePublish();
    check("P2: rebuild ships all months + shared files, no blog.html",
      !!zip6 && !!zip6["blog/2606.html"] && !!zip6["sitemap.xml"] &&
      !!zip6["robots.txt"] && !zip6["blog.html"],
      zip6 ? Object.keys(zip6).sort().join(", ") : "no zip");
    if (zip6) {
      check("P2: rebuild is idempotent (matches the deployed month byte-for-byte)",
        zip6["blog/2606.html"].equals(readFileSync(join(bdir, "blog/2606.html"))));
    }

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
    await evaluate(`[...document.querySelectorAll('.bc-btns .ced-btn')].find(b => b.textContent === 'Publish').click()`);
    const zip7 = await capturePublish();
    check("P2: a deleted highlights region does not fail the publish",
      !!zip7 && !!zip7["blog/2606.html"] &&
      zip7["blog/2606.html"].toString("utf8").includes("Still published."),
      zip7 ? Object.keys(zip7).sort().join(", ") : "no zip");
    check("P2: and the home page is left out rather than written wrong",
      !!zip7 && !zip7["index.html"],
      zip7 && zip7["index.html"] ? "index.html was written anyway" : "left out");
  }
  try { bs?.kill(); } catch {}

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
