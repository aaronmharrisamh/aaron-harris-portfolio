/* ============================================================
   gallery.js - the tile packer for gallery.html.

   Loads on gallery.html only. The page is already correct without
   it: Part 1 authored every train to the invariant by hand, and
   this file recomputes the same answer for the width the reader has.

   The invariant it keeps, from docs/mockup-path-E.png:

     every tile is exactly one row tall
     the spans in a row add to exactly the column count
     only the LAST row of a train may be short

   Because every tile is one row tall and every row is full, an
   interior hole is impossible rather than avoided. That is what
   makes this file small.

   Eight sections, one more than the usual seven. This file holds two
   jobs that do not merge: deciding a layout, and being the editor's
   third image-region consumer. The first is arithmetic on numbers and
   the second is a surface a person uses. If it grows again, split a
   file out rather than adding a ninth.

   Sections:
     1. HEADER AND SETUP         5. DRAWING AND OPENING
     2. CONSTANTS                6. WHEN TO RUN
     3. MEASURING                7. THE EDITOR CONSUMER
     4. THE PACKER               8. ENTRY POINT AND EXPORTS

   Sections 3 and 4 are pure functions. They take numbers and return
   numbers, touch no DOM and hold no state, and the test suite calls
   them directly. Every decision the layout makes is in there; section
   5 only writes down what they decided.

   Who owns what:

     the CSS owns the layout when this file does not run. Section 4
     of site.css maps each authored data-span to a grid span, and
     collapses it at the two narrow breakpoints.

     this file owns the layout when it does run, and says so with an
     inline grid-column, which wins over those rules everywhere.

   The packer never writes back to the markup. A span is a decision
   about one viewport width, recomputed when that width changes, and
   the export reads the authored source rather than the live DOM.
   What the packer decides is never what the export contains: the file
   keeps what the author asked for.

   Section 7 loads after tool.js and claims the trains as image
   regions. It reimplements nothing: the drop, the file check, the
   caption modal and the delete confirm are all the editor's, reached
   through AMH.tool. What it adds is the two numbers a tile carries
   and the controls for them.
   ============================================================ */
/* ==========================================================
   1. HEADER AND SETUP
   ----------------------------------------------------------
   One packer per page load. A page with no train is left alone,
   which is what keeps this file inert anywhere it is loaded by
   mistake.
   ========================================================== */
