// ============================================================
// tools/e2e/media_matrix.mjs - what each installed browser does with the
// suite's media files.
//
//   node tools/e2e/media_matrix.mjs
//
// It serves the repo, opens blog.html in each browser it finds, and for
// every file in tools/e2e/fixtures/media reads three facts: whether the
// browser says it can play the type, what the image engine's intake makes
// of the file, and whether a muted player really plays it (its time moves).
// Last it meets each browser's own autoplay rule with no gesture: a muted
// video, and a video with sound at volume 0, so no sound is heard. A
// browser may count volume 0 as silent and start that one too, so the
// second line is not proof of what the browser does with a sound a
// person can hear: that needs a normal session with speakers.
//
// Chrome and Edge are driven through the DevTools protocol, and Firefox
// through WebDriver BiDi. A browser that is not installed is named as not
// run. Nothing here is part of the gate: it is a report for a person, to
// record which browsers were seen doing what, on which machine.
//
// Needs node 22+ (WebSocket and fetch) and the py launcher (http.server).
// ============================================================
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir, release, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ============ SETUP ============

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORT = 8131;
const PAGE = `http://127.0.0.1:${PORT}/blog.html?matrix=1`;
const MANIFEST = JSON.parse(readFileSync(join(REPO, "tools", "e2e", "fixtures", "media", "manifest.json"), "utf8"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* The browsers this report looks for, in the places Windows installs them. */
const BROWSERS = [
  { name: "Chrome", kind: "cdp", port: 9241, paths: ["c:/Program Files/Google/Chrome/Application/chrome.exe"] },
  { name: "Edge", kind: "cdp", port: 9242, paths: ["c:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "c:/Program Files/Microsoft/Edge/Application/msedge.exe"] },
  { name: "Firefox", kind: "bidi", port: 9243, paths: ["c:/Program Files/Mozilla Firefox/firefox.exe",
    "c:/Program Files (x86)/Mozilla Firefox/firefox.exe"] }
];

/* Each file's kind and its type, for canPlayType. */
const TYPES = {
  "clip.mp4": ["video", 'video/mp4; codecs="avc1.42E01E, mp4a.40.2"'], "square.mp4": ["video", 'video/mp4; codecs="avc1.42E01E"'],
  "tall.webm": ["video", 'video/webm; codecs="vp8"'], "silent.webm": ["video", 'video/webm; codecs="vp8"'],
  "sound.webm": ["video", 'video/webm; codecs="vp8, opus"'], "voice.weba": ["audio", 'audio/webm; codecs="opus"'],
  "tone.mp4": ["audio", 'audio/mp4; codecs="mp4a.40.2"'], "tone.webm": ["audio", 'audio/webm; codecs="opus"'],
  "tone.mp3": ["audio", "audio/mpeg"], "tone.wav": ["audio", 'audio/wav; codecs="1"'], "tone.ogg": ["audio", 'audio/ogg; codecs="vorbis"'],
  "theora.ogg": ["video", 'video/ogg; codecs="theora"'], "oldcodec.mp4": ["video", 'video/mp4; codecs="mp4v.20.8"'],
  "song.mid": ["midi", "audio/midi"], "song.midi": ["midi", "audio/midi"]
};

/* What runs in each browser's page. It returns one string of JSON, so the
   two protocols hand back the same thing. */
const PROBE = `(async function () {
  var files = ${JSON.stringify(MANIFEST.files.map((f) => ({ name: f.name, kind: TYPES[f.name][0], type: TYPES[f.name][1] })))};
  var wait = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  for (var i = 0; i < 100 && !(window.AMH && AMH.images && AMH.images.intakeMedia); i++) await wait(100);
  var out = { ua: navigator.userAgent, rows: [] };
  for (var k = 0; k < files.length; k++) {
    var f = files[k], row = { name: f.name };
    var blob = await (await fetch('tools/e2e/fixtures/media/' + f.name)).blob();
    var el = document.createElement(f.kind === 'video' ? 'video' : 'audio');
    row.can = f.kind === 'midi' ? '-' : (el.canPlayType(f.type) || 'no');
    try {
      var ph = await AMH.images.intakeMedia(new File([blob], f.name), { name: function () { return 'x/x'; }, chooseKind: function () { return 'video'; } });
      row.taken = ph ? ph.kind + (ph.kind !== 'midi' && !ph.playable ? ', cannot play' : '') : 'let go';
    } catch (e) { row.taken = 'refused'; }
    if (f.kind === 'midi') { row.plays = '-'; out.rows.push(row); continue; }
    el.muted = true;
    el.src = URL.createObjectURL(blob);
    document.body.appendChild(el);
    try { await el.play(); await wait(700); row.plays = el.currentTime > 0.1 ? 'plays' : 'stuck'; }
    catch (e) { row.plays = e.name; }
    el.pause(); el.remove();
    out.rows.push(row);
  }
  var tryPlay = function (name, muted) {
    var v = document.createElement('video');
    v.src = 'tools/e2e/fixtures/media/' + name; v.muted = muted; v.volume = 0;
    document.body.appendChild(v);
    return v.play().then(function () { v.pause(); v.remove(); return 'starts'; },
      function (e) { v.remove(); return 'refused (' + e.name + ')'; });
  };
  out.mutedAutoplay = await tryPlay('silent.webm', true);
  out.soundAutoplay = await tryPlay('sound.webm', false);
  return JSON.stringify(out);
})()`;

// ============ THE TWO PROTOCOLS ============

/* A JSON-RPC link over a WebSocket: send() resolves the answer to its id. */
function link(url) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(url);
    const waits = new Map();
    let id = 0;
    ws.onopen = () => res({
      ws,
      send(method, params = {}) {
        const n = ++id;
        return new Promise((ok) => { waits.set(n, ok); ws.send(JSON.stringify({ id: n, method, params })); });
      }
    });
    ws.onerror = (e) => rej(new Error("no connection to " + url));
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id && waits.has(m.id)) { waits.get(m.id)(m); waits.delete(m.id); }
    };
  });
}

