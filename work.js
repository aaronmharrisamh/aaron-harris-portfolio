/* ============================================================
   work.js - the portfolio's image surfaces: the fullscreen lightbox,
   the deep-dive drawer, and the project carousels.

   Loads after site.js. Publishes AMH.work.buildGalleries, which the
   editor calls after an image edit and the blog engine calls after it
   renders a post that carries a gallery.

   No libraries. Every surface here is built from the authored markup.

   Sections:
     1. SETUP                   4. CAROUSEL SETTINGS
     2. LIGHTBOX                5. CAROUSELS
     3. DEEP-DIVE DRAWER        6. ENTRY POINT AND EXPORTS

   AMH.work.lightbox is the viewer, published for consumers outside this
   file. It takes a list of items and knows nothing about where they came
   from, which is what lets a tile grid open it without a second viewer.
   ============================================================ */
(function () {
  "use strict";
  /* ==========================================================
     1. SETUP
     ========================================================== */
  var AMH = window.AMH = window.AMH || {};
  var doc = document;

  /* Turn authored <img> elements into lightbox items.

     currentSrc, not the src attribute: while the editor is showing a dropped
     file, the live <img> is painting a blob: preview and the attribute still
     holds the img/work/ path the export will carry. The viewer must show what
     is on screen. */
  function itemsFromImgs(imgEls) {
    return Array.prototype.map.call(imgEls, function (im) {
      return {
        src: im.currentSrc || im.src,
        caption: im.getAttribute("data-caption") || "",
        alt: im.getAttribute("alt") || ""
      };
    });
  }
  /* ==========================================================
     2. LIGHTBOX
     ----------------------------------------------------------
     One fullscreen viewer, shared by every gallery and by the
     deep-dive drawer.

     Pointer devices fit the image to the page and do not zoom. The
     subtitle appears on mouse movement or on an image change, then
     fades while the pointer is still.

     Touch devices add pinch zoom with clamped pan, and drag to change
     photos while not zoomed, which matches the carousel's swipe.

     Both get close, prev and next controls, Esc and backdrop close,
     a focus trap, and the rest of the page marked inert.

     Interface:

       lightbox.open(items, startIndex, opts)
       lightbox.close()
       lightbox.isOpen()

     items is a list of { src, caption, alt }. That is deliberately the
     subset the image-region core in tool.js already produces, so a
     consumer passes its model straight through with no adapter. Use
     itemsFromImgs() above to build the list from markup.

     opts, all optional:
       nav     false hides the prev and next controls, for a consumer
               whose item has nothing to navigate to
       opener  the element focus returns to on close
       label   the dialog's accessible name

     The viewer holds no reference to a carousel, a gallery or a tile. It
     is handed a list and an index.

     BODY SCROLL LOCK

     Body scroll is locked by a class on <body>, and each component
     removes only the class it added. More than one may be held at once
     when one layers over another: this viewer opens on top of the
     deep-dive drawer, so dd-open and lb-open are both set until each
     closes. A component that takes the page over rather than layering on
     it closes the other holders first, which is what the blog stream
     does to the drawer.
     ========================================================== */
  var lightbox = (function () {
    var root, stage, imgEl, imgInEl, captionEl, closeBtn, prevBtn, nextBtn;
    var mainEl = doc.querySelector("main");
    /* Resolved here, not read as a bare name. <header id="header"> puts a
       global on window, so the bare name happened to work on this page and
       would silently be undefined on a page whose header has no id. */
    var headerEl = doc.getElementById("header");
    var images = [], current = 0, opener = null, lastFocus = null, built = false;
    var zoomable = false, scale = 1, tx = 0, ty = 0;
    var MAX = 4;
    var captionIdle = 0, LB_CAPTION_HOLD = 2800;   /* subtitle hold before it fades */

    function svgButton(cls, label, inner) {
      var b = doc.createElement("button");
      b.type = "button"; b.className = cls;
      b.setAttribute("aria-label", label); b.innerHTML = inner;
      return b;
    }
    function chevron(dir) {
      var pts = dir === "prev" ? "15 18 9 12 15 6" : "9 18 15 12 9 6";
      return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
        'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="' +
        pts + '"/></svg>';
    }
    var X_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
      'stroke-linecap="round" aria-hidden="true"><line x1="6" y1="6" x2="18" y2="18"/>' +
      '<line x1="18" y1="6" x2="6" y2="18"/></svg>';

    function build() {
      root = doc.createElement("div");
      root.className = "lightbox";
      root.setAttribute("role", "dialog");
      root.setAttribute("aria-modal", "true");
      root.setAttribute("aria-label", "Image viewer");
      root.hidden = true;

      stage = doc.createElement("div");
      stage.className = "lightbox__stage";
      /* incoming layer first (beneath), active layer on top */
      imgInEl = doc.createElement("img");
      imgInEl.className = "lightbox__img lightbox__img--incoming";
      imgInEl.alt = ""; imgInEl.draggable = false;
      imgInEl.setAttribute("aria-hidden", "true");
      stage.appendChild(imgInEl);
      imgEl = doc.createElement("img");
      imgEl.className = "lightbox__img lightbox__img--active";
      imgEl.alt = ""; imgEl.draggable = false;
      stage.appendChild(imgEl);

      closeBtn = svgButton("lightbox__close", "Close image viewer", X_ICON);
      prevBtn = svgButton("lightbox__nav lightbox__nav--prev", "Previous image", chevron("prev"));
      nextBtn = svgButton("lightbox__nav lightbox__nav--next", "Next image", chevron("next"));
      captionEl = doc.createElement("div");
      captionEl.className = "lightbox__caption";

      root.appendChild(stage);
      root.appendChild(closeBtn);
      root.appendChild(prevBtn);
      root.appendChild(nextBtn);
      root.appendChild(captionEl);
      doc.body.appendChild(root);

      closeBtn.addEventListener("click", close);
      prevBtn.addEventListener("click", function (e) { e.stopPropagation(); go(current - 1); });
      nextBtn.addEventListener("click", function (e) { e.stopPropagation(); go(current + 1); });
      /* click on the backdrop (or stage padding), but not the image or a
         control, closes. */
      root.addEventListener("click", function (e) {
        if (e.target === root || e.target === stage) close();
      });
      imgEl.addEventListener("click", function (e) { e.stopPropagation(); });
      /* Desktop: any mouse movement re-summons the subtitle; the idle timer in
         revealCaption() then fades it back out once the pointer goes still. */
      root.addEventListener("mousemove", revealCaption);
      doc.addEventListener("keydown", onKey);
      bindTouch();
      built = true;
    }

    /* ---- keyboard + focus trap ---- */
    function onKey(e) {
      if (!root || root.hidden) return;
      if (e.key === "Escape") { e.preventDefault(); close(); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); go(current - 1); }
      else if (e.key === "ArrowRight") { e.preventDefault(); go(current + 1); }
      else if (e.key === "Tab") { trap(e); }
    }
    function controls() {
      return [closeBtn, prevBtn, nextBtn].filter(function (b) { return b.style.display !== "none"; });
    }
    function trap(e) {
      var f = controls();
      if (!f.length) return;
      var i = f.indexOf(doc.activeElement);
      if (i === -1) { e.preventDefault(); f[0].focus(); }
      else if (e.shiftKey && i === 0) { e.preventDefault(); f[f.length - 1].focus(); }
      else if (!e.shiftKey && i === f.length - 1) { e.preventDefault(); f[0].focus(); }
    }

    /* hide the rest of the page from AT + tab order while open */
    function inert(on) {
      [headerEl, mainEl].forEach(function (el) {
        if (!el) return;
        if (on) { el.setAttribute("aria-hidden", "true"); el.setAttribute("inert", ""); }
        else { el.removeAttribute("aria-hidden"); el.removeAttribute("inert"); }
      });
    }

    /* Open the viewer on a list of items. Returns false, and does nothing,
       when there is nothing to show. See the section header for opts. */
    function open(items, startIndex, opts) {
      if (!built) build();
      images = (items || []).filter(function (it) { return it && it.src; })
        .map(function (it) {
          return { src: it.src, caption: it.caption || "", alt: it.alt || "" };
        });
      if (!images.length) return false;
      opts = opts || {};
      opener = opts.opener || null;
      lastFocus = doc.activeElement;
      current = startIndex || 0;
      if (current < 0 || current >= images.length) current = 0;
      zoomable = !!(window.matchMedia && window.matchMedia("(pointer: coarse)").matches);
      root.setAttribute("aria-label", opts.label || "Image viewer");
      root.hidden = false;
      doc.body.classList.add("lb-open");
      inert(true);
      /* one item has nothing to navigate to, and a consumer can suppress the
         controls even when it passes several */
      var many = opts.nav === false ? false : images.length > 1;
      prevBtn.style.display = nextBtn.style.display = many ? "" : "none";
      render();
      closeBtn.focus();
      return true;
    }
    function isOpen() { return !!(root && !root.hidden); }

    /* Fade the subtitle in, then schedule it to dissolve after a gracious beat.
       Shared by the image-change, desktop mouse-move, and touch-drag paths. */
    function revealCaption() {
      if (!captionEl || captionEl.classList.contains("is-empty")) return;
      captionEl.classList.add("is-visible");
      if (captionIdle) window.clearTimeout(captionIdle);
      captionIdle = window.setTimeout(function () {
        captionIdle = 0;
        captionEl.classList.remove("is-visible");
      }, LB_CAPTION_HOLD);
    }

    function render() {
      resetZoom();
      var im = images[current];
      imgEl.src = im.src;
      imgEl.alt = im.alt;
      if (im.caption) { captionEl.textContent = im.caption; captionEl.classList.remove("is-empty"); }
      else { captionEl.textContent = ""; captionEl.classList.add("is-empty"); }
      revealCaption();   /* glides in on every image change (incl. open) */
    }
    function go(i) {
      var n = images.length;
      if (!n) return;
      current = ((i % n) + n) % n;       /* wrap-around */
      render();
    }
    function close() {
      if (!root || root.hidden) return;
      root.hidden = true;
      doc.body.classList.remove("lb-open");
      inert(false);
      if (captionIdle) { window.clearTimeout(captionIdle); captionIdle = 0; }
      if (captionEl) captionEl.classList.remove("is-visible");
      if (swipeSettle) { window.clearTimeout(swipeSettle); swipeSettle = 0; }
      if (imgInEl) { imgInEl.style.transition = ""; imgInEl.style.opacity = ""; }
      resetZoom();
      var back = opener || lastFocus;
      if (back && typeof back.focus === "function") back.focus();
    }

    /* ---- zoom / pan (touch only) ---- */
    function applyTransform() {
      imgEl.style.transform = "translate(" + tx + "px," + ty + "px) scale(" + scale + ")";
      imgEl.classList.toggle("is-zoomed", scale > 1.01);
    }
    function resetZoom() { scale = 1; tx = 0; ty = 0; if (imgEl) applyTransform(); }
    function clampPan() {
      var r = stage.getBoundingClientRect();
      var mx = (scale - 1) * r.width / 2, my = (scale - 1) * r.height / 2;
      tx = Math.max(-mx, Math.min(mx, tx));
      ty = Math.max(-my, Math.min(my, ty));
    }
    function dist(t) {
      var dx = t[0].clientX - t[1].clientX, dy = t[0].clientY - t[1].clientY;
      return Math.sqrt(dx * dx + dy * dy);
    }
    function center() {
      var r = stage.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }
    var pinch = null, pan = null, lastTap = 0, swipe = null, swipeSettle = 0;

    /* Reset the inline styles used by a drag so CSS governs again: the active
       layer falls back to visible/identity, the incoming layer back to hidden. */
    function clearSwipeStyles() {
      imgEl.style.transition = "";
      imgEl.style.opacity = "";
      imgInEl.style.transition = "";
      imgInEl.style.opacity = "";     /* → class default: hidden */
      applyTransform();               /* normalize active transform (identity unless zoomed) */
    }

    function bindTouch() {
      stage.addEventListener("touchstart", function (e) {
        if (!zoomable) return;
        /* a new touch interrupts any in-flight settle animation, resetting to a
           clean state (if the swap hadn't run yet, we stay on the current photo) */
        if (swipeSettle) { window.clearTimeout(swipeSettle); swipeSettle = 0; clearSwipeStyles(); }
        if (e.touches.length === 2) {
          var c = center();
          var mx = (e.touches[0].clientX + e.touches[1].clientX) / 2;
          var my = (e.touches[0].clientY + e.touches[1].clientY) / 2;
          pinch = { d0: dist(e.touches), s0: scale, fx: mx - c.x, fy: my - c.y, tx0: tx, ty0: ty };
          pan = null; swipe = null;
        } else if (e.touches.length === 1) {
          pinch = null;
          if (scale > 1.01) {
            /* zoomed in → one finger pans the photo (swipe-to-change is off) */
            pan = { x: e.touches[0].clientX - tx, y: e.touches[0].clientY - ty };
            swipe = null;
          } else {
            /* at natural size → one finger drags between photos (like the gallery) */
            pan = null;
            swipe = images.length > 1 ? {
              x0: e.touches[0].clientX, y0: e.touches[0].clientY,
              t0: Date.now(), lock: null, target: -1,
              width: stage.getBoundingClientRect().width || 1
            } : null;
          }
        }
      }, { passive: true });

      stage.addEventListener("touchmove", function (e) {
        if (!zoomable) return;
        if (pinch && e.touches.length === 2) {
          e.preventDefault();
          var s = Math.max(1, Math.min(MAX, pinch.s0 * (dist(e.touches) / pinch.d0)));
          tx = pinch.fx - (pinch.fx - pinch.tx0) * (s / pinch.s0);   /* keep focal point fixed */
          ty = pinch.fy - (pinch.fy - pinch.ty0) * (s / pinch.s0);
          scale = s; clampPan(); applyTransform();
        } else if (pan && e.touches.length === 1 && scale > 1.01) {
          e.preventDefault();
          tx = e.touches[0].clientX - pan.x;
          ty = e.touches[0].clientY - pan.y;
          clampPan(); applyTransform();
        } else if (swipe && e.touches.length === 1 && scale <= 1.01) {
          var dx = e.touches[0].clientX - swipe.x0, dy = e.touches[0].clientY - swipe.y0;
          if (swipe.lock === null) {
            if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;   /* wait for a clear direction */
            swipe.lock = Math.abs(dx) > Math.abs(dy) ? "h" : "v";
          }
          if (swipe.lock !== "h") return;
          e.preventDefault();
          var n = images.length;
          var tgt = dx < 0 ? (current + 1) % n : (current - 1 + n) % n;
          if (tgt !== swipe.target) { swipe.target = tgt; imgInEl.src = images[tgt].src; }
          var prog = Math.min(1, Math.abs(dx) / (swipe.width * 0.6));
          imgEl.style.transition = "none";
          imgEl.style.transform = "translateX(" + dx + "px)";
          imgInEl.style.transition = "none";
          imgInEl.style.opacity = String(prog);
          revealCaption();   /* the subtitle answers the drag */
        }
      }, { passive: false });

      stage.addEventListener("touchend", function (e) {
        if (!zoomable) return;

        /* a committed horizontal drag resolves to a photo change (or springs back) */
        if (swipe && swipe.lock === "h") {
          var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
          var ct = e.changedTouches[0];
          var dx = ct ? ct.clientX - swipe.x0 : 0;
          var dt = Date.now() - swipe.t0, moved = Math.abs(dx);
          var flick = dt < 300 && moved > 40 && moved / dt > 0.3;
          var commit = swipe.target >= 0 && (moved > swipe.width * 0.25 || flick);
          var dur = reduce ? 0 : 260;
          var dir = dx < 0 ? -1 : 1, w = swipe.width, target = swipe.target;
          if (commit) {
            /* active photo slides off + fades; the incoming layer (already the
               target, centered) fades up to take its place. */
            imgEl.style.transition = "transform " + dur + "ms ease, opacity " + dur + "ms ease";
            imgEl.style.transform = "translateX(" + (dir * w) + "px)";
            imgEl.style.opacity = "0";
            imgInEl.style.transition = "opacity " + dur + "ms ease";
            imgInEl.style.opacity = "1";
            swipeSettle = window.setTimeout(function () {
              swipeSettle = 0;
              /* hand off under cover: swap the active layer to the target
                 INSTANTLY (transition off) while the incoming layer still shows
                 the same photo, then hide the incoming layer. No flicker. */
              imgEl.style.transition = "none";
              go(target);                 /* src→target, transform→identity, caption reveal */
              imgEl.style.opacity = "1";
              imgInEl.style.transition = "none";
              imgInEl.style.opacity = "0";
              window.requestAnimationFrame(function () {
                imgEl.style.transition = ""; imgEl.style.opacity = "";
                imgInEl.style.transition = ""; imgInEl.style.opacity = "";
              });
            }, dur + 20);
          } else {
            /* not far enough → spring the active photo back, fade the target out */
            imgEl.style.transition = "transform " + dur + "ms ease, opacity " + dur + "ms ease";
            imgEl.style.transform = "translateX(0)";
            imgEl.style.opacity = "1";
            imgInEl.style.transition = "opacity " + dur + "ms ease";
            imgInEl.style.opacity = "0";
            swipeSettle = window.setTimeout(function () { swipeSettle = 0; clearSwipeStyles(); }, dur + 20);
          }
          swipe = null; pinch = null; pan = null;
          return;
        }
        swipe = null;

        if (e.touches.length === 0) {
          if (scale <= 1.01) { scale = 1; tx = 0; ty = 0; applyTransform(); }
          if (pinch === null && pan === null) {           /* a clean tap: detect double-tap */
            var now = Date.now();
            if (now - lastTap < 300) {
              if (scale > 1.01) { resetZoom(); } else { scale = 2; clampPan(); applyTransform(); }
              lastTap = 0; e.preventDefault();
            } else { lastTap = now; }
          }
        }
        if (e.touches.length < 2) pinch = null;
        if (e.touches.length === 0) pan = null;
      }, { passive: false });
    }

    return { open: open, close: close, isOpen: isOpen };
  })();

  /* ==========================================================
     3. DEEP-DIVE DRAWER
     ----------------------------------------------------------
     The "Learn more" slide-over. Its content comes from the project's
     <template class="deepdive" data-title data-subtitle>.

     A single photo (figure.dd-figure img) opens in the lightbox above,
     on click or on Enter or Space. Esc, the scrim and the close button
     all dismiss it, and focus returns to the trigger.

     The shell is built on first open, not at load: most visitors never
     open a drawer.
     ========================================================== */
  (function () {
    var triggers = doc.querySelectorAll(".project__more");
    if (!triggers.length) return;

    var root, panel, titleEl, subEl, bodyEl, closeBtn;
    var lastFocus = null, built = false;

    var DD_X = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="2" stroke-linecap="round" aria-hidden="true">' +
      '<line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg>';

    function build() {
      root = doc.createElement("div");
      root.className = "dd";
      root.setAttribute("role", "dialog");
      root.setAttribute("aria-modal", "true");
      root.setAttribute("aria-label", "Project detail");

      var scrim = doc.createElement("div");
      scrim.className = "dd__scrim";

      panel = doc.createElement("aside");
      panel.className = "dd__panel";

      var head = doc.createElement("div");
      head.className = "dd__head";
      var eyebrow = doc.createElement("div");
      eyebrow.className = "dd__eyebrow";
      eyebrow.textContent = "Deep dive";
      titleEl = doc.createElement("h2");
      titleEl.className = "dd__title";
      subEl = doc.createElement("p");
      subEl.className = "dd__subtitle";
      closeBtn = doc.createElement("button");
      closeBtn.type = "button";
      closeBtn.className = "dd__close";
      closeBtn.setAttribute("aria-label", "Close project detail");
      closeBtn.innerHTML = DD_X;
      head.appendChild(eyebrow);
      head.appendChild(titleEl);
      head.appendChild(subEl);
      head.appendChild(closeBtn);

      bodyEl = doc.createElement("div");
      bodyEl.className = "dd__body";

      panel.appendChild(head);
      panel.appendChild(bodyEl);
      root.appendChild(scrim);
      root.appendChild(panel);
      doc.body.appendChild(root);

      scrim.addEventListener("click", close);
      closeBtn.addEventListener("click", close);
      doc.addEventListener("keydown", function (e) {
        if (!root || !root.classList.contains("is-open")) return;
        if (e.key === "Escape") { e.preventDefault(); close(); }
        else if (e.key === "Tab") { trap(e); }
      });
      /* single photos in the drawer open the shared lightbox */
      bodyEl.addEventListener("click", function (e) {
        var img = e.target && e.target.closest ? e.target.closest("figure.dd-figure img") : null;
        if (img) { e.preventDefault(); lightbox.open(itemsFromImgs([img]), 0, { opener: img }); }
      });
      bodyEl.addEventListener("keydown", function (e) {
        if (e.key !== "Enter" && e.key !== " " && e.key !== "Spacebar") return;
        var t = e.target;
        if (t && t.matches && t.matches("figure.dd-figure img")) {
          e.preventDefault(); lightbox.open(itemsFromImgs([t]), 0, { opener: t });
        }
      });
      built = true;
    }

    function focusables() {
      if (!panel) return [];
      return Array.prototype.slice.call(
        panel.querySelectorAll('button:not([disabled]), a[href], [tabindex="0"]')
      ).filter(function (el) {
        return el === closeBtn || el.offsetWidth > 0 || el.offsetHeight > 0;
      });
    }
    function trap(e) {
      var f = focusables();
      if (!f.length) return;
      var i = f.indexOf(doc.activeElement);
      if (i === -1) { e.preventDefault(); f[0].focus(); }
      else if (e.shiftKey && i === 0) { e.preventDefault(); f[f.length - 1].focus(); }
      else if (!e.shiftKey && i === f.length - 1) { e.preventDefault(); f[0].focus(); }
    }

    function open(trigger) {
      if (!built) build();
      var project = trigger.closest ? trigger.closest(".project") : null;
      var tpl = project ? project.querySelector("template.deepdive") : null;
      if (!tpl) return;

      var titleAttr = tpl.getAttribute("data-title");
      if (!titleAttr && project) {
        var h = project.querySelector(".project__title");
        titleAttr = h ? h.textContent : "";
      }
      titleEl.textContent = titleAttr || "";
      subEl.textContent = tpl.getAttribute("data-subtitle") || "";

      bodyEl.innerHTML = "";
      bodyEl.appendChild(tpl.content.cloneNode(true));
      /* deep-dive galleries: a dd can carry the same .gallery block as the
         project cards. The clone arrives un-built (template content is inert),
         so build it now; an empty gallery (no photos) is removed entirely -
         a text-only deep dive is legitimate. */
      Array.prototype.forEach.call(bodyEl.querySelectorAll(".gallery"), function (g) {
        if (!g.querySelector("img")) { g.parentNode.removeChild(g); }
      });
      buildGalleries();
      /* drawer galleries: keep the keyboard/AT affordance the old dd figure
         had - focusable, labelled, Enter/Space opens the lightbox - and give
         the caption a transient reveal so touch users see it at least once
         (a single-image gallery never fires the image-change reveal). */
      Array.prototype.forEach.call(bodyEl.querySelectorAll(".gallery__holder"), function (h) {
        h.setAttribute("tabindex", "0");
        h.setAttribute("role", "button");
        h.setAttribute("aria-label", "Project photo (enlarge)");
        h.addEventListener("keydown", function (e) {
          if (e.key === "Enter" || e.key === " " || e.key === "Spacebar") {
            e.preventDefault(); h.click();
          }
        });
        var cap = h.querySelector(".gallery__caption");
        if (cap && !cap.classList.contains("is-empty")) {
          cap.classList.add("is-visible");
          window.setTimeout(function () { cap.classList.remove("is-visible"); }, 3800);
        }
      });
      /* make single photos keyboard-focusable + labelled for zoom */
      Array.prototype.forEach.call(bodyEl.querySelectorAll("figure.dd-figure img"), function (im) {
        im.setAttribute("tabindex", "0");
        im.setAttribute("role", "button");
        if (!im.getAttribute("aria-label")) {
          im.setAttribute("aria-label", (im.getAttribute("alt") || "Photo") + " (enlarge)");
        }
      });
      bodyEl.scrollTop = 0;

      lastFocus = doc.activeElement;
      root.classList.add("is-open");
      doc.body.classList.add("dd-open");
      window.setTimeout(function () { if (closeBtn) closeBtn.focus(); }, 60);
    }

    function close() {
      if (!root) return;
      root.classList.remove("is-open");
      doc.body.classList.remove("dd-open");
      if (lastFocus && lastFocus.focus) lastFocus.focus();
    }

    Array.prototype.forEach.call(triggers, function (btn) {
      btn.addEventListener("click", function () { open(btn); });
    });
  })();

  /* ==========================================================
     4. CAROUSEL SETTINGS
     ----------------------------------------------------------
     The values that decide how a carousel looks. Change one here
     rather than in the builder below.
     ========================================================== */

  /* Prev/next arrow PLACEMENT, chosen independently for desktop and mobile
     (the site's 880px breakpoint). Each is one of:
       "off"   - no arrows (swipe / preview / dots still navigate)
       "image" - overlaid on the photo's edges (original hover-reveal style)
       "bar"   - inside the in-frame HUD
       "dots"  - flanking the progress timeline
     Switch a placement by editing its value. Arrows are built only in the
     locations these two settings use, and CSS shows the right one per
     breakpoint. (The lightbox keeps its own arrows; the swipe is unaffected.) */
  var GALLERY_ARROWS_DESKTOP = "bar";
  var GALLERY_ARROWS_MOBILE  = "bar";

  /* Show the "01 / 05" slide count at all? Off by default (a cleaner, more
     minimal frame). Flip to true to bring it back everywhere; when on it keeps
     its existing behavior — hidden at rest, glides in on a change (and on hover
     on desktop), then fades out. This single switch covers desktop and mobile. */
  var GALLERY_SHOW_COUNTER = false;

  doc.body.classList.add("ga-d-" + GALLERY_ARROWS_DESKTOP);
  doc.body.classList.add("ga-m-" + GALLERY_ARROWS_MOBILE);
  var GA_IMAGE = GALLERY_ARROWS_DESKTOP === "image" || GALLERY_ARROWS_MOBILE === "image";
  var GA_BAR   = GALLERY_ARROWS_DESKTOP === "bar"   || GALLERY_ARROWS_MOBILE === "bar";
  var GA_DOTS  = GALLERY_ARROWS_DESKTOP === "dots"  || GALLERY_ARROWS_MOBILE === "dots";

  /* On touch (no hover), the subtitle + count are hidden at rest and only
     glide in for a moment on each image change; on hover devices CSS handles
     the subtitle on hover, so the JS transient reveal there is for the count
     only. Re-evaluated live so a resized desktop window stays correct. */
  var GA_TOUCH_MQ = window.matchMedia ? window.matchMedia("(hover: none)") : null;
  var GA_COUNTER_HOLD = 2600;   /* ms the slide count stays up before it fades */
  var GA_CAPTION_HOLD = 3800;   /* ms the subtitle stays up; longer, it is read */

  /* ==========================================================
     5. CAROUSELS
     ----------------------------------------------------------
     Turn each authored `.gallery`, a plain list of <img>, into a holder
     with a framed backdrop, a padded stage, cross-fade navigation, a
     progress timeline, an optional in-frame HUD, and an optional next-
     image preview (opt in with data-next-preview).

     Arrows, pips and the preview are hidden for a one-image gallery.
     The active image carries a data-lightbox hook for section 2.
     ========================================================== */
  function buildGalleries() {
    var galleries = doc.querySelectorAll(".gallery");
    Array.prototype.forEach.call(galleries, function (gallery) {
      if (gallery.classList.contains("is-ready")) return;
      var imgs = Array.prototype.filter.call(gallery.children, function (el) {
        return el.tagName === "IMG";
      });
      if (!imgs.length) return;

      var wantsPreview = gallery.hasAttribute("data-next-preview");
      var single = imgs.length === 1;
      var anyCaption = imgs.some(function (im) { return !!im.getAttribute("data-caption"); });
      var index = 0;
      var ambient = null;        /* blurred active-image backdrop */
      var hud = null;            /* in-frame control layer */
      var caption = null;        /* lower-left caption label */
      var captionText = null;    /* the caption text span inside it */
      var counterText = null;    /* current slide count */
      var counterTimer = 0;      /* transient reveal after image changes */
      var captionTimer = 0;      /* transient subtitle reveal (touch only) */
      var navCluster = null;     /* floating prev/next rocker */
      var previewImg = null;
      var dotButtons = [];
      var prevButtons = [], nextButtons = [];   /* every arrow copy across the used locations */
      var justSwiped = false;   /* set by a mobile swipe so the trailing click doesn't open the lightbox */

      var holder = doc.createElement("div");
      holder.className = "gallery__holder";
      var frame = doc.createElement("div");
      frame.className = "gallery__frame";
      ambient = doc.createElement("img");
      ambient.className = "gallery__ambient";
      ambient.alt = "";
      ambient.loading = "lazy";
      ambient.setAttribute("aria-hidden", "true");
      var stage = doc.createElement("div");
      stage.className = "gallery__stage";

      imgs.forEach(function (img, i) {
        img.classList.add("gallery__img");
        if (i === 0) img.classList.add("is-active");
        stage.appendChild(img);
      });
      holder.setAttribute("tabindex", "-1");   /* focusable so the lightbox can return focus here */
      holder.addEventListener("click", function () {
        if (justSwiped) { justSwiped = false; return; }
        lightbox.open(itemsFromImgs(imgs), index, { opener: holder });
      });

      function makeNav(dir, location, label) {
        var b = doc.createElement("button");
        b.type = "button";
        b.className = "gallery__nav gallery__nav--" + location + " gallery__nav--" + dir;
        b.setAttribute("aria-label", label);
        var pts = dir === "prev" ? "15 18 9 12 15 6" : "9 18 15 12 9 6";
        b.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
          'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
          '<polyline points="' + pts + '"/></svg>';
        (dir === "prev" ? prevButtons : nextButtons).push(b);
        return b;
      }

      function countLabel(i, n) {
        function pad(v) { return v < 10 ? "0" + v : String(v); }
        return pad(i + 1) + " / " + pad(n);
      }

      function revealCounter() {
        if (!counterText) return;
        counterText.classList.add("is-visible");
        if (counterTimer) window.clearTimeout(counterTimer);
        counterTimer = window.setTimeout(function () {
          counterTimer = 0;
          counterText.classList.remove("is-visible");
        }, GA_COUNTER_HOLD);
      }

      /* Touch only: fade the subtitle in on an image change, then let it
         dissolve back out after a gracious beat. On hover devices the subtitle
         is hover-revealed by CSS, so we leave it alone here. */
      function revealCaption() {
        if (!caption || !captionText) return;
        if (!GA_TOUCH_MQ || !GA_TOUCH_MQ.matches) return;
        if (caption.classList.contains("is-empty")) return;   /* nothing to show */
        caption.classList.add("is-visible");
        if (captionTimer) window.clearTimeout(captionTimer);
        captionTimer = window.setTimeout(function () {
          captionTimer = 0;
          caption.classList.remove("is-visible");
        }, GA_CAPTION_HOLD);
      }

      var preview = null;
      if (!single) {
        /* image-mode arrows overlay the photo's edges (built only if used) */
        if (GA_IMAGE) {
          holder.appendChild(makeNav("prev", "image", "Previous image"));
          holder.appendChild(makeNav("next", "image", "Next image"));
        }

        if (wantsPreview) {
          preview = doc.createElement("button");
          preview.type = "button";
          preview.className = "gallery__preview";
          preview.setAttribute("aria-label", "Show next image");
          previewImg = doc.createElement("img");
          previewImg.alt = "";
          previewImg.loading = "lazy";
          preview.appendChild(previewImg);
          frame.appendChild(preview);
        }
      }

      var dots = doc.createElement("div");
      dots.className = "gallery__dots";
      if (!single) {
        /* dots-mode arrows flank the centered progress rail: [<] - - - [>] */
        if (GA_DOTS) dots.appendChild(makeNav("prev", "dots", "Previous image"));
        imgs.forEach(function (img, i) {
          var dot = doc.createElement("button");
          dot.type = "button";
          dot.className = "gallery__dot";
          dot.setAttribute("aria-label", "Show image " + (i + 1) + " of " + imgs.length);
          var dimg = doc.createElement("img");
          dimg.src = img.getAttribute("data-sd") || img.src;   /* _sd thumb hook for later */
          dimg.alt = "";
          dimg.loading = "lazy";
          dot.appendChild(dimg);
          dot.addEventListener("click", function (e) { e.stopPropagation(); show(i, true); });
          dots.appendChild(dot);
          dotButtons.push(dot);
        });
        if (GA_DOTS) dots.appendChild(makeNav("next", "dots", "Next image"));
      }

      frame.appendChild(ambient);
      gallery.appendChild(holder);
      /* In-frame HUD: caption, counter, and arrows each get their own zone. */
      if (anyCaption || !single) {
        hud = doc.createElement("div");
        hud.className = "gallery__hud";
        hud.addEventListener("click", function (e) { e.stopPropagation(); });
        if (anyCaption) {
          caption = doc.createElement("div");
          caption.className = "gallery__caption";
          captionText = doc.createElement("span");
          captionText.className = "gallery__caption-text";
          caption.appendChild(captionText);
          hud.appendChild(caption);
        }
        if (!single && GALLERY_SHOW_COUNTER) {
          counterText = doc.createElement("span");
          counterText.className = "gallery__counter";
          hud.appendChild(counterText);
        }
        if (!single && GA_BAR) {
          navCluster = doc.createElement("div");
          navCluster.className = "gallery__nav-cluster";
          navCluster.appendChild(makeNav("prev", "bar", "Previous image"));
          navCluster.appendChild(makeNav("next", "bar", "Next image"));
          hud.appendChild(navCluster);
        }
        frame.appendChild(hud);
      }
      frame.appendChild(dots);
      frame.appendChild(stage);
      holder.appendChild(frame);
      gallery.classList.add("is-ready");
      if (single) gallery.classList.add("gallery--single");

      function show(i, revealOnChange) {
        var n = imgs.length;
        var nextIndex = ((i % n) + n) % n;        /* wrap-around */
        var changed = nextIndex !== index;
        index = nextIndex;
        imgs.forEach(function (img, k) { img.classList.toggle("is-active", k === index); });
        dotButtons.forEach(function (d, k) { d.classList.toggle("is-active", k === index); });
        if (captionText) {
          var cap = imgs[index].getAttribute("data-caption") || "";
          captionText.textContent = cap;
          if (caption) caption.classList.toggle("is-empty", !cap);
        }
        if (counterText) { counterText.textContent = countLabel(index, n); }
        if (revealOnChange && changed) { revealCounter(); revealCaption(); }
        if (ambient) {
          var active = imgs[index];
          ambient.src = active.getAttribute("data-sd") || active.currentSrc || active.src;
          ambient.classList.add("is-active");
        }
        if (previewImg) {
          var nx = imgs[(index + 1) % n];
          previewImg.src = nx.getAttribute("data-sd") || nx.src;
        }
        imgs.forEach(function (img, k) {
          if (k === index) { img.setAttribute("data-lightbox", ""); }
          else { img.removeAttribute("data-lightbox"); }
        });
      }

      if (!single) {
        prevButtons.forEach(function (b) { b.addEventListener("click", function (e) { e.stopPropagation(); show(index - 1, true); }); });
        nextButtons.forEach(function (b) { b.addEventListener("click", function (e) { e.stopPropagation(); show(index + 1, true); }); });
        if (preview) {
          preview.addEventListener("click", function (e) { e.stopPropagation(); show(index + 1, true); });
        }
        holder.addEventListener("keydown", function (e) {
          if (e.key === "ArrowLeft") { e.preventDefault(); show(index - 1, true); }
          else if (e.key === "ArrowRight") { e.preventDefault(); show(index + 1, true); }
        });
        bindSwipe();
      }

      /* ---- mobile swipe-to-change (Option B: drag-and-fade) ----
         A clear horizontal drag moves the active photo with the finger while
         the target photo fades in beneath it; a vertical drag still scrolls the
         page; a near-still touch stays a tap that opens the lightbox. Commit on
         a quarter-width drag OR a quick flick; otherwise spring back. Wraps
         around. Touch-only (these listeners never fire without touch). */
      function bindSwipe() {
        var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        var x0 = 0, y0 = 0, t0 = 0, lock = null, target = -1, width = 1, settleTimer = 0;

        function clearStyles() {
          imgs.forEach(function (im) { im.style.transition = ""; im.style.transform = ""; im.style.opacity = ""; });
        }

        holder.addEventListener("touchstart", function (e) {
          if (e.touches.length !== 1) return;
          if (settleTimer) { window.clearTimeout(settleTimer); settleTimer = 0; clearStyles(); }
          justSwiped = false;
          x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; t0 = Date.now();
          lock = null; target = -1;
          width = holder.getBoundingClientRect().width || 1;
        }, { passive: true });

        holder.addEventListener("touchmove", function (e) {
          if (e.touches.length !== 1 || lock === "v") return;
          var dx = e.touches[0].clientX - x0, dy = e.touches[0].clientY - y0;
          if (lock === null) {
            if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;   /* wait for a clear direction */
            lock = Math.abs(dx) > Math.abs(dy) ? "h" : "v";
          }
          if (lock !== "h") return;
          e.preventDefault();   /* take over horizontal; vertical scrolling was never blocked */
          var n = imgs.length;
          target = dx < 0 ? (index + 1) % n : (index - 1 + n) % n;
          var prog = Math.min(1, Math.abs(dx) / (width * 0.6));
          imgs.forEach(function (im, k) {
            im.style.transition = "none";
            if (k === index) { im.style.transform = "translateX(" + dx + "px)"; im.style.opacity = "1"; }
            else if (k === target) { im.style.transform = ""; im.style.opacity = String(prog); }
            else { im.style.transform = ""; im.style.opacity = "0"; }
          });
        }, { passive: false });

        holder.addEventListener("touchend", function (e) {
          if (lock !== "h") { lock = null; return; }
          lock = null;
          var dx = e.changedTouches[0] ? e.changedTouches[0].clientX - x0 : 0;
          var dt = Date.now() - t0, dist = Math.abs(dx);
          var flick = dt < 300 && dist > 40 && dist / dt > 0.3;
          var commit = target >= 0 && (dist > width * 0.25 || flick);
          var act = imgs[index], tgt = target >= 0 ? imgs[target] : null;
          var dur = reduce ? 0 : 260;
          justSwiped = true;   /* swallow the click that browsers fire after a drag */

          if (commit && tgt) {
            var dir = dx < 0 ? -1 : 1;
            act.style.transition = "transform " + dur + "ms ease, opacity " + dur + "ms ease";
            act.style.transform = "translateX(" + (dir * width) + "px)";
            act.style.opacity = "0";
            tgt.style.transition = "opacity " + dur + "ms ease";
            tgt.style.opacity = "1";
            settleTimer = window.setTimeout(function () { settleTimer = 0; show(target, true); clearStyles(); }, dur + 20);
          } else {
            act.style.transition = "transform " + dur + "ms ease, opacity " + dur + "ms ease";
            act.style.transform = "translateX(0)";
            act.style.opacity = "1";
            if (tgt) { tgt.style.transition = "opacity " + dur + "ms ease"; tgt.style.opacity = "0"; }
            settleTimer = window.setTimeout(function () { settleTimer = 0; clearStyles(); }, dur + 20);
          }
        }, { passive: true });
      }

      show(0, false);
    });
  }
  /* ==========================================================
     6. ENTRY POINT AND EXPORTS
     ========================================================== */
  buildGalleries();

  /* the editor rebuilds a gallery after an image edit by restoring the
     plain <img> list and re-running the builder. buildGalleries skips
     anything already built, so a repeat call is safe. */
  AMH.work = { buildGalleries: buildGalleries, lightbox: lightbox };
})();
