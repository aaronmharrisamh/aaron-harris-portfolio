/* ============================================================
   publish.js - the blog composer and the publish bundle writer.

   Loads on blog.html only, and after tool.js, because it is an
   extension of the copy editor rather than a page of its own. The
   manifest and the reading engine are both on that page, and a
   publish needs all three.

   Write a post, drop images, publish -> one zip bundle:
   blog.html (manifest spliced) + blog/YYMM.html + sitemap.xml +
   robots.txt + the images + the originals under imgsources/.
   Month pages link site.css from the repo, so no stylesheet is
   generated.

   Seven sections:
     1. HEADER AND SETUP         5. GENERATORS
     2. CONSTANTS AND STATE      6. BUNDLE AND PUBLISH
     3. IMAGE INTAKE             7. LIFECYCLE AND API
     4. COMPOSER UI

   This file uses two surfaces and publishes one.

     AMH.tool   the editor kit: the splice, the pristine fetch, the
                zip writer, the toolbar, and the styles. tool.js owns
                every one of them, and this file changes none.
     AMH.blog   the reading engine: the manifest, the body renderer,
                and the source codec. blog.js owns them.
     AMH.publish  what window.edit.blog() calls. tool.js keeps the
                console surface, so the names people type never move
                when a file does.
   ============================================================ */
/* ==========================================================
   1. HEADER AND SETUP
   ----------------------------------------------------------
   One composer per page load, the same rule the editor uses. A second
   load is a no-op rather than a second panel over the first.
   ========================================================== */
