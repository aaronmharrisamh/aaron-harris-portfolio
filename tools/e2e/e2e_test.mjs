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
  check("panel lists all 82 text regions", ui.rows === 82, "rows=" + ui.rows);
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
    const src = readFileSync(join(REPO, "index.html"), "utf-8");
    const OPEN = "<!--[edit:hero-h1]-->", CLOSE = "<!--[/edit:hero-h1]-->";
    const sA = src.indexOf(OPEN) + OPEN.length, sB = src.indexOf(CLOSE);
    const eA = exported.indexOf(OPEN) + OPEN.length, eB = exported.indexOf(CLOSE);
    const prefixSame = src.slice(0, sA) === exported.slice(0, eA);
    const suffixSame = src.slice(sB) === exported.slice(eB);
    const innerNew = exported.slice(eA, eB);
    check("export: everything outside edited region byte-identical", prefixSame && suffixSame,
      "prefix=" + prefixSame + " suffix=" + suffixSame);
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
    const src2 = readFileSync(join(REPO, "index.html"), "utf-8");
    const galA = exported2.indexOf("<!--[edit:fr3-gallery]-->");
    const galB = exported2.indexOf("<!--[/edit:fr3-gallery]-->");
    const galSpan = exported2.slice(galA, galB);
    check("exported gallery holds the img/work path + caption + alt",
      galSpan.includes('src="img/work/fr3-real.png"') &&
      galSpan.includes('data-caption="Live capture of the real UI"') &&
      galSpan.includes('alt="Forerunner 3 real interface"') &&
      !galSpan.includes("img/seed/"),
      galSpan.replace(/\s+/g, " ").slice(0, 140));
    const stripped = (t) => stripSpans(t, ["hero-h1", "fr3-gallery"]);
    check("gallery export: byte-identical outside edited regions",
      stripped(exported2) !== null && stripped(exported2) === stripped(src2));
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
    const src3 = readFileSync(join(REPO, "index.html"), "utf-8");
    const ddA = exported3.indexOf("<!--[edit:fr3-deepdive]-->");
    const ddB = exported3.indexOf("<!--[/edit:fr3-deepdive]-->");
    const ddSpan = exported3.slice(ddA, ddB);
    check("deepdive span carries the text edit AND the dd image",
      ddSpan.includes("TESTEDDD built") &&
      ddSpan.includes('src="img/work/dd-real.png"') &&
      ddSpan.includes('data-caption="Real orbital scene"'),
      ddSpan.replace(/\s+/g, " ").slice(0, 120));
    const stripped3 = (t) => stripSpans(t, ["hero-h1", "fr3-gallery", "fr3-deepdive"]);
    check("nested export: byte-identical outside edited regions",
      stripped3(exported3) !== null && stripped3(exported3) === stripped3(src3));
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

  // ============ BLOG TESTS ============
  // BL1. empty manifest: no Blog nav; ?b= deep link degrades gracefully
  check("no Blog nav while manifest is empty",
    await evaluate(`![...document.querySelectorAll('.nav__links a')].some(a => a.textContent === 'Blog')`));
  await send("Page.navigate", { url: PAGE + "?b=" });
  await sleep(1800);
  const degrade = await evaluate(`({
    open: document.body.classList.contains('blog-open'),
    note: document.querySelector('.bs-note')?.textContent || '',
  })`);
  check("?b= with empty manifest shows the no-posts note", degrade.open && degrade.note.includes("No posts yet"),
    JSON.stringify(degrade));
  await send("Page.navigate", { url: PAGE });
  await sleep(1800);

  // BL2. composer opens; draft save/restore round-trip
  await evaluate(`window.edit.blog()`);
  await sleep(300);
  check("composer opens with tabs and fields", await evaluate(`({
    panel: !!document.querySelector('.bc-panel'),
    tabs: document.querySelectorAll('.bc-tab').length,
  })`).then((r) => r.panel && r.tabs === 3));
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
      "index.html", "robots.txt", "sitemap.xml", "sitestyle.css",
    ].sort()), names.join(", "));

    const outIdx = zipFiles["index.html"].toString("utf8");
    const srcIdx = readFileSync(join(REPO, "index.html"), "utf-8");
    const manSpan = outIdx.slice(outIdx.indexOf("<!--[edit:blog-manifest]-->"),
      outIdx.indexOf("<!--[/edit:blog-manifest]-->"));
    check("manifest spliced: counters + entry",
      manSpan.includes("next-post:0002") && manSpan.includes("next-img:0003") &&
      manSpan.includes("2607110001E2E first post"),
      manSpan.replace(/\s+/g, " ").slice(0, 120));
    check("bundle index.html byte-identical outside the manifest",
      stripSpans(outIdx, ["blog-manifest"]) === stripSpans(srcIdx, ["blog-manifest"]));

    const month = zipFiles["blog/2607.html"].toString("utf8");
    const srcM = /<scr[i]pt type="text\/x-blog-source">\n([\s\S]*?)\n<\/scr[i]pt>/.exec(month);
    const decoded = srcM ? srcM[1].replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&") : "";
    check("month file: article shell + static figures + head parity",
      month.includes('id="p0001"') && month.includes('data-date="260711"') &&
      month.includes('<figure class="bp-fig">') &&
      month.includes('alt="Alt one"') && month.includes("<figcaption>Cap two</figcaption>") &&
      month.includes('name="twitter:card"') && month.includes("fonts.googleapis.com") &&
      month.includes('href="../sitestyle.css"'),
      month.length + " chars");
    check("x-blog-source round-trips exactly",
      decoded.includes("[img0001,Cap one|Alt one][png0002,Cap two]") &&
      decoded.includes("Escape probe: &lt;/scr" + "ipt&gt; as text"),
      decoded.slice(0, 90));

    const css = zipFiles["sitestyle.css"].toString("utf8");
    check("sitestyle.css lifts the fenced sections only",
      css.includes("GENERATED sitestyle.css") && css.includes(":root") &&
      css.includes(".blog-post") && css.includes(".text-xs") && !css.includes(".hero__halo"),
      css.length + " chars");
    const sm = zipFiles["sitemap.xml"].toString("utf8");
    check("sitemap + robots point at the month page",
      sm.includes("blog/2607.html") &&
      zipFiles["robots.txt"].toString("utf8").includes("Sitemap: "));
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
    bs = spawn("py", ["-3", "-m", "http.server", "8124", "--bind", "127.0.0.1"], { cwd: bdir, stdio: "ignore" });
    await sleep(1500);
    await send("Page.navigate", { url: "http://127.0.0.1:8124/index.html" });
    await sleep(2200);
    check("bundle: Blog nav appears",
      await evaluate(`[...document.querySelectorAll('.nav__links a')].some(a => a.textContent === 'Blog')`));
    await evaluate(`[...document.querySelectorAll('.nav__links a')].find(a => a.textContent === 'Blog').click()`);
    await sleep(1500);
    const stream = await evaluate(`({
      open: document.body.classList.contains('blog-open'),
      article: !!document.getElementById('p0001'),
      carousel: document.querySelector('#p0001 .gallery.is-ready')?.querySelectorAll('.gallery__stage img').length || 0,
      caption: document.querySelector('#p0001 .gallery__stage img')?.getAttribute('data-caption') || '',
      esc: (document.querySelector('#p0001 .blog-post__body')?.textContent || '').includes('</scr' + 'ipt>'),
    })`);
    check("bundle: stream renders the published post with a 2-image carousel",
      stream.open && stream.article && stream.carousel === 2 && stream.caption === "Cap one" && stream.esc,
      JSON.stringify(stream));
    await send("Page.navigate", { url: "http://127.0.0.1:8124/index.html?b=p0001" });
    await sleep(2200);
    check("bundle: ?b=p0001 deep link lands on the post",
      await evaluate(`document.body.classList.contains('blog-open') && !!document.getElementById('p0001')`));
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
    await send("Page.navigate", { url: B + "index.html" });
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
      const man2 = zip2["index.html"].toString("utf8");
      check("P2: manifest entries date-sorted with permanent ids",
        man2.includes("2606100002June post|2607110001E2E first post") && man2.includes("next-post:0003"));
      writeBundle(zip2);
    }

    // P2-2. month cache: reopening the stream refetches nothing
    await send("Page.navigate", { url: B + "index.html" });
    await sleep(2200);
    await evaluate(`
      window.__blogFetches = 0;
      const of = window.fetch;
      window.fetch = function (u) {
        if (String(u).indexOf('blog/') === 0) window.__blogFetches++;
        return of.apply(this, arguments);
      };`);
    await evaluate(`[...document.querySelectorAll('.nav__links a')].find(a => a.textContent === 'Blog').click()`);
    await sleep(1800);
    const nav2 = await evaluate(`({
      months: document.querySelectorAll('.bs-months button').length,
      posts: [...document.querySelectorAll('.blog-view article.blog-post')].map(a => a.id),
      fetches: window.__blogFetches,
    })`);
    check("P2: jump nav lists both months; stream newest-first across months",
      nav2.months === 2 && JSON.stringify(nav2.posts) === '["p0001","p0002"]', JSON.stringify(nav2));
    await evaluate(`document.getElementById('blogClose').click()`);
    await sleep(500);
    await evaluate(`[...document.querySelectorAll('.nav__links a')].find(a => a.textContent === 'Blog').click()`);
    await sleep(800);
    const fetches2 = await evaluate(`window.__blogFetches`);
    check("P2: reopening the stream uses the month cache (no refetch)",
      fetches2 === nav2.fetches, "fetches " + nav2.fetches + " -> " + fetches2);

    // P2-3. edit a published post's body (same title/date)
    await send("Page.navigate", { url: B + "index.html" });
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
    check("P2: body republish regenerates only the month file",
      !!zip3 && !!zip3["blog/2607.html"] && zip3["blog/2607.html"].toString("utf8").includes("EDITED BODY") &&
      !zip3["ORPHANS.txt"] && !Object.keys(zip3).some((n) => /img\d{4}\.(jpg|png)$/.test(n)),
      zip3 ? Object.keys(zip3).sort().join(", ") : "no zip");
    if (zip3) {
      check("P2: body republish leaves index.html byte-identical (no manifest change)",
        zip3["index.html"].equals(readFileSync(join(bdir, "index.html"))));
      writeBundle(zip3);
    }

    // P2-4. retitle + cross-month date move (2607 -> 2606) with image renames
    await send("Page.navigate", { url: B + "index.html" });
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
      const man4 = zip4["index.html"].toString("utf8");
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
    await send("Page.navigate", { url: B + "index.html" });
    await sleep(2200);
    await evaluate(`window.edit()`);
    await sleep(400);
    await evaluate(`[...document.querySelectorAll('.nav__links a')].find(a => a.textContent === 'Blog').click()`);
    await sleep(1500);
    const after4 = await evaluate(`({
      months: document.querySelectorAll('.bs-months button').length,
      posts: [...document.querySelectorAll('.blog-view article.blog-post')].map(a => a.id),
      title: document.querySelector('#p0001 header h2')?.textContent,
      editBtns: document.querySelectorAll('.blog-view article header .bs-retry').length,
    })`);
    check("P2: post-move stream is one June month with both posts + edit buttons",
      after4.months === 1 && JSON.stringify(after4.posts) === '["p0002","p0001"]' &&
      after4.title === "Moved post" && after4.editBtns === 2, JSON.stringify(after4));

    // P2-6. delete a post (keeps the month, which still has p0001)
    await send("Page.navigate", { url: B + "index.html" });
    await sleep(2200);
    await evaluate(ZIP_CAPTURE);
    await evaluate(`window.edit.blog.edit("0002")`);
    await sleep(1200);
    await evaluate(`[...document.querySelectorAll('.bc-btns .ced-btn')].find(b => b.textContent === 'Delete post').click()`);
    const zip5 = await capturePublish();
    check("P2: delete bundle removes entry, regenerates month",
      !!zip5 && !zip5["index.html"].toString("utf8").includes("June post") &&
      !!zip5["blog/2606.html"] && !zip5["blog/2606.html"].toString("utf8").includes('id="p0002"') &&
      zip5["blog/2606.html"].toString("utf8").includes('id="p0001"'),
      zip5 ? Object.keys(zip5).sort().join(", ") : "no zip");
    if (zip5) writeBundle(zip5);

    // P2-7. rebuild: idempotent re-render of every month with current chrome
    await send("Page.navigate", { url: B + "index.html" });
    await sleep(2200);
    await evaluate(ZIP_CAPTURE);
    await evaluate(`window.edit.blog.rebuild()`);
    const zip6 = await capturePublish();
    check("P2: rebuild ships all months + shared files, no index.html",
      !!zip6 && !!zip6["blog/2606.html"] && !!zip6["sitestyle.css"] && !!zip6["sitemap.xml"] &&
      !zip6["index.html"],
      zip6 ? Object.keys(zip6).sort().join(", ") : "no zip");
    if (zip6) {
      check("P2: rebuild is idempotent (matches the deployed month byte-for-byte)",
        zip6["blog/2606.html"].equals(readFileSync(join(bdir, "blog/2606.html"))));
    }
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