(function () {
  "use strict";
  var AMH = window.AMH = window.AMH || {};
  if (AMH.gallery) return;
  var doc = document;

  /* ==========================================================
     2. CONSTANTS
     ----------------------------------------------------------
     The three numbers the design rests on. Each is here rather than
     inside the function that uses it, because each is a decision
     someone may want to revisit.
     ========================================================== */

  /* How far an image may be enlarged to cover its slot.

     Measured in DEVICE pixels, not CSS pixels: on a 2x display an
     image drawn at 1.0 CSS scale is already showing one image pixel
     per two device pixels, and that is where softness starts.

     Past roughly a third, upscaling is visible as softness on a
     high-density display. The packer will not choose a span that
     needs more, and takes a narrower one or a short row instead. A
     short row is always better than a soft image. */
  var ZOOM_CAP = 1.35;

  /* The widest a tile may be drawn. The design offers x2, x3 and x4,
     with x1 kept for the packer to close a row with. Nothing is ever
     drawn wider than x4, however much room a row has: a single tile
     across a whole train reads as a banner, not as a gallery. */
  var MAX_SPAN = 4;

  /* The narrowest. A span of 1 is always allowed, even when it breaks
     the zoom cap. The alternatives are a hole in the grid or an image
     that is not shown at all, and both are worse than one soft tile. */
  var MIN_SPAN = 1;

  /* A tile's preference is written for six columns. At a narrower
     breakpoint it is REMAPPED, not scaled: three columns have no room
     for an x4, and scaling would ask for fractions of a column.

     This is the same table site.css applies at each breakpoint, and it
     has to stay the same table. The CSS lays the page out until the
     packer runs; if the two disagreed, the tiles would jump the moment
     it did. Change one and change the other. */
  var COLLAPSE = {
    6: { 1: 1, 2: 2, 3: 3, 4: 4 },
    3: { 1: 1, 2: 1, 3: 2, 4: 3 },
    1: { 1: 1, 2: 1, 3: 1, 4: 1 }
  };

  /* The preference in this many columns. An unlisted column count is
     clamped rather than guessed at, so a future breakpoint renders
     something sensible before anyone adds its row to the table. */
  function preferIn(prefer, cols) {
    var map = COLLAPSE[cols];
    return Math.max(MIN_SPAN, Math.min(map ? (map[prefer] || prefer) : prefer, cols));
  }

  /* ==========================================================
     3. MEASURING
     ----------------------------------------------------------
     Geometry in, one number out: the widest span this image can fill
     without passing the cap. Pure - it never looks at an element.
     ========================================================== */

  /* The CSS width of a slot `span` columns wide, gaps included. */
  function slotWidth(span, geom) {
    var col = (geom.width - geom.gap * (geom.cols - 1)) / geom.cols;
    return col * span + geom.gap * (span - 1);
  }

  /* How far the image is enlarged to cover a slot.

     object-fit: cover fills the shorter side and crops the other, so
     the scale is the LARGER of the two ratios. The device pixel ratio
     multiplies in because that is what the eye is given. */
  function coverScale(natW, natH, w, h, dpr) {
    if (!natW || !natH) return 1;   /* not measured yet: do not constrain */
    return Math.max(w / natW, h / natH) * (dpr || 1);
  }

  /* The widest span within the cap, never below MIN_SPAN and never
     above MAX_SPAN or the column count. */
  function maxSpanFor(natW, natH, geom) {
    var top = Math.min(MAX_SPAN, geom.cols);
    for (var s = top; s > MIN_SPAN; s--) {
      if (coverScale(natW, natH, slotWidth(s, geom), geom.rowH, geom.dpr) <= ZOOM_CAP) {
        return s;
      }
    }
    return MIN_SPAN;
  }

  /* ==========================================================
     4. THE PACKER
     ----------------------------------------------------------
     A list of tiles and a column count in, a list of rows out.

     Pure: no DOM, no measurement, no module state. The same input
     gives the same output every time, which is what lets the suite
     test every rule below without a browser layout.

       in   { prefer, priority, maxSpan }   prefer and maxSpan are spans
       out  [ [ { tile, span, how }, ... ], ... ]

     `how` records why a tile is not at its preferred width, so the
     Part 3 editor can show the reader what the packer did.
     ========================================================== */

  /* The rules, applied in this order:

       1. Sort by priority, then by document order. That is the
          sequence the author asked for.
       2. Fill each row to exactly the column count.
       3. Reorder to fill: when the next tile does not fit the gap,
          pull up the first later tile that does.
       4. Widen before you reorder. Widening keeps the author's order,
          so it is tried first; reordering is the fallback.
       5. The trailing row is exempt. The last row of a train may be
          short, and nothing is widened or moved to square it off.

     Rules 3 and 4 look like one rule from two sides. Both answer a row
     that cannot be closed by placing the next tile at its preference:
     rule 4 when the tile is too NARROW for the gap, rule 3 when it is
     too WIDE.

     One deviation from the plan, and the reason for it. The plan states
     rule 4 as "if the row has n left and the current tile could take n,
     widen it". Taken at its word that fires on the first tile of almost
     every row: place one x2 in a six-column row and four columns are
     left, which most images can reach. Every row would then hold exactly
     two tiles, and the 2+2+2 rows in the mockup this design comes from
     could never occur.

     So rule 4 fires on the condition it exists to prevent: placing the
     tile at its preference would leave a gap that NONE of the remaining
     tiles wants. While something later still wants that gap, the walk
     carries on and rules 2, 3 and 5 close the row between them. */
  function pack(tiles, cols) {
    var queue = tiles.map(function (t, i) { return { t: t, i: i }; });

    /* rule 1. Array.prototype.sort is stable in every engine this site
       runs on, but the index tiebreak says the intent out loud. */
    queue.sort(function (a, b) {
      return (a.t.priority || 0) - (b.t.priority || 0) || a.i - b.i;
    });

    var rows = [], row = [], used = 0;

    /* the widest this tile may be drawn, and the width it asks for */
    function ceiling(e) {
      return Math.max(MIN_SPAN, Math.min(e.t.maxSpan || MAX_SPAN, MAX_SPAN, cols));
    }
    function wants(e) {
      return Math.max(MIN_SPAN, Math.min(preferIn(e.t.prefer || 2, cols), ceiling(e)));
    }

    function put(e, span, how) {
      row.push({ tile: e.t, index: e.i, span: span, how: how });
      used += span;
      if (used >= cols) { rows.push(row); row = []; used = 0; }
    }

    /* Is any tile still waiting that would fit a gap this size at its
       own preferred width? Rule 4 asks before it widens anything. */
    function wantsAtMost(gap) {
      if (gap < MIN_SPAN) return false;
      for (var i = 0; i < queue.length; i++) {
        if (wants(queue[i]) <= gap) return true;
      }
      return false;
    }

    /* rule 3's lookahead. An exact preference first: a tile is not
       stretched to close someone else's row while a tile that already
       wants that width is waiting. Only then, one that can widen into
       the gap within its own cap. */
    function findFit(gap) {
      var i;
      for (i = 0; i < queue.length; i++) {
        if (wants(queue[i]) === gap) return i;
      }
      for (i = 0; i < queue.length; i++) {
        if (ceiling(queue[i]) >= gap && gap <= MAX_SPAN) return i;
      }
      return -1;
    }

    while (queue.length) {
      var left = cols - used;
      var e = queue.shift();
      var want = wants(e);

      if (want === left) { put(e, want, ""); continue; }

      if (want < left) {
        /* rule 4, before rule 3, because widening keeps the author's
           order and reordering does not.

           Two guards. Only while tiles remain: on the last row there is
           no hole to close, and rule 5 leaves it short rather than
           stretch the final image to square off the end. And only when
           the gap it would leave is one nothing else wants - see the
           note above. */
        var gap = left - want;
        if (queue.length && !wantsAtMost(gap) &&
            ceiling(e) >= left && left <= MAX_SPAN) {
          put(e, left, "widened");
        } else {
          put(e, want, "");
        }
        continue;
      }

      /* want > left: this tile cannot take its preference here. */
      var j = findFit(left);
      if (j >= 0) {
        var pulled = queue.splice(j, 1)[0];
        queue.unshift(e);            /* e keeps its place in the order */
        put(pulled, left, "moved");   /* findFit guarantees it reaches */
        continue;
      }

      /* Nothing fits the gap. Narrowing this tile keeps the author's
         order and always closes the row, because MIN_SPAN is 1 and a
         gap is never smaller than that. It is the last resort, and it
         is what makes an interior hole impossible rather than rare. */
      put(e, left, "narrowed");
    }

    /* rule 5: whatever is left over is the trailing row */
    if (row.length) rows.push(row);
    return rows;
  }

  /* ==========================================================
     5. DRAWING AND OPENING
     ----------------------------------------------------------
     Read one train, pack it, write the answer down; and let a reader
     open a tile. This section holds every DOM read and write that a
     reader is affected by, and makes no layout decisions of its own:
     everything it writes came out of section 3 or 4.
     ========================================================== */

  /* The column count comes from site.css, which declares it as --gal-cols
     beside every grid-template-columns. The breakpoints live in one place
     and this follows them.

     Not counted from the computed tracks. That reads back this file's own
     work: a tile carrying an inline span wider than the grid creates
     implicit columns, and the computed value then describes the overflow
     rather than the breakpoint. */
  function columnsOf(train) {
    var cols = parseInt(getComputedStyle(train).getPropertyValue("--gal-cols"), 10);
    return cols > 0 ? cols : 1;
  }

  function geometryOf(train, cols) {
    var cs = getComputedStyle(train);
    return {
      cols: cols,
      width: train.clientWidth,
      gap: parseFloat(cs.columnGap) || 0,
      rowH: parseFloat(cs.getPropertyValue("--gal-row")) || 200,
      dpr: window.devicePixelRatio || 1
    };
  }

  /* The authored order, snapshotted once. Every pack starts from it,
     so a resize re-decides from the same input rather than from the
     result of the last decision. */
  var trains = [];

  function readTrain(train) {
    var els = Array.prototype.slice.call(train.querySelectorAll(".gal-tile"));
    return { el: train, tiles: els };
  }

  /* The packer's record for one train, found or made. The editor rebuilds a
     train's tiles, so the record has to be reachable by element rather than
     only by the index it had at load. */
  function trainEntry(train) {
    for (var i = 0; i < trains.length; i++) {
      if (trains[i].el === train) return trains[i];
    }
    var e = readTrain(train);
    trains.push(e);
    return e;
  }

  function modelFor(el, geom) {
    var img = el.querySelector("img");
    return {
      el: el,
      prefer: parseInt(el.getAttribute("data-w"), 10) || 2,
      priority: parseInt(el.getAttribute("data-priority"), 10) || 0,
      maxSpan: maxSpanFor(img ? img.naturalWidth : 0,
                          img ? img.naturalHeight : 0, geom)
    };
  }

  function layoutTrain(entry) {
    var cols = columnsOf(entry.el);
    var geom = geometryOf(entry.el, cols);
    var model = entry.tiles.map(function (el) { return modelFor(el, geom); });
    var rows = pack(model, cols);

    /* Write spans first, then order. An inline grid-column beats the
       data-span rules in site.css, which is how this file takes over
       from them without either having to know about the other. */
    var order = [];
    rows.forEach(function (r) {
      r.forEach(function (cell) {
        var el = cell.tile.el;
        el.style.gridColumn = "span " + cell.span;
        /* what the packer did, for the Part 3 editor to show */
        if (cell.how) el.setAttribute("data-packed", cell.how);
        else el.removeAttribute("data-packed");
        order.push(el);
      });
    });

    /* Move the nodes rather than set CSS order: a reader on a screen
       reader, or a keyboard, should meet the tiles in the order the page
       shows them.

       Only when the order changed. Re-appending eight nodes that
       are already in the right places is work nobody asked for, and it
       happens on every resize tick. */
    var same = order.length === entry.tiles.length &&
      order.every(function (el, i) { return entry.el.children[i + 1] === el; });
    if (!same) order.forEach(function (el) { entry.el.appendChild(el); });
    return rows;
  }

  function layout() {
    return trains.map(layoutTrain);
  }

  /* ---------------- opening a tile ---------------- */

  /* One train's tiles as lightbox items.

     currentSrc, not the src attribute, for the reason work.js gives: while
     the editor is showing a dropped file the live <img> paints a blob
     preview, and the viewer must show what is on screen rather than the
     img/work/ path the export will carry.

     The caption comes from the figcaption, because that is where a tile
     keeps it: it has to be readable with no script running. */
  function tileItems(train) {
    return Array.prototype.map.call(train.querySelectorAll(".gal-tile"),
      function (fig) {
        var im = fig.querySelector("img");
        var cap = fig.querySelector(".gal-tile__cap");
        return {
          src: im ? (im.currentSrc || im.src) : "",
          caption: cap ? cap.textContent.trim() : "",
          alt: im ? (im.getAttribute("alt") || "") : ""
        };
      });
  }

  /* A click on a tile opens the whole train at that tile.

     The train, not the page. Moving between trains inside the viewer would
     cross from one project to another with nothing to tell the reader it
     had happened.

     What the packer did to a tile does not follow the image in. The grid
     crops to one row height and may widen a slot; the viewer shows the
     photograph whole. That is the promise a cropped tile makes, and this is
     where it is kept - the lightbox fits the image rather than covering the
     slot, so it needs nothing from this file to keep it.

     Delegated, and attached once per train. The editor rebuilds the tiles
     on every model change, so a listener on a tile would not survive. */
  function openTiles(train, fig) {
    if (!AMH.work || !AMH.work.lightbox) return;
    var tiles = Array.prototype.slice.call(train.querySelectorAll(".gal-tile"));
    var i = tiles.indexOf(fig);
    if (i < 0) return;
    AMH.work.lightbox.open(tileItems(train), i, {
      opener: fig,
      label: "Gallery photo"
    });
  }

  function wireTrain(train) {
    if (train.__galLightbox) return;
    train.__galLightbox = true;

    train.addEventListener("click", function (e) {
      /* the editor's own controls sit on top of a tile and stop their own
         clicks; anything that reaches here is a click on the photograph */
      var fig = e.target.closest && e.target.closest(".gal-tile");
      if (!fig || !train.contains(fig)) return;
      openTiles(train, fig);
    });

    /* the affordance the drawer galleries have: focusable, labelled, and
       opened with Enter or Space. A grid of photographs is no less usable
       with a keyboard than a carousel is. */
    train.addEventListener("keydown", function (e) {
      if (e.key !== "Enter" && e.key !== " " && e.key !== "Spacebar") return;
      var fig = e.target.closest && e.target.closest(".gal-tile");
      if (!fig || fig !== e.target) return;
      e.preventDefault();
      openTiles(train, fig);
    });
  }

  /* Every tile is a button to a reader, whether it was authored or drawn. */
  function markOpenable(train) {
    Array.prototype.forEach.call(train.querySelectorAll(".gal-tile"), function (fig) {
      fig.setAttribute("tabindex", "0");
      fig.setAttribute("role", "button");
      var cap = fig.querySelector(".gal-tile__cap");
      fig.setAttribute("aria-label",
        (cap && cap.textContent.trim() ? cap.textContent.trim() : "Gallery photo") +
        " (enlarge)");
    });
  }

  /* ==========================================================
     6. WHEN TO RUN
     ----------------------------------------------------------
     The packer needs every image's natural size, so it waits for
     them. Until it runs, the authored markup stands, which is the
     whole reason Part 1 authored a valid layout by hand.
     ========================================================== */

  /* Repack when an image first reports its size.

     The packer is NOT held back until every image has loaded. The tiles are
     loading="lazy", so one below the fold does not load until someone
     scrolls to it, and a wait for all of them would never end.

     It does not need to wait. An unmeasured image puts no constraint on the
     cap, so it gets its preferred width, so the first pass reproduces the
     authored markup - which is the layout the CSS is already showing. Each
     image that arrives can only narrow its own tile, and the repack is
     coalesced into one frame so a burst of eight arrivals costs one pass. */
  function watchImages(imgs) {
    imgs.forEach(function (img) {
      if (img.complete && img.naturalWidth) return;
      var again = function () { schedule(); };
      img.addEventListener("load", again, { once: true });
      img.addEventListener("error", again, { once: true });
    });
  }

  var frame = 0;
  function schedule() {
    if (frame) return;
    frame = window.requestAnimationFrame(function () { frame = 0; layout(); });
  }

  /* A resize only matters when it changes the answer. The column count
     changes at a breakpoint; the slot width changes continuously, and
     can move a tile past the zoom cap without any breakpoint. So both
     are watched, and the width is rounded to keep a one-pixel drag
     from repacking on every frame. */
  var lastKey = "";
  function layoutKey() {
    return trains.map(function (e) {
      return columnsOf(e.el) + ":" + Math.round(e.el.clientWidth / 20);
    }).join("|") + "@" + (window.devicePixelRatio || 1);
  }

  function relayoutIfChanged() {
    var key = layoutKey();
    if (key === lastKey) return false;
    lastKey = key;
    layout();
    return true;
  }

  var pending = 0;
  function onResize() {
    window.clearTimeout(pending);
    pending = window.setTimeout(relayoutIfChanged, 140);
  }

  /* ==========================================================
     7. THE EDITOR CONSUMER
     ----------------------------------------------------------
     A train is an image region. The editor owns the model; this
     section owns the markup, which is the division the core was
     built for.

     Nothing here duplicates the editor. A drop goes to
     AMH.tool.dropFiles, a chip opens AMH.tool.openImage, and any
     change is reported with AMH.tool.changed. If this section ever
     starts reimplementing one of those, the hook is missing and
     belongs in tool.js.
     ========================================================== */

  var TOOL = null;          /* the editor kit, once tool.js has loaded */
  /* The editor's own rules for a tile, added to the editor's one <style>
     rather than to site.css: none of this exists for a reader, and a
     stylesheet the whole site loads should not carry it. */
  var EDIT_CSS = "" +
    ".gal-tile--edit{outline:1px dashed rgba(74,165,232,.28);outline-offset:-1px;}" +
    ".gal-tile.ced-dropping{outline:2px solid var(--accent);outline-offset:-2px;}" +
    ".gal-tile__chip{position:absolute;top:8px;left:8px;z-index:3;}" +
    ".gal-tile__ctl{position:absolute;top:8px;right:8px;z-index:3;display:flex;" +
      "gap:.3rem;align-items:center;}" +
    ".gal-tile__w{display:flex;gap:2px;background:rgba(8,10,14,.72);" +
      "border:1px solid rgba(74,165,232,.32);border-radius:6px;padding:2px;}" +
    ".gal-w{border:0;background:transparent;color:var(--muted);cursor:pointer;" +
      "font:700 10px/1 Consolas,monospace;padding:3px 5px;border-radius:4px;}" +
    ".gal-w.on{background:var(--accent);color:#0d1014;}" +
    ".gal-w:hover{color:var(--text);}" +
    ".gal-tile__pri{width:44px;background:rgba(8,10,14,.72);color:var(--text);" +
      "border:1px solid rgba(74,165,232,.32);border-radius:6px;padding:2px 4px;" +
      "font:700 10px/1 Consolas,monospace;}" +
    ".gal-tile__mark{position:absolute;bottom:8px;right:8px;z-index:3;" +
      "font:700 9.5px/1 Consolas,monospace;letter-spacing:.1em;border-radius:4px;" +
      "padding:3px 6px;color:#0d1014;}" +
    ".gal-tile__mark--moved{background:var(--accent);}" +
    ".gal-tile__mark--widened{background:#f0883e;}" +
    ".gal-tile__mark--narrowed{background:var(--muted);}";


  /* The two numbers a tile carries beyond src, alt and caption. The core
     does not know what they mean; it carries them into the export form and
     back, which is all this file needs from it. */
  var TILE_FIELDS = ["prefer", "priority"];

  /* Read a tile's own fields off its authored markup. The caption is the
     figcaption rather than a data-caption attribute, because it has to be
     readable with no script running. */
  function readTile(im) {
    var fig = im.closest(".gal-tile");
    var cap = fig && fig.querySelector(".gal-tile__cap");
    return {
      caption: cap ? cap.textContent.trim() : "",
      prefer: fig ? (parseInt(fig.getAttribute("data-w"), 10) || 2) : 2,
      priority: fig ? (parseInt(fig.getAttribute("data-priority"), 10) || 0) : 0
    };
  }

  /* One tile, as authored markup, for the export splice.

     data-span is written as the tile's PREFERENCE, not as whatever the
     packer drew it at. Widening and reordering are decisions about one
     viewport; the file keeps what the author asked for. A reader with no
     script then gets the preference, which is the honest fallback. */
  function serializeTiles(entries, indent) {
    if (!entries.length) return "\n" + indent;
    var lines = entries.map(function (e) {
      var w = e.prefer || 2, p = e.priority || 0;
      var cap = e.caption || "";
      return indent + '  <figure class="gal-tile" data-w="' + w +
        '" data-priority="' + p + '" data-span="' + w + '">\n' +
        indent + '    <img src="' + TOOL.escAttr(e.src) + '" alt="' +
        TOOL.escAttr(e.alt) + '" loading="lazy" decoding="async" />\n' +
        indent + '    <figcaption class="gal-tile__cap">' +
        TOOL.escAttr(cap) + "</figcaption>\n" +
        indent + "  </figure>";
    });
    return "\n" + lines.join("\n") + "\n" + indent;
  }

  /* ---------------- drawing one tile ---------------- */

  function tileFigure(region, entry, index) {
    var fig = doc.createElement("figure");
    fig.className = "gal-tile";
    var w = entry.prefer || 2;
    fig.setAttribute("data-w", w);
    fig.setAttribute("data-priority", entry.priority || 0);
    fig.setAttribute("data-span", w);

    var img = doc.createElement("img");
    img.src = entry.empty ? TOOL.emptyTile : (entry.preview || entry.src);
    img.alt = entry.alt || "";
    img.setAttribute("loading", "lazy");
    img.setAttribute("decoding", "async");
    fig.appendChild(img);

    var cap = doc.createElement("figcaption");
    cap.className = "gal-tile__cap";
    cap.textContent = entry.caption || "";
    fig.appendChild(cap);

    if (TOOL.editorOn()) decorateTile(fig, region, entry, index);
    return fig;
  }

  /* Everything a tile grows while the editor is on, and loses when it is
     off. All of it is scaffolding: none of it is ever exported. */
  function decorateTile(fig, region, entry, index) {
    fig.classList.add("gal-tile--edit");

    /* the chip, which opens the editor's own caption and alt modal */
    var chip = doc.createElement("button");
    chip.type = "button";
    chip.className = "ced-chip gal-tile__chip" +
      (entry.isSeed ? " ced-chip--seed" : "");
    chip.textContent = entry.empty ? "DROP" : (entry.isSeed ? "SEED" : (entry.imgId || "IMG"));
    chip.title = entry.isSeed
      ? "placeholder - drop a real image to replace every seed"
      : (entry.empty ? "empty slot - drop an image here" : "caption, alt and delete");
    chip.addEventListener("click", function (e) {
      e.preventDefault(); e.stopPropagation();
      if (entry.isSeed) return;
      TOOL.openImage(region, index);
    });
    fig.appendChild(chip);

    /* a seed is filler: it takes drops, but carries no controls */
    if (!entry.isSeed) fig.appendChild(tileControls(region, entry, index));

    /* the drop target is the tile itself */
    fig.addEventListener("dragover", function (e) {
      if (!TOOL.editorOn()) return;
      e.preventDefault(); e.stopPropagation();
      e.dataTransfer.dropEffect = "copy";
      fig.classList.add("ced-dropping");
    });
    fig.addEventListener("dragleave", function () { fig.classList.remove("ced-dropping"); });
    fig.addEventListener("drop", function (e) {
      if (!TOOL.editorOn()) return;
      e.preventDefault(); e.stopPropagation();
      fig.classList.remove("ced-dropping");
      var files = Array.prototype.filter.call(
        (e.dataTransfer && e.dataTransfer.files) || [],
        function (f) { return /^image\//.test(f.type); });
      /* a seed grid has an empty model: the editor replaces the whole seed
         set on the first real drop, which is the carousel's behaviour too */
      if (files.length) TOOL.dropFiles(region, files, entry.isSeed ? -1 : index);
    });
  }

  /* The two controls that are new in this consumer.

     Both are labelled preferences rather than commands, because that is what
     they are: the packer may widen a tile or pull it forward under the rules
     in section 4, and the indicators below say when it did. */
  function tileControls(region, entry, index) {
    var bar = doc.createElement("div");
    bar.className = "gal-tile__ctl";

    var widths = doc.createElement("div");
    widths.className = "gal-tile__w";
    widths.title = "preferred width - the packer may widen or move this tile";
    [2, 3, 4].forEach(function (w) {
      var b = doc.createElement("button");
      b.type = "button";
      b.className = "gal-w" + ((entry.prefer || 2) === w ? " on" : "");
      b.textContent = "x" + w;
      b.addEventListener("click", function (e) {
        e.preventDefault(); e.stopPropagation();
        entry.prefer = w;
        TOOL.changed(region);
        render(region);
      });
      widths.appendChild(b);
    });
    bar.appendChild(widths);

    var pri = doc.createElement("input");
    pri.type = "number";
    pri.className = "gal-tile__pri";
    pri.value = String(entry.priority || 0);
    pri.min = "0";
    pri.title = "priority - lower comes first, ties keep document order";
    pri.addEventListener("click", function (e) { e.stopPropagation(); });
    pri.addEventListener("change", function () {
      entry.priority = parseInt(pri.value, 10) || 0;
      TOOL.changed(region);
      render(region);
    });
    bar.appendChild(pri);
    return bar;
  }

  /* ---------------- drawing a whole train ---------------- */

  /* Rebuild the tiles from the model, then pack them. One path: the packer
     is not a second pass over someone else's markup, it is the last step of
     drawing. */
  function render(region, viewEntries) {
    var list = viewEntries ||
      (region.model.length ? region.model : region.seeds);
    var train = region.el;
    Array.prototype.slice.call(train.querySelectorAll(".gal-tile"))
      .forEach(function (el) { train.removeChild(el); });
    list.forEach(function (en, i) { train.appendChild(tileFigure(region, en, i)); });

    var entry = trainEntry(train);
    entry.tiles = Array.prototype.slice.call(train.querySelectorAll(".gal-tile"));
    layoutTrain(entry);
    markPacked(train);
    markOpenable(train);
    watchImages(entry.tiles.map(function (el) { return el.querySelector("img"); })
      .filter(Boolean));
  }

  /* The indicators from the mockup. A tile the packer widened or pulled
     forward says so, so the author can see why their order was not literal
     rather than being left to guess. */
  function markPacked(train) {
    if (!TOOL || !TOOL.editorOn()) return;
    Array.prototype.forEach.call(train.querySelectorAll(".gal-tile"), function (fig) {
      var was = fig.querySelector(".gal-tile__mark");
      if (was) was.remove();
      var how = fig.getAttribute("data-packed");
      if (!how) return;
      var mark = doc.createElement("span");
      mark.className = "gal-tile__mark gal-tile__mark--" + how;
      mark.textContent = how === "moved" ? "MOVED UP"
        : how === "widened" ? "ZOOM" : "NARROWED";
      mark.title = how === "moved"
        ? "pulled forward by the packer to close a row"
        : how === "widened"
          ? "widened to close a row - within the zoom cap"
          : "narrowed to close a row";
      fig.appendChild(mark);
    });
  }

  /* The kind. Every field the core reads about this consumer is here, which
     is what keeps tool.js from knowing what a gallery is. */
  var TILES_KIND = {
    name: "gallery tiles",
    readImgs: function (el) { return el.querySelectorAll(".gal-tile img"); },
    readEntry: readTile,
    fields: TILE_FIELDS,
    /* what a brand new tile asks for: the middle width, and no priority */
    defaults: { prefer: 2, priority: 0 },
    serialize: serializeTiles,
    render: function (g, list) { render(g, list); },
    deferLive: false,
    onScreen: function () { return true; },
    syncSource: false,
    dropWhenEmpty: false,
    seedFallback: true,
    mayBeEmpty: false,
    rowNote: ' <span class="ced-hidden">(tiles)</span>',
    modalNote: ' <span class="ced-hidden" style="color:var(--dim);font-size:.7rem">(gallery tile)</span>',
    lastImageNote: function (r) {
      return r.seeds.length
        ? "\n\nThis is the last image: the seed placeholders will return."
        : "\n\nThis is the last image: the train will be empty.";
    }
  };

  /* Claim every train, by element for this page and by slug for a page the
     editor is not on. A staged edit carries its export form but not its
     markup, and the serializer differs by kind. */
  var trainSlugs = [];

  function claimTrains() {
    TOOL = AMH.tool;
    if (!TOOL || !TOOL.imageRegion || !TOOL.imageRegion.claim) return;
    var slugs = trainSlugs;
    Array.prototype.forEach.call(doc.querySelectorAll(".gal-train"), function (train) {
      var open = train.previousSibling;
      while (open && open.nodeType !== 8) open = open.previousSibling;
      var m = open && /^\[edit:([\w-]+)\]$/.exec(open.nodeValue.trim());
      if (m) slugs.push(m[1]);
    });
    TOOL.imageRegion.claim(function (el) {
      return !!(el.classList && el.classList.contains("gal-train"));
    }, TILES_KIND, slugs);
    TOOL.addStyles(EDIT_CSS);
  }

  /* ==========================================================
     8. ENTRY POINT AND EXPORTS
     ========================================================== */
  function start() {
    var els = doc.querySelectorAll(".gal-train");
    if (!els.length) return;                  /* not the gallery page */
    trains = Array.prototype.slice.call(els).map(readTrain);

    var imgs = [];
    trains.forEach(function (t) {
      t.tiles.forEach(function (el) {
        var img = el.querySelector("img");
        if (img) imgs.push(img);
      });
    });

    lastKey = layoutKey();
    layout();              /* at once, on whatever is known */
    watchImages(imgs);     /* and again as each image arrives */

    trains.forEach(function (e) { wireTrain(e.el); markOpenable(e.el); });
    claimTrains();
    window.addEventListener("resize", onResize);
    /* A lazy image can report its size after the promises settle. One
       more pass at load costs nothing and closes that window. */
    window.addEventListener("load", function () { relayoutIfChanged(); });
  }

  /* AMH.gallery
       pack(tiles, cols)             the packer, pure
       maxSpan(natW, natH, geom)     the zoom cap, pure
       layout()                      repack every train now
       ZOOM_CAP / MAX_SPAN / MIN_SPAN

     The two pure functions are published for the test suite, which
     checks every rule against them directly rather than by reading a
     rendered page. */
  /* The image regions this file's trains registered as, once the editor has
     scanned. Empty until then: registration happens on the first edit(). */
  function regions() {
    if (!TOOL || !TOOL.regionFor) return [];
    return trainSlugs.map(TOOL.regionFor).filter(Boolean);
  }

  AMH.gallery = {
    regions: regions,
    pack: pack,
    preferIn: preferIn,
    maxSpan: maxSpanFor,
    coverScale: coverScale,
    slotWidth: slotWidth,
    layout: layout,
    ZOOM_CAP: ZOOM_CAP,
    MAX_SPAN: MAX_SPAN,
    MIN_SPAN: MIN_SPAN
  };

  start();
})();
