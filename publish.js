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
  var bcStatus = null, bcCards = null, bcPreviewEl = null;
  var bcImages = [];            /* {num, fmt, caption, alt, blob, previewURL, origBlob, origName, w, h} */
  var bcManAtOpen = null;       /* manifest payload string at composer open (staleness check) */
  var bcImgCounter = 0;         /* session-local offset over manifest next-img */
  var bcPublished = false;
  var bcIntakeChain = Promise.resolve();   /* serializes drops: numbers follow drop order */
  var bcEditing = null;         /* null = new post; else {id, date0, title0, source0} */
  var bcOrphans = [];           /* server files this session's edits made unreferenced */
  var bcDeleteBtn = null;
  /* sticky until reload: after ANY bundle is built, the deployed site no
     longer matches what a further operation would splice against */
  var bcSessionPublished = false;

  function pad4(n) { return ("000" + n).slice(-4); }
  function bcDirty() {
    if (!bcPanel || !bcPanel.parentNode || bcPublished) return false;
    return !!(bcTitle.value.trim() || bcBody.value.trim() || bcImages.length);
  }

  /* manifest parsing straight from a source string (the DOM parser in the
     page script reads the live tag; publish must read the PRISTINE source) */
  function bcManifestFrom(srcText) {
    var m = /<script id="blogManifest"[^>]*>([\s\S]*?)<\/script>/.exec(srcText);
    var out = { nextPost: 1, nextImg: 1, entries: [], payload: m ? m[1] : "" };
    if (!m) return out;
    m[1].split("\n").map(function (l) { return l.trim(); }).forEach(function (l) {
      if (l.indexOf("next-post:") === 0) out.nextPost = parseInt(l.slice(10), 10) || 1;
      else if (l.indexOf("next-img:") === 0) out.nextImg = parseInt(l.slice(9), 10) || 1;
      else if (l) {
        l.split("|").forEach(function (e) {
          var em = /^(\d{6})(\d{4})(.*)$/.exec(e);
          if (em) out.entries.push({ date: em[1], id: em[2], title: em[3] });
        });
      }
    });
    return out;
  }
  function bcManifestPayload(nextPost, nextImg, entries) {
    var line = entries.map(function (e) { return e.date + e.id + e.title; }).join("|");
    return "\nnext-post:" + pad4(nextPost) + "\nnext-img:" + pad4(nextImg) +
      (line ? "\n" + line : "") + "\n";
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
    ".bc-fields{display:flex;gap:.5rem;padding:0 1.1rem .55rem;}" +
    ".bc-fields input{background:var(--bg-deep);color:var(--text);border:1px solid var(--line);" +
    "border-radius:8px;padding:.45rem .7rem;font:12.5px Consolas,'Courier New',monospace;}" +
    ".bc-fields input:focus-visible{outline:2px solid var(--accent);}" +
    ".bc-date{width:9ch;flex:none;}" +
    ".bc-title{flex:1;}" +
    ".bc-tabs{display:flex;gap:.3rem;padding:0 1.1rem .5rem;}" +
    ".bc-tab{padding:.3rem .8rem;border-radius:999px;border:1px solid var(--line);" +
    "background:var(--bg-deep);color:var(--muted);font:600 .72rem var(--font);cursor:pointer;}" +
    ".bc-tab.on{border-color:var(--accent);color:var(--accent-bright);}" +
    ".bc-write,.bc-images,.bc-preview{flex:1;min-height:0;display:none;flex-direction:column;" +
    "margin:0 1.1rem;}" +
    ".bc-panel[data-tab=write] .bc-write{display:flex;}" +
    ".bc-panel[data-tab=images] .bc-images{display:flex;}" +
    ".bc-panel[data-tab=preview] .bc-preview{display:flex;}" +
    ".bc-write textarea{flex:1;min-height:0;resize:none;background:var(--bg-deep);color:var(--text);" +
    "border:1px solid var(--line);border-radius:8px;padding:.7rem .8rem;" +
    "font:12.5px/1.55 Consolas,'Courier New',monospace;white-space:pre-wrap;}" +
    ".bc-write textarea:focus-visible{outline:2px solid var(--accent);}" +
    ".bc-images{overflow-y:auto;display:none;}" +
    ".bc-panel[data-tab=images] .bc-images{display:block;}" +
    ".bc-drop{border:2px dashed var(--line);border-radius:10px;padding:1.1rem;text-align:center;" +
    "color:var(--muted);font-size:.85rem;transition:border-color .2s;}" +
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
    ".bc-btns{display:flex;flex-wrap:wrap;gap:.4rem;padding:.7rem 1.1rem .9rem;}" +
    ".bc-btns .ced-spacer{flex:1 1 auto;}";
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

  function bcRenderPreview() {
    var date = /^\d{6}$/.test(bcDate.value) ? bcDate.value : bcTodayYYMMDD();
    var B = AMH.blog;
    bcPreviewEl.innerHTML = '<article class="blog-post"><header><h2>' +
      TOOL.escAttr(bcTitle.value || "(untitled)").replace(/&quot;/g, '"') +
      '</h2><time datetime="' + B.dateTime(date) + '">' + B.dateLabel(date) +
      '</time></header><div class="blog-post__body"></div></article>';
    var body = bcPreviewEl.querySelector(".blog-post__body");
    body.innerHTML = B.renderBody(bcBody.value.trim(), date, "stream");
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

  function bcSaveDraft() {
    try {
      localStorage.setItem(BC_DRAFT_KEY, JSON.stringify({
        date: bcDate.value, title: bcTitle.value, body: bcBody.value, when: Date.now()
      }));
      bcSetStatus("Draft saved (text only - images don't persist; keep the files). One slot.");
    } catch (err) { bcSetStatus("Draft save failed: " + err.message); }
  }
  function bcRestoreDraft() {
    var raw = null;
    try { raw = localStorage.getItem(BC_DRAFT_KEY); } catch (err) {}
    if (!raw) { bcSetStatus("No draft stored."); return; }
    var d;
    try { d = JSON.parse(raw); } catch (err) { bcSetStatus("Draft is unreadable."); return; }
    if (!d || typeof d.body !== "string" || typeof d.when !== "number") {
      bcSetStatus("Draft is unreadable."); return;
    }
    if (!window.confirm("Restore draft '" + (d.title || "(untitled)") + "' (" +
        TOOL.age(Date.now() - d.when) + ")?\n\nThis replaces the date, title, and body.")) return;
    bcDate.value = d.date || bcTodayYYMMDD();
    bcTitle.value = d.title || "";
    bcBody.value = d.body;
    bcSetStatus("Draft restored - re-add any images it references.");
  }

  function bcRequestClose() {
    if (bcDirty() &&
        !window.confirm("The composer has unpublished content.\n\nClose and discard it? (Save Draft first if unsure.)")) return;
    bcClose();
  }
  function bcClose() {
    bcImages.forEach(function (im) { if (im.previewURL) URL.revokeObjectURL(im.previewURL); });
    bcImages = [];
    if (bcScrim && bcScrim.parentNode) bcScrim.parentNode.removeChild(bcScrim);
    if (bcPanel && bcPanel.parentNode) bcPanel.parentNode.removeChild(bcPanel);
  }

  /* Everything in the panel a TAB can land on, in the order it appears:
     the date, the title, the three view tabs, the body, then the buttons at
     the bottom. The toolbar is absent by construction, because its buttons
     carry tabIndex -1 and this asks the document which elements are
     focusable rather than listing them. */
  function bcFocusables() {
    if (!bcPanel) return [];
    return Array.prototype.filter.call(
      bcPanel.querySelectorAll("input, textarea, button, [href], select"),
      function (el) {
        return el.tabIndex !== -1 && !el.disabled &&
               el.getAttribute("aria-hidden") !== "true" &&
               (el.offsetWidth > 0 || el.offsetHeight > 0);
      });
  }

  /* The panel says aria-modal, so TAB has to stay in it. Without this the
     focus walks out through the scrim and onto the page behind, where the
     editor's own chips are waiting, and there is no way back but the mouse. */
  function bcTrapFocus(e) {
    if (e.key !== "Tab") return;
    var items = bcFocusables();
    if (!items.length) return;
    var first = items[0], last = items[items.length - 1];
    var at = items.indexOf(doc.activeElement);
    if (at === -1) { e.preventDefault(); first.focus(); return; }
    if (e.shiftKey && doc.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && doc.activeElement === last) { e.preventDefault(); first.focus(); }
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
        if (TOOL.modalOpen()) return;
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
    bcManAtOpen = (doc.getElementById("blogManifest") || { textContent: "" }).textContent;
    bcScrim = doc.createElement("div");
    bcScrim.className = "ced-scrim";
    bcPanel = doc.createElement("div");
    bcPanel.className = "bc-panel";
    bcPanel.setAttribute("role", "dialog");
    bcPanel.setAttribute("aria-modal", "true");
    bcPanel.setAttribute("data-tab", "write");

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

    var fields = doc.createElement("div");
    fields.className = "bc-fields";
    bcDate = doc.createElement("input");
    bcDate.type = "text"; bcDate.className = "bc-date";
    bcDate.value = bcTodayYYMMDD();
    bcDate.title = "post date, YYMMDD";
    bcDate.spellcheck = false;
    bcTitle = doc.createElement("input");
    bcTitle.type = "text"; bcTitle.className = "bc-title";
    bcTitle.placeholder = "Post title";
    bcTitle.addEventListener("input", function () {
      /* titles land inside the manifest script tag and in attributes: no
         pipes (entry delimiter) and no angle brackets (a script-closing
         sequence in a title would truncate the manifest for every visitor) */
      if (/[|<>]/.test(bcTitle.value)) bcTitle.value = bcTitle.value.replace(/[|<>]/g, "");
    });
    fields.appendChild(bcDate);
    fields.appendChild(bcTitle);
    bcPanel.appendChild(fields);

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

    /* write tab: toolbar + textarea */
    var writeEl = doc.createElement("div");
    writeEl.className = "bc-write";
    var tools = doc.createElement("div");
    tools.className = "ced-modal__tools";
    tools.style.padding = "0 0 .55rem";
    TOOL.toolbar.concat([
      ["H3", "subheading", function () { TOOL.wrap("<h3>", "</h3>"); }],
      ["P", "paragraph", function () { TOOL.wrap("<p>", "</p>"); }]
    ]).forEach(function (t) {
      var b = doc.createElement("button");
      b.type = "button"; b.className = "ced-tool";
      b.tabIndex = -1;             /* see the note in tool.js: not a tab stop */
      b.textContent = t[0]; b.title = t[1];
      b.addEventListener("click", t[2]);
      tools.appendChild(b);
    });
    writeEl.appendChild(tools);
    bcBody = doc.createElement("textarea");
    bcBody.spellcheck = true;
    bcBody.placeholder = "<p>Write the post as HTML paragraphs.</p>\n\nDrop images on the Images tab, then place them with [img####,caption|alt] tags. Adjacent tags become one carousel.";
    writeEl.appendChild(bcBody);
    bcPanel.appendChild(writeEl);

    /* images tab */
    var imagesEl = doc.createElement("div");
    imagesEl.className = "bc-images";
    var drop = doc.createElement("div");
    drop.className = "bc-drop";
    drop.textContent = "Drop images here (jpg / png / webp) - resized to 1600px, jpg quality 85; toggle a card to .png for lossless";
    ["dragover", "dragleave", "drop"].forEach(function (evName) {
      drop.addEventListener(evName, function (e) {
        e.preventDefault(); e.stopPropagation();
        drop.classList.toggle("ced-dropping", evName === "dragover");
        if (evName !== "drop") return;
        var files = Array.prototype.slice.call((e.dataTransfer && e.dataTransfer.files) || []);
        /* intake is async (decode + encode); chain it so numbers are always
           assigned in drop order, even across rapid multi-drops */
        files.forEach(function (f) {
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
      });
    });
    imagesEl.appendChild(drop);
    /* The one thing on the site that cannot travel between pages. Copy and
       gallery edits are strings, so they wait in sessionStorage and follow you.
       These are real resized bytes, held in memory for the zip, and a
       navigation frees them. */
    var imgNote = doc.createElement("div");
    imgNote.className = "bc-status";
    imgNote.style.padding = "0 1.1rem .4rem";
    imgNote.textContent = "Images live on this page only. Text edits follow you " +
      "between pages, but these are real file bytes: leaving loses them, so " +
      "publish the post from here.";
    imagesEl.appendChild(imgNote);
    bcCards = doc.createElement("div");
    imagesEl.appendChild(bcCards);
    bcPanel.appendChild(imagesEl);

    /* preview tab */
    bcPreviewEl = doc.createElement("div");
    bcPreviewEl.className = "bc-preview";
    bcPanel.appendChild(bcPreviewEl);

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
    bcBtn("Publish", "ced-btn--accent", bcPublish, btns);
    bcBtn("Close", "", bcRequestClose, btns);
    bcPanel.appendChild(btns);

    doc.body.appendChild(bcScrim);
    doc.body.appendChild(bcPanel);
    bcTabsSync();
    bcTitle.focus();
    bcSetStatus("Reminder: publish from a clean repo synced with the deployed site.");
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

  function bcRenderArticle(id, date, title, source) {
    var B = AMH.blog;
    var t = TOOL.escAttr(title);
    return "      <!-- ===== POST " + id + " · " + date + " ===== -->\n" +
      '      <article class="blog-post" id="p' + id + '" data-id="' + id +
      '" data-date="' + date + '" data-title="' + t + '">\n' +
      "        <header>\n" +
      "          <h2>" + t.replace(/&quot;/g, '"') + "</h2>\n" +
      '          <time datetime="' + B.dateTime(date) + '">' + B.dateLabel(date) + "</time>\n" +
      "        </header>\n" +
      '        <div class="blog-post__body">\n' +
      B.renderBody(source, date, "static") + "\n" +
      "        </div>\n" +
      '        <scr' + 'ipt type="text/x-blog-source">\n' +
      B.encodeSource(source) + "\n" +
      "</scr" + "ipt>\n" +
      "      </article>\n" +
      "      <!-- ===== /POST " + id + " ===== -->";
  }

  function bcIso() { return new Date().toISOString().slice(0, 10); }

  function bcMonthSkeleton(yymm, blocksJoined, base, fontHref, brand) {
    var B = AMH.blog;
    var mt = B.monthTitle(yymm);
    var pageTitle = "Aaron M. Harris · Blog · " + mt;
    var descr = "Thoughts, musings, and fun new developments from Aaron M. Harris";
    var url = base + "blog/" + yymm + ".html";
    return "<!DOCTYPE html>\n" +
      "<!-- GENERATED by the blog.html publish engine on " + bcIso() + ".\n" +
      "     Hand edits will be overwritten by the next publish/rebuild. -->\n" +
      '<html lang="en">\n<head>\n' +
      '  <meta charset="UTF-8" />\n' +
      '  <meta name="viewport" content="width=device-width, initial-scale=1.0" />\n' +
      "  <title>" + pageTitle + "</title>\n" +
      '  <meta name="description" content="' + descr + '" />\n' +
      '  <link rel="canonical" href="' + url + '" />\n' +
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
      '    <header class="bm-head">\n' +
      '      <a class="bm-head__brand" href="../index.html">' + brand + "</a>\n" +
      '      <h1 class="bm-head__label">Blog · ' + mt + "</h1>\n" +
      /* Two links, two jobs. The brand is the wordmark and goes home. The
         stream link is the way back to where the reader came from, which is
         the blog page now rather than a view of the home page. */
      '      <a class="textlink bm-head__stream" href="../blog.html?b=' + yymm + '">Read in the full stream</a>\n' +
      "    </header>\n" +
      "    <main>\n" +
      blocksJoined + "\n" +
      "    </main>\n" +
      '    <footer class="bm-foot">© ' + ("20" + yymm.slice(0, 2)) + " Aaron M. Harris · Traverse City, MI</footer>\n" +
      "  </div>\n" +
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
  var BC_SRC_RE = new RegExp("<scr" + "ipt type=\"text/x-blog-source\">\\n([\\s\\S]*?)\\n</scr" + "ipt>");
  function bcExtractPost(blockText) {
    var meta = /<article class="blog-post" id="p(\d{4})" data-id="\d{4}" data-date="(\d{6})" data-title="([^"]*)"/.exec(blockText);
    var srcM = BC_SRC_RE.exec(blockText);
    /* lossy-fallback body: string ops, not a lazy regex - a nested </div>
       inside the body (galleries etc.) must not truncate the recovery */
    var staticBody = "";
    var bo = blockText.indexOf('<div class="blog-post__body">');
    if (bo !== -1) {
      var tail = blockText.indexOf("</article>", bo);
      var span = blockText.slice(bo, tail === -1 ? blockText.length : tail);
      var lastDiv = span.lastIndexOf("</div>");
      if (lastDiv !== -1) {
        staticBody = span.slice('<div class="blog-post__body">'.length, lastDiv)
          .replace(/^\n+/, "").replace(/\s+$/, "");
      }
    }
    return {
      id: meta ? meta[1] : null,
      date: meta ? meta[2] : null,
      title: meta ? bcUnescAttr(meta[3]) : "",
      source: srcM ? AMH.blog.decodeSource(srcM[1]) : null,
      staticBody: staticBody
    };
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
        openComposer({ id: id, date0: entry.date, title0: entry.title, source0: source });
        bcDate.value = entry.date;
        bcTitle.value = entry.title;
        bcBody.value = source;
        bcLoadPublishedImages(source, entry.date);
        bcSetStatus("Editing published post p" + id + ". Publish regenerates its month file" +
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

  /* ---------------- the blog index ----------------

     blog.html lists every post once, as a card. The card carries the first
     paragraph and a link into the month file, and the month file carries the
     post. So the full text lives in exactly one place.

     A link works from a page opened from disk; a fetch does not. That is the
     whole reason the index exists. */

  /* How much of the first paragraph a card shows. Long enough to say what a
     post is about, short enough that the page stays a list. */
  var EXCERPT_CHARS = 180;

  /* The first paragraph of a post, as plain text.

     Image tags go first: an excerpt is prose, and "[img0001,Cap|Alt]" is not.
     Then the markup, because a card is one line of text and a stray <strong>
     would have to be balanced to be safe. Cut on a word, never mid-word. */
  function bcExcerpt(source) {
    var s = String(source || "").replace(BC_TAG_RE_G, " ");
    var para = /<p[^>]*>([\s\S]*?)<\/p>/i.exec(s);
    var text = (para ? para[1] : s)
      .replace(/<[^>]*>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (text.length <= EXCERPT_CHARS) return text;
    var cut = text.slice(0, EXCERPT_CHARS);
    var space = cut.lastIndexOf(" ");
    return (space > 40 ? cut.slice(0, space) : cut).replace(/[.,;:!?]+$/, "") + "..";
  }

  /* One card. The id is the post id, so "?b=p0001" can find it, and the link
     is the month file at that same anchor. */
  function bcIndexCard(entry, source, indent) {
    var yymm = entry.date.slice(0, 4);
    var B = AMH.blog;
    return indent + '<article class="bs-card" id="p' + entry.id +
      '" data-month="' + yymm + '">\n' +
      indent + '  <time datetime="' + B.dateTime(entry.date) + '">' +
      B.dateLabel(entry.date) + "</time>\n" +
      indent + "  <h3>" + TOOL.escAttr(entry.title) + "</h3>\n" +
      indent + '  <p class="bs-card__excerpt">' + TOOL.escAttr(bcExcerpt(source)) + "</p>\n" +
      indent + '  <a class="bs-card__more" href="blog/' + yymm + ".html#p" + entry.id +
      '">Read more</a>\n' +
      indent + "</article>";
  }

  /* Pull the cards already in the deployed index, keyed by post id, so a
     publish can replace one and leave the rest byte-identical. */
  function bcIndexCards(src) {
    var open = "<!--[edit:blog-index]-->";
    var a = src.indexOf(open);
    if (a < 0) return null;
    var b = src.indexOf("<!--[/edit:blog-index]-->", a);
    if (b < 0) return null;
    var region = src.slice(a + open.length, b);
    var out = {};
    var re = /[ \t]*<article class="bs-card" id="p(\d{4})"[\s\S]*?<\/article>/g;
    var m;
    while ((m = re.exec(region))) out[m[1]] = m[0];
    return out;
  }

  /* Write the index back, newest post first, with one card changed.

     card is null to remove that post. cards, when given, replaces the whole
     set - which is what a rebuild does, because it has read every source. */
  function bcSpliceIndex(src, entries, id, card, cards) {
    var have = cards || bcIndexCards(src);
    if (have === null) {
      console.warn("[blog] blog.html has no [blog-index] region - the index was " +
        "not updated. The post is published either way.");
      return src;
    }
    if (id) {
      if (card) have[id] = card;
      else delete have[id];
    }
    var order = entries.slice().reverse();     /* manifest is oldest first */
    var lines = order.map(function (e) { return have[e.id]; })
      .filter(function (c) { return !!c; });
    var inner = lines.length
      ? "\n" + lines.join("\n") + "\n        "
      : '\n          <p class="bs-note">No posts yet - check back soon.</p>\n        ';
    var out = TOOL.spliceRegion(src, "blog-index", inner);
    return out === null ? src : out;
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
  function bcSitemap(base, months) {
    var iso = bcIso();
    var urls = TOOL.pages.map(function (pg) {
      return "  <url><loc>" + bcPageURL(base, pg.path) + "</loc><lastmod>" + iso + "</lastmod></url>";
    });
    months.forEach(function (m) {
      urls.push('  <url><loc>' + base + "blog/" + m + ".html</loc><lastmod>" + iso + "</lastmod></url>");
    });
    return '<?xml version="1.0" encoding="UTF-8"?>\n' +
      "<!-- GENERATED by the blog.html publish engine on " + bcIso() + "; hand edits are overwritten -->\n" +
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
      urls.join("\n") + "\n</urlset>\n";
  }
  /* Structure unchanged: it points at the sitemap. The base comes from the
     page's own og:url, so it follows CNAME rather than a second copy of it. */
  function bcRobots(base) {
    return "# GENERATED by the blog.html publish engine on " + bcIso() + "; hand edits are overwritten\n" +
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
    return { base: base, fontHref: fontHref, brand: brand };
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
  function bcCommonFiles(files, src, entries, meta) {
    var enc = new TextEncoder();
    files[TOOL.currentPage()] = enc.encode(src);
    files["sitemap.xml"] = enc.encode(bcSitemap(meta.base, bcUniqueMonths(entries)));
    files["robots.txt"] = enc.encode(bcRobots(meta.base));
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
  function bcFinishBundle(files, zipName, statusMsg, extraLog) {
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
  }

  /* ---------------- publish: a new post, or an edited one again ---------------- */
  function bcPublish() {
    if (bcPublished || bcSessionPublished) {
      bcSetStatus("A bundle was already built this page load. Upload it, reload the page, then compose again.");
      return;
    }
    var date = bcDate.value.trim();
    var title = bcTitle.value.replace(/[|<>]/g, "").trim();
    var source = bcBody.value.trim();
    var mm = parseInt(date.slice(2, 4), 10), dd = parseInt(date.slice(4, 6), 10);
    if (!/^\d{6}$/.test(date) || mm < 1 || mm > 12 || dd < 1 || dd > 31) {
      bcSetStatus("Date must be a plausible YYMMDD."); return;
    }
    if (!title) { bcSetStatus("A title is required (it goes in the manifest)."); return; }
    if (!source) { bcSetStatus("The post body is empty."); return; }
    var problem = TOOL.tagCheck(source.replace(BC_TAG_RE_G, ""));
    if (problem && !window.confirm("Tag check: " + problem + "\n\nPublish anyway?")) {
      bcSetStatus("Not published - " + problem); return;
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
      bcSetStatus("Tags reference images that aren't in the Images tab: " + dangling.join(", ")); return;
    }
    Object.keys(refs).forEach(function (n) {
      var want = refs[n] === "png" ? "png" : "jpg";
      if (known[n].fmt !== want) badFmt.push(n + " (tag says ." + want + ", image is ." + known[n].fmt + ")");
    });
    if (badFmt.length) {
      bcSetStatus("Tag/format mismatch - fix the tag prefix or toggle the image: " + badFmt.join("; ")); return;
    }
    function pushOrphan(f) { if (bcOrphans.indexOf(f) === -1) bcOrphans.push(f); }
    var usedNew = bcImages.filter(function (im) { return refs[im.num] && !im.published; });
    var usedPub = bcImages.filter(function (im) { return refs[im.num] && im.published; });
    var unusedNew = bcImages.filter(function (im) { return !refs[im.num] && !im.published; });
    var unusedPub = bcImages.filter(function (im) { return !refs[im.num] && im.published; });
    if (unusedNew.length && !window.confirm(unusedNew.length +
        " new image(s) are not referenced by any tag and will be SKIPPED:\n" +
        unusedNew.map(function (im) { return im.num; }).join(", ") + "\n\nPublish without them?")) {
      return;
    }
    if (unusedPub.length && !window.confirm(unusedPub.length +
        " PUBLISHED image(s) are no longer referenced; their server files become orphans:\n" +
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
    var willReplace = ["blog/" + date.slice(0, 4) + ".html", "sitemap.xml", "robots.txt"];
    if (bcEditing && bcEditing.date0.slice(0, 4) !== date.slice(0, 4)) {
      willReplace.unshift("blog/" + bcEditing.date0.slice(0, 4) + ".html");
    }
    if (!window.confirm("Publish reminder.\n\nSPLICED from the DEPLOYED bytes of:\n  " +
        willWrite.sort().join("\n  ") +
        "\n\nREGENERATED whole:\n  " + willReplace.join("\n  ") +
        "\n\nMake sure your local repo is clean and synced with the live site " +
        "before extracting.\n\nBuild the bundle?")) {
      return;
    }
    bcSetStatus("Publishing…");
    var yymm = date.slice(0, 4);
    var oldMonth = bcEditing ? bcEditing.date0.slice(0, 4) : null;
    /* Say what this publish will read before it starts. A page opened from
       disk cannot fetch its own bytes, and the wizard shows the whole list
       and its progress rather than asking once per file with no context. */
    TOOL.expectFiles([TOOL.currentPage(), "blog/" + yymm + ".html"]
      .concat(oldMonth && oldMonth !== yymm ? ["blog/" + oldMonth + ".html"] : [])
      .concat(willWrite.filter(function (pp) { return pp !== TOOL.currentPage(); })));
    var dateChanged = !!(bcEditing && bcEditing.date0 !== date);
    var files = {};   /* name -> Uint8Array */
    /* held for the last step of the chain, which renders the home page
       highlights from the manifest this publish writes */
    var meta, id, entries;
    TOOL.pristine()
      .then(function (src) {
        var man = bcManifestFrom(src);
        if (man.payload.trim() !== bcManAtOpen.trim()) {
          throw new Error("the deployed manifest differs from the page you loaded - reload and recompose (Save Draft first)");
        }
        /* what the deployed manifest knows, read before this post is added
           to it: that is the list of month files that can exist */
        var deployed = bcUniqueMonths(man.entries);
        /* a month with no deployed posts is one this publish creates, so it
           is never asked for; a month that has them may still be missing
           from someone's folder, so it is optional rather than required */
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
        entries.splice(at, 0, { date: date, id: id, title: title });
        var payload = bcManifestPayload(
          bcEditing ? man.nextPost : man.nextPost + 1,
          man.nextImg + bcImgCounter, entries);
        src = TOOL.spliceAllEdits(src);   /* outstanding copy/gallery edits ride along */
        var out = TOOL.spliceRegion(src, "blog-manifest", payload);
        if (out === null) throw new Error("blog-manifest markers not found in deployed blog.html");
        src = out;
        /* the index card for this post, put in among the ones already there */
        src = bcSpliceIndex(src, entries, id,
          bcIndexCard({ id: id, date: date, title: title }, source, "          "));
        meta = bcSiteMeta(src);
        bcCommonFiles(files, src, entries, meta);
        var enc = new TextEncoder();
        /* target month: swap in the (re)rendered article */
        return bcFetchMonth(yymm, deployed).then(function (existing) {
          var blocks = existing ? bcParseMonthBlocks(existing) : [];
          if (existing && !blocks.length) {
            throw new Error("blog/" + yymm + ".html exists but couldn't be parsed - is it a generated month file?");
          }
          blocks = blocks.filter(function (b) { return b.id !== id; });
          blocks.push({ id: id, date: date, text: bcRenderArticle(id, date, title, source) });
          files["blog/" + yymm + ".html"] = enc.encode(bcMonthSkeleton(
            yymm, bcSortBlocks(blocks).map(function (b) { return b.text; }).join("\n"),
            meta.base, meta.fontHref, meta.brand));
        }).then(function () {
          /* cross-month move: regenerate the old month without this post,
             or orphan the whole file if this was its only post */
          if (!bcEditing || oldMonth === yymm) return;
          return bcFetchMonth(oldMonth, deployed).then(function (oldText) {
            if (oldText === null) return;   /* nothing deployed there - nothing to fix */
            var oldBlocks = bcParseMonthBlocks(oldText)
              .filter(function (b) { return b.id !== id; });
            if (oldBlocks.length) {
              files["blog/" + oldMonth + ".html"] = enc.encode(bcMonthSkeleton(
                oldMonth, bcSortBlocks(oldBlocks).map(function (b) { return b.text; }).join("\n"),
                meta.base, meta.fontHref, meta.brand));
            } else {
              bcOrphans.push("blog/" + oldMonth + ".html");
            }
          });
        }).then(function () {
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
        }).then(function () {
          /* date change: published files carry the date in their names, and
             tags resolve via the post date - fetch the deployed bytes and
             re-emit them under the new prefix; old names become orphans */
          if (!dateChanged || !usedPub.length) return;
          return Promise.all(usedPub.map(function (im) {
            return fetch(im.previewURL, { cache: "no-store" }).then(function (res) {
              if (!res.ok) throw new Error("couldn't fetch published image " + im.previewURL +
                " (HTTP " + res.status + ") - needed to rename it for the new date");
              return res.arrayBuffer();
            }).then(function (buf) {
              files["blog/" + date + "_img" + im.num + "." + im.fmt] = new Uint8Array(buf);
              pushOrphan(im.previewURL);
            });
          }));
        });
      })
      .then(function () { return bcOtherPages(files, entries); })
      .then(function () {
        bcPublished = true;
        bcSessionPublished = true;
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
          ". Extract the zip at the repo root, review the diff" +
          (bcOrphans.length ? ", DELETE the files in ORPHANS.txt" : "") +
          ", commit, push - then RELOAD this page before composing again.",
          "[blog] post URL once live: " + meta.base + "blog/" + yymm + ".html#p" + id +
          (dateChanged && oldMonth !== yymm
            ? "\n[blog] note: links shared before the move still point at blog/" + oldMonth +
              ".html - re-share the new URL"
            : ""));
      })
      .catch(function (err) {
        bcSetStatus("Publish failed: " + err.message);
        console.error("[blog] publish failed:", err);
      });
  }

  /* ---------------- delete: remove a published post ---------------- */
  function bcDeletePost() {
    if (!bcEditing) return;
    if (bcPublished || bcSessionPublished) {
      bcSetStatus("A bundle was already built this page load - upload it and reload before more changes.");
      return;
    }
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
    if (!window.confirm("DELETE post p" + id + " ('" + bcEditing.title0 + "')?\n\n" +
        "Its manifest entry is removed and its month file regenerated without it." +
        (imgOrphans.length
          ? "\nThese image files become orphans to delete manually:\n  " + imgOrphans.join("\n  ")
          : "") +
        "\n\nThis builds a publish bundle; the post stays live until you upload it.")) {
      return;
    }
    bcSetStatus("Building deletion bundle…");
    var files = {};
    var meta, entries;
    TOOL.expectFiles([TOOL.currentPage(), "blog/" + yymm + ".html"]);
    TOOL.pristine()
      .then(function (src) {
        var man = bcManifestFrom(src);
        if (man.payload.trim() !== bcManAtOpen.trim()) {
          throw new Error("the deployed manifest differs from the page you loaded - reload first");
        }
        entries = man.entries.filter(function (e) { return e.id !== id; });
        var payload = bcManifestPayload(man.nextPost, man.nextImg, entries);
        src = TOOL.spliceAllEdits(src);
        var out = TOOL.spliceRegion(src, "blog-manifest", payload);
        if (out === null) throw new Error("blog-manifest markers not found in deployed blog.html");
        src = out;
        src = bcSpliceIndex(src, entries, id, null);   /* card goes with the post */
        meta = bcSiteMeta(src);
        bcCommonFiles(files, src, entries, meta);
        imgOrphans.forEach(function (f) {
          if (bcOrphans.indexOf(f) === -1) bcOrphans.push(f);
        });
        /* the post being deleted lives in this month, so its file must
           exist; a missing one is a real problem and is thrown below */
        return bcFetchMonth(yymm).then(function (text) {
          if (text === null) {
            /* never half-delete: dropping the manifest entry while the
               article stays live would strand the post outside the system */
            throw new Error("couldn't fetch blog/" + yymm + ".html - aborting the delete");
          }
          var blocks = bcParseMonthBlocks(text).filter(function (b) { return b.id !== id; });
          if (blocks.length) {
            files["blog/" + yymm + ".html"] = new TextEncoder().encode(bcMonthSkeleton(
              yymm, bcSortBlocks(blocks).map(function (b) { return b.text; }).join("\n"),
              meta.base, meta.fontHref, meta.brand));
          } else {
            bcOrphans.push("blog/" + yymm + ".html");
          }
        });
      })
      .then(function () { return bcOtherPages(files, entries); })
      .then(function () {
        bcPublished = true;
        bcSessionPublished = true;
        TOOL.markExported();
        bcFinishBundle(files, "blog-delete-p" + id + ".zip",
          "Deletion bundle built for p" + id + ". Extract at the repo root, DELETE the files in " +
          "ORPHANS.txt, commit, push - then RELOAD this page.", "");
      })
      .catch(function (err) {
        bcSetStatus("Delete failed: " + err.message);
        console.error("[blog] delete failed:", err);
      });
  }

  /* ---------------- rebuild: every month file, current chrome ---------------- */
  function bcRebuild() {
    if (bcSessionPublished) {
      console.warn("[blog] a bundle was already built this page load - the deployed site no longer " +
        "matches it. Upload that bundle and reload before rebuilding.");
      return "blocked: upload the pending bundle and reload first";
    }
    TOOL.injectStyles();
    console.info("[blog] rebuild: re-rendering every month file with current chrome…");
    var files = {};
    var carried = [];
    /* a rebuild has no orphans of its own; never inherit a composer session's */
    var savedOrphans = bcOrphans;
    bcOrphans = [];
    /* held for the last step, which writes the index back into the page */
    var rebuiltCards = {}, rebuiltSrc = "", rebuiltEntries = [];
    TOOL.pristine()
      .then(function (src) {
        var man = bcManifestFrom(src);
        if (!man.entries.length) throw new Error("manifest is empty - nothing to rebuild");
        /* A rebuild reads every month, and only knows which ones once the
           manifest is in hand. Declaring them here still lets the wizard show
           the list and the progress for all the asks that follow. */
        TOOL.expectFiles([TOOL.currentPage()].concat(
          bcUniqueMonths(man.entries).map(function (m) { return "blog/" + m + ".html"; })));
        var meta = bcSiteMeta(src);
        var enc = new TextEncoder();
        /* no manifest change: index.html stays out of a rebuild bundle */
        files["sitemap.xml"] = enc.encode(bcSitemap(meta.base, bcUniqueMonths(man.entries)));
        files["robots.txt"] = enc.encode(bcRobots(meta.base));
        /* A rebuild reads every month, so it is the one path that holds
           every post's source and can regenerate every card. It therefore
           has to write blog.html, which it used to leave out: a rebuild that
           rewrote the month files and not the index would be the one way
           these two could fall out of step. */
        rebuiltSrc = src;
        rebuiltEntries = man.entries;
        var months = bcUniqueMonths(man.entries);
        /* every one of these is in the manifest, so every one should exist;
           a folder that lacks one is a fact about the folder, not a reason
           to abandon the rebuild */
        TOOL.expectOptional(months.map(function (m) { return "blog/" + m + ".html"; }));
        return Promise.all(months.map(function (yymm) {
          return bcFetchMonth(yymm, months).then(function (text) {
            if (text === null) throw new Error("blog/" + yymm + ".html is missing on the server");
            var blocks = bcParseMonthBlocks(text);
            if (!blocks.length) throw new Error("blog/" + yymm + ".html couldn't be parsed");
            var rendered = blocks.map(function (b) {
              var post = bcExtractPost(b.text);
              if (post.source === null || !post.id) {
                carried.push("p" + b.id + " (" + yymm + ")");
                return b;   /* no source: carry the block verbatim */
              }
              /* the same source the month file is rendered from, so the card
                 and the post cannot say different things */
              rebuiltCards[post.id] = bcIndexCard(
                { id: post.id, date: post.date, title: post.title },
                post.source, "          ");
              return { id: post.id, date: post.date,
                       text: bcRenderArticle(post.id, post.date, post.title, post.source) };
            });
            files["blog/" + yymm + ".html"] = enc.encode(bcMonthSkeleton(
              yymm, bcSortBlocks(rendered).map(function (b) { return b.text; }).join("\n"),
              meta.base, meta.fontHref, meta.brand));
          });
        }));
      })
      .then(function () {
        if (carried.length) {
          console.warn("[blog] rebuilt with VERBATIM carry (no embedded source): " + carried.join(", "));
        }
        /* The index is regenerated from the same sources the month files
           were, so the two cannot disagree. This is why a rebuild now writes
           blog.html: it used to leave the page out, which was fine when the
           page held nothing derived from a post. */
        var idxSrc = bcSpliceIndex(rebuiltSrc, rebuiltEntries, null, null, rebuiltCards);
        if (idxSrc !== rebuiltSrc) {
          files[TOOL.currentPage()] = new TextEncoder().encode(idxSrc);
        }
        bcFinishBundle(files, "blog-rebuild-" + bcTodayYYMMDD() + ".zip", "", "");
        console.info("[blog] rebuild bundle ready - extract at the repo root, review, commit, push.");
      })
      .catch(function (err) {
        console.error("[blog] rebuild failed:", err.message);
      })
      .then(function () { bcOrphans = savedOrphans; });
    return "rebuilding (bundle will download)";
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
    dirty: bcDirty
  };
})();
