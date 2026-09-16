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
   regions. It reimplements nothing: the wizard, the photos box, the
   trash's question and the caption field are all the editor's,
   reached through AMH.tool. What it adds is where they sit, the two
   numbers a tile carries, and the band a section wears.

   A carousel shows one photograph and takes its controls from chips
   drawn over it. A grid shows every photograph at once, so each one
   carries its own: a chip, its two numbers, a trash, and a pencil on
   a caption that exists.

   The trains are a list, which is the editor's word for a run of
   blocks it may add to, remove from and reorder. This file says what
   one section looks like; tool.js owns the list itself and never
   learns what a gallery is.
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

  /* The grid as numbers, for the one thing arithmetic cannot be left to the
     browser for: the sizes string a tile's markup carries. The browser reads
     it before it has laid anything out, so it has to be told.

     These are site.css section 4's values. They are the same duplication
     COLLAPSE above is, for the same reason and with the same rule: change
     one and change the other. */
  var TABLET = 880;          /* at this width six columns become three */
  var PHONE = 560;           /* and at this one, three become one */
  var WRAP = 1180;           /* .wrap max-width */
  var WRAP_PAD = 96;         /* its gutter, both sides, at that width */
  var GAP = 14;              /* --gal-gap */

  /* How wide a tile of this preference is drawn, in the three bands the
     grid has. Each band states the WIDEST the tile can be in it: a sizes
     string that understates hands the browser a copy too small to be sharp,
     and one that overstates costs bytes and nothing else.

       a phone     one column, the wrap less its gutter
       a tablet    the collapsed preference, out of three columns
       wider       the preference out of six, in a wrap that stops at 1180

     The packer may still widen a tile within the zoom cap. That costs one
     step of sharpness on one tile at one viewport and never a wrong image.
     It is not solved here because it cannot be: the packer decides per
     viewport, and a sizes string is written once. */
  function sizesFor(prefer) {
    var col = (WRAP - WRAP_PAD - GAP * (6 - 1)) / 6;
    var wide = Math.round(col * prefer + GAP * (prefer - 1));
    /* the wrap is about 90vw at the tablet band, where the gutter is 5vw */
    var mid = Math.round(preferIn(prefer, 3) / 3 * 90);
    return "(max-width: " + PHONE + "px) 92vw, " +
           "(max-width: " + TABLET + "px) " + mid + "vw, " + wide + "px";
  }

  /* The slot a tile's markup is written for.

     widest is 0, which is to say a srcset is always written. A tile covers
     its cell: object-fit crops a copy narrower than the slot with or without
     a srcset, so the srcset can only help, by handing a phone the small
     copy. A carousel draws its photo at the photo's own size, which is why
     it states a width there and this does not. */
  function slotFor(prefer) {
    return { sizes: sizesFor(prefer), widest: 0 };
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

  /* The photograph's own size: the width and height the markup declares,
     and the loaded copy's only when it declares none.

     The attribute first, because a tile with a srcset may have painted its
     small copy, and naturalWidth would then report 480 for a photograph
     that is 1920 wide. The zoom cap is a question about the photograph. */
  function naturalOf(img) {
    if (!img) return { w: 0, h: 0 };
    var w = parseInt(img.getAttribute("width"), 10) || 0;
    var h = parseInt(img.getAttribute("height"), 10) || 0;
    if (w && h) return { w: w, h: h };
    return { w: img.naturalWidth, h: img.naturalHeight };
  }

  function modelFor(el, geom) {
    var nat = naturalOf(el.querySelector("img"));
    return {
      el: el,
      prefer: parseInt(el.getAttribute("data-w"), 10) || 2,
      priority: parseInt(el.getAttribute("data-priority"), 10) || 0,
      maxSpan: maxSpanFor(nat.w, nat.h, geom)
    };
  }

  /* A photo shown at its own size leaves room in its tile. The room shows
     the backdrop a carousel draws: the photo's small copy, blurred and
     dimmed. It goes after the photo, so fig.querySelector("img") still
     finds the photo. Every draw of a train comes through layoutTrain, so
     this runs often, and does nothing when the tile has its backdrop. */
  function tileAmbient(fig) {
    var img = fig.querySelector("img");
    if (!img || img.getAttribute("data-truesize") !== "1") return;
    if (fig.querySelector(".gal-tile__ambient")) return;
    var sd = img.getAttribute("data-sd");
    if (!sd) return;
    var back = doc.createElement("img");
    back.className = "gal-tile__ambient";
    back.src = sd;
    back.alt = "";
    back.setAttribute("aria-hidden", "true");
    back.setAttribute("loading", "lazy");
    back.setAttribute("decoding", "async");
    fig.insertBefore(back, img.nextSibling);
  }

  /* A crisp photo keeps hard pixel edges only while its tile holds it at
     its own size. A packed tile can be narrower than a small photo, and a
     browser draws a shrink with hard edges too, which is jagged. A pack
     changes the tile's size, so this runs after each one. */
  function tileCrisp(fig) {
    var img = fig.querySelector("img");
    if (!img || img.getAttribute("data-crisp") !== "1") return;
    var size = /^(\d+)x(\d+)$/.exec(img.getAttribute("data-original-size") || "");
    var fits = !!size && +size[1] <= fig.clientWidth && +size[2] <= fig.clientHeight;
    img.classList.toggle("is-shrunk", !fits);
  }

  function layoutTrain(entry) {
    entry.tiles.forEach(tileAmbient);
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
    entry.tiles.forEach(tileCrisp);
    return rows;
  }

  function layout() {
    return trains.map(layoutTrain);
  }

  /* ---------------- opening a tile ---------------- */

  /* One train's tiles as lightbox items.

     The src attribute, not currentSrc, for the reason work.js gives: an
     image with a srcset may be painting its small copy, and the viewer
     shows the whole picture. A dropped file's blob preview is in the
     attribute too, so the viewer shows what the tile shows.

     The caption comes from the figcaption, because that is where a tile
     keeps it: it has to be readable with no script running. */
  /* A tile's caption as words. The editor wraps them in a span so a field
     can stand in for them, so the span is read when there is one. */
  function capText(fig) {
    var cap = fig.querySelector(".gal-tile__cap");
    if (!cap) return "";
    var text = cap.querySelector(".gal-tile__cap-text");
    return (text || cap).textContent.trim();
  }

  function tileItems(train) {
    return Array.prototype.map.call(train.querySelectorAll(".gal-tile"),
      function (fig) {
        var im = fig.querySelector("img");
        return {
          src: im ? im.src : "",
          caption: capText(fig),
          alt: im ? (im.getAttribute("alt") || "") : "",
          original: im ? (im.getAttribute("data-original") || "") : "",
          originalBytes: im ? (parseInt(im.getAttribute("data-original-bytes"), 10) || 0) : 0,
          crisp: im ? im.getAttribute("data-crisp") === "1" : false
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

  /* The image files of a drop, and nothing else. */
  function imageFiles(e) {
    return Array.prototype.filter.call((e.dataTransfer && e.dataTransfer.files) || [],
      function (f) { return /^image\//.test(f.type); });
  }

  /* The image region one train registered as, or none while the editor has
     not scanned. A listener wired at load has to ask each time. */
  function regionOf(train) {
    var all = regions();
    for (var i = 0; i < all.length; i++) if (all[i].el === train) return all[i];
    return null;
  }

  function wireTrain(train) {
    if (train.__galLightbox) return;
    train.__galLightbox = true;

    /* A drop on the band or in a gap adds to the section, the same as a drop
       on a tile. What a photo joins is the section, not the tile it landed
       on, so the two answer the same way. A tile stops its own drop, so this
       never runs twice for one file. */
    train.addEventListener("dragover", function (e) {
      if (!TOOL || !TOOL.editorOn() || !e.dataTransfer) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    });
    train.addEventListener("drop", function (e) {
      if (!TOOL || !TOOL.editorOn()) return;
      var region = regionOf(train);
      if (!region) return;
      e.preventDefault();
      var files = imageFiles(e);
      if (files.length) TOOL.addPhoto(region, { files: files });
    });

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
      var words = capText(fig);
      fig.setAttribute("aria-label", (words || "Gallery photo") + " (enlarge)");
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

     Nothing here duplicates the editor. A drop, the + Photo pill and the
     empty tile all open AMH.tool.addPhoto; the chip opens
     AMH.tool.editPhotos; the trash asks through AMH.tool.trashPhoto; the
     pencil edits through AMH.tool.captionField; and any change is reported
     with AMH.tool.changed. If this section ever starts reimplementing one
     of those, the hook is missing and belongs in tool.js.

     What is this file's own is where they sit: a band wears the pills, a
     tile wears its two numbers and its trash, and a caption wears its
     pencil. A carousel shows one photograph and takes its controls from
     chips drawn over it; a grid shows every photograph at once, so each
     one carries its own.
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
    ".gal-tile__mark--narrowed{background:var(--muted);}" +
    /* the trash, in the bar with the two numbers and shaped like them */
    ".gal-tile__bin{display:grid;place-items:center;width:23px;height:23px;padding:0;" +
      "background:rgba(8,10,14,.72);border:1px solid rgba(74,165,232,.32);border-radius:6px;" +
      "color:var(--muted);cursor:pointer;}" +
    ".gal-tile__bin svg{width:12px;height:12px;display:block;}" +
    ".gal-tile__bin:hover{border-color:#e5534b;color:#e5534b;}" +
    /* the way into an empty section, on the tile that stands for it */
    ".gal-tile__choose{position:absolute;left:50%;bottom:14%;transform:translateX(-50%);" +
      "z-index:3;white-space:nowrap;}" +
    /* a chip in the before view is a label: it names the photo and opens
       nothing, because nothing is edited there */
    ".gal-tile__chip:disabled{cursor:default;opacity:.75;}" +
    /* the caption, while the editor is on: words, then a pencil, and a field
       in the words' place while one is open */
    ".gal-tile--edit .gal-tile__cap{display:flex;align-items:center;gap:.4rem;}" +
    ".gal-tile__cap-text{min-width:0;overflow:hidden;text-overflow:ellipsis;" +
      "white-space:nowrap;}" +
    ".gal-tile__cap-text[hidden]{display:none;}" +
    ".gal-tile__cap .ced-cappen{flex:none;display:grid;place-items:center;width:20px;" +
      "height:20px;padding:0;border-radius:5px;cursor:pointer;color:#fff;" +
      "background:rgba(8,10,14,.68);border:1px solid rgba(255,255,255,.3);}" +
    ".gal-tile__cap .ced-cappen svg{width:11px;height:11px;display:block;}" +
    ".gal-tile__cap .ced-cappen:hover{background:var(--accent);border-color:var(--accent);" +
      "color:#0d1014;}" +
    ".gal-tile__cap .ced-cappen[hidden]{display:none;}" +
    ".gal-tile__cap .ced-capedit{flex:1 1 auto;min-width:0;padding:.22rem .45rem;" +
      "font:inherit;color:var(--text);background:rgba(8,10,14,.94);" +
      "border:1px solid var(--accent);border-radius:5px;cursor:text;}" +
    ".gal-tile__cap .ced-capedit:focus{outline:none;box-shadow:0 0 0 3px rgba(74,165,232,.28);}" +
    /* the same two numbers, on a row of the PHOTOS box */
    ".gal-extra{display:inline-flex;align-items:center;gap:.4rem;}";


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

  /* The band: what a section is, beyond its photographs.

     The number is not read, because it is not a value. The stylesheet
     counts it, so a section that moves is renumbered by the browser and
     never by a rewrite. The image count is not read either: the serializer
     writes it from the photographs it is writing. */
  function readHead(el) {
    var band = el.querySelector(".gal-train__head");
    function txt(sel) {
      var n = band && band.querySelector(sel);
      return n ? n.textContent.trim() : "";
    }
    return { label: txt(".gal-train__n"), title: txt(".gal-train__title"),
             year: txt(".gal-train__year") };
  }

  /* How many photographs the section shows, which is also how many the
     export writes: the model when it holds any, the seed filler when it
     does not. An unfilled slot is scaffolding and counts as nothing. */
  function shownCount(region) {
    var list = region.model.length ? region.model : region.seeds;
    return list.filter(function (e) { return !e.empty; }).length;
  }
  function countWords(n) {
    return n === 1 ? "1 image" : (n ? n + " images" : "no images");
  }

  /* One whole train, as authored markup, for the export splice: the band
     first, then one figure for each photograph.

     THE BAND IS WRITTEN, NOT KEPT. The region the export replaces holds the
     band as well as the tiles, so a serializer that wrote only figures
     dropped the section's own title on the first published tile edit.

     Two things in the band are never typed. The number is a CSS counter and
     is not in the file at all. The count is written here, from the entries
     being written, so the two cannot disagree.

     data-span is written as the tile's PREFERENCE, not as whatever the
     packer drew it at. Widening and reordering are decisions about one
     viewport; the file keeps what the author asked for. A reader with no
     script then gets the preference, which is the honest fallback. */
  function serializeTrain(entries, indent, head) {
    var h = head || { label: "Section", title: "", year: "" };
    var esc = TOOL.escAttr;
    var band =
      indent + '  <header class="gal-train__head">\n' +
      indent + '    <span class="gal-train__n"><i class="gal-train__i"></i>' +
        esc(h.label || "") + "</span>\n" +
      indent + '    <h3 class="gal-train__title">' + esc(h.title || "") + "</h3>\n" +
      indent + '    <span class="gal-train__rule" aria-hidden="true"></span>\n' +
      indent + '    <span class="gal-train__meta"><span class="gal-train__year">' +
        esc(h.year || "") + '</span><span class="gal-train__count">' +
        countWords(entries.length) + "</span></span>\n" +
      indent + "  </header>";
    /* One attribute a line under the src, the way a carousel writes one:
       what the browser reads to pick and place a copy, then the words, then
       the editor's notes on the files. The continuation aligns under `src`. */
    var pad = "\n" + indent + "         ";
    var lines = entries.map(function (e) {
      var w = e.prefer || 2, p = e.priority || 0;
      /* the src is the contract's too: with Display Maximum UHD on, it is
         the original and not the entry's display copy */
      var src = e.src, shown = "", notes = "";
      AMH.images.attrs(e, slotFor(w)).forEach(function (a) {
        if (a[0] === "src") { src = a[1]; return; }
        var line = pad + a[0] + '="' + esc(a[1]) + '"';
        if (a[0].indexOf("data-") === 0) notes += line;
        else shown += line;
      });
      return indent + '  <figure class="gal-tile" data-w="' + w +
        '" data-priority="' + p + '" data-span="' + w + '">\n' +
        indent + '    <img src="' + esc(src) + '"' + shown +
        pad + 'alt="' + esc(e.alt) + '" loading="lazy" decoding="async"' + notes + " />\n" +
        indent + '    <figcaption class="gal-tile__cap">' +
        esc(e.caption || "") + "</figcaption>\n" +
        indent + "  </figure>";
    });
    return "\n" + [band].concat(lines).join("\n") + "\n" + indent;
  }

  /* ---------------- drawing one tile ---------------- */

  function tileFigure(region, entry) {
    var fig = doc.createElement("figure");
    fig.className = "gal-tile";
    var w = entry.prefer || 2;
    fig.setAttribute("data-w", w);
    fig.setAttribute("data-priority", entry.priority || 0);
    fig.setAttribute("data-span", w);
    /* the entry this tile draws. A control finds its tile again through it,
       because the packer reorders the train and the order on screen is then
       not the model's. */
    fig.__galEntry = entry;

    var img = doc.createElement("img");
    if (entry.empty) img.src = TOOL.photoTile;
    else {
      /* a photo no save has written shows from its blob: URLs, which are one
         copy each and so go with no slot */
      var held = entry.photo ? AMH.images.preview(entry.photo) : null;
      if (held) { held.uhd = entry.uhd; held.truesize = entry.truesize; }
      if (held) setAttrs(img, AMH.images.attrs(held, null));
      else if (entry.preview && entry.preview !== entry.src) img.src = entry.preview;
      else setAttrs(img, AMH.images.attrs(entry, slotFor(w)));
    }
    img.alt = entry.alt || "";
    img.setAttribute("loading", "lazy");
    img.setAttribute("decoding", "async");
    fig.appendChild(img);

    /* the words go in a span of their own, so a field can stand in for them
       while one is open */
    var cap = doc.createElement("figcaption");
    cap.className = "gal-tile__cap";
    var text = doc.createElement("span");
    text.className = "gal-tile__cap-text";
    text.textContent = entry.caption || "";
    cap.appendChild(text);
    fig.appendChild(cap);

    if (TOOL.editorOn()) decorateTile(fig, region, entry);
    return fig;
  }

  function setAttrs(img, pairs) {
    pairs.forEach(function (a) { img.setAttribute(a[0], a[1]); });
  }

  /* The tile one entry is drawn as, found by the entry itself. */
  function tileFor(region, en) {
    var tiles = region.el ? region.el.querySelectorAll(".gal-tile") : [];
    for (var i = 0; i < tiles.length; i++) {
      if (tiles[i].__galEntry === en) return tiles[i];
    }
    return null;
  }

  /* Everything a tile grows while the editor is on, and loses when it is
     off. All of it is scaffolding: none of it is ever exported.

     THE BEFORE VIEW CARRIES NO TOOLS. It draws what is published, from a
     list that is not the model, so a control that named a photo by its place
     in the model would act on the wrong photo. The chip stays, as a label for
     what the reader is looking at. */
  function decorateTile(fig, region, entry) {
    var after = TOOL.viewing() === "after";
    var at = region.model.indexOf(entry);
    fig.classList.add("gal-tile--edit");

    /* the chip: the photos of this section, opened on this one */
    var chip = doc.createElement("button");
    chip.type = "button";
    chip.className = "ced-chip gal-tile__chip" +
      (entry.isSeed ? " ced-chip--seed" : "");
    chip.textContent = entry.empty ? "ADD"
      : (entry.isSeed ? "SEED" : (entry.imgId || "IMG"));
    chip.title = entry.isSeed
      ? "placeholder - the first photo you add replaces every seed"
      : entry.empty ? "add the first photo of this section"
      : "caption, alt text, width and priority";
    chip.disabled = !after || entry.isSeed;
    chip.addEventListener("click", function (e) {
      e.preventDefault(); e.stopPropagation();
      if (chip.disabled) return;
      if (entry.empty) TOOL.addPhoto(region, { choose: true });
      else if (at !== -1) TOOL.editPhotos(region, at);
    });
    fig.appendChild(chip);
    if (!after) return;

    if (entry.empty) emptyTileTools(fig, region);
    else if (!entry.isSeed) {
      fig.appendChild(tileControls(region, entry, at));
      if (entry.caption) capPencil(fig, region, entry);
    }

    /* A DROP ADDS; IT DOES NOT REPLACE. It used to replace the photo it
       landed on, which is a way to lose one by aiming badly. Replace in
       PHOTOS is the way to swap a file for a photo that is named, and the
       carousels made the same change in V088. */
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
      var files = imageFiles(e);
      if (files.length) TOOL.addPhoto(region, { files: files });
    });
  }

  /* The slot a section with no photographs shows. One press opens the file
     picker with the wizard, from the button, from the tile, and from the
     keyboard: a person who has just made a section wants a photo in it.

     The button's click stops at the button, so the tile's own listener does
     not open a second picker. Both stop the click going further, which is
     what keeps the train from opening the viewer on the art. */
  function emptyTileTools(fig, region) {
    function open() { TOOL.addPhoto(region, { choose: true }); }
    var choose = doc.createElement("button");
    choose.type = "button";
    choose.className = "ced-btn ced-choose gal-tile__choose";
    choose.textContent = "Choose a photo";
    choose.addEventListener("click", function (e) {
      e.preventDefault(); e.stopPropagation(); open();
    });
    fig.appendChild(choose);
    fig.addEventListener("click", function (e) {
      e.preventDefault(); e.stopPropagation(); open();
    });
    fig.addEventListener("keydown", function (e) {
      if (e.key !== "Enter" && e.key !== " " && e.key !== "Spacebar") return;
      if (e.target !== fig) return;
      e.preventDefault(); e.stopPropagation(); open();
    });
  }

  /* The pencil on a tile's caption, which edits it where it stands.

     IT SHOWS ON A CAPTION THAT EXISTS. Writing the first one is the wizard's
     job and the PHOTOS box's, the same rule the carousels keep. */
  function capPencil(fig, region, entry) {
    var cap = fig.querySelector(".gal-tile__cap");
    var text = cap ? cap.querySelector(".gal-tile__cap-text") : null;
    if (!text) return;
    var pen = doc.createElement("button");
    pen.type = "button";
    pen.className = "ced-cappen";
    pen.innerHTML = TOOL.icon.pencil;
    pen.title = "Edit this caption";
    pen.setAttribute("aria-label", "Edit this caption");
    /* stopped, so the tile does not open the viewer under the field */
    pen.addEventListener("click", function (e) {
      e.preventDefault(); e.stopPropagation();
      TOOL.captionField(region, entry, cap, text, pen);
    });
    cap.appendChild(pen);
  }

  /* A saved caption, written where it stands.

     Not by drawing the section again. The click that ended the edit is still
     travelling, and a redraw would take the element it was aimed at. That is
     the rule V089 gave the carousels, and a grid needs it more, because every
     photo is on screen at once. */
  function writeTileCaption(region, en, value) {
    var fig = tileFor(region, en);
    if (!fig) return;
    var cap = fig.querySelector(".gal-tile__cap");
    var text = cap ? cap.querySelector(".gal-tile__cap-text") : null;
    if (text) text.textContent = value;
    /* an emptied caption has nothing left to edit in place */
    var pen = cap ? cap.querySelector(".ced-cappen") : null;
    if (pen) pen.hidden = !value;
    markOpenable(region.el);
  }

  /* The two numbers a tile carries, drawn on a row of the PHOTOS box.

     The same classes the tile bar uses, so one rule paints both. The bar is
     the quick way for one tile; the box is the way for a whole section. */
  function drawRowExtras(host, values, changed) {
    var wrap = doc.createElement("span");
    wrap.className = "gal-extra";
    var lab = doc.createElement("span");
    lab.className = "ced-field__label";
    lab.textContent = "Width";
    var widths = doc.createElement("div");
    widths.className = "gal-tile__w";
    [2, 3, 4].forEach(function (w) {
      var b = doc.createElement("button");
      b.type = "button";
      b.className = "gal-w" + ((values.prefer || 2) === w ? " on" : "");
      b.textContent = "x" + w;
      b.addEventListener("click", function () {
        values.prefer = w;
        Array.prototype.forEach.call(widths.children, function (o) {
          o.classList.toggle("on", o === b);
        });
        changed();
      });
      widths.appendChild(b);
    });
    wrap.appendChild(lab);
    wrap.appendChild(widths);

    var pWrap = doc.createElement("label");
    pWrap.className = "gal-extra";
    var pLab = doc.createElement("span");
    pLab.className = "ced-field__label";
    pLab.textContent = "Priority";
    var pri = doc.createElement("input");
    pri.type = "number";
    pri.className = "gal-tile__pri";
    pri.min = "0";
    pri.value = String(values.priority || 0);
    pri.title = "lower comes first, ties keep the order on screen";
    pri.addEventListener("change", function () {
      values.priority = parseInt(pri.value, 10) || 0;
      changed();
    });
    pWrap.appendChild(pLab);
    pWrap.appendChild(pri);

    host.appendChild(wrap);
    host.appendChild(pWrap);
  }

  /* The controls one tile carries: the two numbers, and the trash.

     The numbers are labelled preferences rather than commands, because that
     is what they are: the packer may widen a tile or pull it forward under
     the rules in section 4, and the indicators below say when it did. */
  function tileControls(region, entry, at) {
    var bar = doc.createElement("div");
    bar.className = "gal-tile__ctl";
    /* the bar sits over the photograph, and a press on it is not a press on
       the photograph */
    bar.addEventListener("click", function (e) { e.stopPropagation(); });

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

    var bin = doc.createElement("button");
    bin.type = "button";
    bin.className = "gal-tile__bin";
    bin.innerHTML = TOOL.icon.trash;
    bin.title = "Delete this photo";
    bin.setAttribute("aria-label", "Delete this photo");
    bin.addEventListener("click", function (e) {
      e.preventDefault(); e.stopPropagation();
      if (at !== -1) TOOL.trashPhoto(region, at);
    });
    bar.appendChild(bin);
    return bar;
  }

  /* ---------------- drawing a whole train ---------------- */

  /* Rebuild the tiles from the model, then pack them. One path: the packer
     is not a second pass over someone else's markup, it is the last step of
     drawing. */
  /* Draw the band from the region's head, and its count from the model, so
     a change made in the section form is on screen the moment it is
     applied. The number is left to the stylesheet. */
  function renderHead(region) {
    var head = region.head;
    var band = region.el.querySelector(".gal-train__head");
    if (!head || !band) return;
    /* the editor's own controls come off first: they are scaffolding, and
       the band is drawn again from the model every time */
    var was = band.querySelector(".ced-pills");
    if (was) band.removeChild(was);
    var n = band.querySelector(".gal-train__n");
    if (n) {
      n.textContent = "";
      var mark = doc.createElement("i");
      mark.className = "gal-train__i";
      n.appendChild(mark);
      n.appendChild(doc.createTextNode(head.label || ""));
    }
    var title = band.querySelector(".gal-train__title");
    if (title) title.textContent = head.title || "";
    var year = band.querySelector(".gal-train__year");
    if (year) year.textContent = head.year || "";
    var count = band.querySelector(".gal-train__count");
    if (count) count.textContent = countWords(shownCount(region));
    /* Open this section, and move it. The editor draws them and knows what
       they do; this file only says where they sit. They go inside the band
       because the band is drawn from the model, so nothing here is ever
       serialized. */
    var pills = TOOL && TOOL.listPills
      ? TOOL.listPills("gallery", region.el.getAttribute("data-section") || "")
      : null;
    if (pills) {
      /* The fourth pill: the way a photograph gets into this section. It goes
         in the same wrap as the other three, so a band wears one set of
         controls and not two, and it is drawn on the same condition they are:
         listPills answers with nothing while the editor is off. */
      pills.appendChild(TOOL.pill("Photo", TOOL.icon.plus, function () {
        TOOL.addPhoto(region, {});
      }));
      band.appendChild(pills);
    }
  }

  function render(region, viewEntries) {
    var list = viewEntries ||
      (region.model.length ? region.model : region.seeds);
    var train = region.el;
    renderHead(region);
    Array.prototype.slice.call(train.querySelectorAll(".gal-tile"))
      .forEach(function (el) { train.removeChild(el); });
    list.forEach(function (en) { train.appendChild(tileFigure(region, en)); });

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
  /* One whole section as markup, markers and all, written at no indent.

     The export writes this same string, so what lands on the page and what
     lands in the file cannot differ. The band comes from the serializer, so
     there is one description of what a section looks like and not two. */
  function makeSection(head, id, entries) {
    var inner = serializeTrain(entries || [], "", head);
    return "<!--[item:" + id + "]-->\n" +
      "<!--[edit:gal-" + id + "]-->\n" +
      '<div class="gal-train" data-section="' + TOOL.escAttr(id) + '">' + inner + "</div>\n" +
      "<!--[/edit:gal-" + id + "]-->\n" +
      "<!--[/item:" + id + "]-->";
  }

  /* What one section is, for the editor's list engine.

     A section is not tied to a project. It is a label, a title, a year and
     its photographs, so a set of travel pictures is as much a section as a
     piece of work is. tool.js owns the list and draws the controls; this is
     everything it has to be told. */
  var SECTION_LIST = {
    name: "gallery",
    noun: "section",
    nameKey: "title",
    fields: [
      { key: "label", label: "Label", start: "Section",
        hint: "Project, Travel, Sketches" },
      { key: "title", label: "Title", hint: "what this section is called" },
      { key: "year", label: "Year", hint: "2026, or 2011-2016" }
    ],
    slugFor: function (id) { return "gal-" + id; },
    make: makeSection,
    countNote: function (region) {
      return countWords(shownCount(region)) +
        ", counted for you. The section number is counted too.";
    }
  };

  /* A train the editor put on the page after this file looked at it: wire
     it, draw it, and take it into the layout.

     A train the file was served with is already in the packer's records, so
     this leaves its authored markup exactly as it is. That is what keeps a
     scan from redrawing eight tiles that are already correct. */
  function adoptTrain(region) {
    if (trainSlugs.indexOf(region.slug) === -1) trainSlugs.push(region.slug);
    wireTrain(region.el);
    var known = trains.some(function (e) { return e.el === region.el; });
    if (known) { markOpenable(region.el); return; }
    render(region);
    relayoutIfChanged();
  }
  /* The inverse, before the editor forgets the region. */
  function dropTrain(region) {
    var at = trainSlugs.indexOf(region.slug);
    if (at !== -1) trainSlugs.splice(at, 1);
    for (var i = 0; i < trains.length; i++) {
      if (trains[i].el === region.el) { trains.splice(i, 1); return; }
    }
  }

  var TILES_KIND = {
    name: "gallery tiles",
    /* a tile's backdrop is drawn, not authored, and is never a photo */
    readImgs: function (el) { return el.querySelectorAll(".gal-tile img:not(.gal-tile__ambient)"); },
    readEntry: readTile,
    readHead: readHead,
    fields: TILE_FIELDS,
    /* a box is named for the section and its sentences say "section" */
    describe: function (g) {
      return { name: (g.head && g.head.title) || "Section", noun: "section" };
    },
    rowExtras: drawRowExtras,
    captionWrite: writeTileCaption,
    /* what a brand new tile asks for: the middle width, and no priority */
    defaults: { prefer: 2, priority: 0 },
    serialize: serializeTrain,
    render: function (g, list) { render(g, list); },
    adopt: adoptTrain,
    drop: dropTrain,
    deferLive: false,
    onScreen: function () { return true; },
    syncSource: false,
    dropWhenEmpty: false,
    seedFallback: true,
    /* A section with no photographs is legitimate: a new one starts that
       way, and its one slot is a way in. The seed filler belongs to the one
       section the site was built with, and a new section has none to fall
       back to. */
    mayBeEmpty: true,
    rowNote: ' <span class="ced-hidden">(tiles)</span>',
    lastImageNote: function (r) {
      return r.seeds.length
        ? "\n\nThis is the last image: the seed placeholders will return."
        : "\n\nThis is the last image: the section will be empty.";
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
    /* the trains are a list: the editor may add one, remove one and reorder
       them, which no other region on the site allows */
    if (TOOL.listKind) TOOL.listKind(SECTION_LIST);
    TOOL.addStyles(EDIT_CSS);
  }

  /* ==========================================================
     8. ENTRY POINT AND EXPORTS
     ========================================================== */
  function start() {
    /* Is this the gallery page, which is not the same question as whether it
       holds any sections. Every one of them can be deleted now, and a page
       with none still has to offer a way to make the next. */
    if (!doc.querySelector(".gal .wrap")) return;
    var els = doc.querySelectorAll(".gal-train");
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