async function viaCdp(b, exe) {
  const profile = mkdtempSync(join(tmpdir(), "media-matrix-"));
  const proc = spawn(exe, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
    "--remote-debugging-port=" + b.port, "--user-data-dir=" + profile, PAGE], { stdio: "ignore" });
  try {
    let target = null;
    for (let i = 0; i < 60 && !target; i++) {
      await sleep(300);
      try {
        const list = await (await fetch(`http://127.0.0.1:${b.port}/json/list`)).json();
        target = list.find((t) => t.type === "page" && t.url.indexOf(PAGE) === 0) || null;
      } catch {}
    }
    if (!target) throw new Error("no page");
    const c = await link(target.webSocketDebuggerUrl);
    const version = await (async () => {
      try { const v = await (await fetch(`http://127.0.0.1:${b.port}/json/version`)).json(); return v.Browser; } catch { return ""; }
    })();
    await sleep(1500);
    const r = await c.send("Runtime.evaluate", { expression: PROBE, awaitPromise: true, returnByValue: true });
    c.ws.close();
    if (r.result && r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.text);
    return { version, ...JSON.parse(r.result.result.value) };
  } finally {
    /* Browser.close ends every process of the browser. On Windows, kill()
       alone left Chrome and Edge running, with the debugging port open. */
    try {
      const v = await (await fetch(`http://127.0.0.1:${b.port}/json/version`)).json();
      const top = await link(v.webSocketDebuggerUrl);
      top.send("Browser.close");
      await sleep(800);
      top.ws.close();
    } catch {}
    try { proc.kill(); } catch {}
    await sleep(500);
    try { rmSync(profile, { recursive: true, force: true }); } catch {}
  }
}

async function viaBidi(b, exe) {
  const profile = mkdtempSync(join(tmpdir(), "media-matrix-ff-"));
  const proc = spawn(exe, ["--headless", "--no-remote", "--profile", profile, "--remote-debugging-port=" + b.port], { stdio: "ignore" });
  try {
    let c = null;
    for (let i = 0; i < 60 && !c; i++) {
      await sleep(400);
      try { c = await link(`ws://127.0.0.1:${b.port}/session`); } catch {}
    }
    if (!c) throw new Error("no BiDi session");
    const s = await c.send("session.new", { capabilities: {} });
    const version = s.result && s.result.capabilities ? "Firefox " + s.result.capabilities.browserVersion : "";
    const tree = await c.send("browsingContext.getTree", {});
    const context = tree.result.contexts[0].context;
    await c.send("browsingContext.navigate", { context, url: PAGE, wait: "complete" });
    await sleep(1500);
    const r = await c.send("script.evaluate", { expression: PROBE, target: { context }, awaitPromise: true, resultOwnership: "none" });
    try { await c.send("session.end", {}); } catch {}
    c.ws.close();
    if (!r.result || r.result.type !== "success") throw new Error(JSON.stringify(r.result || r.error).slice(0, 200));
    return { version, ...JSON.parse(r.result.result.value) };
  } finally {
    try { proc.kill(); } catch {}
    await sleep(800);
    try { rmSync(profile, { recursive: true, force: true }); } catch {}
  }
}

// ============ THE REPORT ============

const server = spawn("py", ["-3", "-m", "http.server", String(PORT), "--bind", "127.0.0.1"], { cwd: REPO, stdio: "ignore" });
await sleep(1500);
const seen = [];
try {
  for (const b of BROWSERS) {
    const exe = b.paths.find((p) => existsSync(p));
    if (!exe) { seen.push({ name: b.name, missing: true }); continue; }
    try {
      const got = await Promise.race([b.kind === "cdp" ? viaCdp(b, exe) : viaBidi(b, exe),
        sleep(120000).then(() => { throw new Error("timed out"); })]);
      seen.push({ name: b.name, ...got });
    } catch (e) {
      seen.push({ name: b.name, error: e.message });
    }
  }
} finally {
  try { server.kill(); } catch {}
}

/* The run's date by this machine's clock. toISOString gives the UTC date,
   which is the next day for an evening run west of Greenwich. */
const now = new Date();
const runDay = now.getFullYear() + "-" + String(now.getMonth() + 1).padStart(2, "0") + "-" + String(now.getDate()).padStart(2, "0");
console.log("# Media files in each browser\n");
console.log("Machine: " + platform() + " " + release() + ". Run: " + runDay + ".\n");
for (const s of seen) {
  if (s.missing) { console.log("## " + s.name + "\n\nNot installed, so not run.\n"); continue; }
  if (s.error) { console.log("## " + s.name + "\n\nNot run: " + s.error + "\n"); continue; }
  console.log("## " + (s.version || s.name) + "\n");
  console.log("| File | canPlayType | The engine takes it as | A muted player |");
  console.log("|---|---|---|---|");
  for (const r of s.rows) console.log(`| \`${r.name}\` | ${r.can} | ${r.taken} | ${r.plays} |`);
  console.log("\nWith no gesture: a muted video " + s.mutedAutoplay + "; a video with sound at volume 0 " + s.soundAutoplay +
    " (a browser may count volume 0 as silent).\n");
}