(function () {
  "use strict";
  var AMH = window.AMH = window.AMH || {};
  if (AMH.publish) return;
  var doc = document;

  /* The editor kit. tool.js publishes it at load, and it loads first, so
     reading it once here is safe and saves a lookup at every call site. */
  var TOOL = AMH.tool;
  if (!TOOL) {
    console.warn("[blog] publish.js needs tool.js, which did not load.");
    return;
  }

  /* ==========================================================
     2. CONSTANTS AND STATE
     ----------------------------------------------------------
     The draft key is permanent. Renaming it throws away a post someone has
     already written.

     One composer per page load. The state below is that composer: what is on
     screen, which images are staged, and what the manifest said when the
     panel opened. The manifest check at publish time compares against that
     opening value, because a stale page would splice a stale manifest.
     ========================================================== */
  var BC_DRAFT_KEY = "amh-blog-draft";

  /* The home page highlights block: which page carries it, which region, and
     how many posts it lists. The count is a constant rather than a number
     buried in the renderer, because it is the one thing about this block
     anyone is likely to want to change. */
  var HL_PAGE = "index.html";
  var HL_SLUG = "blog-highlights";
  var HL_COUNT = 4;
  var bcPanel = null, bcScrim = null, bcBody = null, bcDate = null, bcTitle = null;
  var bcTime = null, bcZone = null, bcTags = null, bcCountsEl = null;
  var bcTagMenu = null, bcTagsKnown = null;   /* the blog's tags, with counts */
  var bcDrop = null, bcCloseBtn = null;
  var bcStatus = null, bcCards = null, bcPreviewEl = null;
  var bcImages = [];            /* {num, fmt, caption, alt, blob, previewURL, origBlob, origName, w, h} */
  var bcManAtOpen = null;       /* manifest payload string at composer open (staleness check) */
  var bcImgCounter = 0;         /* session-local offset over manifest next-img */
  var bcPublished = false;
  var bcIntakeChain = Promise.resolve();   /* serializes drops: numbers follow drop order */
  var bcEditing = null;         /* null = new post; else {id, date0, title0, source0, format0, time, zone, tags} */
  var bcMode = "md";            /* "md" for a new post; "html" for a post written in HTML */
  var bcOrphans = [];           /* server files this session's edits made unreferenced */
  var bcDeleteBtn = null;
  /* sticky until reload: after ANY bundle is built, the deployed site no
     longer matches what a further operation would splice against */

  /* The publish wizard's keys and timings. The localStorage key is a
     preference and survives. The two sessionStorage keys belong to one tab
     and one publish, which is the same life as a pending edit. */
  var NOREMIND_KEY = "amh-publish-noremind";  /* "1": the reminder step proceeds on its own */
  var PUBLISH_KEY = "amh-publish-pending";    /* the last bundle, until the site shows it */
  /* The least time a progress row stays current. On the live site the work
     takes a few milliseconds, and a list that ticks faster than the eye can
     read explains nothing. */
  var STEP_MS = 350;
  /* How long the "proceeding" notice stays when the reminder is switched
     off. Long enough to read, and long enough to press Cancel. */
  var NOTICE_MS = 1600;
  var bcWiz = null;             /* the wizard while it is on screen */
  var bcProg = null;            /* the progress step, while a bundle is built */
  var bcPublishBtn = null;

  function pad4(n) { return ("000" + n).slice(-4); }
  function pushOrphan(f) { if (bcOrphans.indexOf(f) === -1) bcOrphans.push(f); }
  function bcDirty() {
    if (!bcPanel || !bcPanel.parentNode || bcPublished) return false;
    return !!(bcTitle.value.trim() || bcBody.value.trim() || bcImages.length);
  }

  /* manifest parsing straight from a source string (the DOM parser in the
     page script reads the live tag; publish must read the PRISTINE source).

     The lines: next-post and next-img are the counters; stamp names the
     publish that wrote the manifest; month:YYMM=stamp names the publish
     that last wrote that month file; months: is the month list a month
     page states outright, having no entries of its own; every other line
     is entries. A line that matches nothing is reported and skipped.
     blog.js reads the same shape from the live tag, and the two must
     agree line for line. */
  function bcManifestFrom(srcText) {
    var m = /<script id="blogManifest"[^>]*>([\s\S]*?)<\/script>/.exec(srcText);
    var out = { nextPost: 1, nextImg: 1, entries: [], stamp: "", monthStamps: {},
                months: [], payload: m ? m[1] : "" };
    if (!m) return out;
    m[1].split("\n").map(function (l) { return l.trim(); }).forEach(function (l) {
      if (!l) return;
      if (l.indexOf("next-post:") === 0) out.nextPost = parseInt(l.slice(10), 10) || 1;
      else if (l.indexOf("next-img:") === 0) out.nextImg = parseInt(l.slice(9), 10) || 1;
      else if (l.indexOf("stamp:") === 0) out.stamp = l.slice(6).trim();
      else if (l.indexOf("months:") === 0) out.months = l.slice(7).split(/\s+/).filter(Boolean);
      else if (/^month:\d{4}=/.test(l)) out.monthStamps[l.slice(6, 10)] = l.slice(11).trim();
      else {
        l.split("|").forEach(function (e) {
          var em = /^(\d{6})(\d{4})(.*)$/.exec(e);
          if (em) out.entries.push({ date: em[1], id: em[2], title: em[3] });
          else console.warn("[blog] manifest line not understood, skipped: " + e);
        });
      }
    });
    return out;
  }
  /* stamps is {publish, months}. With none given the payload has the shape
     from before V044, which is what the empty page carries. */
  function bcManifestPayload(nextPost, nextImg, entries, stamps) {
    var line = entries.map(function (e) { return e.date + e.id + e.title; }).join("|");
    var head = "\nnext-post:" + pad4(nextPost) + "\nnext-img:" + pad4(nextImg);
    if (stamps) {
      if (stamps.publish) head += "\nstamp:" + stamps.publish;
      Object.keys(stamps.months).sort().forEach(function (mo) {
        head += "\nmonth:" + mo + "=" + stamps.months[mo];
      });
    }
    return head + (line ? "\n" + line : "") + "\n";
  }
  /* The stamps a manifest write carries, and the payload that carries them.

     touched maps a month to the stamp of the file this bundle writes for
     it. A month the bundle does not touch keeps the line it has, so a
     hand-off can still check that month's file. A month with no posts left
     loses its line, because its file is an orphan now.

     The publish stamp is the hash of the payload without its own stamp
     line, joined to the previous stamp, so each publish names the one
     before it. A stamp equal to the previous one is rehashed with a counter
     until it differs: the live check tells pending from live by the two
     being different. */
  function bcStamps(man, nextPost, nextImg, entries, touched) {
    var months = {};
    var has = {};
    entries.forEach(function (e) { has[e.date.slice(0, 4)] = true; });
    Object.keys(man.monthStamps).forEach(function (mo) {
      if (has[mo]) months[mo] = man.monthStamps[mo];
    });
    Object.keys(touched).forEach(function (mo) { months[mo] = touched[mo]; });
    var bare = bcManifestPayload(nextPost, nextImg, entries, { publish: "", months: months });
    var publish = TOOL.stamp(man.stamp + "\n" + bare);
    for (var n = 1; publish === man.stamp; n++) {
      publish = TOOL.stamp(man.stamp + "\n" + bare + "\n" + n);
    }
    return { publish: publish, months: months,
             payload: bcManifestPayload(nextPost, nextImg, entries,
                                        { publish: publish, months: months }) };
  }

  /* ==========================================================
     3. IMAGE INTAKE
     ----------------------------------------------------------
     A dropped file is decoded, re-encoded at a publish size, and given a
     four-digit number. The number is permanent: it is the name of the file
     the bundle ships and the number the body tag refers to.
     ========================================================== */
  var BC_TYPES = { "image/jpeg": 1, "image/png": 1, "image/webp": 1 };
  function bcEncode(bitmap, fmt) {
    var scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
    var w = Math.max(1, Math.round(bitmap.width * scale));
    var h = Math.max(1, Math.round(bitmap.height * scale));
    var cv = doc.createElement("canvas");
    cv.width = w; cv.height = h;
    var cx = cv.getContext("2d");
    if (fmt === "jpg") { cx.fillStyle = "#16181d"; cx.fillRect(0, 0, w, h); }  /* flatten alpha */
    cx.drawImage(bitmap, 0, 0, w, h);
    return new Promise(function (resolve, reject) {
      cv.toBlob(function (b) {
        if (b) resolve({ blob: b, w: w, h: h });
        else reject(new Error("encode failed"));
      }, fmt === "png" ? "image/png" : "image/jpeg", 0.85);
    });
  }
  function bcDecode(file) {
    if (window.createImageBitmap) {
      return createImageBitmap(file, { imageOrientation: "from-image" })
        .catch(function () { return createImageBitmap(file); });
    }
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var im = new Image();
      im.onload = function () { URL.revokeObjectURL(url); resolve(im); };
      im.onerror = function () { URL.revokeObjectURL(url); reject(new Error("decode failed")); };
      im.src = url;
    });
  }
  function bcIntake(file) {
    if (!BC_TYPES[file.type]) return Promise.reject(new Error("unsupported type " + (file.type || "?") + " (jpg/png/webp only; gif would lose animation)"));
    if (file.size > 40 * 1024 * 1024) return Promise.reject(new Error("over 40 MB"));
    return bcDecode(file).then(function (bmp) {
      if (Math.max(bmp.width, bmp.height) > 12000) throw new Error("over 12000px on a side");
      var man = AMH.blog ? AMH.blog.parseManifest() : { nextImg: 1 };
      var im = {
        num: pad4(man.nextImg + bcImgCounter++),
        fmt: "jpg", caption: "", alt: TOOL.imageRegion.humanize(file.name),
        blob: null, previewURL: "", origBlob: file, origName: file.name,
        w: 0, h: 0, bmp: bmp
      };
      return bcEncode(bmp, "jpg").then(function (r) {
        im.blob = r.blob; im.w = r.w; im.h = r.h;
        im.previewURL = URL.createObjectURL(r.blob);
        bcImages.push(im);
        return im;
      });
    });
  }
  function bcToggleFmt(im, card) {
    var to = im.fmt === "jpg" ? "png" : "jpg";
    bcEncode(im.bmp, to).then(function (r) {
      if (im.previewURL) URL.revokeObjectURL(im.previewURL);
      im.fmt = to; im.blob = r.blob;
      im.previewURL = URL.createObjectURL(r.blob);
      /* swap only the tag PREFIX - the caption|alt the author typed in the
         tag is theirs and must survive a format toggle untouched */
      bcBody.value = bcBody.value.replace(bcTagRe(im.num, true), function (m) {
        return "[" + (to === "png" ? "png" : "img") + m.slice(m.search(/\d{4}/));
      });
      bcRenderCard(im, card);
      bcSetStatus(im.num + " re-encoded as ." + to + " (" + Math.round(r.blob.size / 1024) + " KB).");
    });
  }

  /* ---------------- tags in the body ---------------- */
  function bcBuildTag(im) {
    return "[" + (im.fmt === "png" ? "png" : "img") + im.num +
      (im.caption || im.alt ? "," + im.caption : "") +
      (im.alt ? "|" + im.alt : "") + "]";
  }
  function bcTagRe(num, global) {
    /* global flag for rewrites (a tag can be duplicated in the body);
       plain for .test - a /g regex's lastIndex makes repeated tests lie */
    return new RegExp("\\[(?:img|png)" + num + "(?:,[^\\]|]*)?(?:\\|[^\\]]*)?\\]", global ? "g" : "");
  }
  function bcFindTag(num) { return bcTagRe(num).test(bcBody.value); }
  /* pull the tag's current caption/alt into the card before its inputs make
     their first rewrite, so typed-in-tag values are never clobbered */
  function bcHarvestTag(im) {
    var m = new RegExp("\\[(?:img|png)" + im.num +
      "(?:,([^\\]|]*))?(?:\\|([^\\]]*))?\\]").exec(bcBody.value);
    if (!m) return;
    if (m[1] !== undefined) im.caption = m[1];
    if (m[2] !== undefined) im.alt = m[2];
  }
  function bcRewriteTag(im) {
    bcBody.value = bcBody.value.replace(bcTagRe(im.num, true), bcBuildTag(im));
  }
  function bcClean(s) { return s.replace(/[\]|]/g, "").trim(); }

  /* ==========================================================
     4. COMPOSER UI
     ----------------------------------------------------------
     The panel: write, images, preview. It is a sibling of the copy editor's
     modal, not a child, so it carries its own scrim and its own Escape rule.
     The toolbar is the editor's, reached through AMH.tool.toolbar.
     ========================================================== */

  /* The panel's own rules. tool.js holds the one <style> the editor injects,
     and puts these after its own, so a shared class name resolves in favour
     of the composer while the composer is what is on screen. */
  var BC_CSS = "" +
    ".bc-panel{position:fixed;z-index:3300;left:50%;top:50%;transform:translate(-50%,-50%);" +
    "width:min(960px,96vw);height:min(860px,94vh);display:flex;flex-direction:column;" +
    "background:var(--panel);border:1px solid var(--line);border-radius:14px;" +
    "box-shadow:0 40px 100px -40px rgba(0,0,0,1);}" +
    ".bc-head{display:flex;align-items:baseline;gap:.7rem;padding:.85rem 3rem .5rem 1.1rem;}" +
    ".bc-head .ced-slug{font-weight:800;color:var(--text);}" +
    ".bc-head .ced-hint{font-size:.7rem;color:var(--dim);}" +
    ".bc-fields{display:flex;flex-wrap:wrap;gap:.5rem .8rem;align-items:flex-end;padding:0 1.1rem .55rem;}" +
    ".bc-fields input{background:var(--bg-deep);color:var(--text);border:1px solid var(--line);" +
    "border-radius:8px;padding:.45rem .7rem;font:12.5px Consolas,'Courier New',monospace;}" +
    ".bc-fields input:focus-visible{outline:2px solid var(--accent);}" +
    ".bc-title{flex:1 1 16rem;min-width:0;}" +
    /* the posted group: three inputs, each at its own width, so nothing is
       scrunched; a caption above says what the three are */
    ".bc-posted{display:flex;flex-direction:column;gap:.2rem;flex:none;}" +
    ".bc-posted__cap{font:600 .62rem var(--font);letter-spacing:.1em;text-transform:uppercase;color:var(--dim);}" +
    ".bc-posted__row{display:flex;gap:.4rem;}" +
    /* border-box: the width holds the padding too, so each is its
       characters plus the padding, or six digits would not fit */
    ".bc-date{width:calc(8ch + 1.6rem);}" +
    ".bc-time{width:calc(9ch + 1.6rem);}" +
    ".bc-zone{width:calc(6ch + 1.6rem);}" +
    ".bc-tags{margin:.5rem 1.1rem 0;position:relative;}" +
    ".bc-tags__menu{position:absolute;left:0;right:0;bottom:calc(100% + .3rem);z-index:5;background:var(--panel);border:1px solid var(--line);border-radius:8px;overflow:hidden;box-shadow:0 20px 50px -20px rgba(0,0,0,.9);}" +
    ".bc-tags__opt{display:flex;width:100%;justify-content:space-between;align-items:center;gap:.6rem;padding:.35rem .7rem;background:none;border:0;color:var(--text-soft);font:600 .78rem var(--font);cursor:pointer;text-align:left;}" +
    ".bc-tags__opt:hover,.bc-tags__opt.is-at{background:var(--accent-faint);color:var(--text);}" +
    ".bc-tags__opt small{color:var(--dim);font:10.5px Consolas,monospace;}" +
    ".bc-tags input{width:100%;background:var(--bg-deep);color:var(--text);border:1px solid var(--line);" +
    "border-radius:8px;padding:.4rem .7rem;font:12.5px Consolas,'Courier New',monospace;}" +
    ".bc-tags input:focus-visible{outline:2px solid var(--accent);}" +
    ".bc-counts{position:absolute;right:.9rem;bottom:.5rem;font:10.5px Consolas,monospace;" +
    "color:var(--dim);pointer-events:none;}" +
    ".bc-tabs{display:flex;gap:.3rem;padding:.5rem 1.1rem 0;}" +
    ".bc-tab{padding:.3rem .8rem;border-radius:999px;border:1px solid var(--line);" +
    "background:var(--bg-deep);color:var(--muted);font:600 .72rem var(--font);cursor:pointer;}" +
    ".bc-tab.on{border-color:var(--accent);color:var(--accent-bright);}" +
    ".bc-write,.bc-images,.bc-preview{flex:1;min-height:0;display:none;flex-direction:column;" +
    "margin:0 1.1rem;}" +
    ".bc-write{position:relative;}" +
    ".bc-panel[data-tab=write] .bc-write{display:flex;}" +
    ".bc-panel[data-tab=images] .bc-images{display:flex;}" +
    ".bc-panel[data-tab=preview] .bc-preview{display:flex;}" +
    ".bc-write textarea{flex:1;min-height:0;resize:none;background:var(--bg-deep);color:var(--text);" +
    "border:1px solid var(--line);border-radius:8px;padding:.7rem .8rem 1.7rem;" +
    "font:12.5px/1.55 Consolas,'Courier New',monospace;white-space:pre-wrap;}" +
    ".bc-write textarea:focus-visible{outline:2px solid var(--accent);}" +
    ".bc-images{overflow-y:auto;display:none;}" +
    ".bc-panel[data-tab=images] .bc-images{display:block;}" +
    ".bc-drop{border:2px dashed var(--line);border-radius:10px;padding:1.1rem;text-align:center;" +
    "color:var(--muted);font-size:.85rem;transition:border-color .2s;cursor:pointer;}" +
    ".bc-drop:focus-visible{outline:2px solid var(--accent);outline-offset:2px;}" +
    ".bc-drop.ced-dropping{border-color:var(--accent);color:var(--text);}" +
    ".bc-card{display:flex;gap:.7rem;align-items:center;padding:.55rem;border:1px solid var(--line);" +
    "border-radius:10px;margin-top:.6rem;background:var(--bg-deep);}" +
    ".bc-card img{width:86px;height:56px;object-fit:cover;border-radius:6px;flex:none;border:1px solid var(--line);}" +
    ".bc-card__mid{flex:1;min-width:0;display:flex;flex-direction:column;gap:.3rem;}" +
    ".bc-card__mid input{background:var(--panel);color:var(--text);border:1px solid var(--line);" +
    "border-radius:6px;padding:.3rem .5rem;font:11.5px Consolas,'Courier New',monospace;width:100%;}" +
    ".bc-card__meta{font:10.5px Consolas,monospace;color:var(--dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}" +
    ".bc-card__meta.bc-err{color:var(--c-orange);}" +
    ".bc-card__btns{display:flex;flex-direction:column;gap:.3rem;flex:none;}" +
    ".bc-preview{overflow-y:auto;display:none;background:var(--bg);border:1px solid var(--line);" +
    "border-radius:8px;padding:.4rem 1.2rem 1.2rem;}" +
    ".bc-panel[data-tab=preview] .bc-preview{display:block;}" +
    ".bc-status{padding:.35rem 1.1rem 0;font-size:.7rem;color:var(--muted);min-height:1.2em;}" +
    ".bc-imgnote{padding:.4rem 0;font-size:.7rem;color:var(--muted);}" +
    ".bc-btns{display:flex;flex-wrap:wrap;gap:.4rem;padding:.7rem 1.1rem .9rem;}" +
    ".bc-btns .ced-spacer{flex:1 1 auto;}";
  /* the wizard: one box, four bodies */
  BC_CSS +=
    ".bc-wizard{width:min(560px,92vw);}" +
    ".bc-wiz__body{padding:.2rem 1.1rem .4rem;font-size:.8rem;color:var(--muted);line-height:1.55;" +
    "max-height:70vh;overflow:auto;}" +
    ".bc-wiz__body p{margin:.35rem 0;}" +
    ".bc-wiz__body strong{color:var(--text);}" +
    ".bc-wiz__body code{color:var(--accent-bright);font-family:Consolas,monospace;font-size:.78rem;}" +
    ".bc-wiz__body a{color:var(--accent-bright);}" +
    ".bc-wiz__files{display:flex;flex-wrap:wrap;gap:.3rem;margin:.3rem 0 .5rem;}" +
    ".bc-wiz__file{font:700 9.5px/1 Consolas,monospace;letter-spacing:.05em;border-radius:4px;" +
    "padding:3px 6px;border:1px solid var(--line);color:var(--muted);}" +
    ".bc-wiz__file[data-how=spliced]{border-color:var(--accent);color:var(--accent-bright);}" +
    ".bc-wiz__file[data-how=regenerated]{border-style:dashed;}" +
    ".bc-wiz__file[data-how=added]{color:var(--c-yellow);border-color:rgba(240,180,41,.4);}" +
    ".bc-wiz__file[data-how=orphan]{color:var(--c-red,#e06c75);border-color:rgba(224,108,117,.5);}" +
    ".bc-wiz__rows{list-style:none;margin:.4rem 0;padding:0;}" +
    ".bc-wiz__rows li{padding:.28rem 0 .28rem 1.5rem;position:relative;color:var(--dim);}" +
    ".bc-wiz__rows li::before{content:'';position:absolute;left:.15rem;top:.55rem;width:.6rem;" +
    "height:.6rem;border-radius:50%;border:1px solid var(--line);transition:all .25s var(--ease);}" +
    ".bc-wiz__rows li.is-now{color:var(--text);}" +
    ".bc-wiz__rows li.is-now::before{border-color:var(--accent);box-shadow:0 0 0 3px rgba(74,165,232,.25);}" +
    ".bc-wiz__rows li.is-done{color:var(--muted);}" +
    ".bc-wiz__rows li.is-done::before{background:var(--accent);border-color:var(--accent);}" +
    ".bc-wiz__checks{margin:.4rem 0 0;padding:0;list-style:none;}" +
    ".bc-wiz__checks li{padding:.2rem 0;}" +
    ".bc-wiz__checks label{display:flex;gap:.5rem;align-items:baseline;cursor:pointer;color:var(--text);}" +
    ".bc-wiz__checks input:checked+span{color:var(--muted);text-decoration:line-through;}" +
    ".bc-wiz__checks input:disabled+span{color:var(--dim);text-decoration:none;}" +
    ".bc-wiz__opt{display:flex;gap:.5rem;align-items:center;margin:.6rem 0 .2rem;font-size:.75rem;cursor:pointer;}" +
    ".bc-wiz__legend{font-size:.68rem;color:var(--dim);}" +
    ".bc-wiz__reads{padding:0;margin:.3rem 0 .2rem;}" +
    ".bc-wiz__reads .is-opt{border-style:dashed;}" +
    ".bc-wiz__zone{margin:.5rem 0;}" +
    ".bc-wiz__note{min-height:1em;color:var(--text);}";
  TOOL.addStyles(BC_CSS);

  function bcBtn(label, cls, fn, parent) {
    var b = doc.createElement("button");
    b.type = "button";
    b.className = "ced-btn" + (cls ? " " + cls : "");
    b.textContent = label;
    b.addEventListener("click", fn);
    parent.appendChild(b);
    return b;
  }
  function bcSetStatus(msg) { if (bcStatus) bcStatus.textContent = msg || ""; }
  function bcTodayYYMMDD() {
    var d = new Date();
    return String(d.getFullYear()).slice(2) +
      ("0" + (d.getMonth() + 1)).slice(-2) + ("0" + d.getDate()).slice(-2);
  }

  function bcRenderCard(im, existing) {
    var card = existing || doc.createElement("div");
    card.className = "bc-card";
    card.innerHTML = "";
    var th = doc.createElement("img");
    th.src = im.previewURL;
    th.alt = "";
    card.appendChild(th);
    var mid = doc.createElement("div");
    mid.className = "bc-card__mid";
    var meta = doc.createElement("div");
    meta.className = "bc-card__meta";
    meta.textContent = im.published
      ? im.num + " · ." + im.fmt + " · published (" + im.previewURL + ")"
      : im.num + " · ." + im.fmt + " · " + im.w + "x" + im.h +
        " · " + Math.round(im.blob.size / 1024) + " KB · from " + im.origName;
    mid.appendChild(meta);
    var cap = doc.createElement("input");
    cap.type = "text"; cap.placeholder = "caption (shown under / on the image)";
    cap.value = im.caption; cap.spellcheck = true;
    cap.addEventListener("focus", function () { bcHarvestTag(im); cap.value = im.caption; alt.value = im.alt; });
    cap.addEventListener("input", function () {
      im.caption = bcClean(cap.value);
      if (bcFindTag(im.num)) bcRewriteTag(im);
    });
    mid.appendChild(cap);
    var alt = doc.createElement("input");
    alt.type = "text"; alt.placeholder = "alt text (for screen readers / SEO)";
    alt.value = im.alt; alt.spellcheck = true;
    alt.addEventListener("focus", function () { bcHarvestTag(im); cap.value = im.caption; alt.value = im.alt; });
    alt.addEventListener("input", function () {
      im.alt = bcClean(alt.value);
      if (bcFindTag(im.num)) bcRewriteTag(im);
    });
    mid.appendChild(alt);
    card.appendChild(mid);
    var btns = doc.createElement("div");
    btns.className = "bc-card__btns";
    bcBtn("Insert tag", "ced-btn--accent", function () {
      bcPanel.setAttribute("data-tab", "write");
      bcTabsSync();
      TOOL.insert(bcBuildTag(im));
      bcSetStatus("Tag for " + im.num + " inserted at the cursor.");
    }, btns);
    if (!im.published) {
      /* format is baked into a published file - replacing it means a new
         image (new number); only pending images can toggle */
      bcBtn("." + (im.fmt === "jpg" ? "png" : "jpg"), "", function () { bcToggleFmt(im, card); }, btns);
    }
    bcBtn("Remove", "ced-btn--danger", function () {
      if (!window.confirm("Remove image " + im.num + " from this post?" +
          (im.published ? "\n\nThe server file becomes an orphan - it will be listed in ORPHANS.txt for manual deletion." : ""))) return;
      if (bcFindTag(im.num)) {
        bcBody.value = bcBody.value.replace(bcTagRe(im.num, true), "");
        bcSetStatus("Image " + im.num + " and its tag(s) removed.");
      } else {
        bcSetStatus("Image " + im.num + " removed.");
      }
      if (im.published) {
        bcOrphans.push(im.previewURL);
      } else if (im.previewURL) {
        URL.revokeObjectURL(im.previewURL);
      }
      bcImages.splice(bcImages.indexOf(im), 1);
      card.remove();
    }, btns);
    card.appendChild(btns);
    bcNoTab(card);   /* by click: the ring is title, body, images, Publish, Close */
    return card;
  }

  var bcTabBtns = [];
  function bcTabsSync() {
    var cur = bcPanel.getAttribute("data-tab");
    bcTabBtns.forEach(function (b) {
      b.classList.toggle("on", b.getAttribute("data-tab") === cur);
    });
    if (cur === "preview") bcRenderPreview();
  }

  /* The preview by mode: Markdown through the renderer, HTML as it is,
     both through the tag renderer for the images. */
  function bcRenderPreview() {
    var date = /^\d{6}$/.test(bcDate.value) ? bcDate.value : bcTodayYYMMDD();
    var B = AMH.blog;
    var src = bcBody.value.trim();
    var title = bcTitle.value.trim();
    var time = bcTimeParse(bcTime.value);
    /* the preview is the stream's own markup, so what is on screen is
       what the publish writes */
    bcPreviewEl.innerHTML = '<article class="bs-post"><header class="bs-post__by">' +
      '<img class="bs-post__avatar" src="aaron-portfolio-portrait-transparent.png" alt="" />' +
      "<b>" + TOOL.escAttr(bcBrand) + "</b>" +
      '<span class="bs-post__when"><time datetime="' + B.dateTime(date) + '">' +
      B.dateLabel(date) + TOOL.escAttr(time ? " · " + bcTimeLabel(time) : "") + "</time>" +
      (bcZone.value.trim() ? '<span class="bs-post__zone">' + TOOL.escAttr(bcZone.value.trim()) + "</span>" : "") +
      "</span></header>" +
      (title ? '<h3 class="bs-post__title">' + TOOL.escAttr(title).replace(/&quot;/g, '"') + "</h3>" : "") +
      '<div class="bs-post__body"></div>' +
      (bcTagsClean(bcTags.value)
        ? '<div class="bs-post__tags">' + bcTagList(bcTagsClean(bcTags.value)).map(function (t) {
            return "<a>#" + TOOL.escAttr(t) + "</a>"; }).join(" ") + "</div>"
        : "") + "</article>";
    var body = bcPreviewEl.querySelector(".bs-post__body");
    body.innerHTML = B.renderBody(bcMode === "md" ? AMH.markdown.render(src) : src, date, "stream");
    /* pending images do not exist on the server yet: remap to blob previews */
    Array.prototype.forEach.call(body.querySelectorAll("img"), function (img) {
      var m = /_img(\d{4})\.(?:jpg|png)$/.exec(img.getAttribute("src") || "");
      if (!m) return;
      bcImages.forEach(function (im) {
        if (im.num === m[1] && im.previewURL) img.src = im.previewURL;
      });
    });
    if (AMH.work) AMH.work.buildGalleries();
  }

  /* ---------------- the clock, the zone, and the time field ----------------

     The time of day is a note on the post, written as the person sees it:
     "3:07 pm" and a zone such as "EDT" or "Paris". The zone is text, never
     arithmetic; it is there so a post written in Paris on a PC still set
     to EDT can say so. The field starts at the clock and ticks with it
     until touched, so a post written at once carries the time it was
     written, and a post held for an hour carries the time the person
     chose. */
  function bcClockLabel(d) {
    var h = d.getHours(), m = d.getMinutes();
    var ap = h < 12 ? "am" : "pm";
    h = h % 12 || 12;
    return h + ":" + (m < 10 ? "0" : "") + m + " " + ap;
  }
  /* "EDT", "CEST", or "GMT+2" from the browser; the offset when it has no name */
  function bcZoneDefault() {
    try {
      var parts = new Intl.DateTimeFormat("en-US", { timeZoneName: "short" }).formatToParts(new Date());
      for (var i = 0; i < parts.length; i++) {
        if (parts[i].type === "timeZoneName" && parts[i].value) return parts[i].value;
      }
    } catch (err) {}
    var off = -new Date().getTimezoneOffset();
    var sign = off < 0 ? "-" : "+";
    off = Math.abs(off);
    return "UTC" + sign + Math.floor(off / 60) + (off % 60 ? ":" + (off % 60 < 10 ? "0" : "") + off % 60 : "");
  }
  /* "3:07 pm", "15:07", "3pm" -> "1507"; anything else -> "" */
  function bcTimeParse(text) {
    var m = /^\s*(\d{1,2})(?::(\d{2}))?\s*([ap])?\.?m?\.?\s*$/i.exec(text || "");
    if (!m) return "";
    var h = parseInt(m[1], 10), mi = parseInt(m[2] || "0", 10);
    if (mi > 59 || h > 23) return "";
    if (m[3]) {
      if (h < 1 || h > 12) return "";
      h = h % 12 + (m[3].toLowerCase() === "p" ? 12 : 0);
    }
    return (h < 10 ? "0" : "") + h + (mi < 10 ? "0" : "") + mi;
  }
  function bcTimeLabel(hhmm) {
    if (!/^\d{4}$/.test(hhmm || "")) return "";
    return bcClockLabel(new Date(2000, 0, 1, parseInt(hhmm.slice(0, 2), 10), parseInt(hhmm.slice(2), 10)));
  }
  var bcTimeTouched = false;    /* the person took the time field; the clock leaves it alone */
  var bcTicker = null;
  function bcTickTime() {
    if (bcTime && !bcTimeTouched) bcTime.value = bcClockLabel(new Date());
  }
  function bcStartTicker() {
    bcStopTicker();
    bcTickTime();
    bcTicker = window.setInterval(bcTickTime, 60000);
  }
  function bcStopTicker() {
    if (bcTicker) window.clearInterval(bcTicker);
    bcTicker = null;
  }

  /* ---------------- the counts ---------------- */
  /* Characters are the body as typed. Words are runs of letters and
     digits, so a tag or a URL counts once. */
  function bcCounts(text) {
    var words = (text.match(/[A-Za-z0-9]+/g) || []).length;
    return { chars: text.length, words: words };
  }
  function bcRefreshCounts() {
    if (!bcCountsEl) return;
    var c = bcCounts(bcBody.value);
    bcCountsEl.textContent = c.chars.toLocaleString("en-US") + (c.chars === 1 ? " character, " : " characters, ") +
      c.words.toLocaleString("en-US") + (c.words === 1 ? " word" : " words");
  }

  /* ---------------- the Markdown toolbar ----------------

     The composer's own list. The region modal keeps the editor's HTML
     list, because its surfaces hold HTML; this list writes Markdown into
     the body through the same wrap and insert, so the modal gains nothing
     it does not want. Every button is by click: the ring is title, body,
     images, Publish, Close, and a keyboard writer types the marks. */

  /* The current line's bounds in the body. */
  function bcLineAt() {
    var v = bcBody.value, s = bcBody.selectionStart;
    var a = v.lastIndexOf("\n", s - 1) + 1;
    var b = v.indexOf("\n", s);
    if (b === -1) b = v.length;
    return { a: a, b: b, text: v.slice(a, b) };
  }
  function bcSetLine(line, text) {
    var v = bcBody.value;
    bcBody.value = v.slice(0, line.a) + text + v.slice(line.b);
    bcBody.focus();
    bcBody.selectionStart = bcBody.selectionEnd = line.a + text.length;
    bcRefreshCounts();
  }
  /* H2 to H4 as a cycle, then back to plain text. */
  function bcHeadingCycle() {
    var line = bcLineAt();
    var m = /^(#{1,3}) (.*)$/.exec(line.text);
    var rest = m ? m[2] : line.text;
    var hashes = !m ? "#" : m[1].length < 3 ? m[1] + "#" : "";
    bcSetLine(line, hashes ? hashes + " " + rest : rest);
  }
  /* "- " or "1. " on the line, off again when it is there. */
  function bcListToggle(marker) {
    var line = bcLineAt();
    var m = /^( *)(?:[-*]|\d+\.) (.*)$/.exec(line.text);
    if (m) {
      var has = /^ *[-*] /.test(line.text) ? "- " : "1. ";
      bcSetLine(line, has === marker ? m[1] + m[2] : m[1] + marker + m[2]);
    } else {
      bcSetLine(line, marker + line.text);
    }
  }
  /* A flag stands alone on its own line, or it is text. */
  function bcInsertFlag(flag) {
    var v = bcBody.value, s = bcBody.selectionStart;
    var before = s === 0 || v.charAt(s - 1) === "\n" ? "" : "\n";
    var after = s >= v.length || v.charAt(s) === "\n" ? "" : "\n";
    TOOL.insert(before + flag + after);
    bcRefreshCounts();
  }
  function bcInsertTable() {
    var v = bcBody.value, s = bcBody.selectionStart;
    var before = s === 0 || v.charAt(s - 1) === "\n" ? "" : "\n";
    TOOL.insert(before + "| Column | Column |\n| --- | --- |\n| cell | cell |\n");
    bcRefreshCounts();
  }
  /* The marks of the set, removed from the selection: bold, italic,
     strikethrough, code, a link to its text, a heading or list prefix. */
  function bcClearMarks() {
    var s = bcBody.selectionStart, e = bcBody.selectionEnd, v = bcBody.value;
    if (s === e) { var line = bcLineAt(); s = line.a; e = line.b; }
    var t = v.slice(s, e)
      .replace(/\*\*([^*]+)\*\*/g, "$1").replace(/~~([^~]+)~~/g, "$1")
      .replace(/\*([^*\n]+)\*/g, "$1").replace(/(^|[^\w])_([^_\n]+)_(?=[^\w]|$)/g, "$1$2")
      .replace(/`([^`\n]+)`/g, "$1")
      .replace(/\[([^\]\n]+)\]\((?:[^()\s]|\([^()\s]*\))+\)/g, "$1")
      .replace(/^ *(?:#{1,3} |[-*] |\d+\. )/gm, "");
    bcBody.value = v.slice(0, s) + t + v.slice(e);
    bcBody.focus();
    bcBody.selectionStart = s;
    bcBody.selectionEnd = s + t.length;
    bcRefreshCounts();
  }
  var BC_TOOLS = [
    ["H", "heading: H2, H3, H4, then plain", bcHeadingCycle],
    ["• list", "bullet list", function () { bcListToggle("- "); }],
    ["1. list", "numbered list", function () { bcListToggle("1. "); }],
    ["B", "bold", function () { TOOL.wrap("**", "**"); bcRefreshCounts(); }],
    ["I", "italic", function () { TOOL.wrap("*", "*"); bcRefreshCounts(); }],
    ["S", "strikethrough", function () { TOOL.wrap("~~", "~~"); bcRefreshCounts(); }],
    ["Link", "link", function () {
      var url = window.prompt("Link URL:", "https://");
      if (url) { TOOL.wrap("[", "](" + url + ")"); bcRefreshCounts(); }
    }],
    ["Table", "table: a two by two skeleton", bcInsertTable],
    ["Expand", "expand for more: the feed folds the post here", function () { bcInsertFlag("{expandformore}"); }],
    ["Break", "page break: the feed ends the post here with Read more", function () { bcInsertFlag("{pagebreak}"); }],
    ["Clear", "clear formatting in the selection", bcClearMarks]
  ];

  /* ---------------- the tag dropdown ----------------

     The tags the blog already uses, offered as you type, each with the
     number of posts that carry it. Nothing is refused: what you type
     stays what you typed. The count beside a near match is the point of
     it, because that is what stops a typo becoming a category.

     The list comes from the packed index, which loads on the first
     keystroke in the field and not before. */
  function bcTagsWire() {
    bcTags.addEventListener("input", bcTagMenuDraw);
    bcTags.addEventListener("focus", function () {
      if (!bcTagsKnown && AMH.search) {
        AMH.search.tags().then(function (list) { bcTagsKnown = list; }, function () { bcTagsKnown = []; });
      }
    });
    bcTags.addEventListener("keydown", bcTagMenuKeys);
    bcTags.addEventListener("blur", function () {
      /* a click on an option lands after the blur, so the menu waits */
      window.setTimeout(function () { if (bcTagMenu) bcTagMenu.hidden = true; }, 150);
    });
  }
  /* What is being typed now: the last word of the field. */
  function bcTagWord() {
    var v = bcTags.value;
    var at = Math.max(v.lastIndexOf(" "), v.lastIndexOf(","));
    return { from: at + 1, text: v.slice(at + 1).replace(/^#/, "").toLowerCase() };
  }
  function bcTagMenuDraw() {
    if (!bcTagMenu) return;
    if (!bcTagsKnown || !bcTagsKnown.length) { bcTagMenu.hidden = true; return; }
    var word = bcTagWord();
    var used = bcTagList(bcTagsClean(bcTags.value));
    var all = word.text === "";
    var hits = bcTagsKnown.filter(function (t) {
      if (used.indexOf(t.tag) !== -1 && t.tag !== word.text) return false;
      return all || t.tag.indexOf(word.text) === 0;
    }).slice(0, 8);
    if (!hits.length) { bcTagMenu.hidden = true; return; }
    bcTagMenu.innerHTML = "";
    hits.forEach(function (t) {
      var b = doc.createElement("button");
      b.type = "button";
      b.className = "bc-tags__opt";
      b.tabIndex = -1;
      b.setAttribute("data-tag", t.tag);
      b.innerHTML = "<span>#" + TOOL.escAttr(t.tag) + "</span><small>" + t.count + "</small>";
      b.addEventListener("mousedown", function (e) { e.preventDefault(); bcTagTake(t.tag); });
      bcTagMenu.appendChild(b);
    });
    bcTagMenu.hidden = false;
  }
  /* Put the chosen tag in place of the word being typed. */
  function bcTagTake(tag) {
    var word = bcTagWord();
    bcTags.value = bcTags.value.slice(0, word.from) + tag + " ";
    bcTags.focus();
    bcTagMenu.hidden = true;
  }
  function bcTagMenuKeys(e) {
    if (e.key === "Escape") { bcTagMenu.hidden = true; return; }
    if (bcTagMenu.hidden) return;
    var opts = Array.prototype.slice.call(bcTagMenu.querySelectorAll(".bc-tags__opt"));
    if (!opts.length) return;
    var at = opts.map(function (o) { return o.classList.contains("is-at"); }).indexOf(true);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      at = (at + (e.key === "ArrowDown" ? 1 : -1) + opts.length) % opts.length;
      opts.forEach(function (o, i) { o.classList.toggle("is-at", i === at); });
    } else if (e.key === "Enter" && at !== -1) {
      e.preventDefault();
      bcTagTake(opts[at].getAttribute("data-tag"));
    }
  }

  /* ---------------- the draft ---------------- */
  function bcSaveDraft() {
    try {
      localStorage.setItem(BC_DRAFT_KEY, JSON.stringify({
        date: bcDate.value, title: bcTitle.value, body: bcBody.value,
        tags: bcTags.value, time: bcTime.value, zone: bcZone.value, when: Date.now()
      }));
      bcSetStatus("Draft saved. Text only: images do not persist, so keep the files. One slot.");
    } catch (err) { bcSetStatus("Draft save failed: " + err.message); }
  }
  /* A draft from before the time, zone and tags fields restores with those
     at their defaults: the clock, the PC's zone, no tags. */
  function bcRestoreDraft() {
    var raw = null;
    try { raw = localStorage.getItem(BC_DRAFT_KEY); } catch (err) {}
    if (!raw) { bcSetStatus("No draft stored."); return; }
    var d;
    try { d = JSON.parse(raw); } catch (err) { bcSetStatus("Draft is unreadable."); return; }
    if (!d || typeof d.body !== "string" || typeof d.when !== "number") {
      bcSetStatus("Draft is unreadable."); return;
    }
    if (!window.confirm("Restore draft \"" + (d.title || "(untitled)") + "\" (" +
        TOOL.age(Date.now() - d.when) + ")?\n\nThis replaces the title, the body, the tags and the posted fields.")) return;
    bcDate.value = d.date || bcTodayYYMMDD();
    bcTitle.value = d.title || "";
    bcBody.value = d.body;
    bcTags.value = d.tags || "";
    bcZone.value = d.zone || bcZoneDefault();
    if (d.time) { bcTimeTouched = true; bcStopTicker(); bcTime.value = d.time; }
    else { bcTimeTouched = false; bcStartTicker(); }
    bcRefreshCounts();
    bcSetStatus("Draft restored. Add any images it references again.");
  }

  function bcRequestClose() {
    if (bcDirty() &&
        !window.confirm("The composer has unpublished content.\n\nClose and discard it? (Save Draft first if unsure.)")) return;
    bcClose();
  }
  function bcClose() {
    bcStopTicker();
    bcImages.forEach(function (im) { if (im.previewURL) URL.revokeObjectURL(im.previewURL); });
    bcImages = [];
    if (bcScrim && bcScrim.parentNode) bcScrim.parentNode.removeChild(bcScrim);
    if (bcPanel && bcPanel.parentNode) bcPanel.parentNode.removeChild(bcPanel);
  }

  /* The tab ring: title, body, the images area, Publish, Close. That is
     the order a post is written in. Everything else in the panel is by
     click and carries tabIndex -1, so the ring is a list and not a query.
     A stop that is disabled, which Publish is once a bundle is built, is
     skipped. */
  function bcRing() {
    return [bcTitle, bcBody, bcDrop, bcPublishBtn, bcCloseBtn].filter(function (el) {
      return el && !el.disabled;
    });
  }
  /* The images area lives in its own view, so landing on it shows that
     view, and landing back on the title or the body shows the write view. */
  function bcFocusStop(el) {
    var view = el === bcDrop ? "images" : (el === bcTitle || el === bcBody) ? "write" : "";
    if (view && bcPanel.getAttribute("data-tab") !== view) {
      bcPanel.setAttribute("data-tab", view);
      bcTabsSync();
    }
    el.focus();
  }
  /* The panel says aria-modal, so TAB has to stay in it. Without this the
     focus walks out through the scrim and onto the page behind, where the
     editor's own chips are waiting, and there is no way back but the mouse. */
  function bcTrapFocus(e) {
    if (e.key !== "Tab") return;
    var ring = bcRing();
    if (!ring.length) return;
    e.preventDefault();
    var at = ring.indexOf(doc.activeElement);
    var next = at === -1 ? 0 : (at + (e.shiftKey ? -1 : 1) + ring.length) % ring.length;
    bcFocusStop(ring[next]);
  }
  /* Everything in root that could take focus and is not a ring stop is
     taken out of the tab order. Called for the panel once built, and for
     each image card as it is rendered. */
  function bcNoTab(root) {
    var ring = bcRing();
    Array.prototype.forEach.call(root.querySelectorAll("input, textarea, button, [tabindex]"), function (el) {
      if (ring.indexOf(el) === -1) el.tabIndex = -1;
    });
  }

  var bcEscBound = false;
  function openComposer(editing) {
    if (bcPanel && bcPanel.parentNode) return;
    bcEditing = editing || null;
    bcOrphans = [];
    if (!bcEscBound) {
      bcEscBound = true;
      doc.addEventListener("keydown", function (e) {
        if (!bcPanel || !bcPanel.parentNode) return;
        /* the region modal layers over this one and owns the keyboard while
           it is open, so neither rule fires underneath it */
        if (TOOL.modalOpen() || bcWiz) return;
        if (e.key === "Escape") {
          e.preventDefault();
          bcRequestClose();
          return;
        }
        bcTrapFocus(e);
      });
    }
    bcPublished = false;
    bcImgCounter = 0;
    var stagedPage = TOOL.layerFile(TOOL.currentPage());
    bcManAtOpen = stagedPage !== null
      ? bcManifestFrom(stagedPage).payload
      : (doc.getElementById("blogManifest") || { textContent: "" }).textContent;
    bcScrim = doc.createElement("div");
    bcScrim.className = "ced-scrim";
    bcPanel = doc.createElement("div");
    bcPanel.className = "bc-panel";
    bcPanel.setAttribute("role", "dialog");
    bcPanel.setAttribute("aria-modal", "true");
    bcPanel.setAttribute("data-tab", "write");
    /* the mode is the post's format: a new post is Markdown, and a post
       written in HTML stays HTML, because a conversion by machine would
       change prose, and prose is the person's */
    bcMode = bcEditing && bcEditing.format0 === "html" ? "html" : "md";
    bcPanel.setAttribute("data-mode", bcMode);

    var head = doc.createElement("div");
    head.className = "bc-head";
    head.innerHTML = '<span class="ced-slug">' +
      (bcEditing ? "Edit post p" + bcEditing.id : "New blog post") + "</span>" +
      '<span class="ced-hint">publishes as a zip bundle - extract at the repo root</span>';
    bcPanel.appendChild(head);
    var x = doc.createElement("button");
    x.type = "button";
    x.className = "ced-modal__x";
    x.setAttribute("aria-label", "Close composer");
    x.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
      'stroke-linecap="round" aria-hidden="true"><line x1="6" y1="6" x2="18" y2="18"/>' +
      '<line x1="18" y1="6" x2="6" y2="18"/></svg>';
    x.addEventListener("click", bcRequestClose);
    bcPanel.appendChild(x);

    /* the title row: the title, and on the right the posted group */
    var fields = doc.createElement("div");
    fields.className = "bc-fields";
    bcTitle = doc.createElement("input");
    bcTitle.type = "text"; bcTitle.className = "bc-title";
    bcTitle.placeholder = "Title (optional)";
    bcTitle.addEventListener("input", function () {
      /* titles land inside the manifest script tag and in attributes: no
         pipes (entry delimiter) and no angle brackets (a script-closing
         sequence in a title would truncate the manifest for every visitor) */
      if (/[|<>]/.test(bcTitle.value)) bcTitle.value = bcTitle.value.replace(/[|<>]/g, "");
    });
    fields.appendChild(bcTitle);
    var posted = doc.createElement("div");
    posted.className = "bc-posted";
    posted.innerHTML = '<span class="bc-posted__cap">posted</span>';
    var postedRow = doc.createElement("div");
    postedRow.className = "bc-posted__row";
    bcDate = doc.createElement("input");
    bcDate.type = "text"; bcDate.className = "bc-date";
    bcDate.value = bcTodayYYMMDD();
    bcDate.title = "post date, YYMMDD";
    bcDate.spellcheck = false;
    bcTime = doc.createElement("input");
    bcTime.type = "text"; bcTime.className = "bc-time";
    bcTime.title = "time of day. It follows the clock until you touch it; blank it to follow the clock again";
    bcTime.spellcheck = false;
    bcTime.placeholder = "h:mm am";
    /* the clock stops at a focus, not only at a key, so a click never
       has the field change under the cursor */
    bcTime.addEventListener("focus", function () { bcTimeTouched = true; bcStopTicker(); });
    bcTime.addEventListener("input", function () { bcTimeTouched = true; bcStopTicker(); });
    bcTime.addEventListener("blur", function () {
      if (bcTime.value.trim() === "") { bcTimeTouched = false; bcStartTicker(); }
    });
    bcZone = doc.createElement("input");
    bcZone.type = "text"; bcZone.className = "bc-zone";
    bcZone.title = "time zone, as a note: EDT, CEST, Paris";
    bcZone.spellcheck = false;
    bcZone.value = bcZoneDefault();
    postedRow.appendChild(bcDate);
    postedRow.appendChild(bcTime);
    postedRow.appendChild(bcZone);
    posted.appendChild(postedRow);
    fields.appendChild(posted);
    bcPanel.appendChild(fields);

    /* the write view: the Markdown toolbar, the body, the counts */
    var writeEl = doc.createElement("div");
    writeEl.className = "bc-write";
    var tools = doc.createElement("div");
    tools.className = "ced-modal__tools";
    tools.style.padding = "0 0 .55rem";
    /* the HTML mode keeps the editor's HTML list, the set an old post was
       written with; the Markdown mode has the composer's own */
    var toolList = bcMode === "html"
      ? TOOL.toolbar.concat([
          ["H3", "subheading", function () { TOOL.wrap("<h3>", "</h3>"); bcRefreshCounts(); }],
          ["P", "paragraph", function () { TOOL.wrap("<p>", "</p>"); bcRefreshCounts(); }]
        ])
      : BC_TOOLS;
    toolList.forEach(function (t) {
      var b = doc.createElement("button");
      b.type = "button"; b.className = "ced-tool";
      b.tabIndex = -1;             /* by click: the ring is title, body, images, Publish, Close */
      b.textContent = t[0]; b.title = t[1];
      b.addEventListener("click", t[2]);
      tools.appendChild(b);
    });
    writeEl.appendChild(tools);
    bcBody = doc.createElement("textarea");
    bcBody.spellcheck = true;
    bcBody.placeholder = bcMode === "html"
      ? "<p>This post is HTML, and stays HTML.</p>"
      : "Write the post in Markdown. # for a heading, - for a list, **bold**, *italic*.\n\n" +
        "Drop images on the Images view, then place them with [img####,caption|alt] tags on their own lines. " +
        "{expandformore} and {pagebreak} alone on a line tell the feed where to fold.";
    bcBody.addEventListener("input", bcRefreshCounts);
    writeEl.appendChild(bcBody);
    bcCountsEl = doc.createElement("span");
    bcCountsEl.className = "bc-counts";
    writeEl.appendChild(bcCountsEl);
    bcPanel.appendChild(writeEl);

    /* images tab */
    var imagesEl = doc.createElement("div");
    imagesEl.className = "bc-images";
    /* the images area is the ring's third stop, so it takes focus and
       opens a picker on Enter or a click, as well as taking a drop */
    var drop = doc.createElement("div");
    drop.className = "bc-drop";
    drop.setAttribute("role", "button");
    drop.tabIndex = 0;
    drop.textContent = "Drop images here, or click to choose them (jpg, png, webp). " +
      "They are resized to 1600px at jpg quality 85; toggle a card to .png for lossless.";
    var picker = doc.createElement("input");
    picker.type = "file";
    picker.multiple = true;
    picker.accept = "image/jpeg,image/png,image/webp";
    picker.style.display = "none";
    picker.tabIndex = -1;
    /* intake is async (decode + encode); chain it so numbers are always
       assigned in drop order, even across rapid multi-drops */
    function takeImages(list) {
      Array.prototype.slice.call(list || []).forEach(function (f) {
        bcIntakeChain = bcIntakeChain.then(function () {
          return bcIntake(f).then(function (im) {
            bcCards.appendChild(bcRenderCard(im, null));
            bcSetStatus(im.num + " added (" + Math.round(im.blob.size / 1024) + " KB). Use Insert tag to place it.");
          }).catch(function (err) {
            var note = doc.createElement("div");
            note.className = "bc-card__meta bc-err";
            note.style.marginTop = ".6rem";
            note.textContent = f.name + ": " + err.message;
            bcCards.appendChild(note);
          });
        });
      });
    }
    ["dragover", "dragleave", "drop"].forEach(function (evName) {
      drop.addEventListener(evName, function (e) {
        e.preventDefault(); e.stopPropagation();
        drop.classList.toggle("ced-dropping", evName === "dragover");
        if (evName !== "drop") return;
        takeImages(e.dataTransfer && e.dataTransfer.files);
      });
    });
    drop.addEventListener("click", function () { picker.click(); });
    drop.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.key === " " || e.key === "Spacebar") { e.preventDefault(); picker.click(); }
    });
    picker.addEventListener("change", function () { takeImages(picker.files); picker.value = ""; });
    bcDrop = drop;
    imagesEl.appendChild(drop);
    imagesEl.appendChild(picker);
    /* The one thing on the site that cannot travel between pages. Copy and
       gallery edits are strings, so they wait in sessionStorage and follow you.
       These are real resized bytes, held in memory for the zip, and a
       navigation frees them. */
    var imgNote = doc.createElement("div");
    imgNote.className = "bc-imgnote";
    imgNote.textContent = "Images live on this page only. Text edits follow you " +
      "between pages, but these are real file bytes: leaving loses them, so " +
      "publish the post from here.";
    imagesEl.appendChild(imgNote);
    bcCards = doc.createElement("div");
    imagesEl.appendChild(bcCards);
    bcPanel.appendChild(imagesEl);

    /* preview view */
    bcPreviewEl = doc.createElement("div");
    bcPreviewEl.className = "bc-preview";
    bcPanel.appendChild(bcPreviewEl);

    /* the tags, under whichever view is showing */
    var tagsEl = doc.createElement("div");
    tagsEl.className = "bc-tags";
    bcTags = doc.createElement("input");
    bcTags.type = "text";
    bcTags.placeholder = "tags, such as xr planetarium";
    bcTags.title = "tags: free text, # optional, comma or space between them";
    bcTags.spellcheck = false;
    bcTags.autocomplete = "off";
    tagsEl.appendChild(bcTags);
    bcTagMenu = doc.createElement("div");
    bcTagMenu.className = "bc-tags__menu";
    bcTagMenu.hidden = true;
    tagsEl.appendChild(bcTagMenu);
    bcTagsWire();
    bcPanel.appendChild(tagsEl);

    /* the view row, below the body, so a switch never moves the buttons */
    var tabs = doc.createElement("div");
    tabs.className = "bc-tabs";
    bcTabBtns = [];
    [["write", "Write"], ["images", "Images"], ["preview", "Preview"]].forEach(function (t) {
      var b = doc.createElement("button");
      b.type = "button"; b.className = "bc-tab";
      b.setAttribute("data-tab", t[0]);
      b.textContent = t[1];
      b.addEventListener("click", function () {
        bcPanel.setAttribute("data-tab", t[0]);
        bcTabsSync();
      });
      bcTabBtns.push(b);
      tabs.appendChild(b);
    });
    bcPanel.appendChild(tabs);

    bcStatus = doc.createElement("div");
    bcStatus.className = "bc-status";
    bcPanel.appendChild(bcStatus);

    var btns = doc.createElement("div");
    btns.className = "bc-btns";
    bcDeleteBtn = bcBtn("Delete post", "ced-btn--danger", bcDeletePost, btns);
    if (!bcEditing) bcDeleteBtn.style.display = "none";
    bcBtn("Save Draft", "", bcSaveDraft, btns);
    bcBtn("Restore Draft", "", bcRestoreDraft, btns);
    var sp = doc.createElement("span");
    sp.className = "ced-spacer";
    btns.appendChild(sp);
    bcPublishBtn = bcBtn("Publish", "ced-btn--accent", bcPublish, btns);
    bcCloseBtn = bcBtn("Close", "", bcRequestClose, btns);
    bcPanel.appendChild(btns);

    /* an edited post opens with its own time and zone, and the clock stays
       out of it; a new post follows the clock until touched */
    if (bcEditing && bcEditing.time) {
      bcTimeTouched = true;
      bcTime.value = bcTimeLabel(bcEditing.time) || bcEditing.time;
      if (bcEditing.zone) bcZone.value = bcEditing.zone;
    } else {
      bcTimeTouched = false;
      bcStartTicker();
    }
    if (bcEditing && bcEditing.tags) bcTags.value = bcEditing.tags;
    bcNoTab(bcPanel);
    bcRefreshCounts();
    doc.body.appendChild(bcScrim);
    doc.body.appendChild(bcPanel);
    bcTabsSync();
    bcTitle.focus();
    bcSetStatus("Reminder: publish from a clean repo that is synced with the live site.");
  }

  /* ---------------- the publish wizard ----------------

     One dialog from Publish to Done. The browser's confirm box used to be
     the only step, and the one line of status after it was easy to miss: the
     zip left the page in silence and the next thing to do was in the console.

     Four steps, one box: confirm, progress, done, failed. Each step replaces
     the body; the box, its focus trap and its Escape stay. */

  function bcWizFocusables() {
    if (!bcWiz) return [];
    return Array.prototype.filter.call(
      bcWiz.box.querySelectorAll("input, button, [href]"),
      function (el) {
        return el.tabIndex !== -1 && !el.disabled && (el.offsetWidth > 0 || el.offsetHeight > 0);
      });
  }
  /* Captured, so it runs before the composer's own handler, which also
     yields while the wizard is up. */
  function bcWizKeys(e) {
    if (!bcWiz) return;
    if (e.key === "Escape") {
      e.preventDefault();
      if (bcWiz.onEscape) bcWiz.onEscape();
      return;
    }
    if (e.key !== "Tab") return;
    var items = bcWizFocusables();
    if (!items.length) return;
    var first = items[0], last = items[items.length - 1];
    var at = items.indexOf(doc.activeElement);
    if (at === -1) { e.preventDefault(); first.focus(); return; }
    if (e.shiftKey && doc.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && doc.activeElement === last) { e.preventDefault(); first.focus(); }
  }
  /* Open the box, or reuse it for the next step. It sits at the modal layer
     above the composer and takes the keyboard while it is up. */
  function bcWizShow(step, title) {
    TOOL.injectStyles();
    if (!bcWiz) {
      var scrim = doc.createElement("div");
      scrim.className = "ced-scrim";
      var box = doc.createElement("div");
      box.className = "ced-modal bc-wizard";
      box.setAttribute("role", "dialog");
      box.setAttribute("aria-modal", "true");
      var head = doc.createElement("div");
      head.className = "ced-modal__head";
      var body = doc.createElement("div");
      body.className = "bc-wiz__body";
      var btns = doc.createElement("div");
      btns.className = "ced-modal__btns";
      box.appendChild(head);
      box.appendChild(body);
      box.appendChild(btns);
      doc.body.appendChild(scrim);
      doc.body.appendChild(box);
      doc.addEventListener("keydown", bcWizKeys, true);
      bcWiz = { scrim: scrim, box: box, head: head, body: body, btns: btns, onEscape: null };
    }
    bcWiz.box.setAttribute("data-step", step);
    bcWiz.head.innerHTML = '<span class="ced-b">PUBLISH</span><span class="ced-slug">' +
      TOOL.escAttr(title) + "</span>";
    bcWiz.body.innerHTML = "";
    bcWiz.btns.innerHTML = "";
    bcWiz.onEscape = null;
    bcWizUnhand();
    return bcWiz;
  }
  /* the progress step listens for the hand-off; the next step, or the
     close, stops it */
  function bcWizUnhand() {
    if (bcWiz && bcWiz.onHand) doc.removeEventListener("ced:handoff", bcWiz.onHand);
    if (bcWiz) bcWiz.onHand = null;
  }
  function bcWizClose() {
    if (!bcWiz) return;
    bcWizUnhand();
    doc.removeEventListener("keydown", bcWizKeys, true);
    if (bcWiz.scrim.parentNode) bcWiz.scrim.parentNode.removeChild(bcWiz.scrim);
    if (bcWiz.box.parentNode) bcWiz.box.parentNode.removeChild(bcWiz.box);
    bcWiz = null;
    if (bcPanel && bcPanel.parentNode && bcTitle) bcTitle.focus();
  }
  function bcWizBtn(label, cls, fn) {
    var b = doc.createElement("button");
    b.type = "button";
    b.className = "ced-btn" + (cls ? " " + cls : "");
    b.textContent = label;
    b.addEventListener("click", fn);
    bcWiz.btns.appendChild(b);
    return b;
  }
  function bcWizSpacer() {
    var s = doc.createElement("span");
    s.className = "ced-spacer";
    bcWiz.btns.appendChild(s);
  }
  function bcFileChips(names, how) {
    return names.map(function (n) {
      return '<span class="bc-wiz__file" data-how="' + how + '">' + TOOL.escAttr(n) + "</span>";
    }).join("");
  }
  var BC_LEGEND = '<p class="bc-wiz__legend">Solid: spliced from the deployed bytes. ' +
    "Dashed: written whole. Yellow: added.</p>";
  function bcNoRemind() {
    try { return localStorage.getItem(NOREMIND_KEY) === "1"; } catch (err) { return false; }
  }
  function bcSetNoRemind(on) {
    try {
      if (on) localStorage.setItem(NOREMIND_KEY, "1");
      else localStorage.removeItem(NOREMIND_KEY);
    } catch (err) {}
  }

  /* Step one. Resolves true to build, false to stop. The reminder is the
     one the browser box carried, because it is what stops a stale local copy
     from silently reverting real work. With the reminder switched off the
     step still shows, as a notice that proceeds on its own, so a publish
     never starts with nothing on screen. */
  function bcWizConfirm(willWrite, willReplace) {
    return new Promise(function (resolve) {
      var lists =
        "<p>These pages are <strong>spliced</strong> from their deployed bytes:</p>" +
        '<div class="bc-wiz__files">' + bcFileChips(willWrite.slice().sort(), "spliced") + "</div>" +
        "<p>These files are <strong>written whole</strong>:</p>" +
        '<div class="bc-wiz__files">' + bcFileChips(willReplace, "regenerated") + "</div>";
      if (bcNoRemind()) {
        var w = bcWizShow("notice", "Proceeding");
        w.body.innerHTML =
          "<p>You chose not to see the reminder. The bundle builds in a moment. " +
          "Cancel stops it.</p>" + lists;
        var timer = window.setTimeout(function () { resolve(true); }, NOTICE_MS);
        var stop = function () { window.clearTimeout(timer); bcWizClose(); resolve(false); };
        bcWizSpacer();
        bcWizBtn("Cancel", "", stop).focus();
        w.onEscape = stop;
        return;
      }
      var wz = bcWizShow("confirm", "Before the build");
      wz.body.innerHTML = lists +
        "<p>Make sure your local repo is <strong>clean and synced with the live site</strong> " +
        "before you extract the zip. A spliced page keeps every byte outside its markers. " +
        "A stale copy reverts real work, and says nothing.</p>" +
        '<label class="bc-wiz__opt"><input type="checkbox" class="bc-wiz__noremind" />' +
        "<span>Do not show this reminder again</span></label>";
      var cancel = function () { bcWizClose(); resolve(false); };
      bcWizBtn("Cancel", "", cancel);
      bcWizSpacer();
      bcWizBtn("Build the bundle", "ced-btn--accent", function () {
        var cb = wz.body.querySelector(".bc-wiz__noremind");
        if (cb && cb.checked) bcSetNoRemind(true);
        resolve(true);
      }).focus();
      wz.onEscape = cancel;
    });
  }

  /* The Files step, from disk only, between Confirm and the build. A page
     opened from disk cannot fetch the bytes it splices. The hand-off used
     to ask for them one file at a time from inside the build, so the build
     stopped at its first read and a second dialog appeared with no warning.
     This step names every file before anything runs, takes the folder or
     the files, and closes itself when every required file is in hand. A
     required file the folder lacks keeps it open, and Continue lets the
     hand-off ask for that file as it did before. Resolves true to build,
     false to stop. */
  function bcWizFiles(reads) {
    function name(pp) { return pp.replace(/^.*\//, ""); }
    function stillNeeded() {
      return reads.required.filter(function (pp) { return TOOL.fileState(pp) === "wait"; });
    }
    return new Promise(function (resolve) {
      if (!TOOL.fromDisk() || TOOL.hasRepo() || !stillNeeded().length) { resolve(true); return; }
      var w = bcWizShow("files", "Files from your repo");
      w.body.innerHTML =
        "<p>This page was opened from disk, so the publish cannot read the deployed files " +
        "by itself. It reads these files from your repo:</p>" +
        '<div class="ced-handoff__list bc-wiz__reads"></div>' +
        '<div class="ced-handoff__zone bc-wiz__zone" tabindex="0" role="button">' +
        "<strong>Drop the files here</strong><span>or click to choose them</span></div>" +
        '<p class="bc-wiz__legend">Dashed: may not exist yet. Struck through: in hand.</p>' +
        '<p class="bc-wiz__note"></p>';
      var listEl = w.body.querySelector(".bc-wiz__reads");
      var zone = w.body.querySelector(".bc-wiz__zone");
      var note = w.body.querySelector(".bc-wiz__note");
      var input = doc.createElement("input");
      input.type = "file";
      input.multiple = true;
      input.accept = ".html,text/html";
      input.style.display = "none";
      var folder = doc.createElement("input");
      folder.type = "file";
      folder.setAttribute("webkitdirectory", "");
      folder.setAttribute("directory", "");
      folder.style.display = "none";
      w.body.appendChild(input);
      w.body.appendChild(folder);
      function paint() {
        listEl.innerHTML = reads.all.map(function (pp) {
          var state = TOOL.fileState(pp);
          var opt = reads.optional.indexOf(pp) !== -1 ? " is-opt" : "";
          return '<span class="ced-handoff__item is-' + state + opt + '">' + TOOL.escAttr(name(pp)) + "</span>";
        }).join("");
      }
      function leave(go) {
        TOOL.unpoint();
        if (!go) bcWizClose();
        resolve(go);
      }
      function after() {
        paint();
        var left = stillNeeded();
        if (!left.length) { leave(true); return; }
        note.textContent = "Still needed: " + left.map(name).join(", ") +
          ". Drop them here, or click Continue and the publish asks for each one.";
      }
      function takeFrom(files) {
        TOOL.takeFiles(files, reads.all).then(function (took) {
          if (!took) note.textContent = "None of those is a file this publish reads.";
          after();
        });
      }
      paint();
      zone.addEventListener("click", function () { input.click(); });
      zone.addEventListener("keydown", function (e) {
        if (e.key === "Enter" || e.key === " " || e.key === "Spacebar") { e.preventDefault(); input.click(); }
      });
      zone.addEventListener("dragover", function (e) {
        e.preventDefault(); e.stopPropagation();
        e.dataTransfer.dropEffect = "copy";
        zone.classList.add("is-over");
      });
      zone.addEventListener("dragleave", function () { zone.classList.remove("is-over"); });
      zone.addEventListener("drop", function (e) {
        e.preventDefault(); e.stopPropagation();
        zone.classList.remove("is-over");
        takeFrom(e.dataTransfer && e.dataTransfer.files);
      });
      input.addEventListener("change", function () { takeFrom(input.files); });
      folder.addEventListener("change", function () {
        TOOL.takeFolder(folder.files, reads.all).then(function (took) {
          if (!took) note.textContent = "That folder holds none of the files this publish reads.";
          after();
        });
      });
      var cancel = function () { leave(false); };
      bcWizBtn("Cancel", "", cancel);
      bcWizSpacer();
      var repo = bcWizBtn("Use my repo folder", "ced-btn--accent", function () {
        if (!TOOL.hasPicker()) { folder.click(); return; }
        TOOL.pickRepo(reads.all).then(function (took) {
          if (took !== null) after();
        }, function (err) { note.textContent = err && err.message ? err.message : String(err); });
      });
      repo.title = "Choose the root of your repo folder one time. Every file is read from it.";
      bcWizBtn("Continue", "", function () { leave(true); });
      repo.focus();
      w.onEscape = cancel;
      TOOL.pointRepo(repo);
    });
  }

  /* Step two. The rows are named up front and ticked as the work reaches
     them. The work runs at full speed and the display paces itself, so each
     row is current for at least STEP_MS. finish() resolves when the last
     tick has been seen, which is when Done may take the box. */
  function bcWizProgress(rows) {
    var w = bcWizShow("progress", "Building the bundle");
    w.body.innerHTML = "<p>The publish does these steps:</p>" +
      '<ol class="bc-wiz__rows">' + rows.map(function (r, i) {
        return '<li class="' + (i === 0 ? "is-now" : "is-wait") + '">' + TOOL.escAttr(r) + "</li>";
      }).join("") + "</ol>";
    var lis = w.body.querySelectorAll("li");
    var chain = Promise.resolve();
    var t0 = Date.now();
    function wait(ms) { return new Promise(function (res) { window.setTimeout(res, ms); }); }
    /* While the hand-off dialog is up the current row says so, so the two
       boxes read as one job: the build waits for a file, and the dialog is
       where the file goes. The hand-off announces itself on the document,
       because tool.js does not know the wizard. */
    var handPath = "";
    function paint() {
      for (var i = 0; i < lis.length; i++) {
        lis[i].textContent = (handPath && lis[i].className === "is-now")
          ? "Waiting for you: hand over " + handPath.replace(/^.*\//, "")
          : rows[i];
      }
    }
    w.onHand = function (e) {
      handPath = e.detail && e.detail.open ? e.detail.path : "";
      paint();
    };
    doc.addEventListener("ced:handoff", w.onHand);
    return {
      mark: function (i) {
        chain = chain.then(function () {
          if (lis[i]) lis[i].className = "is-done";
          if (lis[i + 1]) lis[i + 1].className = "is-now";
          paint();
          return wait(STEP_MS);
        });
      },
      finish: function () {
        return chain.then(function () {
          if (bcWiz) bcWiz.box.setAttribute("data-elapsed", String(Date.now() - t0));
        });
      }
    };
  }

  /* The publish record: what the last bundle was and how far it has been
     taken. It lives in sessionStorage so it follows a reload in this tab,
     which is when it is needed: the page has reloaded, the wizard is gone,
     and the record is what remembers. tool.js reads it for the panel line. */
  function bcRecordLoad() { return TOOL.layer(); }
  function bcRecordSave(rec) { TOOL.layerSave(rec); }
  /* Is the last bundle on the page that loaded? The bundle's manifest
     carries a stamp no other publish has, and the record holds the same
     stamp, so the page is live when its manifest says that stamp. One
     compare for a publish, a delete and a rebuild. Live clears the record:
     there is nothing left to remember. From disk this is the extracted
     copy, which is the same fact one step earlier. */
  function bcCheckLive() {
    var rec = bcRecordLoad();
    if (!rec || !rec.stamp) return false;
    /* the stamp the page carried when it arrived, before the layer put
       its own work on screen: the question is whether the SERVER has the
       bundle, and the layer would answer yes to its own reflection */
    var live = bcDeployedStamp === rec.stamp;
    if (live) {
      console.info("[blog] this page carries publish " + rec.stamp +
        ". The bundle is live, so the staging layer is cleared.");
      bcRecordSave(null);
      bcStagedChips();
    }
    return live;
  }
  /* What the page said before anything was staged onto it. */
  var bcDeployedStamp = "";
  var bcDeployedIds = {};

  /* A post that is in the layer and not on the server yet wears a chip
     saying so, with the way back to its checklist. Which posts those are
     is the difference between the manifest the page arrived with and the
     one on screen now. */
  function bcStagedChips() {
    var rec = bcRecordLoad();
    Array.prototype.forEach.call(doc.querySelectorAll(".bs-post"), function (post) {
      var id = post.getAttribute("data-id");
      var staged = !!rec && !bcDeployedIds[id];
      post.classList.toggle("bs-post--staged", staged);
      var chip = post.querySelector(".bs-post__staged");
      if (!staged) { if (chip) chip.remove(); return; }
      if (chip) return;
      chip = doc.createElement("button");
      chip.type = "button";
      chip.className = "bs-post__staged";
      chip.title = "This post is in a bundle you have not uploaded yet. Open the checklist.";
      chip.textContent = "not uploaded yet";
      chip.addEventListener("click", function () { bcWizDone(bcRecordLoad()); });
      var by = post.querySelector(".bs-post__by") || post;
      by.appendChild(chip);
    });
  }
  /* The zip again, from the layer. The images are gone with the page
     load that made them, so the file says which they were and where to
     find them. */
  function bcDownloadAgain(rec) {
    var enc = new TextEncoder();
    var parts = Object.keys(rec.files || {}).sort().map(function (n) {
      return { name: n, bytes: enc.encode(rec.files[n]) };
    });
    if ((rec.images || []).length) {
      parts.push({ name: "MISSING-IMAGES.txt", bytes: enc.encode(
        "# This zip was built again from the staging layer, which keeps text only.\n" +
        "# These image files were in the original zip and are NOT in this one.\n" +
        "# Extract the original zip for them, or publish the post again from its images:\n" +
        rec.images.join("\n") + "\n") });
    }
    TOOL.download(rec.zip.replace(/\.zip$/, "-again.zip"), TOOL.zip(parts));
  }

  /* Step three. What happened, where the zip went, what is in it, and the
     list to work through. The list is the person's, because the page cannot
     see the repo. The last box is the page's, and it ticks itself when the
     site shows the post. */
  function bcWizDone(rec) {
    var esc = TOOL.escAttr;
    var w = bcWizShow("done",
      rec.kind === "delete" ? "Deletion bundle built for p" + rec.id
      : rec.kind === "rebuild" ? "Rebuild bundle built"
      : (rec.edit ? "Republished p" : "Published p") + rec.id);
    var checks = rec.checks || {};
    var items = [
      ["extract", "Extract <code>" + esc(rec.zip) + "</code> at the repo root"],
      ["review", "Review the diff"]
    ];
    if (rec.orphans && rec.orphans.length) {
      items.push(["orphans", "Delete the files in <code>ORPHANS.txt</code>"]);
    }
    items.push(["commit", "Commit"], ["push", "Push"]);
    var shows = rec.kind === "delete" ? "The site no longer shows the post"
      : rec.kind === "rebuild" ? "The site shows the rebuild"
      : "The site shows the post";
    w.body.innerHTML =
      "<p>Your browser saved <code>" + esc(rec.zip) + "</code> to its Downloads folder.</p>" +
      "<p>The bundle holds:</p>" +
      '<div class="bc-wiz__files">' + bcFileChips(rec.spliced || [], "spliced") +
      bcFileChips(rec.regenerated || [], "regenerated") + bcFileChips(rec.added || [], "added") + "</div>" +
      BC_LEGEND +
      (rec.orphans && rec.orphans.length
        ? "<p><strong>Delete these files before you commit.</strong> The engine cannot remove a file from the repo:</p>" +
          '<div class="bc-wiz__files">' + bcFileChips(rec.orphans, "orphan") + "</div>"
        : "") +
      (rec.url ? '<p>The post\'s address when it is live: <a href="' + esc(rec.url) +
        '" target="_blank" rel="noopener">' + esc(rec.url) + "</a></p>" : "") +
      (rec.stamp ? "<p>Publish stamp: <code>" + esc(rec.stamp) + "</code></p>" : "") +
      "<p><strong>Your list.</strong> Tick each step when you do it. The list is kept until " +
      "the site shows the change.</p>" +
      '<ul class="bc-wiz__checks">' + items.map(function (it) {
        return '<li><label><input type="checkbox" data-check="' + it[0] + '"' +
          (checks[it[0]] ? " checked" : "") + " /><span>" + it[1] + "</span></label></li>";
      }).join("") +
      '<li><label><input type="checkbox" data-check="live" disabled' +
      (checks.live ? " checked" : "") + " /><span>" + shows +
      ". This box ticks itself after you reload.</span></label></li></ul>" +
      (rec.overSize
        ? "<p><strong>This bundle is too large to stage.</strong> Upload it before you " +
          "make another post, or the next bundle will not carry it.</p>"
        : "<p>You can compose another post now. The next bundle carries this one too, " +
          "so the newest zip is always the whole of what you have not uploaded.</p>");
    w.body.addEventListener("change", function (e) {
      var cb = e.target;
      var key = cb && cb.getAttribute ? cb.getAttribute("data-check") : null;
      if (!key) return;
      rec.checks = rec.checks || {};
      rec.checks[key] = !!cb.checked;
      bcRecordSave(rec);
    });
    var close = function () { bcWizClose(); };
    bcWizBtn("Close", "", close);
    if (rec.files && Object.keys(rec.files).length) {
      bcWizBtn("Download again", "", function () { bcDownloadAgain(rec); });
    }
    if (bcNoRemind()) {
      var again = bcWizBtn("Show the reminder again", "", function () {
        bcSetNoRemind(false);
        if (again.parentNode) again.parentNode.removeChild(again);
      });
    }
    bcWizSpacer();
    bcWizBtn("Compose another", "ced-btn--accent", function () {
      bcWizClose();
      /* the composer that published is finished with: openComposer
         refuses to open over one that is still on screen, so this button
         would otherwise do nothing at all */
      bcClose();
      if (!TOOL.editorOn()) window.edit();
      openComposer(null);
    }).focus();
    w.onEscape = close;
  }

  /* Step four. Nothing was written, and the composer keeps the post. */
  function bcWizFail(err, what) {
    var w = bcWizShow("failed", what + " failed");
    var msg = err && err.message ? err.message : String(err);
    var code = err && err.code ? err.code : "";
    w.body.innerHTML =
      "<p>" + TOOL.escAttr(msg) + "</p>" +
      "<p><strong>Nothing was written.</strong> " +
      (code === "BLG-E07"
        ? "You cancelled the file hand-off. Publish again when the files are at hand."
        : code === "BLG-E11"
        ? "Save the draft, reload the page, and compose again."
        : "Fix the cause and publish again. The composer keeps your post.") + "</p>";
    var close = function () { bcWizClose(); };
    bcWizSpacer();
    bcWizBtn("Close", "ced-btn--accent", close).focus();
    w.onEscape = close;
  }

  /* ==========================================================
     5. GENERATORS
     ----------------------------------------------------------
     Render a post, render a month page, parse a month page back into posts,
     and load one of those posts into the composer. The parse side has to
     match the render side exactly, which is why they live together.

     Every generated file says so in its first comment. A machine-owned file
     is written again at the next publish, and a hand edit is lost.
     ========================================================== */
  var BC_TAG_RE_G = /\[(img|png)(\d{4})(?:,[^\]|]*)?(?:\|[^\]]*)?\]/g;

  /* meta is {format, time, zone, tags}: the format is "md" or "html", the
     time is HHMM or "", the zone and the tags are text. The article carries
     the facts as attributes and the source block carries the format, so a
     republish and a rebuild read back what was written. A post with no
     title is written with an empty data-title and no h2; the manifest has
     the derived title, and the empty attribute is what says it was derived. */
  function bcRenderArticle(id, date, title, source, meta) {
    var m = meta || {};
    var format = m.format === "md" ? "md" : "html";
    var post = { id: id, date: date, title: title || "", time: m.time || "",
                 zone: m.zone || "", tags: m.tags || "", format: format,
                 source: source, staticBody: "" };
    var tail = '        <scr' + 'ipt type="text/x-blog-source" data-format="' + format + '">\n' +
      AMH.blog.encodeSource(source) + "\n" + "</scr" + "ipt>\n";
    return "      <!-- ===== POST " + id + " · " + date + " ===== -->\n" +
      bcPostMarkup(post, "      ", bcBrand, BC_WHERE.month, tail) + "\n" +
      "      <!-- ===== /POST " + id + " ===== -->";
  }
  /* The wordmark for a month page's bylines. bcSiteMeta reads it from the
     page being viewed, and every render path passes through a month
     render that has the meta in hand, so it is set there rather than
     threaded through bcRenderArticle's four callers. */
  var bcBrand = "AARON M. HARRIS";
  /* The manifest needs a name for every post. With no title it is the
     first six words of the body, cut on a word, with no trailing
     punctuation. The entry does not say it is derived; the article's empty
     data-title does. */
  function bcDerivedTitle(source, format) {
    var text = format === "md" && AMH.markdown ? AMH.markdown.text(source)
      : String(source || "").replace(BC_TAG_RE_G, " ").replace(/<[^>]+>/g, " ");
    var words = text.replace(/[|<>]/g, "").split(/\s+/).filter(Boolean);
    var t = words.slice(0, 6).join(" ").replace(/[.,;:!?]+$/, "");
    return t + (words.length > 6 ? "..." : "");
  }
  /* The tags as stored: no #, one space between, no repeats. */
  function bcTagsClean(text) {
    var seen = {}, out = [];
    String(text || "").split(/[\s,]+/).forEach(function (t) {
      t = t.replace(/^#+/, "").replace(/[|<>"]/g, "");
      if (t && !seen[t.toLowerCase()]) { seen[t.toLowerCase()] = true; out.push(t); }
    });
    return out.join(" ");
  }

  function bcIso() { return new Date().toISOString().slice(0, 10); }

  /* One month file from its blocks: sorted, joined, and stamped. The stamp
     is the hash of the joined blocks, so a month a publish does not touch,
     or a rebuild renders again the same, keeps the stamp it has. The
     manifest carries the same stamp on the month's line, and a hand-off
     compares the two. */
  function bcMonthText(yymm, blocks, meta, prev, months) {
    var joined = bcSortBlocks(blocks).map(function (b) { return b.text; }).join("\n");
    var ms = TOOL.stamp(joined);
    return { stamp: ms, text: bcMonthSkeleton(yymm, joined, meta, prev || null, ms, months) };
  }
  /* The chain. months is newest first, as bcUniqueMonths gives it, and
     both work whether yymm is in the list or not: the month before it is
     the first one older, the month after it is the last one newer. */
  function bcPrevOf(months, yymm) {
    for (var i = 0; i < months.length; i++) if (months[i] < yymm) return months[i];
    return null;
  }
  function bcNewerOf(months, yymm) {
    var out = null;
    months.forEach(function (m) { if (m > yymm) out = m; });
    return out;
  }
  /* The neighbour rule. A month needs to know only the month before it,
     and for forward posting that never changes. When an operation creates
     a month, or empties one, the month after it has a wrong prev: this
     fetches that one month, reparses it, and writes it again with the prev
     the final month list gives it. Nothing else is touched. A month the
     bundle already holds was rendered with the right prev. */
  function bcRepairNewer(files, touched, months, yymm, deployed, meta, blocksFor) {
    var newer = bcNewerOf(months, yymm);
    if (!newer || files["blog/" + newer + ".html"]) return Promise.resolve();
    return bcFetchMonth(newer, deployed).then(function (text) {
      if (text === null) return;
      var blocks = bcParseMonthBlocks(text);
      if (!blocks.length) return;
      var mt = bcMonthText(newer, blocks, meta, bcPrevOf(months, newer), months);
      files["blog/" + newer + ".html"] = new TextEncoder().encode(mt.text);
      touched[newer] = mt.stamp;
      if (blocksFor) blocksFor[newer] = blocks;
      console.info("[blog] blog/" + newer + ".html written again: the month before it is now " +
        (bcPrevOf(months, newer) || "none") + ".");
    });
  }
  /* The one comment every generated file opens with. The stamp is what
     ties a file to the publish that wrote it. */
  function bcGenerated(stamp) {
    return "GENERATED by the blog.html publish engine on " + bcIso() +
      "; stamp:" + stamp + "; hand edits are overwritten";
  }

  /* The first letter of each word of the wordmark, so "AARON M. HARRIS"
     gives "AMH". The month bar shows this instead of the full name on a
     narrow screen. It is derived and not fixed, so a change to the
     wordmark carries into the month files at the next publish. */
  function bcMonogram(brand) {
    return String(brand).split(/\s+/).filter(Boolean)
      .map(function (w) { return w.charAt(0); }).join("").toUpperCase();
  }

  /* meta is the site meta from bcSiteMeta; prev is the month before this
     one, or null for the first month. The chain runs backward only:
     reading runs back in time, so a month needs to know only the month
     before it. The two script tags are site.js and blog.js, for the loader
     that walks the chain in place; neither tool.js nor publish.js loads
     here, because a month file is generated, not managed. */
  function bcMonthSkeleton(yymm, blocksJoined, meta, prev, stamp, months) {
    var B = AMH.blog;
    var base = meta.base, fontHref = meta.fontHref, brand = meta.brand;
    var mt = B.monthTitle(yymm);
    var pageTitle = "Aaron M. Harris · Blog · " + mt;
    var descr = "Thoughts, musings, and fun new developments from Aaron M. Harris";
    var url = base + "blog/" + yymm + ".html";
    var older = prev
      ? '    <a class="bm-older" href="' + prev + '.html" rel="prev">Older posts: ' + B.monthTitle(prev) + "</a>\n"
      : '    <p class="bm-older bm-older--end">This is the first month.</p>\n';
    return "<!DOCTYPE html>\n" +
      "<!-- " + bcGenerated(stamp) + " -->\n" +
      '<html lang="en">\n<head>\n' +
      '  <meta charset="UTF-8" />\n' +
      '  <meta name="viewport" content="width=device-width, initial-scale=1.0" />\n' +
      "  <title>" + pageTitle + "</title>\n" +
      '  <meta name="description" content="' + descr + '" />\n' +
      '  <link rel="canonical" href="' + url + '" />\n' +
      '  <link rel="alternate" type="application/atom+xml" title="' + brand +
      ' - Blog" href="../feed.xml" />\n' +
      (prev ? '  <link rel="prev" href="' + prev + '.html" />\n' +
              '  <link rel="prefetch" href="' + prev + '.html" />\n' : "") +
      '  <meta property="og:type" content="website" />\n' +
      '  <meta property="og:site_name" content="Aaron M. Harris" />\n' +
      '  <meta property="og:title" content="' + pageTitle + '" />\n' +
      '  <meta property="og:description" content="' + descr + '" />\n' +
      '  <meta property="og:url" content="' + url + '" />\n' +
      '  <meta property="og:image" content="' + base + 'og-image.png" />\n' +
      '  <meta property="og:image:width" content="1200" />\n' +
      '  <meta property="og:image:height" content="630" />\n' +
      '  <meta property="og:image:alt" content="Aaron M. Harris — Technical Lead & Solutions Architect." />\n' +
      '  <meta name="twitter:card" content="summary_large_image" />\n' +
      '  <meta name="twitter:title" content="' + pageTitle + '" />\n' +
      '  <meta name="twitter:description" content="' + descr + '" />\n' +
      '  <meta name="twitter:image" content="' + base + 'og-image.png" />\n' +
      '  <link rel="preconnect" href="https://fonts.googleapis.com" />\n' +
      '  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />\n' +
      '  <link href="' + fontHref + '" rel="stylesheet" />\n' +
      '  <link rel="stylesheet" href="../site.css" />\n' +
      "</head>\n" +
      '<body class="blog-month">\n' +
      '  <div class="blog-wrap">\n' +
      /* The heading, which scrolls away, and then the bar, which sticks.
         blog.html has the same two above its stream, so a reader who
         lands here from a search engine sees the blog and not a plainer
         copy of it.

         The month name and the stream link sit in the heading and not in
         the bar. The bar holds one row at every width, and a 600px
         measure cannot fit five items on one row. */
      '    <div class="bm-top">\n' +
      '      <span class="eyebrow">' + (meta.eyebrow || "Blog") + "</span>\n" +
      '      <h1 class="bm-top__month">' + mt + "</h1>\n" +
      '      <a class="textlink bm-top__stream" href="../blog.html?b=' + yymm +
      '">Read in the full stream</a>\n' +
      "    </div>\n" +
      /* Three items, three jobs, the same three blog.html carries: the
         wordmark goes home, the find slot takes the search pill, and the
         picker jumps to another month. The monogram replaces the
         wordmark on a narrow screen, where the full name would squeeze
         the search box under its floor. */
      '    <div class="bs-bar" id="blogBar">\n' +
      '      <a class="bs-bar__name" href="../index.html">' +
      '<span class="bs-bar__full">' + brand + "</span>" +
      '<span class="bs-bar__short">' + bcMonogram(brand) + "</span></a>\n" +
      '      <div class="bs-bar__find" id="blogFind"></div>\n' +
      '      <select class="bs-bar__month" id="blogMonth" aria-label="Jump to a month"></select>\n' +
      "    </div>\n" +
      "    <main>\n" +
      blocksJoined + "\n" +
      "    </main>\n" +
      older +
      '    <footer class="bm-foot">© ' + ("20" + yymm.slice(0, 2)) + " Aaron M. Harris · Traverse City, MI</footer>\n" +
      "  </div>\n" +
      /* The months, for the picker. A month page has no manifest of its
         own and needs no entries: the one thing the picker reads is the
         month list, and blog.js takes this line as it takes the list it
         derives from the entries on blog.html. */
      '  <scr' + 'ipt id="blogManifest" type="text/plain" data-ced="blog">\n' +
      "months:" + (months || [yymm]).join(" ") + "\n" +
      "</scr" + "ipt>\n" +
      '  <script defer src="../site.js"></script>\n' +
      '  <script defer src="../work.js"></script>\n' +
      '  <script defer src="../blog.js"></script>\n' +
      "</body>\n</html>\n";
  }

  /* parse an existing (generated or fixture) month file back into article
     blocks so a new post can merge in; blocks are carried verbatim */
  function bcParseMonthBlocks(text) {
    var re = /[ \t]*<!-- ===== POST (\d{4}) · (\d{6}) ===== -->[\s\S]*?<!-- ===== \/POST \1 ===== -->/g;
    var out = [], m;
    while ((m = re.exec(text))) {
      out.push({ id: m[1], date: m[2], text: m[0].replace(/^\n+/, "") });
    }
    return out;
  }

  /* recover a post's identity + authoring source from its article block.
     The embedded x-blog-source is the lossless path; the rendered body is
     the lossy last resort (image tags stay as rendered markup). */
  function bcUnescAttr(s) {
    return String(s).replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&amp;/g, "&");
  }
  /* the format attribute is absent on a block from before V047, and that
     absence means html */
  var BC_SRC_RE = new RegExp("<scr" + "ipt type=\"text/x-blog-source\"(?: data-format=\"(md|html)\")?>\\n([\\s\\S]*?)\\n</scr" + "ipt>");
  /* Both shapes: a month file written before V051 carries blog-post, and
     one written since carries the stream's own bs-post. The identity
     attributes and their order are the same in both. */
  var BC_META_RE = /<article class="(?:blog-post|bs-post)" id="p(\d{4})" data-id="\d{4}" data-date="(\d{6})"(?: data-time="(\d{0,4})")?(?: data-zone="([^"]*)")?(?: data-tags="([^"]*)")? data-title="([^"]*)"/;
  function bcExtractPost(blockText) {
    var meta = BC_META_RE.exec(blockText);
    var srcM = BC_SRC_RE.exec(blockText);
    /* lossy-fallback body: string ops, not a lazy regex - a nested </div>
       inside the body (galleries etc.) must not truncate the recovery */
    var staticBody = "";
    var open = /<div class="(?:blog-post|bs-post)__body">/.exec(blockText);
    if (open) {
      var tail = blockText.indexOf("</article>", open.index);
      var span = blockText.slice(open.index, tail === -1 ? blockText.length : tail);
      var lastDiv = span.lastIndexOf("</div>");
      if (lastDiv !== -1) {
        staticBody = span.slice(open[0].length, lastDiv)
          .replace(/^\n+/, "").replace(/\s+$/, "");
      }
    }
    return {
      id: meta ? meta[1] : null,
      date: meta ? meta[2] : null,
      time: meta && meta[3] ? meta[3] : "",
      zone: meta && meta[4] ? bcUnescAttr(meta[4]) : "",
      tags: meta && meta[5] ? bcUnescAttr(meta[5]) : "",
      title: meta ? bcUnescAttr(meta[6]) : "",
      format: srcM && srcM[1] === "md" ? "md" : "html",
      source: srcM ? AMH.blog.decodeSource(srcM[2]) : null,
      staticBody: staticBody
    };
  }
  /* the facts a rendered article carries, from an extracted post */
  function bcMetaOf(post) {
    return { format: post.format, time: post.time, zone: post.zone, tags: post.tags };
  }

  /* open a PUBLISHED post in the composer */
  function bcLoadPost(id) {
    TOOL.injectStyles();
    TOOL.armGuard();
    if (bcPanel && bcPanel.parentNode) {
      console.warn("[blog] close the open composer first.");
      return "composer already open";
    }
    var man = AMH.blog.parseManifest();
    var entry = null;
    man.entries.forEach(function (e) { if (e.id === id) entry = e; });
    if (!entry) {
      console.warn("[blog] no post with id " + id + " in the manifest.");
      return "unknown post id";
    }
    var yymm = entry.date.slice(0, 4);
    fetch("blog/" + yymm + ".html", { cache: "no-store" })
      .then(function (res) {
        if (!res.ok) throw new Error("blog/" + yymm + ".html HTTP " + res.status);
        return res.text();
      })
      .then(function (text) {
        var block = null;
        bcParseMonthBlocks(text).forEach(function (b) { if (b.id === id) block = b; });
        if (!block) throw new Error("post p" + id + " not found in blog/" + yymm + ".html");
        var post = bcExtractPost(block.text);
        var source = post.source;
        if (source === null) {
          if (!window.confirm("This post has no embedded authoring source (hand-made or foreign file).\n\n" +
              "Load the RENDERED body instead? Image tags will appear as raw markup (lossy last resort).")) {
            return;
          }
          source = post.staticBody;
        }
        /* the title from the article, not the manifest: an empty data-title
           says the manifest's is derived, and the field opens empty again */
        openComposer({ id: id, date0: entry.date, title0: post.title, source0: source,
                       format0: post.format, time: post.time, zone: post.zone, tags: post.tags });
        bcDate.value = entry.date;
        bcTitle.value = post.title;
        bcBody.value = source;
        bcRefreshCounts();
        bcLoadPublishedImages(source, entry.date);
        bcSetStatus(post.format === "html"
          ? "This post was written in HTML. It stays HTML. Write new posts in Markdown."
          : "Editing published post p" + id + ". Publish writes its month file again" +
            " (and the old one, if you change the month).");
      })
      .catch(function (err) {
        console.error("[blog] load failed:", err.message);
      });
    return "loading p" + id;
  }

  /* image tags in a published post become locked cards: thumbnail from the
     server, number/format fixed, caption/alt editable, Remove orphans the file */
  function bcLoadPublishedImages(source, date0) {
    var re = /\[(img|png)(\d{4})(?:,([^\]|]*))?(?:\|([^\]]*))?\]/g, m;
    var seen = {};
    while ((m = re.exec(source))) {
      if (seen[m[2]]) continue;
      seen[m[2]] = true;
      var fmt = m[1] === "png" ? "png" : "jpg";
      var im = {
        num: m[2], fmt: fmt,
        caption: (m[3] || "").trim(), alt: (m[4] || "").trim(),
        blob: null, previewURL: "blog/" + date0 + "_img" + m[2] + "." + fmt,
        origBlob: null, origName: "(published)", w: 0, h: 0, bmp: null,
        published: true, date0: date0
      };
      bcImages.push(im);
      bcCards.appendChild(bcRenderCard(im, null));
    }
  }
  /* The highlights block: the newest few posts as static HTML, for the home
     page. Rendered from the manifest this publish writes, so the block
     and the blog cannot disagree - the block is never stored anywhere else.

     Returns the innerHTML of the region's element. The element itself, with
     its class and its data-ced, belongs to the page and survives the splice.

     Entries are oldest-first in the manifest, so the newest few are the tail,
     read backwards. */
  function bcHighlights(entries) {
    var B = AMH.blog;
    var rows = entries.slice(-HL_COUNT).reverse().map(function (e) {
      return '          <a class="latest__item" href="blog/' + e.date.slice(0, 4) +
        ".html#p" + e.id + '">\n' +
        '            <time datetime="' + B.dateTime(e.date) + '">' +
        B.dateLabel(e.date) + "</time>\n" +
        '            <span class="latest__title">' + TOOL.escAttr(e.title) + "</span>\n" +
        "          </a>";
    });
    return "\n" + rows.join("\n") + "\n" +
      '          <a class="textlink latest__all" href="blog.html">All posts</a>\n' +
      "        ";
  }

  /* ---------------- the stream ----------------

     blog.html carries the newest month's posts in full, in a region the
     publish owns. A reader who opens the page sees the newest month with
     no fetch, from disk as well as over http, and the loader in blog.js
     appends the months before it on the live site.

     The full text of an older post lives in its month file and nowhere
     else. The newest month is the one exception: its posts are in the
     stream and in its own file, which is bounded to one month, and each
     page is canonical for itself.

     The stream never carries a source block. The source lives in the
     month file, so a post's source is in exactly one place. */

  /* The byline's name and picture come from the page, not from here: the
     wordmark is editable copy, and the portrait is the asset the home page
     already ships. A rename in the editor reaches the stream at the next
     publish that writes it. */
  var STREAM_AVATAR = "aaron-portfolio-portrait-transparent.png";

  /* One post, in the markup both surfaces share.

     `where` says which surface. The stream sits at the site root and a
     month page sits in blog/, and they differ in three places and nowhere
     else: the id prefix, what a path is relative to, and where the
     timestamp points. So one function writes both and the two cannot
     drift apart.

     The id is "s" plus the post number in the stream and "p" plus the
     number on a month page. Both are in one document once the loader
     appends a month, so they cannot be the same string. The timestamp is
     the link to the post's own page, which is the social way and the
     honest one; on that page it is the anchor of the post itself.

     `tail` is what goes inside the article after the body, which is the
     source block on a month page and nothing in the stream.

     blog.js builds the same shape in the DOM when it appends a month
     block written before this version. The suite compares the two. */
  var BC_WHERE = {
    stream: { id: "s", img: "", tag: "blog.html?t=",
              when: function (p) { return "blog/" + p.date.slice(0, 4) + ".html#p" + p.id; } },
    month: { id: "p", img: "../", tag: "../blog.html?t=",
             when: function (p) { return "#p" + p.id; } }
  };
  function bcPostMarkup(post, indent, brand, where, tail) {
    var B = AMH.blog;
    var esc = TOOL.escAttr;
    var body = post.source === null ? post.staticBody
      : B.renderBody(post.format === "md" ? AMH.markdown.render(post.source) : post.source,
                     post.date, "static", where.img);
    /* a carried body was rendered for a page in blog/; in the stream the
       one step up comes off its paths */
    if (post.source === null && where.img === "") body = bcStreamStatic(body);
    var when = B.dateLabel(post.date) + (post.time ? " · " + bcTimeLabel(post.time) : "");
    var tags = bcTagList(post.tags).map(function (t) {
      return '<a href="' + where.tag + encodeURIComponent(t) + '">#' + esc(t) + "</a>";
    });
    return indent + '<article class="bs-post" id="' + where.id + post.id + '" data-id="' + post.id +
      '" data-date="' + post.date + '" data-time="' + (post.time || "") +
      '" data-zone="' + esc(post.zone || "") + '" data-tags="' + esc(post.tags || "") +
      (where.id === "p" ? '" data-title="' + esc(post.title || "") : "") + '">\n' +
      indent + '  <header class="bs-post__by">\n' +
      indent + '    <img class="bs-post__avatar" src="' + where.img + STREAM_AVATAR + '" alt="" />\n' +
      indent + "    <b>" + esc(brand) + "</b>\n" +
      indent + '    <a class="bs-post__when" href="' + where.when(post) + '">' +
      '<time datetime="' + B.dateTime(post.date) +
      (post.time ? "T" + post.time.slice(0, 2) + ":" + post.time.slice(2) : "") + '">' +
      esc(when) + "</time>" +
      (post.zone ? '<span class="bs-post__zone">' + esc(post.zone) + "</span>" : "") +
      "</a>\n" +
      indent + "  </header>\n" +
      (post.title ? indent + '  <h3 class="bs-post__title">' +
        esc(post.title).replace(/&quot;/g, '"') + "</h3>\n" : "") +
      indent + '  <div class="bs-post__body">\n' + body + "\n" + indent + "  </div>\n" +
      (tags.length ? indent + '  <div class="bs-post__tags">' + tags.join(" ") + "</div>\n" : "") +
      (tail || "") +
      indent + "</article>";
  }
  /* A post with no source block is carried from its rendered body, which
     was written for a page in blog/. The stream is at the root, so the one
     step up comes off its paths. */
  function bcStreamStatic(body) {
    return String(body || "").replace(/(src|href)="\.\.\//g, '$1="');
  }
  function bcTagList(tags) {
    return String(tags || "").split(/\s+/).filter(Boolean);
  }

  /* The region's inner HTML: every post of the newest month, newest first,
     then the way back to the month before it. */
  function bcStreamBlocks(blocks, prev, brand) {
    var posts = bcSortBlocks(blocks.slice()).map(function (b) {
      var post = bcExtractPost(b.text);
      return post.id ? bcPostMarkup(post, "          ", brand, BC_WHERE.stream, "") : "";
    }).filter(Boolean);
    if (!posts.length) {
      return '\n          <p class="bs-note">No posts yet - check back soon.</p>\n        ';
    }
    var older = prev
      ? '          <a class="bm-older" href="blog/' + prev + '.html" rel="prev">Older posts: ' +
        AMH.blog.monthTitle(prev) + "</a>"
      : '          <p class="bm-older bm-older--end">This is the first month.</p>';
    return "\n" + posts.join("\n") + "\n" + older + "\n        ";
  }
  function bcSpliceStream(src, inner) {
    var out = TOOL.spliceRegion(src, "blog-stream", inner);
    if (out === null) {
      console.warn("[blog] blog.html has no [blog-stream] region, so the stream was " +
        "not written. The post is published either way.");
      return src;
    }
    return out;
  }
  /* The stream shows the newest month, N. It is written again only when
     this operation has N's blocks in hand, which is when it wrote N's
     file, and when N is a different month than the deployed page shows.
     Otherwise the region stays byte for byte as it is.

     blocksFor holds the blocks of every month this operation rendered.
     deployed is the month list the loaded manifest held. */
  function bcStreamInto(src, months, blocksFor, brand, deployed) {
    var newest = months[0];
    if (!newest) return Promise.resolve(bcSpliceStream(src, bcStreamBlocks([], null, brand)));
    if (blocksFor[newest]) {
      return Promise.resolve(bcSpliceStream(src,
        bcStreamBlocks(blocksFor[newest], bcPrevOf(months, newest), brand)));
    }
    if (deployed[0] === newest) return Promise.resolve(src);   /* untouched */
    /* the newest month changed and this operation did not write it: read it */
    return bcFetchMonth(newest, deployed).then(function (text) {
      if (text === null) {
        console.warn("[blog] blog/" + newest + ".html could not be read, so the stream still " +
          "shows the month before it. A rebuild puts it right.");
        return src;
      }
      return bcSpliceStream(src,
        bcStreamBlocks(bcParseMonthBlocks(text), bcPrevOf(months, newest), brand));
    });
  }

  /* The public URL of a managed page. The home page is the site root: its
     canonical is the bare domain, and a sitemap that named index.html
     instead would be offering search engines a second URL for one page. */
  function bcPageURL(base, path) {
    return path === "index.html" ? base : base + path;
  }
  /* Every managed page, then every month file that has a post in it.

     The page half is read from AMH.tool.pages rather than written out here.
     That list is the one place a page is declared, so a page cannot be added
     to the site and left out of the sitemap. Phase 4 adds the gallery to it
     and this generator picks the gallery up with no change. */
  function bcSitemap(base, months, stamp) {
    var iso = bcIso();
    var urls = TOOL.pages.map(function (pg) {
      return "  <url><loc>" + bcPageURL(base, pg.path) + "</loc><lastmod>" + iso + "</lastmod></url>";
    });
    months.forEach(function (m) {
      urls.push('  <url><loc>' + base + "blog/" + m + ".html</loc><lastmod>" + iso + "</lastmod></url>");
    });
    return '<?xml version="1.0" encoding="UTF-8"?>\n' +
      "<!-- " + bcGenerated(stamp) + " -->\n" +
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
      urls.join("\n") + "\n</urlset>\n";
  }
  /* ---------------- the packed index ----------------

     search.js is everything the site knows about its posts, in one file
     a browser can search: base64 of gzip of JSON, in a classic script.
     A script tag loads from disk and a fetch does not, and reading this
     site from disk has to work.

     Gzip because the words of a blog would otherwise sit as a large
     plain block in every publish diff. The thumbnails do not compress,
     so they are kept tiny: 48 px on the long side, WebP, about a
     kilobyte each, and only for a post that has an image.

     blog.js owns the unpacker, and this file reads the deployed index
     through it, so the writer and the reader cannot disagree. */
  var SEARCH_FILE = "search.js";
  var THUMB_PX = 48;

  /* Base64 of bytes, in chunks: one apply() over a megabyte overflows
     the argument list. */
  function bcB64(bytes) {
    var out = "";
    for (var i = 0; i < bytes.length; i += 8192) {
      out += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
    }
    return btoa(out);
  }
  /* The file's text. A browser with no CompressionStream writes the
     table unpacked behind a "plain:" prefix the unpacker understands,
     so a publish is never blocked by a missing browser feature. */
  function bcSearchPack(table, stamp) {
    var json = JSON.stringify(table);
    var head = "/* " + bcGenerated(stamp) + " */\n";
    var line = function (payload) {
      return head + "window.AMH_SEARCH = \"" + payload + "\";\n";
    };
    if (typeof CompressionStream !== "function") {
      return Promise.resolve({
        text: line("plain:" + bcB64(new TextEncoder().encode(json))), plain: true });
    }
    var stream = new Blob([json]).stream().pipeThrough(new CompressionStream("gzip"));
    return new Response(stream).arrayBuffer().then(function (buf) {
      return { text: line(bcB64(new Uint8Array(buf))), plain: false };
    });
  }
  /* One entry, from an extracted post. The text is the post's words with
     the image tags taken out, and the captions are their own field, so a
     search can say which of the two it matched. */
  function bcSearchEntry(post, thumb) {
    var bare = String(post.source === null ? post.staticBody : post.source)
      .replace(BC_TAG_RE_G, " ");
    var text = post.format === "md" && post.source !== null && AMH.markdown
      ? AMH.markdown.text(bare)
      : bare.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    /* A scan of its own, and one that captures. This file's tag regex
       skips the caption and the alt with non-capturing groups, because
       every other caller only needs the number; here they are the whole
       point. It is also fresh each time, so no other caller's lastIndex
       can start this scan in the middle of the body. */
    var scan = /\[(?:img|png)\d{4}(?:,([^\]|]*))?(?:\|([^\]]*))?\]/g;
    var caps = [];
    var m;
    while ((m = scan.exec(String(post.source || "")))) {
      var words = [(m[1] || "").trim(), (m[2] || "").trim()].filter(Boolean).join(" ");
      if (words) caps.push(words);
    }
    return { id: post.id, date: post.date, time: post.time || "", zone: post.zone || "",
             title: post.title || "", tags: post.tags || "", text: text, caps: caps,
             thumb: thumb || "" };
  }
  /* A thumbnail from a bitmap the composer already holds, so a publish
     needs no fetch to make one. */
  function bcThumb(bmp) {
    var scale = Math.min(1, THUMB_PX / Math.max(bmp.width, bmp.height));
    var cv = doc.createElement("canvas");
    cv.width = Math.max(1, Math.round(bmp.width * scale));
    cv.height = Math.max(1, Math.round(bmp.height * scale));
    cv.getContext("2d").drawImage(bmp, 0, 0, cv.width, cv.height);
    return new Promise(function (resolve) {
      cv.toBlob(function (b) {
        if (!b) { resolve(""); return; }
        var fr = new FileReader();
        fr.onload = function () { resolve(String(fr.result)); };
        fr.onerror = function () { resolve(""); };
        fr.readAsDataURL(b);
      }, "image/webp", 0.6);
    });
  }
  /* The same, from a deployed image. Only a rebuild uses it, and only
     over http: from disk there is nothing to fetch, and the entry keeps
     the thumbnail it had. */
  function bcThumbFromURL(url) {
    return fetch(url, { cache: "no-store" })
      .then(function (res) { return res.ok ? res.blob() : null; })
      .then(function (b) { return b ? createImageBitmap(b) : null; })
      .then(function (bmp) { return bmp ? bcThumb(bmp) : ""; })
      .catch(function () { return ""; });
  }
  /* The first image a post uses, as a deployed path, or "". */
  function bcFirstImage(post) {
    var m = new RegExp(BC_TAG_RE_G.source).exec(String(post.source || ""));
    return m ? "blog/" + post.date + "_img" + m[2] + (m[1] === "png" ? ".png" : ".jpg") : "";
  }
  /* Read a deployed file that is not a page and not a month. Same shape
     as bcFetchMonth: null when it is genuinely not there, and the
     hand-off when the page was opened from disk. */
  function bcFetchText(path) {
    var staged = TOOL.layerFile(path);
    if (staged !== null) return Promise.resolve(staged);
    return fetch(path, { cache: "no-store" }).then(
      function (res) { return res.ok ? res.text() : null; },
      function (netErr) {
        return TOOL.handOff(path, netErr).then(null, function () { return null; });
      }
    );
  }
  /* Write the index again: read the deployed one, apply one change, pack.
     change is {entry} to add or replace, or {remove: id}, or nothing at
     all for a rebuild, which passes its whole table in `table`.

     Entries are sorted by date then id, newest last, as the manifest is,
     so the file's diff moves only where the blog moved. */
  function bcSearchWrite(files, deployed, change, stamp) {
    var unpack = (AMH.search && AMH.search.unpack)
      ? AMH.search.unpack(deployed || "")
      : Promise.resolve({ v: 1, stamp: "", posts: [] });
    return unpack.catch(function () { return { v: 1, stamp: "", posts: [] }; })
      .then(function (old) {
        var posts = (change && change.table) ? change.table
          : (old.posts || []).filter(function (e) {
              return !(change && (change.remove === e.id ||
                                  (change.entry && change.entry.id === e.id)));
            });
        if (change && change.entry) posts.push(change.entry);
        posts.sort(function (a, b) {
          return a.date === b.date ? (a.id < b.id ? -1 : 1) : (a.date < b.date ? -1 : 1);
        });
        return bcSearchPack({ v: 1, stamp: stamp, posts: posts }, stamp)
          .then(function (packed) { packed.posts = posts; return packed; });
      })
      .then(function (packed) {
        files[SEARCH_FILE] = new TextEncoder().encode(packed.text);
        if (packed.plain) {
          console.warn("[blog] this browser cannot compress, so search.js was written " +
            "unpacked. It still works; a publish from a browser that can will shrink it.");
        }
        return packed.posts;
      });
  }
  /* The thumbnail for the post being published: from the bytes the
     composer holds when the post has a new image, and the one the
     deployed index already has when it does not. */
  function bcPublishThumb(usedNew, post, deployed) {
    if (usedNew.length && usedNew[0].bmp) return bcThumb(usedNew[0].bmp);
    if (!bcFirstImage(post)) return Promise.resolve("");
    var unpack = (AMH.search && AMH.search.unpack)
      ? AMH.search.unpack(deployed || "") : Promise.resolve({ posts: [] });
    return unpack.catch(function () { return { posts: [] }; }).then(function (old) {
      var hit = (old.posts || []).filter(function (e) { return e.id === post.id; })[0];
      return hit ? hit.thumb || "" : "";
    });
  }

  /* ---------------- the feed ----------------

     Atom, because it needs only what the blog already has and never
     changes: a permanent id and a date. The id and the link are the
     post's own anchor on its month page, which never moves.

     A reader that is not a browser gets the twenty newest posts with a
     summary each. The whole post is one click away and stays one place,
     so the feed carries no copy of it. */
  var FEED_FILE = "feed.xml";
  var FEED_MAX = 20;
  var FEED_SUMMARY = 300;
  /* The zones this site writes, as offsets. A zone is a note a person
     typed, so one that is not here is no error: the entry then carries
     the date at midnight UTC, which is true and dateless rather than
     wrong and precise. */
  var FEED_ZONES = { UTC: 0, GMT: 0, EST: -300, EDT: -240, CST: -360, CDT: -300,
                     MST: -420, MDT: -360, PST: -480, PDT: -420,
                     BST: 60, CET: 60, CEST: 120, IST: 330, JST: 540, AEST: 600 };
  function feedOffset(zone) {
    var z = String(zone || "").trim().toUpperCase();
    if (FEED_ZONES[z] !== undefined) return FEED_ZONES[z];
    var m = /^(?:UTC|GMT)([+-])(\d{1,2})(?::?(\d{2}))?$/.exec(z);
    if (!m) return null;
    var mins = parseInt(m[2], 10) * 60 + parseInt(m[3] || "0", 10);
    return m[1] === "-" ? -mins : mins;
  }
  function feedWhen(entry) {
    var d = "20" + entry.date.slice(0, 2) + "-" + entry.date.slice(2, 4) + "-" + entry.date.slice(4, 6);
    var off = entry.time ? feedOffset(entry.zone) : null;
    if (!entry.time || off === null) return d + "T00:00:00Z";
    var sign = off < 0 ? "-" : "+";
    var a = Math.abs(off);
    return d + "T" + entry.time.slice(0, 2) + ":" + entry.time.slice(2) + ":00" + sign +
      ("0" + Math.floor(a / 60)).slice(-2) + ":" + ("0" + (a % 60)).slice(-2);
  }
  function feedSummary(text) {
    var t = String(text || "").trim();
    if (t.length <= FEED_SUMMARY) return t;
    var cut = t.slice(0, FEED_SUMMARY);
    var sp = cut.lastIndexOf(" ");
    return (sp > 40 ? cut.slice(0, sp) : cut) + "...";
  }
  /* One entry per post, newest first. titles holds the manifest's title
     for each id, which is the derived one for a post with none, because
     a feed reader shows a list and a list needs names. */
  function bcTitles(entries) {
    var out = {};
    entries.forEach(function (e) { out[e.id] = e.title; });
    return out;
  }
  function bcFeed(base, posts, titles, brand, stamp) {
    var esc = function (t) {
      return String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    };
    var newest = posts.slice().reverse().slice(0, FEED_MAX);
    var entries = newest.map(function (e) {
      var url = base + "blog/" + e.date.slice(0, 4) + ".html#p" + e.id;
      return "  <entry>\n" +
        "    <title>" + esc(titles[e.id] || e.title || "Post " + e.id) + "</title>\n" +
        '    <link href="' + esc(url) + '" />\n' +
        "    <id>" + esc(url) + "</id>\n" +
        "    <updated>" + feedWhen(e) + "</updated>\n" +
        '    <summary type="text">' + esc(feedSummary(e.text)) + "</summary>\n" +
        "  </entry>";
    });
    return '<?xml version="1.0" encoding="UTF-8"?>\n' +
      "<!-- " + bcGenerated(stamp) + " -->\n" +
      '<feed xmlns="http://www.w3.org/2005/Atom">\n' +
      "  <title>" + esc(brand) + " - Blog</title>\n" +
      '  <link href="' + base + '" />\n' +
      '  <link rel="self" href="' + base + FEED_FILE + '" />\n' +
      "  <id>" + base + FEED_FILE + "</id>\n" +
      "  <updated>" + bcIso() + "T00:00:00Z</updated>\n" +
      "  <author><name>" + esc(brand) + "</name></author>\n" +
      (entries.length ? entries.join("\n") + "\n" : "") +
      "</feed>\n";
  }

  /* Structure unchanged: it points at the sitemap. The base comes from the
     page's own og:url, so it follows CNAME rather than a second copy of it. */
  function bcRobots(base, stamp) {
    return "# " + bcGenerated(stamp) + "\n" +
      "User-agent: *\nAllow: /\nSitemap: " + base + "sitemap.xml\n";
  }

  /* ==========================================================
     6. BUNDLE AND PUBLISH
     ----------------------------------------------------------
     One publish for each page load. A bundle splices the deployed bytes of
     the pages it rewrites, so a second bundle would splice into bytes that
     no longer match the live site.

     The zip writer itself is AMH.tool.zip: a multi-page export ships a zip
     too, so it is not blog machinery.
     ========================================================== */
  /* The site root and the font link, read from the page that carries the
     manifest. Everything generated is built from the root, so it has to be
     the root and not a page inside it.

     og:url is that page's own URL. While the manifest lived on the home page
     the two were the same string; on blog.html they are not, so the page's
     own path comes off the end. Without that, every generated URL sits one
     level down a directory that does not exist. */
  function bcSiteMeta(src) {
    var base = (/<meta property="og:url" content="([^"]+)"/.exec(src) ||
      [null, "https://aaronmichaelharris.com/"])[1];
    var page = TOOL.currentPage();
    if (base.slice(-page.length) === page) base = base.slice(0, -page.length);
    if (base.slice(-1) !== "/") base += "/";
    var fontHref = (/<link href="(https:\/\/fonts\.googleapis\.com[^"]+)" rel="stylesheet"/.exec(src) ||
      [null, "https://fonts.googleapis.com/css2?family=Inter&display=swap"])[1];
    /* The wordmark, read rather than repeated. A month file carries the same
       brand as the site, and the brand is editable copy: a second copy here
       would mean a rename in the editor left every month file behind. */
    var brand = (/class="brand__title full">([^<]*)</.exec(src) ||
      [null, "AARON M. HARRIS"])[1];
    bcBrand = brand;
    /* The blog eyebrow, read for the same reason as the brand. A month
       page opens with it, and it is editable copy on blog.html. */
    var eyebrow = (/\[edit:blog-eyebrow\]-->\s*<span class="eyebrow">([^<]*)</.exec(src) ||
      [null, "Blog"])[1];
    return { base: base, fontHref: fontHref, brand: brand, eyebrow: eyebrow };
  }
  function bcUniqueMonths(entries) {
    var months = [];
    entries.slice().reverse().forEach(function (e) {
      var mo = e.date.slice(0, 4);
      if (months.indexOf(mo) === -1) months.push(mo);
    });
    return months;
  }
  /* The shared generated files every operation ships. src is the spliced
     source of the page that carries the manifest, which is the page being
     viewed; after Phase 3 that is blog.html rather than the home page. */
  function bcCommonFiles(files, src, entries, meta, stamp) {
    var enc = new TextEncoder();
    files[TOOL.currentPage()] = enc.encode(src);
    files["sitemap.xml"] = enc.encode(bcSitemap(meta.base, bcUniqueMonths(entries), stamp));
    files["robots.txt"] = enc.encode(bcRobots(meta.base, stamp));
  }
  /* Every managed page this bundle should carry, apart from the one holding
     the manifest, which the caller writes because only it has the spliced
     source.

     Two kinds of change end up here. The highlights block, staged for the
     home page; and any shared copy edit made during this sitting on a page
     the composer is not looking at. Both travel the editor's own multi-page
     path - pristine bytes, plus whatever is staged or pending for that page -
     so a publish writes exactly what an export would have.

     A page whose bytes come back unchanged is left out. An unchanged file in
     a diff is noise, and noise is what stops a diff from being read.

     Nothing here can fail the publish. A page that cannot be read or spliced
     is reported and dropped: the post is the thing the user came to do. */
  function bcOtherPages(files, entries) {
    if (entries.length) TOOL.stage(HL_PAGE, HL_SLUG, bcHighlights(entries));
    var here = TOOL.currentPage();
    var paths = TOOL.changedPages().filter(function (path) { return path !== here; });
    var enc = new TextEncoder();
    return Promise.all(paths.map(function (path) {
      return Promise.all([TOOL.pristine(path), TOOL.buildPage(path)])
        .then(function (both) {
          if (both[1].text !== both[0]) files[path] = enc.encode(both[1].text);
        }, function (err) {
          console.warn("[blog] " + path + " could not be written (" + err.message +
            ") and is left out of the bundle. The post is published either way.");
        });
    }));
  }

  /* Read one deployed month file. null means the month is genuinely not there,
     which callers already handle. A refused fetch is a different thing: the
     page was opened from disk, so ask for the file rather than report a month
     that does exist as missing. Cancelling the prompt gives the same null. */
  function bcFetchMonth(yymm, deployed) {
    var path = "blog/" + yymm + ".html";
    /* The manifest is the record of what has been published, and a month
       file exists only for a month with posts in it. So a month the manifest
       does not know cannot have a file, and asking for one is noise: it is
       the publish that is about to create it.

       deployed is the list of months the DEPLOYED manifest holds. Callers
       that have not read a manifest pass nothing and keep the old behaviour,
       which is to ask. */
    if (deployed && deployed.indexOf(yymm) === -1) {
      return Promise.resolve(null);
    }
    /* the staging layer first, as pristine() does: a month file this tab
       has written and not yet uploaded is the one the next bundle has to
       build on, or the post in it is lost */
    var staged = TOOL.layerFile(path);
    if (staged !== null) return Promise.resolve(staged);
    return fetch(path, { cache: "no-store" }).then(
      function (res) { return res.ok ? res.text() : null; },
      function (netErr) {
        return TOOL.handOff(path, netErr).then(null, function () { return null; });
      }
    );
  }
  function bcSortBlocks(blocks) {
    blocks.sort(function (a, b) {
      return a.date === b.date ? (a.id < b.id ? 1 : -1) : (a.date < b.date ? 1 : -1);
    });
    return blocks;
  }
  /* rec names the operation for the Done step: kind, edit, id, url, and the
     publish stamp the bundle's manifest carries. Which files were spliced
     is a fact the managed-page list already holds, and everything else in
     the bundle was written whole. */
  function bcFinishBundle(files, zipName, statusMsg, extraLog, rec) {
    var enc = new TextEncoder();
    var orphans = bcOrphans.filter(function (o, i) { return bcOrphans.indexOf(o) === i; });
    if (orphans.length) {
      files["ORPHANS.txt"] = enc.encode(
        "# Files no longer referenced after this publish.\n" +
        "# DELETE THESE FROM THE REPO BEFORE COMMITTING (the engine cannot remove server files):\n" +
        orphans.map(function (o) { return o; }).join("\n") + "\n");
    }
    var names = Object.keys(files).sort();
    TOOL.download(zipName, TOOL.zip(names.map(function (n) { return { name: n, bytes: files[n] }; })));
    console.info("[blog] bundle contents:\n  " + names.join("\n  ") + (extraLog ? "\n" + extraLog : ""));
    if (orphans.length) {
      console.warn("[blog] ORPHANED FILES - delete these from the repo before committing:\n  " +
        orphans.join("\n  "));
    }
    if (bcPanel && bcPanel.parentNode) bcSetStatus(statusMsg);
    /* the Publish button stays live: the layer means the next bundle
       builds on this one rather than fighting it */
    var managed = TOOL.pages.map(function (pg) { return pg.path; });
    var record = {
      kind: rec.kind, edit: !!rec.edit, id: rec.id || "", zip: zipName, url: rec.url || "",
      stamp: rec.stamp || "",
      spliced: names.filter(function (n) { return managed.indexOf(n) !== -1; }),
      regenerated: names.filter(function (n) {
        return managed.indexOf(n) === -1 && (/\.(html|xml|txt)$/.test(n) || n === SEARCH_FILE);
      }),
      added: names.filter(function (n) {
        return !/\.(html|xml|txt)$/.test(n) && n !== SEARCH_FILE;
      }),
      orphans: orphans,
      checks: { extract: false, review: false, orphans: false, commit: false, push: false, live: false },
      at: new Date().toISOString()
    };
    /* the layer: the text of this bundle, so the next one splices what
       this one wrote. Image bytes cannot be kept, so they are named. */
    var staged = {};
    var images = [];
    var dec = new TextDecoder();
    names.forEach(function (n) {
      if (/\.(html|xml|txt|js)$/.test(n)) staged[n] = dec.decode(files[n]);
      else images.push(n);
    });
    TOOL.layerKeep(record, staged, images);
    /* and onto the page, so a second post is composed against the first */
    TOOL.layerApply(true);
    bcStagedChips();
    var prog = bcProg;
    bcProg = null;
    if (prog) prog.mark(6);
    (prog ? prog.finish() : Promise.resolve()).then(function () { bcWizDone(record); });
  }

  /* ---------------- publish: a new post, or an edited one again ---------------- */
  function bcPublish() {
    var date = bcDate.value.trim();
    var title = bcTitle.value.replace(/[|<>]/g, "").trim();
    var source = bcBody.value.trim();
    var mm = parseInt(date.slice(2, 4), 10), dd = parseInt(date.slice(4, 6), 10);
    if (!/^\d{6}$/.test(date) || mm < 1 || mm > 12 || dd < 1 || dd > 31) {
      bcSetStatus("The date must be a valid YYMMDD."); return;
    }
    if (!source) { bcSetStatus("The post body is empty."); return; }
    /* the format is the composer's mode: Markdown for a new post, HTML
       for a post that was written in HTML */
    var format = bcMode;
    var time = bcTimeParse(bcTime.value);
    if (bcTime.value.trim() && !time) {
      bcSetStatus("The time must be h:mm am or HH:MM, or blank."); return;
    }
    var zone = bcZone.value.replace(/[|<>"]/g, "").trim();
    var tags = bcTagsClean(bcTags.value);
    /* the title is optional; the manifest still needs a name for the post,
       and the article's empty data-title says the name was derived */
    var entryTitle = title || bcDerivedTitle(source, format);
    /* the tag check runs on the rendered HTML, so raw HTML inside Markdown
       is still balanced before it reaches a page */
    var rendered = format === "md" ? AMH.markdown.render(source) : source;
    var problem = TOOL.tagCheck(rendered.replace(BC_TAG_RE_G, ""));
    if (problem && !window.confirm("Tag check: " + problem + "\n\nPublish anyway?")) {
      bcSetStatus("Not published. " + problem); return;
    }
    /* image tags vs image cards */
    var refs = {}, badFmt = [], m2;
    BC_TAG_RE_G.lastIndex = 0;
    while ((m2 = BC_TAG_RE_G.exec(source))) {
      refs[m2[2]] = m2[1];
    }
    var known = {};
    bcImages.forEach(function (im) { known[im.num] = im; });
    var dangling = Object.keys(refs).filter(function (n) { return !known[n]; });
    if (dangling.length) {
      bcSetStatus("These tags name images that are not in the Images tab: " + dangling.join(", ")); return;
    }
    Object.keys(refs).forEach(function (n) {
      var want = refs[n] === "png" ? "png" : "jpg";
      if (known[n].fmt !== want) badFmt.push(n + " (tag says ." + want + ", image is ." + known[n].fmt + ")");
    });
    if (badFmt.length) {
      bcSetStatus("A tag and its image do not agree on the format. Fix the tag prefix, or toggle the image: " + badFmt.join("; ")); return;
    }
    var usedNew = bcImages.filter(function (im) { return refs[im.num] && !im.published; });
    var usedPub = bcImages.filter(function (im) { return refs[im.num] && im.published; });
    var unusedNew = bcImages.filter(function (im) { return !refs[im.num] && !im.published; });
    var unusedPub = bcImages.filter(function (im) { return !refs[im.num] && im.published; });
    if (unusedNew.length && !window.confirm(unusedNew.length +
        " new image(s) have no tag in the body. They are not published:\n" +
        unusedNew.map(function (im) { return im.num; }).join(", ") + "\n\nPublish without them?")) {
      return;
    }
    if (unusedPub.length && !window.confirm(unusedPub.length +
        " published image(s) have no tag in the body now. Their files become orphans:\n" +
        unusedPub.map(function (im) { return im.previewURL; }).join("\n") + "\n\nContinue?")) {
      return;
    }
    unusedPub.forEach(function (im) { pushOrphan(im.previewURL); });
    /* A publish can rewrite more than one page now, so name them before it
       builds: an out-of-date repo turns a good splice into a silent revert.

       Two lists, because the two carry different risk. A spliced page keeps
       every byte outside its markers, so a stale copy silently reverts real
       work. A generated file is written whole, so a stale copy is
       replaced with nothing lost. The user should see which is which before saying yes. */
    var willWrite = TOOL.changedPages();
    if (willWrite.indexOf(TOOL.currentPage()) === -1) willWrite.push(TOOL.currentPage());
    var willReplace = ["blog/" + date.slice(0, 4) + ".html", "sitemap.xml", "robots.txt",
                       "search.js", "feed.xml"];
    if (bcEditing && bcEditing.date0.slice(0, 4) !== date.slice(0, 4)) {
      willReplace.unshift("blog/" + bcEditing.date0.slice(0, 4) + ".html");
    }
    /* the neighbour rule, from the manifest: a month this publish creates,
       or empties, leaves the month after it with a wrong prev, and that
       month is written again too, so the confirm step names it */
    var neighbours = bcNeighboursOf(date);
    neighbours.forEach(function (m) {
      if (willReplace.indexOf("blog/" + m + ".html") === -1) willReplace.splice(-2, 0, "blog/" + m + ".html");
    });
    var reads = bcPublishReads(date, willWrite, neighbours);
    bcWizConfirm(willWrite, willReplace)
      .then(function (go) { return go && bcWizFiles(reads); })
      .then(function (go) {
        if (!go) { bcSetStatus("Not published. Nothing was written."); return; }
        bcPublishBuild({ date: date, title: title, entryTitle: entryTitle, source: source,
                         meta: { format: format, time: time, zone: zone, tags: tags },
                         usedNew: usedNew, usedPub: usedPub, willWrite: willWrite, reads: reads });
      });
  }

  /* Everything a publish reads, decided before it starts, so a page opened
     from disk can ask for all of it in one step. The month files it may
     read are the ones the loaded manifest knows: a month outside the
     manifest has no file and is never asked for, and a month inside it may
     still be missing from someone's folder, so it is optional. The home
     page is read for the highlights block, and it is required because the
     block is written at every publish. */
  function bcPublishReads(date, willWrite, extra) {
    var here = TOOL.currentPage();
    var known = AMH.blog ? AMH.blog.parseManifest().months : [];
    var months = [date.slice(0, 4)].concat(extra || []);
    if (bcEditing && bcEditing.date0.slice(0, 4) !== months[0]) months.push(bcEditing.date0.slice(0, 4));
    var required = [here].concat(willWrite.filter(function (pp) { return pp !== here; }));
    if (required.indexOf(HL_PAGE) === -1) required.push(HL_PAGE);
    var optional = months.filter(function (m) { return known.indexOf(m) !== -1; })
      .map(function (m) { return "blog/" + m + ".html"; });
    /* the packed index: every publish rewrites it, and a site published
       before it existed has none, so it is read and may be absent */
    optional.push("search.js");
    return { required: required, optional: optional, all: required.concat(optional) };
  }

  /* The months the neighbour rule will write again, decided from the
     loaded manifest before the build: the month after a month this publish
     creates, and the month after a month it empties. */
  function bcNeighboursOf(date) {
    var man = AMH.blog ? AMH.blog.parseManifest() : { entries: [] };
    var yymm = date.slice(0, 4);
    var entries = man.entries.filter(function (e) { return !bcEditing || e.id !== bcEditing.id; });
    entries.push({ date: date, id: "0000", title: "" });
    var months = bcUniqueMonths(entries);
    var out = [];
    if (man.months.indexOf(yymm) === -1) {
      var n = bcNewerOf(months, yymm);
      if (n) out.push(n);
    }
    if (bcEditing) {
      var oldMonth = bcEditing.date0.slice(0, 4);
      if (oldMonth !== yymm && months.indexOf(oldMonth) === -1) {
        var n2 = bcNewerOf(months, oldMonth);
        if (n2 && out.indexOf(n2) === -1) out.push(n2);
      }
    }
    return out;
  }

  /* The build, after the person said yes. Each stage marks a progress row
     as it is reached, and the rows are named here in the order the chain
     runs them: the month file before the manifest, because the manifest
     carries the month file's stamp. */
  function bcPublishBuild(p) {
    var date = p.date, title = p.title, source = p.source, meta0 = p.meta;
    var entryTitle = p.entryTitle || title;
    var usedNew = p.usedNew, usedPub = p.usedPub;
    var yymm = date.slice(0, 4);
    bcSetStatus("Building the bundle.");
    bcProg = bcWizProgress([
      "Read the deployed blog.html",
      "Write blog/" + yymm + ".html",
      "Write the manifest and the index card",
      "Write sitemap.xml and robots.txt",
      usedNew.length ? "Add " + usedNew.length + " new image" + (usedNew.length === 1 ? "" : "s") : "No new images",
      "Write the other pages",
      "Zip the bundle"
    ]);
    var oldMonth = bcEditing ? bcEditing.date0.slice(0, 4) : null;
    /* Say what this publish will read before it starts. A page opened from
       disk cannot fetch its own bytes, and the hand-off shows the whole list
       and its progress rather than asking once per file with no context. */
    TOOL.expectFiles(p.reads.all);
    TOOL.expectOptional(p.reads.optional);
    var dateChanged = !!(bcEditing && bcEditing.date0 !== date);
    var files = {};   /* name -> Uint8Array */
    var enc = new TextEncoder();
    /* held across the chain: the page's source and manifest, the entry list
       this publish writes, and the stamp of each month file it renders */
    var meta, id, entries, man, src, deployed, stamps, months;
    var touched = {};     /* month -> the stamp of the file written for it */
    var blocksFor = {};   /* month -> its blocks, for the stream */
    TOOL.pristine()
      .then(function (text) {
        bcProg.mark(0);
        src = text;
        man = bcManifestFrom(src);
        /* the page was loaded from one manifest and the splice reads another:
           a publish built on the loaded one would drop what the live one
           gained, so it stops here */
        if (man.payload.trim() !== bcManAtOpen.trim()) throw TOOL.error("BLG-E11");
        /* what the deployed manifest knows, read before this post is added
           to it: that is the list of month files that can exist */
        deployed = bcUniqueMonths(man.entries);
        TOOL.expectOptional(deployed.map(function (m) { return "blog/" + m + ".html"; }));
        entries = man.entries.slice();
        if (bcEditing) {
          /* republish: the permanent id keeps its place unless the date moved */
          id = bcEditing.id;
          entries = entries.filter(function (e) { return e.id !== id; });
        } else {
          id = pad4(man.nextPost);
        }
        var at = entries.length;
        while (at > 0 && entries[at - 1].date > date) at--;
        entries.splice(at, 0, { date: date, id: id, title: entryTitle });
        /* the month list after this publish: every month rendered here
           takes its prev from it, and the neighbour rule reads it */
        months = bcUniqueMonths(entries);
        src = TOOL.spliceAllEdits(src);   /* outstanding copy/gallery edits ride along */
        meta = bcSiteMeta(src);
        /* target month: swap in the (re)rendered article */
        return bcFetchMonth(yymm, deployed);
      })
      .then(function (existing) {
        var blocks = existing ? bcParseMonthBlocks(existing) : [];
        if (existing && !blocks.length) {
          throw new Error("blog/" + yymm + ".html exists but could not be parsed. Is it a generated month file?");
        }
        blocks = blocks.filter(function (b) { return b.id !== id; });
        blocks.push({ id: id, date: date, text: bcRenderArticle(id, date, title, source, meta0) });
        var mt = bcMonthText(yymm, blocks, meta, bcPrevOf(months, yymm), months);
        files["blog/" + yymm + ".html"] = enc.encode(mt.text);
        touched[yymm] = mt.stamp;
        blocksFor[yymm] = blocks;
        bcProg.mark(1);
        /* cross-month move: regenerate the old month without this post,
           or orphan the whole file if this was its only post */
        if (!bcEditing || oldMonth === yymm) return;
        return bcFetchMonth(oldMonth, deployed).then(function (oldText) {
          if (oldText === null) return;   /* nothing deployed there - nothing to fix */
          var oldBlocks = bcParseMonthBlocks(oldText)
            .filter(function (b) { return b.id !== id; });
          if (oldBlocks.length) {
            var ot = bcMonthText(oldMonth, oldBlocks, meta, bcPrevOf(months, oldMonth), months);
            files["blog/" + oldMonth + ".html"] = enc.encode(ot.text);
            touched[oldMonth] = ot.stamp;
            blocksFor[oldMonth] = oldBlocks;
          } else {
            bcOrphans.push("blog/" + oldMonth + ".html");
          }
        });
      })
      .then(function () {
        /* a month created, or a month emptied: the month after it points
           at the wrong month now */
        var created = deployed.indexOf(yymm) === -1
          ? bcRepairNewer(files, touched, months, yymm, deployed, meta, blocksFor) : Promise.resolve();
        return created.then(function () {
          if (oldMonth && oldMonth !== yymm && months.indexOf(oldMonth) === -1) {
            return bcRepairNewer(files, touched, months, oldMonth, deployed, meta, blocksFor);
          }
        });
      })
      .then(function () {
        /* the manifest, stamped, and the stream, which shows the newest
           month; then the files every operation writes whole, each
           carrying the publish stamp */
        stamps = bcStamps(man, bcEditing ? man.nextPost : man.nextPost + 1,
          man.nextImg + bcImgCounter, entries, touched);
        var out = TOOL.spliceRegion(src, "blog-manifest", stamps.payload);
        if (out === null) throw new Error("The blog-manifest markers are not in the deployed blog.html.");
        return bcStreamInto(out, months, blocksFor, meta.brand, deployed);
      })
      .then(function (text) {
        src = text;
        bcProg.mark(2);
        bcCommonFiles(files, src, entries, meta, stamps.publish);
        bcProg.mark(3);
        /* new images: encoded for blog/, untouched originals for imgsources/ */
        return Promise.all(usedNew.map(function (im) {
          var ext = im.fmt === "png" ? ".png" : ".jpg";
          var origExt = (/\.[a-z0-9]+$/i.exec(im.origName) || [".bin"])[0];
          return im.blob.arrayBuffer().then(function (buf) {
            files["blog/" + date + "_img" + im.num + ext] = new Uint8Array(buf);
            return im.origBlob.arrayBuffer();
          }).then(function (obuf) {
            files["imgsources/" + date + "_img" + im.num + "_original" + origExt] = new Uint8Array(obuf);
          });
        }));
      })
      .then(function () {
        /* date change: published files carry the date in their names, and
           tags resolve via the post date - fetch the deployed bytes and
           re-emit them under the new prefix; old names become orphans */
        if (!dateChanged || !usedPub.length) return;
        return Promise.all(usedPub.map(function (im) {
          return fetch(im.previewURL, { cache: "no-store" }).then(function (res) {
            if (!res.ok) throw new Error("The published image " + im.previewURL +
              " could not be fetched (HTTP " + res.status + "). The new date needs it renamed.");
            return res.arrayBuffer();
          }).then(function (buf) {
            files["blog/" + date + "_img" + im.num + "." + im.fmt] = new Uint8Array(buf);
            pushOrphan(im.previewURL);
          });
        }));
      })
      .then(function () { bcProg.mark(4); return bcOtherPages(files, entries); })
      .then(function () {
        /* the packed index last: it is the one file that may not exist,
           and asking for it after the pages keeps the asks in the order
           the Files step lists them */
        return bcFetchText("search.js").then(function (deployed) {
          var post = { id: id, date: date, title: title, time: meta0.time, zone: meta0.zone,
                       tags: meta0.tags, format: meta0.format, source: source, staticBody: "" };
          return bcPublishThumb(usedNew, post, deployed).then(function (thumb) {
            return bcSearchWrite(files, deployed, { entry: bcSearchEntry(post, thumb) },
                                 stamps.publish);
          }).then(function (table) {
            files[FEED_FILE] = new TextEncoder().encode(
              bcFeed(meta.base, table, bcTitles(entries), meta.brand, stamps.publish));
          });
        });
      })
      .then(function () {
        bcProg.mark(5);
        bcPublished = true;
        TOOL.markExported();   /* copy/gallery edits rode along in the bundle */
        if (dateChanged && usedPub.length) {
          console.warn("[blog] the imgsources/ ORIGINALS for renamed images keep their old date " +
            "prefix (they are local-only; the engine cannot rename them). If you keep originals, " +
            "rename these by hand:\n  " + usedPub.map(function (im) {
              return "imgsources/" + bcEditing.date0 + "_img" + im.num + "_original.* -> imgsources/" +
                date + "_img" + im.num + "_original.*";
            }).join("\n  "));
        }
        bcFinishBundle(files, "blog-publish-" + date + ".zip",
          (bcEditing ? "Republished p" : "Published p") + id +
          ". Extract the zip at the repo root. Review the diff." +
          (bcOrphans.length ? " Delete the files in ORPHANS.txt." : "") +
          " Commit and push. Then reload this page before you compose again.",
          "[blog] post URL once live: " + meta.base + "blog/" + yymm + ".html#p" + id +
          (dateChanged && oldMonth !== yymm
            ? "\n[blog] note: links shared before the move still point at blog/" + oldMonth +
              ".html - re-share the new URL"
            : ""),
          { kind: "publish", edit: !!bcEditing, id: id, stamp: stamps.publish,
            url: meta.base + "blog/" + yymm + ".html#p" + id });
      })
      .catch(function (err) {
        bcProg = null;
        bcSetStatus("Publish failed: " + err.message);
        console.error("[blog] publish failed:", err);
        bcWizFail(err, "Publish");
      });
  }

  /* ---------------- delete: remove a published post ---------------- */
  function bcDeletePost() {
    if (!bcEditing) return;
    var id = bcEditing.id;
    var date0 = bcEditing.date0;
    var yymm = date0.slice(0, 4);
    /* every file the CURRENT source references becomes an orphan */
    var imgOrphans = [];
    var re = /\[(img|png)(\d{4})(?:,[^\]|]*)?(?:\|[^\]]*)?\]/g, m;
    while ((m = re.exec(bcEditing.source0))) {
      var f = "blog/" + date0 + "_img" + m[2] + "." + (m[1] === "png" ? "png" : "jpg");
      if (imgOrphans.indexOf(f) === -1) imgOrphans.push(f);
    }
    if (!window.confirm("Delete post p" + id + " (\"" + (bcEditing.title0 || bcDerivedTitle(bcEditing.source0, bcMode)) + "\")?\n\n" +
        "Its manifest entry is removed. Its month file is written again without it." +
        (imgOrphans.length
          ? "\nThese image files become orphans. Delete them by hand:\n  " + imgOrphans.join("\n  ")
          : "") +
        "\n\nThis builds a publish bundle. The post stays live until you upload the bundle.")) {
      return;
    }
    bcSetStatus("Building the deletion bundle.");
    var files = {};
    var meta, entries, man, stamps, months, deployed;
    var touched = {};
    var blocksFor = {};
    TOOL.expectFiles([TOOL.currentPage(), "blog/" + yymm + ".html"]);
    TOOL.pristine()
      .then(function (src) {
        man = bcManifestFrom(src);
        if (man.payload.trim() !== bcManAtOpen.trim()) throw TOOL.error("BLG-E11");
        entries = man.entries.filter(function (e) { return e.id !== id; });
        deployed = bcUniqueMonths(man.entries);
        /* the month after this one may be written again, if this delete
           empties the month, and the month before it may become the newest,
           which the stream shows; either may be missing from a folder */
        var after = bcUniqueMonths(entries);
        var newer = bcNewerOf(after, yymm);
        if (newer) TOOL.expectOptional(["blog/" + newer + ".html"]);
        if (after[0] && after[0] !== yymm) TOOL.expectOptional(["blog/" + after[0] + ".html"]);
        TOOL.expectOptional(["search.js"]);
        src = TOOL.spliceAllEdits(src);
        meta = bcSiteMeta(src);
        imgOrphans.forEach(function (f) {
          if (bcOrphans.indexOf(f) === -1) bcOrphans.push(f);
        });
        /* the post being deleted lives in this month, so its file must
           exist; a missing one is a real problem and is thrown below */
        return bcFetchMonth(yymm).then(function (text) {
          if (text === null) {
            /* never half-delete: dropping the manifest entry while the
               article stays live would strand the post outside the system */
            throw new Error("blog/" + yymm + ".html could not be fetched. The delete stops here.");
          }
          var blocks = bcParseMonthBlocks(text).filter(function (b) { return b.id !== id; });
          months = bcUniqueMonths(entries);
          var repair = Promise.resolve();
          if (blocks.length) {
            var mt = bcMonthText(yymm, blocks, meta, bcPrevOf(months, yymm), months);
            files["blog/" + yymm + ".html"] = new TextEncoder().encode(mt.text);
            touched[yymm] = mt.stamp;
            blocksFor[yymm] = blocks;
          } else {
            bcOrphans.push("blog/" + yymm + ".html");
            /* the month is empty now: the month after it points at it, and
               the stream may have to show the month before it instead */
            repair = bcRepairNewer(files, touched, months, yymm, deployed, meta, blocksFor);
          }
          return repair;
        }).then(function () {
          stamps = bcStamps(man, man.nextPost, man.nextImg, entries, touched);
          var out = TOOL.spliceRegion(src, "blog-manifest", stamps.payload);
          if (out === null) throw new Error("The blog-manifest markers are not in the deployed blog.html.");
          return bcStreamInto(out, months, blocksFor, meta.brand, deployed);
        }).then(function (text2) {
          src = text2;
          bcCommonFiles(files, src, entries, meta, stamps.publish);
          return bcFetchText("search.js").then(function (deployed) {
            return bcSearchWrite(files, deployed, { remove: id }, stamps.publish)
              .then(function (table) {
                files[FEED_FILE] = new TextEncoder().encode(
                  bcFeed(meta.base, table, bcTitles(entries), meta.brand, stamps.publish));
              });
          });
        });
      })
      .then(function () { return bcOtherPages(files, entries); })
      .then(function () {
        bcPublished = true;
        TOOL.markExported();
        bcFinishBundle(files, "blog-delete-p" + id + ".zip",
          "Deletion bundle built for p" + id + ". Extract it at the repo root. Delete the files in " +
          "ORPHANS.txt. Commit and push. Then reload this page.", "",
          { kind: "delete", id: id, stamp: stamps.publish });
      })
      .catch(function (err) {
        bcSetStatus("Delete failed: " + err.message);
        console.error("[blog] delete failed:", err);
        bcWizFail(err, "Delete");
      });
  }

  /* ---------------- rebuild: every month file, current chrome ---------------- */
  function bcRebuild() {
    TOOL.injectStyles();
    console.info("[blog] rebuild: rendering every month file again with the current chrome.");
    var files = {};
    var carried = [];     /* blocks with no source, carried verbatim */
    var found = [];       /* posts read from the month files, with source */
    var touched = {};     /* month -> the stamp of the file written for it */
    /* a rebuild has no orphans of its own; never inherit a composer session's */
    var savedOrphans = bcOrphans;
    bcOrphans = [];
    /* held for the last step, which writes the manifest and the stream
       back into the page */
    var blocksFor = {}, rebuiltSrc = "", rebuiltMan = null, meta = null, allMonths = [];
    var enc = new TextEncoder();
    TOOL.pristine()
      .then(function (src) {
        var man = bcManifestFrom(src);
        if (!man.entries.length) throw new Error("The manifest is empty. There is nothing to rebuild.");
        /* A rebuild reads every month, and only knows which ones once the
           manifest is in hand. Declaring them here still lets the hand-off
           show the list and the progress for all the asks that follow. */
        TOOL.expectFiles([TOOL.currentPage()].concat(
          bcUniqueMonths(man.entries).map(function (m) { return "blog/" + m + ".html"; }))
          .concat(["search.js"]));
        TOOL.expectOptional(["search.js"]);
        meta = bcSiteMeta(src);
        rebuiltSrc = src;
        rebuiltMan = man;
        var months = allMonths = bcUniqueMonths(man.entries);
        /* every one of these is in the manifest, so every one should exist;
           a folder that lacks one is a fact about the folder, not a reason
           to abandon the rebuild */
        TOOL.expectOptional(months.map(function (m) { return "blog/" + m + ".html"; }));
        return Promise.all(months.map(function (yymm) {
          return bcFetchMonth(yymm, months).then(function (text) {
            if (text === null) throw new Error("blog/" + yymm + ".html is missing on the server.");
            var blocks = bcParseMonthBlocks(text);
            if (!blocks.length) throw new Error("blog/" + yymm + ".html could not be parsed.");
            var rendered = blocks.map(function (b) {
              var post = bcExtractPost(b.text);
              if (post.source === null || !post.id) {
                carried.push({ id: b.id, label: "p" + b.id + " (" + yymm + ")" });
                return b;   /* no source: carry the block verbatim */
              }
              /* by format: a month with both kinds regenerates both kinds */
              found.push(post);
              return { id: post.id, date: post.date,
                       text: bcRenderArticle(post.id, post.date, post.title, post.source, bcMetaOf(post)) };
            });
            /* a rebuild sets every link in the chain from the full list */
            var mt = bcMonthText(yymm, rendered, meta, bcPrevOf(months, yymm), months);
            files["blog/" + yymm + ".html"] = enc.encode(mt.text);
            touched[yymm] = mt.stamp;
            blocksFor[yymm] = rendered;
          });
        }));
      })
      .then(function () {
        if (carried.length) {
          console.warn("[blog] rebuilt with VERBATIM carry (no embedded source): " +
            carried.map(function (c) { return c.label; }).join(", "));
        }
        /* The manifest and the stream are written again from the same
           sources the month files were, so the three cannot disagree. This
           is why a rebuild writes blog.html: a rebuild that rewrote the
           month files and not the page would be the one way they could fall
           out of step. The stamp changes at every rebuild, so the page is
           always in the bundle. */
        var derived = bcDerivedManifest(rebuiltMan, found, carried);
        var stamps = bcStamps(rebuiltMan, derived.nextPost, derived.nextImg, derived.entries, touched);
        var src = TOOL.spliceRegion(rebuiltSrc, "blog-manifest", stamps.payload);
        if (src === null) throw new Error("The blog-manifest markers are not in the deployed blog.html.");
        var months2 = bcUniqueMonths(derived.entries);
        return bcStreamInto(src, months2, blocksFor, meta.brand, allMonths).then(function (text) {
          bcCommonFiles(files, text, derived.entries, meta, stamps.publish);
          /* the index, from the same sources the month files were written
             from, so the three cannot disagree */
          return bcRebuildSearch(files, found, carried, stamps.publish)
            .then(function (table) {
              files[FEED_FILE] = new TextEncoder().encode(
                bcFeed(meta.base, table, bcTitles(derived.entries), meta.brand, stamps.publish));
            });
        }).then(function () {
          /* the highlights block reads the entries, so a rebuild that
             changed one has to reach the home page as a publish would */
          var same = bcManifestPayload(1, 1, derived.entries) === bcManifestPayload(1, 1, rebuiltMan.entries);
          return (same ? Promise.resolve() : bcOtherPages(files, derived.entries)).then(function () {
            if (!same) TOOL.markExported();
            bcFinishBundle(files, "blog-rebuild-" + bcTodayYYMMDD() + ".zip", "", "",
              { kind: "rebuild", stamp: stamps.publish });
            console.info("[blog] rebuild bundle ready. Extract it at the repo root, review, commit, push.");
          });
        });
      })
      .catch(function (err) {
        console.error("[blog] rebuild failed:", err.message);
        bcWizFail(err, "Rebuild");
      })
      .then(function () { bcOrphans = savedOrphans; });
    return "rebuilding (bundle will download)";
  }

  /* The index a rebuild writes, from the posts it read.

     A rebuild has every source in hand, so every entry is made again.
     The thumbnails are the one thing it cannot remake from a source: it
     keeps the one the deployed index has, and makes a new one over http
     for a post that has an image and no thumbnail yet. From disk there
     is nothing to fetch, so such a post keeps an empty thumbnail until a
     publish from the live site gives it one. */
  function bcRebuildSearch(files, found, carried, stamp) {
    return bcFetchText("search.js").then(function (deployed) {
      var unpack = (AMH.search && AMH.search.unpack)
        ? AMH.search.unpack(deployed || "") : Promise.resolve({ posts: [] });
      return unpack.catch(function () { return { posts: [] }; }).then(function (old) {
        var had = {};
        (old.posts || []).forEach(function (e) { had[e.id] = e.thumb || ""; });
        var missing = 0;
        return Promise.all(found.map(function (post) {
          var thumb = had[post.id] || "";
          var first = bcFirstImage(post);
          if (thumb || !first) return Promise.resolve(bcSearchEntry(post, thumb));
          if (location.protocol === "file:") { missing++; return Promise.resolve(bcSearchEntry(post, "")); }
          return bcThumbFromURL(first).then(function (made) {
            if (!made) missing++;
            return bcSearchEntry(post, made);
          });
        })).then(function (table) {
          /* a post carried verbatim has no source to index; its entry is
             kept as it was rather than dropped */
          carried.forEach(function (c) {
            var kept = (old.posts || []).filter(function (e) { return e.id === c.id; })[0];
            if (kept) table.push(kept);
          });
          if (missing) {
            console.warn("[blog] " + missing + " post(s) have an image and no thumbnail in " +
              "search.js. A publish from the live site makes them.");
          }
          return bcSearchWrite(files, deployed, { table: table }, stamp);
        });
      });
    });
  }

  /* The manifest a rebuild writes, from what it read.

     The entry list comes from the month files, sorted by date then id, as
     the publish path keeps it. The month file wins over the manifest,
     because the file is what a reader sees; every difference is named on
     the console, and the diff of the bundle shows the same thing. A block
     with no source keeps the entry the manifest has for it, because the
     block alone cannot give its title the way the source can.

     The counters never go down. Each becomes the larger of the value the
     manifest holds and the highest number in use plus one, so an id or an
     image name is never given out twice. */
  function bcDerivedManifest(man, found, carried) {
    var byId = {};
    man.entries.forEach(function (e) { byId[e.id] = e; });
    var entries = found.map(function (p) {
      return { date: p.date, id: p.id, title: p.title || bcDerivedTitle(p.source, p.format) };
    });
    carried.forEach(function (c) { if (byId[c.id]) entries.push(byId[c.id]); });
    entries.sort(function (a, b) {
      return a.date === b.date ? (a.id < b.id ? -1 : 1) : (a.date < b.date ? -1 : 1);
    });
    var seen = {};
    entries.forEach(function (e) {
      seen[e.id] = true;
      var old = byId[e.id];
      if (!old) {
        console.warn("[blog] rebuild: p" + e.id + " is in blog/" + e.date.slice(0, 4) +
          ".html and not in the manifest. The entry is added.");
      } else if (old.title !== e.title || old.date !== e.date) {
        console.warn("[blog] rebuild: p" + e.id + " is \"" + e.title + "\" on " + e.date +
          " in the month file and \"" + old.title + "\" on " + old.date +
          " in the manifest. The month file wins.");
      }
    });
    man.entries.forEach(function (e) {
      if (!seen[e.id]) {
        console.warn("[blog] rebuild: p" + e.id + " is in the manifest and in no month file. " +
          "The entry is removed.");
      }
    });
    var maxId = 0, maxImg = 0, m;
    entries.forEach(function (e) { maxId = Math.max(maxId, parseInt(e.id, 10) || 0); });
    found.forEach(function (p) {
      BC_TAG_RE_G.lastIndex = 0;
      while ((m = BC_TAG_RE_G.exec(p.source))) maxImg = Math.max(maxImg, parseInt(m[2], 10) || 0);
    });
    return { entries: entries,
             nextPost: Math.max(man.nextPost, maxId + 1),
             nextImg: Math.max(man.nextImg, maxImg + 1) };
  }

  /* ==========================================================
     7. LIFECYCLE AND API
     ----------------------------------------------------------
     tool.js keeps window.edit and calls in here. Nothing on this file
     is a console command, so nothing here has to be permanent - but
     the four names on AMH.publish do have to match what tool.js calls.
     ========================================================== */

  /* The editor toolbar writes into whichever surface is open. While the
     composer is on screen that is the post body, not the region modal. */
  TOOL.editSurface(function () {
    return (bcPanel && bcPanel.parentNode && bcBody) ? bcBody : null;
  });

  /* AMH.publish
       open(editing)   open the composer; null composes a new post
       edit(id)        load a published post into the composer
       rebuild()       re-render every month file with the current chrome
       dirty()         true while the composer holds unpublished work

     tool.js calls all four. The unload guard calls dirty(), which is why
     a composer that is open but empty must answer false. */
  AMH.publish = {
    open: openComposer,
    edit: bcLoadPost,
    rebuild: bcRebuild,
    dirty: bcDirty,
    /* the Done step again, from the record; the panel line calls this */
    checklist: function () {
      var rec = bcRecordLoad();
      if (!rec) return "no bundle is waiting";
      bcWizDone(rec);
      return "checklist open";
    },
    checkLive: bcCheckLive,
    /* the page's own lifecycle hook, run again when the page's manifest
       changes under it */
    arrive: function () { bcArrive(); },
    record: bcRecordLoad,
    /* the source-string parser; the suite feeds one fixture to it and to
       blog.js's, because the two must agree line for line */
    manifest: bcManifestFrom,
    /* the minute tick of the time field, so the suite need not wait a
       minute; and the two time forms, HHMM and "3:07 pm" */
    /* the index generators, so the suite can round-trip a known table
       without publishing one */
    searchEntry: bcSearchEntry,
    searchPack: bcSearchPack,
    tick: bcTickTime,
    timeParse: bcTimeParse,
    timeLabel: bcTimeLabel
  };

  /* On arrival: the record the last bundle left, and the reload the Done
     step offered. tool.js has run by now, which script order guarantees,
     and the manifest is on the page, which DOMContentLoaded guarantees. */
  function bcArrive() {
    /* what the server sent, read before anything is staged onto it: the
       live check asks whether the SERVER has the bundle, and the layer
       would otherwise answer yes to its own reflection */
    var man = AMH.blog ? AMH.blog.parseManifest() : { stamp: "", entries: [] };
    bcDeployedStamp = man.stamp;
    bcDeployedIds = {};
    man.entries.forEach(function (e) { bcDeployedIds[e.id] = true; });
    if (bcCheckLive()) return;
    /* the work that is built and not yet uploaded, onto the page */
    if (TOOL.editorOn() && TOOL.layerApply()) {
      if (AMH.blog) { AMH.blog.cut(); AMH.blog.editButtons(); }
      bcStagedChips();
      console.info("[blog] this page shows a bundle you have not uploaded yet.");
    }
  }
  /* The editor turning on is the other moment the layer may be shown:
     tool.js calls this when it does. */
  AMH.publish.staged = function () {
    if (!TOOL.layerApply()) return 0;
    if (AMH.blog) { AMH.blog.cut(); AMH.blog.editButtons(); }
    bcStagedChips();
    return 1;
  };
  if (doc.readyState === "loading") doc.addEventListener("DOMContentLoaded", bcArrive, { once: true });
  else bcArrive();
})();
