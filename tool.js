/* ============================================================
   tool.js - the site's authoring surface: the site editor, image
   editing, and the export that writes a page back.

   Every page loads it, last in the fixed order. Nothing else depends
   on it, and everything it drives is reached through AMH or through
   the window.edit console entry.

   Seven sections. It held eight until Phase 3 Part 3, when the blog
   composer became publish.js. The rule that allowed the eighth said
   the next growth splits a file out rather than adding a ninth
   section, and that is what happened.

   Sections:
     1. SETUP                    5. EDITOR UI
     2. CONSTANTS AND KEYS       6. EXPORT AND SPLICING
     3. REGIONS AND LISTS        7. PUBLIC API
     4. IMAGE REGIONS

   Two public surfaces, both listed in section 7: window.edit is the
   console, and AMH.tool is the editor kit that publish.js and the
   gallery tile grid build on.

   AMH.tool.imageRegion, from section 4, is the image-region core. It is
   the largest piece of that kit.

     An entry is a record of strings. There is ONE way one gets its src:
     imagesengine.js, which makes a photo's three files and holds them
     until a save writes them. A carousel, a gallery tile, a deep dive's
     drawer and the blog's composer all go through it, so a photo is made
     the same way wherever it is added. Everything except the blob
     preview survives a navigation.

     A consumer registers a region and draws it:

       var region = AMH.tool.imageRegion.register({
         slug: "br-gallery",         the [edit:slug] pair the export splices
         el:   containerElement,     the authored container
         kind: myKind                see AMH.tool.imageKinds
       });

     A kind is a plain record of the properties the core reads: how to
     find the authored images, whether an empty export falls back to
     seeds, whether the live element is always on screen, and so on. The
     core never asks what kind a region is, so a new consumer is a new
     kind rather than a change here.

     The core owns the model, the export form and the serializer. It does
     not own layout. A carousel shows one image at a time and a tile grid
     shows many; that difference belongs to the consumer, which is why it
     is the one thing the core refuses to know about.
   ============================================================ */
/* ===========================================================
   BUILT-IN COPY EDITOR (hidden until activated)
   ------------------------------------------------------------
   Activate from the F12 console:  edit()
   Full docs live in docs/README.md (not published).

   Console commands:
     edit()            toggle editor mode (badges + panel)
     edit.list()       table of every editable region
     edit.export()     download the changed pages, and the photos they show
     edit.save()       write the same files into the repo folder
     edit.before()     view the page as published (pre-edit)
     edit.after()      view the page with applied edits
     edit.revertAll()  discard every applied edit (confirm)
     edit.clear()      wipe the quicksave slot
     edit.help()       print this list

   Images: galleries (project carousels + deep-dive drawers) are
   image regions. In editor mode each carousel has three chips: (+)
   opens ADD PHOTO, a wizard that takes dropped or chosen files;
   IMG## opens PHOTOS, where captions, alt text, order, the UHD
   switch, replacing and deleting wait for Apply; and the trash can
   deletes the photo on screen after it asks. A caption on screen
   carries a pencil that edits it in place. Files dropped on a
   carousel open ADD PHOTO on those files. Seed images (img/seed/)
   are placeholder filler: they show only while a gallery has no
   real images.

   How it works: copy regions are fenced in the HTML by
   [edit:slug] ... [/edit:slug] comment pairs, each wrapping exactly
   one element. Editing changes that element's innerHTML live;
   export re-fetches the pristine source over HTTP and splices only
   the edited innerHTMLs back between their markers, so the download
   is byte-identical to the source outside the regions you edited
   (inside them the browser normalizes entities, e.g. &middot; to a
   literal character).
   (Export therefore needs the page served over HTTP, not file://.)
   Edits live in memory only; nothing persists except the one manual
   quicksave slot. Casual visitors can never see any of this.
   =========================================================== */
/* ==========================================================
   1. SETUP
   ----------------------------------------------------------
   One editor per page. The guard makes a second load a no-op rather
   than a second set of badges over the first.
   ========================================================== */
(function () {
  "use strict";
  if (window.edit) return;
  var AMH = window.AMH = window.AMH || {};
  AMH.tool = AMH.tool || {};
  var doc = document;

  /* ==========================================================
     2. CONSTANTS AND KEYS
     ----------------------------------------------------------
     Rule: the two storage keys are permanent. Renaming one throws away
     a quicksave or a blog draft that someone has already written.
     ========================================================== */
  /* The pages this engine may read and write.

     Rules:
       - The engine fetches and splices only a page on this list.
       - A page not on this list is never written, even if it carries
         [edit:slug] markers.
       - Adding a page here is a deliberate act, paired with adding its
         markers. A page on the list with no markers is harmless; a page
         with markers that is not on the list is silently unpublishable,
         so add both together.

     Order is the order a reader meets the pages, not an order the engine
     depends on. The sitemap is generated from this list. */
  var MANAGED_PAGES = [
    { path: "index.html", label: "Home" },
    { path: "gallery.html", label: "Gallery" },
    { path: "blog.html", label: "Blog" }
  ];

  /* Published so a page can register itself, and so the tests can drive a
     second page without one existing in the site yet. */
  AMH.tool.pages = MANAGED_PAGES;

  /* Copy that appears on more than one managed page and has to read the same
     on all of them: the brand and the nav in the header, and the contact
     section that closes every page.

     An edit to one of these is staged for every other managed page in the
     same act, so the pages cannot drift apart. Nothing here generates the
     markup - each page holds its own, hand-written and editable - and the
     contract test holds the shared spans to being byte-identical.

     A page that does not carry one of these slugs is not an error. See
     optionalSlug() in section 6. */
  var SHARED_SLUGS = {
    "brand-title": 1, "brand-sub": 1,
    "nav-work": 1, "nav-gallery": 1, "nav-blog": 1, "nav-about": 1,
    "nav-contact": 1,
    "contact-eyebrow": 1, "contact-h2": 1, "contact-email": 1,
    "contact-btn-email": 1, "contact-btn-call": 1, "contact-btn-txt": 1,
    "contact-btn-resume": 1, "endbar": 1
  };

  var QS_KEY = "amh-copy-editor-quicksave";
  /* Pending edits live in sessionStorage, not localStorage: they belong to one
     sitting. The tab closing is the signal that the work is abandoned. */
  var PENDING_KEY = "amh-pending-edits";
  var VOID_TAGS = { area:1, base:1, br:1, col:1, embed:1, hr:1, img:1,
                    input:1, link:1, meta:1, param:1, source:1, track:1, wbr:1 };

  var regions = [];          /* {slug, badge, el, original, current, edited, visible, chip, row} */
  var gals = [];             /* gallery (image) regions - see IMAGE / GALLERY EDITING below */
  /* Lists, by the name in their [list:name] markers. A list is a run of
     blocks the editor may add to, remove from and reorder. See section 3. */
  var lists = {};
  var badgeSeq = 0;          /* badges only ever go up, so none is reused */
  var imgSeq = 0;            /* running IMG## counter */
  var scanned = false;
  var active = false;        /* editor mode on/off */
  var viewing = "after";     /* "after" = with edits, "before" = as published */
  var exportedClean = true;  /* false once an edit exists that hasn't been exported */
  var overlay = null, panel = null, panelList = null, viewBtn = null;
  var regRowsEl = null, imgRowsEl = null;
  var modal = null, scrim = null, ta = null, modalTitle = null, modalStatus = null;
  var pendingChip = null;
  var buildRow = null;         /* the build mark and what it agrees with */
  /* The last bundle publish.js built, until the site shows it. The line is
     on every page because a person may be anywhere when they wonder whether
     they pushed it. publish.js owns the record; this only reads it. */
  var publishLine = null;
  var PUBLISH_KEY = "amh-publish-pending";
  var openRegion = null;     /* text region in the modal */
  var drawerHooked = false;
  var styleEl = null;

  /* ==========================================================
     3. REGIONS AND LISTS
     ----------------------------------------------------------
     Find the marker pairs a page holds and build the models the
     rest of the file works from: one region for each [edit:slug],
     and one list for each [list:name] with the blocks inside it.

     Both are read here because both are read the same way, off the
     comments in the page, and because a list adds and removes
     regions: the two models change together or not at all.
     ========================================================== */
  function badgeFor(i) {
    var letter = String.fromCharCode(65 + Math.floor(i / 99));   /* A01–A99, B01… */
    var n = (i % 99) + 1;
    return letter + (n < 10 ? "0" + n : String(n));
  }

  /* Every [edit:slug] opening comment among these nodes and inside them.

     A node may be a comment itself, because a block added while the editor
     is on arrives as a run of siblings: its own markers, then its element. */
  function regionComments(nodes) {
    var out = [];
    function take(c) {
      var m = /^\[edit:([\w-]+)\]$/.exec(c.nodeValue.trim());
      if (m) out.push({ slug: m[1], node: c });
    }
    nodes.forEach(function (n) {
      if (n.nodeType === 8) { take(n); return; }
      if (n.nodeType !== 1) return;
      var w = doc.createTreeWalker(n, NodeFilter.SHOW_COMMENT, null, false);
      var c;
      while ((c = w.nextNode())) take(c);
    });
    return out;
  }

  /* Register the regions these nodes hold. Returns how many were made.

     scan() hands it the page. A list hands it the nodes one new item put
     into the page, so a block added in a sitting is registered exactly as
     one the file was served with. */
  function scanNodes(nodes) {
    var made = 0;
    regionComments(nodes).forEach(function (o) {
      var el = o.node.nextSibling;
      while (el && !(el.nodeType === 1)) {
        if (el.nodeType === 3 && el.nodeValue.trim() !== "") break;
        el = el.nextSibling;
      }
      if (!el || el.nodeType !== 1) {
        console.warn("[site editor] marker '" + o.slug + "' is not followed by an element - skipped");
        return;
      }
      var after = el.nextSibling;
      while (after && after.nodeType === 3 && after.nodeValue.trim() === "") after = after.nextSibling;
      var ok = after && after.nodeType === 8 &&
               after.nodeValue.trim() === "[/edit:" + o.slug + "]";
      if (!ok) {
        console.warn("[site editor] marker '" + o.slug + "' has no matching close right after its element - skipped");
        return;
      }
      /* data-ced names the owner of a region:
           "blog"       the blog composer's publish pipeline owns it outright,
                        so the site editor does not register it at all
           "generated"  the publisher writes it on every publish that changes
                        its input. It is registered, listed and exported like
                        any other region, but never hand-edited: an edit here
                        would be overwritten at the next publish with no warning. */
      var owner = (el.getAttribute && el.getAttribute("data-ced")) || "";
      if (owner === "blog") return;
      /* an image region is not a text region: its live markup is
         runtime-built, so it carries a {src, alt, caption} model instead.
         Which elements are image regions is not decided here - each
         consumer claims its own, see imageRegion.claim(). */
      var claimed = imageRegion.claimFor(el);
      if (claimed) {
        var g = imageRegion.register({ slug: o.slug, el: el, kind: claimed });
        /* the trunk that owns the kind wires its own element. This file
           learns nothing about what the element is. */
        if (claimed.adopt) claimed.adopt(g);
        made++;
        return;
      }
      var html = el.innerHTML;
      regions.push({
        slug: o.slug, badge: badgeFor(badgeSeq++), el: el,
        original: html, current: html, edited: false,
        generated: owner === "generated",
        visible: el.getClientRects().length > 0,
        chip: null, row: null
      });
      made++;
    });
    return made;
  }

  /* The galleries inside one deep-dive template.

     Template content is a separate fragment the body walker never enters,
     so it is walked on its own: at the first scan, and again whenever a
     template is rewritten, because a deep dive that gained photographs
     gained a region with them. */
  function scanTemplate(r) {
    if (!r.el || r.el.tagName !== "TEMPLATE") return;
    var w = doc.createTreeWalker(r.el.content, NodeFilter.SHOW_COMMENT, null, false);
    var c;
    while ((c = w.nextNode())) {
      var m = /^\[edit:([\w-]+)\]$/.exec(c.nodeValue.trim());
      if (!m) continue;
      var el = c.nextSibling;
      while (el && el.nodeType !== 1) el = el.nextSibling;
      if (!el || !el.classList || !el.classList.contains("gallery")) continue;
      var had = null;
      gals.forEach(function (g) { if (g.slug === m[1]) had = g; });
      if (had) { had.el = el; had.tpl = r.el; continue; }
      var made = imageRegion.register({ slug: m[1], el: el, kind: KIND.deepdive, tpl: r.el });
      galChipsFor(made);
    }
  }

  /* Drop one region: the editor stops holding it, and its furniture goes.

     Called for every region inside a block a list removes. The bytes are
     already gone from the page; this is the model catching up. */
  function forget(slug) {
    var i;
    for (i = 0; i < regions.length; i++) {
      if (regions[i].slug !== slug) continue;
      var r = regions[i];
      if (r.chip && r.chip.parentNode) r.chip.parentNode.removeChild(r.chip);
      if (r.row && r.row.parentNode) r.row.parentNode.removeChild(r.row);
      regions.splice(i, 1);
      pendingDrop(currentPage(), "text", slug);
      return true;
    }
    for (i = 0; i < gals.length; i++) {
      if (gals[i].slug !== slug) continue;
      var g = gals[i];
      if (g.kind.drop) g.kind.drop(g);
      if (g.chip && g.chip.parentNode) g.chip.parentNode.removeChild(g.chip);
      if (g.plusChip && g.plusChip.parentNode) g.plusChip.parentNode.removeChild(g.plusChip);
      if (g.trashChip && g.trashChip.parentNode) g.trashChip.parentNode.removeChild(g.trashChip);
      if (g.observer) { g.observer.disconnect(); g.observer = null; }
      g.model.forEach(imageRegion.revokePreview);
      gals.splice(i, 1);
      pendingDrop(currentPage(), "gallery", slug);
      pendingDrop(currentPage(), "heads", slug);
      pendingDrop(currentPage(), "bytes", slug);
      return true;
    }
    return false;
  }

  /* ------------------------------------------------------------
     THE LISTS

     Every other edit replaces what is between one pair of markers, so
     nothing can add a pair. A list is the answer: a run of blocks, each
     fenced by [item:id] inside a [list:name], that the editor may add to,
     remove from and reorder.

     An item id is permanent. A rename, a reorder or the deletion of a
     sibling never changes it, which is the rule post ids already follow.

     What the trunk that owns a list supplies is in section 5; this is the
     model and the page it is read from.
     ------------------------------------------------------------ */

  /* Read the lists the page holds, and the ids in each, in document order.
     source is the order the served file holds; order is the order now. */
  function scanLists() {
    var walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_COMMENT, null, false);
    var c, now = null;
    while ((c = walker.nextNode())) {
      var m = /^\[(\/?)(list|item):([\w-]+)\]$/.exec(c.nodeValue.trim());
      if (!m) continue;
      var closing = m[1] === "/", family = m[2], name = m[3];
      if (family === "list") {
        if (closing) { if (lists[name]) lists[name].close = c; now = null; continue; }
        lists[name] = { name: name, source: [], order: [], added: {}, removed: [],
                        close: null, at: {} };
        now = lists[name];
        continue;
      }
      if (!now || closing) continue;
      now.source.push(name);
      now.order.push(name);
      now.at[name] = c;      /* the item's opening comment, for moving it */
    }
  }

  function listDirty(st) {
    return st.order.join(",") !== st.source.join(",") ||
           Object.keys(st.added).length > 0 || st.removed.length > 0;
  }
  function listsDirty() {
    return Object.keys(lists).some(function (n) { return listDirty(lists[n]); });
  }

  /* One item's nodes, from its opening marker to its closing one. */
  function itemNodes(st, id) {
    var out = [], n = st.at[id];
    if (!n) return out;
    var stop = "[/item:" + id + "]";
    while (n) {
      out.push(n);
      if (n.nodeType === 8 && n.nodeValue.trim() === stop) break;
      n = n.nextSibling;
    }
    return out;
  }

  /* Put one new item into the page and into the list.

     The markup is the one source of truth: the same string becomes the DOM
     here and the bytes at export, so what is on screen cannot drift from
     what a publish writes. It carries no indent; the splice adds the file's
     own. beforeId places it, and nothing places it last. */
  function listInsert(st, id, markup, beforeId) {
    var anchor = (beforeId && st.at[beforeId]) || st.close;
    if (!anchor || !anchor.parentNode) return false;
    var tpl = doc.createElement("template");
    tpl.innerHTML = markup;
    var nodes = Array.prototype.slice.call(tpl.content.childNodes);
    if (!nodes.length) return false;
    var frag = doc.createDocumentFragment();
    nodes.forEach(function (n) { frag.appendChild(n); });
    anchor.parentNode.insertBefore(frag, anchor);
    anchor.parentNode.insertBefore(doc.createTextNode("\n"), anchor);
    st.added[id] = markup;
    st.at[id] = nodes[0];
    var was = st.removed.indexOf(id);
    if (was !== -1) st.removed.splice(was, 1);
    /* A block that arrives after load has never been watched, and a reveal
       starts invisible. The page owns that animation, so it is asked. */
    if (AMH.site && AMH.site.watchReveals) {
      nodes.forEach(function (n) { if (n.nodeType === 1) AMH.site.watchReveals(n); });
    }
    var to = beforeId ? st.order.indexOf(beforeId) : -1;
    if (to < 0) st.order.push(id);
    else st.order.splice(to, 0, id);
    scanNodes(nodes);
    return true;
  }

  /* Take one item out of the page, with every region it held. */
  /* Every slug these nodes hold, INSIDE a template as well as outside one.

     A tree walker does not enter template content, which is right for the
     scanner: a region in there is claimed by the trunk that owns the
     template, not registered as text. It is wrong for a removal, because a
     block that leaves takes those regions with it and the editor would go
     on holding one whose element is no longer on the page. */
  function heldSlugs(nodes) {
    var out = regionComments(nodes).map(function (o) { return o.slug; });
    nodes.forEach(function (n) {
      if (n.nodeType !== 1) return;
      var tpls = n.tagName === "TEMPLATE" ? [n] :
        Array.prototype.slice.call(n.querySelectorAll("template"));
      tpls.forEach(function (t) {
        if (!t.content) return;
        var w = doc.createTreeWalker(t.content, NodeFilter.SHOW_COMMENT, null, false);
        var c, m;
        while ((c = w.nextNode())) {
          m = /^\[edit:([\w-]+)\]$/.exec(c.nodeValue.trim());
          if (m) out.push(m[1]);
        }
      });
    });
    return out;
  }

  function listRemove(st, id) {
    var kill = itemNodes(st, id);
    if (!kill.length) return false;
    heldSlugs(kill).forEach(forget);
    kill.forEach(function (n) { if (n.parentNode) n.parentNode.removeChild(n); });
    delete st.at[id];
    if (st.added[id]) delete st.added[id];
    else if (st.removed.indexOf(id) === -1) st.removed.push(id);
    var at = st.order.indexOf(id);
    if (at !== -1) st.order.splice(at, 1);
    return true;
  }

  /* Put the items in this order, on the page and in the model. Each item's
     nodes are moved, not rebuilt, so nothing inside one is disturbed. */
  function listReorder(st, order) {
    var anchor = st.close;
    if (!anchor || !anchor.parentNode) return false;
    var parent = anchor.parentNode;
    order.forEach(function (id) {
      itemNodes(st, id).forEach(function (n) { parent.insertBefore(n, anchor); });
    });
    st.order = order.slice();
    return true;
  }

  /* Put one list back to the membership and the order the file holds.

     A block that was ADDED comes off the page. A block that was MOVED goes
     back where it was. A block that was DELETED cannot be rebuilt from here:
     its bytes went with it and the file is the only copy. The list is marked
     clean either way, so the export writes the file's own list and the block
     is in it; the page catches up on the next load, which the console says. */
  function listRevert(st) {
    Object.keys(st.added).forEach(function (id) { listRemove(st, id); });
    var here = st.source.filter(function (id) { return st.at[id]; });
    var lost = st.source.filter(function (id) { return !st.at[id]; });
    listReorder(st, here);
    st.order = st.source.slice();
    st.added = {};
    st.removed = [];
    if (lost.length) {
      console.info("[site editor] reload the page to see " + lost.join(", ") +
        " again. The export already has them: their bytes are in the file, " +
        "and this tab no longer holds a copy.");
    }
  }

  function listMove(st, id, by) {
    var at = st.order.indexOf(id), to = at + by;
    if (at < 0 || to < 0 || to >= st.order.length) return false;
    var next = st.order.slice();
    next.splice(at, 1);
    next.splice(to, 0, id);
    return listReorder(st, next);
  }

  function scan() {
    if (scanned) return;
    scanned = true;
    scanLists();
    scanNodes([doc.body]);
    regions.forEach(scanTemplate);
    var ls = Object.keys(lists).length;
    console.info("[site editor] " + regions.length + " text regions, " +
      gals.length + " galleries and " + ls + " list(s) registered.");
  }

  function dirty() {
    return !exportedClean &&
      (regions.some(function (r) { return r.edited; }) || gals.some(galDirty) ||
       listsDirty());
  }

  /* ==========================================================
     4. IMAGE REGIONS
     ========================================================== */

  /* ------------------------------------------------------------
     IMAGE / GALLERY EDITING
     Galleries (project cards + deep-dive drawers) are image regions, and
     so is a gallery page section. Four tools serve every one of them:
     ADD PHOTO, the PHOTOS box, a trash that asks, and a pencil on a
     caption; see PHOTOS, IN BOXES in section 5. A carousel takes them
     from chips drawn over it, and a surface that shows every photo at
     once puts its own on each. The editor keeps a clean model per region
     (entries of strings, see THE CORE) and both the live preview and the
     export serialize from that model - runtime gallery markup is never
     read back after the initial scan.
     Seeds (img/seed/ paths) are placeholder filler: they show only
     while a region has no real images and are never editable.
     ============================================================ */
  /* The frame an unfilled slot shows. It takes a photo from anywhere on the
     machine, because the editor writes its files into img/work/, so its
     words do not send the reader to that folder.

     Its second line names the formats rather than a control. The gallery
     page draws a Choose a photo button on this frame, and art that told the
     reader to press something else would argue with the button. */
  var PHOTO_TILE = "data:image/svg+xml," + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900">' +
    '<rect width="1600" height="900" fill="#101217"/>' +
    '<rect x="30" y="30" width="1540" height="840" rx="26" fill="rgba(74,165,232,.06)" ' +
    'stroke="#4aa5e8" stroke-width="5" stroke-dasharray="30 20"/>' +
    '<text x="800" y="430" fill="#6fbcf2" font-family="Segoe UI,Arial,sans-serif" ' +
    'font-size="66" font-weight="700" text-anchor="middle">Drop a photo here</text>' +
    '<text x="800" y="505" fill="#969eaa" font-family="Segoe UI,Arial,sans-serif" ' +
    'font-size="34" text-anchor="middle">JPG, PNG, WebP or GIF</text></svg>');

  /* ------------------------------------------------------------
     THE CORE

     One image entry is a record of strings plus one transient preview:

       src       the display copy's path, "img/work/<file>"
       sd, sdw   the small copy's path, and its width
       w, h      the display copy's size
       ow, oh    the original's size
       original  the original's path
       bytes     the original's size
       uhd       true when the page shows the original in the display
                 copy's place: Display Maximum UHD
       alt       string
       caption   string
       imgId     "IMG07", assigned in document order for this session
       isSeed    true while the region is showing placeholder filler
       empty     true for an unfilled slot, which is never exported
       preview   a blob: URL, valid for this document only, never exported
       photo     the engine's photo for src, until a save writes it

     The fields from sd to uhd are the file fields. imagesengine.js reads
     them off an <img> and writes them back, so the markup is spelt out
     there and not here. An authored image with a src alone has none.

     One way in. A photo added to any region goes through the image engine
     (see HELD PHOTOS), and a save writes its files. An image a page
     already names is read back through the engine too, which is how its
     entry keeps the display copy when the page shows the original. Every
     field except preview and photo survives a page navigation, which is
     what carries an edit across pages; the held photo comes back from the
     engine's store.

     The core owns the model and the export form. A consumer owns its DOM:
     how many images it shows at once is not the core's business.
     ------------------------------------------------------------ */
  var claims = [];

  /* The file fields, in the order an export form carries them. A field an
     image does not have is left off, and so is a switch that is off, so a
     seed's form stays src, alt and caption. */
  var FILE_FIELDS = ["sd", "sdw", "w", "h", "ow", "oh", "original", "bytes", "uhd", "truesize"];
  function copyFiles(en, from) {
    FILE_FIELDS.forEach(function (k) { if (from && from[k]) en[k] = from[k]; });
    return en;
  }

  /* Which kind owns a slug on a page that is not on screen.

     An edit staged for another page carries its export form but not its
     element, and the serializer differs by kind. A consumer names the slugs
     it owns when it claims them, so this is a lookup rather than a guess. */
  var slugKinds = {};
  function kindForSlug(slug) { return slugKinds[slug] || null; }

  var imageRegion = {

    /* Allocate the next IMG## label. Ids run in document order per session
       and are display labels only; nothing exported depends on them. */
    nextId: function () {
      imgSeq++;
      return "IMG" + (imgSeq < 10 ? "0" + imgSeq : String(imgSeq));
    },

    /* A seed is placeholder filler under img/seed/. It shows only while a
       region holds no real image, and is never editable. */
    isSeed: function (src) { return String(src).indexOf("img/seed/") === 0; },

    /* "blockade-runner_01.png" -> "blockade runner 01" */
    humanize: function (name) {
      return String(name).replace(/\.[a-z0-9]+$/i, "").replace(/[-_]+/g, " ").trim();
    },

    /* Build an entry from an authored <img>.

       A kind may add fields of its own through readEntry: the gallery tiles
       keep a preferred width and a priority there. The core carries them and
       never reads them - what they mean is the consumer's business. */
    fromImg: function (im, kind) {
      /* The entry's src is the display copy, and the page's src is the file
         it shows. The two differ when Display Maximum UHD shows the original:
         read() takes the display copy from data-hd. An entry built from the
         attribute wrote the original into data-hd at the next save, and the
         display copy was then an orphan. */
      var shown = im.getAttribute("src") || "";
      var files = engine().read(im);
      var src = files.src || shown;
      var en = {
        src: src, alt: im.getAttribute("alt") || "",
        caption: im.getAttribute("data-caption") || "",
        preview: shown, empty: false,
        isSeed: imageRegion.isSeed(src), imgId: null, orig: null
      };
      copyFiles(en, files);
      if (kind && kind.readEntry) {
        var extra = kind.readEntry(im) || {};
        Object.keys(extra).forEach(function (k) { en[k] = extra[k]; });
      }
      if (!en.isSeed) en.imgId = imageRegion.nextId();
      en.orig = { caption: en.caption, alt: en.alt };
      return en;
    },

    /* The extra field names a kind declares, or none. */
    fieldsOf: function (kind) { return (kind && kind.fields) || []; },

    /* Build an entry from a photo the image engine made. The one way in.

       carry is taken as it stands: its caption, its alt, its two switches
       and a kind's own fields, so an alt the reader emptied stays empty.
       Its file fields are not: they name the files being replaced. With no
       carry the alt is the file's name. */
    fromPhoto: function (photo, carry, kind) {
      var en = {
        src: photo.files.hd,
        alt: carry ? String(carry.alt || "") : imageRegion.humanize(photo.from),
        caption: carry ? String(carry.caption || "") : "",
        preview: photo.urls.hd, empty: false, isSeed: false,
        imgId: imageRegion.nextId(), orig: null, photo: photo
      };
      copyFiles(en, engine().fields(photo));
      if (carry && carry.uhd) en.uhd = true;
      if (carry && carry.truesize) { en.truesize = true; en.uhd = true; }
      var defaults = (kind && kind.defaults) || {};
      imageRegion.fieldsOf(kind).forEach(function (k) {
        en[k] = (carry && carry[k] !== undefined) ? carry[k] : defaults[k];
      });
      en.orig = { caption: en.caption, alt: en.alt };
      return en;
    },

    /* An unfilled slot: a drop target that is never exported. It carries the
       kind's defaults so the tile it becomes starts where a new tile should,
       rather than with nothing. */
    emptySlot: function (kind) {
      var en = { src: "", alt: "", caption: "", preview: "", empty: true,
                 isSeed: false, imgId: null, orig: null };
      var defaults = (kind && kind.defaults) || {};
      imageRegion.fieldsOf(kind).forEach(function (k) { en[k] = defaults[k]; });
      return en;
    },

    /* The only shape that reaches a file: strings, no slots, no previews.

       The file fields travel with it, and so do a kind's own fields. Both
       are part of what the page is written with, so they belong in the
       export and in the pending store that carries an edit between pages. */
    exportForm: function (entries, kind) {
      var extra = imageRegion.fieldsOf(kind);
      return entries.filter(function (e) { return !e.empty; })
        .map(function (e) {
          var o = copyFiles({ src: e.src, alt: e.alt, caption: e.caption }, e);
          extra.forEach(function (k) { o[k] = e[k]; });
          return o;
        });
    },

    /* The inverse: rebuild live entries from an export form. */
    fromExportForm: function (list, kind) {
      var extra = imageRegion.fieldsOf(kind);
      return list.map(function (o) {
        var en = { src: o.src, alt: o.alt, caption: o.caption, preview: o.src,
                   empty: false, isSeed: imageRegion.isSeed(o.src),
                   imgId: null, orig: { caption: o.caption, alt: o.alt } };
        copyFiles(en, o);
        extra.forEach(function (k) { en[k] = o[k]; });
        return en;
      });
    },

    /* Release a dropped file's preview URL. Deferred, because an <img> or an
       open lightbox may still be painting it after the entry is replaced. */
    revokePreview: function (en) {
      /* A held photo's URL belongs to the photo, not to the entry. Another
         entry or a box may be showing it, and the store lets it go when
         nothing does. */
      if (en && en.photo) return;
      if (en && en.preview && en.preview.indexOf("blob:") === 0) {
        var url = en.preview;
        window.setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
      }
    },

    /* Consumers claim their own elements. The core walks the claims in the
       order they were made and takes the first that says yes, so a new
       consumer is a new claim rather than an edit to scan().

       A consumer that loads after this file registers its claim at load; the
       first scan happens no earlier than the first edit() call, which is why
       the load order in every page head puts it before that can happen. */
    claim: function (matches, kind, slugs) {
      claims.push({ matches: matches, kind: kind });
      /* A page the editor is not on has no element to match, so a consumer
         also names the slugs it owns. That is what lets an edit made here
         be written into that page correctly. */
      (slugs || []).forEach(function (s) { slugKinds[s] = kind; });
    },
    claimFor: function (el) {
      for (var i = 0; i < claims.length; i++) {
        if (claims[i].matches(el)) return claims[i].kind;
      }
      return null;
    },

    /* Render entries as authored markup for the export splice. indent is
       read from the source span, so the output matches the file's own
       hand-written style. Returns the inner text for spliceRegion.

       A kind that is not a list of <img> supplies its own; this is the
       default, and the two carousel kinds use it. */
    serializeFor: function (entries, indent, kind, head) {
      return (kind && kind.serialize)
        ? kind.serialize(entries, indent, head)
        : imageRegion.serialize(entries, indent, kind);
    },

    /* The attributes a region's head writes onto the region's own open tag,
       as a map for spliceRegion, or null for none. A carousel's head holds
       its frame choice, which lives on its wrapper; an empty choice is Auto
       and removes the attribute. The rule is the core's and not a kind's:
       an export made for another page has no kind for a carousel, because
       carousels claim no slugs, and it has the stored head. */
    openAttrs: function (head) {
      if (!head || typeof head.shape !== "string") return null;
      return { "data-shape": head.shape || null };
    },

    /* One attribute a line: the src first, then what the browser reads to
       pick and place a copy, then the words, then the editor's notes on the
       files. A seed comes out as src, alt and caption, as it always has.
       The kind's slot is what lets srcset be written. */
    serialize: function (entries, indent, kind) {
      var slot = kind ? kind.slot : null;
      var pad = "\n" + indent + "       ";
      var lines = entries.map(function (en) {
        /* the src is the contract's too: with Display Maximum UHD on, it is
           the original and not the entry's display copy */
        var src = en.src, shown = "", notes = "";
        engine().attrs(en, slot).forEach(function (a) {
          if (a[0] === "src") { src = a[1]; return; }
          var line = pad + a[0] + '="' + escAttr(a[1]) + '"';
          if (a[0].indexOf("data-") === 0) notes += line;
          else shown += line;
        });
        return indent + '  <img src="' + escAttr(src) + '" loading="lazy"' + shown +
               pad + 'alt="' + escAttr(en.alt) + '"' +
               (en.caption ? pad + 'data-caption="' + escAttr(en.caption) + '"' : "") +
               notes + " />";
      });
      return lines.length ? "\n" + lines.join("\n") + "\n" + indent : "\n" + indent;
    },

    /* Register one image region and return the record the core and the
       consumer both work from. spec:

         slug   the [edit:slug] pair the export splices
         el     the authored container
         kind   a KIND descriptor, see below
         tpl    the <template> that owns el, for a deep-dive region

       A third consumer registers here with its own kind and draws the
       model however it likes. The core does not draw. */
    register: function (spec) {
      var entries = [];
      Array.prototype.forEach.call(spec.kind.readImgs(spec.el), function (im) {
        entries.push(imageRegion.fromImg(im, spec.kind));
      });
      var r = {
        slug: spec.slug, el: spec.el, kind: spec.kind, tpl: spec.tpl || null,
        seeds: entries.filter(function (e) { return e.isSeed; }),
        model: entries.filter(function (e) { return !e.isSeed; }),
        original: null,
        /* The head is what a region holds that is not an image, read off
           the authored markup by the kind: a gallery train's band. A kind
           with no readHead has none, and nothing else changes for it. */
        head: spec.kind.readHead ? spec.kind.readHead(spec.el) : null,
        headOriginal: null,
        live: spec.kind.deferLive ? null : spec.el,
        chip: null, plusChip: null, trashChip: null, observer: null
      };
      r.original = imageRegion.exportForm(r.model, r.kind);
      r.headOriginal = JSON.stringify(r.head || null);
      /* A region that may legitimately hold no images still needs somewhere
         to drop one, and it has no seeds to fall back on. */
      if (!r.model.length && !r.seeds.length && spec.kind.mayBeEmpty) {
        r.model.push(imageRegion.emptySlot(spec.kind));
      }
      gals.push(r);
      return r;
    },

    /* What the region shows. Seeds are all-or-nothing filler, so they come
       back on their own the moment the model empties. There is no
       restoreSeeds operation, because this rule is the whole mechanism. */
    displayed: function (r) { return r.model.length ? r.model : r.seeds; },

    /* Does the region export something other than what the file already
       holds? Compared through the export form, so a preview URL or an
       IMG## label can never make a region look edited. */
    dirty: function (r) {
      return JSON.stringify(imageRegion.exportForm(r.model, r.kind)) !== JSON.stringify(r.original) ||
             JSON.stringify(r.head || null) !== r.headOriginal;
    },

    /* Model operations. Each returns the entry it displaced, if any. */
    replaceAt: function (r, i, en) {
      var old = r.model[i];
      r.model[i] = en;
      if (old) imageRegion.revokePreview(old);
      return old;
    },
    append: function (r, en) { r.model.push(en); return null; },
    addEmptySlot: function (r) { r.model.push(imageRegion.emptySlot(r.kind)); return null; },
    remove: function (r, i) {
      var old = r.model.splice(i, 1)[0];
      if (old) imageRegion.revokePreview(old);
      /* no images and no seed fallback would leave nothing to rebuild - keep
         a drop target alive so the region stays recoverable from the UI */
      if (!r.model.length && !r.seeds.length) r.model.push(imageRegion.emptySlot(r.kind));
      return old;
    },

    /* Discard every change and rebuild the model from the published form. */
    revert: function (r) {
      r.model.forEach(imageRegion.revokePreview);
      r.model = imageRegion.fromExportForm(r.original, r.kind);
      r.model.forEach(function (en) { en.imgId = imageRegion.nextId(); });
      r.head = JSON.parse(r.headOriginal);
      if (!r.model.length && !r.seeds.length && r.kind.mayBeEmpty) {
        r.model.push(imageRegion.emptySlot(r.kind));
      }
    }
  };

  /* How wide a carousel's picture is drawn, for the browser's pick between
     the small copy and the display copy. Measured in the browser, not taken
     from the stylesheet's numbers: a card's stage is at most 84vw up to
     880px, 48vw up to the 1180px content width, and 562px above it. The
     drawer's stage is at most 84vw up to 560px, and 460px above it.

     widest is the most either string gives, at the top of its phone band:
     84vw of 880px, and 84vw of 560px. A display copy narrower than that
     gets no srcset, and keeps its own size. */
  var CARD_SLOT = { sizes: "(max-width: 880px) 84vw, (max-width: 1180px) 48vw, 562px", widest: 740 };
  var DRAWER_SLOT = { sizes: "(max-width: 560px) 84vw, 460px", widest: 471 };

  /* ------------------------------------------------------------
     REGION KINDS

     A kind says how one family of consumers differs. The core reads these
     properties; it never asks what kind a region is. That is what lets a
     new consumer be added by writing a kind rather than by editing the
     core, and it is why the tile grid in Phase 4 needs no change here.

       name           for console messages
       readImgs(el)   find the authored <img> elements in a container
       deferLive      true if the live element only exists sometimes
       onScreen(r)    is this region's live DOM on screen right now
       syncSource     write the model back into the authored container too
       dropWhenEmpty  remove the live container once the model empties
       seedFallback   an empty export falls back to the seed images
       mayBeEmpty     exporting nothing is legitimate, so do not warn
       describe(g)    { name, noun }: what a box is called, and the word its
                      sentences use for the region. Default: the project's
                      title, and "carousel".
       rowExtras(host, values, changed)
                      draw the kind's own fields as controls for one row of
                      the PHOTOS box. values holds them while the box is
                      open, and Apply writes them onto the entry.
       captionWrite(g, en, value)
                      put a saved caption on screen in place. A kind that
                      draws itself supplies it, because a redraw would take
                      the element the reader's next click is aimed at.
       slot           how wide the picture is drawn, { sizes, widest },
                      which srcset needs; no srcset is written without it
       single         ADD PHOTO takes one file, and a second replaces it,
                      for a consumer that holds one image
       shapes         true for a kind that shows one photo at a time in a
                      frame: its PHOTOS box offers Auto, Landscape and
                      Portrait, and its head carries the choice as shape
       rowNote        suffix for the region's rows in the panel
       lastImageNote(r) warning shown before the last image is deleted
       readHead(el)   the region's non-image fields, read off the markup
       adopt(r)       wire an element this trunk did not see at load
       drop(r)        the inverse, before the region is forgotten
     ------------------------------------------------------------ */
  /* A carousel's head: its frame choice, as its wrapper writes it. The word
     is kept as written, so an export that did not change it writes the open
     tag back as it was. work.js reads anything but landscape or portrait as
     Auto, and says so in the console. */
  function readShapeHead(el) {
    return { shape: (el && el.getAttribute("data-shape")) || "" };
  }

  var KIND = {

    /* The seven project carousels. Built by work.js at load, so by the time
       the editor scans, the authored imgs have moved into .gallery__stage. */
    carousel: {
      name: "carousel",
      readImgs: function (el) {
        var stage = el.querySelector(".gallery__stage");
        return stage ? stage.querySelectorAll("img") : el.querySelectorAll("img");
      },
      deferLive: false,
      onScreen: function () { return true; },
      syncSource: false,
      dropWhenEmpty: false,
      seedFallback: true,
      mayBeEmpty: false,
      slot: CARD_SLOT,
      shapes: true,
      readHead: readShapeHead,
      rowNote: "",
      lastImageNote: function (r) {
        return r.seeds.length
          ? "\n\nThis is the last image: the seed placeholders will return."
          : "\n\nThis is the last image: the gallery will be empty.";
      }
    },

    /* The carousels inside a <template class="deepdive">. Template content is
       inert, so it still holds its clean authored children, and there is no
       live element at all until the drawer clones the template. */
    deepdive: {
      name: "deep-dive carousel",
      readImgs: function (el) { return el.querySelectorAll("img"); },
      deferLive: true,
      onScreen: function () { return doc.body.classList.contains("dd-open"); },
      syncSource: true,
      dropWhenEmpty: true,
      seedFallback: false,
      mayBeEmpty: true,
      slot: DRAWER_SLOT,
      shapes: true,
      readHead: readShapeHead,
      rowNote: ' <span class="ced-hidden">(dd)</span>',
      lastImageNote: function () {
        return "\n\nThis is the last image: the deep-dive gallery will show nothing.";
      }
    }
  };

  /* The carousels claim themselves, the same way a consumer in another file
     does. scan() has no special case for them, and adding a fourth consumer
     is a fourth claim rather than an edit to the scanner. */
  imageRegion.claim(function (el) {
    return !!(el.classList && el.classList.contains("gallery"));
  }, KIND.carousel);

  /* Published for the consumers that do not live in this file. The gallery
     tile grid registers through this rather than growing its own model. */
  AMH.tool.imageRegion = imageRegion;
  AMH.tool.imageKinds = KIND;

  /* The editor's own behaviour, for a consumer that draws its own region.
     A consumer that finds itself reimplementing any of these should be given
     the missing hook instead. The photo tools are published in section 7.

       changed     "an edit happened here": mark unexported, stage it for the
                   page, refresh the panel and the chips
       editorOn    whether editor mode is on right now */
  AMH.tool.changed = function (g) {
    exportedClean = false;
    pendingSyncGallery(g);
    refreshDirtyUI();
    refreshImageRows();
  };
  AMH.tool.editorOn = function () { return active; };

  /* The image region for a slug, or null. Registration happens inside
     scan(), so a consumer that claimed the kind never sees the record it
     produced; this is how it gets one back. */
  AMH.tool.regionFor = function (slug) {
    for (var i = 0; i < gals.length; i++) {
      if (gals[i].slug === slug) return gals[i];
    }
    return null;
  };

  /* ------------------------------------------------------------
     HELD PHOTOS

     A carousel does not ask the reader to copy a file by hand. A photo
     added to one goes through imagesengine.js, which makes its three
     files and holds them until a save writes them into img/work/, beside
     the page that shows them. That file says what a photo becomes, how
     it is named and what is cut out of it.

     This block is what the editor knows and the engine does not: which
     photos the edits still show, on this page and on every page with an
     edit waiting.
     ------------------------------------------------------------ */

  /* The image engine, or an error that says what is wrong. A page served
     from an old cache can load this file without it, and carrying on
     would write images without the files they name.

     A month file written before the engine's tag existed loads this file
     without it too, until its next publish. Such a page has no image
     region, so the calls below that only let go of photos or look for
     them do nothing there, and a text edit saves as it always has. */
  function engine() {
    if (!AMH.images) {
      throw new Error("imagesengine.js did not load, so this page cannot read " +
        "or write images. Reload the page.");
    }
    return AMH.images;
  }

  /* Every base path an edit shows: the regions on this page, and the edits
     waiting for every page. */
  function photoUsed() {
    var used = {};
    function add(src) { if (src) used[engine().baseOf(src)] = true; }
    gals.forEach(function (g) {
      g.model.forEach(function (en) { add(en.src); });
    });
    var all = pendingRead();
    Object.keys(all).forEach(function (path) {
      var waiting = (all[path] || {}).gallery || {};
      Object.keys(waiting).forEach(function (slug) {
        (waiting[slug] || []).forEach(function (o) { if (o) add(o.src); });
      });
    });
    return used;
  }

  /* Stop holding every photo no edit shows. A page without the engine
     holds none. */
  function photoPrune() {
    if (AMH.images) AMH.images.prune(photoUsed());
  }

  /* "1920 x 960 · 212 KB": the display copy, which is what a page shows */
  function photoSize(photo) {
    return photo.w + " x " + photo.h + " · " +
      Math.max(1, Math.round(photo.blobs.hd.size / 1024)) + " KB";
  }

  /* Said when an original is over the size GitHub takes in a push. The
     photo is kept all the same, so the words say what is left to do. */
  function photoLimitNote(photo) {
    return "The original is " + (photo.bytes / 1048576).toFixed(1) + " MB, over the " +
      engine().GIT_FILE_LIMIT_MB + " MB GitHub takes in one file. It is saved all " +
      "the same, and that one file has to be uploaded by hand.";
  }

  /* Give a region's entries the photos this tab holds for them. An entry
     rebuilt from the pending store is strings, and its preview would ask
     the server for a file that is not there yet. True when one changed. */
  function photoLink(g) {
    var changed = false;
    g.model.forEach(function (en) {
      var photo = en.src ? engine().photo(engine().baseOf(en.src)) : null;
      if (!photo || en.photo === photo) return;
      en.photo = photo;
      en.preview = photo.urls.hd;
      changed = true;
    });
    return changed;
  }

  /* The held photos these pages show, as the bytes a save or a bundle
     writes: three files for each photo, keyed by the path each is written
     to. A photo a save has already written is not written again. */
  function photoFiles(paths) {
    var srcs = [];
    var here = currentPage();
    var all = pendingRead();
    (paths || []).forEach(function (path) {
      if (path === here) {
        gals.forEach(function (g) {
          g.model.forEach(function (en) { if (en.src) srcs.push(en.src); });
        });
      }
      var waiting = (all[path] || {}).gallery || {};
      Object.keys(waiting).forEach(function (slug) {
        (waiting[slug] || []).forEach(function (o) { if (o && o.src) srcs.push(o.src); });
      });
    });
    /* no image to carry, so nothing to ask the engine for */
    if (!srcs.length) return Promise.resolve({});
    var want = {};
    try {
      srcs.forEach(function (src) { want[engine().baseOf(src)] = true; });
    } catch (err) {
      return Promise.reject(err);
    }
    return engine().files(Object.keys(want));
  }

  /* ------------------------------------------------------------
     THE CAROUSEL CONSUMER

     Both kinds registered today draw the same way, as one visible photo
     with navigation, so they share this renderer. A consumer that shows
     many images at once supplies its own instead; the core does not care.
     ------------------------------------------------------------ */
  function galDirty(g) { return imageRegion.dirty(g); }
  function displayedEntries(g) { return imageRegion.displayed(g); }
  function liveHolder(g) {
    if (!g.live || !g.live.isConnected) return null;
    if (!g.kind.onScreen(g)) return null;
    return g.live.querySelector(".gallery__holder");
  }
  function activeIndex(g) {
    if (!g.live || !g.live.isConnected) return 0;
    var imgs = g.live.querySelectorAll(".gallery__stage img");
    for (var i = 0; i < imgs.length; i++) {
      if (imgs[i].classList.contains("is-active")) return i;
    }
    return 0;
  }

  /* Draw entries as <img> elements. preview shows a photo no save has
     written from its blob: URLs, which go with no slot and so no srcset;
     everything else is drawn with the paths the file is written with. */
  function setGalleryImgs(el, entries, preview, tile, slot) {
    el.innerHTML = "";
    entries.forEach(function (en) {
      var im = doc.createElement("img");
      if (en.empty) im.src = tile || PHOTO_TILE;
      else {
        var held = preview && en.photo;
        var shown = held ? engine().preview(en.photo) : en;
        if (held) { shown.uhd = en.uhd; shown.truesize = en.truesize; }
        engine().attrs(shown, held ? null : slot)
          .forEach(function (a) { im.setAttribute(a[0], a[1]); });
      }
      im.alt = en.alt || "";
      im.setAttribute("loading", "lazy");
      if (en.caption) im.setAttribute("data-caption", en.caption);
      el.appendChild(im);
    });
  }

  /* A carousel's frame choice lives on its wrapper, where work.js reads it
     at the next build: the word, or no attribute for Auto. A head with no
     shape field is not a carousel's, and changes nothing. */
  function writeShape(el, head) {
    if (!el || !head || typeof head.shape !== "string") return;
    if (head.shape) el.setAttribute("data-shape", head.shape);
    else el.removeAttribute("data-shape");
  }
  /* The head a view shows: the published one in the before view. */
  function shownHead(g) {
    return viewing === "before" && g.headOriginal ? JSON.parse(g.headOriginal) : g.head;
  }

  /* A deep dive's carousel is also written into its template, which stays in
     clean export form: no blob previews and no slots. Template content always
     reports isConnected false, so a bare null check is the right guard. */
  function syncGallerySource(g, list) {
    if (!g.kind.syncSource || !g.el) return;
    writeShape(g.el, shownHead(g));
    setGalleryImgs(g.el, list.filter(function (e) { return !e.empty; }), false, null, g.kind.slot);
  }

  /* re-render one gallery from its model: restore a plain <img> list, then
     let the page's own builder re-enhance it. showIndex navigates the rebuilt
     carousel (rebuilds always land on photo 0). */
  function renderGallery(g, viewEntries, showIndex) {
    /* A kind that does not draw one photo at a time draws itself. The rest
       of this function is the carousel renderer, which both carousel kinds
       share; a consumer with a different shape supplies its own. */
    if (g.kind.render) {
      g.kind.render(g, viewEntries || displayedEntries(g), showIndex);
      refreshImageRows();
      requestReposition();
      return;
    }
    var list = viewEntries || displayedEntries(g);
    syncGallerySource(g, list);
    var live = g.live;
    if (live && live.isConnected) {
      if (g.observer) { g.observer.disconnect(); g.observer = null; }
      if (g.kind.dropWhenEmpty && !list.length) {
        /* an empty region of this kind is legitimate - remove the container */
        if (live.parentNode) live.parentNode.removeChild(live);
        g.live = null;
      } else {
        writeShape(live, shownHead(g));
        setGalleryImgs(live, list, true, PHOTO_TILE, g.kind.slot);
        live.classList.remove("is-ready", "gallery--single");
        if (AMH.work) AMH.work.buildGalleries();
        if (showIndex > 0) {
          var dots = live.querySelectorAll(".gallery__dot");
          if (dots[showIndex]) dots[showIndex].click();
        }
        attachGalleryRuntime(g);
      }
    }
    refreshImageRows();
    requestReposition();
  }

  /* drop handling + chip-follows-active-photo wiring; holder is recreated on
     every rebuild, so this runs after each one (listeners dedupe by flag) */
  function attachGalleryRuntime(g) {
    var holder = liveHolder(g);
    if (!holder) return;
    if (!holder.__cedDrop) {
      holder.__cedDrop = true;
      holder.addEventListener("dragover", function (e) {
        if (!active) return;
        e.preventDefault(); e.stopPropagation();
        e.dataTransfer.dropEffect = "copy";
        holder.classList.add("ced-dropping");
      });
      holder.addEventListener("dragleave", function () {
        holder.classList.remove("ced-dropping");
      });
      holder.addEventListener("drop", function (e) {
        if (!active) return;
        e.preventDefault(); e.stopPropagation();
        holder.classList.remove("ced-dropping");
        var files = Array.prototype.filter.call(
          (e.dataTransfer && e.dataTransfer.files) || [],
          function (f) { return /^image\//.test(f.type); });
        if (!files.length) return;
        /* A drop adds its photos, through the same three steps as (+). It
           does not replace the photo on screen: Replace in PHOTOS does
           that, on a row that names the photo it means. */
        addPhotoBox(g, { files: files });
      });
    }
    var stage = g.live.querySelector(".gallery__stage");
    if (stage && window.MutationObserver) {
      if (g.observer) g.observer.disconnect();   /* drawer reopens re-attach; don't stack */
      g.observer = new MutationObserver(function () {
        updateGalleryChip(g);
        captionPencil(g);
      });
      g.observer.observe(stage, { attributes: true, attributeFilter: ["class"], subtree: true });
    }
    updateGalleryChip(g);
    captionPencil(g);
  }

  function updateGalleryChip(g) {
    if (!g.chip) return;
    var en = displayedEntries(g)[activeIndex(g)] || null;
    g.chip.textContent = !en ? "IMG" : (en.empty ? "DROP" : (en.isSeed ? "SEED" : en.imgId));
    /* every state opens the same box, so a seed chip is a live chip */
    g.chip.title = "Edit the photos in this carousel";
    g.chip.classList.toggle("ced-edited", galDirty(g));
    /* the photo on screen changed, and the trash can follows it */
    if (g.trashChip && g.chip.style.display !== "none") {
      g.trashChip.style.display = trashable(g) ? "" : "none";
    }
  }

  /* One row per text region, drawn again whenever the set of them changes.

     A block a list adds brings its regions with it, so the rows cannot be
     written once at build time: the panel would go on describing the page
     as it was while its own count said otherwise. */
  function refreshRegionRows() {
    if (!regRowsEl) return;
    regRowsEl.innerHTML = "";
    regions.forEach(function (r) {
      var row = doc.createElement("button");
      row.type = "button";
      row.className = "ced-panel__row" + (r.edited ? " ced-edited" : "");
      row.innerHTML = '<span class="ced-b">' + r.badge + "</span><span>" + r.slug + "</span>" +
        (r.generated ? ' <span class="ced-hidden">(generated)</span>' : "") +
        (r.visible ? "" : ' <span class="ced-hidden">(hidden)</span>') +
        '<span class="ced-dot"></span>';
      /* A deep dive is written from Markdown the template carries, so its
         own box would be editing the half that follows. The row opens the
         project's form on the view that owns it. */
      row.addEventListener("click", function () {
        var owner = ddOwner(r.slug);
        if (owner) projectForm("projects", owner, 2);
        else openModal(r);
      });
      r.row = row;
      regRowsEl.appendChild(row);
    });
  }

  function refreshImageRows() {
    if (!imgRowsEl) return;
    imgRowsEl.innerHTML = "";
    gals.forEach(function (g) {
      var isDirty = galDirty(g);
      function addRow(label, i) {
        var row = doc.createElement("button");
        row.type = "button";
        row.className = "ced-panel__row ced-panel__row--img" + (isDirty ? " ced-edited" : "");
        row.innerHTML = '<span class="ced-b">' + label + "</span><span>" + g.slug +
          "</span>" + g.kind.rowNote +
          '<span class="ced-dot"></span>';
        row.addEventListener("click", function () {
          revealGallery(g, i);
          photosBox(g, i);
        });
        imgRowsEl.appendChild(row);
      }
      if (!g.model.length) { addRow("SEED", 0); return; }
      g.model.forEach(function (en, i) {
        addRow(en.empty ? "SLOT" : en.imgId, i);
      });
    });
  }
  function revealGallery(g, i) {
    if (g.live && g.live.isConnected && g.kind.onScreen(g)) {
      g.live.scrollIntoView({ block: "center" });
      var dots = g.live.querySelectorAll(".gallery__dot");
      if (dots[i]) dots[i].click();
    }
  }

  /* the deep-dive drawer clones its template on every open; catch the open
     (via the Learn more button) and adopt the clone's gallery as g.live */
  function hookOpenDrawer() {
    if (!doc.body.classList.contains("dd-open")) return;
    var t = doc.querySelector(".dd__title");
    var body2 = doc.querySelector(".dd__body");
    if (!t || !body2) return;
    var liveG = body2.querySelector(".gallery");
    /* The drawer names the template it cloned. A title match was the older
       way, and it broke as soon as a head moved from an attribute into the
       markup the editor writes. */
    var from = AMH.work && AMH.work.openTemplate ? AMH.work.openTemplate() : null;
    gals.forEach(function (g) {
      if (!g.kind.deferLive || !g.tpl) return;
      var mine = from ? g.tpl === from
        : (g.tpl.getAttribute("data-title") || "") === t.textContent;
      if (mine) {
        g.live = liveG;
        if (g.live) attachGalleryRuntime(g);
      }
    });
    requestReposition();
  }

  /* a text apply on a deepdive region replaces the template's children, which
     orphans our reference to the gallery inside it - re-resolve it */
  function relinkTplGalleries(r) {
    if (!r.el || r.el.tagName !== "TEMPLATE") return;
    scanTemplate(r);                     /* re-point, and take up a new one */
    gals.forEach(function (g) {
      if (g.tpl !== r.el) return;
      if (!g.el || !r.el.content.contains(g.el)) {
        console.warn("[site editor] " + g.slug +
          " gallery markup was removed by a text edit - image edits for it are disabled until revert.");
        return;
      }
      /* The apply replaced the template's children, so the gallery inside
         it is the empty one the new markup carried. The model is what fills
         it, dirty or not, or the drawer would open on nothing. */
      renderGallery(g);
    });
  }

  /* ==========================================================
     5. EDITOR UI
     ----------------------------------------------------------
     Everything a person sees once the editor is on: the injected
     styles, the badge chips, the region panel, and the edit modal.

     The styles go into <head> at runtime, after site.css, so the
     editor wins on equal specificity without any !important.
     ========================================================== */
  /* ---------------- styles (injected only on first activation) ---------------- */
  var CSS = "" +
    ".ced-chip{position:absolute;z-index:850;width:26px;height:26px;padding:0;border-radius:50%;" +
    "border:1px solid var(--accent);background:var(--panel);color:var(--accent-bright);" +
    "font:700 9px/1 Consolas,monospace;letter-spacing:.02em;cursor:pointer;" +
    "display:grid;place-items:center;box-shadow:0 4px 14px -6px var(--accent-glow);" +
    "transform:translate(-40%,-55%);transition:transform .15s ease,background .15s;}" +
    ".ced-chip:hover{transform:translate(-40%,-55%) scale(1.25);background:var(--panel-2);}" +
    ".ced-chip.ced-edited{border-color:var(--c-orange);color:var(--c-orange);}" +
    ".ced-panel{position:fixed;right:14px;bottom:14px;z-index:3100;width:250px;max-height:min(70vh,560px);" +
    "display:flex;flex-direction:column;background:var(--panel);border:1px solid var(--line);" +
    "border-radius:12px;box-shadow:0 24px 60px -30px rgba(0,0,0,.9);font-size:.78rem;color:var(--text-soft);}" +
    ".ced-panel__head{padding:.6rem .8rem;border-bottom:1px solid var(--line-soft);display:flex;" +
    "align-items:center;gap:.4rem;font-weight:800;letter-spacing:.14em;" +
    "font-size:.66rem;color:var(--accent);text-transform:uppercase;}" +
    /* the name takes the row and the two controls sit at the right end,
       so the close is where a window's close always is */
    ".ced-panel__view{margin-left:auto;font-weight:600;letter-spacing:0;" +
    "text-transform:none;color:var(--muted);}" +
    ".ced-panel__view b{color:var(--c-yellow);font-weight:700;}" +
    ".ced-panel__x{display:flex;align-items:center;justify-content:center;flex:none;" +
    "width:22px;height:22px;padding:0;border:1px solid var(--line);border-radius:50%;" +
    "background:none;color:var(--muted);cursor:pointer;transition:color .2s,border-color .2s;}" +
    ".ced-panel__x:hover{border-color:var(--accent);color:var(--text);}" +
    ".ced-panel__x svg{width:12px;height:12px;display:block;}" +
    /* the tick the Rebuild button wears while it says Done */
    ".ced-tick{width:11px;height:11px;margin-right:.25rem;vertical-align:-1px;}" +
    /* the unsaved-changes chip: a full-width bar under the panel head, shown
       only when something is waiting */
    ".ced-pending{display:block;width:100%;border:0;border-bottom:1px solid var(--line-soft);" +
    "background:rgba(240,180,41,.12);color:var(--c-yellow);font:700 .64rem/1.5 Consolas,monospace;" +
    "letter-spacing:.06em;padding:.4rem .8rem;text-align:left;cursor:pointer;}" +
    ".ced-pending:hover{background:rgba(240,180,41,.2);}" +
    ".ced-publish{background:rgba(74,165,232,.1);color:var(--accent-bright);}" +
    ".ced-publish:hover{background:rgba(74,165,232,.18);}" +
    ".ced-handoff__zone{margin:.8rem 1.1rem;padding:1.6rem 1rem;border-radius:10px;" +
    "border:2px dashed var(--accent);background:rgba(74,165,232,.06);text-align:center;" +
    "cursor:pointer;display:flex;flex-direction:column;gap:.35rem;}" +
    ".ced-handoff__zone strong{color:var(--text);font-size:.9rem;}" +
    ".ced-handoff__zone code{color:var(--accent-bright);font-family:Consolas,monospace;}" +
    ".ced-handoff__zone span{color:var(--muted);font-size:.75rem;}" +
    ".ced-handoff__zone.is-over{background:rgba(74,165,232,.18);}" +
    ".ced-handoff__zone.is-wrong{border-color:var(--c-red,#e5534b);}" +
    ".ced-handoff__zone.is-warn{border-color:#f0883e;}" +
    ".ced-handoff__zone:focus-visible{outline:2px solid var(--accent);outline-offset:2px;}" +
    /* the remembered folder, offered in the box that is already open */
    ".ced-handoff__offer{margin:.8rem 1.1rem 0;padding:.7rem .85rem;border-radius:10px;" +
    "border:1px solid var(--accent);background:rgba(74,165,232,.08);display:flex;" +
    "flex-direction:column;gap:.35rem;}" +
    ".ced-handoff__offer strong{color:var(--text);font-size:.85rem;}" +
    ".ced-handoff__why{color:var(--muted);font-size:.72rem;line-height:1.5;max-width:var(--ced-read);}" +
    ".ced-handoff__offerbtns{display:flex;gap:.5rem;flex-wrap:wrap;margin-top:.15rem;}" +
    /* the display above beats the browser's own rule for [hidden], so the
       offer has to be told to go away in the same breath */
    ".ced-handoff__offer[hidden]{display:none;}" +
    /* THE PLACE IN THE LINE, at the right of the head.
       This is the one piece of the wizard plan that was deferred, because
       it had to read the line of asks. It reads required() and expected,
       which are that line, so it is a fact and not an estimate. It sat
       beside the file name at the name's own size; margin-left:auto is
       what puts it at the right of a flex row, and the badge's face is
       what tells it apart from the name. It costs no height. */
    ".ced-handoff__count{margin-left:auto;font:700 10px/1 Consolas,monospace;" +
    "letter-spacing:.08em;text-transform:uppercase;color:var(--muted);white-space:nowrap;}" +
    /* nothing sits in the top right of an ask or a confirm: the 3rem in the
       shared head rule clears the region editor's close control, which
       these boxes do not have, and it would hold the count off the edge */
    ".ced-handoff .ced-modal__head{padding-right:1.1rem;}" +
    ".ced-handoff__list{display:flex;flex-wrap:wrap;gap:.3rem;padding:0 1.1rem .2rem;}" +
    ".ced-handoff__item{font:700 9.5px/1 Consolas,monospace;letter-spacing:.06em;border-radius:4px;padding:3px 6px;border:1px solid var(--line);color:var(--dim);}" +
    ".ced-handoff__item.is-now{border-color:var(--accent);color:var(--accent-bright);}" +
    ".ced-handoff__item.is-done{border-color:rgba(74,165,232,.3);color:var(--muted);text-decoration:line-through;}" +
    ".ced-handoff__item.is-none{border-style:dashed;color:var(--dim);}" +
    ".ced-panel__list{flex:1 1 auto;min-height:0;overflow-y:auto;padding:.35rem 0;}" +
    ".ced-panel__row{display:flex;gap:.55rem;align-items:center;width:100%;padding:.22rem .8rem;" +
    "border:0;background:none;color:var(--text-soft);font:inherit;cursor:pointer;text-align:left;}" +
    ".ced-panel__row:hover{background:var(--panel-2);color:var(--text);}" +
    ".ced-panel__row .ced-b{flex:none;color:var(--accent-bright);font:700 10px/1 Consolas,monospace;}" +
    ".ced-panel__row .ced-dot{flex:none;margin-left:auto;width:7px;height:7px;border-radius:50%;" +
    "background:var(--c-orange);opacity:0;}" +
    ".ced-panel__row.ced-edited .ced-dot{opacity:1;}" +
    ".ced-panel__row .ced-hidden{color:var(--dim);font-size:.62rem;}" +
    /* one line, and it wraps rather than pushing the panel wider */
    ".ced-panel__build{display:flex;align-items:baseline;gap:.4rem;flex-wrap:wrap;" +
    "padding:.4rem .6rem;border-bottom:1px solid var(--line-soft);font-size:.62rem;" +
    "color:var(--dim);line-height:1.5;}" +
    ".ced-panel__build .ced-b{flex:none;color:var(--accent-bright);font:700 10px/1 Consolas,monospace;}" +
    /* The mark is the one thing on this row a person reads back, so it is
       larger than its own label and spaced enough to be counted as six
       characters rather than scanned as a word.

       UPPER CASE BY STYLE, not by value. The text stays as the hash made
       it, so anything that reads it sees what was computed. */
    ".ced-panel__mark{flex:none;font:700 13px/1 Consolas,monospace;" +
    "letter-spacing:.09em;text-transform:uppercase;color:var(--text-soft);}" +
    ".ced-panel__state{min-width:0;}" +
    /* behind is a fact to act on, so it is the one state that is colored */
    ".ced-panel__build.is-off{color:var(--c-orange);}" +
    ".ced-panel__build.is-off .ced-panel__mark{color:var(--c-orange);}" +
    ".ced-panel__foot{padding:.55rem .6rem;border-top:1px solid var(--line-soft);display:flex;flex-wrap:wrap;gap:.35rem;}" +
    ".ced-btn{padding:.34rem .66rem;border-radius:999px;border:1px solid var(--line);background:var(--bg-deep);" +
    "color:var(--text-soft);font:600 .7rem var(--font);cursor:pointer;transition:border-color .2s,color .2s;}" +
    ".ced-btn:hover{border-color:var(--accent);color:var(--text);}" +
    /* A control that cannot be pressed should not look like one that can,
       and must not light up under the pointer. The hover reset skips a
       filled control, whose ground would otherwise fight the reset. */
    ".ced-btn:disabled{opacity:.45;cursor:default;}" +
    ".ced-btn:disabled:not(.ced-btn--accent):hover{border-color:var(--line);" +
    "color:var(--text-soft);}" +
    ".ced-btn--accent{border-color:var(--accent);color:var(--accent-bright);}" +
    /* The panel's own buttons are filled. They are the four moves the
       editor offers, and outlined they read as labels on a dark panel.
       The scope is the foot, so View in the head stays plain: it reports
       which copy is on screen and is not a move. */
    ".ced-panel__foot .ced-btn{border-color:var(--accent);background:var(--accent);" +
    "color:var(--bg-deep);transition:background .2s,border-color .2s;}" +
    ".ced-panel__foot .ced-btn:hover{border-color:var(--accent-bright);" +
    "background:var(--accent-bright);color:var(--bg-deep);}" +
    /* SAVE IS YELLOW. The panel's banner says "unsaved change" in yellow, so
       the one button that settles it wears the same colour, and a reader
       finds it from the banner without reading the row. Every other move
       stays blue. Same specificity as the rule above and later, so it wins. */
    ".ced-panel__foot .ced-btn--save{border-color:var(--c-yellow);background:var(--c-yellow);" +
    "color:var(--bg-deep);}" +
    ".ced-panel__foot .ced-btn--save:hover{border-color:var(--c-yellow);background:var(--c-yellow);" +
    "color:var(--bg-deep);filter:brightness(1.08);box-shadow:0 0 0 3px rgba(242,193,78,.28);}" +
    ".ced-panel__foot .ced-btn--save:focus-visible{outline:2px solid var(--c-yellow);outline-offset:2px;}" +
    ".ced-panel__foot .ced-btn--save:disabled," +
    ".ced-panel__foot .ced-btn--save:disabled:hover{border-color:var(--c-yellow);" +
    "background:var(--c-yellow);filter:none;box-shadow:none;}" +
    /* the success box: the head's own side padding, so the text lines up
       under the title, and the files it wrote, one chip each */
    ".ced-saved__body{display:grid;gap:.55rem;padding:.8rem 1.1rem .9rem;}" +
    ".ced-saved__body p{margin:0;line-height:1.55;}" +
    ".ced-saved__files{display:flex;flex-wrap:wrap;gap:.3rem;margin:.1rem 0 .2rem;padding:0;list-style:none;}" +
    ".ced-saved__file{font:12px Consolas,'Courier New',monospace;padding:.18rem .5rem;" +
    "border:1px solid var(--line);border-radius:6px;color:var(--text);background:var(--bg-deep);}" +
    /* an original over the Git limit, written and not pushable */
    ".ced-saved__file--over{color:var(--c-yellow);border-color:var(--c-yellow);}" +
    ".ced-saved__over{color:var(--c-yellow);}" +
    ".ced-saved__tick{color:var(--c-yellow);}" +
    ".ced-saved__tick .ced-tick{width:14px;height:14px;vertical-align:-2px;}" +
    /* THE ONE MOVE OF A DIALOG, FILLED.
       The scope is the button row and not the class. The accent class also
       marks the primary control of a repeated image card in the composer,
       and filling each of those would give one surface a dozen filled
       controls competing with its Publish button. A dialog's one move
       lives in its button row, so that is what is filled. */
    ".ced-modal__btns .ced-btn--accent{border-color:var(--accent);background:var(--accent);" +
    "color:var(--bg-deep);transition:background .2s,border-color .2s;}" +
    ".ced-modal__btns .ced-btn--accent:hover{border-color:var(--accent-bright);" +
    "background:var(--accent-bright);color:var(--bg-deep);}" +
    /* HOW A BOX ARRIVES, AND HOW IT LEAVES.

       A stage inside the wizard travels by writing transform outright,
       because a stage is laid across the box and has no transform of its
       own. A BOX does: every one is centred by translate(-50%,-50%), and a
       dragged one carries translateX(-50%). A class that wrote transform
       would throw the box to a corner.

       So the travel is a variable that each box's own transform already
       includes. A centred box, a dragged box and a stage then all move the
       same distance, and none of them loses its place. */
    ".ced-box{transition:transform .26s var(--ease),opacity .26s var(--ease);}" +
    ".ced-box--next{--travel:28px;opacity:0;}" +
    ".ced-box--past{--travel:-28px;opacity:0;}" +
    /* a box on its way in or out must not answer a click on the way */
    ".ced-box--next,.ced-box--past{pointer-events:none;}" +
    /* A drag is direct manipulation, not an animation. Taking a box over
       swaps translate(-50%,-50%) for translateX(-50%) and writes an
       explicit top, and with a transition on transform that swap SLID:
       the box moved half its own height while the reader held the grip. */
    ".ced-box--still{transition:none;}" +
    "@media (prefers-reduced-motion:reduce){" +
    ".ced-box{transition:opacity .2s var(--ease);}" +
    ".ced-box--next,.ced-box--past{--travel:0px;}}" +
    /* THE GRIP.
       A bar across the foot of a box. A box is as tall as its rule says,
       and this is how a reader says the rule is wrong for what they are
       doing now.

       It lies inside the button row's own bottom padding, which is .9rem,
       so 13px covers no button. z-index puts it over a wizard stage, which
       is laid across the whole box.

       touch-action:none is required. Without it a phone scrolls the page
       instead of dragging the box. */
    ".ced-grip{position:absolute;left:0;right:0;bottom:0;height:13px;z-index:2;" +
    "cursor:ns-resize;display:grid;place-items:center;touch-action:none;}" +
    ".ced-grip::before{content:'';width:46px;height:3px;border-radius:2px;" +
    "background:var(--line);transition:background .2s;}" +
    ".ced-grip:hover::before{background:var(--accent);}" +
    ".ced-grip:focus-visible{outline:2px solid var(--accent);outline-offset:-3px;}" +
    ".ced-grip:focus-visible::before{background:var(--accent);}" +
    /* while a drag runs, a stray selection must not follow the pointer */
    "html.ced-gripping,html.ced-gripping *{user-select:none;}" +
    ".ced-scrim{position:fixed;inset:0;z-index:3200;background:rgba(4,6,10,.72);}" +
    /* the tutorial arrow: above every dialog, below the launcher */
    ".ced-point{position:fixed;z-index:3400;pointer-events:none;}" +
    ".ced-point svg{display:block;overflow:visible;}" +
    ".ced-point path{fill:none;stroke:var(--accent-bright,#6fbcf2);stroke-width:2.4;stroke-linecap:round;" +
    "stroke-linejoin:round;filter:drop-shadow(0 0 6px rgba(74,165,232,.55));}" +
    /* Three stages, one class. The head shows first, at the tip. The stroke
       then draws from the tip back to the tail: a negative dash offset
       running to zero reveals a path from its end, and the path is written
       tail first. Last, the label writes itself out under a clip that
       opens left to right, the way handwriting arrives. The delays put the
       stages end to end; the exit runs them in the other order. */
    ".ced-point__curve{stroke-dasharray:var(--pt-len);stroke-dashoffset:var(--pt-off);" +
    "transition:stroke-dashoffset .45s var(--ease,ease) .15s;}" +
    ".ced-point__head{opacity:0;transition:opacity .15s ease;}" +
    ".ced-point__label{position:absolute;white-space:nowrap;font:600 22px/1.2 Caveat,'Segoe Script'," +
    "'Bradley Hand',cursive;color:var(--accent-bright,#6fbcf2);text-shadow:0 0 10px rgba(74,165,232,.35);" +
    "clip-path:inset(-30% 100% -30% -6%);transition:clip-path .55s cubic-bezier(.4,0,.2,1) .58s;}" +
    /* the head is placed by its SVG transform attribute, which a CSS
       transform would override; nothing here sets transform on it */
    ".ced-point.is-on .ced-point__curve{stroke-dashoffset:0;}" +
    ".ced-point.is-on .ced-point__head{opacity:1;}" +
    ".ced-point.is-on .ced-point__label{clip-path:inset(-30% -6% -30% -6%);}" +
    ".ced-point.is-off .ced-point__label{transition-delay:0s;transition-duration:.3s;}" +
    ".ced-point.is-off .ced-point__curve{transition-delay:.2s;transition-duration:.3s;}" +
    ".ced-point.is-off .ced-point__head{transition-delay:.46s;}" +
    ".ced-point.is-still *{transition:none !important;}" +
    /* THE RATIO: 16:9 IN LANDSCAPE, FLOW IN PORTRAIT.

       Four dialogs held four sizes, so the same file ask was one shape
       inside the wizard and another shape in a box of its own. One rule
       replaces them. The width anchors the ratio, and the height follows.

       Measured: 1920x1080 and 1280x800 both give 960x540. 800x600 gives
       736x414, where 92vw binds before the 960 cap. 390x844 is portrait,
       drops the ratio, and flows at 359 wide.

       max-height stays, against the plan, and the measurement is the
       reason: it binds at none of those four viewports, and it is what
       holds a box on screen in a short landscape window, where 16:9 of
       960px is 540px and the window is not that tall. A box that cannot
       be seen cannot be closed, so the screen wins over the ratio there
       and nowhere else. */
    ".ced-modal{position:fixed;z-index:3300;left:50%;top:50%;" +
    "transform:translate(-50%,-50%) translateX(var(--travel,0px));" +
    "width:min(960px,92vw);aspect-ratio:16/9;max-height:90vh;display:flex;flex-direction:column;" +
    "background:var(--panel);border:1px solid var(--line);border-radius:14px;" +
    "box-shadow:0 40px 100px -40px rgba(0,0,0,1);}" +
    /* A box that flows takes the height its content needs. This is the
       per-box answer for a surface that 16:9 does not suit. No surface
       needs it today, and the gate proves it works, so the first one that
       needs it can say so in one word. */
    ".ced-modal--flow{aspect-ratio:auto;}" +
    /* Portrait drops the ratio everywhere. A phone is tall and narrow, and
       a held 16:9 there is a letterbox with the content pressed into it. */
    "@media (orientation:portrait){.ced-modal{aspect-ratio:auto;}}" +
    /* THE THREE BANDS.
       A rule under the head and a rule above the buttons. Between them
       every surface reads the same way: what this is, what it holds, and
       what you can do about it. The wizard had these two rules to itself,
       which is why the file ask reached from Publish and the same ask
       reached from Edit looked like two products.
       --line, at 8 percent, and not --line-soft: 5 percent on this panel
       lands about 11 levels above its ground and does not register. */
    ".ced-modal__head{padding:.8rem 3rem .6rem 1.1rem;display:flex;align-items:baseline;gap:.6rem;" +
    "border-bottom:1px solid var(--line);}" +
    ".ced-modal__head .ced-b{color:var(--accent-bright);font:700 12px/1 Consolas,monospace;}" +
    ".ced-modal__head .ced-slug{font-weight:800;color:var(--text);}" +
    ".ced-modal__x{position:absolute;top:.6rem;right:.7rem;width:30px;height:30px;padding:0;" +
    "display:grid;place-items:center;border:1px solid var(--line);border-radius:50%;" +
    "background:var(--bg-deep);color:var(--text-soft);cursor:pointer;" +
    "transition:border-color .2s,color .2s,background .2s;}" +
    ".ced-modal__x:hover{border-color:var(--accent);color:var(--text);background:var(--panel-2);}" +
    ".ced-modal__x svg{width:15px;height:15px;display:block;}" +
    ".ced-modal__tools{display:flex;flex-wrap:wrap;gap:.3rem;padding:0 1.1rem .55rem;}" +
    ".ced-tool{min-width:30px;padding:.28rem .5rem;border-radius:7px;border:1px solid var(--line);" +
    "background:var(--bg-deep);color:var(--text-soft);font:600 .72rem var(--font);cursor:pointer;}" +
    ".ced-tool:hover{border-color:var(--accent);color:var(--text);}" +
    /* Decision A, 2026-09-07: the box grip is the only way to make room
       here. The corner grip grew the text inside a box that was already
       too small, which moves the scrollbar rather than making room. The
       textarea takes whatever the box gives it. */
    ".ced-modal textarea{margin:0 1.1rem;flex:1 1 auto;min-height:240px;resize:none;" +
    "background:var(--bg-deep);color:var(--text);border:1px solid var(--line);border-radius:8px;" +
    "padding:.7rem .8rem;font:12.5px/1.55 Consolas,'Courier New',monospace;white-space:pre-wrap;}" +
    ".ced-modal textarea:focus-visible{outline:2px solid var(--accent);}" +
    /* THE READING COLUMN.
       The hand-off note measured 96 characters a line in a 720px box,
       well past the 60 to 75 that reads without effort. The cap is on the
       text and not on the body: a drop zone, a chip list, a field row and
       a textarea keep the full width of the frame.
       72ch is a no-op on the wizard today, whose widest line measured 66.
       It is declared here so the rule already holds when a box gets wider. */
    ".ced-modal{--ced-read:72ch;}" +
    ".ced-modal__status.is-warn{color:var(--c-yellow);}" +
    ".ced-modal__status{padding:.35rem 1.1rem 0;font-size:.7rem;color:var(--muted);min-height:1.2em;" +
    "max-width:var(--ced-read);}" +
    /* margin-top:auto pins the row to the foot of the box.
       Before the ratio a dialog was as tall as its content, so the buttons
       sat at the bottom by definition. A held box is taller than its
       content, and the row floated in the middle of the file ask with the
       rule above it drawn across nothing.
       The wizard and the region editor each have a flexible child that
       already takes the slack, so this changes neither of them. */
    ".ced-modal__btns{display:flex;flex-wrap:wrap;gap:.4rem;padding:.7rem 1.1rem .9rem;" +
    "border-top:1px solid var(--line);margin-top:auto;}" +
    ".ced-modal__btns .ced-spacer{flex:1 1 auto;}" +
    /* image / gallery editing */
    ".ced-chip--img{width:auto;min-width:26px;padding:0 8px;border-radius:999px;font-size:8.5px;}" +
    ".ced-chip--plus{font-size:14px;font-weight:800;}" +
    ".ced-chip--trash svg{width:13px;height:13px;display:block;}" +
    /* THE CAPTION PENCIL sits at the end of a carousel's caption label, which
       is always on screen in the caption strip. The label ignores the pointer
       so a tap falls through to the carousel, so the pencil asks for the
       pointer back. */
    ".gallery__caption .ced-cappen{flex:none;display:grid;place-items:center;width:22px;height:22px;" +
    "margin-left:.55rem;padding:0;border:1px solid rgba(111,188,242,.6);border-radius:50%;" +
    "background:rgba(6,9,14,.6);color:var(--accent-bright);cursor:pointer;pointer-events:auto;" +
    "transition:background .2s,border-color .2s,color .2s;}" +
    ".gallery__caption .ced-cappen:hover{background:var(--accent);border-color:var(--accent);" +
    "color:var(--bg-deep);}" +
    ".gallery__caption .ced-cappen:focus-visible{outline:2px solid var(--accent-bright);outline-offset:2px;}" +
    ".gallery__caption .ced-cappen svg{width:12px;height:12px;display:block;}" +
    ".gallery__caption .ced-cappen[hidden]{display:none;}" +
    /* While a caption is edited its label takes the pointer and widens across
       the strip, so a long caption has room to be read. The caption cell and
       its hidden copies step aside for the field. */
    ".gallery__caption.ced-capediting{pointer-events:auto;" +
    "width:min(34rem,calc(100% - 1rem));max-width:calc(100% - 1rem);}" +
    ".gallery__caption.ced-capediting .gallery__caption-cell{display:none;}" +
    ".gallery__caption .ced-capedit{flex:1 1 auto;min-width:0;padding:.28rem .5rem;" +
    "border:1px solid var(--accent);border-radius:6px;background:rgba(6,9,14,.78);" +
    "color:var(--text);font:600 .78rem var(--font);}" +
    /* the accent border already says where typing goes, so the focus is a
       soft ring and not a second outline around the first */
    ".gallery__caption .ced-capedit:focus{outline:none;box-shadow:0 0 0 3px rgba(74,165,232,.28);}" +
    /* red under the pointer only: at rest it is one of the carousel's chips,
       and orange already means "edited" */
    ".ced-chip--trash:hover{border-color:#e5534b;color:#e5534b;}" +
    ".ced-chip--seed{border-color:var(--dim);color:var(--muted);box-shadow:none;cursor:default;}" +
    ".ced-dropping{outline:3px dashed var(--accent);outline-offset:-3px;border-radius:10px;}" +
    ".ced-btn--danger{border-color:rgba(240,136,62,.5);color:var(--c-orange);}" +
    ".ced-btn--danger:hover{border-color:var(--c-orange);color:#fff;background:rgba(240,136,62,.15);}" +
    /* --region names the one box that is built once and reused. Every other
       box the editor opens is built again each time it is wanted. */
    ".ced-panel__row--img .ced-b{color:var(--c-yellow);}" +
    /* THE PILL.
       A copy chip is a small hollow blue circle and edits one field. A pill
       is solid yellow and opens a whole thing: a blog post, a gallery
       section. Filled against hollow and yellow against blue, so the two
       are told apart at a glance rather than by reading them.
       The blog's post pill wears this too, and site.css keeps only where
       that one sits. */
    ".ced-pill{display:inline-flex;align-items:center;gap:.35rem;padding:.3rem .7rem;" +
    "border-radius:999px;border:1px solid var(--c-yellow);background:var(--c-yellow);" +
    "color:var(--bg-deep);font:700 .74rem var(--font);cursor:pointer;" +
    "transition:filter .2s var(--ease-soft),box-shadow .2s var(--ease-soft);}" +
    ".ced-pill:hover{filter:brightness(1.08);box-shadow:0 0 0 3px rgba(242,193,78,.28);}" +
    ".ced-pill:focus-visible{outline:2px solid var(--c-yellow);outline-offset:2px;}" +
    /* a move that cannot be made must not look like one that can */
    ".ced-pill:disabled{opacity:.38;cursor:default;filter:none;box-shadow:none;}" +
    ".ced-pill svg{width:13px;height:13px;flex:none;}" +
    /* Up and Down are arrows only. The band they sit on has a title to fit. */
    ".ced-pill--icon{padding:.3rem .45rem;}" +
    ".ced-pills{display:inline-flex;align-items:center;gap:.3rem;flex:none;}" +
    /* The new-block control, after the list's own close marker: outside
       every item, and outside every region, so it can reach no file. */
    ".ced-listfoot{display:flex;justify-content:center;padding:1.1rem 0 .2rem;" +
    "border-top:1px dashed var(--line);margin-top:.4rem;}" +
    /* the block form: one field to a row */
    ".ced-listform{width:min(560px,92vw);}" +
    ".ced-listform__body{display:grid;gap:.6rem;padding:.8rem 1.1rem .2rem;}" +
    ".ced-field{display:grid;gap:.25rem;min-width:0;}" +
    ".ced-field__label{font-size:.62rem;font-weight:800;letter-spacing:.14em;" +
    "text-transform:uppercase;color:var(--dim);}" +
    ".ced-field input,.ced-field textarea{background:var(--bg-deep);color:var(--text);" +
    "border:1px solid var(--line);border-radius:8px;padding:.45rem .7rem;" +
    "font:12.5px/1.5 Consolas,'Courier New',monospace;}" +
    ".ced-field textarea{resize:vertical;white-space:pre-wrap;}" +
    ".ced-field input:focus-visible,.ced-field textarea:focus-visible{outline:2px solid var(--accent);}" +
    /* a row whose region does not parse says so, and takes the region as
       it stands rather than pretending to understand it */
    ".ced-field__why{font-size:.68rem;color:var(--c-orange);line-height:1.4;}" +
    /* a named row: the name is short and the value takes the rest */
    ".ced-pair{display:flex;gap:.4rem;min-width:0;}" +
    ".ced-pair__name{flex:none;width:5.5rem;}" +
    ".ced-pair input:last-child{flex:1;min-width:0;}" +
    /* THE PROJECT FORM.
       More fields than a box can show at once, so the views scroll and the
       head, the tabs and the buttons hold still. */
    ".ced-projform{width:min(880px,94vw);}" +
    ".ced-projform__body{flex:1 1 auto;min-height:0;overflow:auto;" +
    "padding:.8rem 1.1rem .2rem;}" +
    ".ced-pane{display:grid;gap:.6rem;}" +
    ".ced-pane[hidden]{display:none;}" +
    ".ced-tabs{display:flex;gap:.2rem;padding:.5rem 1.1rem 0;" +
    "border-bottom:1px solid var(--line-soft);flex:none;}" +
    ".ced-tab{padding:.4rem .7rem;border:0;background:none;cursor:pointer;" +
    "font:700 .72rem var(--font);color:var(--muted);border-bottom:2px solid transparent;}" +
    ".ced-tab.on{color:var(--text);border-bottom-color:var(--accent);}" +
    ".ced-tab:focus-visible{outline:2px solid var(--accent);outline-offset:-2px;}" +
    ".ced-empty{margin:.2rem 0;color:var(--text-soft);font-size:.86rem;line-height:1.6;}" +
    /* a carousel's photos in a view of the form: a strip to look at, and a
       compact zone and two buttons that open the photo boxes */
    ".ced-photoview{display:grid;gap:.5rem;}" +
    ".ced-strip{display:flex;flex-wrap:wrap;gap:.35rem;list-style:none;margin:0;padding:0;}" +
    ".ced-strip img{display:block;width:96px;aspect-ratio:16/9;object-fit:cover;" +
    "border-radius:6px;border:1px solid var(--line);background:var(--bg-deep);}" +
    ".ced-handoff__zone.ced-drop{margin:0;padding:.75rem 1rem;}" +
    ".ced-btnrow{display:flex;flex-wrap:wrap;gap:.4rem;}" +
    /* A button that belongs to a view rather than to the box's button row
       sits where it was put, at the size of the row's own buttons. */
    ".ced-btn--own{justify-self:start;}" +
    /* the bar over a body inside a view: no side padding of its own, since
       the view already has the box's */
    ".ced-tools--own{padding:0 0 .4rem;position:relative;}" +
    ".ced-field--md{position:relative;}" +
    ".ced-field--md textarea{min-height:11rem;}" +
    ".ced-empty--warn{color:var(--c-orange);}" +
    /* the head's tag is blue on every other box; a list's own form is
       yellow, for the same reason its pill is */
    ".ced-modal__head .ced-b--y{color:var(--c-yellow);}" +
    ".ced-modal__head .ced-b--o{color:var(--c-orange);}" +
    /* THE ASK. One question, a picture of what it is about, and two ways
       out. The move is filled orange when it deletes or discards. */
    ".ced-ask{width:min(560px,92vw);}" +
    ".ced-ask__body{display:flex;gap:.9rem;align-items:flex-start;padding:.9rem 1.1rem .8rem;}" +
    ".ced-ask__thumb{flex:none;width:140px;aspect-ratio:16/9;object-fit:cover;border-radius:8px;" +
    "border:1px solid var(--line);background:var(--bg-deep);}" +
    ".ced-ask__text{min-width:0;display:grid;gap:.4rem;align-content:start;}" +
    ".ced-ask__text p{margin:0;font-size:.9rem;line-height:1.5;max-width:var(--ced-read);}" +
    ".ced-ask__text code{font:12px Consolas,'Courier New',monospace;color:var(--accent-bright);" +
    "overflow-wrap:anywhere;}" +
    ".ced-modal__btns .ced-btn--fill-danger{border-color:var(--c-orange);background:var(--c-orange);" +
    "color:var(--bg-deep);transition:filter .2s;}" +
    ".ced-modal__btns .ced-btn--fill-danger:hover{filter:brightness(1.1);color:var(--bg-deep);}" +
    "@media (max-width:480px){.ced-ask__body{flex-direction:column;}.ced-ask__thumb{width:100%;}}" +
    /* ADD PHOTO. The steps sit under the head, and the body scrolls inside
       the held box, so the buttons stay in one place on every step. */
    ".ced-addphoto{width:min(880px,94vw);}" +
    ".ced-steps{display:flex;flex-wrap:wrap;gap:.35rem;margin:0;padding:.6rem 1.1rem 0;list-style:none;}" +
    ".ced-steps li{font:700 9.5px/1 Consolas,monospace;letter-spacing:.06em;text-transform:uppercase;" +
    "border-radius:4px;padding:4px 7px;border:1px solid var(--line);color:var(--dim);}" +
    ".ced-steps li.is-now{border-color:var(--accent);color:var(--accent-bright);}" +
    ".ced-steps li.is-done{border-color:rgba(74,165,232,.3);color:var(--muted);}" +
    ".ced-addphoto__body{flex:1 1 auto;min-height:0;overflow:auto;padding:.8rem 1.1rem .4rem;}" +
    ".ced-addphoto__pane{display:grid;gap:.7rem;}" +
    ".ced-addphoto__pane[hidden]{display:none;}" +
    ".ced-addphoto .ced-handoff__zone{margin:0;}" +
    /* the button that picks a file sits inside its drop zone, under the words */
    ".ced-choose{align-self:center;margin-top:.35rem;border-color:var(--accent);color:var(--accent-bright);}" +
    ".ced-keepmeta{display:flex;align-items:center;gap:.5rem;font-size:.75rem;" +
    "color:var(--text-soft);cursor:pointer;justify-self:start;}" +
    ".ced-keepmeta input{margin:0;accent-color:var(--accent);}" +
    ".ced-place{display:flex;gap:.4rem;overflow-x:auto;padding:.1rem .1rem .4rem;}" +
    ".ced-place__pic{flex:none;position:relative;width:112px;aspect-ratio:16/9;border-radius:6px;" +
    "border:1px solid var(--line);overflow:hidden;background:var(--bg-deep);}" +
    ".ced-place__pic img{display:block;width:100%;height:100%;object-fit:cover;}" +
    ".ced-place__pic.is-new{border:2px solid var(--c-yellow);}" +
    ".ced-place__pic.is-new::after{content:'NEW';position:absolute;left:4px;top:4px;" +
    "font:700 8.5px/1 Consolas,monospace;padding:2px 4px;border-radius:3px;" +
    "background:var(--c-yellow);color:var(--bg-deep);}" +
    ".ced-place__moves{display:flex;align-items:center;gap:.5rem;}" +
    ".ced-place__moves[hidden]{display:none;}" +
    ".ced-place__move{display:inline-flex;align-items:center;gap:.3rem;}" +
    ".ced-place__move svg{width:13px;height:13px;}" +
    ".ced-place__at{font-size:.74rem;color:var(--muted);min-width:6.5rem;text-align:center;}" +
    ".ced-hint{margin:0;font-size:.74rem;line-height:1.5;color:var(--muted);max-width:var(--ced-read);}" +
    ".ced-hint code{font:12px Consolas,'Courier New',monospace;color:var(--accent-bright);}" +
    /* PHOTOS. A row for each photo: its number, its picture, its words and
       its moves. The list scrolls, so the head and the buttons hold still. */
    ".ced-photos{width:min(880px,94vw);}" +
    ".ced-photos__body{flex:1 1 auto;min-height:0;overflow:auto;padding:.8rem 1.1rem .4rem;}" +
    ".ced-photos__list{list-style:none;margin:0;padding:0;display:grid;gap:.5rem;}" +
    /* THE FRAME GROUP: a carousel's shape, three buttons with one pressed */
    ".ced-frame{display:inline-flex;align-items:center;gap:.3rem;margin-left:.2rem;}" +
    ".ced-frame__label{font:600 .72rem var(--font);color:var(--dim);margin-right:.1rem;}" +
    ".ced-frame .ced-btn[aria-pressed=true]{border-color:var(--accent);color:var(--accent-bright);" +
    "background:rgba(74,165,232,.14);}" +
    ".ced-photo{display:grid;grid-template-columns:auto 132px minmax(0,1fr) auto;gap:.75rem;" +
    "align-items:start;padding:.6rem;border:1px solid var(--line);border-radius:10px;" +
    "background:var(--bg-deep);}" +
    ".ced-photo__n{font:700 11px/1 Consolas,monospace;color:var(--dim);padding-top:.4rem;}" +
    ".ced-photo__pic{display:block;width:132px;aspect-ratio:16/9;object-fit:cover;border-radius:6px;" +
    "border:1px solid var(--line);background:var(--panel);}" +
    ".ced-photo__fields{display:grid;gap:.4rem;min-width:0;}" +
    ".ced-photo__file{font:11px Consolas,'Courier New',monospace;color:var(--dim);" +
    "overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}" +
    ".ced-photo__tag{margin-left:.4rem;font:700 8.5px/1 Consolas,monospace;padding:2px 4px;" +
    "border-radius:3px;background:var(--c-yellow);color:var(--bg-deep);vertical-align:1px;}" +
    /* a row's facts, and its switch: the same line in both boxes */
    ".ced-photo__meta{display:flex;flex-wrap:wrap;align-items:center;gap:.3rem .9rem;min-width:0;}" +
    ".ced-photo__facts{font:11px Consolas,'Courier New',monospace;color:var(--dim);}" +
    ".ced-photo__warn{color:var(--c-yellow);}" +
    /* an alt text that is still the file's name is marked until it changes */
    ".ced-altmark{margin-left:.45rem;font:700 8.5px/1 Consolas,monospace;letter-spacing:.04em;" +
    "padding:2px 4px;border-radius:3px;background:var(--c-yellow);color:var(--bg-deep);" +
    "vertical-align:1px;text-transform:none;}" +
    ".ced-altmark[hidden]{display:none;}" +
    /* Display True Pixel Size and Display Maximum UHD, drawn as switches:
       each a checkbox with the switch role */
    ".ced-truesize,.ced-uhd{display:inline-flex;align-items:center;gap:.4rem;font-size:.72rem;" +
    "color:var(--text-soft);cursor:pointer;}" +
    ".ced-truesize input,.ced-uhd input{-webkit-appearance:none;appearance:none;margin:0;flex:none;" +
    "width:28px;height:16px;border-radius:999px;background:var(--line);position:relative;cursor:pointer;" +
    "transition:background .15s;}" +
    ".ced-truesize input::before,.ced-uhd input::before{content:'';position:absolute;top:2px;left:2px;" +
    "width:12px;height:12px;border-radius:50%;background:var(--text-soft);transition:transform .15s,background .15s;}" +
    ".ced-truesize input:checked,.ced-uhd input:checked{background:var(--accent);}" +
    ".ced-truesize input:checked::before,.ced-uhd input:checked::before{transform:translateX(12px);background:#fff;}" +
    ".ced-truesize input:focus-visible,.ced-uhd input:focus-visible{outline:2px solid var(--accent);outline-offset:2px;}" +
    /* UHD held on by True Pixel Size: still on, and not a control while it lasts */
    ".ced-uhd.is-locked{cursor:default;opacity:.62;}" +
    ".ced-uhd.is-locked input{cursor:default;}" +
    ".ced-uhd__what{font:11px Consolas,'Courier New',monospace;color:var(--dim);}" +
    /* the controls a kind adds of its own, under the facts */
    ".ced-photo__extras{display:flex;flex-wrap:wrap;align-items:center;gap:.35rem .9rem;" +
    "min-width:0;}" +
    ".ced-photo__extras .ced-field__label{margin:0;}" +
    ".ced-photo__acts{display:flex;justify-content:flex-end;gap:.3rem;}" +
    ".ced-photo__acts .ced-tool--icon svg{width:14px;height:14px;display:block;}" +
    ".ced-photo__acts .ced-tool:disabled{opacity:.35;cursor:default;}" +
    ".ced-photo__acts .ced-tool:disabled:hover{border-color:var(--line);color:var(--text-soft);}" +
    ".ced-tool--danger:hover{border-color:#e5534b;color:#e5534b;}" +
    "@media (max-width:640px){.ced-photo{grid-template-columns:96px minmax(0,1fr);}" +
    ".ced-photo__n{display:none;}.ced-photo__pic{width:96px;}" +
    ".ced-photo__acts{grid-column:1 / -1;justify-content:flex-start;flex-wrap:wrap;}}" +
    /* THE MARKDOWN TOOLBAR.
       The sprite is in the page and drawn from, never seen. A name is kept
       for a screen reader on every icon button, because a mark says nothing
       out loud; .ced-sr is site.css's, where the blog's search pill already
       uses it, and a second copy here would be a second answer. */
    ".ced-sprite{position:absolute;width:0;height:0;overflow:hidden;}" +
    ".ced-tool--icon{display:inline-flex;align-items:center;justify-content:center;" +
    "min-width:30px;padding:.28rem .42rem;}" +
    ".ced-tool__i{width:16px;height:16px;display:block;flex:none;}" +
    /* The (i) keeps its words: it is the one control on the row whose name
       a reader has to see, because nothing about a circle says what is
       behind it. */
    ".ced-spec__btn{display:inline-flex;align-items:center;gap:.35rem;}" +
    ".ced-spec__btn .ced-tool__i{width:14px;height:14px;}" +
    ".ced-spec__btn.on{border-color:var(--accent);color:var(--accent-bright);}" +
    /* The (i) sits after a divider at the end of the row, so it reads as a
       different kind of thing from the buttons that write text. */
    ".ced-tool__sep{width:1px;align-self:stretch;margin:.15rem .35rem;" +
    "background:var(--line);flex:none;}" +
    /* Above the surface it belongs to, not below it: the row sits at the
       top, so a panel under it would cover the words being written. top is
       set when it opens, from the row's own foot; this is where it starts
       before the first open. */
    /* The cap is the SCREEN'S, not the host's. The row this hangs from is a
       whole composer on one surface and one field of a form on another, and a
       cap in percent made the panel short exactly where the field was. */
    ".ced-spec{position:absolute;left:0;right:0;top:2.4rem;z-index:4;" +
    "background:var(--panel);border:1px solid var(--line);border-radius:10px;" +
    "box-shadow:0 24px 60px -24px rgba(0,0,0,.9);padding:.6rem .8rem;" +
    "max-height:min(70vh,40rem);overflow:auto;}" +
    ".ced-spec[hidden]{display:none;}" +
    ".ced-spec__head{font:700 .66rem var(--font);letter-spacing:.12em;" +
    "text-transform:uppercase;color:var(--dim);padding-bottom:.4rem;" +
    "border-bottom:1px solid var(--line-soft);margin-bottom:.5rem;}" +
    ".ced-spec__list{display:grid;grid-template-columns:max-content 1fr;" +
    "gap:.5rem .8rem;align-items:baseline;}" +
    ".ced-spec__write{flex:none;font:12px Consolas,'Courier New',monospace;" +
    "color:var(--accent-bright);white-space:nowrap;}" +
    ".ced-spec__of{min-width:0;display:flex;flex-direction:column;gap:.1rem;}" +
    ".ced-spec__where{font-size:.66rem;color:var(--dim);}" +
    ".ced-spec__does{font-size:.74rem;color:var(--text-soft);line-height:1.45;}" +
    ".ced-spec__foot{margin:.5rem 0 0;padding-top:.45rem;" +
    "border-top:1px solid var(--line-soft);font-size:.7rem;color:var(--dim);}" +
    /* a phone has no room for the code beside the words */
    "@media (max-width:560px){.ced-spec__list{grid-template-columns:1fr;gap:.1rem;}" +
    ".ced-spec__list .ced-spec__of{padding-bottom:.4rem;}}";

  /* Rules from a trunk that extends the editor. They go into the same
     <style>, after the editor's own, so a tie resolves the way source order
     says it should. A trunk may register after the style is already in the
     head, so the element is rewritten rather than left as it was. */
  var extraCSS = [];
  function addStyles(css) {
    extraCSS.push(css);
    if (styleEl) styleEl.textContent = CSS + extraCSS.join("");
  }
  function injectStyles() {
    if (styleEl) return;
    styleEl = doc.createElement("style");
    styleEl.textContent = CSS + extraCSS.join("");
    doc.head.appendChild(styleEl);
  }

  /* ---------------- one ground, counted ----------------

     Every box used to lay its own ground. They are all the same colour,
     rgba(4,6,10,.72), so two composed to about 0.92 and three to about
     0.98: a stack of boxes turned the page behind almost black, and the
     reader lost the site they were editing.

     One element serves them all. The count is what makes that safe. A box
     that closes while another is still open must not take the ground away
     from the box still there, and a count is the only way to know. */
  var scrimEl = null, scrimCount = 0;
  function scrimUp() {
    scrimCount++;
    if (scrimEl) return;
    injectStyles();
    scrimEl = doc.createElement("div");
    scrimEl.className = "ced-scrim";
    doc.body.appendChild(scrimEl);
  }
  function scrimDown() {
    if (!scrimCount) return;
    scrimCount--;
    if (scrimCount) return;
    if (scrimEl && scrimEl.parentNode) scrimEl.parentNode.removeChild(scrimEl);
    scrimEl = null;
  }

  /* The editor's own dialogs, innermost last.

     A stack, not a count, because Escape has to answer the one in FRONT.
     Each dialog listening on the document for itself does not work: two
     listeners on one node both fire for one key, and stopPropagation does
     not stop a sibling on the same node. So there is one listener here,
     and it asks the top of the stack.

     modalOpen reports the depth, so a consumer with its own Escape rule
     knows to yield the key to whatever is in front of it. */
  var dialogStack = [];
  function dialogUp(esc) {
    dialogStack.push(esc);
    if (dialogStack.length === 1) doc.addEventListener("keydown", dialogKeys);
  }
  function dialogDown(esc) {
    var at = dialogStack.lastIndexOf(esc);
    if (at !== -1) dialogStack.splice(at, 1);
    if (!dialogStack.length) doc.removeEventListener("keydown", dialogKeys);
  }
  function dialogKeys(e) {
    if (e.key !== "Escape" || !dialogStack.length) return;
    e.preventDefault();
    e.stopPropagation();
    dialogStack[dialogStack.length - 1]();
  }

  /* ---------------- the build mark ----------------
     ONE SHORT MARK FOR EVERY FILE THIS PAGE IS BUILT FROM.

     The site edits itself, so the editor you are running is a file the site
     served you, and a browser will happily keep an old one. GitHub Pages
     sends max-age=600 and every page loads its scripts by bare name, with
     no version query, so a deploy does not reach a tab that is already
     open. That is a silent fault: the editor looks right and behaves like
     last week.

     THE PAGE'S OWN STAMP CANNOT ANSWER THIS. A publish writes a stamp into
     every page, and comparing that would be wrong here: the HTML can be
     fresh while a script is cached, which is exactly the case that catches
     people, and a page-to-page comparison calls it current.

     NOTHING CAN BE STAMPED INTO THE SCRIPTS EITHER. They are hand-written
     source, a publish writes generated files only, and the project has no
     build step, so no hash can be put inside them.

     What is left is the server's own answer. Same origin, so the editor can
     read the ETag of the copy the browser holds and the copy the server
     holds, and never download either. The repo has no ETag, so that side is
     compared by content, which is a local read on both halves.

     Three marks, three faults, and they are different faults:
       browser against server   you must refresh
       repo against browser     you have commits you did not push
     A side that cannot be read says so. It never counts as agreement. */

  /* Every same-origin file this page is built from, derived from the page
     itself so there is no list to keep in sync. */
  function buildSet() {
    var out = [];
    Array.prototype.forEach.call(doc.querySelectorAll("script[src]"), function (s) {
      out.push(s.getAttribute("src"));
    });
    Array.prototype.forEach.call(doc.querySelectorAll('link[rel="stylesheet"]'), function (l) {
      out.push(l.getAttribute("href"));
    });
    out.push((location.pathname.replace(/^.*\//, "") || "index.html"));
    /* a font or a CDN is not ours to check, and a query would not compare */
    return out.filter(function (u) {
      return u && !/^https?:/.test(u) && !/^\/\//.test(u) && u.indexOf("?") === -1;
    });
  }
  /* FNV-1a, base 36, six characters. Short enough to read out, long enough
     that two different builds do not collide in a project this size. */
  function buildHash(text) {
    var h = 0x811c9dc5;
    for (var i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return ("00000" + h.toString(36)).slice(-6);
  }
  /* The identity of one file, as the server states it. "?" means the file
     could not be read, which is never the same as "it matches". */
  function buildTag(res) {
    if (!res || !res.ok) return "?";
    return res.headers.get("etag") || res.headers.get("last-modified") || "?";
  }
  function buildSide(how) {
    var files = buildSet();
    return Promise.all(files.map(function (u) {
      return fetch(u, how).then(buildTag, function () { return "?"; });
    })).then(function (tags) { return { files: files, tags: tags }; });
  }
  /* What this browser is running: the copy in its own cache, which is the
     copy it gave to the page. */
  function buildMine() { return buildSide({ cache: "force-cache" }); }
  /* What the server holds now. HEAD, so no body crosses the wire. */
  function buildTheirs() { return buildSide({ method: "HEAD", cache: "no-store" }); }
  /* What the repo folder holds. No ETag exists here, so this side is
     compared by content against the browser's own copy. Both reads are
     local, so nothing crosses the wire at all. */
  function buildRepo(files) {
    if (!repoDir) return Promise.resolve(null);
    return Promise.all(files.map(function (u) {
      return readFromRepo(u).then(function (text) {
        return text === null ? "?" : buildHash(text);
      }, function () { return "?"; });
    }));
  }
  function buildMineText(files) {
    return Promise.all(files.map(function (u) {
      return fetch(u, { cache: "force-cache" }).then(function (r) {
        return r.ok ? r.text().then(buildHash) : "?";
      }, function () { return "?"; });
    }));
  }
  /* Which files two sides disagree on. A "?" on either side is a disagreement
     that cannot be resolved, and is reported as unread rather than as equal. */
  function buildDiff(files, a, b) {
    var off = [], unread = [];
    files.forEach(function (u, i) {
      if (a[i] === "?" || b[i] === "?") unread.push(u);
      else if (a[i] !== b[i]) off.push(u);
    });
    return { off: off, unread: unread };
  }

  /* Read all three and say what they mean. Resolves an answer; it never
     rejects, because a check that throws tells a reader nothing. */
  function buildCheck() {
    var fromDisk = location.protocol === "file:";
    return buildMine().then(function (mine) {
      var files = mine.files;
      var mark = buildHash(mine.tags.join("|"));
      if (fromDisk) {
        return { mark: mark, files: files, server: "disk", repo: "unchecked",
                 say: "opened from disk, so the server cannot be asked" };
      }
      return buildTheirs().then(function (theirs) {
        var d = buildDiff(files, mine.tags, theirs.tags);
        return { mark: mark, files: files,
                 server: d.off.length ? "behind" : (d.unread.length ? "unread" : "same"),
                 behind: d.off, unread: d.unread };
      }).then(function (r) {
        if (!repoDir) { r.repo = "unchecked"; return r; }
        return buildMineText(files).then(function (mineText) {
          return buildRepo(files).then(function (repo) {
            var d2 = buildDiff(files, mineText, repo);
            r.repo = d2.off.length ? "differs" : (d2.unread.length ? "unread" : "same");
            r.repoOff = d2.off;
            return r;
          });
        });
      });
    });
  }

  /* Run the check and put the answer in the row. It is called once, when
     the panel is built, because that is a deliberate act and the answer is
     only interesting at the moment you sit down to edit. */
  function buildSay() {
    if (!buildRow) return;
    var mark = buildRow.querySelector(".ced-panel__mark");
    var state = buildRow.querySelector(".ced-panel__state");
    buildCheck().then(function (r) {
      if (!buildRow) return;
      mark.textContent = r.mark;
      var bad = r.server === "behind" || r.repo === "differs";
      var say;
      if (r.server === "disk") {
        say = "opened from disk, so nothing was checked";
      } else if (r.server === "behind") {
        say = r.behind.length + (r.behind.length === 1 ? " file is" : " files are") +
          " behind the server: " + r.behind.join(", ") + ". Press Ctrl+F5.";
      } else if (r.repo === "differs") {
        say = "current, but " + r.repoOff.length +
          (r.repoOff.length === 1 ? " file in your repo differs" : " files in your repo differ") +
          ": " + r.repoOff.join(", ") + ". Commit and push.";
      } else if (r.server === "unread" || r.repo === "unread") {
        say = "some files could not be read, so this is not a clean answer";
      } else if (r.repo === "unchecked") {
        say = "matches the server. The repo folder was not given, so it was not checked.";
      } else {
        say = "browser, server and repo agree";
      }
      state.textContent = say;
      buildRow.classList.toggle("is-off", bad);
      buildRow.title = r.files.join("\n");
    }, function () {
      if (!buildRow) return;
      mark.textContent = "??????";
      state.textContent = "the check could not run";
    });
  }

  /* ---------------- the grip ----------------
     Every box is centred by a transform, so adding height grows it equally
     up and down. To grow downward, the box's current top is written as an
     explicit top and the transform drops to translateX only. A box stops
     being centred once it is dragged, which is correct: the reader put it
     where it is.

     Nothing is remembered. Four of the five boxes are built again at every
     open, and the fifth is reset at its own, so a box always comes back on
     its rule. There is no stored height and nothing to migrate. */
  var GRIP_MIN = 180;    /* under this the head and the buttons stop fitting */
  var GRIP_STEP = 24;    /* one press of an arrow key */
  var GRIP_EDGE = 8;     /* the box never sits against the foot of the screen */
  var gripBoxes = [];    /* every box carrying a grip, for the resize clamp */

  /* Take the box off its rule and onto an explicit height, anchored at the
     top it has now. Safe to call again: it takes over once. */
  function gripTake(box) {
    if (box.style.height) return parseFloat(box.style.height);
    var r = box.getBoundingClientRect();
    /* off for the length of this change, and on again straight after, so
       the box arrives at its new anchor in one frame and every later move
       of --travel still travels */
    box.classList.add("ced-box--still");
    box.style.top = Math.round(r.top) + "px";
    box.style.transform = "translateX(-50%) translateX(var(--travel,0px))";
    /* the ratio and the viewport cap each decide a height, and from here
       the reader does. gripTo is what keeps the box on the screen. */
    box.style.maxHeight = "none";
    box.style.height = Math.round(r.height) + "px";
    /* reading a layout value is what makes the change take now rather than
       at the next frame, which is what the class has to outlast */
    void box.offsetHeight;
    box.classList.remove("ced-box--still");
    return Math.round(r.height);
  }
  /* Ask for a height and get the one that fits. The floor keeps the head
     and the buttons. The ceiling is the screen, because a box taller than
     the screen cannot be closed with its own buttons. */
  function gripTo(box, want) {
    var top = parseFloat(box.style.top);
    if (isNaN(top)) top = box.getBoundingClientRect().top;
    var room = window.innerHeight - top - GRIP_EDGE;
    var h = Math.max(GRIP_MIN, Math.min(want, room));
    box.style.height = Math.round(h) + "px";
    return Math.round(h);
  }
  /* Give the box back to its rule. */
  function gripReset(box) {
    box.style.top = "";
    box.style.height = "";
    box.style.transform = "";
    box.style.maxHeight = "";
  }
  /* A window that gets shorter must not leave a dragged box off the screen:
     a box that cannot be reached cannot be closed. */
  function gripClampAll() {
    gripBoxes = gripBoxes.filter(function (b) { return b.parentNode; });
    gripBoxes.forEach(function (box) {
      if (!box.style.height) return;
      var top = parseFloat(box.style.top) || 0;
      var highest = window.innerHeight - GRIP_MIN - GRIP_EDGE;
      if (top > highest) box.style.top = Math.round(Math.max(GRIP_EDGE, highest)) + "px";
      gripTo(box, parseFloat(box.style.height));
    });
  }
  window.addEventListener("resize", gripClampAll);

  /* Put a grip on a box. It is appended last, so it lies over the button
     row's lower edge, and nothing is appended after it. */
  function gripAdd(box) {
    var grip = doc.createElement("div");
    grip.className = "ced-grip";
    grip.tabIndex = 0;
    grip.setAttribute("role", "separator");
    grip.setAttribute("aria-orientation", "horizontal");
    grip.setAttribute("aria-label", "Make this box taller or shorter");
    grip.title = "Drag, or use the arrow keys. Home puts the box back.";

    var from = 0, at = 0, dragging = false;
    grip.addEventListener("pointerdown", function (e) {
      /* preventDefault stops the drag from starting a text selection */
      e.preventDefault();
      from = e.clientY;
      at = gripTake(box);
      dragging = true;
      doc.documentElement.classList.add("ced-gripping");
      /* capture, so the drag survives the pointer leaving the box */
      try { grip.setPointerCapture(e.pointerId); } catch (err) {}
    });
    grip.addEventListener("pointermove", function (e) {
      if (!dragging) return;
      gripTo(box, at + (e.clientY - from));
    });
    function done(e) {
      if (!dragging) return;
      dragging = false;
      doc.documentElement.classList.remove("ced-gripping");
      try { grip.releasePointerCapture(e.pointerId); } catch (err) {}
    }
    grip.addEventListener("pointerup", done);
    grip.addEventListener("pointercancel", done);

    /* A grip that answers only a pointer is unreachable for anyone who
       does not use one. */
    grip.addEventListener("keydown", function (e) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        gripTo(box, gripTake(box) + (e.key === "ArrowDown" ? GRIP_STEP : -GRIP_STEP));
      } else if (e.key === "Home") {
        e.preventDefault();
        gripReset(box);
      }
    });

    box.appendChild(grip);
    gripBoxes.push(box);
    return grip;
  }

  /* The shell that holds this file's dialogs, when one is on screen.
     Registered through AMH.tool.stageHost. */
  var hostFn = null;

  /* ---------------- badges + panel ---------------- */
  /* THE CHIP FLOOR.

     The site header is fixed, so a chip whose region scrolls to the top of
     the window would sit behind it and be neither readable nor clickable.
     Each chip stops just under the header instead, and stays there while
     its region is still on screen. When the region leaves, the chip goes
     with it rather than hanging under a bar pointing at nothing.

     positionChips writes document coordinates, which do not change as the
     page scrolls. This does, so it runs on scroll as well. */
  var CHIP_H = 26;          /* the chip's own height, from its rule above */
  var CHIP_GAP = 8;         /* clear of the header, not touching it */

  function chipFloor() {
    var head = doc.querySelector(".site-header");
    var below = head ? head.getBoundingClientRect().bottom : 0;
    return (window.scrollY || window.pageYOffset) + Math.max(below, 0) + CHIP_GAP;
  }
  function floorChips() {
    if (!overlay) return;
    var floor = chipFloor();
    regions.forEach(function (r) {
      if (!r.chip || r.chipTop === undefined || r.chip.style.display === "none") return;
      /* never below the region's own foot: a chip that outran its region
         would point at the wrong thing */
      var lowest = r.chipBottom - CHIP_H;
      r.chip.style.top = Math.max(r.chipTop, Math.min(floor, lowest)) + "px";
    });
  }
  var floorPending = false;
  function requestFloor() {
    if (floorPending) return;
    floorPending = true;
    window.requestAnimationFrame(function () { floorPending = false; floorChips(); });
  }

  function positionChips() {
    if (!overlay) return;
    var sx = window.scrollX || window.pageXOffset;
    var sy = window.scrollY || window.pageYOffset;
    /* read every rect first, then write every style: one reflow, not eighty */
    var rects = regions.map(function (r) {
      if (!r.chip) return null;
      r.visible = r.el.getClientRects().length > 0;
      return r.visible ? r.el.getBoundingClientRect() : null;
    });
    regions.forEach(function (r, i) {
      if (!r.chip) return;
      if (!rects[i]) { r.chip.style.display = "none"; return; }
      r.chip.style.display = "";
      r.chip.style.left = (rects[i].left + sx) + "px";
      /* the region's own top and bottom, in document space, kept for the
         floor: it clamps between them and needs both */
      r.chipTop = rects[i].top + sy;
      r.chipBottom = rects[i].bottom + sy;
      r.chip.style.top = r.chipTop + "px";
    });
    floorChips();
    /* gallery chips: IMG## + (+) pinned to each built carousel's top-left */
    var gRects = gals.map(function (g) {
      if (viewing === "before") return null;   /* image chips only make sense on the after view */
      var holder = liveHolder(g);
      /* getClientRects: a display:none holder (e.g. blog takeover hides the
         portfolio) reports a truthy all-zeros bounding rect - skip it */
      return (holder && g.live.classList.contains("is-ready") && holder.getClientRects().length)
        ? holder.getBoundingClientRect() : null;
    });
    gals.forEach(function (g, i) {
      if (!g.chip) return;
      var trash = g.trashChip;
      if (!gRects[i]) {
        g.chip.style.display = "none"; g.plusChip.style.display = "none";
        if (trash) trash.style.display = "none";
        return;
      }
      g.chip.style.display = ""; g.plusChip.style.display = "";
      g.chip.style.left = (gRects[i].left + sx + 16) + "px";
      g.chip.style.top = (gRects[i].top + sy) + "px";
      g.plusChip.style.left = (gRects[i].left + sx + 58) + "px";
      g.plusChip.style.top = (gRects[i].top + sy) + "px";
      if (trash) {
        trash.style.left = (gRects[i].left + sx + 92) + "px";
        trash.style.top = (gRects[i].top + sy) + "px";
        trash.style.display = trashable(g) ? "" : "none";
      }
    });
  }
  var repoTimer = 0;
  function requestReposition() {
    if (repoTimer) return;
    repoTimer = window.setTimeout(function () { repoTimer = 0; positionChips(); }, 120);
  }

  function pendingLabel(c) {
    c = c || pendingCount();
    return c.changes + (c.changes === 1 ? " unsaved change" : " unsaved changes") +
      " on " + c.pages + (c.pages === 1 ? " page" : " pages");
  }

  /* The count is only useful while the editor is open, and only when it is not
     zero: a chip that always reads "0" is furniture. */
  function refreshPendingChip() {
    if (!pendingChip) return;
    var c = pendingCount();
    pendingChip.textContent = pendingLabel(c);
    pendingChip.hidden = c.changes === 0;
  }

  /* Read the record and say where it stands. Four of its boxes are the
     person's; the fifth, live, is the page's and clears the record. */
  function refreshPublishLine() {
    if (!publishLine) return;
    var rec = null;
    try {
      var raw = window.sessionStorage.getItem(PUBLISH_KEY);
      rec = raw ? JSON.parse(raw) : null;
    } catch (err) {}
    publishLine.hidden = !rec;
    if (!rec) return;
    var done = ["extract", "review", "commit", "push"].filter(function (k) {
      return rec.checks && rec.checks[k];
    }).length;
    var what = rec.kind === "rebuild" ? "The rebuild"
      : "p" + rec.id + (rec.kind === "delete" ? " deletion" : "");
    publishLine.textContent = what +
      " is in a bundle that is not live yet. " + done + " of 4 steps ticked." +
      (AMH.publish ? " Checklist." : " Open blog.html for the checklist.");
  }
  AMH.tool.publishLine = refreshPublishLine;

  function refreshDirtyUI() {
    regions.forEach(function (r) {
      if (r.chip) r.chip.classList.toggle("ced-edited", r.edited);
      if (r.row) r.row.classList.toggle("ced-edited", r.edited);
    });
    if (viewBtn) viewBtn.textContent = viewing === "after" ? "View: after" : "View: BEFORE";
    refreshPendingChip();
  }

  /* The close mark, for the panel head and the region modal. One drawing,
     so the two closes on screen cannot end up different shapes. It takes
     currentColor and costs no request. */
  var CED_X = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" aria-hidden="true">' +
    '<line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg>';
  var CED_TICK = '<svg class="ced-tick" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="m5 13 5 5L20 7" /></svg>';
  /* The trash can, for the carousel's chip and a photo's row. One drawing,
     so a delete looks the same wherever it is offered. */
  var CED_TRASH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M3 6h18" /><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" />' +
    '<path d="m19 6-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />' +
    '<path d="M10 11v6" /><path d="M14 11v6" /></svg>';

  /* WHAT THE REBUILD BUTTON SAYS.

     A rebuild opens the wizard, and the wizard covers the button that
     started it. When the box closes the reader is back at a panel that
     looks exactly as it did before they pressed anything, so the button
     itself has to carry the outcome for a moment.

     "Rebuilding..." from the press, then a tick and "Done!" for three
     seconds, then the name back. The name comes back because the button
     is a control and not a status line: a tick that stayed would be read
     as the state of the site rather than the result of one press.

     publish.js announces the finish on the document, because it does not
     know the panel. A failure never announces, and the timeout is what
     puts the name back, so a build that dies cannot leave "Rebuilding..."
     on screen for the rest of the page load. */
  var REBUILD_SAY_MS = 3000;
  var REBUILD_GIVEUP_MS = 120000;
  var rebuildBtn = null;

  var SAVE_LABEL = "Save to repo";
  var SAVE_SAY_MS = 3000;      /* long enough to read a result */
  var SAVE_GIVEUP_MS = 60000;  /* the folder picker stays open for as long as it does */

  /* The button carries the outcome for a moment, because the folder picker
     covers the panel while the save runs and a reader who comes back to a
     button that looks untouched has no idea whether it worked.

     A count and not a list: the console holds the file names, and the button
     is 250px of panel. */
  /* One timer for the button, not one for each press. A timer made inside
     the press could not be cleared by the next one, and the first press's
     three seconds would then put the name back over the second's result. */
  var saveTimer = 0;

  /* THE SAVE, CONFIRMED IN A BOX.

     A folder write is invisible: nothing downloads, nothing opens, and the
     picker that covered the panel has gone. A box is the one place a reader
     cannot miss, so a success says itself there, with every file it wrote.

     It is a success box only. Nothing to save and a fallback to the download
     are answered on the button, because neither left a file in the repo and
     neither needs the reader to stop.

     The frame is the frame every other box wears: the head, the rule under
     it, running text, the rule over the buttons, and one filled move. */
  function savedBox(written, folder, moved) {
    injectStyles();
    var box = doc.createElement("div");
    box.className = "ced-modal ced-modal--flow ced-saved";
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-modal", "true");
    box.setAttribute("aria-labelledby", "cedSavedTitle");

    var headEl = doc.createElement("div");
    headEl.className = "ced-modal__head";
    headEl.innerHTML = '<span class="ced-b ced-b--y ced-saved__tick">' + CED_TICK + "SAVED</span>" +
      '<span class="ced-slug" id="cedSavedTitle">Written into your repo folder</span>';

    var xBtn = doc.createElement("button");
    xBtn.type = "button";
    xBtn.className = "ced-modal__x";
    xBtn.setAttribute("aria-label", "Close");
    xBtn.title = "Close";
    xBtn.innerHTML = CED_X;

    var body = doc.createElement("div");
    body.className = "ced-saved__body";
    var lead = doc.createElement("p");
    lead.className = "ced-saved__lead";
    lead.textContent = (written.length === 1 ? "1 file was" : written.length + " files were") +
      " written into " + (folder ? folder : "the repo folder") + ":";
    function fileList(paths, cls) {
      var ul = doc.createElement("ul");
      ul.className = "ced-saved__files" + (cls ? " " + cls : "");
      paths.forEach(function (path) {
        var li = doc.createElement("li");
        li.className = "ced-saved__file";
        li.textContent = path;
        ul.appendChild(li);
      });
      return ul;
    }
    var list = fileList(written);
    /* An original over the Git limit is written all the same. Its line is
       yellow, and a sentence says what is left to do. */
    var over = written.filter(function (path) {
      var photo = AMH.images ? AMH.images.photo(AMH.images.baseOf(path)) : null;
      return !!(photo && photo.overLimit && photo.files.original === path);
    });
    Array.prototype.forEach.call(list.children, function (li) {
      if (over.indexOf(li.textContent) !== -1) li.classList.add("ced-saved__file--over");
    });
    var next = doc.createElement("p");
    next.className = "ced-saved__next";
    /* A hard refresh shows the files only where the page is served from the
       repo. On the deployed site it shows the old page until the push lands,
       so the sentence says which case it is for. */
    next.innerHTML = "<strong>Written is not live.</strong> Commit and push these files " +
      "to publish them. If this page is served from the repo, press " +
      "<strong>Ctrl+F5</strong> to see them.";
    body.appendChild(lead);
    body.appendChild(list);
    if (over.length) {
      var big = doc.createElement("p");
      big.className = "ced-saved__over";
      big.textContent = (over.length === 1 ? "The yellow original is" : "The yellow originals are") +
        " over the " + engine().GIT_FILE_LIMIT_MB + " MB GitHub takes in one file, so a push " +
        "refuses " + (over.length === 1 ? "it" : "them") + ". Upload " +
        (over.length === 1 ? "that file" : "those files") + " by hand.";
      body.appendChild(big);
    }
    /* The files nothing names any more are gone from where they were, and
       the commit shows them deleted, so the box says where they went. */
    if (moved && moved.length) {
      var gone = doc.createElement("p");
      gone.className = "ced-saved__moved";
      gone.textContent = (moved.length === 1 ? "1 file nothing uses any more was" :
        moved.length + " files nothing uses any more were") + " moved into " +
        engine().DELETE_DIR + ":";
      body.appendChild(gone);
      body.appendChild(fileList(moved, "ced-saved__files--moved"));
    }
    body.appendChild(next);

    var btns = doc.createElement("div");
    btns.className = "ced-modal__btns";
    var sp = doc.createElement("span");
    sp.className = "ced-spacer";
    btns.appendChild(sp);
    var ok = doc.createElement("button");
    ok.type = "button";
    ok.className = "ced-btn ced-btn--accent";
    ok.textContent = "OK! Done!";
    btns.appendChild(ok);

    var shut = false;
    function done() {
      if (shut) return;
      shut = true;
      dialogDown(done);
      scrimDown();
      if (box.parentNode) box.parentNode.removeChild(box);
    }
    ok.addEventListener("click", done);
    xBtn.addEventListener("click", done);

    box.appendChild(headEl);
    box.appendChild(xBtn);
    box.appendChild(body);
    box.appendChild(btns);
    scrimUp();
    doc.body.appendChild(box);
    dialogUp(done);
    ok.focus();
    return box;
  }

  /* ONE QUESTION, IN A BOX OF ITS OWN.

     window.confirm is the browser's box. It cannot show a photo, and a
     delete has to show the reader what they are about to lose, so the
     photo boxes ask here instead.

     o.tag and o.title name the question. o.thumb is a picture to show,
     o.code a path under it, and o.lines the sentences, one paragraph
     each. o.yes names the move and o.no the way out, "Cancel" when none
     is given. o.danger paints the move orange and puts the focus on the
     way out, so a reader who presses Enter without reading keeps the
     photo.

     Resolves true for the move and false for the X, Escape and the way
     out. It never rejects. */
  var askSeq = 0;
  function askBox(o) {
    return new Promise(function (resolve) {
      injectStyles();
      var id = "cedAsk" + (++askSeq);
      var box = doc.createElement("div");
      box.className = "ced-modal ced-modal--flow ced-ask";
      box.setAttribute("role", "alertdialog");
      box.setAttribute("aria-modal", "true");
      box.setAttribute("aria-labelledby", id);

      var headEl = doc.createElement("div");
      headEl.className = "ced-modal__head";
      var tag = doc.createElement("span");
      tag.className = "ced-b" + (o.danger ? " ced-b--o" : "");
      tag.textContent = o.tag || "CHECK";
      var title = doc.createElement("span");
      title.className = "ced-slug";
      title.id = id;
      title.textContent = o.title || "";
      headEl.appendChild(tag);
      headEl.appendChild(title);

      var xBtn = doc.createElement("button");
      xBtn.type = "button";
      xBtn.className = "ced-modal__x";
      xBtn.setAttribute("aria-label", "Close");
      xBtn.title = "Close";
      xBtn.innerHTML = CED_X;

      var body = doc.createElement("div");
      body.className = "ced-ask__body";
      if (o.thumb) {
        var pic = doc.createElement("img");
        pic.className = "ced-ask__thumb";
        pic.alt = "";
        pic.src = o.thumb;
        body.appendChild(pic);
      }
      var text = doc.createElement("div");
      text.className = "ced-ask__text";
      if (o.code) {
        var path = doc.createElement("code");
        path.textContent = o.code;
        text.appendChild(path);
      }
      (o.lines || []).forEach(function (line) {
        if (!line) return;
        var p = doc.createElement("p");
        p.textContent = line;
        text.appendChild(p);
      });
      body.appendChild(text);

      var btns = doc.createElement("div");
      btns.className = "ced-modal__btns";
      var sp = doc.createElement("span");
      sp.className = "ced-spacer";
      btns.appendChild(sp);
      var no = doc.createElement("button");
      no.type = "button";
      no.className = "ced-btn";
      no.textContent = o.no || "Cancel";
      btns.appendChild(no);
      var yes = doc.createElement("button");
      yes.type = "button";
      yes.className = "ced-btn " + (o.danger ? "ced-btn--fill-danger" : "ced-btn--accent");
      yes.textContent = o.yes || "OK";
      btns.appendChild(yes);

      var shut = false;
      function done(answer) {
        if (shut) return;
        shut = true;
        dialogDown(escNo);
        scrimDown();
        if (box.parentNode) box.parentNode.removeChild(box);
        resolve(answer);
      }
      function escNo() { done(false); }
      no.addEventListener("click", escNo);
      xBtn.addEventListener("click", escNo);
      yes.addEventListener("click", function () { done(true); });

      box.appendChild(headEl);
      box.appendChild(xBtn);
      box.appendChild(body);
      box.appendChild(btns);
      scrimUp();
      doc.body.appendChild(box);
      dialogUp(escNo);
      (o.danger ? no : yes).focus();
    });
  }

  function runSave(btn) {
    function say(html, ms) {
      window.clearTimeout(saveTimer);
      btn.innerHTML = html;
      saveTimer = window.setTimeout(function () { btn.textContent = SAVE_LABEL; }, ms);
    }
    say("Saving...", SAVE_GIVEUP_MS);
    saveToFolder().then(function (out) {
      if (out.fellBack) {
        say("Downloaded", SAVE_SAY_MS);
        console.warn("[site editor] " + out.fellBack);
        return;
      }
      /* the box says it now, so the button goes back to being a button */
      window.clearTimeout(saveTimer);
      btn.textContent = SAVE_LABEL;
      savedBox(out.wrote, out.folder, out.moved);
    }, function (err) {
      say("Nothing to save", SAVE_SAY_MS);
      console.warn("[site editor] " + (err && err.message ? err.message : String(err)));
    });
  }

  function armRebuildSay(btn) {
    var timer = 0;
    function say(html, ms) {
      window.clearTimeout(timer);
      btn.innerHTML = html;
      timer = window.setTimeout(function () { btn.textContent = "Rebuild"; }, ms);
    }
    btn.addEventListener("click", function () { say("Rebuilding...", REBUILD_GIVEUP_MS); });
    doc.addEventListener("ced:published", function (e) {
      if (!btn.parentNode) return;
      if (!e.detail || e.detail.kind !== "rebuild") return;
      say(CED_TICK + "Done!", REBUILD_SAY_MS);
    });
  }

  function buildUI() {
    overlay = doc.createElement("div");
    overlay.setAttribute("aria-hidden", "true");
    overlay.style.cssText = "position:absolute;left:0;top:0;width:0;height:0;";

    panel = doc.createElement("div");
    panel.className = "ced-panel";
    var head = doc.createElement("div");
    head.className = "ced-panel__head";
    head.innerHTML = "<span>Site editor</span>";
    viewBtn = doc.createElement("button");
    viewBtn.type = "button";
    viewBtn.className = "ced-btn ced-panel__view";
    viewBtn.addEventListener("click", function () {
      (viewing === "after" ? api.before : api.after)();
    });
    head.appendChild(viewBtn);
    /* The close, where a window's close is. It is the same move as Exit at
       the foot: the foot is where a reader who has worked down the panel
       ends, and this is where a reader who wants out looks first. */
    var shut = doc.createElement("button");
    shut.type = "button";
    shut.className = "ced-panel__x";
    shut.setAttribute("aria-label", "Close the site editor");
    shut.title = "Close the site editor";
    shut.innerHTML = CED_X;
    shut.addEventListener("click", function () { api(); });
    head.appendChild(shut);
    panel.appendChild(head);

    /* THE BUILD ROW. Its own line, directly under the head, because it
       describes the whole panel below it rather than any one thing in it.
       Quiet when the three marks agree, and marked when they do not. */
    buildRow = doc.createElement("div");
    buildRow.className = "ced-panel__build";
    buildRow.innerHTML = '<span class="ced-b">BUILD</span>' +
      '<span class="ced-panel__mark">......</span>' +
      '<span class="ced-panel__state">checking...</span>';
    panel.appendChild(buildRow);
    buildSay();

    pendingChip = doc.createElement("button");
    pendingChip.type = "button";
    pendingChip.className = "ced-pending";
    pendingChip.hidden = true;
    pendingChip.title = "Click to list them. Shift-click to discard them all.";
    pendingChip.addEventListener("click", function (e) {
      if (e.shiftKey) api.pending.clear();
      else api.pending();
    });
    panel.appendChild(pendingChip);

    publishLine = doc.createElement("button");
    publishLine.type = "button";
    publishLine.className = "ced-pending ced-publish";
    publishLine.hidden = true;
    publishLine.title = "The last bundle you built. Click for the list of what to do with it.";
    publishLine.addEventListener("click", function () {
      if (AMH.publish && AMH.publish.checklist) AMH.publish.checklist();
      else console.info("[site editor] the checklist opens on blog.html.");
    });
    panel.appendChild(publishLine);
    refreshPublishLine();

    panelList = doc.createElement("div");
    panelList.className = "ced-panel__list";
    regRowsEl = doc.createElement("div");
    panelList.appendChild(regRowsEl);
    refreshRegionRows();
    imgRowsEl = doc.createElement("div");
    panelList.appendChild(imgRowsEl);
    refreshImageRows();
    /* published blog posts: click to edit */
    var man = AMH.blog ? AMH.blog.parseManifest() : { entries: [] };
    man.entries.slice().reverse().forEach(function (e) {
      var row = doc.createElement("button");
      row.type = "button";
      row.className = "ced-panel__row ced-panel__row--img";
      row.innerHTML = '<span class="ced-b">p' + e.id + "</span><span>" +
        e.title.replace(/&/g, "&amp;").replace(/</g, "&lt;") +
        '</span> <span class="ced-hidden">(blog)</span><span class="ced-dot"></span>';
      row.addEventListener("click", function () { api.blog.edit(e.id); });
      panelList.appendChild(row);
    });
    panel.appendChild(panelList);

    var foot = doc.createElement("div");
    foot.className = "ced-panel__foot";
    function footBtn(label, cls, fn) {
      var b = doc.createElement("button");
      b.type = "button"; b.className = "ced-btn" + (cls ? " " + cls : "");
      b.textContent = label;
      b.addEventListener("click", fn);
      foot.appendChild(b);
      return b;
    }
    footBtn("Export", "ced-btn--accent", function () { api.export(); });
    /* THE SITE'S SAVE, BESIDE THE SITE'S EXPORT.

       Export hands over a download that the person then has to find and
       copy. This writes the same bytes into the repo folder. It is on every
       page, because every page can be edited and every page is a file.

       The blog's Rebuild below is a different job and keeps its own button:
       it renders what the manifest generates. Updating the site and updating
       the blog are two things a person does, and they stay two buttons. */
    /* A class and not a label, because the label is what changes: the button
       reads "Saving..." and then what happened, and anything looking for it
       by its words would lose it for those seconds. */
    var saveBtn = footBtn(SAVE_LABEL, "ced-btn--save", function () { runSave(saveBtn); });
    if (!hasPicker()) {
      /* On screen and dead, with the reason on it. A hidden option teaches
         nobody what the tool can do. Export is the way out, and it is the
         button beside this one. */
      saveBtn.disabled = true;
      saveBtn.title = "This browser has no folder picker. Use Export instead.";
    }
    /* Rebuild renders every month file again with the current chrome. It
       runs the same wizard a publish runs, so the route pick, the bundle
       and the checklist are shared and not copied.

       It is offered only where the publish engine is loaded. On the other
       pages the button could only answer "the composer lives on
       blog.html", which is not an answer worth a button. */
    if (AMH.publish && AMH.publish.rebuild) {
      rebuildBtn = footBtn("Rebuild", "", function () { api.blog.rebuild(); });
      armRebuildSay(rebuildBtn);
    }
    footBtn("New post", "", function () { api.blog(); });
    footBtn("Revert all", "", function () { api.revertAll(); });
    footBtn("Exit", "", function () { api(); });
    panel.appendChild(foot);

    regions.forEach(chipFor);
    gals.forEach(galChipsFor);

    if (!drawerHooked) {
      drawerHooked = true;
      /* adopt the deep-dive drawer's cloned gallery whenever a drawer opens */
      doc.addEventListener("click", function (e) {
        if (!active) return;
        var more = e.target && e.target.closest ? e.target.closest(".project__more") : null;
        if (more) window.setTimeout(hookOpenDrawer, 120);
      });
      /* the drawer body scrolls internally; chips must follow */
      doc.addEventListener("scroll", function (e) {
        if (!active) return;
        if (e.target && e.target.classList && e.target.classList.contains("dd__body")) {
          requestReposition();
        }
      }, true);
    }
    hookOpenDrawer();   /* in case the drawer is already open right now */

    doc.body.appendChild(overlay);
    doc.body.appendChild(panel);
    positionChips();
    refreshDirtyUI();
    window.addEventListener("resize", requestReposition);
    window.addEventListener("scroll", requestFloor, { passive: true });
    /* AMH.tool.viewChanged()
       blog.js calls this when its takeover view opens or closes. The badge
       chips are positioned over the portfolio, which that view hides and
       re-shows, so they have to be placed again. */
    AMH.tool.viewChanged = requestReposition;
    redrawSelfDrawn();
  }

  /* One region's badge. Drawn when the editor opens, and again for a region
     that arrives after that: a block added to a list brings regions with it,
     and they earn their badges the same way. Idempotent, so the pass that
     draws them all may run as often as it likes. */
  function chipFor(r) {
    if (!overlay || r.chip || !r.visible) return;
    var chip = doc.createElement("button");
    chip.type = "button";
    chip.className = "ced-chip";
    chip.textContent = r.badge;
    chip.title = r.slug;
    chip.addEventListener("click", function (e) { e.stopPropagation(); openModal(r); });
    r.chip = chip;
    overlay.appendChild(chip);
  }

  /* An image region's chips. On a carousel: IMG##, which opens the PHOTOS
     box on the photo on screen; (+), which opens ADD PHOTO; and the trash
     can, which deletes the photo on screen.

     A region that draws itself gets none of them. These are placed over the
     one photo on screen, and a surface that shows every photo at once puts
     its own controls on each of them. */
  function galChipsFor(g) {
    if (!overlay || g.chip || g.kind.render) return;
    var chip = doc.createElement("button");
    chip.type = "button";
    chip.className = "ced-chip ced-chip--img";
    chip.textContent = "IMG";
    chip.addEventListener("click", function (e) {
      e.stopPropagation();
      var i = activeIndex(g), en = displayedEntries(g)[i];
      photosBox(g, realEntry(en) ? g.model.indexOf(en) : -1);
    });
    g.chip = chip;
    overlay.appendChild(chip);
    var plus = doc.createElement("button");
    plus.type = "button";
    plus.className = "ced-chip ced-chip--plus";
    plus.textContent = "+";
    plus.title = "Add a photo to this " + describeRegion(g).noun;
    plus.addEventListener("click", function (e) {
      e.stopPropagation();
      addPhotoBox(g);
    });
    g.plusChip = plus;
    overlay.appendChild(plus);
    var trash = doc.createElement("button");
    trash.type = "button";
    trash.className = "ced-chip ced-chip--trash";
    trash.innerHTML = CED_TRASH;
    trash.title = "Delete the photo on screen";
    trash.setAttribute("aria-label", "Delete the photo on screen");
    trash.addEventListener("click", function (e) { e.stopPropagation(); trashOnScreen(g); });
    g.trashChip = trash;
    overlay.appendChild(trash);
    attachGalleryRuntime(g);
  }

  /* A region that draws itself keeps its scaffolding inside its own markup:
     the chips, the controls, the drop targets. The carousels get theirs from
     buildUI(), which draws over the live element, so nothing has to be
     rebuilt for them. A self-drawing region redraws instead - on the way in
     to add the scaffolding, and on the way out to take it away. */
  function redrawSelfDrawn() {
    gals.forEach(function (g) { if (g.kind.render) renderGallery(g); });
    Object.keys(lists).forEach(function (n) {
      listFoot(lists[n]);
      listItemPills(lists[n]);
    });
  }

  /* ------------------------------------------------------------
     PHOTOS, IN BOXES

     A carousel is edited through two boxes, three chips and a pencil.

       (+)     opens ADD PHOTO, a wizard in three steps: choose the photos,
               describe them, place them. Nothing reaches the carousel
               until Add, so the X, Cancel and Escape change nothing.
       IMG##   opens PHOTOS, every photo of the carousel in one list. Its
               changes wait in the box until Apply.
       trash   deletes the photo on screen, once the reader says so.
       pencil  on the caption label, edits that caption where it is. See
               A CAPTION, EDITED WHERE IT IS.

     Both boxes draw a photo as the same row: its picture, its caption and
     alt text, a line of facts, and the Display Maximum UHD switch.

     Files dropped on a carousel open ADD PHOTO on those files, and so do
     files dropped on a gallery section. There is one way in.
     ------------------------------------------------------------ */

  /* An entry that is a photo, and not a slot or a seed. */
  function realEntry(en) { return !!en && !en.empty && !en.isSeed; }

  /* The trash chip shows only over a photo it could delete. */
  function trashable(g) { return realEntry(displayedEntries(g)[activeIndex(g)]); }

  /* The name a reader knows a carousel by: its project's title, with
     "deep dive" after it for the drawer's own carousel. */
  function carouselName(g) {
    var m = /^(.+?)-(dd-)?gallery$/.exec(g.slug || "");
    var r = m ? regionBySlug(m[1] + "-title") : null;
    var name = r ? parseHtml(r.current).textContent.replace(/\s+/g, " ").trim() : "";
    if (!name) return g.slug;
    return m[2] ? name + " deep dive" : name;
  }

  /* What the boxes call a region: the name they head themselves with, and
     the word their sentences use for it. A kind that is not a carousel says
     so with describe(); the two carousel kinds take this default. */
  function describeRegion(g) {
    var said = g.kind.describe ? g.kind.describe(g) : null;
    return { name: (said && said.name) || carouselName(g),
             noun: (said && said.noun) || "carousel" };
  }

  /* One labelled line of text, with its hint as the placeholder. */
  function photoField(host, label, hint) {
    var row = doc.createElement("label");
    row.className = "ced-field";
    var lab = doc.createElement("span");
    lab.className = "ced-field__label";
    lab.textContent = label;
    var inp = doc.createElement("input");
    inp.type = "text";
    if (hint) inp.placeholder = hint;
    row.appendChild(lab);
    row.appendChild(inp);
    host.appendChild(row);
    return inp;
  }

  /* A small button that shows an icon and gives a screen reader its name. */
  function iconTool(label, icon, fn, cls) {
    var b = doc.createElement("button");
    b.type = "button";
    b.className = "ced-tool ced-tool--icon" + (cls ? " " + cls : "");
    b.innerHTML = icon;
    b.setAttribute("aria-label", label);
    b.title = label;
    b.addEventListener("click", fn);
    return b;
  }

  /* The button inside a drop zone. A click on the zone does the same job,
     so a click on the button stops at the button: one press, one picker.
     The zone is not a button itself, so the keyboard reaches this one. */
  function zoneButton(zone, fn) {
    var b = doc.createElement("button");
    b.type = "button";
    /* its own class, not the accent one: the accent class names a box's
       one move, and this is a way to start, not the move */
    b.className = "ced-btn ced-choose";
    b.textContent = "Choose a photo";
    b.addEventListener("click", function (e) { e.stopPropagation(); fn(); });
    zone.appendChild(b);
    return b;
  }

  /* "3.1 MB", the way the viewer says it too */
  function sizeText(bytes) { return AMH.work.sizeText(bytes); }

  function extOfPath(path) {
    var m = /\.([a-z0-9]+)$/i.exec(String(path || ""));
    return m ? m[1].toLowerCase() : "";
  }

  /* Alt text that is still a camera's file name says nothing about the
     photo: all digits and separators, or a camera's own prefix. */
  function altIsFileName(alt) {
    var t = String(alt || "").trim();
    return /^[\d\s._-]+$/.test(t) || /^(?:img|dsc|dscn|pxl|mvimg)(?:[\s_-]*\d|$)/i.test(t);
  }

  /* What a row says about a photo, as pieces it joins with dots:
     "1920 x 960", "PNG original", "3.1 MB", what the cut did, and a
     warning when the original is over the Git limit. photo is a photo the
     engine made; without one the entry's own fields answer, and what the
     cut did is not known. */
  function photoFacts(photo, en) {
    var from = photo || en || {};
    var type = photo ? photo.type : extOfPath(en && en.original);
    var out = [];
    if (from.w && from.h) out.push({ text: from.w + " x " + from.h });
    if (type === "gif" && photo && photo.animated) out.push({ text: "GIF" }, { text: "animated" });
    else if (type) out.push({ text: type.toUpperCase() + " original" });
    if (from.bytes) out.push({ text: sizeText(from.bytes) });
    if (photo) {
      var meta = photo.meta || {};
      var found = meta.location || meta.camera || meta.date;
      out.push({ text: !found ? "no location or camera data"
        : "location and camera data " + (meta.kept ? "kept" : "removed") });
      if (photo.overLimit) out.push({ text: "over the Git limit", warn: true });
    }
    return out;
  }

  /* What Display Maximum UHD would show: "PNG · 2400 x 1200". */
  function uhdWhat(photo, en) {
    var type = photo ? photo.type : extOfPath(en && en.original);
    var ow = photo ? photo.ow : (en && en.ow), oh = photo ? photo.oh : (en && en.oh);
    return (type ? type.toUpperCase() : "") + (ow && oh ? " · " + ow + " x " + oh : "");
  }

  /* One switch on a photo's row: a checkbox with the switch role, and its
     words. onChange is told each new value. Returns { label, input }. */
  function photoSwitch(cls, words, on, onChange) {
    var label = doc.createElement("label");
    label.className = cls;
    var input = doc.createElement("input");
    input.type = "checkbox";
    input.setAttribute("role", "switch");
    input.checked = !!on;
    input.addEventListener("change", function () { onChange(input.checked); });
    var text = doc.createElement("span");
    text.textContent = words;
    label.appendChild(input);
    label.appendChild(text);
    return { label: label, input: input };
  }

  /* One photo's row, the shape both boxes draw: a number, the picture, the
     caption and the alt text, a line of facts with the two switches, and
     the row's moves.

       o.n, o.pic             the row's number and picture
       o.caption, o.alt       the words it opens with
       o.autoAlt              the alt given from the file's name; while the
                              alt is still that name, the field is marked
       o.file                 an element for the line above the facts
       o.facts                pieces from photoFacts
       o.truesize             { on } for Display True Pixel Size, or null
       o.uhd                  { on, what } for Display Maximum UHD, or null
       o.extras               a kind's own controls, under the facts
       o.acts                 the buttons, in order
       o.onCaption, o.onAlt   told each new value
       o.onTruesize, o.onUhd  told each switch's new value
       o.onEnter              Enter in the caption or the alt

     While True Pixel Size is on, UHD shows on and is locked, and a UHD
     that was off is turned on and told. Turning True Pixel Size off leaves
     UHD on and free to change.

     Returns { li, cap, alt }. */
  function photoRow(o) {
    var li = doc.createElement("li");
    li.className = "ced-photo";
    var n = doc.createElement("span");
    n.className = "ced-photo__n";
    n.textContent = (o.n < 10 ? "0" : "") + o.n;
    var pic = doc.createElement("img");
    pic.className = "ced-photo__pic";
    pic.alt = "";
    pic.src = o.pic;
    var fields = doc.createElement("div");
    fields.className = "ced-photo__fields";
    var cap = photoField(fields, "Caption", "Shown under the photo in the viewer");
    cap.value = o.caption || "";
    var alt = photoField(fields, "Alt text", "What the photo shows");
    alt.value = o.alt || "";
    var mark = doc.createElement("span");
    mark.className = "ced-altmark";
    mark.textContent = "file name";
    mark.title = "This alt text is the file's name. Say what the photo shows.";
    alt.parentNode.querySelector(".ced-field__label").appendChild(mark);
    function markAlt() {
      mark.hidden = !(alt.value === o.autoAlt && altIsFileName(alt.value));
    }
    markAlt();
    cap.addEventListener("input", function () { if (o.onCaption) o.onCaption(cap.value); });
    alt.addEventListener("input", function () {
      markAlt();
      if (o.onAlt) o.onAlt(alt.value);
    });
    [cap, alt].forEach(function (inp) {
      inp.addEventListener("keydown", function (e) {
        if (e.key !== "Enter" || !o.onEnter) return;
        e.preventDefault();
        o.onEnter();
      });
    });
    if (o.file) fields.appendChild(o.file);
    var meta = doc.createElement("div");
    meta.className = "ced-photo__meta";
    var facts = doc.createElement("span");
    facts.className = "ced-photo__facts";
    (o.facts || []).forEach(function (part, k) {
      if (k) facts.appendChild(doc.createTextNode(" · "));
      var s = doc.createElement("span");
      if (part.warn) s.className = "ced-photo__warn";
      s.textContent = part.text;
      facts.appendChild(s);
    });
    meta.appendChild(facts);
    /* True Pixel Size first, because it decides the switch after it */
    var size = o.truesize ? photoSwitch("ced-truesize", "Display True Pixel Size", o.truesize.on,
      function (on) {
        if (o.onTruesize) o.onTruesize(on);
        lockUhd();
      }) : null;
    if (size) meta.appendChild(size.label);
    var uhd = o.uhd ? photoSwitch("ced-uhd", "Display Maximum UHD", o.uhd.on,
      function (on) { if (o.onUhd) o.onUhd(on); }) : null;
    if (uhd) {
      if (o.uhd.what) {
        var what = doc.createElement("span");
        what.className = "ced-uhd__what";
        what.textContent = o.uhd.what;
        uhd.label.appendChild(what);
      }
      meta.appendChild(uhd.label);
    }
    function lockUhd() {
      if (!uhd) return;
      var locked = !!(size && size.input.checked);
      if (locked && !uhd.input.checked) {
        uhd.input.checked = true;
        if (o.onUhd) o.onUhd(true);
      }
      uhd.input.disabled = locked;
      uhd.label.classList.toggle("is-locked", locked);
      uhd.label.title = locked ? "On while Display True Pixel Size is on" : "";
    }
    lockUhd();
    fields.appendChild(meta);
    if (o.extras) fields.appendChild(o.extras);
    var acts = doc.createElement("div");
    acts.className = "ced-photo__acts";
    (o.acts || []).forEach(function (b) { acts.appendChild(b); });
    li.appendChild(n);
    li.appendChild(pic);
    li.appendChild(fields);
    li.appendChild(acts);
    return { li: li, cap: cap, alt: alt };
  }

  /* Delete one photo of a region, once the reader says so. `at` is its place
     in the model, which is how a surface that shows every photo at once names
     the one it means; the trash chip passes the photo on screen.

     Nothing is removed before the answer, so a No leaves the region as it
     was. Returns a promise of whether the photo went. */
  function photoTrash(g, at) {
    var en = g.model[at];
    if (!realEntry(en)) return Promise.resolve(false);
    var last = g.model.filter(realEntry).length === 1;
    return askBox({
      tag: "DELETE", title: "Delete this photo?", danger: true,
      thumb: en.preview || en.src, code: en.src,
      lines: [en.caption ? "Caption: " + en.caption : "",
              last ? g.kind.lastImageNote(g).trim() : ""],
      yes: "Delete photo"
    }).then(function (yes) {
      /* the model may have moved while the question stood, so the photo is
         found again rather than removed by the index the reader clicked */
      var now = yes ? g.model.indexOf(en) : -1;
      if (now === -1) return false;
      imageRegion.remove(g, now);
      exportedClean = false;
      renderGallery(g, null, Math.min(now, g.model.length - 1));
      pendingSyncGallery(g);
      refreshDirtyUI();
      photoPrune();
      return true;
    });
  }

  /* The trash chip's delete: the photo on screen is the one it means. */
  function trashOnScreen(g) {
    var en = displayedEntries(g)[activeIndex(g)];
    if (realEntry(en)) photoTrash(g, g.model.indexOf(en));
  }

  /* Where ADD PHOTO puts its photos when no box is waiting for them: the
     region itself. A PHOTOS box hands the wizard its own list instead, and
     both answer the same four things. */
  function liveTarget(g) {
    return {
      name: describeRegion(g).name,
      list: function () { return g.model.filter(realEntry); },
      seeds: function () { return !g.model.some(realEntry) && g.seeds.length > 0; },
      putAll: function (entries, at) {
        if (viewing === "before") api.after();
        /* an unfilled slot was only somewhere to drop, so it goes, and the
           seeds step aside for a real photo on their own */
        var list = g.model.filter(realEntry);
        Array.prototype.splice.apply(list, [at, 0].concat(entries));
        g.model = list;
        entries.forEach(function (en) { engine().hold(en.photo); });
        exportedClean = false;
        renderGallery(g, null, at);
        pendingSyncGallery(g);
        refreshDirtyUI();
      }
    };
  }

  /* The metadata choice for this page load. The wizard's checkbox sets it,
     and Replace in PHOTOS takes a file the same way. It is off unless the
     author turns it on, because the site is public. */
  var keepMetaChoice = false;

  /* ADD PHOTO, the wizard.

     One photo or a batch, in three steps. Every photo is prepared while
     the box is open and let go when the box closes without Add, so a
     closed box leaves the page as it was.

     opts.files   files a drop already chose; the box opens on them
     opts.choose  open the file picker with the box
     opts.target  where the photos go: liveTarget(g) when not given
     opts.done    told true when photos were added, and false when not

     A kind that holds one image says single. The box then takes one file,
     and a second file replaces the first. */
  function addPhotoBox(g, opts) {
    opts = opts || {};
    if (viewing === "before") api.after();
    injectStyles();
    guardDocumentDrops();
    var target = opts.target || liveTarget(g);
    var noun = describeRegion(g).noun;
    var single = !!g.kind.single;
    /* { photo, caption, alt, autoAlt, uhd, capIn, altIn }, in the batch's order */
    var rows = [];
    var at = 0;                /* where the run goes among target.list() */
    var step = 0;
    var busy = false;

    var box = doc.createElement("div");
    box.className = "ced-modal ced-addphoto";
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-modal", "true");
    box.setAttribute("aria-label", "Add photos to " + target.name);

    var headEl = doc.createElement("div");
    headEl.className = "ced-modal__head";
    var tag = doc.createElement("span");
    tag.className = "ced-b ced-b--y";
    tag.textContent = "ADD PHOTO";
    var who = doc.createElement("span");
    who.className = "ced-slug";
    who.textContent = target.name;
    headEl.appendChild(tag);
    headEl.appendChild(who);

    var xBtn = doc.createElement("button");
    xBtn.type = "button";
    xBtn.className = "ced-modal__x";
    xBtn.setAttribute("aria-label", "Close");
    xBtn.title = "Close";
    xBtn.innerHTML = CED_X;

    /* the steps by name, so the reader can see how far there is to go */
    var steps = doc.createElement("ol");
    steps.className = "ced-steps";
    ["Choose", "Describe", "Place"].forEach(function (word, i) {
      var li = doc.createElement("li");
      li.textContent = (i + 1) + " " + word;
      steps.appendChild(li);
    });

    var body = doc.createElement("div");
    body.className = "ced-addphoto__body";
    function pane() {
      var p = doc.createElement("div");
      p.className = "ced-addphoto__pane";
      body.appendChild(p);
      return p;
    }

    /* ---- 1. choose ---- */
    var choosePane = pane();
    var zone = doc.createElement("div");
    zone.className = "ced-handoff__zone";
    zone.innerHTML = "<strong>" + (single ? "Drop a photo here" : "Drop photos here") + "</strong>" +
      "<span>JPG, PNG, WebP or GIF. Each is saved as a JPG 1920px on its long edge, " +
      "with a small copy and the original beside it.</span>";
    var input = doc.createElement("input");
    input.type = "file";
    input.accept = engine().ACCEPT;
    input.multiple = !single;
    input.hidden = true;
    var choose = zoneButton(zone, function () { input.click(); });
    zone.addEventListener("click", function () { input.click(); });
    /* read when a file is taken, so it is set before the files are */
    var keep = doc.createElement("label");
    keep.className = "ced-keepmeta";
    var keepIn = doc.createElement("input");
    keepIn.type = "checkbox";
    keepIn.checked = keepMetaChoice;
    keepIn.addEventListener("change", function () { keepMetaChoice = keepIn.checked; });
    keep.appendChild(keepIn);
    keep.appendChild(doc.createTextNode("Keep location and camera data in the originals"));
    choosePane.appendChild(zone);
    choosePane.appendChild(keep);
    choosePane.appendChild(input);
    input.addEventListener("change", function () {
      var files = Array.prototype.slice.call(input.files || []);
      input.value = "";
      if (files.length) take(files);
    });

    /* ---- 2. describe ---- */
    var describePane = pane();
    var describe = doc.createElement("div");
    describe.className = "ced-describe";
    var rowList = doc.createElement("ol");
    rowList.className = "ced-photos__list";
    describe.appendChild(rowList);
    describePane.appendChild(describe);

    /* The fields hold what was typed, so they are read before a redraw and
       before the photos are put in. */
    function syncRows() {
      rows.forEach(function (r) {
        if (!r.capIn) return;
        r.caption = r.capIn.value;
        r.alt = r.altIn.value;
      });
    }

    function drawRows(focusRow, focusAct) {
      syncRows();
      rowList.innerHTML = "";
      rows.forEach(function (r, i) {
        var up = iconTool("Move earlier", ICON.up, function () { moveRow(r, -1, 0); });
        up.disabled = i === 0;
        var down = iconTool("Move later", ICON.down, function () { moveRow(r, 1, 1); });
        down.disabled = i === rows.length - 1;
        var out = iconTool("Take this photo out", CED_TRASH, function () { dropRow(r); },
          "ced-tool--danger");
        var row = photoRow({
          n: i + 1, pic: r.photo.urls.sd, caption: r.caption, alt: r.alt, autoAlt: r.autoAlt,
          facts: photoFacts(r.photo), truesize: { on: r.truesize },
          uhd: { on: r.uhd, what: uhdWhat(r.photo) },
          acts: [up, down, out],
          onTruesize: function (on) { r.truesize = on; },
          onUhd: function (on) { r.uhd = on; },
          /* Enter moves on to the next photo's caption, and past the last
             photo it moves on to the next step */
          onEnter: function () {
            var after = rows[rows.indexOf(r) + 1];
            if (after) after.capIn.focus();
            else next.click();
          }
        });
        r.capIn = row.cap;
        r.altIn = row.alt;
        rowList.appendChild(row.li);
      });
      var li = typeof focusRow === "number" ? rowList.children[focusRow] : null;
      if (!li) return;
      li.scrollIntoView({ block: "nearest" });
      /* the focus follows a moved photo, so a run of presses keeps moving it */
      var b = typeof focusAct === "number" ? li.querySelectorAll(".ced-photo__acts .ced-tool")[focusAct] : null;
      if (b && !b.disabled) b.focus();
      else li.querySelector("input").focus();
    }

    function moveRow(r, by, which) {
      var i = rows.indexOf(r), to = i + by;
      if (i < 0 || to < 0 || to >= rows.length) return;
      syncRows();
      rows.splice(i, 1);
      rows.splice(to, 0, r);
      drawRows(to, which);
    }

    function dropRow(r) {
      var i = rows.indexOf(r);
      if (i < 0) return;
      syncRows();
      rows.splice(i, 1);
      engine().letGo(r.photo);
      if (!rows.length) { show(0); return; }
      drawRows(Math.min(i, rows.length - 1));
    }

    /* ---- 3. place ---- */
    var placePane = pane();
    var askWhere = doc.createElement("p");
    askWhere.className = "ced-empty";
    var strip = doc.createElement("div");
    strip.className = "ced-place";
    var moves = doc.createElement("div");
    moves.className = "ced-place__moves";
    function moveBtn(label, icon, by) {
      var b = doc.createElement("button");
      b.type = "button";
      b.className = "ced-btn ced-place__move";
      b.innerHTML = icon;
      b.appendChild(doc.createTextNode(label));
      b.addEventListener("click", function () { at += by; drawPlace(); });
      return b;
    }
    var earlier = moveBtn("Earlier", ICON.left, -1);
    var where = doc.createElement("span");
    where.className = "ced-place__at";
    var later = moveBtn("Later", ICON.right, 1);
    moves.appendChild(earlier);
    moves.appendChild(where);
    moves.appendChild(later);
    var fileNote = doc.createElement("p");
    fileNote.className = "ced-hint";
    placePane.appendChild(askWhere);
    placePane.appendChild(strip);
    placePane.appendChild(moves);
    placePane.appendChild(fileNote);

    function placePic(src, isNew) {
      var cell = doc.createElement("span");
      cell.className = "ced-place__pic" + (isNew ? " is-new" : "");
      var im = doc.createElement("img");
      im.alt = "";
      im.src = src;
      cell.appendChild(im);
      return cell;
    }
    /* the batch is one run, marked NEW, and moves as one */
    function drawPlace() {
      var list = target.list();
      var many = rows.length > 1;
      at = Math.max(0, Math.min(at, list.length));
      strip.innerHTML = "";
      var firstNew = null;
      for (var i = 0; i <= list.length; i++) {
        if (i === at) {
          rows.forEach(function (r) {
            var cell = placePic(r.photo.urls.sd, true);
            if (!firstNew) firstNew = cell;
            strip.appendChild(cell);
          });
        }
        if (i < list.length) strip.appendChild(placePic(list[i].preview || list[i].src, false));
      }
      if (list.length) {
        askWhere.textContent = (many ? "Where do they go in the " : "Where does it go in the ") +
          noun + "?";
      } else {
        askWhere.textContent = (many ? "These are the first photos in this "
          : "This is the first photo in this ") + noun +
          (target.seeds() ? ", so the placeholder photos go away." : ".");
      }
      moves.hidden = !list.length;
      earlier.disabled = at <= 0;
      later.disabled = at >= list.length;
      var total = list.length + rows.length;
      where.textContent = many ? "Photos " + (at + 1) + " to " + (at + rows.length) + " of " + total
        : "Photo " + (at + 1) + " of " + total;
      fileNote.innerHTML = many
        ? "Save to repo writes each photo's three files into <code>" +
          escText(rows[0].photo.files.hd.replace(/[^\/]*$/, "")) + "</code>."
        : "Save to repo writes it to <code>" + escText(rows[0].photo.files.hd) +
          "</code>, with its small copy and its original.";
      /* a long carousel scrolls, and the new photos stay in view */
      strip.scrollLeft = Math.max(0, firstNew.offsetLeft - (strip.clientWidth - firstNew.offsetWidth) / 2);
    }

    var note = doc.createElement("div");
    note.className = "ced-modal__status";
    /* warn paints the line yellow, for photos taken with a problem */
    function say(t, warn) {
      note.textContent = t || "";
      note.classList.toggle("is-warn", !!warn);
    }

    var btns = doc.createElement("div");
    btns.className = "ced-modal__btns";
    function btn(label, cls, fn) {
      var b = doc.createElement("button");
      b.type = "button";
      b.className = "ced-btn" + (cls ? " " + cls : "");
      b.textContent = label;
      b.addEventListener("click", fn);
      btns.appendChild(b);
      return b;
    }
    var back = btn("Back", "", function () { if (step > 0) show(step - 1); });
    var sp = doc.createElement("span");
    sp.className = "ced-spacer";
    btns.appendChild(sp);
    btn("Cancel", "", function () { done(false); });
    var next = btn("Next", "ced-btn--accent", function () {
      if (busy || !rows.length) return;
      if (step < 2) show(step + 1);
      else add();
    });

    function show(n) {
      syncRows();
      step = n;
      [choosePane, describePane, placePane].forEach(function (p, i) { p.hidden = i !== n; });
      Array.prototype.forEach.call(steps.children, function (li, i) {
        li.classList.toggle("is-now", i === n);
        li.classList.toggle("is-done", i < n);
        if (i === n) li.setAttribute("aria-current", "step");
        else li.removeAttribute("aria-current");
      });
      back.hidden = n === 0;
      next.textContent = n === 2 ? (rows.length > 1 ? "Add photos" : "Add photo") : "Next";
      next.disabled = busy || !rows.length;
      if (n === 0) choose.focus();
      if (n === 1) drawRows(0);
      if (n === 2) {
        drawPlace();
        next.focus();
      }
    }

    /* Every file, one at a time in the order it came, so the batch keeps
       that order. A file the engine refuses is named, and the rest go on. */
    function take(files) {
      if (busy) return;
      files = files.filter(Boolean);
      if (!files.length) { say("That drop carried no file. Use Choose a photo instead."); return; }
      var extra = single && files.length > 1;
      if (single) files = files.slice(0, 1);
      busy = true;
      next.disabled = true;
      var refused = [];
      var wasEmpty = !rows.length;
      var keepMeta = keepIn.checked;
      files.reduce(function (chain, file, i) {
        return chain.then(function () {
          if (shut) return null;
          say(files.length > 1 ? "Preparing photo " + (i + 1) + " of " + files.length + "..."
            : "Preparing the photo...");
          return engine().intake(file, { keepMeta: keepMeta }).then(function (made) {
            if (shut) { engine().letGo(made); return; }
            syncRows();
            if (single) {
              rows.forEach(function (r) { engine().letGo(r.photo); });
              rows = [];
            }
            var auto = imageRegion.humanize(made.from);
            /* the engine says which switches a new photo starts with */
            var starts = engine().defaults(made);
            rows.push({ photo: made, caption: "", alt: auto, autoAlt: auto,
                        uhd: starts.uhd, truesize: starts.truesize });
          }, function (err) {
            refused.push(err && err.message ? err.message : String(err));
          });
        });
      }, Promise.resolve()).then(function () {
        busy = false;
        if (shut) return;
        if (wasEmpty) at = target.list().length;
        var over = rows.filter(function (r) { return r.photo.overLimit; });
        if (refused.length) say(refused.join(" "));
        else if (over.length === 1) say(photoLimitNote(over[0].photo), true);
        else if (over.length) {
          say(over.length + " originals are over the " + engine().GIT_FILE_LIMIT_MB +
            " MB GitHub takes in one file. They are saved all the same, and those files " +
            "have to be uploaded by hand.", true);
        } else say(extra ? "One photo at a time. This box uses the first file." : "");
        if (!rows.length) { next.disabled = true; return; }
        show(step === 0 ? 1 : step);
      });
    }

    /* photos dropped anywhere on the box are taken, on any step */
    ["dragover", "dragleave", "drop"].forEach(function (type) {
      box.addEventListener(type, function (e) {
        if (!e.dataTransfer) return;
        e.preventDefault();
        e.stopPropagation();
        zone.classList.toggle("is-over", type === "dragover");
        if (type === "drop") take(Array.prototype.slice.call(e.dataTransfer.files || []));
      });
    });

    function add() {
      syncRows();
      var entries = rows.map(function (r) {
        return imageRegion.fromPhoto(r.photo,
          { caption: r.caption.trim(), alt: r.alt.trim(), uhd: r.uhd, truesize: r.truesize }, g.kind);
      });
      rows = [];                 /* the target holds them now */
      target.putAll(entries, at);
      done(true);
    }

    var shut = false;
    function done(added) {
      if (shut) return;
      shut = true;
      rows.forEach(function (r) { engine().letGo(r.photo); });
      rows = [];
      dialogDown(escMe);
      scrimDown();
      if (box.parentNode) box.parentNode.removeChild(box);
      if (opts.done) opts.done(!!added);
    }
    function escMe() { done(false); }
    xBtn.addEventListener("click", escMe);

    box.appendChild(headEl);
    box.appendChild(xBtn);
    box.appendChild(steps);
    box.appendChild(body);
    box.appendChild(note);
    box.appendChild(btns);
    gripAdd(box);
    scrimUp();
    doc.body.appendChild(box);
    dialogUp(escMe);
    show(0);
    if (opts.files && opts.files.length) take(opts.files);
    else if (opts.choose) input.click();
    return box;
  }

  /* PHOTOS, the box for one carousel.

     Every photo in one list, each with its caption, its alt text, its
     place and its file. Every change waits in the box and Apply writes
     them together, which is what lets Cancel mean that nothing happened.
     The box asks before it throws a change away.

     focusAt is the photo to open on, or -1. opts.done is told true when
     Apply wrote the carousel, and false when the box closed without. */
  function photosBox(g, focusAt, opts) {
    opts = opts || {};
    if (viewing === "before") api.after();
    injectStyles();
    guardDocumentDrops();
    /* swap is a replacement file not applied yet; fresh is a photo this
       box added. Both are let go if the box closes without Apply. */
    /* The kind's own fields, held on the row rather than on the entry, so
       Cancel leaves the entry as it was. A replaced photo keeps them: they
       are written after the new file's fields and not before. */
    function valuesOf(en) {
      var out = {};
      imageRegion.fieldsOf(g.kind).forEach(function (k) { out[k] = en[k]; });
      return out;
    }
    var rows = g.model.filter(realEntry).map(function (en) {
      return { en: en, caption: en.caption || "", alt: en.alt || "", autoAlt: en.alt || "",
               uhd: !!en.uhd, truesize: !!en.truesize, values: valuesOf(en), swap: null, fresh: false };
    });
    /* the frame choice, for a kind that shows its photos in a frame */
    var shapeNow = g.kind.shapes && g.head && typeof g.head.shape === "string" ? g.head.shape : "";
    function sig() {
      return JSON.stringify({ shape: shapeNow, rows: rows.map(function (r) {
        return [r.en.src, r.caption, r.alt, r.uhd, r.truesize, r.swap ? r.swap.files.hd : "", r.values];
      }) });
    }
    var was = sig();
    var said = describeRegion(g);
    var name = said.name, noun = said.noun;

    var box = doc.createElement("div");
    box.className = "ced-modal ced-photos";
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-modal", "true");
    box.setAttribute("aria-label", "Photos in " + name);

    var headEl = doc.createElement("div");
    headEl.className = "ced-modal__head";
    var tag = doc.createElement("span");
    tag.className = "ced-b ced-b--y";
    tag.textContent = "PHOTOS";
    var who = doc.createElement("span");
    who.className = "ced-slug";
    who.textContent = name;
    headEl.appendChild(tag);
    headEl.appendChild(who);

    var xBtn = doc.createElement("button");
    xBtn.type = "button";
    xBtn.className = "ced-modal__x";
    xBtn.setAttribute("aria-label", "Close");
    xBtn.title = "Close";
    xBtn.innerHTML = CED_X;

    var body = doc.createElement("div");
    body.className = "ced-photos__body";
    var none = doc.createElement("p");
    none.className = "ced-empty";
    var list = doc.createElement("ol");
    list.className = "ced-photos__list";
    var replaceIn = doc.createElement("input");
    replaceIn.type = "file";
    replaceIn.accept = engine().ACCEPT;
    replaceIn.hidden = true;
    body.appendChild(none);
    body.appendChild(list);
    body.appendChild(replaceIn);

    var note = doc.createElement("div");
    note.className = "ced-modal__status";
    function say(t) { note.textContent = t || ""; }

    var btns = doc.createElement("div");
    btns.className = "ced-modal__btns";
    function btn(label, cls, fn) {
      var b = doc.createElement("button");
      b.type = "button";
      b.className = "ced-btn" + (cls ? " " + cls : "");
      b.textContent = label;
      b.addEventListener("click", fn);
      btns.appendChild(b);
      return b;
    }

    /* ADD PHOTO, pointed at this box's list rather than at the page */
    var draft = {
      name: name,
      list: function () {
        return rows.map(function (r) {
          return r.swap ? { src: r.swap.files.hd, preview: r.swap.urls.hd } : r.en;
        });
      },
      seeds: function () { return !rows.length && g.seeds.length > 0; },
      putAll: function (entries, at) {
        Array.prototype.splice.apply(rows, [at, 0].concat(entries.map(function (en) {
          return { en: en, caption: en.caption, alt: en.alt, autoAlt: en.alt, uhd: !!en.uhd,
                   truesize: !!en.truesize, values: valuesOf(en), swap: null, fresh: true };
        })));
        draw(at);
        say(entries.length > 1 ? "Added. Press Apply to keep them." : "Added. Press Apply to keep it.");
      }
    };
    var addBtn = btn("Add a photo", "", function () { addPhotoBox(g, { target: draft }); });

    /* THE FRAME. Auto follows the photos in the box as they stand, and its
       label says what it would give; Landscape and Portrait are the author's
       word, which the frame keeps whatever the photos are. */
    var frameBtns = [];
    if (g.kind.shapes) {
      var group = doc.createElement("span");
      group.className = "ced-frame";
      group.setAttribute("role", "group");
      group.setAttribute("aria-label", "Frame");
      var groupWords = doc.createElement("span");
      groupWords.className = "ced-frame__label";
      groupWords.textContent = "Frame";
      group.appendChild(groupWords);
      [["", "Auto"], ["landscape", "Landscape"], ["portrait", "Portrait"]].forEach(function (pair) {
        var b = doc.createElement("button");
        b.type = "button";
        b.className = "ced-btn";
        b.setAttribute("data-shape", pair[0]);
        b.addEventListener("click", function () {
          shapeNow = pair[0];
          drawFrame();
          say("Frame: " + (pair[0] || "Auto") + ". Press Apply to keep it.");
        });
        frameBtns.push({ el: b, word: pair[0], label: pair[1] });
        group.appendChild(b);
      });
      btns.appendChild(group);
    }
    function drawFrame() {
      if (!frameBtns || !frameBtns.length) return;
      var auto = AMH.work && AMH.work.frameShape
        ? AMH.work.frameShape(rows.map(function (r) {
            var p = r.swap;
            return p ? { w: p.w, h: p.h } : { w: +r.en.w || 0, h: +r.en.h || 0 };
          }), "").orientation
        : "";
      var chosen = shapeNow === "landscape" || shapeNow === "portrait" ? shapeNow : "";
      frameBtns.forEach(function (f) {
        f.el.textContent = f.word ? f.label : "Auto" + (auto ? " (" + auto + ")" : "");
        f.el.setAttribute("aria-pressed", String(f.word === chosen));
      });
    }
    var sp = doc.createElement("span");
    sp.className = "ced-spacer";
    btns.appendChild(sp);
    btn("Cancel", "", cancel);
    btn("Apply", "ced-btn--accent", apply);

    function rowEl(r, i) {
      var up = iconTool("Move earlier", ICON.up, function () { move(r, -1, 0); });
      up.disabled = i === 0;
      var down = iconTool("Move later", ICON.down, function () { move(r, 1, 1); });
      down.disabled = i === rows.length - 1;
      var rep = doc.createElement("button");
      rep.type = "button";
      rep.className = "ced-tool";
      rep.textContent = "Replace";
      rep.title = "Choose another file for this photo, and keep its caption and alt text";
      rep.addEventListener("click", function () { replacing = r; replaceIn.click(); });
      var bin = iconTool("Delete this photo", CED_TRASH, function () { trash(r); }, "ced-tool--danger");
      var file = doc.createElement("span");
      file.className = "ced-photo__file";
      file.textContent = r.swap ? r.swap.files.hd : r.en.src;
      if (r.swap || r.fresh) {
        var mark = doc.createElement("span");
        mark.className = "ced-photo__tag";
        mark.textContent = r.swap ? "REPLACED" : "NEW";
        file.appendChild(mark);
      }
      /* a photo the engine holds says everything about itself; a photo on
         disk says what its markup holds */
      var photo = r.swap || r.en.photo || null;
      /* the controls a kind adds of its own: the gallery tiles put their
         width and their priority here */
      var extras = null;
      if (g.kind.rowExtras) {
        extras = doc.createElement("div");
        extras.className = "ced-photo__extras";
        g.kind.rowExtras(extras, r.values, function () {
          say("Changed. Press Apply to keep it.");
        });
      }
      return photoRow({
        n: i + 1, pic: r.swap ? r.swap.urls.sd : (r.en.preview || r.en.src),
        caption: r.caption, alt: r.alt, autoAlt: r.autoAlt, file: file,
        facts: photoFacts(photo, r.en),
        /* the switches are for a photo that has an original to show */
        truesize: (r.swap || r.en.original) ? { on: r.truesize } : null,
        uhd: (r.swap || r.en.original) ? { on: r.uhd, what: uhdWhat(photo, r.en) } : null,
        extras: extras,
        acts: [up, down, rep, bin],
        onCaption: function (v) { r.caption = v; },
        onAlt: function (v) { r.alt = v; },
        onTruesize: function (on) { r.truesize = on; },
        onUhd: function (on) { r.uhd = on; }
      }).li;
    }

    function draw(focusRow) {
      list.innerHTML = "";
      none.hidden = rows.length > 0;
      none.textContent = g.seeds.length
        ? "No photos yet. The placeholder photos show until you add one."
        : "No photos yet.";
      rows.forEach(function (r, i) { list.appendChild(rowEl(r, i)); });
      drawFrame();
      var li = typeof focusRow === "number" ? list.children[focusRow] : null;
      if (li) {
        li.scrollIntoView({ block: "nearest" });
        li.querySelector("input").focus();
      }
    }

    function move(r, by, which) {
      var i = rows.indexOf(r), to = i + by;
      if (i < 0 || to < 0 || to >= rows.length) return;
      rows.splice(i, 1);
      rows.splice(to, 0, r);
      draw();
      /* the focus follows the photo, so a run of presses keeps moving it */
      var li = list.children[to];
      var b = li ? li.querySelectorAll(".ced-photo__acts .ced-tool")[which] : null;
      if (b && !b.disabled) b.focus();
      else if (li) li.querySelector("input").focus();
      say("Moved. Press Apply to keep the new order.");
    }

    var replacing = null;
    replaceIn.addEventListener("change", function () {
      var file = (replaceIn.files || [])[0];
      replaceIn.value = "";
      var r = replacing;
      replacing = null;
      if (!file || !r) return;
      say("Preparing the photo...");
      engine().intake(file, { keepMeta: keepMetaChoice }).then(function (made) {
        if (shut || rows.indexOf(r) === -1) { engine().letGo(made); return; }
        if (r.swap) engine().letGo(r.swap);
        r.swap = made;
        /* The engine's defaults, the way the wizard takes a photo. A default
           turns a switch on and never off: a switch the author turned on
           stays on for the new file. */
        var starts = engine().defaults(made);
        var turnedOn = (starts.truesize && !r.truesize) || (starts.uhd && !r.uhd);
        if (starts.truesize) r.truesize = true;
        if (starts.uhd) r.uhd = true;
        draw(rows.indexOf(r));
        say(turnedOn ? "Replaced. This photo shows at its own size, so its switches are on. Press Apply to keep it."
          : "Replaced. Press Apply to keep it.");
      }, function (err) {
        if (!shut) say(err && err.message ? err.message : String(err));
      });
    });

    function trash(r) {
      askBox({
        tag: "DELETE", title: "Delete this photo?", danger: true,
        thumb: r.swap ? r.swap.urls.hd : (r.en.preview || r.en.src),
        code: r.swap ? r.swap.files.hd : r.en.src,
        lines: [r.caption ? "Caption: " + r.caption : "",
                rows.length === 1 ? g.kind.lastImageNote(g).trim() : "",
                "It leaves the " + noun + " when you press Apply."],
        yes: "Delete photo"
      }).then(function (yes) {
        if (!yes || shut) return;
        var i = rows.indexOf(r);
        if (i === -1) return;
        rows.splice(i, 1);
        if (r.swap) engine().letGo(r.swap);
        if (r.fresh) engine().letGo(r.en.photo);
        draw();
        say("Deleted. Press Apply to keep the change.");
      });
    }

    function apply() {
      if (sig() === was) { done(false); return; }
      var next = rows.map(function (r) {
        var en = r.en;
        if (r.swap) {
          engine().hold(r.swap);
          if (r.fresh) engine().letGo(en.photo);
          en = imageRegion.fromPhoto(r.swap, en, g.kind);
        } else if (r.fresh) {
          engine().hold(en.photo);
        }
        en.caption = r.caption.trim();
        en.alt = r.alt.trim();
        en.uhd = r.uhd || r.truesize;
        en.truesize = r.truesize;
        /* last, so a replaced photo keeps the numbers set in this box rather
           than the ones fromPhoto carried over with the file */
        Object.keys(r.values).forEach(function (k) { en[k] = r.values[k]; });
        return en;
      });
      g.model.forEach(function (en) { if (next.indexOf(en) === -1) imageRegion.revokePreview(en); });
      g.model = next;
      if (g.kind.shapes) g.head = { shape: shapeNow };
      if (!next.length && !g.seeds.length && g.kind.mayBeEmpty) {
        g.model.push(imageRegion.emptySlot(g.kind));
      }
      exportedClean = false;
      renderGallery(g, null, 0);
      pendingSyncGallery(g);
      refreshDirtyUI();
      done(true);
      photoPrune();
    }

    function cancel() {
      if (shut) return;
      if (sig() === was) { done(false); return; }
      askBox({
        tag: "DISCARD", title: "Discard your changes?", danger: true,
        lines: ["The changes in this box are not applied yet. Discarding them " +
                "leaves the " + noun + " as it is."],
        yes: "Discard changes", no: "Keep editing"
      }).then(function (yes) { if (yes) done(false); });
    }

    var shut = false;
    function done(applied) {
      if (shut) return;
      shut = true;
      if (!applied) {
        rows.forEach(function (r) {
          if (r.swap) engine().letGo(r.swap);
          if (r.fresh) engine().letGo(r.en.photo);
        });
      }
      dialogDown(cancel);
      scrimDown();
      if (box.parentNode) box.parentNode.removeChild(box);
      if (opts.done) opts.done(!!applied);
    }
    xBtn.addEventListener("click", cancel);

    box.appendChild(headEl);
    box.appendChild(xBtn);
    box.appendChild(body);
    box.appendChild(note);
    box.appendChild(btns);
    gripAdd(box);
    scrimUp();
    doc.body.appendChild(box);
    dialogUp(cancel);
    var opening = focusAt >= 0 && focusAt < rows.length;
    draw(opening ? focusAt : undefined);
    if (!opening) addBtn.focus();
    say("Changes wait in this box until you press Apply.");
    return box;
  }

  /* ------------------------------------------------------------
     A CAPTION, EDITED WHERE IT IS

     While the editor is on, a carousel's caption label carries a pencil,
     and the pencil turns the label into a field on the photo itself. It is
     the quick way. PHOTOS is still where alt text, order and files live.

     THE PENCIL IS ON A CAPTION THAT EXISTS. It shows only over a real photo
     that has one. Writing a first caption is the wizard's job and PHOTOS's.

     THE FIELD KEEPS ITS KEYS. Above it, the carousel moves on the arrow
     keys, and a deep dive's drawer opens the viewer on Enter and Space and
     closes on Escape. Every key stops at the field, so typing changes the
     caption and nothing else.

     A SAVE DOES NOT REBUILD THE CAROUSEL. The label, the photo's own
     data-caption and a deep dive's template are written in place, so the
     click that ended the edit still lands on what it was aimed at.
     ------------------------------------------------------------ */
  var capEditing = null;     /* the open caption field's finish(save), or null */

  /* The photo a pencil is for: the one on screen, when it is real and has a
     caption, and never in the before view, which shows what is published. */
  function captionTarget(g) {
    if (viewing === "before") return null;
    var en = displayedEntries(g)[activeIndex(g)];
    return realEntry(en) && en.caption ? en : null;
  }

  /* Put the pencil on a carousel's caption label, show it or hide it, or
     take it away. Runs after every rebuild and at every change of the photo
     on screen, so it is safe to call as often as those happen. */
  function captionPencil(g) {
    if (!g.live || !g.live.isConnected) return;
    var label = g.live.querySelector(".gallery__caption");
    var pen = label ? label.querySelector(".ced-cappen") : null;
    if (!active || !label) {
      if (pen) pen.parentNode.removeChild(pen);
      return;
    }
    if (!pen) {
      pen = doc.createElement("button");
      pen.type = "button";
      pen.className = "ced-cappen";
      pen.innerHTML = ICON.pencil;
      pen.title = "Edit this caption";
      pen.setAttribute("aria-label", "Edit this caption");
      pen.addEventListener("click", function (e) {
        e.preventDefault();
        e.stopPropagation();
        captionEdit(g, label);
      });
      /* Enter and Space press the pencil. A drawer's carousel would also
         take them as "open the viewer", so they go no further. */
      pen.addEventListener("keydown", function (e) {
        if (e.key === "Enter" || e.key === " " || e.key === "Spacebar") e.stopPropagation();
      });
      label.appendChild(pen);
    }
    if (label.classList.contains("ced-capediting")) return;
    pen.hidden = !captionTarget(g);
  }

  /* Open the field on one photo's caption, wherever that caption is drawn.

     The carousel passes its one label; a surface that shows every photo at
     once passes the label of the photo the pencil was on. Enter saves,
     Escape puts the caption back, and moving away saves, because a click
     somewhere else is the reader moving on.

       en       the photo whose caption this is
       label    the element the field is mounted into
       textEl   the words to hide while the field stands in for them
       pen      the pencil to hide with them, or none */
  function captionField(g, en, label, textEl, pen) {
    if (!en || !label || label.classList.contains("ced-capediting")) return;
    if (capEditing) capEditing(true);        /* one field at a time: the other saves */
    var text = textEl || null;
    var field = doc.createElement("input");
    field.type = "text";
    field.className = "ced-capedit";
    field.value = en.caption;
    field.setAttribute("aria-label", "Caption");
    label.classList.add("ced-capediting");
    if (text) text.hidden = true;
    if (pen) pen.hidden = true;
    label.insertBefore(field, pen || null);

    var shut = false;
    function finish(save) {
      if (shut) return;
      shut = true;
      capEditing = null;
      var value = field.value.trim();
      /* taking the field out of the page blurs it, which is why shut is set
         before this line and not after it */
      if (field.parentNode) field.parentNode.removeChild(field);
      label.classList.remove("ced-capediting");
      if (text) text.hidden = false;
      /* the pencil comes back first, and the write hides it again when the
         caption it edits is now empty */
      if (pen) pen.hidden = false;
      if (save && value !== en.caption) captionSave(g, en, value);
      captionPencil(g);
    }
    field.addEventListener("keydown", function (e) {
      e.stopPropagation();
      if (e.key === "Enter") { e.preventDefault(); finish(true); }
      else if (e.key === "Escape") { e.preventDefault(); finish(false); }
    });
    field.addEventListener("blur", function () { finish(true); });
    /* a click in the field places the caret; on the carousel it would open
       the viewer */
    field.addEventListener("click", function (e) { e.stopPropagation(); });
    capEditing = finish;
    field.focus();
    field.select();
  }

  /* The carousel's pencil: the photo on screen, and the one label it has. */
  function captionEdit(g, label) {
    captionField(g, captionTarget(g), label,
      label.querySelector(".gallery__caption-text"),
      label.querySelector(".ced-cappen"));
  }

  /* Write one caption: the photo's entry, the photo in the live carousel,
     the label when that photo is on screen, a deep dive's template, and the
     record of what is waiting to be saved. An empty caption is a choice, and
     the label hides, as it does for any photo with none. */
  function captionSave(g, en, value) {
    en.caption = value;
    var at = g.model.indexOf(en);
    var live = g.live && g.live.isConnected ? g.live : null;
    /* A kind that draws itself writes its own caption where it stands. The
       carousel path below would find nothing to write, and a redraw would
       take the element the reader's next click is aimed at. */
    if (g.kind.captionWrite) g.kind.captionWrite(g, en, value);
    var img = !g.kind.captionWrite && live && at !== -1
      ? live.querySelectorAll(".gallery__stage img")[at] : null;
    if (img) {
      if (value) img.setAttribute("data-caption", value);
      else img.removeAttribute("data-caption");
      var label = live.querySelector(".gallery__caption");
      var text = label ? label.querySelector(".gallery__caption-text") : null;
      if (img.classList.contains("is-active") && text) {
        text.textContent = value;
        label.classList.toggle("is-empty", !value);
      }
    }
    syncGallerySource(g, displayedEntries(g));
    exportedClean = false;
    pendingSyncGallery(g);
    refreshDirtyUI();
    updateGalleryChip(g);
  }

  /* ------------------------------------------------------------
     A PROJECT, AS FIELDS

     A card on the home page is nine regions, and a chip edits one of them.
     The form edits all of them at once, so it has to read each region back
     into a control and write it out again in the same shape.

     THE ROUND TRIP RULE. A field is offered as its control only when its
     region parses into it and nothing is lost. A region written by hand
     into a shape these readers do not know is offered as raw HTML with a
     note instead, so opening the form can never flatten it.

     A field that was not changed writes nothing, so opening the form and
     pressing Apply leaves every byte where it was.

     WHY THIS IS IN THIS FILE. A gallery train has a kind of its own, so
     gallery.js describes it. A project card has no kind: it is nine plain
     regions and one image region, all of them this file's own machinery.
     There is no trunk that owns a card, so the description lives with the
     machinery that reads it.
     ------------------------------------------------------------ */

  /* Text, escaped for a text node. Not escAttr: that also escapes a quote,
     and a lead with a quotation mark in it would come back changed. */
  function escText(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");
  }
  function parseHtml(html) {
    var box = doc.createElement("div");
    box.innerHTML = html;
    return box;
  }
  /* Every child that carries content. A whitespace-only text node is
     layout; anything else is something a reader has to be able to hold. */
  function realKids(box) {
    return Array.prototype.filter.call(box.childNodes, function (n) {
      return !(n.nodeType === 3 && n.nodeValue.trim() === "");
    });
  }
  function onlyClass(el, name) {
    return el.nodeType === 1 && el.classList.contains(name) && el.classList.length === 1 &&
      el.attributes.length === 1;
  }
  /* A card's own indent, and its children's. Every card in the page is laid
     out this way, and the generator writes the same. */
  var CARD_IND = "            ";

  /* Each kind reads one region's inner HTML into a value, or returns null
     to say it cannot hold what is there. write() is the inverse. */
  var FIELD_KINDS = {
    /* a line of words, no markup */
    text: {
      read: function (html) {
        var box = parseHtml(html);
        return box.querySelector("*") ? null : box.textContent;
      },
      write: function (v) { return escText(v); }
    },
    /* markup, kept as it is: a lead holds <em> and &nbsp; today, and a
       second format for the same field would need a converter that loses
       exactly those */
    html: {
      read: function (html) { return html; },
      write: function (v) { return v; }
    },
    /* one stat a line, as  bold | the rest */
    stats: {
      read: function (html) {
        var out = [], ok = true;
        realKids(parseHtml(html)).forEach(function (n) {
          if (!onlyClass(n, "stat") || n.tagName !== "SPAN") { ok = false; return; }
          var b = n.childNodes[0];
          if (!b || b.nodeType !== 1 || b.tagName !== "B" || b.attributes.length) { ok = false; return; }
          var rest = n.innerHTML.slice(b.outerHTML.length);
          out.push(b.innerHTML + " | " + rest.replace(/^\s+/, ""));
        });
        return ok ? out.join("\n") : null;
      },
      write: function (v) {
        var rows = String(v).split("\n").map(function (l) { return l.trim(); })
          .filter(function (l) { return l !== ""; })
          .map(function (l) {
            var at = l.indexOf("|");
            var bold = at < 0 ? l : l.slice(0, at).trim();
            var rest = at < 0 ? "" : l.slice(at + 1).trim();
            return CARD_IND + '  <span class="stat"><b>' + bold + "</b>" +
              (rest ? " " + rest : "") + "</span>";
          });
        return rows.length ? "\n" + rows.join("\n") + "\n" + CARD_IND : "";
      }
    },
    /* one point a line */
    lines: {
      read: function (html) {
        var out = [], ok = true;
        realKids(parseHtml(html)).forEach(function (n) {
          if (n.nodeType !== 1 || n.tagName !== "LI" || n.attributes.length) { ok = false; return; }
          out.push(n.innerHTML);
        });
        return ok ? out.join("\n") : null;
      },
      write: function (v) {
        var rows = String(v).split("\n").map(function (l) { return l.trim(); })
          .filter(function (l) { return l !== ""; })
          .map(function (l) { return CARD_IND + "  <li>" + l + "</li>"; });
        return rows.length ? "\n" + rows.join("\n") + "\n" + CARD_IND : "";
      }
    },
    /* a named row: the name is kept as the file has it, the value is edited */
    spec: {
      read: function (html) {
        var kids = realKids(parseHtml(html));
        if (kids.length !== 2) return null;
        if (kids[0].nodeType !== 1 || kids[0].tagName !== "DT" || kids[0].attributes.length) return null;
        if (kids[1].nodeType !== 1 || kids[1].tagName !== "DD" || kids[1].attributes.length) return null;
        if (kids[0].querySelector("*")) return null;
        return { label: kids[0].textContent, value: kids[1].innerHTML };
      },
      write: function (v) {
        return "<dt>" + escText(v.label) + "</dt><dd>" + v.value + "</dd>";
      }
    },
    /* a named row of chips, written as a comma list */
    chips: {
      read: function (html) {
        var kids = realKids(parseHtml(html));
        if (kids.length !== 2) return null;
        if (kids[0].nodeType !== 1 || kids[0].tagName !== "DT" || kids[0].attributes.length) return null;
        if (kids[1].nodeType !== 1 || kids[1].tagName !== "DD" || kids[1].attributes.length) return null;
        if (kids[0].querySelector("*")) return null;
        var inner = realKids(kids[1]);
        if (inner.length !== 1 || !onlyClass(inner[0], "chips") || inner[0].tagName !== "SPAN") return null;
        var out = [], ok = true;
        realKids(inner[0]).forEach(function (c) {
          if (!onlyClass(c, "chip") || c.tagName !== "SPAN" || c.querySelector("*")) { ok = false; return; }
          if (c.textContent.indexOf(",") !== -1) { ok = false; return; }
          out.push(c.textContent);
        });
        return ok ? { label: kids[0].textContent, value: out.join(", ") } : null;
      },
      write: function (v) {
        var chips = String(v.value).split(",").map(function (c) { return c.trim(); })
          .filter(function (c) { return c !== ""; })
          .map(function (c) { return '<span class="chip">' + escText(c) + "</span>"; });
        return "<dt>" + escText(v.label) + '</dt><dd><span class="chips">' +
          chips.join("") + "</span></dd>";
      }
    }
  };

  /* One card, field by field, in the order the card itself reads.

     key is the slug after the card's own prefix. A card has one of
     spec-stack or spec-tech, never both, so the second spec names the two
     and takes whichever the card carries. */
  var PROJECT_FIELDS = [
    { key: "title", label: "Title", kind: "text", line: true },
    { key: "meta", label: "Meta", kind: "text", line: true,
      hint: "Company - Role - Dates" },
    { key: "lead", label: "Lead", kind: "html", rows: 3,
      hint: "one sentence that hooks the reader" },
    { key: "desc", label: "Description", kind: "html", rows: 6 },
    { key: "stats", label: "Stats, one a line as  bold | the rest", kind: "stats", rows: 3 },
    { key: "highlights", label: "Highlights, one a line", kind: "lines", rows: 3 },
    { key: "spec-role", label: "Role", kind: "spec", line: true },
    { key: ["spec-stack", "spec-tech"], label: "Stack or Tech", kind: "chips", line: true,
      hint: "one name, then the next, separated by commas" }
  ];

  /* The slug a field has on one card, or null when the card has neither. */
  function fieldSlug(id, f) {
    var keys = typeof f.key === "string" ? [f.key] : f.key;
    for (var i = 0; i < keys.length; i++) {
      if (regionBySlug(id + "-" + keys[i])) return id + "-" + keys[i];
    }
    return null;
  }
  function regionBySlug(slug) {
    for (var i = 0; i < regions.length; i++) if (regions[i].slug === slug) return regions[i];
    return null;
  }

  /* ------------------------------------------------------------
     THE PROJECT BLOCK

     One template, and the only thing that writes a whole card. New and
     Duplicate use it; every other move on the list carries the bytes the
     file already had.
     ------------------------------------------------------------ */

  /* The decoration a card wears in the source. It is not read by anything;
     it is there so a person opening the file sees where a block starts. */
  function cardBanner(name) {
    var bar = new Array(64).join("=").replace(/=/g, "\u2550");
    var head = "  PROJECT \u2014 " + name;
    var pad = Math.max(1, 64 - head.length);
    return "<!-- \u2554" + bar + "\u2557\n" +
      "             \u2551" + head + new Array(pad + 1).join(" ") + "\u2551\n" +
      "             \u255a" + bar + "\u255d -->";
  }
  function cardEnd(name) {
    var bar = new Array(16).join("=").replace(/=/g, "\u2550");
    return "<!-- \u255a" + bar + " END \u00b7 " + name + " " + bar + "\u255d -->";
  }

  /* What each field's region is wrapped in. The pair is the element the
     markers fence, which the splice never touches. */
  var CARD_TAGS = {
    title: ['<h3 class="project__title">', "</h3>"],
    meta: ['<p class="project__meta">', "</p>"],
    lead: ['<p class="project__lead">', "</p>"],
    desc: ['<p class="project__desc">', "</p>"],
    stats: ['<div class="stats">', "</div>"],
    highlights: ['<ul class="highlights">', "</ul>"],
    "spec-role": ['<div class="spec">', "</div>"],
    "spec-stack": ['<div class="spec">', "</div>"],
    "spec-tech": ['<div class="spec">', "</div>"]
  };

  /* A whole project, as the markup the page and the file both get. The
     string is the one source of truth: it becomes the DOM here and the
     bytes at export, so the two cannot drift.

     Written at no indent; the list splice adds the file's own. */
  function makeProject(head, id, entries) {
    var name = head.title || "New project";
    var L = [];
    function put(slug, note, markup) {
      if (note) L.push(note);
      L.push("<!--[edit:" + id + "-" + slug + "]-->");
      L.push(markup);
      L.push("<!--[/edit:" + id + "-" + slug + "]-->");
    }
    L.push("<!--[item:" + id + "]-->");
    L.push(cardBanner(name));
    L.push('<article class="project">');
    L.push('  <div class="project__media reveal">');
    L.push("");
    L.push("    <!-- GALLERY \u00b7 one <img> per photo (src, alt, optional data-caption).");
    L.push("         Add or remove a photo = add or remove one <img> line below. -->");
    L.push("    <!--[edit:" + id + "-gallery]-->");
    /* the carousel's own serializer, so a card made here writes its photos
       exactly as an edit to the carousel would */
    L.push('    <div class="gallery">' + imageRegion.serialize(entries || [], "    ", KIND.carousel) + "</div>");
    L.push("    <!--[/edit:" + id + "-gallery]-->");
    L.push("");
    L.push("  </div>");
    L.push('  <div class="project__body reveal d1">');
    L.push("");
    L.push("    <!-- NUMBER \u00b7 automatic (01, 02\u2026) \u00b7 leave this span empty -->");
    L.push('    <span class="project__index"></span>');
    L.push("");
    /* The two spec rows sit inside one wrapper, the way every card has
       them, so they are gathered rather than written where they fall. */
    var body = [], specs = [];
    PROJECT_FIELDS.forEach(function (f) {
      var key = typeof f.key === "string" ? f.key : f.key[0];
      var kind = FIELD_KINDS[f.kind];
      var isSpec = f.kind === "spec" || f.kind === "chips";
      var value = head[key];
      var inner = isSpec
        ? kind.write(value || { label: key === "spec-role" ? "Role" : "Stack", value: "" })
        : kind.write(value || "");
      var tag = CARD_TAGS[key];
      var into = isSpec ? specs : body;
      var pad = isSpec ? "      " : "    ";
      if (!isSpec) into.push("");
      into.push(pad + "<!--[edit:" + id + "-" + key + "]-->");
      into.push(pad + tag[0] + inner + tag[1]);
      into.push(pad + "<!--[/edit:" + id + "-" + key + "]-->");
    });
    L = L.concat(body);
    L.push("");
    L.push("    <!-- SPECS / chips (required) -->");
    L.push('    <div class="specs">');
    L = L.concat(specs);
    L.push("    </div>");
    /* The drawer and the button that opens it, written only for a card
       that has one. A new project starts without, and gains both from the
       form's third view. */
    if (head.deepdive) {
      var dd = ddBuild(head.deepdive, id + "-dd-gallery",
        head.deepdive.photos || [], "      ");
      L.push("");
      L.push("    <!-- LEARN MORE \u00b7 opens the deep-dive drawer from the template below -->");
      L.push("    <!--[edit:" + id + "-more]-->");
      L.push('    <button class="project__more" type="button">' +
        escText(head.deepdive.label || "Learn more"));
      L.push('      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
        'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
        '<line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>');
      L.push("    </button>");
      L.push("    <!--[/edit:" + id + "-more]-->");
      L.push("");
      L.push("    <!-- DEEP DIVE \u00b7 written in Markdown; the source travels with it -->");
      L.push("    <!--[edit:" + id + "-deepdive]-->");
      L.push('    <template class="deepdive">' + dd.html + "</template>");
      L.push("    <!--[/edit:" + id + "-deepdive]-->");
    }
    L.push("");
    L.push("  </div>");
    L.push("</article>");
    L.push(cardEnd(name));
    L.push("<!--[/item:" + id + "]-->");
    return L.join("\n");
  }

  /* Which project a deep-dive region belongs to, or null.

     The slug is the card's id and then the word, which is how every region
     on a card is named, so the id is what comes before it. */
  function ddOwner(slug) {
    var m = /^([\w-]+)-deepdive$/.exec(slug || "");
    if (!m) return null;
    var st = lists.projects;
    return st && st.order.indexOf(m[1]) !== -1 ? m[1] : null;
  }

  /* ------------------------------------------------------------
     A DEEP DIVE, AS MARKDOWN

     The drawer behind Learn more holds paragraphs, one heading, a list of
     points, a closing note and one carousel. Markdown writes the first
     three. The last two are flags the renderer leaves a sign for, and this
     is the surface that decides what those signs mean.

     THE SOURCE IS THE TRUTH. What was typed travels inside the template as
     a script of a type no browser runs, and the rendered HTML follows it.
     So the form opens what was written rather than what it rendered to, and
     a hand edit to the rendered half would be lost at the next Apply. That
     is why the raw box refuses this region and names the form instead.
     ------------------------------------------------------------ */

  /* The source block can hold no tag and no closing script, because every
     < and & is written as an entity. Script content is raw text, so nothing
     decodes it on the way back in and the form does it here.

     It also keeps both tag checkers happy: each walks every < in a region,
     and a body that mentions <b> would fail them. */
  function ddEncode(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");
  }
  function ddDecode(s) {
    return String(s).replace(/&lt;/g, "<").replace(/&amp;/g, "&");
  }
  function ddSource(tpl) {
    var s = tpl && tpl.content && tpl.content.querySelector("script.dd-source");
    return s ? ddDecode(s.textContent) : null;
  }
  function nextEl(n) {
    while ((n = n.nextSibling)) { if (n.nodeType === 1) return n; }
    return null;
  }
  function prevEl(n) {
    while ((n = n.previousSibling)) { if (n.nodeType === 1) return n; }
    return null;
  }

  /* What the renderer's marks mean in a deep dive.

       note      the paragraph the mark sits with becomes the closing note,
                 whether the flag was written before it or after it
       gallery   the first one becomes the photographs, and a second is
                 dropped, because a deep dive has one carousel

     Photographs with no mark go last, which is where a reader expects them
     when nothing said otherwise. Returns the body and what it had to drop. */
  function ddResolve(html, slug, photos) {
    var box = doc.createElement("div");
    box.innerHTML = html;
    Array.prototype.forEach.call(box.querySelectorAll('[data-mark="note"]'), function (m) {
      var p = nextEl(m) || prevEl(m);
      if (p && p.tagName === "P") p.className = "dd-note";
      m.parentNode.removeChild(m);
    });
    var marks = Array.prototype.slice.call(box.querySelectorAll('[data-mark="gallery"]'));
    var spare = marks.length > 1 ? marks.length - 1 : 0;
    for (var i = 1; i < marks.length; i++) marks[i].parentNode.removeChild(marks[i]);
    var where = marks[0] || null;

    /* The container is written when there are photographs to put in it, and
       also when the body asked for one and has none yet. An empty region is
       what a first drop lands on: without it, a deep dive added in a sitting
       could never gain a photograph. The drawer takes an empty gallery out of
       its clone, so a reader never sees one. */
    if ((photos && photos.length) || where) {
      var holder = doc.createElement("div");
      holder.className = "gallery";
      /* THE PHOTOGRAPHS GO INTO THE MARKUP, not only into the region.

         A gallery region corrects its list at export only when it has been
         edited. This writes the template, so a container left empty here
         would export empty and the drawer would open on nothing. */
      (photos || []).forEach(function (en) {
        var im = doc.createElement("img");
        engine().attrs(en, KIND.deepdive.slot).forEach(function (a) {
          im.setAttribute(a[0], a[1]);
        });
        im.setAttribute("loading", "lazy");
        im.setAttribute("alt", en.alt || "");
        if (en.caption) im.setAttribute("data-caption", en.caption);
        holder.appendChild(im);
      });
      if (where) where.parentNode.replaceChild(holder, where);
      else box.appendChild(holder);
      /* the pair the export splices the photograph list between */
      holder.parentNode.insertBefore(doc.createComment("[edit:" + slug + "]"), holder);
      holder.parentNode.insertBefore(doc.createComment("[/edit:" + slug + "]"),
        holder.nextSibling);
    }
    return { html: box.innerHTML, spare: spare };
  }

  /* A whole deep dive as the template's inner markup: the source, the head
     that the drawer lifts, and the body the renderer wrote. */
  function ddBuild(dd, slug, photos, indent) {
    var ind = indent === undefined ? "              " : indent;
    var md = (window.AMH.markdown && window.AMH.markdown.render)
      ? window.AMH.markdown.render(dd.body || "")
      : "<p>" + escText(dd.body || "") + "</p>";
    var got = ddResolve(md, slug, photos);
    var lines = got.html.split("\n").map(function (l) { return l ? ind + l : l; });
    return {
      html: "\n" + ind + '<script type="text/markdown" class="dd-source">' +
        ddEncode(dd.body || "") + "</" + "script>\n" +
        ind + '<h2 class="dd-lead">' + escText(dd.title || "") + "</h2>\n" +
        ind + '<p class="dd-lead__sub">' + escText(dd.subtitle || "") + "</p>\n" +
        lines.join("\n") + "\n" + ind.slice(2),
      spare: got.spare
    };
  }

  /* ------------------------------------------------------------
     THE PROJECT FORM

     A chip edits one field of a card. This edits the whole card, and both
     write the same regions through applyRegion, so the two doors can never
     disagree about what a card says.

     A field the person did not touch writes nothing, so opening this and
     pressing Apply changes no byte of the page.
     ------------------------------------------------------------ */

  function projectForm(name, id, startAt) {
    var st = lists[name], spec = listKinds[name];
    if (!st || !spec) return;
    var making = !id;
    if (!making && !itemElement(st, id)) return;
    injectStyles();

    var box = doc.createElement("div");
    box.className = "ced-modal ced-projform";
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-modal", "true");

    var headEl = doc.createElement("div");
    headEl.className = "ced-modal__head";
    var tag = doc.createElement("span");
    tag.className = "ced-b ced-b--y";
    tag.textContent = "PROJECT";
    var who = doc.createElement("span");
    who.className = "ced-slug";
    headEl.appendChild(tag);
    headEl.appendChild(who);

    var xBtn = doc.createElement("button");
    xBtn.type = "button";
    xBtn.className = "ced-modal__x";
    xBtn.setAttribute("aria-label", "Close");
    xBtn.title = "Close";
    xBtn.innerHTML = CED_X;

    /* the three views, as tabs, the way the composer has them */
    var tabs = doc.createElement("div");
    tabs.className = "ced-tabs";
    tabs.setAttribute("role", "tablist");
    var panes = doc.createElement("div");
    panes.className = "ced-projform__body";
    var cardPane = doc.createElement("div");
    cardPane.className = "ced-pane";
    var imgPane = doc.createElement("div");
    imgPane.className = "ced-pane";
    imgPane.hidden = true;
    var ddPane = doc.createElement("div");
    ddPane.className = "ced-pane";
    ddPane.hidden = true;
    panes.appendChild(cardPane);
    panes.appendChild(imgPane);
    panes.appendChild(ddPane);
    var tabBtns = [];
    function tab(label, pane) {
      var b = doc.createElement("button");
      b.type = "button";
      b.className = "ced-tab";
      b.setAttribute("role", "tab");
      b.textContent = label;
      b.addEventListener("click", function () {
        tabBtns.forEach(function (x) {
          x.b.classList.toggle("on", x.b === b);
          x.b.setAttribute("aria-selected", x.b === b ? "true" : "false");
          x.pane.hidden = x.b !== b;
        });
        if (pane === imgPane) drawImages();
        if (pane === ddPane) drawDeep();
      });
      tabs.appendChild(b);
      tabBtns.push({ b: b, pane: pane });
      return b;
    }
    tab("Card", cardPane);
    tab("Images", imgPane);
    tab("Deep dive", ddPane);
    tabBtns.forEach(function (x, i) {
      x.b.classList.toggle("on", i === (startAt || 0));
      x.b.setAttribute("aria-selected", i === (startAt || 0) ? "true" : "false");
      x.pane.hidden = i !== (startAt || 0);
    });

    var note = doc.createElement("div");
    note.className = "ced-modal__status";

    /* ---------------- the Card view ---------------- */

    /* One row per field. A field whose region does not parse into its own
       control is offered as raw HTML instead, so a hand-written region is
       never flattened by opening this. */
    var rows = {};
    PROJECT_FIELDS.forEach(function (f) {
      var key = typeof f.key === "string" ? f.key : f.key[0];
      var slug = making ? null : fieldSlug(id, f);
      if (!making && !slug) return;
      var kind = FIELD_KINDS[f.kind];
      var r = slug ? regionBySlug(slug) : null;
      var value = r ? kind.read(r.current) : null;
      var raw = !!r && value === null;
      if (making) {
        value = (f.kind === "spec") ? { label: "Role", value: "" }
              : (f.kind === "chips") ? { label: "Stack", value: "" } : "";
      }

      var row = doc.createElement("label");
      row.className = "ced-field";
      var lab = doc.createElement("span");
      lab.className = "ced-field__label";
      lab.textContent = raw ? f.label + " - as HTML" : f.label;
      row.appendChild(lab);

      var nameIn = null, valIn;
      if (!raw && f.kind === "chips") {
        var pair = doc.createElement("span");
        pair.className = "ced-pair";
        nameIn = doc.createElement("input");
        nameIn.type = "text";
        nameIn.className = "ced-pair__name";
        nameIn.value = value.label;
        nameIn.setAttribute("aria-label", "The name of this row");
        valIn = doc.createElement("input");
        valIn.type = "text";
        valIn.value = value.value;
        pair.appendChild(nameIn);
        pair.appendChild(valIn);
        row.appendChild(pair);
      } else if (!raw && (f.line || f.kind === "spec")) {
        valIn = doc.createElement("input");
        valIn.type = "text";
        valIn.value = f.kind === "spec" ? value.value : value;
        row.appendChild(valIn);
      } else {
        valIn = doc.createElement("textarea");
        valIn.rows = raw ? 4 : (f.rows || 3);
        valIn.spellcheck = f.kind !== "html";
        valIn.value = raw ? r.current : value;
        row.appendChild(valIn);
      }
      valIn.spellcheck = false;
      if (f.hint && !raw) valIn.placeholder = f.hint;
      if (raw) {
        var why = doc.createElement("span");
        why.className = "ced-field__why";
        why.textContent = "This region is not in the shape this field reads, " +
          "so it is offered as it stands. What you write here is written as it stands.";
        row.appendChild(why);
      }
      cardPane.appendChild(row);
      rows[key] = {
        f: f, slug: slug, raw: raw, kind: kind, nameIn: nameIn, valIn: valIn,
        was: raw ? r.current : JSON.stringify(value),
        read: function () {
          if (this.raw) return this.valIn.value;
          if (this.f.kind === "chips") return { label: nameIn.value, value: valIn.value };
          if (this.f.kind === "spec") {
            var had = regionBySlug(this.slug);
            var old = had ? this.kind.read(had.current) : null;
            return { label: old ? old.label : "Role", value: this.valIn.value };
          }
          return this.valIn.value;
        }
      };
    });
    who.textContent = making ? "New project"
      : ((rows.title && rows.title.valIn.value) || id);

    /* ---------------- the Images view ---------------- */

    function gallery() { return making ? null : galBySlug(id + "-gallery"); }
    function drawImages() {
      imgPane.innerHTML = "";
      drawPhotos(imgPane, gallery(), making
        ? "Photographs go on once the project is on the page. Apply first, then open it again."
        : "This project has no gallery region.");
    }

    /* One carousel's photos, drawn for the card and again for the deep
       dive. The view shows them and hands the work to the photo boxes, so
       a photo added here is added exactly as (+) on the page adds one. */
    function drawPhotos(host, g, whenNone) {
      if (!g) {
        var soon = doc.createElement("p");
        soon.className = "ced-empty";
        soon.textContent = whenNone;
        host.appendChild(soon);
        return;
      }
      /* Only this part is drawn again after a box closes. The deep dive's
         view holds Markdown that may not be applied yet, and drawing the
         whole view again would throw it away. */
      var wrap = doc.createElement("div");
      wrap.className = "ced-photoview";
      host.appendChild(wrap);
      function paint() {
        wrap.innerHTML = "";
        var shown = g.model.filter(realEntry);
        if (shown.length) {
          var strip = doc.createElement("ul");
          strip.className = "ced-strip";
          shown.forEach(function (en) {
            var li = doc.createElement("li");
            var im = doc.createElement("img");
            im.src = en.preview || en.src;
            im.alt = en.alt || "";
            im.title = en.caption || en.src;
            li.appendChild(im);
            strip.appendChild(li);
          });
          wrap.appendChild(strip);
        } else {
          wrap.appendChild(says(g.seeds.length
            ? "No photos yet. The placeholder photos show until you add one."
            : "No photos yet."));
        }

        /* the same zone the wizard opens on, with the same button in it:
           either one opens the wizard straight onto the file picker */
        var zone = doc.createElement("div");
        zone.className = "ced-handoff__zone ced-drop";
        zone.innerHTML = "<strong>Drop photos here</strong><span>JPG, PNG, WebP or GIF</span>";
        function pick() { addPhotoBox(g, { choose: true, done: paint }); }
        zone.addEventListener("click", pick);
        zoneButton(zone, pick);
        ["dragover", "dragleave", "drop"].forEach(function (ev) {
          zone.addEventListener(ev, function (e) {
            e.preventDefault(); e.stopPropagation();
            zone.classList.toggle("is-over", ev === "dragover");
            if (ev !== "drop") return;
            var files = Array.prototype.slice.call((e.dataTransfer && e.dataTransfer.files) || []);
            if (files.length) addPhotoBox(g, { files: files, done: paint });
          });
        });
        wrap.appendChild(zone);

        var row = doc.createElement("div");
        row.className = "ced-btnrow";
        var add = doc.createElement("button");
        add.type = "button";
        add.className = "ced-btn";
        add.textContent = "Add a photo";
        add.addEventListener("click", function () { addPhotoBox(g, { done: paint }); });
        var edit = doc.createElement("button");
        edit.type = "button";
        edit.className = "ced-btn";
        edit.textContent = "Edit photos";
        edit.addEventListener("click", function () { photosBox(g, -1, { done: paint }); });
        row.appendChild(add);
        row.appendChild(edit);
        wrap.appendChild(row);
      }
      paint();
    }

    /* ---------------- the Deep dive view ---------------- */

    function ddRegion() { return making ? null : regionBySlug(id + "-deepdive"); }
    function ddGallery() { return making ? null : galBySlug(id + "-dd-gallery"); }
    function moreRegion() { return making ? null : regionBySlug(id + "-more"); }

    /* The words on the Learn more button, without the arrow beside them.
       Writing one back keeps the whitespace it was written with, so a
       button nobody touched is not reflowed. */
    function moreLabel(r) {
      return Array.prototype.filter.call(parseHtml(r.current).childNodes, function (n) {
        return n.nodeType === 3;
      }).map(function (n) { return n.nodeValue; }).join("").trim();
    }
    function moreWrite(r, label) {
      var box = parseHtml(r.current);
      var did = false;
      Array.prototype.forEach.call(box.childNodes, function (n) {
        if (did || n.nodeType !== 3 || !n.nodeValue.trim()) return;
        var m = /^(\s*)[\s\S]*?(\s*)$/.exec(n.nodeValue);
        n.nodeValue = m[1] + label + m[2];
        did = true;
      });
      return did ? box.innerHTML : escText(label);
    }
    /* the indent the template's own children are written at */
    function ddIndent(r) {
      var m = /\n([ \t]*)</.exec(r.original || r.current || "");
      return m ? m[1] : "              ";
    }
    function says(words, cls) {
      var p = doc.createElement("p");
      p.className = cls || "ced-empty";
      p.textContent = words;
      return p;
    }
    function textRow(host, label, value) {
      var row = doc.createElement("label");
      row.className = "ced-field";
      var lab = doc.createElement("span");
      lab.className = "ced-field__label";
      lab.textContent = label;
      var inp = doc.createElement("input");
      inp.type = "text";
      inp.spellcheck = false;
      inp.value = value;
      row.appendChild(lab);
      row.appendChild(inp);
      host.appendChild(row);
      return inp;
    }
    /* What a deep dive can carry that Markdown does not name. The two flags
       are the renderer's, so this list cannot disagree with what it obeys. */
    function ddSpecials() {
      var out = ((AMH.markdown && AMH.markdown.flags) || [])
        .filter(function (f) { return (f.for || ["post"]).indexOf("deepdive") !== -1; })
        .map(function (f) {
          return { write: "{" + f.name + "}", where: "anywhere on a line", does: f.does };
        });
      out.push({ write: "{!command}", where: "in place of the command",
                 does: "Writes the command as text instead of obeying it." });
      return out;
    }

    var ddFields = null;
    function ddValues() {
      return {
        title: ddFields.title.value.trim(),
        subtitle: ddFields.sub.value.trim(),
        label: ddFields.label.value.trim(),
        body: ddFields.body.value
      };
    }

    function drawDeep() {
      ddPane.innerHTML = "";
      ddFields = null;
      if (making) {
        ddPane.appendChild(says("A deep dive goes on once the project is on the " +
          "page. Apply first, then open the project again."));
        return;
      }
      var r = ddRegion();
      if (!r) {
        ddPane.appendChild(says("This project has no deep dive. A deep dive is the " +
          "drawer behind Learn more: a title, a subtitle, a body in Markdown, and " +
          "photographs of its own."));
        var add = doc.createElement("button");
        add.type = "button";
        add.className = "ced-btn ced-btn--accent ced-btn--own";
        add.textContent = "Add a deep dive";
        add.addEventListener("click", function () { reshape(true); });
        ddPane.appendChild(add);
        return;
      }

      var tpl = r.el;
      var lead = tpl.content.querySelector(".dd-lead");
      var leadSub = tpl.content.querySelector(".dd-lead__sub");
      var body = ddSource(tpl);
      var mr = moreRegion();
      var f = {
        title: textRow(ddPane, "Title",
          lead ? lead.textContent : (tpl.getAttribute("data-title") || "")),
        sub: textRow(ddPane, "Subtitle",
          leadSub ? leadSub.textContent : (tpl.getAttribute("data-subtitle") || "")),
        label: textRow(ddPane, "The button that opens it",
          mr ? moreLabel(mr) : "Learn more")
      };

      /* the body, with the editor's own Markdown bar over it */
      var row = doc.createElement("label");
      row.className = "ced-field ced-field--md";
      var lab = doc.createElement("span");
      lab.className = "ced-field__label";
      lab.textContent = "Body, in Markdown";
      row.appendChild(lab);
      var bar = doc.createElement("div");
      bar.className = "ced-modal__tools ced-tools--own";
      row.appendChild(bar);
      var ta = doc.createElement("textarea");
      ta.rows = 9;
      ta.spellcheck = true;
      ta.value = body === null ? "" : body;
      row.appendChild(ta);
      ddPane.appendChild(row);
      mdToolbar(bar, ta, { surface: "deepdive" });
      specialsFlyout(bar, row, {
        rows: ddSpecials,
        foot: function () { return "Everything else in this deep dive is Markdown."; },
        hover: "The commands a deep dive can carry that Markdown does not know"
      });
      f.body = ta;

      if (body === null) {
        ddPane.appendChild(says("This deep dive was written before the form " +
          "existed, so there is nothing to open in the box above. Write it in " +
          "Markdown and Apply, and the drawer is written from what you typed. " +
          "Leave the box as it is and nothing about it is changed.",
          "ced-empty ced-empty--warn"));
      }

      var photos = doc.createElement("div");
      photos.className = "ced-field";
      var plab = doc.createElement("span");
      plab.className = "ced-field__label";
      plab.textContent = "Photographs";
      photos.appendChild(plab);
      ddPane.appendChild(photos);
      drawPhotos(photos, ddGallery(), "This deep dive has no photographs yet. " +
        "Write {gallery} where you want them, Apply, then add one here.");

      var gone = doc.createElement("button");
      gone.type = "button";
      gone.className = "ced-btn ced-btn--danger ced-btn--own";
      gone.textContent = "Remove deep dive";
      gone.addEventListener("click", function () { reshape(false); });
      ddPane.appendChild(gone);

      ddFields = f;
      ddFields.was = JSON.stringify(ddValues());
    }

    /* Adding a deep dive and removing one both change WHICH regions the
       card has, so both write the card again from the form's own values.
       Every other move on a card carries the bytes the file already had. */
    function reshape(want) {
      var raw = Object.keys(rows).filter(function (k) { return rows[k].raw; });
      if (raw.length) {
        note.textContent = "This card holds a field the form reads as HTML, so it " +
          "cannot be written again. Put that field back into its own shape first.";
        return;
      }
      if (!want) {
        var g0 = ddGallery();
        var n = g0 ? imageRegion.exportForm(imageRegion.displayed(g0), g0.kind).length : 0;
        if (!window.confirm("Remove the deep dive from this project?\n\nIt takes " +
            "its " + (n === 1 ? "1 photograph" : n + " photographs") + " and its " +
            "Learn more button with it.")) return;
      }
      var head = readAll();
      head.deepdive = want
        ? { title: head.title || id, subtitle: head.meta || "",
            label: "Learn more", body: "", photos: [] }
        : null;
      var g = gallery();
      var keep = g ? imageRegion.exportForm(imageRegion.displayed(g), g.kind) : [];
      var at = st.order.indexOf(id);
      var after = st.order[at + 1] || null;
      listRemove(st, id);
      listInsert(st, id, makeProject(head, id, keep), after);
      listChanged(st);
      done();
      projectForm(name, id, 2);
    }

    /* ---------------- the moves ---------------- */

    var btns = doc.createElement("div");
    btns.className = "ced-modal__btns";
    function btn(label, cls, fn) {
      var b = doc.createElement("button");
      b.type = "button";
      b.className = "ced-btn" + (cls ? " " + cls : "");
      b.textContent = label;
      b.addEventListener("click", fn);
      btns.appendChild(b);
      return b;
    }
    if (!making) btn("Remove project", "ced-btn--danger", removeIt);
    var sp = doc.createElement("span");
    sp.className = "ced-spacer";
    btns.appendChild(sp);
    if (!making) btn("Duplicate", "", duplicate);
    btn("Cancel", "", function () { done(); });
    btn("Apply", "ced-btn--accent", apply);

    var shut = false;
    function done() {
      if (shut) return;
      shut = true;
      dialogDown(done);
      scrimDown();
      if (box.parentNode) box.parentNode.removeChild(box);
    }
    xBtn.addEventListener("click", function () { done(); });

    /* every field's value, as the generator wants them */
    function readAll() {
      var head = {};
      Object.keys(rows).forEach(function (k) { head[k] = rows[k].read(); });
      return head;
    }
    function same(a, b) { return JSON.stringify(a) === b; }

    function apply() {
      var head = readAll();
      if (!head.title || !String(head.title).trim()) {
        note.textContent = "Give the project a title first.";
        if (rows.title) rows.title.valIn.focus();
        return;
      }
      if (making) {
        var newId = freshId(st, spec, head);
        if (!listInsert(st, newId, makeProject(head, newId, []), null)) {
          note.textContent = "This page could not take a new project.";
          return;
        }
        listChanged(st);
        done();
        return;
      }
      var wrote = 0;
      Object.keys(rows).forEach(function (k) {
        var row = rows[k];
        if (!row.slug) return;
        var now = row.read();
        if (row.raw ? now === row.was : same(now, row.was)) return;
        var r = regionBySlug(row.slug);
        if (!r) return;
        applyRegion(r, row.raw ? now : row.kind.write(now));
        wrote++;
      });
      wrote += applyDeep();
      refreshDirtyUI();
      requestReposition();
      armGuard();
      if (!ddHeld) done();
      if (!wrote) console.info("[site editor] nothing in that project had changed.");
    }

    /* The drawer is written from the Markdown, every time. The source is
       what was typed and the rendered half follows it, so the two can never
       drift; that is why the raw box refuses this region. */
    var ddHeld = false;
    function applyDeep() {
      ddHeld = false;
      if (!ddFields) return 0;
      var now = ddValues();
      if (JSON.stringify(now) === ddFields.was) return 0;
      var r = ddRegion();
      if (!r) return 0;
      var g = ddGallery();
      var photos = g ? imageRegion.exportForm(imageRegion.displayed(g), g.kind) : [];
      var built = ddBuild(now, id + "-dd-gallery", photos, ddIndent(r));
      applyRegion(r, built.html);
      var mr = moreRegion();
      if (mr) applyRegion(mr, moreWrite(mr, now.label || "Learn more"));
      if (built.spare) {
        note.textContent = "A deep dive has one carousel, so " + built.spare +
          " more {gallery} " + (built.spare === 1 ? "was" : "were") + " dropped.";
        ddHeld = true;          /* the box stays open, so the words are read */
        ddFields.was = JSON.stringify(now);
        drawDeep();
      }
      return 1;
    }

    function duplicate() {
      var head = readAll();
      head.title = (head.title || "untitled") + " copy";
      var newId = freshId(st, spec, head);
      var g = gallery();
      var entries = g ? imageRegion.exportForm(imageRegion.displayed(g), g.kind) : [];
      var at = st.order.indexOf(id);
      var after = st.order[at + 1] || null;
      if (!listInsert(st, newId, makeProject(head, newId, entries), after)) {
        note.textContent = "This page could not take another project.";
        return;
      }
      listChanged(st);
      done();
      projectForm(name, newId);
    }

    function removeIt() {
      var g = gallery();
      var n = g ? imageRegion.exportForm(imageRegion.displayed(g), g.kind).length : 0;
      var dd = regionBySlug(id + "-deepdive");
      if (!window.confirm("Remove the project \"" +
          ((rows.title && rows.title.valIn.value) || id) + "\"?\n\nIt takes its " +
          (n === 1 ? "1 photograph" : n + " photographs") +
          (dd ? " and its deep dive" : "") + " with it.\n\nRevert all puts it back " +
          "in the export; reload the page to see it again.")) return;
      listRemove(st, id);
      listChanged(st);
      done();
    }

    note.textContent = making
      ? "The number and the left-right side are written for you."
      : "A field you do not touch is not written.";

    box.appendChild(headEl);
    box.appendChild(xBtn);
    box.appendChild(tabs);
    box.appendChild(panes);
    box.appendChild(note);
    box.appendChild(btns);
    gripAdd(box);
    scrimUp();
    doc.body.appendChild(box);
    dialogUp(done);
    /* a view is drawn when it is opened, and the one opened with the box
       has had no click to draw it */
    if (!imgPane.hidden) drawImages();
    if (!ddPane.hidden) drawDeep();
    if (!startAt && rows.title) { rows.title.valIn.focus(); rows.title.valIn.select(); }
  }

  /* The home page's projects, as a list.

     slugFor names the region that proves an id is taken. Every card has a
     title, and so would "brand-title": an id may not collide with a slug
     that is not a project's either. */
  var PROJECT_LIST = {
    name: "projects",
    noun: "project",
    nameKey: "title",
    slugFor: function (pid) { return pid + "-title"; },
    make: makeProject,
    form: projectForm,
    anchor: function (el) { return el.querySelector(".project__body"); },
    after: function (where) { return where.querySelector(".project__index"); }
  };

  /* ------------------------------------------------------------
     LIST FURNITURE

     The model and the page a list is read from are in section 3. This is
     what a person sees of one: three controls on each block, one control
     under the list, and the form behind the first of them.

     What a block IS stays with the trunk that owns it. A trunk registers a
     descriptor and places the controls; this file draws them and knows what
     they do. That is what keeps a gallery out of this file.

       name      the list's [list:name]
       noun      the word the controls use: "section"
       nameKey   which field names the block
       fields    [{key, label, hint, start}], in order
       slugFor(id)          the region slug a block's markers carry
       make(head, id, entries)  the block's markup, markers included, at no
                                indent, which is also what the export writes
       countNote(region)    one line the form shows under the fields
     ------------------------------------------------------------ */
  var listKinds = {};

  /* The projects list is this file's own, for the reason given above
     PROJECT_FIELDS: a card is nine plain regions and one image region, and
     there is no trunk that owns one. A page with no [list:projects] markers
     has no list, so this draws nothing on the other two pages. */
  listKinds.projects = PROJECT_LIST;

  /* The marks the lists and the photo boxes use. One drawing each, inlined,
     taking currentColor so they stay black on a yellow pill. */
  var ICON = {
    left: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" ' +
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M19 12H5" /><path d="m12 19-7-7 7-7" /></svg>',
    right: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" ' +
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M5 12h14" /><path d="m12 5 7 7-7 7" /></svg>',
    pencil: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M12 20h9" /><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg>',
    up: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" ' +
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M12 19V5" /><path d="m5 12 7-7 7 7" /></svg>',
    down: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" ' +
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M12 5v14" /><path d="m19 12-7 7-7-7" /></svg>',
    plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" ' +
      'stroke-linecap="round" aria-hidden="true">' +
      '<path d="M12 5v14" /><path d="M5 12h14" /></svg>',
    trash: CED_TRASH
  };

  function pillBtn(label, icon, fn, iconOnly) {
    var b = doc.createElement("button");
    b.type = "button";
    b.className = "ced-pill" + (iconOnly ? " ced-pill--icon" : "");
    if (icon) b.innerHTML = icon;
    if (iconOnly) { b.setAttribute("aria-label", label); b.title = label; }
    else b.appendChild(doc.createTextNode(label));
    b.addEventListener("click", function (e) {
      e.preventDefault(); e.stopPropagation(); fn();
    });
    return b;
  }

  /* The image region a block's own markers carry. */
  function galBySlug(slug) {
    for (var i = 0; i < gals.length; i++) if (gals[i].slug === slug) return gals[i];
    return null;
  }

  /* The three controls a block carries: open it, and move it. The trunk
     decides where they sit; this decides what they do. */
  function listPills(name, id) {
    var st = lists[name], spec = listKinds[name];
    if (!st || !spec || !active) return null;
    var wrap = doc.createElement("span");
    wrap.className = "ced-pills";
    wrap.setAttribute("data-ced-list", name);
    wrap.setAttribute("data-ced-item", id);
    /* the pill names the thing it opens, so it is a title; the buttons that
       act on one are sentences, so they keep the noun as it is written */
    wrap.appendChild(pillBtn(spec.noun.charAt(0).toUpperCase() + spec.noun.slice(1),
      ICON.pencil, function () { listForm(name, id); }));
    wrap.appendChild(pillBtn("Move up", ICON.up, function () { listStep(name, id, -1); }, true));
    wrap.appendChild(pillBtn("Move down", ICON.down, function () { listStep(name, id, 1); }, true));
    listEnds(wrap, st, id);
    return wrap;
  }
  /* A block at an end of the list has nowhere to go in that direction. */
  function listEnds(wrap, st, id) {
    var at = st.order.indexOf(id), last = st.order.length - 1;
    var arrows = wrap.querySelectorAll(".ced-pill--icon");
    if (arrows[0]) arrows[0].disabled = at <= 0;
    if (arrows[1]) arrows[1].disabled = at < 0 || at >= last;
  }
  function refreshPills(name) {
    var st = lists[name];
    if (!st) return;
    Array.prototype.forEach.call(
      doc.querySelectorAll('[data-ced-list="' + name + '"]'), function (wrap) {
        listEnds(wrap, st, wrap.getAttribute("data-ced-item"));
      });
  }

  /* The one control that is not on a block. It goes after the list's own
     close marker: outside every item, and inside no region, so nothing it
     is can reach a file. */
  function listFoot(st) {
    var spec = listKinds[st.name];
    if (st.footEl && st.footEl.parentNode) st.footEl.parentNode.removeChild(st.footEl);
    st.footEl = null;
    if (!spec || !active || !st.close || !st.close.parentNode) return;
    var wrap = doc.createElement("div");
    wrap.className = "ced-listfoot";
    wrap.appendChild(pillBtn("New " + spec.noun, ICON.plus, function () {
      listForm(st.name, null);
    }));
    st.close.parentNode.insertBefore(wrap, st.close.nextSibling);
    st.footEl = wrap;
  }

  function listStep(name, id, by) {
    var st = lists[name];
    if (!st || !listMove(st, id, by)) return;
    listChanged(st);
  }
  function listChanged(st) {
    exportedClean = false;
    pendingSyncList(st);
    refreshDirtyUI();
    /* a block that arrived or left takes its regions with it, so the panel's
       list of them is rebuilt rather than left describing the page before */
    refreshRegionRows();
    refreshImageRows();
    /* a block that arrived brought regions with it, and they have no badge
       until something draws one */
    regions.forEach(chipFor);
    gals.forEach(galChipsFor);
    /* a block that arrived needs its controls, and one that moved needs
       its two arrows to say so */
    listItemPills(st);
    refreshPills(st.name);
    requestReposition();
    armGuard();
  }

  /* An id from the block's name: its initials, lower case, and a number
     when that is taken. Permanent from then on, so a rename never moves it.
     That is the rule a post id already follows. */
  function freshId(st, spec, head) {
    var words = String(head[spec.nameKey] || "").toLowerCase().match(/[a-z0-9]+/g) || [];
    var base = words.map(function (w) { return w.charAt(0); }).join("").slice(0, 4);
    if (!base || /^[0-9]/.test(base)) base = "s" + base;
    var id = base, n = 1;
    while (idTaken(st, spec, id)) { n++; id = base + n; }
    return id;
  }
  function idTaken(st, spec, id) {
    if (st.order.indexOf(id) !== -1) return true;
    var slug = spec.slugFor(id);
    return regions.some(function (r) { return r.slug === slug; }) ||
           gals.some(function (g) { return g.slug === slug; });
  }

  /* The first element inside one item: the block itself. */
  function itemElement(st, id) {
    var nodes = itemNodes(st, id);
    for (var i = 0; i < nodes.length; i++) if (nodes[i].nodeType === 1) return nodes[i];
    return null;
  }

  /* Put the controls on every block of a list that does not draw its own.

     A trunk that redraws its blocks places them itself, because a redraw
     would throw them away. A list of plain regions has no redraw, so the
     editor puts them on when it turns on and takes them off when it does
     not: listPills answers with nothing while the editor is off. */
  function listItemPills(st) {
    var spec = listKinds[st.name];
    if (!spec || !spec.anchor) return;
    st.order.forEach(function (id) {
      var el = itemElement(st, id);
      var where = el && spec.anchor(el);
      if (!where) return;
      var was = where.querySelector(".ced-pills");
      if (was && was.parentNode === where) where.removeChild(was);
      var pills = listPills(st.name, id);
      if (!pills) return;
      var after = spec.after && spec.after(where);
      if (after && after.parentNode === where) where.insertBefore(pills, after.nextSibling);
      else where.insertBefore(pills, where.firstChild);
    });
  }

  /* What a block holds beyond what is inside it. New opens the same form
     with nothing in it, so there is one place a block is named.

     A list whose blocks are more than a few words brings a form of its own
     and says so; this is the plain one. */
  function listForm(name, id, startAt) {
    var st = lists[name], spec = listKinds[name];
    if (!st || !spec) return;
    if (spec.form) { spec.form(name, id, startAt); return; }
    var making = !id;
    var r = making ? null : galBySlug(spec.slugFor(id));
    if (!making && !r) return;
    injectStyles();

    var box = doc.createElement("div");
    box.className = "ced-modal ced-modal--flow ced-listform";
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-modal", "true");

    var headEl = doc.createElement("div");
    headEl.className = "ced-modal__head";
    var tag = doc.createElement("span");
    tag.className = "ced-b ced-b--y";
    tag.textContent = spec.noun.toUpperCase();
    var who = doc.createElement("span");
    who.className = "ced-slug";
    who.textContent = making ? "New " + spec.noun
      : ((r.head && r.head[spec.nameKey]) || "untitled");
    headEl.appendChild(tag);
    headEl.appendChild(who);

    var xBtn = doc.createElement("button");
    xBtn.type = "button";
    xBtn.className = "ced-modal__x";
    xBtn.setAttribute("aria-label", "Close");
    xBtn.title = "Close";
    xBtn.innerHTML = CED_X;

    var body = doc.createElement("div");
    body.className = "ced-listform__body";
    var inputs = {};
    spec.fields.forEach(function (f) {
      var row = doc.createElement("label");
      row.className = "ced-field";
      var lab = doc.createElement("span");
      lab.className = "ced-field__label";
      lab.textContent = f.label;
      var inp = doc.createElement("input");
      inp.type = "text";
      inp.spellcheck = false;
      inp.value = making ? (f.start || "") : ((r.head && r.head[f.key]) || "");
      if (f.hint) inp.placeholder = f.hint;
      inputs[f.key] = inp;
      row.appendChild(lab);
      row.appendChild(inp);
      body.appendChild(row);
    });

    var note = doc.createElement("div");
    note.className = "ced-modal__status";
    note.textContent = making
      ? "The number and the image count are written for you."
      : (spec.countNote ? spec.countNote(r) : "");

    var btns = doc.createElement("div");
    btns.className = "ced-modal__btns";
    function btn(label, cls, fn) {
      var b = doc.createElement("button");
      b.type = "button";
      b.className = "ced-btn" + (cls ? " " + cls : "");
      b.textContent = label;
      b.addEventListener("click", fn);
      btns.appendChild(b);
      return b;
    }
    if (!making) btn("Delete " + spec.noun, "ced-btn--danger", removeIt);
    var sp = doc.createElement("span");
    sp.className = "ced-spacer";
    btns.appendChild(sp);
    if (!making) btn("Duplicate", "", duplicate);
    btn("Cancel", "", function () { done(); });
    btn("Apply", "ced-btn--accent", apply);

    var shut = false;
    function done() {
      if (shut) return;
      shut = true;
      dialogDown(done);
      scrimDown();
      if (box.parentNode) box.parentNode.removeChild(box);
    }
    xBtn.addEventListener("click", function () { done(); });

    function readForm() {
      var out = {};
      spec.fields.forEach(function (f) { out[f.key] = inputs[f.key].value.trim(); });
      return out;
    }
    function shown(region) {
      var list = region.model.length ? region.model : region.seeds;
      return list.filter(function (e) { return !e.empty; });
    }

    function apply() {
      var next = readForm();
      if (!next[spec.nameKey]) {
        note.textContent = "Give this " + spec.noun + " a name first.";
        inputs[spec.nameKey].focus();
        return;
      }
      if (making) {
        var newId = freshId(st, spec, next);
        if (!listInsert(st, newId, spec.make(next, newId, []), null)) {
          note.textContent = "This page could not take a new " + spec.noun + ".";
          return;
        }
        listChanged(st);
        done();
        return;
      }
      r.head = next;
      renderGallery(r);
      AMH.tool.changed(r);
      armGuard();
      done();
    }

    function duplicate() {
      var next = readForm();
      next[spec.nameKey] = (next[spec.nameKey] || "untitled") + " copy";
      var newId = freshId(st, spec, next);
      var entries = imageRegion.exportForm(shown(r), r.kind);
      var at = st.order.indexOf(id);
      var after = st.order[at + 1] || null;
      if (!listInsert(st, newId, spec.make(next, newId, entries), after)) {
        note.textContent = "This page could not take another " + spec.noun + ".";
        return;
      }
      listChanged(st);
      done();
      listForm(name, newId);
    }

    function removeIt() {
      var n = shown(r).length;
      if (!window.confirm("Delete the " + spec.noun + ' "' +
          ((r.head && r.head[spec.nameKey]) || "untitled") + '"?\n\nIt takes its ' +
          (n === 1 ? "1 image" : n + " images") + " with it.\n\nRevert all puts " +
          "it back in the export; reload the page to see it again.")) return;
      listRemove(st, id);
      listChanged(st);
      done();
    }

    box.appendChild(headEl);
    box.appendChild(xBtn);
    box.appendChild(body);
    box.appendChild(note);
    box.appendChild(btns);
    gripAdd(box);
    scrimUp();
    doc.body.appendChild(box);
    dialogUp(done);
    inputs[spec.nameKey].focus();
    inputs[spec.nameKey].select();
  }


  /* ---------------- the edit launcher ----------------

     A quiet mark in a corner. It rests almost invisible, and opens on hover
     or on focus to draw the word EDIT, which is what a click does.

     Built here rather than authored into a page. It belongs on every page
     this file is on, it does nothing without script, and markup would put it
     into the marker inventory and into the chrome the three pages hold
     byte-identical. Nothing built at runtime can reach an export.

     Which corner is one value. site.css positions all four from the data
     attribute, so moving it is a one-word change here and no CSS edit. */
  var LAUNCH_CORNER = "bottom-left";   /* or bottom-right, top-left, top-right */

  /* The corner, as one SVG.

     Paint order is the whole trick. SVG draws in document order, so the flap
     is last and covers everything under it; the word is drawn before it and
     is therefore revealed by the curl rather than floating over it. There is
     no z-index in here at all.

     The free edge of the flap is a curve, not a crease, which is what makes
     it read as paper that has rolled back instead of a folded triangle.

     Both words share the same anchor, so the corner does not move when the
     editor is switched on and the label changes. */
  function peelSVG() {
    return '<svg class="amh-edit__art" viewBox="0 0 150 150" aria-hidden="true" ' +
      'focusable="false" preserveAspectRatio="none">' +
      "<defs>" +
        /* The word is clipped to the hole, so it is drawn only where the
           page has peeled away. The clip path carries the same
           transform as the paper, so the two grow together and cannot fall
           out of step - which is what a second, timed fade could do. */
        '<clipPath id="amhPeel" clipPathUnits="userSpaceOnUse">' +
          '<path class="amh-edit__paper" d="M0 150 L0 9 Q62 51 141 150 Z" />' +
        "</clipPath>" +
        '<linearGradient id="amhHole" x1="0" y1="1" x2="1" y2="0">' +
          '<stop offset="0" stop-color="#0e131a" /><stop offset="1" stop-color="#05070a" />' +
        "</linearGradient>" +
        '<linearGradient id="amhFlap" x1="0" y1="1" x2="1" y2="0">' +
          '<stop offset="0" stop-color="#39414d" />' +
          '<stop offset="0.55" stop-color="#1f242d" />' +
          '<stop offset="1" stop-color="#10141a" />' +
        "</linearGradient>" +
      "</defs>" +
      /* 1. the page under the corner */
      '<path class="amh-edit__paper amh-edit__hole" d="M0 150 L0 9 Q62 51 141 150 Z" />' +
      /* 2. the word, under the flap */
      /* anchored at the middle so the rotation is symmetric and the word
         cannot run off the corner, and turned to follow the fold, which
         runs down and to the right */
      '<g clip-path="url(#amhPeel)">' +
        '<text class="amh-edit__word amh-edit__word--edit" x="52" y="103" ' +
          'text-anchor="middle" transform="rotate(45 52 103)">EDIT</text>' +
        '<text class="amh-edit__word amh-edit__word--exit" x="52" y="103" ' +
          'text-anchor="middle" transform="rotate(45 52 103)">EXIT</text>' +
      "</g>" +
      /* 3. the flap, over both */
      '<path class="amh-edit__paper amh-edit__flap" d="M0 9 Q88 35 141 150 Q39 85 0 9 Z" />' +
      "</svg>";
  }

  var launcher = null;

  function buildLauncher() {
    if (launcher || !doc.body) return;
    launcher = doc.createElement("button");
    launcher.type = "button";
    launcher.className = "amh-edit";
    launcher.setAttribute("data-corner", LAUNCH_CORNER);
    launcher.innerHTML = peelSVG();
    launcher.addEventListener("click", function () { api(); });
    doc.body.appendChild(launcher);
    syncLauncher();
  }

  /* Say what the button does now, not what it is called. The editor can also
     be toggled from the console, so this runs from api() rather than from the
     click, and the two ways in can never disagree. */
  function syncLauncher() {
    if (!launcher) return;
    launcher.classList.toggle("is-on", active);
    launcher.setAttribute("aria-pressed", active ? "true" : "false");
    launcher.setAttribute("aria-label",
      active ? "Close the site editor" : "Open the site editor");
  }

  function teardownUI() {
    pendingChip = null;
    buildRow = null;
    publishLine = null;
    closeModal();
    if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
    if (panel && panel.parentNode) panel.parentNode.removeChild(panel);
    window.removeEventListener("resize", requestReposition);
    window.removeEventListener("scroll", requestFloor);
    regions.forEach(function (r) { r.chip = null; r.row = null; });
    /* a caption half typed when the editor closes is put back, not saved */
    if (capEditing) capEditing(false);
    gals.forEach(function (g) {
      if (g.observer) { g.observer.disconnect(); g.observer = null; }
      g.chip = null; g.plusChip = null; g.trashChip = null;
      captionPencil(g);          /* the editor is off, so this takes the pencil away */
    });
    overlay = panel = panelList = viewBtn = regRowsEl = imgRowsEl = null;
    redrawSelfDrawn();
  }

  /* ---------------- modal ---------------- */
  /* The toolbar writes into whichever editor surface is open. The region
     modal's textarea is this file's own. Another trunk that puts a writing
     surface on screen registers it through AMH.tool.editSurface, so this file
     does not have to know what that surface is or where it lives. */
  var altSurface = null;
  function curTA() {
    var alt = altSurface && altSurface();
    return alt || ta;
  }
  /* Both take the surface to write into, and fall back to whichever one is
     open. A toolbar built for one textarea names it and never has to ask. */
  function wrapSelection(before, after, into) {
    var t = into || curTA();
    var s = t.selectionStart, e = t.selectionEnd, v = t.value;
    t.value = v.slice(0, s) + before + v.slice(s, e) + after + v.slice(e);
    t.focus();
    if (s === e) { t.selectionStart = t.selectionEnd = s + before.length; }
    else { t.selectionStart = s; t.selectionEnd = e + before.length + after.length; }
  }
  function insertAtCursor(txt, into) {
    var t = into || curTA();
    var s = t.selectionStart, v = t.value;
    t.value = v.slice(0, s) + txt + v.slice(t.selectionEnd);
    t.focus();
    t.selectionStart = t.selectionEnd = s + txt.length;
  }

  var TOOLS = [
    ["B", "bold (<strong>)", function () { wrapSelection("<strong>", "</strong>"); }],
    ["I", "italic (<em>)", function () { wrapSelection("<em>", "</em>"); }],
    ["Link", "link (<a class=\"textlink\">)", function () {
      var url = window.prompt("Link URL:", "https://");
      if (url) wrapSelection('<a class="textlink" href="' + url + '" target="_blank" rel="noopener">', "</a>");
    }],
    ["BR", "line break", function () { insertAtCursor("<br />"); }],
    ["x²", "superscript", function () { wrapSelection("<sup>", "</sup>"); }],
    ["x₂", "subscript", function () { wrapSelection("<sub>", "</sub>"); }],
    ["xs", "size: extra small", function () { wrapSelection('<span class="text-xs">', "</span>"); }],
    ["sm", "size: small", function () { wrapSelection('<span class="text-sm">', "</span>"); }],
    ["lg", "size: large", function () { wrapSelection('<span class="text-lg">', "</span>"); }],
    ["xl", "size: extra large", function () { wrapSelection('<span class="text-xl">', "</span>"); }]
  ];

  /* ------------------------------------------------------------
     THE MARKDOWN TOOLBAR

     The HTML list above writes tags into whichever surface is open, which
     suits the region editor: its surfaces hold HTML. This one writes
     Markdown into a surface it is handed, because more than one surface
     wants it and they are not open at the same time.

     Every tool takes its textarea as an argument. Nothing here asks which
     surface is open, which is the whole difference from the list above.

     The flags are the renderer's, read from AMH.markdown.flags. A flag
     added there appears on the toolbar and in the help panel without being
     copied, and a surface is offered only the flags that name it.
     ------------------------------------------------------------ */

  /* The marks, drawn once into the page and used by reference: a <use>
     costs no request, and currentColor keeps every stroke the colour of the
     button's own text. The letters are paths rather than text so they are
     one shape on every platform's font stack. */
  var MD_SPRITE = '<svg xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
    '<symbol id="ced-i-h" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="2.2" stroke-linecap="round">' +
      '<path d="M5 5v14"/><path d="M15 5v14"/><path d="M5 12h10"/>' +
      '<path d="M18.2 8.4a1.8 1.8 0 0 1 3 1.3c0 1.6-3 2.4-3 4.3h3"/></symbol>' +
    '<symbol id="ced-i-bullet" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="2" stroke-linecap="round">' +
      '<path d="M4.5 6h.01"/><path d="M4.5 12h.01"/><path d="M4.5 18h.01"/>' +
      '<path d="M9 6h11"/><path d="M9 12h11"/><path d="M9 18h11"/></symbol>' +
    '<symbol id="ced-i-number" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M9 6h11"/><path d="M9 12h11"/><path d="M9 18h11"/>' +
      '<path d="M3.2 5.2 4.6 4.4V8"/><path d="M3.2 15.4a1.3 1.3 0 0 1 2.3.8c0 1-2.3 1.6-2.3 2.8h2.4"/>' +
      '</symbol>' +
    '<symbol id="ced-i-bold" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M7 5h5.5a3.5 3.5 0 0 1 0 7H7z"/><path d="M7 12h6.5a3.5 3.5 0 0 1 0 7H7z"/></symbol>' +
    '<symbol id="ced-i-italic" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="2.2" stroke-linecap="round">' +
      '<path d="M15 5h-5"/><path d="M14 19H9"/><path d="M14.5 5 9.5 19"/></symbol>' +
    '<symbol id="ced-i-strike" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="2.1" stroke-linecap="round">' +
      '<path d="M16.5 7.2A3.8 3.8 0 0 0 13 5h-1.6a2.9 2.9 0 0 0-1.2 5.6"/>' +
      '<path d="M7.5 16.8A3.8 3.8 0 0 0 11 19h1.6a2.9 2.9 0 0 0 1.4-5.4"/>' +
      '<path d="M4 12h16"/></symbol>' +
    '<symbol id="ced-i-link" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M10.5 13.5a4.5 4.5 0 0 0 6.8.5l2.2-2.2a4.5 4.5 0 0 0-6.4-6.4l-1.3 1.3"/>' +
      '<path d="M13.5 10.5a4.5 4.5 0 0 0-6.8-.5l-2.2 2.2a4.5 4.5 0 0 0 6.4 6.4l1.3-1.3"/>' +
      '</symbol>' +
    '<symbol id="ced-i-table" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M3.5 5h17v14h-17z"/><path d="M3.5 10h17"/><path d="M12 10v9"/></symbol>' +
    '<symbol id="ced-i-expand" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M4 6h16"/><path d="M4 18h16"/><path d="M8.5 10.5 12 14l3.5-3.5"/></symbol>' +
    '<symbol id="ced-i-break" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M7 3h10v5"/><path d="M7 21h10v-5"/>' +
      '<path d="M3 12h3"/><path d="M9.5 12h2.5"/><path d="M15.5 12h2.5"/><path d="M21 12h0"/>' +
      '</symbol>' +
    '<symbol id="ced-i-clear" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M7.5 20.5 3 16a1.6 1.6 0 0 1 0-2.3L13.7 3a1.6 1.6 0 0 1 2.3 0l5 5a1.6 1.6 0 0 1 0 2.3L11.5 20.5z"/>' +
      '<path d="M21.5 20.5H8"/><path d="M8.5 8.5 16 16"/></symbol>' +
    '<symbol id="ced-i-flag" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M5 21V4"/><path d="M5 4h13l-3 4 3 4H5"/></symbol>' +
    '<symbol id="ced-i-photos" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
      '<rect x="3" y="6" width="14" height="12" rx="1.6"/>' +
      '<path d="m5.5 15 3.2-3.4 2.4 2.5 2.3-2.4 2.6 2.8"/>' +
      '<path d="M20 8.5v9"/></symbol>' +
    '<symbol id="ced-i-note" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M4 6h16"/><path d="M4 10h16"/><path d="M4 14h10"/>' +
      '<path d="M15.5 20.5 14 21l.5-1.5 5-5 1 1z"/></symbol>' +
    '<symbol id="ced-i-info" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="2" stroke-linecap="round">' +
      '<circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 7.5v.1"/></symbol>' +
    "</svg>";

  /* One flag's mark, by the name the renderer gave it. A flag with no
     drawing of its own gets the generic one rather than nothing. */
  var MD_FLAG_ICON = { expandformore: "expand", pagebreak: "break",
                       gallery: "photos", note: "note" };

  var mdSpriteEl = null;
  function mdSprite() {
    if (mdSpriteEl && mdSpriteEl.isConnected) return;
    mdSpriteEl = doc.createElement("div");
    mdSpriteEl.className = "ced-sprite";
    mdSpriteEl.setAttribute("aria-hidden", "true");
    mdSpriteEl.innerHTML = MD_SPRITE;
    doc.body.appendChild(mdSpriteEl);
  }
  function mdIcon(name) {
    return '<svg class="ced-tool__i" aria-hidden="true"><use href="#ced-i-' +
      name + '" /></svg>';
  }

  /* ---------------- what the tools do ---------------- */

  /* The current line's bounds in a surface. */
  function mdLineAt(t) {
    var v = t.value, s = t.selectionStart;
    var a = v.lastIndexOf("\n", s - 1) + 1;
    var b = v.indexOf("\n", s);
    if (b === -1) b = v.length;
    return { a: a, b: b, text: v.slice(a, b) };
  }
  function mdSetLine(t, line, text) {
    var v = t.value;
    t.value = v.slice(0, line.a) + text + v.slice(line.b);
    t.focus();
    t.selectionStart = t.selectionEnd = line.a + text.length;
  }
  /* H2 to H4 as a cycle, then back to plain text. */
  function mdHeadingCycle(t) {
    var line = mdLineAt(t);
    var m = /^(#{1,3}) (.*)$/.exec(line.text);
    var rest = m ? m[2] : line.text;
    var hashes = !m ? "#" : m[1].length < 3 ? m[1] + "#" : "";
    mdSetLine(t, line, hashes ? hashes + " " + rest : rest);
  }
  /* "- " or "1. " on the line, off again when it is there. */
  function mdListToggle(t, marker) {
    var line = mdLineAt(t);
    var m = /^( *)(?:[-*]|\d+\.) (.*)$/.exec(line.text);
    if (m) {
      var has = /^ *[-*] /.test(line.text) ? "- " : "1. ";
      mdSetLine(t, line, has === marker ? m[1] + m[2] : m[1] + marker + m[2]);
    } else {
      mdSetLine(t, line, marker + line.text);
    }
  }
  /* A flag stands alone on its own line, or it is text. */
  function mdInsertFlag(t, flag) {
    var v = t.value, s = t.selectionStart;
    var before = s === 0 || v.charAt(s - 1) === "\n" ? "" : "\n";
    var after = s >= v.length || v.charAt(s) === "\n" ? "" : "\n";
    insertAtCursor(before + flag + after, t);
  }
  function mdInsertTable(t) {
    var v = t.value, s = t.selectionStart;
    var before = s === 0 || v.charAt(s - 1) === "\n" ? "" : "\n";
    insertAtCursor(before + "| Column | Column |\n| --- | --- |\n| cell | cell |\n", t);
  }
  /* The marks of the set, removed from the selection: bold, italic,
     strikethrough, code, a link to its text, a heading or list prefix. */
  function mdClearMarks(t) {
    var s = t.selectionStart, e = t.selectionEnd, v = t.value;
    if (s === e) { var line = mdLineAt(t); s = line.a; e = line.b; }
    var out = v.slice(s, e)
      .replace(/\*\*([^*]+)\*\*/g, "$1").replace(/~~([^~]+)~~/g, "$1")
      .replace(/\*([^*\n]+)\*/g, "$1").replace(/(^|[^\w])_([^_\n]+)_(?=[^\w]|$)/g, "$1$2")
      .replace(/`([^`\n]+)`/g, "$1")
      .replace(/\[([^\]\n]+)\]\((?:[^()\s]|\([^()\s]*\))+\)/g, "$1")
      .replace(/^ *(?:#{1,3} |[-*] |\d+\. )/gm, "");
    t.value = v.slice(0, s) + out + v.slice(e);
    t.focus();
    t.selectionStart = s;
    t.selectionEnd = s + out.length;
  }

  /* The nine that every surface gets, in the order they are drawn. Each is
     a name for a reader, a mark, a sentence for the hover, and what it does
     to a surface. A surface's own flags are put in among them below. */
  var MD_TOOLS = [
    ["Heading", "h", "heading: H2, H3, H4, then plain", mdHeadingCycle],
    ["Bullet list", "bullet", "bullet list", function (t) { mdListToggle(t, "- "); }],
    ["Numbered list", "number", "numbered list", function (t) { mdListToggle(t, "1. "); }],
    ["Bold", "bold", "bold", function (t) { wrapSelection("**", "**", t); }],
    ["Italic", "italic", "italic", function (t) { wrapSelection("*", "*", t); }],
    ["Strikethrough", "strike", "strikethrough", function (t) { wrapSelection("~~", "~~", t); }],
    ["Link", "link", "link", function (t) {
      var url = window.prompt("Link URL:", "https://");
      if (url) wrapSelection("[", "](" + url + ")", t);
    }],
    ["Table", "table", "table: a two by two skeleton", mdInsertTable],
    ["Clear", "clear", "clear formatting in the selection", mdClearMarks]
  ];
  /* Where the flags go: after the table and before Clear, which is the
     order the composer drew them in. */
  var MD_FLAGS_AT = 8;

  /* One button. The mark is what is seen; the name is what is heard and is
     kept out of sight, because eleven words across a toolbar is a wall. */
  function mdButton(label, icon, hover, fn, tabbable) {
    var b = doc.createElement("button");
    b.type = "button";
    b.className = "ced-tool ced-tool--icon";
    b.title = hover;
    if (tabbable === false) b.tabIndex = -1;
    b.innerHTML = mdIcon(icon) + '<span class="ced-sr"></span>';
    b.querySelector(".ced-sr").textContent = label;
    b.addEventListener("click", fn);
    return b;
  }

  /* Build the bar into host, writing into ta.

       opts.surface   which flags are offered: "post", "deepdive"
       opts.tabbable  false keeps the buttons out of the tab ring
       opts.onChange  called after every press

     Returns host, so a caller that built its own row keeps it. */
  function mdToolbar(host, ta, opts) {
    var o = opts || {};
    mdSprite();
    injectStyles();
    var after = function () { if (o.onChange) o.onChange(); };
    function add(label, icon, hover, fn) {
      host.appendChild(mdButton(label, icon, hover, function () {
        fn(ta);
        after();
      }, o.tabbable));
    }
    MD_TOOLS.forEach(function (t, i) {
      if (i === MD_FLAGS_AT) mdFlagTools(host, ta, o, add);
      add(t[0], t[1], t[2], t[3]);
    });
    return host;
  }
  /* The flags this surface is offered, in the renderer's own order. The
     word and the sentence are its too, so a hover and a help panel can
     never disagree with what the renderer accepts. */
  function mdFlagTools(host, ta, o, add) {
    var flags = (AMH.markdown && AMH.markdown.flags) || [];
    flags.forEach(function (f) {
      var wants = f.for || ["post"];
      if (wants.indexOf(o.surface || "post") === -1) return;
      var word = "{" + f.name + "}";
      add(f.label || f.name, MD_FLAG_ICON[f.name] || "flag", word + " - " + f.does,
        function (t) { mdInsertFlag(t, word); });
    });
  }

  /* ---------------- the special commands, behind an (i) ----------------

     A toolbar carries what fits on a button. The rest - a command with an
     argument, a rule about a line, the escape that writes one as text -
     needs a sentence each, so they live behind one control.

     A flyout and not a box: a second box over a surface is the thing this
     editor has spent its design removing, and a title cannot hold four
     commands with their syntax. It is anchored to the row it belongs to,
     closes on Escape or a press outside, and needs no new layer.

       row    the toolbar the (i) is added to
       host   the element the panel hangs inside; the row is inside it too
       opts.rows()   the rows, each {write, where, does}
       opts.foot()   one closing sentence, or nothing
       opts.label    the panel's name, default "Special commands"
       opts.tabbable false keeps the (i) out of the tab ring

     Returns { btn, panel, open, isOpen, destroy }. */
  function specialsFlyout(row, host, opts) {
    var o = opts || {};
    var label = o.label || "Special commands";
    mdSprite();
    injectStyles();

    var sep = doc.createElement("span");
    sep.className = "ced-tool__sep";
    sep.setAttribute("aria-hidden", "true");
    row.appendChild(sep);

    var btn = doc.createElement("button");
    btn.type = "button";
    btn.className = "ced-tool ced-spec__btn";
    if (o.tabbable === false) btn.tabIndex = -1;
    btn.setAttribute("aria-expanded", "false");
    btn.title = o.hover || "The commands this surface can carry that Markdown does not know";
    btn.innerHTML = mdIcon("info") + "<span>" + label + "</span>";

    var panel = doc.createElement("div");
    panel.className = "ced-spec";
    panel.hidden = true;
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", label);

    function isOpen() { return !panel.hidden; }
    function fill() {
      var rows = (o.rows ? o.rows() : []).map(function (s) {
        /* two cells of one grid, not a row that lays itself out: the widest
           command sizes the first column and every description then starts
           in the same place, which a per-row flex cannot do. */
        return '<code class="ced-spec__write">' + escAttr(s.write) + "</code>" +
          '<div class="ced-spec__of"><span class="ced-spec__where">' +
          escAttr(s.where) + "</span>" +
          '<span class="ced-spec__does">' + escAttr(s.does) + "</span></div>";
      }).join("");
      var foot = o.foot ? o.foot() : "";
      panel.innerHTML =
        '<div class="ced-spec__head">' + escAttr(label) + "</div>" +
        '<div class="ced-spec__list">' + rows + "</div>" +
        (foot ? '<p class="ced-spec__foot">' + escAttr(foot) + "</p>" : "");
    }
    function open(want) {
      if (want) {
        fill();
        /* The row wraps to two lines on a phone, so a fixed offset would
           lay the panel over its second line. It hangs from where the row
           ends, measured inside the panel's own container. */
        panel.style.top = (row.offsetTop + row.offsetHeight + 4) + "px";
      }
      panel.hidden = !want;
      btn.setAttribute("aria-expanded", want ? "true" : "false");
      btn.classList.toggle("on", !!want);
    }
    btn.addEventListener("click", function () { open(!isOpen()); });

    function onKey(e) {
      if (e.key !== "Escape" || !isOpen()) return;
      /* it is in front of the surface, so it answers the key first */
      e.preventDefault();
      e.stopPropagation();
      open(false);
      btn.focus();
    }
    function onAway(e) {
      if (!isOpen()) return;
      if (panel.contains(e.target) || btn.contains(e.target)) return;
      open(false);
    }
    doc.addEventListener("keydown", onKey, true);
    doc.addEventListener("pointerdown", onAway, true);

    row.appendChild(btn);
    host.appendChild(panel);
    return {
      btn: btn, panel: panel, open: open, isOpen: isOpen,
      destroy: function () {
        doc.removeEventListener("keydown", onKey, true);
        doc.removeEventListener("pointerdown", onAway, true);
      }
    };
  }

  function status(msg) { if (modalStatus) modalStatus.textContent = msg || ""; }

  function buildModal() {
    scrim = doc.createElement("div");
    scrim.className = "ced-scrim";
    modal = doc.createElement("div");
    /* --region says this is the one box that is built once and reused,
       so the rules that hide a control it is not using apply to it and to
       nothing else. */
    modal.className = "ced-modal ced-modal--region";
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");

    modalTitle = doc.createElement("div");
    modalTitle.className = "ced-modal__head";
    modal.appendChild(modalTitle);

    /* (X) close — top-right, on the modal (not the header, which is re-rendered
       each open). Guarded: prompts only when the textarea has unapplied changes. */
    var xBtn = doc.createElement("button");
    xBtn.type = "button";
    xBtn.className = "ced-modal__x";
    xBtn.setAttribute("aria-label", "Close editor");
    xBtn.title = "Close";
    xBtn.innerHTML = CED_X;
    xBtn.addEventListener("click", requestClose);
    modal.appendChild(xBtn);

    var tools = doc.createElement("div");
    tools.className = "ced-modal__tools";
    TOOLS.forEach(function (t) {
      var b = doc.createElement("button");
      b.type = "button"; b.className = "ced-tool";
      /* out of the tab order. Twelve stops between the text and the buttons
         that apply it is a long walk for a shortcut, and the surface here is
         raw HTML: a keyboard user can type the tag. The mouse is unaffected. */
      b.tabIndex = -1;
      b.textContent = t[0]; b.title = t[1];
      b.addEventListener("click", t[2]);
      tools.appendChild(b);
    });
    modal.appendChild(tools);

    ta = doc.createElement("textarea");
    ta.spellcheck = false;
    modal.appendChild(ta);

    modalStatus = doc.createElement("div");
    modalStatus.className = "ced-modal__status";
    modal.appendChild(modalStatus);

    var btns = doc.createElement("div");
    btns.className = "ced-modal__btns";
    function btn(label, cls, fn) {
      var b = doc.createElement("button");
      b.type = "button"; b.className = "ced-btn" + (cls ? " " + cls : "");
      b.textContent = label;
      b.addEventListener("click", fn);
      btns.appendChild(b);
      return b;
    }
    btn("Quicksave", "", quicksave);
    btn("Restore", "", restore);
    var sp = doc.createElement("span"); sp.className = "ced-spacer"; btns.appendChild(sp);
    btn("Apply", "ced-btn--accent", applyModal);
    btn("Revert", "", revertModal);
    btn("Cancel", "", closeModal);
    modal.appendChild(btns);
    gripAdd(modal);

    doc.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && openRegion) { e.preventDefault(); closeModal(); }
    });
  }

  function openModal(r) {
    if (viewing === "before") api.after();   /* never edit on top of the before view */
    if (!modal) buildModal();
    /* a dragged height is forgotten. This box is kept and reused, so it is
       the one that has to be told; the other four are built again. */
    gripReset(modal);
    ta.disabled = false;
    openRegion = r;
    modalTitle.innerHTML = '<span class="ced-b">' + r.badge + '</span>' +
      '<span class="ced-slug">' + r.slug + "</span>" +
      (r.generated ? ' <span class="ced-hidden" style="color:var(--dim);font-size:.7rem">(generated: read-only)</span>' : "") +
      (r.visible ? "" : ' <span class="ced-hidden" style="color:var(--dim);font-size:.7rem">(hidden: not rendered on the page right now)</span>');
    ta.value = r.el.innerHTML;
    ta.readOnly = !!r.generated;
    status(r.generated
      ? "The publisher writes this block on every publish. Edit its source, not this. Anything typed here is discarded."
      : "");
    doc.body.appendChild(scrim);
    doc.body.appendChild(modal);
    ta.focus();
  }

  function closeModal() {
    if (!openRegion) return;
    openRegion = null;
    if (ta) { ta.disabled = false; ta.readOnly = false; }
    if (scrim && scrim.parentNode) scrim.parentNode.removeChild(scrim);
    if (modal && modal.parentNode) modal.parentNode.removeChild(modal);
  }

  /* the (X) close path: unlike Cancel/Esc (which discard silently), this asks
     first, but only when the box holds changes that were never Applied. */
  function requestClose() {
    var unapplied = openRegion && ta && ta.value !== openRegion.current;
    if (unapplied &&
        !window.confirm("You changed the text in this box but haven't applied it.\n\nClose and discard those changes?")) return;
    closeModal();
  }

  /* tag-balance sanity check: catches the typo that would eat half the page */
  function tagCheck(html) {
    var body = html.replace(/<!--[\s\S]*?-->/g, "");
    var re = /<(\/?)([a-zA-Z][\w-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
    var stack = [], m;
    while ((m = re.exec(body))) {
      var closing = m[1], name = m[2].toLowerCase(), attrs = m[3];
      if (VOID_TAGS[name]) continue;
      /* '/>' only truly self-closes inside inline SVG; on an HTML element the
         browser ignores it and opens the tag anyway, so treat it as open. */
      if (!closing && /\/\s*$/.test(attrs) && stack.indexOf("svg") !== -1) continue;
      if (closing) {
        if (!stack.length || stack[stack.length - 1] !== name) {
          return "unexpected </" + name + ">" + (stack.length ? " (open: <" + stack.join("> <") + ">)" : "");
        }
        stack.pop();
      } else stack.push(name);
    }
    if (stack.length) return "unclosed <" + stack.join(">, <") + ">";
    return null;
  }

  function applyModal() {
    if (!openRegion) return;
    if (openRegion.generated) {
      status("Not applied - the publisher owns this block. Edit its source instead.");
      return;
    }
    /* The refusal is here and not only on the textarea, so turning the
       read-only flag off in devtools still cannot write the half that is
       written from something else. */
    if (ddOwner(openRegion.slug)) {
      status("Not applied - a deep dive is written from the Markdown it carries. " +
        "Open the project and use its Deep dive view; what you write here would " +
        "be lost at the next Apply.");
      return;
    }
    var problem = tagCheck(ta.value);
    if (problem && !window.confirm("Tag check: " + problem + "\n\nApply anyway?")) {
      status("Not applied - " + problem);
      return;
    }
    var r = openRegion;
    applyRegion(r, ta.value);
    ta.value = r.current;
    refreshDirtyUI();
    requestReposition();
    status(r.edited ? "Applied - page updated. Export when you're done." : "Applied - matches published content.");
  }

  /* Write one region and record what that means.

     Both doors go through here: a chip's modal, and the project form. A
     field edited either way lands in exactly the same state, which is what
     lets a card have two doors without them disagreeing. */
  function applyRegion(r, html) {
    r.el.innerHTML = html;
    r.current = r.el.innerHTML;          /* normalized by the browser */
    r.edited = r.current !== r.original;
    if (r.edited) exportedClean = false;
    pendingSyncRegion(r);
    relinkTplGalleries(r);               /* a template rewrite orphans its dd gallery */
    return r.edited;
  }

  function revertModal() {
    if (!openRegion) return;
    var r = openRegion;
    r.el.innerHTML = r.original;
    r.current = r.original;
    r.edited = false;
    pendingSyncRegion(r);
    ta.value = r.original;
    relinkTplGalleries(r);
    refreshDirtyUI();
    requestReposition();
    status("Reverted to published content.");
  }

  /* one universal quicksave slot - a panic backup for the current textarea */
  function quicksaveLabel() {
    return openRegion ? openRegion.slug : "?";
  }
  function quicksave() {
    if (!openRegion) return;
    try {
      localStorage.setItem(QS_KEY, JSON.stringify({
        slug: quicksaveLabel(),
        when: Date.now(), text: ta.value
      }));
      status("Quicksaved (" + quicksaveLabel() + "). One slot - a new quicksave overwrites it.");
    } catch (err) { status("Quicksave failed: " + err.message); }
  }
  function age(ms) {
    var s = Math.round(ms / 1000);
    if (s < 90) return s + "s ago";
    if (s < 5400) return Math.round(s / 60) + " min ago";
    if (s < 129600) return Math.round(s / 3600) + " h ago";
    return Math.round(s / 86400) + " days ago";
  }
  function restore() {
    if (!openRegion) return;
    var raw = null;
    try { raw = localStorage.getItem(QS_KEY); } catch (err) {}
    if (!raw) { status("No quicksave stored."); return; }
    var q;
    try { q = JSON.parse(raw); } catch (err) { status("Quicksave is unreadable."); return; }
    if (!q || typeof q.text !== "string" || typeof q.when !== "number") {
      status("Quicksave is unreadable."); return;
    }
    var note = "Quicksave from '" + q.slug + "' (" + age(Date.now() - q.when) + ").";
    if (!window.confirm(note + "\n\nPaste it into this textarea? (Nothing is applied until you press Apply.)")) return;
    ta.value = q.text;
    status(note + " Pasted - review, then Apply.");
  }

  /* ==========================================================
     6. EXPORT AND SPLICING
     ----------------------------------------------------------
     The law this whole tool rests on: export re-fetches the pristine
     bytes of the page and splices only between markers. It never
     serializes the live DOM, so every byte outside an edited region
     survives untouched.

     Export therefore needs the page over HTTP, not file://.
     ========================================================== */
  /* attrs, when given, is a map of attribute names to a value or null, for
     the region's own open tag. See setTagAttrs. */
  function spliceRegion(src, slug, inner, attrs) {
    var open = "<!--[edit:" + slug + "]-->";
    var close = "<!--[/edit:" + slug + "]-->";
    var a = src.indexOf(open);
    if (a < 0) return null;
    var start = a + open.length;
    var b = src.indexOf(close, start);
    if (b < 0) return null;
    var span = src.slice(start, b);
    var lt = span.indexOf("<");
    if (lt < 0) return null;
    /* attribute-aware end of the opening tag: '>' may appear inside a quoted
       attribute value, so a plain indexOf('>') could split the tag open */
    var openTag = /^<[a-zA-Z][\w-]*(?:[^>"']|"[^"]*"|'[^']*')*>/.exec(span.slice(lt));
    if (!openTag) return null;
    var gt = lt + openTag[0].length - 1;
    var lastClose = span.lastIndexOf("</");
    if (lastClose <= gt) return null;
    var tag = attrs ? setTagAttrs(openTag[0], attrs) : openTag[0];
    return src.slice(0, start) + span.slice(0, lt) + tag + inner + span.slice(lastClose) + src.slice(b);
  }

  /* Rewrite the named attributes of one opening tag, and leave every other
     byte of it as it was written. It is the one change to a region's open
     tag the export makes, and the tag is inside the region's markers.

       tag     '<div class="gallery" data-next-preview>'
       attrs   { name: value }; null takes the attribute out

     A value the tag already holds leaves the tag as it was. A new value is
     written in double quotes where the attribute stood, after the same
     white space. An attribute the tag lacks is added after one space,
     before the tag's end. null takes the attribute out with the white
     space before it. */
  function setTagAttrs(tag, attrs) {
    var out = tag;
    Object.keys(attrs).forEach(function (name) {
      var value = attrs[name];
      var found = findTagAttr(out, name);
      if (value === null || value === undefined) {
        if (found) out = out.slice(0, found.start) + out.slice(found.end);
        return;
      }
      var written = name + '="' + escAttr(value) + '"';
      if (found) {
        if (found.value === escAttr(value)) return;
        out = out.slice(0, found.start) + found.space + written + out.slice(found.end);
        return;
      }
      var end = /\s*\/?>$/.exec(out);
      out = out.slice(0, end.index) + " " + written + out.slice(end.index);
    });
    return out;
  }

  /* One attribute of an opening tag: where it starts, with the white space
     before it, where it ends, that white space, and its value as written,
     without quotes. The attributes are read one after another from the tag
     name, so a name inside another attribute's quoted value is never taken
     for an attribute. */
  function findTagAttr(tag, name) {
    var re = /(\s+)([^\s=\/>"']+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s>"']+))?/y;
    re.lastIndex = (/^<[a-zA-Z][\w-]*/.exec(tag) || [""])[0].length;
    var m;
    while ((m = re.exec(tag))) {
      if (m[2].toLowerCase() === name) {
        var raw = m[3] || "";
        return { start: m.index, end: re.lastIndex, space: m[1],
                 value: /^["']/.test(raw) ? raw.slice(1, -1) : raw };
      }
    }
    return null;
  }

  function escAttr(s) {
    return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  }

  /* Indent a block written at no indent, so a region or an item built in
     the browser matches the hand-written style of the file it lands in.
     The first line is left alone: the splice has already placed it. */
  function indentBlock(text, ind) {
    if (!ind) return text;
    return text.split("\n").map(function (ln, i) {
      return i === 0 ? ln : ind + ln;
    }).join("\n");
  }

  /* One list's items, in the order the editor holds, back into the page's
     own bytes.

     An item the file already had contributes its source span VERBATIM, so a
     reorder moves bytes and changes none of them. A new item contributes the
     markup the trunk built, indented to match. A removed one is left out.

     Runs before every region splice, so a region inside a new item finds
     its markers: the item is in the text by the time they are looked for. */
  function spliceList(src, name, state) {
    var open = "<!--[list:" + name + "]-->";
    var close = "<!--[/list:" + name + "]-->";
    var a = src.indexOf(open);
    if (a < 0) return null;
    var start = a + open.length;
    var b = src.indexOf(close, start);
    if (b < 0) return null;
    var inner = src.slice(start, b);

    var have = {};
    var re = /<!--\[item:([\w-]+)\]-->/g, m;
    while ((m = re.exec(inner))) {
      var id = m[1];
      var shut = "<!--[/item:" + id + "]-->";
      var e = inner.indexOf(shut, m.index + m[0].length);
      if (e < 0) return null;
      have[id] = inner.slice(m.index, e + shut.length);
      re.lastIndex = e + shut.length;
    }

    /* the file's own indents: one for an item, one for the close marker */
    var ind = (/\n([ \t]*)<!--\[item:/.exec(inner) || [, "        "])[1];
    var tail = (/\n([ \t]*)$/.exec(inner) || [, ind])[1];

    var out = [];
    for (var i = 0; i < state.order.length; i++) {
      var want = state.order[i];
      /* added first: a block the editor WROTE replaces the one the file
         holds, which is what lets a card be written again when the set of
         regions in it changes. Everything else contributes its source span
         and so moves without changing. */
      if (state.added[want] !== undefined) out.push(indentBlock(ind + state.added[want], ind));
      else if (have[want] !== undefined) out.push(ind + have[want]);
      else return null;
    }
    return src.slice(0, start) +
      (out.length ? "\n" + out.join("\n\n") + "\n" + tail : "\n" + tail) +
      src.slice(b);
  }
  /* Six base36 characters from a 32-bit FNV-1a hash of the text. A publish
     writes one into every file it generates, so a file can say which
     publish it came from. Six characters, always: the hash is reduced to
     36^6 before it is written, so two stamps have one width and one shape.
     It is a fingerprint, not a secret, and a collision is a warning at
     worst: the publisher rehashes when a new stamp equals the last one. */
  var STAMP_SPACE = 2176782336;   /* 36^6 */
  function stamp(text) {
    var h = 0x811c9dc5;
    var s = String(text);
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return ("00000" + (h % STAMP_SPACE).toString(36)).slice(-6);
  }
  /* serialize a gallery's model into tidy authored <img> lines and splice
     them between the gallery's own tags. Indentation is read from the source
     span so the output matches the file's hand-written style. An empty
     project gallery falls back to its seed placeholders; an empty deep-dive
     gallery exports a bare <div class="gallery"> (the drawer removes it). */
  function spliceGallery(src, g) {
    var open = "<!--[edit:" + g.slug + "]-->";
    var a = src.indexOf(open);
    if (a < 0) return null;
    var start = a + open.length;
    var b = src.indexOf("<!--[/edit:" + g.slug + "]-->", start);
    if (b < 0) return null;
    var im = /\n([ \t]*)</.exec(src.slice(start, b));
    var ind = im ? im[1] : "            ";
    var entries = imageRegion.exportForm(g.model, g.kind);
    if (!entries.length && g.kind.seedFallback && g.seeds.length) {
      entries = imageRegion.exportForm(g.seeds, g.kind);
    }
    if (!entries.length && !g.kind.mayBeEmpty) {
      console.warn("[site editor] " + g.slug + " exports EMPTY - no images and no seed fallback.");
    }
    return spliceRegion(src, g.slug, imageRegion.serializeFor(entries, ind, g.kind, g.head),
      imageRegion.openAttrs(g.head));
  }

  /* ---------------- pages and their pristine bytes ---------------- */

  function isManaged(path) {
    return MANAGED_PAGES.some(function (pg) { return pg.path === path; });
  }

  /* Which managed page is being viewed, as a path relative to the site root.

     The site is served from the root of its domain, which the CNAME and the
     canonical URL both say, so stripping the leading slash gives the same path
     the managed-page list uses. location.pathname is used rather than href
     because it is immune to ?query variants, and a directory URL serves
     index.html.

     A file name on its own is not enough: two managed pages in different
     directories would collide on one key, and the pending-edit store is keyed
     by this. The file-name match stays as a fallback for a copy of the site
     served from a subdirectory. */
  function currentPage() {
    var full = location.pathname.replace(/^\//, "");
    if (!full || full.slice(-1) === "/") full += "index.html";
    if (isManaged(full)) return full;
    var name = full.replace(/^.*\//, "");
    return isManaged(name) ? name : (full || "index.html");
  }

  function pageLabel(path) {
    var hit = null;
    MANAGED_PAGES.forEach(function (pg) { if (pg.path === path) hit = pg; });
    return hit ? hit.label : path;
  }

  /* THE ONE PLACE pristine bytes are read.

     Every splice starts from the bytes that are deployed, never from the live
     DOM, which is what keeps everything outside an edited region byte-exact.
     no-store because a stale copy would silently revert an earlier change.

     The hand-off below is the offline fallback, here and only here. */
  /* A page opened from disk cannot fetch anything: the browser refuses it
     and prints a CORS error of its own that no reader can act on. Asking
     anyway produced a dozen red lines at every publish and taught the
     author to stop reading the console. Every reader below asks this
     first and goes straight to the answer that works. */
  function onDisk() { return location.protocol === "file:"; }

  /* The publish engine owns the trace, because a trace is about a publish.
     This trunk reports into it when that trunk is on the page, and says
     nothing when it is not. */
  function note(what, info) {
    if (AMH.publish && AMH.publish.note) AMH.publish.note(what, info);
  }

  function pristine(path) {
    path = path || currentPage();
    if (!isManaged(path)) {
      return Promise.reject(new Error(path + " is not a managed page - add it to MANAGED_PAGES"));
    }
    /* The staging layer first. A bundle that has been built but not yet
       uploaded is the truth about this site as the person means it, and
       the next bundle has to build on it rather than on the bytes the
       server still serves. This one branch is what lets several posts be
       made in one sitting and uploaded once. */
    var staged = layerFile(path);
    if (staged !== null) { note("read " + path, "from the staging layer"); return Promise.resolve(staged); }
    note("read " + path, onDisk() ? "asking, this page is on disk" : "over http");
    /* BLG-E01 is still reported, because that message is the useful one */
    if (onDisk()) return handOff(path, new Error("opened from disk"));
    return fetch(path, { cache: "no-store" }).then(
      function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status + " fetching " + path);
        return res.text();
      },
      /* Only a rejected fetch falls through to the hand-off. A 404 from a real
         server is a real problem and is thrown above, not papered over by
         asking someone to find the file. */
      function (netErr) { return handOff(path, netErr); }
    );
  }

  /* ---------------- the staging layer ----------------

     A publish, a delete or a rebuild builds a zip and leaves it to the
     person to upload. Until they do, the site they see and the site the
     server serves are two different things. The layer is the difference:
     the text files the last bundle wrote, kept for the tab.

     Everything reads through it. pristine() answers from it, so the next
     bundle splices what the last one wrote and the newest zip is always
     the whole of what is not yet live. The page reads from it too, so a
     post shows on the blog the moment it is published and carries a chip
     saying it is not uploaded yet.

     Text only. Image bytes cannot live in storage, which holds a few
     megabytes and no place for photographs, so the layer names the
     images it cannot keep and the zip built again says which they are.

     It clears itself: when a page loads carrying the layer's stamp, the
     upload has happened and there is nothing left to remember. */
  var LAYER_KEY = "amh-publish-pending";
  var LAYER_MAX = 4 * 1024 * 1024;

  function layerRead() {
    try {
      var raw = window.sessionStorage.getItem(LAYER_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (err) { return null; }
  }
  function layerWrite(rec) {
    try {
      if (rec) window.sessionStorage.setItem(LAYER_KEY, JSON.stringify(rec));
      else window.sessionStorage.removeItem(LAYER_KEY);
    } catch (err) {
      console.warn("[site editor] the staging layer could not be kept (" +
        (err && err.message ? err.message : "storage refused it") +
        "). Upload the bundle you have before you make another post.");
      return false;
    }
    if (AMH.tool.publishLine) AMH.tool.publishLine();
    return true;
  }
  /* One file from the layer, or null when the layer does not hold it. */
  function layerFile(path) {
    var rec = layerRead();
    return rec && rec.files && typeof rec.files[path] === "string" ? rec.files[path] : null;
  }
  /* Put a bundle's text files in the layer beside the record of it.
     Refuses a layer over the size rule rather than losing the tab's
     storage to it: the record stays, the files do not, and the next
     bundle reads the deployed bytes as it did before. */
  function layerKeep(rec, files, images) {
    rec.files = files || {};
    rec.images = images || [];
    var size = JSON.stringify(rec).length;
    if (size > LAYER_MAX) {
      console.warn("[site editor] this bundle is " + Math.round(size / 1024) +
        " KB, over the " + Math.round(LAYER_MAX / 1024) + " KB the staging layer keeps. " +
        "It is not staged: upload it before you make another post.");
      rec.files = {};
      rec.images = images || [];
      rec.overSize = true;
    }
    layerWrite(rec);
    return !rec.overSize;
  }

  /* The page, read from the layer.

     Only the machine-owned regions are replaced, and only with the
     editor on: the layer is the author's own unpublished work, not
     something a visitor should see. An authored region is never touched,
     because the layer holds a generated copy of it and the person may
     have edited it since.

     Nothing is written. This changes what is on screen and no file. */
  function layerApply(force) {
    /* force is the moment a bundle is built: the person publishing IS
       the author, whatever the editor's visual state, and the post they
       have made has to appear */
    if (!active && !force) return 0;
    var text = layerFile(currentPage());
    if (text === null) return 0;
    var n = 0;
    regions.forEach(function (r) {
      if (!r.el || r.el.getAttribute("data-ced") === null) return;
      var inner = regionFrom(text, r.slug);
      if (inner === null || inner === r.el.innerHTML) return;
      r.el.innerHTML = inner;
      n++;
    });
    return n;
  }
  /* One region's inner HTML out of a source string. */
  function regionFrom(text, slug) {
    var open = "<!--[edit:" + slug + "]-->";
    var a = text.indexOf(open);
    if (a < 0) return null;
    var b = text.indexOf("<!--[/edit:" + slug + "]-->", a);
    if (b < 0) return null;
    var span = text.slice(a + open.length, b);
    var lt = span.indexOf("<");
    if (lt === -1) return null;
    var gt = span.indexOf(">", lt);
    var lastClose = span.lastIndexOf("</");
    if (gt === -1 || lastClose <= gt) return null;
    return span.slice(gt + 1, lastClose);
  }

  /* ---------------- the file hand-off wizard ----------------

     A page opened from disk has no origin a fetch can use, so the editor
     cannot read its own published bytes. The File API can, because the user
     picks the file. The bytes are then used exactly as fetched bytes are,
     which is what keeps the export byte-exact either way.

     Only a page on file:// reaches this. A rejected fetch is the trigger; a
     404 from a real server is a real problem and is thrown instead.

     The wizard asks once for each file and keeps what it is given for the
     rest of the page load, so a publish that touches four files asks for
     four and never asks twice. A folder gives it everything in one action.

     Every refusal carries a code. The codes are stable, they are printed to
     the console, and they are what a bug report should quote. */

  var ERR = {
    "BLG-E01": "This page was opened from disk. The editor cannot read its own published bytes.",
    "BLG-E02": "That drag carried no file. Some sources hand over a link, not a file. Use the button, or drag from a file manager.",
    "BLG-E03": "That is the wrong file for this step.",
    "BLG-E04": "The file could not be read.",
    "BLG-E05": "This file has no editable regions. The editor does not write this page.",
    "BLG-E06": "This file does not have a region this publish must write.",
    "BLG-E07": "Cancelled. No file was given.",
    "BLG-E08": "That folder has none of the files this publish needs.",
    "BLG-E09": "Not on disk. The publish creates this file.",
    "BLG-E10": "This month file is from a different publish than the blog page you opened. The publish overwrites it with the version this page knows.",
    "BLG-E11": "The live manifest is different from the page you loaded. Reload the page and compose again. Save Draft first.",
    "BLG-E12": "The browser did not give permission to write to that folder. Pick it again and choose Save changes.",
    "BLG-E13": "That folder is not the root of this repo. The root holds index.html and blog.html.",
    "BLG-E14": "A file could not be written to the folder. Nothing else was written after it."
  };

  /* Say a code the same way every time, and put it where a console search
     will find it. Returns the sentence, for a dialog to show. */
  function errText(code, extra) {
    var msg = (ERR[code] || "Unexpected problem.") + (extra ? " " + extra : "");
    console.warn("[site editor] " + code + " " + msg);
    return code + " - " + msg;
  }
  function errObj(code, extra) {
    var e = new Error(errText(code, extra));
    e.code = code;
    return e;
  }

  /* Files the user has already handed over, for this page load only. Keyed by
     the path the engine asked for, holding the text a fetch would have given.
     Cleared by a reload, which is the same life as an unexported edit. */
  var handed = {};

  /* The repo folder, when the user picked it through the File System Access
     API. Kept for the page load, like a handed file: every later ask is
     answered from it with no dialog, which is what "pick the folder once"
     has to mean for a rebuild that learns its months only after the first
     file is in hand. Null in a browser without the API, or until a pick. */
  var repoDir = null;

  /* Read one path from the kept folder. Walks the path one segment at a
     time, so only the named file is opened: nothing is enumerated, and the
     browser has no reason to count the folder or call it an upload.
     Resolves with the text, or null when the file is not there. Any other
     failure rejects with BLG-E04. */
  function readFromRepo(path) {
    var parts = path.split("/");
    var name = parts.pop();
    var dir = Promise.resolve(repoDir);
    parts.forEach(function (seg) {
      dir = dir.then(function (d) { return d.getDirectoryHandle(seg); });
    });
    return dir.then(function (d) { return d.getFileHandle(name); })
      .then(function (fh) { return fh.getFile(); })
      .then(readFile)
      .then(null, function (err) {
        if (err && err.name === "NotFoundError") return null;
        throw errObj("BLG-E04", path + (err && err.message ? " (" + err.message + ")" : ""));
      });
  }

  /* Files the user said are not there. Only an optional file can be skipped,
     and a skip is remembered for the same reason a handed file is: a rebuild
     walks every month, and asking twice about one that does not exist is the
     dialog wasting someone's time. */
  var skipped = {};

  /* What this publish is going to ask for, when the caller knows in advance.
     The wizard counts against it so it can say "file 2 of 4" rather than
     opening the same dialog four times with no sense of progress. */
  var expected = [];
  function expectFiles(paths) {
    expected = (paths || []).slice();
  }

  /* Files the caller has said may legitimately be absent. They are asked for
     differently and are not counted in the step total, because a file that
     does not have to exist is not a step someone has to complete. */
  var optional = {};
  function expectOptional(paths) {
    (paths || []).forEach(function (pp) { optional[pp] = true; });
  }
  function isOptional(path) { return !!optional[path]; }
  function required() {
    return expected.filter(function (pp) { return !optional[pp]; });
  }

  /* The files the publish engine writes whole. None of them carries an
     editable region, so none of them can fail a marker check in a way a
     person could act on. Month files are not listed: they are matched by
     their shape and checked by their stamp. */
  var GENERATED_FILES = {
    "search.js": 1, "feed.xml": 1, "sitemap.xml": 1, "robots.txt": 1
  };

  /* Does this look like a page the editor writes? Better verification, as
     chosen: the name has to match, and the markers the splice needs have to
     be present. It warns and lets the user continue, because the editor
     legitimately holds edits that are not in the file yet. */
  function verifyFile(path, text) {
    var want = path.replace(/^.*\//, "");
    /* A month file has no regions. Its check is the stamp in its first
       comment against the month's line in the manifest this page carries:
       a file from another publish is overwritten with the version this
       page knows, and the person should hear that before it happens. A
       file with no stamp is from before V044 and gets no check; a rebuild
       gives it one. */
    var mo = /^blog\/(\d{4})\.html$/.exec(path);
    if (mo) {
      var fs = /GENERATED by the blog\.html publish engine[^>]*?stamp:([0-9a-z]{6})/.exec(text.slice(0, 600));
      var page = monthStampOnPage(mo[1]);
      if (fs && page && fs[1] !== page) {
        return { ok: true, warn: true, code: "BLG-E10",
                 detail: want + " says " + fs[1] + ", the page says " + page + "." };
      }
      return { ok: true, count: 0 };
    }
    /* A file the engine writes whole carries no markers and never will, so
       saying so at every publish is a warning that can never be acted on.
       A month file is checked above by its stamp instead. */
    if (GENERATED_FILES[want]) return { ok: true, count: 0 };
    var marks = text.match(/<!--\[edit:[\w-]+\]-->/g) || [];
    if (!marks.length) {
      return { ok: true, warn: true, code: "BLG-E05",
               detail: 'The file is named "' + want + '" and has no markers. The publish continues.' };
    }
    /* "<!--[edit:" is ten characters, so the slug starts at ten. It read
       from eleven until V063, which dropped the first letter of every slug
       and made every region compare as missing. The check reported every
       region of every page on every publish, so a region that really was
       missing said nothing that the noise had not already said. */
    var slugs = {};
    marks.forEach(function (m) { slugs[m.slice(10, -4)] = true; });
    /* the regions this page load knows about, when it is this page */
    var missing = [];
    if (path === currentPage()) {
      regions.forEach(function (r) { if (!slugs[r.slug]) missing.push(r.slug); });
      gals.forEach(function (g) { if (!slugs[g.slug]) missing.push(g.slug); });
    }
    Object.keys(staged[path] || {}).forEach(function (s) {
      if (!slugs[s]) missing.push(s);
    });
    if (missing.length) {
      return { ok: true, warn: true, code: "BLG-E06",
               detail: "Missing: " + missing.slice(0, 4).join(", ") +
                       (missing.length > 4 ? " and " + (missing.length - 4) + " more" : "") +
                       ". The export reports what it cannot splice." };
    }
    return { ok: true, count: marks.length };
  }
  /* The stamp the loaded page's manifest holds for a month, or "" when
     the page has no manifest or the month has no line. blog.js reads the
     tag; it loads before this file on the pages that have one. */
  function monthStampOnPage(yymm) {
    var B = window.AMH && window.AMH.blog;
    if (!B || !B.parseManifest) return "";
    return (B.parseManifest().monthStamps || {})[yymm] || "";
  }

  /* A file dropped anywhere but a drop target makes the browser open it,
     which throws the page away and every unexported edit with it. Nothing
     used to listen at this level, so a near miss was destructive. */
  var dropGuarded = false;
  function guardDocumentDrops() {
    if (dropGuarded) return;
    dropGuarded = true;
    ["dragover", "drop"].forEach(function (ev) {
      doc.addEventListener(ev, function (e) {
        /* a real target has already stopped this from bubbling */
        if (!e.dataTransfer) return;
        var types = e.dataTransfer.types || [];
        var isFile = Array.prototype.indexOf.call(types, "Files") !== -1;
        if (!isFile) return;
        e.preventDefault();
        if (ev === "dragover") e.dataTransfer.dropEffect = "none";
      });
    });
  }

  /* Ask for one file, and keep it.

     Resolves with the file's text. Rejects only when the user cancels, and
     the rejection carries a code. */
  function handOff(path, netErr) {
    if (handed[path]) return Promise.resolve(handed[path]);
    /* already said to be absent: an optional file answers null and the
       caller carries on, which is what it would have done at a 404 */
    if (skipped[path]) return Promise.resolve(null);
    /* Two reads of one file can be in flight at once: the publish reads a
       page's pristine bytes and builds the page from them in parallel, and
       over HTTP that is two fetches. From disk it was two dialogs for one
       file, and the second never closed. The second ask now waits on the
       first dialog. */
    if (asking[path]) return asking[path];
    /* And two reads of DIFFERENT files are in flight at once too: a publish
       reads every changed page in parallel, so two paths opened two dialogs
       at the same moment, each with its own ground. The guard above holds
       one path and cannot see the other.

       One line of asks holds them apart. The reads stay parallel: it is
       the asking that cannot overlap. */
    var mine = askWaiting ? askQueue.then(askNow) : askNow();
    askWaiting++;
    /* The line must outlive a refusal. A cancelled ask fails its own
       caller, and the ask behind it still has to run. */
    askQueue = mine.then(askOff, askOff);
    asking[path] = mine.then(
      function (v) { delete asking[path]; return v; },
      function (e) { delete asking[path]; throw e; });
    return asking[path];

    function askNow() {
      /* The wait may have answered it. One folder given to an earlier ask
         answers every file it holds, and then this ask has nothing to do. */
      if (handed[path]) return Promise.resolve(handed[path]);
      if (skipped[path]) return Promise.resolve(null);
      return askOnce(path, netErr);
    }
  }
  var asking = {};
  /* The line, for the page load, beside handed and skipped.

     askWaiting is how many asks are in it. An ask that arrives at an empty
     line runs NOW rather than after a turn of the microtask queue, because
     a dialog that opened a beat late would be a change nobody asked for:
     one ask on its own must behave exactly as it did. */
  var askQueue = Promise.resolve();
  var askWaiting = 0;
  function askOff() { askWaiting--; }
  function askOnce(path, netErr) {
    var want = path.replace(/^.*\//, "");
    var mayBeAbsent = isOptional(path);
    /* the folder is already in hand: read from it, and open the dialog only
       for a required file it does not hold */
    if (repoDir) {
      return readFromRepo(path).then(function (text) {
        if (text !== null) {
          verifyWarn(path, want, text);
          handed[path] = text;
          console.info("[site editor] " + path + " read from the repo folder.");
          return text;
        }
        if (mayBeAbsent) {
          skipped[path] = true;
          errText("BLG-E09", "Wanted: " + want + ".");
          return null;
        }
        console.info("[site editor] " + path + " is not in the repo folder; asking for it.");
        return handOffDialog(path, want, mayBeAbsent, netErr);
      });
    }
    return handOffDialog(path, want, mayBeAbsent, netErr);
  }

  /* Warn about a file's contents, and keep going. A warning is not a
     refusal: the editor holds edits that are not in the file yet, so it
     cannot know from the bytes alone that a file is wrong. The splice is
     the real gate, and it fails loudly and names what it could not find. */
  function verifyWarn(path, want, text) {
    var v = verifyFile(path, text);
    if (v.warn) errText(v.code, v.detail);
  }

  /* ---------------- taking files, from a drop, a choice or a folder ----------------

     The hand-off dialog and the publish wizard's Files step both take files
     the same three ways. What is taken is kept for the page load, so every
     later ask is answered from memory. Each function resolves with the
     count taken; none rejects for a file it could not read, because one
     bad file is a fact about that file, and the ask for it comes round
     again. */

  /* Every path a caller still needs: not in hand, not said to be absent. */
  function stillWanted(paths) {
    return paths.filter(function (pp) { return !handed[pp] && !skipped[pp]; });
  }
  function keep(pp, text) {
    verifyWarn(pp, pp.replace(/^.*\//, ""), text);
    handed[pp] = text;
  }
  /* Files chosen or dropped together, matched by name to the paths still
     wanted. A person chose these by hand, so the name is the match. */
  function takeFiles(files, paths) {
    var byName = {};
    Array.prototype.forEach.call(files || [], function (f) { byName[f.name] = f; });
    var jobs = stillWanted(paths).filter(function (pp) { return !!byName[pp.replace(/^.*\//, "")]; });
    return Promise.all(jobs.map(function (pp) {
      return readFile(byName[pp.replace(/^.*\//, "")])
        .then(function (text) { keep(pp, text); }, function () {});
    })).then(function () { return jobs.length; });
  }
  /* The fallback folder input. The browser hands over every file in the
     tree, so the match is on the full path under the picked folder, and
     never on the bare name: the tree holds a test fixture with the same
     name as a month file, and a name match let the last one seen win. */
  function takeFolder(files, paths) {
    var byPath = {};
    Array.prototype.forEach.call(files || [], function (f) {
      var rel = f.webkitRelativePath
        ? f.webkitRelativePath.replace(/^[^\/]+\//, "")
        : f.name;
      byPath[rel] = f;
    });
    var jobs = stillWanted(paths).filter(function (pp) { return !!byPath[pp]; });
    return Promise.all(jobs.map(function (pp) {
      return readFile(byPath[pp]).then(function (text) { keep(pp, text); }, function () {});
    })).then(function () { return jobs.length; });
  }
  /* The File System Access path. Only the named files are opened. The
     handle is kept, so no later ask in this page load opens a dialog. An
     optional file the folder lacks is marked absent here, as the dialog's
     own button would mark it. */
  function takeDirectory(handle, paths) {
    repoDir = handle;
    var took = 0;
    return Promise.all(stillWanted(paths).map(function (pp) {
      return readFromRepo(pp).then(function (text) {
        if (text === null) {
          if (isOptional(pp)) { skipped[pp] = true; errText("BLG-E09", "Wanted: " + pp + "."); }
          return;
        }
        keep(pp, text);
        took++;
      }, function (err) { errText("BLG-E04", err && err.message); });
    })).then(function () { return took; });
  }
  function hasPicker() { return typeof window.showDirectoryPicker === "function"; }

  /* ---------------- the remembered repo folder ----------------

     Picking the folder once for every page load is one pick too many. The
     handle is kept in IndexedDB, which is the only store that can hold
     one: a handle is an object the browser clones, not a string. A stored
     path would be no use even if we had one, because nothing opens a
     folder by name.

     What the reader is shown is the folder's own name. The browser never
     tells a page where a folder is, which is also why nothing here can
     carry a path into the repo.

     THE CONFIRM STEP IS NOT POLITENESS. The browser keeps the handle but
     usually not the permission, and requestPermission() works only inside
     a user gesture. The click that says "use this folder" is what makes
     the permission askable at all.

     A NAME IS NOT PROOF. Every page opened from disk shares one origin,
     "file://", so two clones of this repo share one memory and report the
     same folder name. The stamp in the folder's own blog.html is what
     tells them apart, so it is read and compared before the folder is
     used. It can only be read after permission is granted, so the verdict
     is shown before the click when the browser still has permission, and
     right after it when it does not. */
  var IDB_NAME = "amh-editor", IDB_STORE = "repo", IDB_KEY = "folder";
  var repoOffered = {};      /* a remembered folder is offered once per mode, per load */

  /* name and store default to the folder's own database. The held photos
     keep a database of their own, so neither can block the other's upgrade
     and clearing one never touches the other. */
  function idbOpen(name, store) {
    return new Promise(function (resolve, reject) {
      if (typeof indexedDB === "undefined" || !indexedDB) {
        reject(new Error("this browser keeps no IndexedDB"));
        return;
      }
      var q = indexedDB.open(name || IDB_NAME, 1);
      q.onupgradeneeded = function () { q.result.createObjectStore(store || IDB_STORE); };
      q.onsuccess = function () { resolve(q.result); };
      q.onerror = function () { reject(q.error || new Error("IndexedDB refused")); };
      q.onblocked = function () { reject(new Error("IndexedDB blocked")); };
    });
  }
  function idbDo(mode, run, name, store) {
    store = store || IDB_STORE;
    return idbOpen(name, store).then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(store, mode);
        var req = run(tx.objectStore(store));
        /* one connection for each job, closed with it, so a run of photo
           writes does not leave a connection open for each */
        tx.oncomplete = function () { db.close(); resolve(req ? req.result : undefined); };
        tx.onerror = function () { db.close(); reject(tx.error); };
        tx.onabort = function () { db.close(); reject(tx.error || new Error("aborted")); };
      });
    });
  }
  /* Every one of these answers rather than throws: a browser that refuses
     storage must cost the reader a pick, not an error. */
  function repoRecall() {
    return idbDo("readonly", function (st) { return st.get(IDB_KEY); })
      .then(function (v) { return v && v.handle ? v.handle : null; },
            function () { return null; });
  }
  function repoRemember(handle) {
    return idbDo("readwrite", function (st) {
      return st.put({ handle: handle, name: handle.name, at: new Date().toISOString() }, IDB_KEY);
    }).then(function () { return true; }, function () { return false; });
  }
  function repoForget() {
    return idbDo("readwrite", function (st) { return st.delete(IDB_KEY); })
      .then(function () { return true; }, function () { return false; });
  }

  /* The publish stamp inside a page's manifest block. Anchored to the
     block, because a generated file names a stamp in its top comment too. */
  function stampIn(text) {
    var at = String(text).indexOf('id="blogManifest"');
    if (at === -1) return "";
    var end = String(text).indexOf("</scr" + "ipt>", at);
    var m = /stamp:([0-9a-z]{6})/.exec(String(text).slice(at, end === -1 ? undefined : end));
    return m ? m[1] : "";
  }
  /* This page's own stamp needs no anchor: the manifest tag holds manifest
     lines and nothing else, and no other line of it carries "stamp:". */
  function pageStamp() {
    var el = doc.getElementById("blogManifest");
    var m = el ? /stamp:([0-9a-z]{6})/.exec(el.textContent) : null;
    return m ? m[1] : "";
  }
  /* Read the folder and say what it is. Needs permission, so it runs after
     the grant. Resolves a verdict the step can show as one sentence. */
  function repoVerify(handle) {
    /* A handle can come back from storage without its methods, because a
       structured clone keeps the data and not the object. Answer, do not
       throw: the rule in this file is that a browser which lost the API
       costs the reader a pick, not an error. */
    if (!handle || typeof handle.getFileHandle !== "function") {
      return Promise.resolve({ ok: false, why: "That folder could not be read." });
    }
    return repoHasRootMarks(handle).then(function (root) {
      if (!root) return { ok: false, why: "That folder is not the root of this site. " +
        "The root holds index.html and blog.html." };
      return handle.getFileHandle("blog.html")
        .then(function (fh) { return fh.getFile(); })
        .then(readFile)
        .then(function (text) {
          var mine = pageStamp(), theirs = stampIn(text);
          if (!mine || !theirs) {
            return { ok: true, why: "It holds index.html and blog.html. The publish " +
              "stamp could not be compared." };
          }
          if (mine === theirs) {
            return { ok: true, why: "Its blog page is the version this page knows (stamp " +
              theirs + ")." };
          }
          return { ok: true, warn: true, why: "Its blog page is from a DIFFERENT publish " +
            "than this page: the folder says " + theirs + " and this page says " + mine +
            ". Check it is the clone you mean before you publish." };
        }, function () {
          return { ok: true, why: "It holds index.html and blog.html. Its blog page " +
            "could not be read." };
        });
    }, function () {
      return { ok: false, why: "That folder could not be read." };
    });
  }

  /* ---------------- writing back into the repo folder ----------------

     The other direction. A publish can hand its files to the browser as a
     zip, or write them straight into the repo folder through this.

     Why it exists: a downloaded zip carries the Mark of the Web, Windows
     copies that mark onto every file taken out of it, and it blocks a
     marked file whose type it treats as a script. A file written through
     the File System Access API never goes through the download manager,
     so it carries no mark. It also removes the extract step.

     What it does NOT do: delete. The tool proposes and the user decides.
     An image file nothing names any more is moved into deletethese/,
     which .gitignore keeps out of the repo, so the commit shows the file
     gone and the copy stays on disk until the person empties the folder.
     The blog's own orphans are still named for the user to remove. */
  var repoWriteDir = null;    /* the folder, once it may be written to */

  /* The two files that say this folder is the root of this site. A publish
     splices deployed bytes, so writing into the wrong folder would put a
     half-site somewhere it does not belong. */
  var ROOT_MARKS = ["index.html", "blog.html"];

  function repoHasRootMarks(handle) {
    return Promise.all(ROOT_MARKS.map(function (name) {
      return handle.getFileHandle(name).then(function () { return true; },
        function () { return false; });
    })).then(function (found) {
      return found.every(function (ok) { return ok; });
    });
  }

  /* Pick the repo folder for writing. Resolves with the handle, or null
     when the picker was closed. Rejects when the folder is not this repo
     or permission was refused, so a caller can say which happened. */
  function pickRepoWrite() {
    if (!hasPicker()) return Promise.reject(errObj("BLG-E04", "no folder picker in this browser"));
    return repoChoose("readwrite").then(function (handle) {
      if (!handle) return null;
      repoWriteDir = handle;
      /* one pick answers both directions: a later read needs no second
         dialog, which is what picking the folder once has to mean */
      if (!repoDir) repoDir = handle;
      return handle;
    });
  }

  /* Walk to the folder a path lives in, making each step that is missing.
     "blog/2607.html" makes blog/ when the repo has no month files yet. */
  function repoDirFor(parts) {
    var dir = Promise.resolve(repoWriteDir);
    parts.forEach(function (seg) {
      dir = dir.then(function (d) {
        return d.getDirectoryHandle(seg, { create: true });
      });
    });
    return dir;
  }

  /* Write one file. The stream truncates, so the file is replaced whole
     and never left with the tail of a longer previous version. */
  function writeOne(path, bytes) {
    var parts = path.split("/");
    var name = parts.pop();
    return repoDirFor(parts)
      .then(function (d) { return d.getFileHandle(name, { create: true }); })
      .then(function (fh) { return fh.createWritable(); })
      .then(function (stream) {
        return Promise.resolve(stream.write(bytes)).then(function () {
          return stream.close();
        });
      })
      .then(null, function (err) {
        throw errObj("BLG-E14", path + (err && err.message ? " (" + err.message + ")" : ""));
      });
  }

  /* Write every file of a bundle, in a fixed order so a failure leaves a
     state that can be described. Resolves with the paths written. The
     caller must have picked the folder first. */
  function writeRepo(files) {
    if (!repoWriteDir) return Promise.reject(errObj("BLG-E12", "no folder was picked"));
    var names = Object.keys(files).sort();
    var written = [];
    return names.reduce(function (chain, name) {
      return chain.then(function () {
        return writeOne(name, files[name]).then(function () { written.push(name); });
      });
    }, Promise.resolve()).then(function () { return written; },
      function (err) { err.written = written; throw err; });
  }
  function repoWriteReady() { return !!repoWriteDir; }

  /* Walk to a folder that is already there. repoDirFor makes each missing
     step, which a read must never do. */
  function repoDirAt(parts) {
    var dir = Promise.resolve(repoWriteDir);
    parts.forEach(function (seg) {
      dir = dir.then(function (d) { return d.getDirectoryHandle(seg); });
    });
    return dir;
  }

  /* The files directly inside one folder of the repo, as sorted repo
     paths. A folder that is not there holds no files. */
  function repoList(dir) {
    var names = [];
    return repoDirAt(dir.split("/")).then(function (d) {
      var walk = d.values();
      function step() {
        return walk.next().then(function (r) {
          if (r.done) return names.sort();
          if (r.value.kind === "file") names.push(dir + "/" + r.value.name);
          return step();
        });
      }
      return step();
    }, function (err) {
      if (err && err.name === "NotFoundError") return [];
      throw err;
    });
  }

  /* One text file of the repo folder. Rejects when it cannot be read. */
  function repoReadText(path) {
    var parts = path.split("/");
    var name = parts.pop();
    return repoDirAt(parts)
      .then(function (d) { return d.getFileHandle(name); })
      .then(function (fh) { return fh.getFile(); })
      .then(function (file) { return file.text(); });
  }

  /* Move files into deletethese/, each at its own path. A move is a copy
     and then a removal: a folder handle has no rename that crosses folders.
     The first failure stops the run and names its file, so the folder is
     left in a state that can be described. Resolves the paths moved. */
  function repoMove(paths) {
    var moved = [];
    return (paths || []).reduce(function (chain, path) {
      return chain.then(function (stopped) {
        if (stopped) return true;
        var parts = path.split("/");
        var name = parts.pop();
        return repoDirAt(parts).then(function (d) {
          return d.getFileHandle(name)
            .then(function (fh) { return fh.getFile(); })
            .then(function (file) { return file.arrayBuffer(); })
            .then(function (buf) { return writeOne(engine().DELETE_DIR + path, new Uint8Array(buf)); })
            .then(function () { return d.removeEntry(name); });
        }).then(function () {
          moved.push(path);
          return false;
        }, function (err) {
          console.warn("[site editor] " + path + " could not be moved into " +
            engine().DELETE_DIR + " (" + (err && err.message ? err.message : err) +
            "). It is still where it was.");
          return true;
        });
      });
    }, Promise.resolve(false)).then(function () { return moved; });
  }

  /* THE IMAGE FILES NOTHING NAMES, MOVED ASIDE.

     After a save, the folder is read back: every file in img/work/ and in
     blog/, and every managed page and month file that could name one. A
     file the image engine named that no page names any more is moved into
     deletethese/. A file named any other way is never touched.

     A read that fails cancels the scan for this save, with a console line,
     and moves nothing: a page that could not be read may be the one that
     names a file. Resolves the paths moved, and never rejects, because the
     save itself has already succeeded. */
  function moveOrphans() {
    if (!AMH.images) return Promise.resolve([]);
    var listing = [];
    return Promise.all([repoList("img/work"), repoList("blog")]).then(function (both) {
      listing = both[0].concat(both[1]);
      var pages = MANAGED_PAGES.map(function (pg) { return pg.path; })
        .concat(both[1].filter(function (p) { return /\.html$/.test(p); }));
      return Promise.all(pages.map(repoReadText));
    }).then(function (texts) {
      return repoMove(engine().orphans(listing, texts));
    }).then(null, function (err) {
      console.warn("[site editor] the scan for image files nothing uses was skipped " +
        "for this save (" + (err && err.message ? err.message : err) + "). Nothing was moved.");
      return [];
    });
  }

  /* The image files the pages being written stop naming, found from the
     pages themselves, before and after, so it needs no folder. A route
     that cannot move a file names them in the console instead. Another
     page may still name one, which is why the words say "these pages". */
  function sayDropped(built) {
    if (!AMH.images) return;
    var listing = [], texts = [];
    built.forEach(function (b) {
      listing = listing.concat(engine().named(b.before || ""));
      texts.push(b.text);
    });
    var gone = engine().orphans(listing, texts);
    if (!gone.length) return;
    console.info("[site editor] these pages no longer name " + gone.length +
      " image file(s):\n  " + gone.join("\n  ") + "\n\nSave to repo moves such files into " +
      engine().DELETE_DIR + ". From a download, move them there yourself before you commit.");
  }
  /* THE FOLDER DECISION, WRITTEN ONCE.

     The same question is asked in two places: a box of its own, and
     inline in a file dialog that is already on screen. They differ only
     in what holds the two buttons, so the caller gives the surface and
     this gives the answer.

     settle(handle) means take this folder. settle(null) means the reader
     wants a different one. Neither is called until the checks pass, so a
     stale or wrong folder never resolves as good. */
  function repoConfirmWire(handle, mode, use, other, setNote, settle) {
    /* THE ACCENT MOVES; IT DOES NOT MULTIPLY.
       A remembered folder that fails its checks makes "choose a different
       folder" the one move of this surface. Each surface fills exactly one
       control, so the accent is taken off the button it leaves, and that
       button is disabled because it has nothing left to do.
       Four branches reach this state, which is why it is written once. */
    function handOver() {
      use.disabled = true;
      use.className = "ced-btn";
      other.className = "ced-btn ced-btn--accent";
    }
    /* the browser may still hold permission, and then the folder can be
       read before the click and the verdict shown with the question */
    repoWritableNow(handle, mode).then(function (granted) {
      if (!granted) return;
      return repoVerify(handle).then(function (v) {
        setNote(v.why);
        if (!v.ok) handOver();
      });
    });

    other.addEventListener("click", function () { settle(null); });
    use.addEventListener("click", function () {
      use.disabled = true;
      setNote("Checking the folder...");
      repoWritable(handle, mode).then(function (granted) {
        if (!granted) {
          setNote(errText("BLG-E12", ""));
          handOver();
          return;
        }
        return repoVerify(handle).then(function (v) {
          if (v.ok) { settle(handle); return; }
          setNote(v.why);
          handOver();
        });
      }, function () {
        setNote(errText("BLG-E12", ""));
        handOver();
      });
    });
  }

  /* The step that offers the folder this browser remembers. Resolves the
     handle to use, or null to open the picker instead. It never resolves a
     folder that failed its checks: a stale or wrong folder sends the
     reader to the picker with the reason on screen.

     This is the box. A file dialog that is already on screen asks the
     same question inline instead, through repoConfirmWire, and never
     reaches here. The write route does reach here: it asks during the
     write, where there is no file dialog to hold an offer. */
  function repoConfirmStep(handle, mode) {
    return new Promise(function (resolve) {
      injectStyles();
      /* the same offer as the hand-off dialog: a stage in the shell when
         one is on screen, a box of its own when there is not */
      var host = hostFn && hostFn();
      var stage = host ? host.open("folder", handle.name || "(unnamed)") : null;
      var box = null, head, body, btns;
      if (stage) {
        head = stage.head; body = stage.body; btns = stage.btns;
      } else {
        box = doc.createElement("div");
        box.className = "ced-modal ced-handoff";
        head = doc.createElement("div");
        head.className = "ced-modal__head";
        body = box;
        btns = doc.createElement("div");
        btns.className = "ced-modal__btns";
      }
      head.innerHTML = '<span class="ced-b">FOLDER</span><span class="ced-slug">' +
        escAttr(handle.name || "(unnamed)") + "</span>";
      var note = doc.createElement("div");
      note.className = "ced-modal__status";
      note.textContent = "This browser remembers this folder from a previous visit. " +
        "It is checked before it is used.";
      var other = doc.createElement("button");
      other.type = "button";
      other.className = "ced-btn";
      other.textContent = "Pick a different folder";
      var spacer = doc.createElement("span");
      spacer.className = "ced-spacer";
      var use = doc.createElement("button");
      use.type = "button";
      use.className = "ced-btn ced-btn--accent";
      use.textContent = "Use the saved folder";

      /* Once only, for the reason given on the hand-off dialog's own done:
         a check still in flight must not take the ground twice. */
      var shut = false;
      function done(answer) {
        if (shut) return;
        shut = true;
        dialogDown(escMe);
        if (host) { host.close(); }
        else {
          scrimDown();
          if (box.parentNode) box.parentNode.removeChild(box);
        }
        resolve(answer);
      }
      /* Escape means the same as "Pick a different folder": not this
         folder, so open the picker. */
      function escMe() { done(null); }
      repoConfirmWire(handle, mode, use, other,
        function (t) { note.textContent = t; }, done);

      btns.appendChild(other); btns.appendChild(spacer); btns.appendChild(use);
      if (box) box.appendChild(head);
      body.appendChild(note);
      if (box) {
        box.appendChild(btns);
        gripAdd(box);
        scrimUp();
        doc.body.appendChild(box);
      }
      dialogUp(escMe);
      use.focus();
    });
  }

  /* Permission as it stands, asking nothing. Used before the click, where
     a request would be refused for want of a gesture. */
  function repoWritableNow(handle, mode) {
    if (!handle.queryPermission) return Promise.resolve(true);
    return handle.queryPermission({ mode: mode }).then(
      function (s) { return s === "granted"; }, function () { return false; });
  }
  /* Permission, asking for it when it is not held. Only from a click. */
  function repoWritable(handle, mode) {
    if (!handle.queryPermission) return Promise.resolve(true);
    return handle.queryPermission({ mode: mode }).then(function (s) {
      if (s === "granted") return true;
      return handle.requestPermission({ mode: mode })
        .then(function (a) { return a === "granted"; });
    });
  }

  /* The folder, from memory when one is remembered and the reader says
     yes, and from the picker otherwise. One place, so the read path and
     the write path remember and check the same way. */
  function repoChoose(mode) {
    var fresh = function () {
      return window.showDirectoryPicker({ id: "amh-repo", mode: mode }).then(
        function (handle) {
          return repoWritable(handle, mode).then(function (granted) {
            if (!granted) throw errObj("BLG-E12", "");
            return repoVerify(handle).then(function (v) {
              if (!v.ok) throw errObj("BLG-E13", "");
              repoRemember(handle);
              return handle;
            });
          });
        },
        function (err) {
          if (err && err.name === "AbortError") return null;
          if (err && err.code) throw err;
          throw errObj("BLG-E04", err && err.message ? err.message : "");
        });
    };
    /* A folder already in hand IS the folder. Read and write are two
       permissions on one handle, not two folders, so the second ask raises
       the permission on the handle the reader already chose rather than
       opening the picker on it again. The handle was checked when it was
       picked, and it is the same folder, so it is not checked twice. */
    var inHand = repoWriteDir || repoDir;
    if (inHand) {
      return repoWritable(inHand, mode).then(function (granted) {
        /* a refused raise is a real answer: the picker is how the reader
           gives a different folder, or the same one with more permission */
        return granted ? inHand : fresh();
      }, fresh);
    }
    /* Once for each mode, not once for the page. One flag for both meant a
       read pick used up the offer and the write ask went straight to the
       picker, on a folder that was already chosen. */
    if (repoOffered[mode]) return fresh();
    repoOffered[mode] = true;
    return repoRecall().then(function (handle) {
      if (!handle) return fresh();
      return repoConfirmStep(handle, mode).then(function (ok) {
        if (!ok) return fresh();
        repoRemember(handle);
        return handle;
      });
    }, fresh);
  }

  /* Pick the folder with the API, so the browser opens only the files that
     are asked for and never counts the tree. Resolves with the count taken,
     or null when the picker was closed. A browser with no API needs a
     folder input, which each caller owns. */
  function pickRepo(paths) {
    return repoChoose("read").then(function (handle) {
      return handle ? takeDirectory(handle, paths) : null;
    });
  }
  /* The one label the arrow gives the folder button, wherever the button
     is. One pick answers every ask, and the root of the repo is the folder
     to pick, which the button alone does not say. */
  /* The folder button's note reads the state it is in. With no folder
     remembered it is an instruction; once one is chosen and the step is
     still open, the same button is the way on, so the note stops telling
     the reader to do what they have already done. */
  var REPO_LABEL = "Click and pick root of repo folder!";
  var REPO_SET_LABEL = "You're all set!";
  function pointRepo(btn) { pointAt(btn, repoDir ? REPO_SET_LABEL : REPO_LABEL); }

  /* The dialog itself: drop, choose, or pick the repo folder. */
  function handOffDialog(path, want, mayBeAbsent, netErr) {
    if (netErr) errText("BLG-E01", "Wanted: " + want + ".");

    return new Promise(function (resolve, reject) {
      injectStyles();
      guardDocumentDrops();

      /* A shell on screen holds this dialog as a stage of its own, so the
         reader answers it inside the box they are already looking at. With
         no shell there is a box, which is what a page opened from disk
         gets when edit.export() asks for a file. */
      var host = hostFn && hostFn();
      var stage = host ? host.open("file", want) : null;
      var box = null, title, body, btns;
      if (stage) {
        title = stage.head; body = stage.body; btns = stage.btns;
      } else {
        box = doc.createElement("div");
        box.className = "ced-modal ced-handoff";
        /* ced-modal__head, not ced-modal__title: the second has no rules
           anywhere in this file, which is why the badge and the name used
           to run together with no padding. */
        title = doc.createElement("div");
        title.className = "ced-modal__head";
        /* the box IS the body when it stands alone, so the same appends
           below serve both shapes */
        body = box;
        btns = doc.createElement("div");
        btns.className = "ced-modal__btns";
      }
      title.innerHTML = '<span class="ced-b">FILE</span><span class="ced-slug">' +
        escAttr(want) + "</span>" + stepLabel(path);

      var zone = doc.createElement("div");
      zone.className = "ced-handoff__zone";
      zone.setAttribute("tabindex", "0");
      zone.setAttribute("role", "button");
      zone.innerHTML = "<strong>Drop <code>" + escAttr(want) + "</code> here</strong>" +
        "<span>or click to choose it</span>";

      /* The remembered folder is offered here, above the drop zone, because
         it is the faster answer and the zone is the fallback. It is empty
         and hidden until the recall answers. */
      var offer = doc.createElement("div");
      offer.className = "ced-handoff__offer";
      offer.hidden = true;

      var note = doc.createElement("div");
      note.className = "ced-modal__status";
      /* the same sentence the wizard's progress row answers to: the two
         boxes are one job, and each says so */
      note.textContent = (required().length > 1
        ? "This publish needs the deployed bytes of these files. Give it the files from " +
          "your repo, or give it the repo folder once."
        : "This publish needs the deployed bytes of this file. Give it the file from " +
          "your repo, or give it the repo folder once.") +
        (mayBeAbsent ? " This file may not exist yet. If it does not, say so, and " +
                       "the publish creates it." : "");

      var list = doc.createElement("div");
      list.className = "ced-handoff__list";
      list.innerHTML = listMarkup(path);

      var input = doc.createElement("input");
      input.type = "file";
      input.accept = ".html,text/html";
      input.style.display = "none";

      var folder = doc.createElement("input");
      folder.type = "file";
      folder.setAttribute("webkitdirectory", "");
      folder.setAttribute("directory", "");
      folder.style.display = "none";

      /* THE TWO VERBS.
         Pick opens a picker. Use accepts something this browser already
         has. The editor asks for a folder on four surfaces, and one verb
         used to mean both jobs: "use my repo folder" opened a picker while
         "use this folder" accepted a folder already saved.
           Pick this file, Pick my repo folder, Pick a different folder
           Use the saved folder
         "Write into my repo folder" on the wizard's route step is a
         delivery choice and not a pick, so it keeps its own verb. */
      var pick = doc.createElement("button");
      pick.type = "button";
      pick.className = "ced-btn ced-btn--accent";
      pick.textContent = "Pick this file";
      var all = doc.createElement("button");
      all.type = "button";
      all.className = "ced-btn";
      all.textContent = "Pick my repo folder";
      all.title = "Pick the root of your repo folder one time. The publish reads only the " +
        "files it needs from it, and does not ask again.";
      var spacer = doc.createElement("span");
      spacer.className = "ced-spacer";
      /* An optional file needs an answer that is not "give up". Cancel
         abandons the publish; this says the file is not there, which is a
         fact about the repo rather than a change of mind. */
      var absent = null;
      if (mayBeAbsent) {
        absent = doc.createElement("button");
        absent.type = "button";
        absent.className = "ced-btn";
        absent.textContent = "Not on disk yet";
        absent.title = "The publish creates this file.";
      }

      var cancel = doc.createElement("button");
      cancel.type = "button";
      cancel.className = "ced-btn";
      cancel.textContent = "Cancel";

      /* the wizard's progress step listens: its current row says the build
         is waiting while this dialog is up */
      function announce(open) {
        doc.dispatchEvent(new CustomEvent("ced:handoff", { detail: { path: path, open: open } }));
      }
      /* Once only. A file read still in flight when Escape closes the box
         calls this again when it lands, and a second pass would take the
         ground away from a box that is still open and leave modalOpen
         stuck true, which costs Escape for the rest of the page load. */
      var shut = false;
      function done() {
        if (shut) return;
        shut = true;
        unpoint();
        dialogDown(escMe);
        /* the shell owns its own ground, so only a box of our own claimed
           one and only a box of our own gives it back */
        if (host) { host.close(); }
        else {
          scrimDown();
          if (box.parentNode) box.parentNode.removeChild(box);
        }
        announce(false);
      }
      /* Escape means the same as Cancel: the publish is given up, and it
         says so with the same code. The stack decides whether this dialog
         is the one in front. */
      function escMe() {
        done();
        reject(errObj("BLG-E07", "Wanted: " + want + "."));
      }
      function fail(code, extra) {
        note.textContent = errText(code, extra);
        zone.classList.add("is-wrong");
      }

      /* Take one file for THIS step. */
      function take(file) {
        if (!file) { fail("BLG-E02"); return; }
        if (file.name !== want) {
          fail("BLG-E03", 'You gave "' + file.name + '". This step needs "' + want + '".');
          return;
        }
        readFile(file).then(function (text) {
          verifyWarn(path, want, text);
          handed[path] = text;
          done();
          resolve(text);
        }, function () { fail("BLG-E04"); });
      }

      /* Every path this publish still needs from a folder: the whole list
         when the caller gave one, else this file. */
      var wanted = expected.length ? expected : [path];
      /* After a folder was read: close if the file this step is for came
         out of it, else say the folder was the wrong one. */
      function folderDone(took) {
        if (!handed[path]) {
          fail("BLG-E08", "Wanted: " + want + "." +
            (took ? " Found " + took + " other file(s) it needs." : ""));
          return;
        }
        console.info("[site editor] took " + took + " file(s) from the folder; " +
          "this publish will not ask again.");
        done();
        resolve(handed[path]);
      }
      /* The API when the browser has one, else the folder input, which
         reads everything under the folder. */
      function pickFolder() {
        if (!hasPicker()) { folder.click(); return; }
        pickRepo(wanted).then(function (took) {
          if (took !== null) folderDone(took);   /* null: closed the picker */
        }, function (err) {
          note.textContent = err.message;
          zone.classList.add("is-wrong");
        });
      }

      zone.addEventListener("click", function () { input.click(); });
      zone.addEventListener("keydown", function (e) {
        if (e.key === "Enter" || e.key === " " || e.key === "Spacebar") {
          e.preventDefault(); input.click();
        }
      });
      pick.addEventListener("click", function () { input.click(); });
      all.addEventListener("click", pickFolder);
      input.addEventListener("change", function () { take(input.files && input.files[0]); });
      folder.addEventListener("change", function () {
        takeFolder(folder.files, wanted).then(folderDone);
      });

      zone.addEventListener("dragover", function (e) {
        e.preventDefault(); e.stopPropagation();
        e.dataTransfer.dropEffect = "copy";
        zone.classList.add("is-over");
      });
      zone.addEventListener("dragleave", function () { zone.classList.remove("is-over"); });
      zone.addEventListener("drop", function (e) {
        e.preventDefault(); e.stopPropagation();
        zone.classList.remove("is-over", "is-wrong", "is-warn");
        take(e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]);
      });
      if (absent) {
        absent.addEventListener("click", function () {
          skipped[path] = true;
          errText("BLG-E09", "Wanted: " + want + ".");
          done();
          resolve(null);
        });
      }
      cancel.addEventListener("click", function () {
        done();
        reject(errObj("BLG-E07", "Wanted: " + want + "."));
      });

      btns.appendChild(pick);
      btns.appendChild(all);
      if (absent) btns.appendChild(absent);
      btns.appendChild(spacer);
      btns.appendChild(cancel);
      /* head first, buttons last, and the rest between: in a box of our own
         the body IS the box, so this one order serves both shapes */
      if (box) box.appendChild(title);
      body.appendChild(offer);
      body.appendChild(zone);
      body.appendChild(note);
      if (list.innerHTML) body.appendChild(list);
      body.appendChild(input);
      body.appendChild(folder);
      if (box) {
        box.appendChild(btns);
        gripAdd(box);
        scrimUp();
        doc.body.appendChild(box);
      }
      dialogUp(escMe);
      zone.focus();
      announce(true);
      /* The first ask of a page load points at the folder button. One pick
         answers every ask, and that is the thing a person cannot know from
         the dialog alone. */
      if (!Object.keys(handed).length && !repoDir) pointRepo(all);
      offerRemembered();

      /* THE FOLDER QUESTION, ANSWERED IN THIS BOX.

         A remembered folder used to be confirmed in a box of its own, on
         top of this one: a whole layer for a yes or no about a folder the
         reader is already looking at. It is the same question, so it is
         asked here.

         Only the read route can do this. The write route asks during the
         write, where no file dialog is on screen to hold an offer, so it
         keeps the box. See repoConfirmStep.

         Showing the offer spends it. A reader who ignores it and presses
         "Pick my repo folder" wants a different folder, and repoChoose
         then goes straight to the picker. */
      function offerRemembered() {
        if (!hasPicker() || repoDir || repoOffered.read) return;
        repoRecall().then(function (handle) {
          /* the recall is asynchronous, so the dialog may already be
             answered. shut says so whether it was a box or a stage. */
          if (!handle || shut) return;
          repoOffered.read = true;
          drawOffer(handle);
        });
      }

      function drawOffer(handle) {
        var ask = doc.createElement("strong");
        ask.textContent = "Use " + (handle.name || "the remembered folder") + "?";
        var why = doc.createElement("span");
        why.className = "ced-handoff__why";
        why.textContent = "This browser remembers this folder from a previous visit. " +
          "It is checked before it is used.";
        var row = doc.createElement("div");
        row.className = "ced-handoff__offerbtns";
        var use = doc.createElement("button");
        use.type = "button";
        use.className = "ced-btn ced-btn--accent";
        use.textContent = "Use the saved folder";
        var other = doc.createElement("button");
        other.type = "button";
        other.className = "ced-btn";
        other.textContent = "Pick a different folder";
        row.appendChild(use); row.appendChild(other);
        offer.appendChild(ask); offer.appendChild(why); offer.appendChild(row);
        offer.hidden = false;

        repoConfirmWire(handle, "read", use, other,
          function (t) { why.textContent = t; },
          function (answer) {
            offer.hidden = true;
            unpoint();
            if (!answer) { pickFolder(); return; }
            /* the checks passed inside the wire, so this is the folder */
            repoRemember(answer);
            takeDirectory(answer, wanted).then(folderDone, function (err) {
              note.textContent = err && err.message ? err.message : String(err);
              zone.classList.add("is-wrong");
            });
          });

        /* The arrow moves to the faster answer. The folder is set, it is
           only not loaded, so REPO_SET_LABEL is the true thing to say.
           It points from the left, because the drop zone and its own words
           are directly below this button and the label would land on top
           of them. */
        if (!Object.keys(handed).length) {
          pointAt(use, REPO_SET_LABEL, { prefer: "left" });
        }
      }
    });
  }

  function readFile(file) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () { resolve(String(fr.result)); };
      fr.onerror = function () { reject(errObj("BLG-E04", file.name)); };
      fr.readAsText(file);
    });
  }

  /* "2 of 4", when the caller said what it would need. */
  /* "2 of 3", counting only the files that have to exist. A file that may
     legitimately be absent is not a step, and counting it makes the dialog
     claim there is more to do than there is. */
  function stepLabel(path) {
    var must = required();
    if (must.length < 2) return "";
    var at = must.indexOf(path);
    if (at < 0) return "";
    return ' <span class="ced-handoff__count">file ' + (at + 1) + " of " + must.length + "</span>";
  }

  /* The whole list, with what is in hand ticked off and what is not there
     marked as such. */
  function listMarkup(path) {
    if (required().length < 2) return "";
    return expected.map(function (pp) {
      var name = pp.replace(/^.*\//, "");
      var state = handed[pp] ? "done"
        : skipped[pp] ? "none"
        : (pp === path ? "now" : "wait");
      return '<span class="ced-handoff__item is-' + state + '">' + escAttr(name) + "</span>";
    }).join("");
  }

  /* The tests drive the hand-off without a real drag: same path, same checks. */
  AMH.tool.handOff = handOff;
  /* A caller that knows every file it will need says so first, and the wizard
     shows progress instead of opening the same dialog once per file. */
  AMH.tool.expectFiles = expectFiles;
  /* Which of those files may legitimately not exist. */
  AMH.tool.expectOptional = expectOptional;
  AMH.tool.errorCodes = ERR;
  /* The wizard's Files step takes files the way the dialog does, before
     the build, so a page opened from disk meets one step and not a chain
     of dialogs. These are what it needs to do that. */
  AMH.tool.fromDisk = function () { return location.protocol === "file:"; };
  AMH.tool.hasRepo = function () { return !!repoDir; };
  AMH.tool.hasPicker = hasPicker;
  AMH.tool.pickRepo = pickRepo;
  AMH.tool.pickRepoWrite = pickRepoWrite;
  AMH.tool.writeRepo = writeRepo;
  AMH.tool.repoWriteReady = repoWriteReady;
  /* the remembered folder, for the suite and for a reader who wants it gone */
  AMH.tool.onDisk = onDisk;
  AMH.tool.repoRecall = repoRecall;
  AMH.tool.repoForget = repoForget;
  AMH.tool.repoVerify = repoVerify;
  /* The image files nothing names any more, moved into deletethese/. The
     blog's publish runs it after a folder write, the way a site save does. */
  AMH.tool.moveOrphans = moveOrphans;
  AMH.tool.takeFiles = takeFiles;
  AMH.tool.takeFolder = takeFolder;
  AMH.tool.fileState = function (path) {
    return handed[path] ? "done" : skipped[path] ? "none" : "wait";
  };
  AMH.tool.pointRepo = pointRepo;
  /* The staging layer. publish.js writes it and reads it back; the page
     reads through it at load. */
  AMH.tool.layer = layerRead;
  AMH.tool.layerSave = layerWrite;
  AMH.tool.layerKeep = layerKeep;
  AMH.tool.layerFile = layerFile;
  AMH.tool.layerApply = layerApply;
  function fetchPristine() { return pristine(currentPage()); }

  /* Edits waiting to be written to a page whose DOM is not on screen, keyed by
     page path: { "gallery.html": { "br-title": "<h3>New</h3>" } }.

     The page being viewed is not staged here. Its edits live in the region
     model, which also carries galleries and nested regions, and which the
     export splices through spliceAllEdits().

     It is filled from sessionStorage, so an edit made on one page travels
     with you to another, and the publish stages the generated highlights
     block the same way. */
  var staged = {};

  /* Stage one region edit for a managed page. Returns false, and stages
     nothing, when the page is not managed. */
  function stageEdit(path, slug, html) {
    if (!isManaged(path)) {
      console.warn("[site editor] refusing to stage " + slug + " for " + path +
        " - not a managed page.");
      return false;
    }
    if (!staged[path]) staged[path] = {};
    staged[path][slug] = html;
    return true;
  }

  AMH.tool.stage = stageEdit;

  /* ---------------- pending edits, across pages ---------------- */

  /* sessionStorage shape:

       { "index.html": {
           text:    { "hero-h1": "<h1>...</h1>" },
           gallery: { "fr3-gallery": [ {src, alt, caption}, ... ] }
       } }

     Text is the applied innerHTML. A gallery is its export form, which is the
     same list of strings the file gets, so a preview blob URL is never stored
     and never needs to be. sessionStorage is shared across pages of one site,
     survives a reload, and dies with the tab, which is the right lifetime for
     work that has not been exported yet.

     A page opened from disk has no proper origin and browsers treat its
     storage inconsistently. Every access is wrapped: on failure the editor
     warns once and carries on with in-memory edits, exactly as it did before
     this store existed. */
  var pendingBroken = false;

  function pendingWarn(err) {
    if (pendingBroken) return;
    pendingBroken = true;
    console.warn("[site editor] pending edits cannot be stored in this context (" +
      (err && err.message ? err.message : "storage unavailable") +
      "). Edits stay in memory on this page only, and are lost on navigation. " +
      "This is normal for a page opened from disk.");
  }

  function pendingRead() {
    var raw = null;
    try { raw = window.sessionStorage.getItem(PENDING_KEY); }
    catch (err) { pendingWarn(err); return {}; }
    if (!raw) return {};
    try {
      var all = JSON.parse(raw);
      return (all && typeof all === "object") ? all : {};
    } catch (err) {
      console.warn("[site editor] the pending-edit store was unreadable and has been dropped.");
      pendingWriteAll({});
      return {};
    }
  }

  function pendingWriteAll(all) {
    /* drop a page whose maps are both empty, so the count stays honest */
    Object.keys(all).forEach(function (path) {
      var pg = all[path] || {};
      var n = Object.keys(pg.text || {}).length + Object.keys(pg.gallery || {}).length +
              Object.keys(pg.list || {}).length;
      if (!n) delete all[path];
    });
    try {
      if (!Object.keys(all).length) window.sessionStorage.removeItem(PENDING_KEY);
      else window.sessionStorage.setItem(PENDING_KEY, JSON.stringify(all));
      return true;
    } catch (err) { pendingWarn(err); return false; }
  }

  /* Record one applied edit.

     kind is "text", "gallery" or "list". Two more ride with a gallery and
     are never counted on their own: "heads", the region's non-image fields,
     and "bytes", what its own kind serialized. */
  function pendingSet(path, kind, slug, value) {
    var all = pendingRead();
    if (!all[path]) all[path] = {};
    if (!all[path][kind]) all[path][kind] = {};
    all[path][kind][slug] = value;
    return pendingWriteAll(all);
  }

  /* Forget one edit, because it was reverted back to the published content. */
  function pendingDrop(path, kind, slug) {
    var all = pendingRead();
    if (all[path] && all[path][kind]) delete all[path][kind][slug];
    return pendingWriteAll(all);
  }

  function pendingDropPage(path) {
    var all = pendingRead();
    delete all[path];
    return pendingWriteAll(all);
  }

  function pendingClearAll() {
    try { window.sessionStorage.removeItem(PENDING_KEY); return true; }
    catch (err) { pendingWarn(err); return false; }
  }

  /* How much is waiting, and where. Used by the chip and the unload guard. */
  function pendingCount() {
    var all = pendingRead();
    var changes = 0, pages = 0;
    Object.keys(all).forEach(function (path) {
      var pg = all[path] || {};
      var n = Object.keys(pg.text || {}).length + Object.keys(pg.gallery || {}).length +
              Object.keys(pg.list || {}).length;
      if (n) { changes += n; pages++; }
    });
    return { changes: changes, pages: pages, byPage: all };
  }

  /* Record the current state of one region. Applying content that matches the
     published bytes is not an edit, so it drops the entry instead.

     A shared region is recorded for every managed page, not only this one.
     That is the whole mechanism: the edit is made once, on whichever page the
     user happens to be looking at, and the export writes it everywhere. */
  function pendingSyncRegion(r) {
    var here = currentPage();
    var paths = SHARED_SLUGS[r.slug]
      ? MANAGED_PAGES.map(function (pg) { return pg.path; })
      : [here];
    paths.forEach(function (path) {
      if (r.edited) pendingSet(path, "text", r.slug, r.current);
      else pendingDrop(path, "text", r.slug);
    });
  }

  /* Re-apply this page's pending edits, once, at load.

     Costs a casual visitor nothing: the store is empty for them and this
     returns before scanning anything. When there is work waiting it runs a
     full scan, so the restored edits land in the same region model an Apply
     would have produced, and the unload guard is armed because there is now
     unexported work on the page. */
  function pendingRestore() {
    var here = currentPage();
    var mine = pendingRead()[here];
    if (!mine) return 0;
    var texts = mine.text || {}, galleries = mine.gallery || {};
    var listed = mine.list || {};
    if (!Object.keys(texts).length && !Object.keys(galleries).length &&
        !Object.keys(listed).length) return 0;

    scan();
    var applied = 0, lost = [];

    /* Lists first. A block this puts back carries regions of its own, and a
       text or gallery edit waiting for one of them has to find it. */
    Object.keys(listed).forEach(function (name) {
      var st = lists[name];
      if (!st) { lost.push("list " + name); pendingDrop(here, "list", name); return; }
      var saved = listed[name];
      var want = saved.order || [];
      want.forEach(function (id) {
        if (st.order.indexOf(id) !== -1) return;
        var markup = (saved.added || {})[id];
        if (markup !== undefined) listInsert(st, id, markup, null);
      });
      st.order.slice().forEach(function (id) {
        if (want.indexOf(id) === -1) listRemove(st, id);
      });
      listReorder(st, want.filter(function (id) { return st.at[id]; }));
      if (listDirty(st)) applied++;
      else pendingDrop(here, "list", name);
    });

    Object.keys(texts).forEach(function (slug) {
      var r = null;
      regions.forEach(function (x) { if (x.slug === slug) r = x; });
      /* a slug that no longer exists is dropped, not applied: the page was
         redeployed under the edit and guessing where it went would be worse */
      if (!r) { lost.push(slug); pendingDrop(here, "text", slug); return; }
      if (r.generated) { lost.push(slug); pendingDrop(here, "text", slug); return; }
      r.el.innerHTML = texts[slug];
      r.current = r.el.innerHTML;
      r.edited = r.current !== r.original;
      relinkTplGalleries(r);
      if (r.edited) applied++;
      else pendingDrop(here, "text", slug);
    });

    Object.keys(galleries).forEach(function (slug) {
      var g = null;
      gals.forEach(function (x) { if (x.slug === slug) g = x; });
      if (!g) { lost.push(slug); pendingDrop(here, "gallery", slug); return; }
      /* the blob previews died with the old document, so each entry loads its
         real src from the server; a file not uploaded yet already has the
         missing-file warning, which is the right message */
      if (mine.heads && mine.heads[slug] !== undefined) g.head = mine.heads[slug];
      g.model = imageRegion.fromExportForm(galleries[slug], g.kind);
      g.model.forEach(function (en) { en.imgId = imageRegion.nextId(); });
      if (!g.model.length && !g.seeds.length && g.kind.mayBeEmpty) {
        g.model.push(imageRegion.emptySlot(g.kind));
      }
      renderGallery(g);
      if (imageRegion.dirty(g)) applied++;
      else pendingDrop(here, "gallery", slug);
    });

    /* A photo the editor holds comes back from its own store a moment
       later. Until it does, the entry asks the server for a file that a
       save has not written yet. */
    if (Object.keys(galleries).length) {
      engine().recall().then(function () {
        gals.forEach(function (g) { if (photoLink(g)) renderGallery(g); });
        photoPrune();
      });
    }

    if (lost.length) {
      console.warn("[site editor] these pending edits no longer match this page and were dropped: " +
        lost.join(", "));
    }
    if (applied) {
      exportedClean = false;
      armGuard();
      console.info("[site editor] restored " + applied + " pending edit(s) on " + here +
        ". Run edit() to see them, or edit.export() to write them out.");
    }
    return applied;
  }

  function pendingSyncGallery(g) {
    var path = currentPage();
    if (imageRegion.dirty(g)) {
      var form = imageRegion.exportForm(g.model, g.kind);
      pendingSet(path, "gallery", g.slug, form);
      /* What this kind writes, written here, on the page that has the kind.
         Kept with no indent; the splice adds the target file's own. */
      pendingSet(path, "bytes", g.slug,
        imageRegion.serializeFor(form, "", g.kind, g.head));
      if (g.head) pendingSet(path, "heads", g.slug, g.head);
    } else {
      pendingDrop(path, "gallery", g.slug);
      pendingDrop(path, "bytes", g.slug);
      pendingDrop(path, "heads", g.slug);
    }
  }

  /* Record one list's shape. The order and what was added are enough: the
     page the export reads supplies the bytes of everything else. */
  function pendingSyncList(st) {
    var path = currentPage();
    if (listDirty(st)) {
      pendingSet(path, "list", st.name,
        { order: st.order, added: st.added, removed: st.removed });
    } else pendingDrop(path, "list", st.name);
  }

  /* Every page this operation must write. A page with nothing changed is
     never fetched and never enters a bundle. */
  function changedPages() {
    var seen = {};
    var here = currentPage();
    if (regions.some(function (r) { return r.edited; }) || gals.some(galDirty) ||
        listsDirty()) {
      seen[here] = true;
    }
    Object.keys(staged).forEach(function (path) {
      if (Object.keys(staged[path]).length) seen[path] = true;
    });
    /* edits made on another page during this sitting; the page being viewed is
       already covered by its own live model above */
    var waiting = pendingCount().byPage;
    Object.keys(waiting).forEach(function (path) {
      if (path !== here && isManaged(path)) seen[path] = true;
    });
    return Object.keys(seen).sort();
  }

  /* Splice edits into a page whose DOM we do not have.

     A gallery is written from its export form through the same serializer the
     live path uses, reading the indent from the source span, so a gallery
     edited on another page comes out byte-for-byte as if it had been edited
     here. */
  /* Slugs the export may skip instead of failing on.

     A shared region is staged for every managed page. A page that does not
     carry it - one with no contact section, or one where the region was
     removed on purpose - is not an error: that copy does not belong there.
     Losing a whole export over it would be the worse outcome.

     A generated block is optional for the same reason, and for a sharper
     one: deleting the highlights region must never cost someone the post
     they were publishing when they found out.

     An edit to a region on the page being viewed is never optional. It is on
     screen, it was edited, and a splice that cannot find it means something
     is wrong that the user needs to hear about. */
  var OPTIONAL_SLUGS = { "blog-highlights": 1 };
  function optionalSlug(slug) { return !!(SHARED_SLUGS[slug] || OPTIONAL_SLUGS[slug]); }

  function spliceStaged(src, edits, galleries, extras) {
    var failed = [], skipped = [];
    var more = extras || {};
    Object.keys(more.lists || {}).forEach(function (name) {
      var out = spliceList(src, name, more.lists[name]);
      if (out === null) failed.push("list " + name);
      else src = out;
    });
    Object.keys(edits || {}).forEach(function (slug) {
      var out = spliceRegion(src, slug, edits[slug]);
      if (out === null) (optionalSlug(slug) ? skipped : failed).push(slug);
      else src = out;
    });
    if (skipped.length) {
      console.warn("[site editor] this page does not carry: " + skipped.join(", ") +
        " - skipped, the rest of the page is written as normal.");
    }
    Object.keys(galleries || {}).forEach(function (slug) {
      var open = "<!--[edit:" + slug + "]-->";
      var a = src.indexOf(open);
      var b = a < 0 ? -1 : src.indexOf("<!--[/edit:" + slug + "]-->", a + open.length);
      if (a < 0 || b < 0) { failed.push(slug); return; }
      var im = /\n([ \t]*)</.exec(src.slice(a + open.length, b));
      var ind = im ? im[1] : "            ";
      /* The bytes this region's own kind wrote, when they were kept. The
         trunk that supplies a serializer is loaded on its own page only, so
         an export made from another page has none to ask. */
      var kept = (more.bytes || {})[slug];
      var out = spliceRegion(src, slug, kept !== undefined
        ? indentBlock(kept, ind)
        : imageRegion.serializeFor(galleries[slug], ind, kindForSlug(slug),
                                   (more.heads || {})[slug]),
        imageRegion.openAttrs((more.heads || {})[slug]));
      if (out === null) failed.push(slug);
      else src = out;
    });
    if (failed.length) {
      throw new Error("markers not found / unsliceable for: " + failed.join(", "));
    }
    return src;
  }

  /* Build the bytes for one changed page. */
  function buildPage(path) {
    var waiting = path === currentPage() ? {} : (pendingCount().byPage[path] || {});
    var texts = {};
    Object.keys(staged[path] || {}).forEach(function (s) { texts[s] = staged[path][s]; });
    Object.keys(waiting.text || {}).forEach(function (s) { texts[s] = waiting.text[s]; });
    return pristine(path).then(function (src) {
      /* before is kept so a route with no folder can say which files the
         page stops naming, without reading the page a second time */
      var before = src;
      if (path === currentPage()) src = spliceAllEdits(src);
      return { path: path, before: before, text: spliceStaged(src, texts, waiting.gallery,
        { lists: waiting.list, heads: waiting.heads, bytes: waiting.bytes }) };
    });
  }
  /* apply every outstanding copy/gallery edit to a pristine source string.
     Text regions first: a deepdive splice carries its template markup
     wholesale, then the nested dd-gallery splice corrects the image list. */
  function spliceAllEdits(src) {
    var failed = [];
    /* lists first: a region inside an item this adds has no markers to find
       until the item itself is in the text */
    Object.keys(lists).forEach(function (name) {
      if (!listDirty(lists[name])) return;
      var out = spliceList(src, name, lists[name]);
      if (out === null) failed.push("list " + name);
      else src = out;
    });
    regions.filter(function (r) { return r.edited; }).forEach(function (r) {
      var out = spliceRegion(src, r.slug, r.current);
      if (out === null) failed.push(r.slug);
      else src = out;
    });
    gals.filter(galDirty).forEach(function (g) {
      var out = spliceGallery(src, g);
      if (out === null) failed.push(g.slug);
      else src = out;
    });
    if (failed.length) {
      throw new Error("markers not found / unsliceable for: " + failed.join(", "));
    }
    return src;
  }
  /* Built pages as bytes, with the photos they show beside them at the
     path each src points to. */
  function bundleFiles(built, held) {
    var enc = new TextEncoder();
    var files = {};
    built.forEach(function (b) { files[b.path] = enc.encode(b.text); });
    Object.keys(held || {}).forEach(function (src) { files[src] = held[src]; });
    return files;
  }

  /* A page on its own downloads as itself, so the common case is
     unchanged. Anything more travels as one zip laid out the way the repo
     is, because the pages and their photos were edited together. */
  function downloadBundle(built, files) {
    var names = Object.keys(files).sort();
    if (names.length === 1 && built.length === 1) {
      downloadFile(built[0].path.replace(/^.*\//, ""), built[0].text, "text/html");
      return;
    }
    downloadFile("publish.zip", zipStore(names.map(function (name) {
      return { name: name, bytes: files[name] };
    })));
  }

  function downloadFile(name, data, type) {
    var blob = data instanceof Blob ? data : new Blob([data], { type: type || "application/octet-stream" });
    var a = doc.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    doc.body.appendChild(a);
    a.click();
    doc.body.removeChild(a);
    window.setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
  }

  /* ---------------- zip writer (STORE method, no compression) ----------------
     Not blog machinery: a multi-page export ships a zip too, and Phase 4
     adds a third page to the same bundle. */
  var zipCrcTable = null;
  function zipCrc32(bytes) {
    if (!zipCrcTable) {
      zipCrcTable = [];
      for (var n = 0; n < 256; n++) {
        var c = n;
        for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        zipCrcTable[n] = c >>> 0;
      }
    }
    var crc = 0xFFFFFFFF;
    for (var i = 0; i < bytes.length; i++) crc = zipCrcTable[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }
  /* entries: [{name, bytes: Uint8Array}] -> Blob. STORE only: images are
     already compressed and the text files are small. */
  function zipStore(entries) {
    var enc = new TextEncoder();
    var now = new Date();
    var dosTime = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) & 0xFFFF;
    var dosDate = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xFFFF;
    function u16(v) { return new Uint8Array([v & 255, (v >> 8) & 255]); }
    function u32(v) { return new Uint8Array([v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255]); }
    var chunks = [], central = [], offset = 0;
    entries.forEach(function (en) {
      var nameB = enc.encode(en.name);
      var crc = zipCrc32(en.bytes);
      central.push({ nameB: nameB, crc: crc, size: en.bytes.length, offset: offset });
      [u32(0x04034b50), u16(20), u16(0x0800), u16(0), u16(dosTime), u16(dosDate),
       u32(crc), u32(en.bytes.length), u32(en.bytes.length), u16(nameB.length), u16(0),
       nameB, en.bytes].forEach(function (p) { chunks.push(p); offset += p.length; });
    });
    var cdStart = offset, cdSize = 0;
    central.forEach(function (c) {
      [u32(0x02014b50), u16(20), u16(20), u16(0x0800), u16(0), u16(dosTime), u16(dosDate),
       u32(c.crc), u32(c.size), u32(c.size), u16(c.nameB.length), u16(0), u16(0), u16(0), u16(0),
       u32(0), u32(c.offset), c.nameB].forEach(function (p) { chunks.push(p); cdSize += p.length; });
    });
    [u32(0x06054b50), u16(0), u16(0), u16(central.length), u16(central.length),
     u32(cdSize), u32(cdStart), u16(0)].forEach(function (p) { chunks.push(p); });
    return new Blob(chunks, { type: "application/zip" });
  }

  /* ==========================================================
     7. PUBLIC API
     ----------------------------------------------------------
     Two surfaces. window.edit is the console entry: it is documented
     in docs/README.md and people type it, so the names here are
     permanent. AMH.tool is the editor kit, for a trunk that extends
     the editor rather than uses it.
     ========================================================== */
  var api = function () {
    injectStyles();
    scan();
    armGuard();
    active = !active;
    if (active) {
      buildUI();
      /* the blog stream renders an Edit button on each post while this is set */
      /* AMH.tool.editPost(id)
         blog.js renders an Edit button on each streamed post while this is
         set. Cleared on teardown, which is why the stream also strips the
         buttons it already drew. */
      AMH.tool.editPost = function (id) { api.blog.edit(id); };
      /* AMH.tool.newPost()
         blog.js draws a New post pill at the top and at the foot of the blog
         while this is set, and a pill opens the composer through it. */
      AMH.tool.newPost = function () { api.blog(); };
      /* the blog page renders its stream at load, before this point, so the
         posts already on screen have to be decorated now */
      if (AMH.blog && AMH.blog.editButtons) AMH.blog.editButtons();
      /* and the work that is built and not yet uploaded goes on screen
         with them: the layer is the author's, so it waits for the editor */
      if (AMH.publish && AMH.publish.staged) AMH.publish.staged();
      console.info("[site editor] ON - click a badge (or a row in the panel) to edit. edit.help() lists commands.");
    } else {
      AMH.tool.editPost = null;
      AMH.tool.newPost = null;
      /* strip the pills the blog drew while we were active: the Edit pill on
         each post, and the two New post pills */
      Array.prototype.forEach.call(
        doc.querySelectorAll(".bs-retry, .bs-newpost"),
        function (b) { b.remove(); });
      if (viewing === "before") api.after();   /* never leave the page showing the before view */
      /* unfilled (+) slots are editor scaffolding - never leave their
         "Drop image here" tiles in the visitor-facing carousels */
      gals.forEach(function (g) {
        if (g.model.some(function (e) { return e.empty; })) {
          g.model = g.model.filter(function (e) { return !e.empty; });
          renderGallery(g);
        }
      });
      teardownUI();
      console.info("[site editor] OFF" + (dirty() ? " - you still have unexported edits (edit.export())." : "."));
    }
    syncLauncher();
    return active ? "editor mode ON" : "editor mode OFF";
  };

  api.list = function () {
    scan();
    console.table(regions.map(function (r) {
      return { badge: r.badge, slug: r.slug, visible: r.visible, edited: r.edited };
    }));
    var imgRows = [];
    gals.forEach(function (g) {
      if (!g.model.length) {
        imgRows.push({ badge: "SEED", gallery: g.slug, src: "(placeholders)", caption: "", edited: galDirty(g) });
        return;
      }
      g.model.forEach(function (en) {
        imgRows.push({ badge: en.empty ? "SLOT" : en.imgId, gallery: g.slug,
                       src: en.src || "(empty)", caption: en.caption, edited: galDirty(g) });
      });
    });
    console.table(imgRows);
    return regions.length + " text regions (" +
      regions.filter(function (r) { return r.edited; }).length + " edited), " +
      gals.length + " galleries (" + gals.filter(galDirty).length + " edited).";
  };

  api.before = function () {
    scan();
    if (viewing === "before") return "already viewing BEFORE";
    viewing = "before";
    regions.forEach(function (r) { if (r.edited) r.el.innerHTML = r.original; });
    if (capEditing) capEditing(false);
    gals.forEach(function (g) {
      if (galDirty(g)) {
        var before = imageRegion.fromExportForm(g.original, g.kind);
        renderGallery(g, before.length ? before : g.seeds);
      }
      /* the before view is what is published, and nothing is edited there */
      captionPencil(g);
    });
    refreshDirtyUI(); requestReposition();
    return "viewing BEFORE (published content) - edit.after() to switch back";
  };
  api.after = function () {
    scan();
    if (viewing === "after") return "already viewing AFTER";
    viewing = "after";
    regions.forEach(function (r) { if (r.edited) r.el.innerHTML = r.current; });
    gals.forEach(function (g) {
      if (galDirty(g)) renderGallery(g);
      captionPencil(g);
    });
    refreshDirtyUI(); requestReposition();
    return "viewing AFTER (with your edits)";
  };

  /* Put the page being viewed back to its published content, and forget what
     was pending for it. Shared by revertAll and by clearing every page. */
  function revertThisPage() {
    if (viewing === "before") viewing = "after";
    regions.forEach(function (r) {
      if (r.edited || r.current !== r.original) {
        r.el.innerHTML = r.original;
        r.current = r.original; r.edited = false;
        relinkTplGalleries(r);
      }
    });
    gals.forEach(function (g) {
      if (!galDirty(g)) return;
      imageRegion.revert(g);
      renderGallery(g);
    });
    Object.keys(lists).forEach(function (n) {
      if (listDirty(lists[n])) listRevert(lists[n]);
      refreshPills(n);
    });
    pendingDropPage(currentPage());
    /* a photo only this page's edits showed is not held any more */
    photoPrune();
    refreshRegionRows();
    refreshImageRows();
    refreshDirtyUI(); requestReposition();
  }

  api.revertAll = function () {
    scan();
    var n = regions.filter(function (r) { return r.edited; }).length;
    var gn = gals.filter(galDirty).length;
    var ln = Object.keys(lists).filter(function (x) { return listDirty(lists[x]); }).length;
    if (!n && !gn && !ln) return "nothing to revert";
    if (!window.confirm("Revert ALL edits (" + n + " text region(s), " + gn +
        " gallery/ies, " + ln + " list(s)) to published content? This cannot be undone.")) {
      return "cancelled";
    }
    revertThisPage();
    return "reverted " + n + " text region(s), " + gn + " gallery/ies and " +
      ln + " list(s)";
  };

  /* edit.pending() - what is waiting, and on which pages */
  api.pending = function () {
    var c = pendingCount();
    if (!c.changes) { console.info("[site editor] nothing pending."); return "nothing pending"; }
    var lines = [];
    Object.keys(c.byPage).sort().forEach(function (path) {
      var pg = c.byPage[path];
      Object.keys(pg.text || {}).forEach(function (s) { lines.push("  " + path + "  " + s); });
      Object.keys(pg.gallery || {}).forEach(function (s) { lines.push("  " + path + "  " + s + "  (gallery)"); });
    });
    console.info("[site editor] " + pendingLabel(c) + ":\n" + lines.join("\n") +
      "\n\nedit.export() writes them all. edit.pending.clear() discards them.");
    return pendingLabel(c);
  };

  /* edit.pending.clear() - discard every pending edit, on every page */
  api.pending.clear = function () {
    var c = pendingCount();
    if (!c.changes && !dirty()) return "nothing pending";
    if (!window.confirm("Discard " + pendingLabel(c) +
        "? The page you are on is put back to its published content, and edits " +
        "waiting on other pages are forgotten. This cannot be undone.")) {
      return "cancelled";
    }
    scan();
    revertThisPage();
    pendingClearAll();
    photoPrune();
    exportedClean = true;
    refreshPendingChip();
    return "discarded " + pendingLabel(c);
  };

  api.clear = function () {
    try { localStorage.removeItem(QS_KEY); } catch (err) {}
    return "quicksave slot cleared";
  };

  api.export = function () {
    scan();
    if (viewing === "before") api.after();
    var edited = regions.filter(function (r) { return r.edited; });
    var editedGals = gals.filter(galDirty);
    var pages = changedPages();
    if (!pages.length) {
      console.warn("[site editor] no edits to export.");
      return "no edits to export";
    }
    console.info("[site editor] exporting " + edited.length + " text region(s) and " +
      editedGals.length + " gallery/ies; this export will write: " +
      pages.map(function (pg) { return pg + " (" + pageLabel(pg) + ")"; }).join(", "));
    Promise.all(pages.map(buildPage))
      .then(function (built) {
        return photoFiles(pages).then(function (held) {
          var files = bundleFiles(built, held);
          downloadBundle(built, files);
          exportedClean = true;
          sayDropped(built);
          console.info("[site editor] exported " + Object.keys(files).sort().join(", ") +
            " with " + edited.length + " text region(s) and " + editedGals.length +
            " gallery/ies spliced in.");
        });
      })
      .catch(function (err) {
        console.error("[site editor] export failed: " + err.message +
          (location.protocol === "file:" ? " (export needs the page served over HTTP, not file://)" : ""));
      });
    return "export started (check downloads)";
  };

  /* ------------------------------------------------------------
     SAVE TO REPO

     Export hands the browser a download, and a download is a file the
     person then has to find and copy. This writes the same bytes straight
     into the repo folder instead.

     It is the site's save, and it is on every page. The blog's publish is a
     different job: it renders the month files, the feed, the sitemap and the
     search index from the manifest, and it owns them. This writes only the
     managed pages an edit has changed, so the two never reach for the same
     file. A page is built by buildPage, which is what the export uses, so
     the bytes are the export's bytes.

     A refused folder falls back to the download. The pages are built by the
     time the folder is asked for, and losing them to a refused permission
     would be the worst of both routes.

     A photo the editor holds goes with the page that shows it, into
     img/work/, as its three files. Paths are written in sorted order, so
     img/work/ comes before index.html: a failed photo stops the save
     before a page can point at a file that is not there.

     After a folder write, the image files nothing names any more move into
     deletethese/. See moveOrphans.
     ------------------------------------------------------------ */

  /* What the save did, for the caller that draws it. Resolves with
     { wrote: [path], moved: [path], fellBack: "reason" or null }, and
     rejects only when there was nothing to write or a page would not
     splice. */
  function saveToFolder() {
    scan();
    if (viewing === "before") api.after();
    var pages = changedPages();
    if (!pages.length) return Promise.reject(new Error("no edits to save."));
    return Promise.all(pages.map(buildPage)).then(function (built) {
      return photoFiles(pages).then(function (held) {
        return { built: built, files: bundleFiles(built, held) };
      });
    }).then(function (bundle) {
      var built = bundle.built, files = bundle.files;
      /* the download, for a browser with no picker and for a refused folder */
      function asZip(why) {
        downloadBundle(built, files);
        AMH.tool.markExported();
        sayDropped(built);
        return { wrote: [], moved: [], fellBack: why };
      }
      if (!hasPicker()) {
        return asZip("This browser has no folder picker, so the pages were " +
          "downloaded instead.");
      }
      var pick = repoWriteReady()
        ? Promise.resolve(true)
        : pickRepoWrite().then(function (handle) { return !!handle; });
      return pick.then(function (got) {
        if (!got) return asZip("The folder was not chosen, so the pages were downloaded instead.");
        return writeRepo(files).then(function (written) {
          AMH.tool.savedPages(written);
          if (AMH.images) AMH.images.saved(written);
          return moveOrphans().then(function (moved) {
            console.info("[site editor] written into the repo folder:\n  " +
              written.join("\n  ") +
              (moved.length ? "\n\nmoved into " + engine().DELETE_DIR + ", because nothing " +
                "names them any more:\n  " + moved.join("\n  ") : "") +
              "\n\nThe files are on disk and not live yet: the commit and the push " +
              "are still yours to make.");
            return { wrote: written, moved: moved, fellBack: null,
                     folder: repoWriteDir && repoWriteDir.name ? repoWriteDir.name : "" };
          });
        });
      }, function (err) {
        var why = (err && err.message ? err.message : String(err));
        console.warn("[site editor] folder write refused: " + why);
        return asZip(why + " The pages were downloaded instead.");
      });
    });
  }

  /* edit.save() - write every changed page into the repo folder */
  api.save = function () {
    saveToFolder().then(function (out) {
      if (out.fellBack) console.warn("[site editor] " + out.fellBack);
    }, function (err) {
      console.warn("[site editor] " + (err && err.message ? err.message : String(err)));
    });
    return "save started";
  };

  /* The composer is publish.js, and it needs the manifest and the reading
     engine as well as itself. All three are on the blog page and nowhere
     else, so say where to go rather than open something that cannot publish.

     The console names stay here whatever file answers them. edit.blog() is
     what people have learned to type. */
  var BLOG_PAGE = "blog.html";
  function onMonthPage() {
    return !!(doc.body && doc.body.classList.contains("blog-month"));
  }
  function blogHere() {
    /* A month page has a blogManifest of its own, holding its month list and
       nothing else. The composer needs the counters and the entries, which
       live on the blog page alone, so a month page is not its home however
       much its manifest tag looks like one. */
    if (onMonthPage()) {
      console.warn("[blog] this is a month page. The composer lives on " + BLOG_PAGE +
        ", which holds the counters and the entries.");
      return false;
    }
    if (AMH.publish && AMH.blog && doc.getElementById("blogManifest")) return true;
    console.warn("[blog] the composer lives on " + BLOG_PAGE +
      ", which holds the manifest, the reading engine and publish.js. Open " +
      BLOG_PAGE + " and run edit.blog() there.");
    return false;
  }
  var BLOG_ELSEWHERE = "the blog composer lives on " + BLOG_PAGE;

  api.blog = function () {
    /* A month page cannot publish, so a new post is written on the blog
       page, which opens the composer as it loads. */
    if (onMonthPage()) {
      location.href = "../" + BLOG_PAGE + "?edit=new";
      return "opening " + BLOG_PAGE + " for a new post";
    }
    if (!blogHere()) return BLOG_ELSEWHERE;
    injectStyles();
    scan();
    armGuard();
    AMH.publish.open(null);
    return "blog composer open";
  };
  /* edit.blog.edit("0007") - or click a post in the panel/stream */
  api.blog.edit = function (id) {
    /* A month page shows the post but cannot publish it. Rather than refuse,
       the work moves to the page that can: the blog page opens the composer
       on this post as it loads. */
    if (onMonthPage()) {
      location.href = "../" + BLOG_PAGE + "?edit=p" + id;
      return "opening " + BLOG_PAGE + " on p" + id;
    }
    if (!blogHere()) return BLOG_ELSEWHERE;
    return AMH.publish.edit(id);
  };
  /* re-render all month files with current chrome */
  api.blog.rebuild = function () {
    if (!blogHere()) return BLOG_ELSEWHERE;
    return AMH.publish.rebuild();
  };
  /* edit.blog.trace(true) prints a line for every read, splice and write of
     the next publish. The wizard's own steps are printed either way. */
  api.blog.trace = function (on) {
    if (!AMH.publish || !AMH.publish.trace) return "the publish engine is not on this page";
    return AMH.publish.trace(on);
  };

  api.help = function () {
    console.info(
      "edit()            toggle editor mode\n" +
      "edit.list()       table of all editable regions\n" +
      "edit.export()     download this page with your edits\n" +
      "edit.save()       write every changed page into the repo folder\n" +
      "edit.blog()       open the blog composer (publishes a zip bundle)\n" +
      "edit.blog.edit(id) edit a published post (also: panel/stream buttons)\n" +
      "edit.blog.rebuild() re-render all month files with current chrome\n" +
      "edit.blog.trace(true) print every read, splice and write of the next publish\n" +
      "edit.before()     view page as published\n" +
      "edit.after()      view page with your edits\n" +
      "edit.revertAll()  discard every applied edit\n" +
      "edit.clear()      wipe the quicksave slot");
    return "see console output above";
  };

  /* refuse to silently lose applied-but-unexported edits on close/refresh.
     Registered lazily on first activation: an always-present beforeunload
     listener would cost every casual visitor the back/forward cache. */
  var guardArmed = false;
  function armGuard() {
    if (guardArmed) return;
    guardArmed = true;
    window.addEventListener("beforeunload", function (e) {
      /* pending edits on OTHER pages count: leaving the site loses them, and
         they are invisible from here, which is exactly when a guard earns its
         keep. Navigating within the site is not a beforeunload. */
      if (dirty() || pendingCount().changes ||
          (AMH.publish && AMH.publish.dirty())) {
        e.preventDefault(); e.returnValue = "";
      }
    });
  }

  window.edit = api;

  /* ---------------- the tutorial arrow ----------------

     One pointer, one target. A curved stroke with a head and a handwritten
     label, drawn over the page to say "this one". It is a note left on top
     of the interface, not a part of it, which is why it is hand-drawn.

     pointAt(target, label, opts) shows it; unpoint() takes it away. One
     exists at a time, and a second pointAt moves it. It stands below the
     target when there is room, so it never covers the control beside the
     target, and takes a side or the top only when there is none. It follows
     the target on scroll and resize, and it leaves when the target is
     clicked or gone.

     The label shrinks to the room beside the tail, down to a floor, so a
     long one stays with the arrow instead of being clamped away from it.

     opts.size    scale of the drawing, 1 by default, .8 on a narrow screen
     opts.stay    true keeps it after the target is clicked
     opts.onHover true takes it away when the cursor reaches the target,
                  for a note whose job is done once the button is found */
  var PT_W = 170, PT_H = 90;   /* the drawing box, in CSS px at scale 1 */
  var PT_GAP = 6;              /* tip to target edge */
  var PT_LBL_GAP = 10;         /* tail end to the label's near edge */
  var PT_IN_MS = 1150;         /* head .15s, stroke .45s, label .55s, end to end */
  var PT_OUT_MS = 620;         /* the same three, the other way round */
  /* Each shape is one cubic, tail first, tip last, in box units, with where
     the box sits against the target and where the label hangs off the tail.
     The two "L" and "R" shapes are the mirror images, for a target near a
     screen edge, so the tail always swings toward the open side. */
  var PT_SHAPES = {
    below:  { d: [[160, 82], [120, 84], [70, 70], [34, 18]],   at: "bottom" },
    belowL: { d: [[10, 82], [50, 84], [100, 70], [136, 18]],   at: "bottom", end: true },
    right:  { d: [[166, 76], [130, 80], [84, 66], [36, 44]],   at: "right" },
    left:   { d: [[4, 76], [40, 80], [86, 66], [134, 44]],     at: "left",   end: true },
    above:  { d: [[20, 6], [60, 2], [120, 18], [150, 66]],     at: "top",    end: true },
    aboveR: { d: [[150, 6], [110, 2], [50, 18], [20, 66]],     at: "top" }
  };
  var ptEl = null, ptTarget = null, ptOpts = null, ptShape = "", ptFontAsked = false;
  var ptLeaving = null;        /* an arrow on its way out, until it is dropped */

  function ptReduced() {
    return !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  }
  /* The handwriting face, asked for once on first use. The fallback is a
     system script face, and nothing waits for the request. */
  function ptFont() {
    if (ptFontAsked) return;
    ptFontAsked = true;
    var l = doc.createElement("link");
    l.rel = "stylesheet";
    l.href = "https://fonts.googleapis.com/css2?family=Caveat:wght@600&display=swap";
    doc.head.appendChild(l);
  }
  /* Which shape fits: below by preference, then a side, then above. The
     mirror of a shape is chosen when the tail would leave the screen.

     The arrow is drawn over the page and knows nothing of what is under
     it, so a caller that does can name a side with opts.prefer. It is
     honored only when it fits on screen: a preference must not push the
     arrow out of the view. */
  function ptPick(r, s, prefer) {
    var vw = window.innerWidth, vh = window.innerHeight;
    var cx = r.left + r.width / 2;
    var needH = PT_H * s + PT_GAP + 8, needW = PT_W * s + PT_GAP + 8;
    if (prefer === "left" && r.left > needW) return "left";
    if (prefer === "right" && vw - r.right > needW) return "right";
    if (prefer === "above" && r.top > needH) return (cx - 150 * s > 8) ? "above" : "aboveR";
    if (vh - r.bottom > needH) return (cx + 140 * s + 8 < vw) ? "below" : "belowL";
    if (vw - r.right > needW) return "right";
    if (r.left > needW) return "left";
    return (cx - 150 * s > 8) ? "above" : "aboveR";
  }
  function ptBox(name, r, s) {
    var sh = PT_SHAPES[name], tip = sh.d[3];
    var cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    if (sh.at === "bottom") return [cx - tip[0] * s, r.bottom + PT_GAP - tip[1] * s];
    if (sh.at === "top") return [cx - tip[0] * s, r.top - PT_GAP - tip[1] * s];
    if (sh.at === "right") return [r.right + PT_GAP - tip[0] * s, cy - tip[1] * s];
    return [r.left - PT_GAP - tip[0] * s, cy - tip[1] * s];
  }
  /* Draw the shape: the curve, and a head turned to the curve's own
     direction at the tip, which for a cubic is the line from the last
     control point to the end. */
  function ptDraw(name) {
    var sh = PT_SHAPES[name], d = sh.d;
    var curve = ptEl.querySelector(".ced-point__curve");
    var head = ptEl.querySelector(".ced-point__head");
    curve.setAttribute("d", "M" + d[0][0] + " " + d[0][1] + " C" + d[1][0] + " " + d[1][1] + ", " +
      d[2][0] + " " + d[2][1] + ", " + d[3][0] + " " + d[3][1]);
    var deg = Math.atan2(d[3][1] - d[2][1], d[3][0] - d[2][0]) * 180 / Math.PI;
    head.setAttribute("transform", "translate(" + d[3][0] + " " + d[3][1] + ") rotate(" + deg.toFixed(1) + ")");
  }
  /* The label hangs off the tail, on the side away from the target, centred
     on the tail's height. The curve leaves the tail toward the target, so
     that side is always clear of the stroke. When the side has no room the
     label goes over or under the tail instead, and a last clamp keeps it on
     screen. Everything is measured, so no offset is a guess. */
  /* The label shrinks to the room beside the tail rather than being
     dragged away from it. A long one at the full size ran past the edge
     of the screen, and the clamp below then pulled it back until it sat
     apart from the arrow that was pointing for it.

     The room is the gap between the tail and the near edge of the screen,
     on the side the label hangs. One measurement answers it: the width at
     the full size gives the ratio, so nothing loops looking for a fit.

     It shrinks and never grows past the base, and it stops at a floor,
     because a label too small to read points at nothing. */
  var PT_LBL_PX = 22;      /* the label's own size, at scale 1 */
  var PT_LBL_MIN = 13;     /* it shrinks to fit, and no further */

  function ptFit(lbl, name, box, s) {
    var sh = PT_SHAPES[name];
    var tx = box[0] + sh.d[0][0] * s;
    var room = sh.end ? tx - PT_LBL_GAP - 8 : window.innerWidth - 8 - tx - PT_LBL_GAP;
    var base = PT_LBL_PX * s;
    lbl.style.fontSize = base + "px";
    var w = lbl.getBoundingClientRect().width;
    if (room <= 0 || w <= 0 || w <= room) return;
    lbl.style.fontSize = Math.max(PT_LBL_MIN, Math.floor(base * (room / w))) + "px";
  }

  function ptLabel(name, box, s) {
    var sh = PT_SHAPES[name];
    var lbl = ptEl.querySelector(".ced-point__label");
    ptFit(lbl, name, box, s);
    var lr = lbl.getBoundingClientRect();
    var lw = lr.width, lh = lr.height;
    var tx = box[0] + sh.d[0][0] * s, ty = box[1] + sh.d[0][1] * s;
    var vw = window.innerWidth, vh = window.innerHeight;
    var x = sh.end ? tx - PT_LBL_GAP - lw : tx + PT_LBL_GAP;
    var y = ty - lh / 2;
    if (x < 8 || x + lw > vw - 8) {
      x = tx - lw / 2;
      y = sh.at === "top" ? ty + PT_LBL_GAP : ty - PT_LBL_GAP - lh;
    }
    x = Math.max(8, Math.min(vw - 8 - lw, x));
    y = Math.max(8, Math.min(vh - 8 - lh, y));
    lbl.style.left = (x - box[0]) + "px";
    lbl.style.top = (y - box[1]) + "px";
  }
  /* Place the box against the target, and keep the label on screen: the
     label is the one part that can reach past an edge, so it is measured
     and pulled back after everything else is set. */
  function ptPlace() {
    if (!ptEl || !ptTarget) return;
    if (!doc.body.contains(ptTarget)) { unpoint(); return; }
    var r = ptTarget.getBoundingClientRect();
    if (!r.width && !r.height) { unpoint(); return; }
    var s = ptOpts.size;
    var name = ptPick(r, s, ptOpts.prefer);
    if (name !== ptShape) {
      /* a new shape mid-flight would restart the draw; show it settled */
      if (ptShape) ptEl.classList.add("is-still");
      ptShape = name;
      ptDraw(name);
    }
    var box = ptBox(name, r, s);
    ptEl.style.left = box[0] + "px";
    ptEl.style.top = box[1] + "px";
    ptLabel(name, box, s);
  }
  function ptTick() { ptPlace(); }
  function ptClicked() { if (ptOpts && !ptOpts.stay) unpoint(); }

  function pointAt(target, label, opts) {
    if (!target) return;
    injectStyles();
    ptFont();
    if (ptEl) unpoint(true);
    /* one element at a time: an arrow still on its way out goes now */
    if (ptLeaving && ptLeaving.parentNode) ptLeaving.parentNode.removeChild(ptLeaving);
    ptLeaving = null;
    ptTarget = target;
    ptOpts = opts || {};
    if (!ptOpts.size) ptOpts.size = window.innerWidth < 600 ? 0.8 : 1;
    ptShape = "";
    ptEl = doc.createElement("div");
    /* born still: the hidden state below has to land without a transition,
       or the move from the initial zero to the hidden offset is itself the
       transition, and the entrance then has nothing left to do */
    ptEl.className = "ced-point is-still";
    ptEl.setAttribute("aria-hidden", "true");
    ptEl.innerHTML = '<svg viewBox="0 0 ' + PT_W + " " + PT_H + '" width="' + (PT_W * ptOpts.size) +
      '" height="' + (PT_H * ptOpts.size) + '">' +
      '<path class="ced-point__curve" d="M0 0" />' +
      '<path class="ced-point__head" d="M-15 -9 L0 0 L-15 9" />' +
      '</svg><span class="ced-point__label"></span>';
    ptEl.querySelector(".ced-point__label").textContent = label || "";
    doc.body.appendChild(ptEl);
    ptPlace();
    /* The entrance is three transitions on one class, timed end to end by
       their delays: the head, the stroke from the tip back to the tail, the
       label written out. The dash length and the hidden offset are two
       variables, so the stylesheet owns both the hidden and the shown state
       and the class is the only thing this code changes. */
    var curve = ptEl.querySelector(".ced-point__curve");
    var len = curve.getTotalLength();
    ptEl.style.setProperty("--pt-len", len + "px");
    ptEl.style.setProperty("--pt-off", (-len) + "px");
    if (ptReduced()) {
      ptEl.classList.add("is-on");
    } else {
      void ptEl.getBoundingClientRect();   /* commit the hidden state, still */
      ptEl.classList.remove("is-still");
      window.requestAnimationFrame(function () { if (ptEl) ptEl.classList.add("is-on"); });
    }
    window.addEventListener("scroll", ptTick, true);
    window.addEventListener("resize", ptTick);
    target.addEventListener("click", ptClicked);
    /* opts.onHover: the reader has found the button, so the note has done
       its job before the press. It leaves on the way in, not on the way
       out, so it is gone by the time the button is under the cursor. */
    if (ptOpts.onHover) target.addEventListener("mouseenter", ptClicked);
  }
  function unpoint(now) {
    if (!ptEl) return;
    var el = ptEl, target = ptTarget;
    window.removeEventListener("scroll", ptTick, true);
    window.removeEventListener("resize", ptTick);
    if (target) {
      target.removeEventListener("click", ptClicked);
      target.removeEventListener("mouseenter", ptClicked);
    }
    ptEl = null; ptTarget = null; ptOpts = null; ptShape = "";
    var drop = function () {
      if (el.parentNode) el.parentNode.removeChild(el);
      if (ptLeaving === el) ptLeaving = null;
    };
    if (now || ptReduced()) { drop(); return; }
    /* the other way round: the label first, then the stroke, then the head */
    ptLeaving = el;
    el.classList.add("is-off");
    el.classList.remove("is-on");
    window.setTimeout(drop, PT_OUT_MS + 20);
  }
  /* AMH.tool.point(target, label, opts) / AMH.tool.unpoint()
     The tutorial arrow. One at a time; see pointAt for the rules. */
  AMH.tool.point = pointAt;
  AMH.tool.unpoint = unpoint;

  /* ---------------- the editor kit ----------------
     What a trunk that extends the editor is allowed to use. publish.js is
     the one consumer today; the Phase 4 gallery tile grid is the next.

     These are internals, not console commands. They may be renamed with
     their consumers. The rule that keeps them honest is that this file
     never reaches the other way: a consumer registers what it owns
     (editSurface below), and nothing here names a variable in another
     trunk.

     imageRegion / imageKinds / pages / stage / handOff are published at
     their definitions, where the reasons for them are written out. */
  AMH.tool.injectStyles = injectStyles;    /* put the editor's styles in <head> */
  AMH.tool.addStyles = addStyles;          /* add a trunk's own rules to them */
  AMH.tool.grip = gripAdd;                 /* put the drag handle on a box */
  AMH.tool.scrimUp = scrimUp;              /* show the one ground, and count this box */
  AMH.tool.scrimDown = scrimDown;          /* drop this box's claim on it */
  AMH.tool.armGuard = armGuard;            /* arm the unsaved-work unload guard */
  AMH.tool.currentPage = currentPage;      /* the managed path being viewed */
  /* The deployed bytes of a managed page. No argument means the page being
     viewed, which is what the composer wants nearly every time; a path is for
     the publisher, which writes pages nobody is looking at. */
  AMH.tool.pristine = function (path) { return pristine(path || currentPage()); };
  AMH.tool.buildPage = buildPage;          /* those bytes, with edits applied */
  AMH.tool.spliceRegion = spliceRegion;    /* one region, into a source string */
  AMH.tool.listState = function (name) { return lists[name] || null; };
  AMH.tool.listDirty = listsDirty;         /* any list, changed from the file */
  /* A trunk says what one block of its list is; this file draws the rest. */
  AMH.tool.listKind = function (spec) { listKinds[spec.name] = spec; };
  AMH.tool.listPills = listPills;          /* the controls one block carries */
  AMH.tool.listForm = listForm;            /* open one block's form, or a new one */
  AMH.tool.spliceAllEdits = spliceAllEdits; /* every outstanding edit at once */
  AMH.tool.changedPages = changedPages;    /* managed pages an export would write */
  /* The photos the editor holds for these pages, as bytes keyed by the
     img/work/ path each file is written to. A bundle that carries a page
     carries these beside it. */
  AMH.tool.photoFiles = photoFiles;
  /* What the editor holds, for the console and the tests: the engine's
     record of each photo, without its bytes, with src the display copy. */
  AMH.tool.photos = function () {
    return engine().list().map(function (p) {
      var out = { src: p.files.hd };
      Object.keys(p).forEach(function (k) { out[k] = p[k]; });
      return out;
    });
  };
  AMH.tool.zip = zipStore;                 /* STORE zip writer */
  AMH.tool.download = downloadFile;        /* hand a file to the browser */
  AMH.tool.escAttr = escAttr;          /* a consumer's serializer needs it */
  AMH.tool.stamp = stamp;                  /* six characters that name a publish */
  AMH.tool.error = errObj;                 /* an Error that carries a BLG code */
  AMH.tool.tagCheck = tagCheck;            /* tag-balance check before a publish */
  AMH.tool.age = age;                      /* "12 min ago" */
  AMH.tool.toolbar = TOOLS;                /* the HTML formatting buttons */
  AMH.tool.mdToolbar = mdToolbar;          /* the Markdown bar, for any surface */
  AMH.tool.specialsFlyout = specialsFlyout; /* the (i) beside it */
  AMH.tool.wrap = wrapSelection;           /* both write into the open surface */
  AMH.tool.insert = insertAtCursor;

  /* An export is clean until an edit happens. A consumer that ships the
     outstanding edits inside its own bundle says so here. */
  AMH.tool.markExported = function () { exportedClean = true; };
  /* These pages are now bytes on disk, so the record of them is finished.

     The pending record answers one question: what has this tab applied that
     no file holds yet. A page that was written is no longer an answer to it,
     and leaving it there would have the panel count work that is done.

     It is not the same as live. The bytes are in the repo folder; the commit
     and the push are still the person's to make, which is what the button
     and the console both say. */
  AMH.tool.savedPages = function (paths) {
    (paths || []).forEach(function (path) {
      pendingDropPage(path);
      /* a trunk's staged bytes are in the file too now. The publisher stages
         the highlights block again from the entries at every publish, so
         nothing is lost by clearing what was written. */
      if (staged[path]) delete staged[path];
    });
    exportedClean = true;
    refreshDirtyUI();
  };

  /* True while the site editor owns the keyboard: a region being edited, an
     image being edited, or one of its own dialogs. A consumer with its own
     Escape rule asks before it acts, so the two never fight over one key. */
  AMH.tool.modalOpen = function () { return !!(openRegion || dialogStack.length); };

  /* Register the writing surface the toolbar should target while it is on
     screen. The function returns the element, or null when it is not. */
  AMH.tool.editSurface = function (fn) { altSurface = fn; };

  /* Register the shell that should hold this file's dialogs while it is on
     screen. The function returns a host, or null when there is none.

     A host is a small object, not an element:
       open(kind, title)  take a stage. Returns { head, body, btns }.
       close()            give the stage back.
     kind is "file" or "folder". A host is an offer and never a
     requirement: with no shell, a dialog builds its own box, which is what
     edit.export() from a page opened from disk still does. */
  AMH.tool.stageHost = function (fn) { hostFn = fn; };

  /* Place the arrow again, because something under it moved.

     The pointer follows a scroll and a resize on its own. A CSS transform
     is neither, so a caller that moves a target has to say so. This is
     about the pointer and not about the stage seam above: the shell hands
     nothing over here, it only reports that the ground shifted. */
  AMH.tool.repoint = function () { ptPlace(); };

  /* THE PHOTO TOOLS, for a trunk that draws its own image region.

     Every one of them is the surface the carousels use. A consumer places
     them; what they do is this file's, so the gallery page and a project
     card cannot drift apart.

       addPhoto(region, opts)      ADD PHOTO: opts.files, opts.choose,
                                   opts.target, opts.done
       editPhotos(region, at)      PHOTOS, opened on row `at`, or on none
       trashPhoto(region, at)      ask about one photo, and delete it
       captionField(region, en, label, textEl, pen)
                                   that caption, edited where it stands
       pill(label, icon, fn, iconOnly)   a yellow pill, the list's own shape
       icon                        the editor's marks
       photoTile                   the picture an unfilled slot shows
       viewing()                   "before" or "after" */
  AMH.tool.addPhoto = function (g, opts) { return addPhotoBox(g, opts); };
  AMH.tool.editPhotos = function (g, at) { return photosBox(g, at === undefined ? -1 : at); };
  AMH.tool.trashPhoto = function (g, at) { return photoTrash(g, at); };
  AMH.tool.captionField = captionField;
  AMH.tool.pill = pillBtn;
  AMH.tool.icon = ICON;
  AMH.tool.photoTile = PHOTO_TILE;
  AMH.tool.viewing = function () { return viewing; };

  /* Work waiting from another page in this sitting is re-applied before anyone
     looks at the page.

     Deferred to DOMContentLoaded rather than run here. This is no longer the
     last script in the load order: a consumer that claims its own image
     regions loads after it, and a scan before that claim would register the
     consumer's region as plain text and lose its model. Deferred scripts all
     run before DOMContentLoaded, so by then every trunk has claimed.

     It also still runs after work.js has built the carousels, which was the
     reason for the old placement. */
  if (doc.readyState === "loading") {
    doc.addEventListener("DOMContentLoaded", pendingRestore, { once: true });
  } else {
    window.setTimeout(pendingRestore, 0);
  }

  /* The way in, for anyone who does not open a console. */
  buildLauncher();
})();
