/* ============================================================
   tool.js - the site's authoring surface: the copy editor, image
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
     3. REGION SCANNING          7. PUBLIC API
     4. IMAGE REGIONS

   Two public surfaces, both listed in section 7: window.edit is the
   console, and AMH.tool is the editor kit that publish.js and the
   gallery tile grid build on.

   AMH.tool.imageRegion, from section 4, is the image-region core. It is
   the largest piece of that kit.

     An entry is a record of strings. The editor never holds image bytes:
     it records "img/work/<file>" and confirms the file with a HEAD
     request. Everything except the blob preview survives a navigation.

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
     edit.export()     download index.html with applied edits spliced in
     edit.before()     view the page as published (pre-edit)
     edit.after()      view the page with applied edits
     edit.revertAll()  discard every applied edit (confirm)
     edit.clear()      wipe the quicksave slot
     edit.help()       print this list

   Images: galleries (project carousels + deep-dive drawers) are
   image regions. In editor mode, drag & drop a file from img/work/
   onto a carousel to replace the visible photo, press the (+) chip
   to add a slot, and click the IMG## chip to caption/alt/delete.
   Seed images (img/seed/) are placeholder filler: they show only
   while a gallery has no real images.

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
  var imgSeq = 0;            /* running IMG## counter */
  var scanned = false;
  var active = false;        /* editor mode on/off */
  var viewing = "after";     /* "after" = with edits, "before" = as published */
  var exportedClean = true;  /* false once an edit exists that hasn't been exported */
  var overlay = null, panel = null, panelList = null, viewBtn = null, imgRowsEl = null;
  var modal = null, scrim = null, ta = null, modalTitle = null, modalStatus = null;
  var altIn = null, srcLine = null;
  var pendingChip = null;
  var openRegion = null;     /* text region in the modal */
  var openImage = null;      /* {g, index, entry} while the modal edits an image */
  var drawerHooked = false;
  var styleEl = null;

  /* ==========================================================
     3. REGION SCANNING
     ----------------------------------------------------------
     Find the [edit:slug] marker pairs and build the region model
     the rest of the file works from.
     ========================================================== */
  function badgeFor(i) {
    var letter = String.fromCharCode(65 + Math.floor(i / 99));   /* A01–A99, B01… */
    var n = (i % 99) + 1;
    return letter + (n < 10 ? "0" + n : String(n));
  }

  function scan() {
    if (scanned) return;
    scanned = true;
    var walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_COMMENT, null, false);
    var open = [];
    var c;
    while ((c = walker.nextNode())) {
      var m = /^\[edit:([\w-]+)\]$/.exec(c.nodeValue.trim());
      if (m) open.push({ slug: m[1], node: c });
    }
    open.forEach(function (o) {
      var el = o.node.nextSibling;
      while (el && !(el.nodeType === 1)) {
        if (el.nodeType === 3 && el.nodeValue.trim() !== "") break;
        el = el.nextSibling;
      }
      if (!el || el.nodeType !== 1) {
        console.warn("[copy editor] marker '" + o.slug + "' is not followed by an element - skipped");
        return;
      }
      var after = el.nextSibling;
      while (after && after.nodeType === 3 && after.nodeValue.trim() === "") after = after.nextSibling;
      var ok = after && after.nodeType === 8 &&
               after.nodeValue.trim() === "[/edit:" + o.slug + "]";
      if (!ok) {
        console.warn("[copy editor] marker '" + o.slug + "' has no matching close right after its element - skipped");
        return;
      }
      /* data-ced names the owner of a region:
           "blog"       the blog composer's publish pipeline owns it outright,
                        so the copy editor does not register it at all
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
        imageRegion.register({ slug: o.slug, el: el, kind: claimed });
        return;
      }
      var html = el.innerHTML;
      regions.push({
        slug: o.slug, badge: badgeFor(regions.length), el: el,
        original: html, current: html, edited: false,
        generated: owner === "generated",
        visible: el.getClientRects().length > 0,
        chip: null, row: null
      });
    });
    /* deep-dive galleries: template content is a separate fragment the body
       walker never enters, so walk each deepdive template explicitly */
    regions.forEach(function (r) {
      if (!r.el || r.el.tagName !== "TEMPLATE") return;
      var w2 = doc.createTreeWalker(r.el.content, NodeFilter.SHOW_COMMENT, null, false);
      var c2;
      while ((c2 = w2.nextNode())) {
        var m2 = /^\[edit:([\w-]+)\]$/.exec(c2.nodeValue.trim());
        if (!m2) continue;
        var el2 = c2.nextSibling;
        while (el2 && el2.nodeType !== 1) el2 = el2.nextSibling;
        if (el2 && el2.classList && el2.classList.contains("gallery")) {
          imageRegion.register({ slug: m2[1], el: el2, kind: KIND.deepdive, tpl: r.el });
        }
      }
    });
    console.info("[copy editor] " + regions.length + " text regions and " +
      gals.length + " galleries registered.");
  }

  function dirty() {
    return !exportedClean &&
      (regions.some(function (r) { return r.edited; }) || gals.some(galDirty));
  }

  /* ==========================================================
     4. IMAGE REGIONS
     ========================================================== */

  /* ------------------------------------------------------------
     IMAGE / GALLERY EDITING
     Galleries (project cards + deep-dive drawers) are image regions.
     Drag & drop replaces the visible photo, (+) adds an empty slot,
     the IMG## chip opens a caption/alt modal with Delete. The editor
     keeps a clean model per gallery ({src, alt, caption} entries) and
     both the live preview and the export serialize from that model -
     runtime gallery markup is never read back after the initial scan.
     Seeds (img/seed/ paths) are placeholder filler: they show only
     while a gallery has no real images and are never editable.
     ============================================================ */
  var EMPTY_TILE = "data:image/svg+xml," + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900">' +
    '<rect width="1600" height="900" fill="#101217"/>' +
    '<rect x="30" y="30" width="1540" height="840" rx="26" fill="rgba(74,165,232,.06)" ' +
    'stroke="#4aa5e8" stroke-width="5" stroke-dasharray="30 20"/>' +
    '<text x="800" y="430" fill="#6fbcf2" font-family="Segoe UI,Arial,sans-serif" ' +
    'font-size="66" font-weight="700" text-anchor="middle">Drop image here</text>' +
    '<text x="800" y="505" fill="#969eaa" font-family="Segoe UI,Arial,sans-serif" ' +
    'font-size="34" text-anchor="middle">drag a file from img/work/ onto this frame</text></svg>');

  /* ------------------------------------------------------------
     THE CORE

     One image entry is a record of strings plus one transient preview:

       src      "img/work/<file>"   the only field that is exported
       alt      string
       caption  string
       imgId    "IMG07", assigned in document order for this session
       isSeed   true while the region is showing placeholder filler
       empty    true for an unfilled (+) slot
       missing  null while the HEAD check runs, then true or false
       preview  a blob: URL, valid for this document only, never exported

     The editor never holds image bytes. It records a path, and a HEAD
     request confirms the file is on the server; copying the file into
     img/work/ stays a manual step. Every field except preview survives a
     page navigation, which is what carries an edit across pages.

     The core owns the model and the export form. A consumer owns its DOM:
     how many images it shows at once is not the core's business.
     ------------------------------------------------------------ */
  var claims = [];

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
      var src = im.getAttribute("src") || "";
      var en = {
        src: src, alt: im.getAttribute("alt") || "",
        caption: im.getAttribute("data-caption") || "",
        preview: src, empty: false, missing: false,
        isSeed: imageRegion.isSeed(src), imgId: null, orig: null
      };
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

    /* Build an entry from a dropped File. Records the path the export will
       carry, then verifies it with a HEAD request. carry, when given, keeps
       the caption and alt of the entry being replaced.

       A kind's own fields are kept the same way. Dropping a new photo into a
       tile should not resize the tile, so the replaced entry's values win;
       only a genuinely new entry falls back to the kind's defaults. */
    fromFile: function (file, carry, kind) {
      var en = {
        src: "img/work/" + file.name,
        alt: carry && carry.alt ? carry.alt : imageRegion.humanize(file.name),
        caption: carry ? carry.caption : "",
        preview: URL.createObjectURL(file),
        empty: false, missing: null /* null = HEAD check pending */, isSeed: false,
        imgId: imageRegion.nextId(), orig: null
      };
      var defaults = (kind && kind.defaults) || {};
      imageRegion.fieldsOf(kind).forEach(function (k) {
        en[k] = (carry && carry[k] !== undefined) ? carry[k] : defaults[k];
      });
      en.orig = { caption: en.caption, alt: en.alt };
      /* served over HTTP, so a HEAD request can confirm the file exists */
      fetch(en.src, { method: "HEAD", cache: "no-store" }).then(function (res) {
        en.missing = !res.ok;
        if (en.missing) {
          console.warn("[copy editor] " + en.src + " not found on the server - " +
            "copy the file into img/work/ before uploading the export.");
        }
        if (openImage && openImage.entry === en) updateSrcLine(en);
      }).catch(function () { en.missing = true; });
      return en;
    },

    /* An unfilled slot: a drop target that is never exported. It carries the
       kind's defaults so the tile it becomes starts where a new tile should,
       rather than with nothing. */
    emptySlot: function (kind) {
      var en = { src: "", alt: "", caption: "", preview: "", empty: true,
                 missing: false, isSeed: false, imgId: null, orig: null };
      var defaults = (kind && kind.defaults) || {};
      imageRegion.fieldsOf(kind).forEach(function (k) { en[k] = defaults[k]; });
      return en;
    },

    /* The only shape that reaches a file: strings, no slots, no previews.

       A kind's own fields travel with it. They are part of what the author
       asked for, so they belong in the export and in the pending store that
       carries an edit between pages. */
    exportForm: function (entries, kind) {
      var extra = imageRegion.fieldsOf(kind);
      return entries.filter(function (e) { return !e.empty; })
        .map(function (e) {
          var o = { src: e.src, alt: e.alt, caption: e.caption };
          extra.forEach(function (k) { o[k] = e[k]; });
          return o;
        });
    },

    /* The inverse: rebuild live entries from an export form. */
    fromExportForm: function (list, kind) {
      var extra = imageRegion.fieldsOf(kind);
      return list.map(function (o) {
        var en = { src: o.src, alt: o.alt, caption: o.caption, preview: o.src,
                   empty: false, missing: false, isSeed: imageRegion.isSeed(o.src),
                   imgId: null, orig: { caption: o.caption, alt: o.alt } };
        extra.forEach(function (k) { en[k] = o[k]; });
        return en;
      });
    },

    /* Release a dropped file's preview URL. Deferred, because an <img> or an
       open lightbox may still be painting it after the entry is replaced. */
    revokePreview: function (en) {
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
    serializeFor: function (entries, indent, kind) {
      return (kind && kind.serialize)
        ? kind.serialize(entries, indent)
        : imageRegion.serialize(entries, indent);
    },

    serialize: function (entries, indent) {
      var lines = entries.map(function (en) {
        return indent + '  <img src="' + escAttr(en.src) + '" loading="lazy"\n' +
               indent + '       alt="' + escAttr(en.alt) + '"' +
               (en.caption ? '\n' + indent + '       data-caption="' + escAttr(en.caption) + '"' : "") +
               " />";
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
        live: spec.kind.deferLive ? null : spec.el,
        chip: null, plusChip: null, observer: null
      };
      r.original = imageRegion.exportForm(r.model, r.kind);
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
      return JSON.stringify(imageRegion.exportForm(r.model, r.kind)) !== JSON.stringify(r.original);
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
    }
  };

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
       rowNote        suffix for the region's rows in the panel
       modalNote      suffix for the image modal heading
       lastImageNote(r) warning shown before the last image is deleted
     ------------------------------------------------------------ */
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
      rowNote: "",
      modalNote: "",
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
      rowNote: ' <span class="ced-hidden">(dd)</span>',
      modalNote: ' <span class="ced-hidden" style="color:var(--dim);font-size:.7rem">(deep-dive gallery)</span>',
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
  /* A consumer needs these three to draw a region the way the carousels are
     drawn: which entries to show, whether the region has changed, and the
     placeholder tile a (+) slot displays. */
  AMH.tool.emptyTile = EMPTY_TILE;

  /* The editor's own behaviour, for a consumer that draws its own region.
     A consumer that finds itself reimplementing any of these should be given
     the missing hook instead.

       dropFiles   the drop path: preview, HEAD check, modal, bookkeeping
       addSlot     add an unfilled (+) slot
       openImage   the caption and alt modal, with Delete
       changed     "an edit happened here": mark unexported, stage it for the
                   page, refresh the panel and the chips
       editorOn    whether editor mode is on right now */
  AMH.tool.dropFiles = function (g, files, index) { handleDrop(g, files, index); };
  AMH.tool.addSlot = function (g) { addSlot(g); };
  AMH.tool.openImage = function (g, index) { openImageModal(g, index); };
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

  function setGalleryImgs(el, entries, preview) {
    el.innerHTML = "";
    entries.forEach(function (en) {
      var im = doc.createElement("img");
      im.src = en.empty ? EMPTY_TILE : ((preview && en.preview) ? en.preview : en.src);
      im.alt = en.alt || "";
      im.setAttribute("loading", "lazy");
      if (en.caption) im.setAttribute("data-caption", en.caption);
      el.appendChild(im);
    });
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
    /* note: template-content nodes always report isConnected false - a bare
       null check is the right guard for the dd gallery inside the template */
    if (g.kind.syncSource && g.el) {
      /* the template stays in clean export form (no blob previews, no slots) */
      setGalleryImgs(g.el, list.filter(function (e) { return !e.empty; })
        .map(function (e) { return { src: e.src, alt: e.alt, caption: e.caption,
                                     preview: e.src, empty: false }; }), false);
    }
    var live = g.live;
    if (live && live.isConnected) {
      if (g.observer) { g.observer.disconnect(); g.observer = null; }
      if (g.kind.dropWhenEmpty && !list.length) {
        /* an empty region of this kind is legitimate - remove the container */
        if (live.parentNode) live.parentNode.removeChild(live);
        g.live = null;
      } else {
        setGalleryImgs(live, list, true);
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
        if (files.length) handleDrop(g, files);
      });
    }
    var stage = g.live.querySelector(".gallery__stage");
    if (stage && window.MutationObserver) {
      if (g.observer) g.observer.disconnect();   /* drawer reopens re-attach; don't stack */
      g.observer = new MutationObserver(function () { updateGalleryChip(g); });
      g.observer.observe(stage, { attributes: true, attributeFilter: ["class"], subtree: true });
    }
    updateGalleryChip(g);
  }

  /* drop = replace what you are looking at; extra files append as new photos.
     A seed-showing gallery flips to real mode with the first drop (seeds are
     all-or-nothing filler, not slots to fill one by one). */
  /* atIndex is the entry the drop landed on. A carousel has one photo on
     screen and has to ask which; a tile grid was dropped on a tile and knows.
     Everything after that choice is the same for both. */
  function handleDrop(g, files, atIndex) {
    if (viewing === "before") api.after();
    var idx;
    if (!g.model.length) {
      imageRegion.append(g, imageRegion.fromFile(files[0], null, g.kind));
      idx = 0;
    } else {
      idx = (typeof atIndex === "number") ? atIndex : activeIndex(g);
      if (idx >= g.model.length) idx = g.model.length - 1;
      if (idx < 0) idx = 0;
      var old = g.model[idx];
      imageRegion.replaceAt(g, idx,
        imageRegion.fromFile(files[0], old.empty ? null : old, g.kind));
    }
    for (var i = 1; i < files.length; i++) {
      imageRegion.append(g, imageRegion.fromFile(files[i], null, g.kind));
    }
    exportedClean = false;
    renderGallery(g, null, idx);
    pendingSyncGallery(g);
    refreshDirtyUI();
    openImageModal(g, idx);
  }

  function addSlot(g) {
    if (viewing === "before") api.after();
    imageRegion.addEmptySlot(g);
    renderGallery(g, null, g.model.length - 1);
    pendingSyncGallery(g);
    refreshDirtyUI();
  }

  function updateGalleryChip(g) {
    if (!g.chip) return;
    var en = displayedEntries(g)[activeIndex(g)] || null;
    g.chip.textContent = !en ? "IMG" : (en.empty ? "DROP" : (en.isSeed ? "SEED" : en.imgId));
    g.chip.title = g.slug + (en && en.isSeed ? " - placeholder; drop a real image to replace" :
      (en && en.empty ? " - empty slot; drop an image here" : ""));
    g.chip.classList.toggle("ced-chip--seed", !!(en && en.isSeed));
    g.chip.classList.toggle("ced-edited", galDirty(g));
  }

  function refreshImageRows() {
    if (!imgRowsEl) return;
    imgRowsEl.innerHTML = "";
    gals.forEach(function (g) {
      var isDirty = galDirty(g);
      function addRow(label, i, openable) {
        var row = doc.createElement("button");
        row.type = "button";
        row.className = "ced-panel__row ced-panel__row--img" + (isDirty ? " ced-edited" : "");
        row.innerHTML = '<span class="ced-b">' + label + "</span><span>" + g.slug +
          "</span>" + g.kind.rowNote +
          '<span class="ced-dot"></span>';
        row.addEventListener("click", function () {
          revealGallery(g, i);
          if (openable) openImageModal(g, i);
        });
        imgRowsEl.appendChild(row);
      }
      if (!g.model.length) { addRow("SEED", 0, false); return; }
      g.model.forEach(function (en, i) {
        addRow(en.empty ? "SLOT" : en.imgId, i, true);
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
    gals.forEach(function (g) {
      if (!g.kind.deferLive || !g.tpl) return;
      if ((g.tpl.getAttribute("data-title") || "") === t.textContent) {
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
    gals.forEach(function (g) {
      if (g.tpl !== r.el) return;
      g.el = r.el.content.querySelector(".gallery");
      if (!g.el) {
        console.warn("[copy editor] " + g.slug +
          " gallery markup was removed by a text edit - image edits for it are disabled until revert.");
        return;
      }
      /* the text apply reset the template to its snapshot; if the image model
         is dirty it is the source of truth - write it back into the template
         so preview, drawer, and export all agree */
      if (galDirty(g)) renderGallery(g);
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
    ".ced-chip{position:absolute;z-index:3000;width:26px;height:26px;padding:0;border-radius:50%;" +
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
    "align-items:center;justify-content:space-between;font-weight:800;letter-spacing:.14em;" +
    "font-size:.66rem;color:var(--accent);text-transform:uppercase;}" +
    ".ced-panel__view{font-weight:600;letter-spacing:0;text-transform:none;color:var(--muted);}" +
    ".ced-panel__view b{color:var(--c-yellow);font-weight:700;}" +
    /* the unsaved-changes chip: a full-width bar under the panel head, shown
       only when something is waiting */
    ".ced-pending{display:block;width:100%;border:0;border-bottom:1px solid var(--line-soft);" +
    "background:rgba(240,180,41,.12);color:var(--c-yellow);font:700 .64rem/1.5 Consolas,monospace;" +
    "letter-spacing:.06em;padding:.4rem .8rem;text-align:left;cursor:pointer;}" +
    ".ced-pending:hover{background:rgba(240,180,41,.2);}" +
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
    ".ced-panel__foot{padding:.55rem .6rem;border-top:1px solid var(--line-soft);display:flex;flex-wrap:wrap;gap:.35rem;}" +
    ".ced-btn{padding:.34rem .66rem;border-radius:999px;border:1px solid var(--line);background:var(--bg-deep);" +
    "color:var(--text-soft);font:600 .7rem var(--font);cursor:pointer;transition:border-color .2s,color .2s;}" +
    ".ced-btn:hover{border-color:var(--accent);color:var(--text);}" +
    ".ced-btn--accent{border-color:var(--accent);color:var(--accent-bright);}" +
    ".ced-scrim{position:fixed;inset:0;z-index:3200;background:rgba(4,6,10,.72);}" +
    ".ced-modal{position:fixed;z-index:3300;left:50%;top:50%;transform:translate(-50%,-50%);" +
    "width:min(720px,94vw);max-height:90vh;display:flex;flex-direction:column;background:var(--panel);" +
    "border:1px solid var(--line);border-radius:14px;box-shadow:0 40px 100px -40px rgba(0,0,0,1);}" +
    ".ced-modal__head{padding:.8rem 3rem .6rem 1.1rem;display:flex;align-items:baseline;gap:.6rem;}" +
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
    ".ced-modal textarea{margin:0 1.1rem;flex:1 1 auto;min-height:240px;resize:vertical;" +
    "background:var(--bg-deep);color:var(--text);border:1px solid var(--line);border-radius:8px;" +
    "padding:.7rem .8rem;font:12.5px/1.55 Consolas,'Courier New',monospace;white-space:pre-wrap;}" +
    ".ced-modal textarea:focus-visible{outline:2px solid var(--accent);}" +
    ".ced-modal__status{padding:.35rem 1.1rem 0;font-size:.7rem;color:var(--muted);min-height:1.2em;}" +
    ".ced-modal__btns{display:flex;flex-wrap:wrap;gap:.4rem;padding:.7rem 1.1rem .9rem;}" +
    ".ced-modal__btns .ced-spacer{flex:1 1 auto;}" +
    /* image / gallery editing */
    ".ced-chip--img{width:auto;min-width:26px;padding:0 8px;border-radius:999px;font-size:8.5px;}" +
    ".ced-chip--plus{font-size:14px;font-weight:800;}" +
    ".ced-chip--seed{border-color:var(--dim);color:var(--muted);box-shadow:none;cursor:default;}" +
    ".ced-dropping{outline:3px dashed var(--accent);outline-offset:-3px;border-radius:10px;}" +
    ".ced-modal__alt{display:flex;align-items:center;gap:.6rem;margin:.5rem 1.1rem 0;}" +
    ".ced-modal__alt span{font-size:.66rem;font-weight:800;letter-spacing:.14em;text-transform:uppercase;color:var(--dim);}" +
    ".ced-modal__alt input{flex:1;background:var(--bg-deep);color:var(--text);border:1px solid var(--line);" +
    "border-radius:8px;padding:.45rem .7rem;font:12.5px Consolas,'Courier New',monospace;}" +
    ".ced-modal__alt input:focus-visible{outline:2px solid var(--accent);}" +
    ".ced-modal__src{margin:.45rem 1.1rem 0;font:11px Consolas,'Courier New',monospace;color:var(--dim);}" +
    ".ced-modal__src--missing{color:var(--c-orange);}" +
    ".ced-btn--danger{border-color:rgba(240,136,62,.5);color:var(--c-orange);}" +
    ".ced-btn--danger:hover{border-color:var(--c-orange);color:#fff;background:rgba(240,136,62,.15);}" +
    ".ced-modal--image .ced-modal__tools{display:none;}" +
    ".ced-modal--image textarea{min-height:84px;}" +
    ".ced-modal:not(.ced-modal--image) .ced-modal__alt{display:none;}" +
    ".ced-modal:not(.ced-modal--image) .ced-modal__src{display:none;}" +
    ".ced-modal:not(.ced-modal--image) .ced-btn--danger{display:none;}" +
    ".ced-panel__row--img .ced-b{color:var(--c-yellow);}";

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

  /* ---------------- badges + panel ---------------- */
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
      r.chip.style.top = (rects[i].top + sy) + "px";
    });
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
      if (!gRects[i]) { g.chip.style.display = "none"; g.plusChip.style.display = "none"; return; }
      g.chip.style.display = ""; g.plusChip.style.display = "";
      g.chip.style.left = (gRects[i].left + sx + 16) + "px";
      g.chip.style.top = (gRects[i].top + sy) + "px";
      g.plusChip.style.left = (gRects[i].left + sx + 58) + "px";
      g.plusChip.style.top = (gRects[i].top + sy) + "px";
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

  function refreshDirtyUI() {
    regions.forEach(function (r) {
      if (r.chip) r.chip.classList.toggle("ced-edited", r.edited);
      if (r.row) r.row.classList.toggle("ced-edited", r.edited);
    });
    if (viewBtn) viewBtn.textContent = viewing === "after" ? "View: after" : "View: BEFORE";
    refreshPendingChip();
  }

  function buildUI() {
    overlay = doc.createElement("div");
    overlay.setAttribute("aria-hidden", "true");
    overlay.style.cssText = "position:absolute;left:0;top:0;width:0;height:0;";

    panel = doc.createElement("div");
    panel.className = "ced-panel";
    var head = doc.createElement("div");
    head.className = "ced-panel__head";
    head.innerHTML = "<span>Copy editor</span>";
    viewBtn = doc.createElement("button");
    viewBtn.type = "button";
    viewBtn.className = "ced-btn ced-panel__view";
    viewBtn.addEventListener("click", function () {
      (viewing === "after" ? api.before : api.after)();
    });
    head.appendChild(viewBtn);
    panel.appendChild(head);

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

    panelList = doc.createElement("div");
    panelList.className = "ced-panel__list";
    regions.forEach(function (r) {
      var row = doc.createElement("button");
      row.type = "button";
      row.className = "ced-panel__row";
      row.innerHTML = '<span class="ced-b">' + r.badge + "</span><span>" + r.slug + "</span>" +
        (r.generated ? ' <span class="ced-hidden">(generated)</span>' : "") +
        (r.visible ? "" : ' <span class="ced-hidden">(hidden)</span>') +
        '<span class="ced-dot"></span>';
      row.addEventListener("click", function () { openModal(r); });
      r.row = row;
      panelList.appendChild(row);
    });
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
    }
    footBtn("Export", "ced-btn--accent", function () { api.export(); });
    footBtn("New post", "", function () { api.blog(); });
    footBtn("Revert all", "", function () { api.revertAll(); });
    footBtn("Exit", "", function () { api(); });
    panel.appendChild(foot);

    regions.forEach(function (r) {
      if (!r.visible) return;
      var chip = doc.createElement("button");
      chip.type = "button";
      chip.className = "ced-chip";
      chip.textContent = r.badge;
      chip.title = r.slug;
      chip.addEventListener("click", function (e) { e.stopPropagation(); openModal(r); });
      r.chip = chip;
      overlay.appendChild(chip);
    });

    /* gallery chips: IMG## (opens the image modal for the visible photo)
       and (+) (adds an empty slot) */
    gals.forEach(function (g) {
      var chip = doc.createElement("button");
      chip.type = "button";
      chip.className = "ced-chip ced-chip--img";
      chip.textContent = "IMG";
      chip.addEventListener("click", function (e) {
        e.stopPropagation();
        var i = activeIndex(g), en = displayedEntries(g)[i];
        if (!en || en.isSeed) return;   /* seeds aren't editable - drop to replace */
        openImageModal(g, i);
      });
      g.chip = chip;
      overlay.appendChild(chip);
      var plus = doc.createElement("button");
      plus.type = "button";
      plus.className = "ced-chip ced-chip--plus";
      plus.textContent = "+";
      plus.title = g.slug + " - add an image slot";
      plus.addEventListener("click", function (e) { e.stopPropagation(); addSlot(g); });
      g.plusChip = plus;
      overlay.appendChild(plus);
      attachGalleryRuntime(g);
    });

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
    /* AMH.tool.viewChanged()
       blog.js calls this when its takeover view opens or closes. The badge
       chips are positioned over the portfolio, which that view hides and
       re-shows, so they have to be placed again. */
    AMH.tool.viewChanged = requestReposition;
    redrawSelfDrawn();
  }

  /* A region that draws itself keeps its scaffolding inside its own markup:
     the chips, the controls, the drop targets. The carousels get theirs from
     buildUI(), which draws over the live element, so nothing has to be
     rebuilt for them. A self-drawing region redraws instead - on the way in
     to add the scaffolding, and on the way out to take it away. */
  function redrawSelfDrawn() {
    gals.forEach(function (g) { if (g.kind.render) renderGallery(g); });
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
      active ? "Close the copy editor" : "Open the copy editor");
  }

  function teardownUI() {
    pendingChip = null;
    closeModal();
    if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
    if (panel && panel.parentNode) panel.parentNode.removeChild(panel);
    window.removeEventListener("resize", requestReposition);
    regions.forEach(function (r) { r.chip = null; r.row = null; });
    gals.forEach(function (g) {
      if (g.observer) { g.observer.disconnect(); g.observer = null; }
      g.chip = null; g.plusChip = null;
    });
    overlay = panel = panelList = viewBtn = imgRowsEl = null;
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
  function wrapSelection(before, after) {
    var t = curTA();
    var s = t.selectionStart, e = t.selectionEnd, v = t.value;
    t.value = v.slice(0, s) + before + v.slice(s, e) + after + v.slice(e);
    t.focus();
    if (s === e) { t.selectionStart = t.selectionEnd = s + before.length; }
    else { t.selectionStart = s; t.selectionEnd = e + before.length + after.length; }
  }
  function insertAtCursor(txt) {
    var t = curTA();
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

  function status(msg) { if (modalStatus) modalStatus.textContent = msg || ""; }

  function buildModal() {
    scrim = doc.createElement("div");
    scrim.className = "ced-scrim";
    modal = doc.createElement("div");
    modal.className = "ced-modal";
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
    xBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="2" stroke-linecap="round" aria-hidden="true">' +
      '<line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg>';
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

    /* image mode only (hidden for text regions via .ced-modal--image CSS) */
    var altRow = doc.createElement("div");
    altRow.className = "ced-modal__alt";
    var altLabel = doc.createElement("span");
    altLabel.textContent = "alt";
    altIn = doc.createElement("input");
    altIn.type = "text";
    altIn.spellcheck = false;
    altRow.appendChild(altLabel);
    altRow.appendChild(altIn);
    modal.appendChild(altRow);
    srcLine = doc.createElement("div");
    srcLine.className = "ced-modal__src";
    modal.appendChild(srcLine);

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
    btn("Delete", "ced-btn--danger", deleteImage);   /* image mode only (CSS-hidden for text) */
    btn("Quicksave", "", quicksave);
    btn("Restore", "", restore);
    var sp = doc.createElement("span"); sp.className = "ced-spacer"; btns.appendChild(sp);
    btn("Apply", "ced-btn--accent", applyModal);
    btn("Revert", "", revertModal);
    btn("Cancel", "", closeModal);
    modal.appendChild(btns);

    doc.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && (openRegion || openImage)) { e.preventDefault(); closeModal(); }
    });
  }

  function openModal(r) {
    if (viewing === "before") api.after();   /* never edit on top of the before view */
    if (!modal) buildModal();
    openImage = null;
    modal.classList.remove("ced-modal--image");
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

  function openImageModal(g, index) {
    if (viewing === "before") api.after();
    if (!modal) buildModal();
    var en = g.model[index];
    if (!en) return;
    openRegion = null;
    openImage = { g: g, index: index, entry: en };
    modal.classList.add("ced-modal--image");
    modalTitle.innerHTML = '<span class="ced-b">' + (en.empty ? "SLOT" : en.imgId) + '</span>' +
      '<span class="ced-slug">' + g.slug + "</span>" +
      g.kind.modalNote;
    ta.value = en.caption;
    altIn.value = en.alt || "";
    ta.disabled = altIn.disabled = !!en.empty;
    updateSrcLine(en);
    status(en.empty
      ? "Empty slot - drop an image onto the carousel to fill it, or Delete to remove the slot."
      : "Caption above, alt text below. Apply updates the page; export writes it to the file.");
    doc.body.appendChild(scrim);
    doc.body.appendChild(modal);
    if (!en.empty) ta.focus();
  }
  function updateSrcLine(en) {
    if (!srcLine) return;
    srcLine.textContent = en.empty ? "(no file yet)" :
      en.src + (en.missing ? "  -  NOT FOUND on server: copy the file into img/work/" : "");
    srcLine.classList.toggle("ced-modal__src--missing", !!en.missing);
  }

  function closeModal() {
    if (!openRegion && !openImage) return;
    openRegion = null;
    openImage = null;
    if (modal) modal.classList.remove("ced-modal--image");
    if (ta) { ta.disabled = false; ta.readOnly = false; }
    if (altIn) altIn.disabled = false;
    if (scrim && scrim.parentNode) scrim.parentNode.removeChild(scrim);
    if (modal && modal.parentNode) modal.parentNode.removeChild(modal);
  }

  /* the (X) close path: unlike Cancel/Esc (which discard silently), this asks
     first, but only when the box holds changes that were never Applied. */
  function requestClose() {
    var unapplied = false;
    if (openRegion && ta) {
      unapplied = ta.value !== openRegion.current;
    } else if (openImage && ta && !openImage.entry.empty) {
      unapplied = ta.value !== openImage.entry.caption ||
                  altIn.value !== (openImage.entry.alt || "");
    }
    if (unapplied &&
        !window.confirm("You changed the text in this box but haven't applied it.\n\nClose and discard those changes?")) return;
    closeModal();
  }

  function deleteImage() {
    if (!openImage) return;
    var g = openImage.g, i = openImage.index, en = openImage.entry;
    var lastReal = !en.empty &&
      g.model.filter(function (e) { return !e.empty; }).length === 1;
    var warn = lastReal ? g.kind.lastImageNote(g) : "";
    var what = en.empty ? "this empty slot" : en.imgId + " (" + en.src + ")";
    if (!window.confirm("Delete " + what + " from " + g.slug + "?" + warn)) return;
    imageRegion.remove(g, i);
    exportedClean = false;
    closeModal();
    renderGallery(g, null, 0);
    pendingSyncGallery(g);
    refreshDirtyUI();
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
    if (openImage) {
      var en = openImage.entry;
      if (en.empty) { status("Nothing to apply - fill the slot first (drop an image on the carousel)."); return; }
      en.caption = ta.value.trim();
      en.alt = altIn.value.trim();
      exportedClean = false;
      renderGallery(openImage.g, null, openImage.index);
      pendingSyncGallery(openImage.g);
      refreshDirtyUI();
      status(galDirty(openImage.g) ? "Applied - export when you're done."
                                   : "Applied - matches published content.");
      return;
    }
    if (!openRegion) return;
    if (openRegion.generated) {
      status("Not applied - the publisher owns this block. Edit its source instead.");
      return;
    }
    var problem = tagCheck(ta.value);
    if (problem && !window.confirm("Tag check: " + problem + "\n\nApply anyway?")) {
      status("Not applied - " + problem);
      return;
    }
    var r = openRegion;
    r.el.innerHTML = ta.value;
    r.current = r.el.innerHTML;          /* normalized by the browser */
    r.edited = r.current !== r.original;
    if (r.edited) exportedClean = false;
    pendingSyncRegion(r);
    ta.value = r.current;
    relinkTplGalleries(r);               /* a template rewrite orphans its dd gallery */
    refreshDirtyUI();
    requestReposition();
    status(r.edited ? "Applied - page updated. Export when you're done." : "Applied - matches published content.");
  }

  function revertModal() {
    if (openImage) {
      var en = openImage.entry;
      if (en.empty) { status("Nothing to revert on an empty slot."); return; }
      en.caption = en.orig.caption;
      en.alt = en.orig.alt;
      ta.value = en.caption;
      altIn.value = en.alt;
      renderGallery(openImage.g, null, openImage.index);
      pendingSyncGallery(openImage.g);
      refreshDirtyUI();
      status("Caption and alt reverted. (Reverting the image file itself = Delete, or drop the old file back.)");
      return;
    }
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
    if (openRegion) return openRegion.slug;
    if (openImage) return openImage.g.slug + "/" + (openImage.entry.imgId || "slot");
    return "?";
  }
  function quicksave() {
    if (!openRegion && !openImage) return;
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
    if (!openRegion && !openImage) return;
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
  function spliceRegion(src, slug, inner) {
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
    return src.slice(0, start) + span.slice(0, gt + 1) + inner + span.slice(lastClose) + src.slice(b);
  }

  function escAttr(s) {
    return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
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
      console.warn("[copy editor] " + g.slug + " exports EMPTY - no images and no seed fallback.");
    }
    return spliceRegion(src, g.slug, imageRegion.serializeFor(entries, ind, g.kind));
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

     Phase 2 Part 4 adds the offline fallback here, and only here. */
  function pristine(path) {
    path = path || currentPage();
    if (!isManaged(path)) {
      return Promise.reject(new Error(path + " is not a managed page - add it to MANAGED_PAGES"));
    }
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
    "BLG-E01": "This page was opened from disk, so the editor cannot read its own published bytes.",
    "BLG-E02": "That drag carried no file. Some sources hand over a link instead of a file. Use the button, or drag from a file manager.",
    "BLG-E03": "That is the wrong file for this step.",
    "BLG-E04": "That file could not be read.",
    "BLG-E05": "That file carries no editable regions, so it is not a page this editor writes.",
    "BLG-E06": "That file is missing a region this publish has to write.",
    "BLG-E07": "Cancelled. No file was provided.",
    "BLG-E08": "That folder holds none of the files this publish needs.",
    "BLG-E09": "Not on disk. The publish treats this file as one it has to create."
  };

  /* Say a code the same way every time, and put it where a console search
     will find it. Returns the sentence, for a dialog to show. */
  function errText(code, extra) {
    var msg = (ERR[code] || "Unexpected problem.") + (extra ? " " + extra : "");
    console.warn("[copy editor] " + code + " " + msg);
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

  /* Does this look like a page the editor writes? Better verification, as
     chosen: the name has to match, and the markers the splice needs have to
     be present. It warns and lets the user continue, because the editor
     legitimately holds edits that are not in the file yet. */
  function verifyFile(path, text) {
    var marks = text.match(/<!--\[edit:[\w-]+\]-->/g) || [];
    if (!marks.length) {
      return { ok: true, warn: true, code: "BLG-E05", detail: "" };
    }
    var slugs = {};
    marks.forEach(function (m) { slugs[m.slice(11, -4)] = true; });
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
               detail: missing.slice(0, 4).join(", ") +
                       (missing.length > 4 ? " and " + (missing.length - 4) + " more" : "") };
    }
    return { ok: true, count: marks.length };
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
    var want = path.replace(/^.*\//, "");
    var mayBeAbsent = isOptional(path);
    if (netErr) errText("BLG-E01", "Wanted: " + want + ".");

    return new Promise(function (resolve, reject) {
      injectStyles();
      guardDocumentDrops();

      var scrim2 = doc.createElement("div");
      scrim2.className = "ced-scrim";
      var box = doc.createElement("div");
      box.className = "ced-modal ced-handoff";

      /* ced-modal__head, not ced-modal__title: the second has no rules
         anywhere in this file, which is why the badge and the name used to
         run together with no padding. */
      var title = doc.createElement("div");
      title.className = "ced-modal__head";
      title.innerHTML = '<span class="ced-b">FILE</span><span class="ced-slug">' +
        escAttr(want) + "</span>" + stepLabel(path);

      var zone = doc.createElement("div");
      zone.className = "ced-handoff__zone";
      zone.setAttribute("tabindex", "0");
      zone.setAttribute("role", "button");
      zone.innerHTML = "<strong>Drop <code>" + escAttr(want) + "</code> here</strong>" +
        "<span>or click to choose it</span>";

      var note = doc.createElement("div");
      note.className = "ced-modal__status";
      note.textContent = ERR["BLG-E01"] + " Hand it the file from your repo and " +
        "the export continues as normal." +
        (mayBeAbsent ? " This one may not exist yet. If it does not, say so and " +
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

      var btns = doc.createElement("div");
      btns.className = "ced-modal__btns";
      var pick = doc.createElement("button");
      pick.type = "button";
      pick.className = "ced-btn ced-btn--accent";
      pick.textContent = "Choose file";
      var all = doc.createElement("button");
      all.type = "button";
      all.className = "ced-btn";
      all.textContent = "Use my repo folder";
      all.title = "Pick the folder once. Every file this publish needs is taken from it.";
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
        absent.title = "The publish will create this file.";
      }

      var cancel = doc.createElement("button");
      cancel.type = "button";
      cancel.className = "ced-btn";
      cancel.textContent = "Cancel";

      function done() {
        if (scrim2.parentNode) scrim2.parentNode.removeChild(scrim2);
        if (box.parentNode) box.parentNode.removeChild(box);
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
          /* Warn, and continue. A warning is not a refusal: the editor
             holds edits that are not in the file yet, so it cannot know from
             the bytes alone that a file is wrong. The splice is the real
             gate, and it fails loudly and names what it could not find. */
          var v = verifyFile(path, text);
          handed[path] = text;
          if (v.warn) {
            errText(v.code, v.detail
              ? "Missing: " + v.detail + ". The export will report anything it cannot splice."
              : 'The file is named "' + want + '" and holds no markers. Continuing anyway.');
          }
          done();
          resolve(text);
        }, function () { fail("BLG-E04"); });
      }

      /* Take a whole folder, and keep every file this publish still needs. */
      function takeFolder(files) {
        var byName = {};
        Array.prototype.forEach.call(files || [], function (f) { byName[f.name] = f; });
        var wanted = expected.length ? expected : [path];
        var jobs = wanted.filter(function (pp) {
          return !handed[pp] && byName[pp.replace(/^.*\//, "")];
        });
        if (!jobs.length) { fail("BLG-E08", "Wanted: " + want + "."); return; }
        Promise.all(jobs.map(function (pp) {
          return readFile(byName[pp.replace(/^.*\//, "")]).then(function (text) {
            if (verifyFile(pp, text).ok) handed[pp] = text;
          }, function () {});
        })).then(function () {
          if (!handed[path]) { fail("BLG-E08", "Wanted: " + want + "."); return; }
          console.info("[copy editor] took " + Object.keys(handed).length +
            " file(s) from the folder; this publish will not ask again.");
          done();
          resolve(handed[path]);
        });
      }

      zone.addEventListener("click", function () { input.click(); });
      zone.addEventListener("keydown", function (e) {
        if (e.key === "Enter" || e.key === " " || e.key === "Spacebar") {
          e.preventDefault(); input.click();
        }
      });
      pick.addEventListener("click", function () { input.click(); });
      all.addEventListener("click", function () { folder.click(); });
      input.addEventListener("change", function () { take(input.files && input.files[0]); });
      folder.addEventListener("change", function () { takeFolder(folder.files); });

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
      box.appendChild(title);
      box.appendChild(zone);
      box.appendChild(note);
      if (list.innerHTML) box.appendChild(list);
      box.appendChild(input);
      box.appendChild(folder);
      box.appendChild(btns);
      doc.body.appendChild(scrim2);
      doc.body.appendChild(box);
      zone.focus();
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
    return ' <span class="ced-hidden">file ' + (at + 1) + " of " + must.length + "</span>";
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
  function fetchPristine() { return pristine(currentPage()); }

  /* Edits waiting to be written to a page whose DOM is not on screen, keyed by
     page path: { "gallery.html": { "br-title": "<h3>New</h3>" } }.

     The page being viewed is not staged here. Its edits live in the region
     model, which also carries galleries and nested regions, and which the
     export splices through spliceAllEdits().

     Phase 2 Part 4 fills this from sessionStorage, so an edit made on one page
     travels with you to another. Phase 3 stages the generated highlights block
     the same way. */
  var staged = {};

  /* Stage one region edit for a managed page. Returns false, and stages
     nothing, when the page is not managed. */
  function stageEdit(path, slug, html) {
    if (!isManaged(path)) {
      console.warn("[copy editor] refusing to stage " + slug + " for " + path +
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
    console.warn("[copy editor] pending edits cannot be stored in this context (" +
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
      console.warn("[copy editor] the pending-edit store was unreadable and has been dropped.");
      pendingWriteAll({});
      return {};
    }
  }

  function pendingWriteAll(all) {
    /* drop a page whose maps are both empty, so the count stays honest */
    Object.keys(all).forEach(function (path) {
      var pg = all[path] || {};
      var n = Object.keys(pg.text || {}).length + Object.keys(pg.gallery || {}).length;
      if (!n) delete all[path];
    });
    try {
      if (!Object.keys(all).length) window.sessionStorage.removeItem(PENDING_KEY);
      else window.sessionStorage.setItem(PENDING_KEY, JSON.stringify(all));
      return true;
    } catch (err) { pendingWarn(err); return false; }
  }

  /* Record one applied edit. kind is "text" or "gallery". */
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
      var n = Object.keys(pg.text || {}).length + Object.keys(pg.gallery || {}).length;
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
    if (!Object.keys(texts).length && !Object.keys(galleries).length) return 0;

    scan();
    var applied = 0, lost = [];

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
      g.model = imageRegion.fromExportForm(galleries[slug], g.kind);
      g.model.forEach(function (en) { en.imgId = imageRegion.nextId(); });
      renderGallery(g);
      if (imageRegion.dirty(g)) applied++;
      else pendingDrop(here, "gallery", slug);
    });

    if (lost.length) {
      console.warn("[copy editor] these pending edits no longer match this page and were dropped: " +
        lost.join(", "));
    }
    if (applied) {
      exportedClean = false;
      armGuard();
      console.info("[copy editor] restored " + applied + " pending edit(s) on " + here +
        ". Run edit() to see them, or edit.export() to write them out.");
    }
    return applied;
  }

  function pendingSyncGallery(g) {
    var path = currentPage();
    if (imageRegion.dirty(g)) {
      pendingSet(path, "gallery", g.slug, imageRegion.exportForm(g.model, g.kind));
    }
    else pendingDrop(path, "gallery", g.slug);
  }

  /* Every page this operation must write. A page with nothing changed is
     never fetched and never enters a bundle. */
  function changedPages() {
    var seen = {};
    var here = currentPage();
    if (regions.some(function (r) { return r.edited; }) || gals.some(galDirty)) {
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

  function spliceStaged(src, edits, galleries) {
    var failed = [], skipped = [];
    Object.keys(edits || {}).forEach(function (slug) {
      var out = spliceRegion(src, slug, edits[slug]);
      if (out === null) (optionalSlug(slug) ? skipped : failed).push(slug);
      else src = out;
    });
    if (skipped.length) {
      console.warn("[copy editor] this page does not carry: " + skipped.join(", ") +
        " - skipped, the rest of the page is written as normal.");
    }
    Object.keys(galleries || {}).forEach(function (slug) {
      var open = "<!--[edit:" + slug + "]-->";
      var a = src.indexOf(open);
      var b = a < 0 ? -1 : src.indexOf("<!--[/edit:" + slug + "]-->", a + open.length);
      if (a < 0 || b < 0) { failed.push(slug); return; }
      var im = /\n([ \t]*)</.exec(src.slice(a + open.length, b));
      var out = spliceRegion(src, slug,
        imageRegion.serializeFor(galleries[slug], im ? im[1] : "            ",
                                 kindForSlug(slug)));
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
      if (path === currentPage()) src = spliceAllEdits(src);
      return { path: path, text: spliceStaged(src, texts, waiting.gallery) };
    });
  }
  /* apply every outstanding copy/gallery edit to a pristine source string.
     Text regions first: a deepdive splice carries its template markup
     wholesale, then the nested dd-gallery splice corrects the image list. */
  function spliceAllEdits(src) {
    var failed = [];
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
      /* the blog page renders its stream at load, before this point, so the
         posts already on screen have to be decorated now */
      if (AMH.blog && AMH.blog.editButtons) AMH.blog.editButtons();
      console.info("[copy editor] ON - click a badge (or a row in the panel) to edit. edit.help() lists commands.");
    } else {
      AMH.tool.editPost = null;
      /* strip any Edit buttons the stream rendered while we were active */
      Array.prototype.forEach.call(
        doc.querySelectorAll("#blogFeed article header .bs-retry"),
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
      console.info("[copy editor] OFF" + (dirty() ? " - you still have unexported edits (edit.export())." : "."));
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
    gals.forEach(function (g) {
      if (!galDirty(g)) return;
      var before = imageRegion.fromExportForm(g.original, g.kind);
      renderGallery(g, before.length ? before : g.seeds);
    });
    refreshDirtyUI(); requestReposition();
    return "viewing BEFORE (published content) - edit.after() to switch back";
  };
  api.after = function () {
    scan();
    if (viewing === "after") return "already viewing AFTER";
    viewing = "after";
    regions.forEach(function (r) { if (r.edited) r.el.innerHTML = r.current; });
    gals.forEach(function (g) { if (galDirty(g)) renderGallery(g); });
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
    pendingDropPage(currentPage());
    refreshDirtyUI(); requestReposition();
  }

  api.revertAll = function () {
    scan();
    var n = regions.filter(function (r) { return r.edited; }).length;
    var gn = gals.filter(galDirty).length;
    if (!n && !gn) return "nothing to revert";
    if (!window.confirm("Revert ALL edits (" + n + " text region(s), " + gn +
        " gallery/ies) to published content? This cannot be undone.")) {
      return "cancelled";
    }
    revertThisPage();
    return "reverted " + n + " text region(s) and " + gn + " gallery/ies";
  };

  /* edit.pending() - what is waiting, and on which pages */
  api.pending = function () {
    var c = pendingCount();
    if (!c.changes) { console.info("[copy editor] nothing pending."); return "nothing pending"; }
    var lines = [];
    Object.keys(c.byPage).sort().forEach(function (path) {
      var pg = c.byPage[path];
      Object.keys(pg.text || {}).forEach(function (s) { lines.push("  " + path + "  " + s); });
      Object.keys(pg.gallery || {}).forEach(function (s) { lines.push("  " + path + "  " + s + "  (gallery)"); });
    });
    console.info("[copy editor] " + pendingLabel(c) + ":\n" + lines.join("\n") +
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
      console.warn("[copy editor] no edits to export.");
      return "no edits to export";
    }
    var missing = [];
    editedGals.forEach(function (g) {
      g.model.forEach(function (en) {
        if (en.empty) return;
        if (en.missing === true) missing.push(en.src);
        else if (en.missing === null) missing.push(en.src + " (existence not verified yet)");
      });
    });
    if (missing.length) {
      console.warn("[copy editor] these image files were NOT confirmed on the server - " +
        "the export will reference them anyway, so make sure they exist in img/work/ before uploading:\n  " +
        missing.join("\n  "));
    }
    console.info("[copy editor] exporting " + edited.length + " text region(s) and " +
      editedGals.length + " gallery/ies; this export will write: " +
      pages.map(function (pg) { return pg + " (" + pageLabel(pg) + ")"; }).join(", "));
    Promise.all(pages.map(buildPage))
      .then(function (built) {
        /* one page downloads as itself, so the common case is unchanged; more
           than one has to travel together, because they were edited together */
        if (built.length === 1) {
          downloadFile(built[0].path.replace(/^.*\//, ""), built[0].text, "text/html");
        } else {
          var enc = new TextEncoder();
          downloadFile("publish.zip", zipStore(built.map(function (b) {
            return { name: b.path, bytes: enc.encode(b.text) };
          })));
        }
        exportedClean = true;
        console.info("[copy editor] exported " +
          built.map(function (b) { return b.path; }).join(", ") + " with " +
          edited.length + " text region(s) and " + editedGals.length + " gallery/ies spliced in.");
      })
      .catch(function (err) {
        console.error("[copy editor] export failed: " + err.message +
          (location.protocol === "file:" ? " (export needs the page served over HTTP, not file://)" : ""));
      });
    return "export started (check downloads)";
  };

  /* The composer is publish.js, and it needs the manifest and the reading
     engine as well as itself. All three are on the blog page and nowhere
     else, so say where to go rather than open something that cannot publish.

     The console names stay here whatever file answers them. edit.blog() is
     what people have learned to type. */
  var BLOG_PAGE = "blog.html";
  function blogHere() {
    if (AMH.publish && AMH.blog && doc.getElementById("blogManifest")) return true;
    console.warn("[blog] the composer lives on " + BLOG_PAGE +
      ", which holds the manifest, the reading engine and publish.js. Open " +
      BLOG_PAGE + " and run edit.blog() there.");
    return false;
  }
  var BLOG_ELSEWHERE = "the blog composer lives on " + BLOG_PAGE;

  api.blog = function () {
    if (!blogHere()) return BLOG_ELSEWHERE;
    injectStyles();
    scan();
    armGuard();
    AMH.publish.open(null);
    return "blog composer open";
  };
  /* edit.blog.edit("0007") - or click a post in the panel/stream */
  api.blog.edit = function (id) {
    if (!blogHere()) return BLOG_ELSEWHERE;
    return AMH.publish.edit(id);
  };
  /* re-render all month files with current chrome */
  api.blog.rebuild = function () {
    if (!blogHere()) return BLOG_ELSEWHERE;
    return AMH.publish.rebuild();
  };

  api.help = function () {
    console.info(
      "edit()            toggle editor mode\n" +
      "edit.list()       table of all editable regions\n" +
      "edit.export()     download index.html with your edits\n" +
      "edit.blog()       open the blog composer (publishes a zip bundle)\n" +
      "edit.blog.edit(id) edit a published post (also: panel/stream buttons)\n" +
      "edit.blog.rebuild() re-render all month files with current chrome\n" +
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
  AMH.tool.armGuard = armGuard;            /* arm the unsaved-work unload guard */
  AMH.tool.currentPage = currentPage;      /* the managed path being viewed */
  /* The deployed bytes of a managed page. No argument means the page being
     viewed, which is what the composer wants nearly every time; a path is for
     the publisher, which writes pages nobody is looking at. */
  AMH.tool.pristine = function (path) { return pristine(path || currentPage()); };
  AMH.tool.buildPage = buildPage;          /* those bytes, with edits applied */
  AMH.tool.spliceRegion = spliceRegion;    /* one region, into a source string */
  AMH.tool.spliceAllEdits = spliceAllEdits; /* every outstanding edit at once */
  AMH.tool.changedPages = changedPages;    /* managed pages an export would write */
  AMH.tool.zip = zipStore;                 /* STORE zip writer */
  AMH.tool.download = downloadFile;        /* hand a file to the browser */
  AMH.tool.escAttr = escAttr;          /* a consumer's serializer needs it */
  AMH.tool.tagCheck = tagCheck;            /* tag-balance check before a publish */
  AMH.tool.age = age;                      /* "12 min ago" */
  AMH.tool.toolbar = TOOLS;                /* the formatting buttons */
  AMH.tool.wrap = wrapSelection;           /* both write into the open surface */
  AMH.tool.insert = insertAtCursor;

  /* An export is clean until an edit happens. A consumer that ships the
     outstanding edits inside its own bundle says so here. */
  AMH.tool.markExported = function () { exportedClean = true; };

  /* True while the copy editor owns the keyboard. A consumer with its own
     Escape rule asks before it acts, so the two never fight over one key. */
  AMH.tool.modalOpen = function () { return !!(openRegion || openImage); };

  /* Register the writing surface the toolbar should target while it is on
     screen. The function returns the element, or null when it is not. */
  AMH.tool.editSurface = function (fn) { altSurface = fn; };

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
