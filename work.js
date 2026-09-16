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

     The src attribute, not currentSrc. An image with a srcset may be
     painting its small copy in a small slot, and the viewer shows the whole
     picture. While the editor shows a photo no save has written, the
     attribute holds that photo's blob: URL, so the viewer shows it as well.

     original and originalBytes name the file as it came, from the markup
     the image engine writes. An image without an original has neither.
     crisp is true for a small image the engine marked with data-crisp:
     the viewer keeps its pixels square. */
  /* A file's size the way a reader says it: "212 KB", "3.1 MB", "48 MB".
     Published, so the editor's boxes say a size the same way. */
  function sizeText(bytes) {
    var kb = bytes / 1024;
    if (kb < 1024) return Math.max(1, Math.round(kb)) + " KB";
    var mb = kb / 1024;
    return (mb < 10 ? mb.toFixed(1) : String(Math.round(mb))) + " MB";
  }

  function itemsFromImgs(imgEls) {
    return Array.prototype.map.call(imgEls, function (im) {
      return {
        src: im.src,
        caption: im.getAttribute("data-caption") || "",
        alt: im.getAttribute("alt") || "",
        original: im.getAttribute("data-original") || "",
        originalBytes: parseInt(im.getAttribute("data-original-bytes"), 10) || 0,
        crisp: im.getAttribute("data-crisp") === "1"
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

     SEE ORIGINAL. An item with an original gets a link at the lower
     right, opposite the caption: "See original · PNG · 3.1 MB". It
     opens the file as it came, in a new tab, so the viewer stays where
     it was. It comes and goes with the caption, and an item with no
     original has none.

     Interface:

       lightbox.open(items, startIndex, opts)
       lightbox.close()
       lightbox.isOpen()

     items is a list of { src, caption, alt, original, originalBytes,
     crisp }, the last three optional. That is deliberately the subset the
     image-region core in tool.js already produces, so a consumer passes
     its model straight through with no adapter. Use itemsFromImgs() above
     to build the list from markup. A crisp item is drawn with square
     pixels, so a small icon enlarged by a pinch stays sharp.

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
    var root, stage, imgEl, imgInEl, captionEl, originalEl, closeBtn, prevBtn, nextBtn;
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
      originalEl = doc.createElement("a");
      originalEl.className = "lightbox__original";
      originalEl.target = "_blank";
      originalEl.rel = "noopener";
      originalEl.hidden = true;

      root.appendChild(stage);
      root.appendChild(closeBtn);
      root.appendChild(prevBtn);
      root.appendChild(nextBtn);
      root.appendChild(captionEl);
      root.appendChild(originalEl);
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
      /* the link opens its tab, and the backdrop under it does not close */
      originalEl.addEventListener("click", function (e) { e.stopPropagation(); });
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
      return [closeBtn, prevBtn, nextBtn, originalEl].filter(function (b) {
        return b.style.display !== "none" && !b.hidden;
      });
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
          return { src: it.src, caption: it.caption || "", alt: it.alt || "",
                   original: it.original || "", originalBytes: it.originalBytes || 0,
                   crisp: !!it.crisp };
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
      var shown = [captionEl, originalEl].filter(function (el) {
        return el && !el.hidden && !el.classList.contains("is-empty");
      });
      if (!shown.length) return;
      shown.forEach(function (el) { el.classList.add("is-visible"); });
      if (captionIdle) window.clearTimeout(captionIdle);
      captionIdle = window.setTimeout(function () {
        captionIdle = 0;
        shown.forEach(function (el) { el.classList.remove("is-visible"); });
      }, LB_CAPTION_HOLD);
    }

    function render() {
      resetZoom();
      var im = images[current];
      imgEl.src = im.src;
      imgEl.alt = im.alt;
      imgEl.classList.toggle("lightbox__img--crisp", im.crisp);
      if (im.caption) { captionEl.textContent = im.caption; captionEl.classList.remove("is-empty"); }
      else { captionEl.textContent = ""; captionEl.classList.add("is-empty"); }
      if (im.original) {
        /* the format from the path; a blob: preview has none, and says none */
        var type = (/\.([a-z0-9]+)(?:[?#]|$)/i.exec(im.original) || [])[1] || "";
        originalEl.href = im.original;
        originalEl.textContent = "See original" + (type ? " · " + type.toUpperCase() : "") +
          (im.originalBytes ? " · " + sizeText(im.originalBytes) : "");
        originalEl.hidden = false;
      } else {
        originalEl.hidden = true;
        originalEl.removeAttribute("href");
      }
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
      if (originalEl) originalEl.classList.remove("is-visible");
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
          if (tgt !== swipe.target) {
            swipe.target = tgt;
            imgInEl.src = images[tgt].src;
            imgInEl.classList.toggle("lightbox__img--crisp", images[tgt].crisp);
          }
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
     <template class="deepdive">. The head is two elements inside the
     template, .dd-lead and .dd-lead__sub, and the drawer lifts them out
     of the body. data-title and data-subtitle are the older shape.

     A single photo (figure.dd-figure img) opens in the lightbox above,
     on click or on Enter or Space. Esc, the scrim and the close button
     all dismiss it, and focus returns to the trigger.

     The shell is built on first open, not at load: most visitors never
     open a drawer.
     ========================================================== */
  /* Which template the open drawer was cloned from, or null.

     The editor has to find the clone of the gallery it holds, and the clone
     carries nothing that names its source. This is the answer, from the one
     place that knows it. */
  var openTpl = null;

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
        /* A box the editor opened over the drawer owns the keyboard. Its
           Escape closes the box and not the drawer under it, and its Tab
           stays in the box instead of being pulled back into the drawer. */
        if (AMH.tool && AMH.tool.modalOpen && AMH.tool.modalOpen()) return;
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
      openTpl = tpl;

      bodyEl.innerHTML = "";
      bodyEl.appendChild(tpl.content.cloneNode(true));

      /* THE HEAD COMES FROM INSIDE THE TEMPLATE.

         The editor writes what is between two markers, and an attribute on
         the template is outside them, so a title kept there could never be
         edited. It is two elements in the content instead, lifted into the
         drawer's head and taken out of the body.

         data-title and data-subtitle are still read, for a template written
         before that and not yet converted. */
      var lead = bodyEl.querySelector(".dd-lead");
      var leadSub = bodyEl.querySelector(".dd-lead__sub");
      var titleText = lead ? lead.textContent : tpl.getAttribute("data-title");
      if (!titleText && project) {
        var h = project.querySelector(".project__title");
        titleText = h ? h.textContent : "";
      }
      titleEl.textContent = titleText || "";
      subEl.textContent = leadSub ? leadSub.textContent
        : (tpl.getAttribute("data-subtitle") || "");
      if (lead && lead.parentNode) lead.parentNode.removeChild(lead);
      if (leadSub && leadSub.parentNode) leadSub.parentNode.removeChild(leadSub);

      /* The Markdown the body was written from travels with it, so the form
         can open what was typed rather than what it rendered to. It is a
         script of a type no browser runs, and it is taken out here so
         nothing downstream has to know it was ever there. */
      var mdSrc = bodyEl.querySelector("script.dd-source");
      if (mdSrc && mdSrc.parentNode) mdSrc.parentNode.removeChild(mdSrc);
      /* deep-dive galleries: a dd can carry the same .gallery block as the
         project cards. The clone arrives un-built (template content is inert),
         so build it now; an empty gallery (no photos) is removed entirely -
         a text-only deep dive is legitimate. */
      Array.prototype.forEach.call(bodyEl.querySelectorAll(".gallery"), function (g) {
        if (!g.querySelector("img")) { g.parentNode.removeChild(g); }
      });
      buildGalleries();
      /* drawer galleries: keep the keyboard/AT affordance the old dd figure
         had - focusable, labelled, Enter/Space opens the lightbox. A caption
         needs nothing here: it is always on screen, in its strip. */
      Array.prototype.forEach.call(bodyEl.querySelectorAll(".gallery__holder"), function (h) {
        h.setAttribute("tabindex", "0");
        h.setAttribute("role", "button");
        h.setAttribute("aria-label", "Project photo (enlarge)");
        h.addEventListener("keydown", function (e) {
          if (e.key === "Enter" || e.key === " " || e.key === "Spacebar") {
            e.preventDefault(); h.click();
          }
        });
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
      openTpl = null;
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

  /* The frame's shape, as width / height. A landscape frame is never squarer
     than FRAME_LANDSCAPE.least or wider than FRAME_LANDSCAPE.most, and a
     portrait frame never squarer than FRAME_PORTRAIT.least or taller than
     FRAME_PORTRAIT.most. */
  var FRAME_LANDSCAPE = { least: 16 / 9, most: 20 / 9 };
  var FRAME_PORTRAIT  = { least: 9 / 16, most: 9 / 20 };

  /* The most of the screen's height a frame's photo area takes. A taller
     frame gets narrower instead, and stays centered. */
  var FRAME_MOST_OF_SCREEN = 0.85;

  doc.body.classList.add("ga-d-" + GALLERY_ARROWS_DESKTOP);
  doc.body.classList.add("ga-m-" + GALLERY_ARROWS_MOBILE);
  doc.body.style.setProperty("--gallery-screen", String(FRAME_MOST_OF_SCREEN));
  var GA_IMAGE = GALLERY_ARROWS_DESKTOP === "image" || GALLERY_ARROWS_MOBILE === "image";
  var GA_BAR   = GALLERY_ARROWS_DESKTOP === "bar"   || GALLERY_ARROWS_MOBILE === "bar";
  var GA_DOTS  = GALLERY_ARROWS_DESKTOP === "dots"  || GALLERY_ARROWS_MOBILE === "dots";

  /* The slide count, when it is on, glides in for a moment on each image
     change and then fades. A caption never does: it stays in its strip. */
  var GA_COUNTER_HOLD = 2600;   /* ms the slide count stays up before it fades */

  /* ==========================================================
     5. CAROUSELS
     ----------------------------------------------------------
     Turn each authored `.gallery`, a plain list of <img>, into a holder
     with a framed backdrop, a view that holds the padded stage, cross-
     fade navigation, a progress timeline, an optional HUD in the view,
     and an optional next-image preview (opt in with data-next-preview).

     A carousel with any caption also gets a caption strip under the view.
     The strip shows the caption at all times and holds the arrows, so a
     caption never covers a photo and never waits for a hover.

     The view takes the frame's shape: landscape or portrait, from the
     wrapper's data-shape or from its photos, at a ratio kept between the
     limits in section 4. See frameShape.

     Arrows, pips and the preview are hidden for a one-image gallery.
     The active image carries a data-lightbox hook for section 2.
     ========================================================== */
  /* The shape of a carousel's frame.

     The orientation is the author's word when it is landscape or portrait.
     Without one the photos decide: a photo taller than it is wide is
     portrait, and every other photo is landscape, a square one included.
     The frame is portrait when more than half of the photos with a known
     size are, so a tie and a carousel of photos with no size are landscape.

     The ratio is the middle photo's of that orientation, counted from the
     least stretched, the first of the two middles for an even count, and
     kept between the orientation's limits. The middle and not the widest,
     so one panorama among camera photos does not make the rest smaller.
     With no photo of that orientation, which only a word can cause, the
     frame takes the orientation's least stretched shape.

       sizes   [{ w, h }], the photos' declared sizes, 0 where one has none
       word    the wrapper's data-shape; any other value is no word

     Returns { orientation, ratio }. It reads no page, so a test can call it. */
  function frameShape(sizes, word) {
    var known = (sizes || []).filter(function (s) { return s && s.w > 0 && s.h > 0; });
    var tall = known.filter(function (s) { return s.h > s.w; });
    var orientation = word === "landscape" || word === "portrait" ? word
      : (tall.length * 2 > known.length ? "portrait" : "landscape");
    var portrait = orientation === "portrait";
    var limits = portrait ? FRAME_PORTRAIT : FRAME_LANDSCAPE;
    var ratios = known
      .filter(function (s) { return (s.h > s.w) === portrait; })
      .map(function (s) { return s.w / s.h; })
      .sort(function (a, b) { return portrait ? b - a : a - b; });
    var ratio = ratios.length ? ratios[Math.floor((ratios.length - 1) / 2)] : limits.least;
    var lo = Math.min(limits.least, limits.most);
    var hi = Math.max(limits.least, limits.most);
    return { orientation: orientation, ratio: Math.min(hi, Math.max(lo, ratio)) };
  }

  /* THE VIEWER'S SET. A carousel opens the viewer on its own photos, unless
     the page says the carousels inside one element are one set: the blog
     does, so a post's photos page through from its first carousel to its
     last. fn(gallery) returns that element, or null for the carousel's own.
     The set is read at the click, so a carousel built later is in it. */
  var viewerScopeOf = null;
  function viewerScope(fn) {
    viewerScopeOf = typeof fn === "function" ? fn : null;
  }
  function viewerSet(gallery, imgs, index) {
    var scope = viewerScopeOf ? viewerScopeOf(gallery) : null;
    if (!scope) return { imgs: imgs, at: index };
    var all = Array.prototype.slice.call(scope.querySelectorAll(".gallery.is-ready .gallery__img"));
    var at = all.indexOf(imgs[index]);
    return at === -1 ? { imgs: imgs, at: index } : { imgs: all, at: at };
  }

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
      /* the frame's shape, from the author's word or from the photos' sizes */
      var word = gallery.getAttribute("data-shape") || "";
      if (word && word !== "landscape" && word !== "portrait") {
        console.warn('[carousel] data-shape="' + word + '" is not landscape or portrait, ' +
          "so this frame follows its photos.", gallery);
      }
      var shape = frameShape(imgs.map(function (im) {
        return { w: parseInt(im.getAttribute("width"), 10) || 0,
                 h: parseInt(im.getAttribute("height"), 10) || 0 };
      }), word);
      var index = 0;
      var ambient = null;        /* blurred active-image backdrop */
      var hud = null;            /* the view's control layer */
      var strip = null;          /* the caption strip under the view */
      var caption = null;        /* the caption label, in the strip */
      var captionText = null;    /* the caption on screen, inside the label */
      var counterText = null;    /* current slide count */
      var counterTimer = 0;      /* transient reveal after image changes */
      var navCluster = null;     /* floating prev/next rocker */
      var previewImg = null;
      var dotButtons = [];
      var prevButtons = [], nextButtons = [];   /* every arrow copy across the used locations */
      var justSwiped = false;   /* set by a mobile swipe so the trailing click doesn't open the lightbox */

      var holder = doc.createElement("div");
      holder.className = "gallery__holder";
      holder.style.setProperty("--gallery-ratio", String(shape.ratio));
      var frame = doc.createElement("div");
      frame.className = "gallery__frame";
      /* The view is the photo area, and it keeps the frame's shape. The
         frame layer fills the holder behind the view and the strip, so both
         stand on one backdrop. */
      var view = doc.createElement("div");
      view.className = "gallery__view";
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
        var set = viewerSet(gallery, imgs, index);
        lightbox.open(itemsFromImgs(set.imgs), set.at, { opener: holder });
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

      var preview = null;
      if (!single) {
        /* image-mode arrows overlay the photo's edges (built only if used) */
        if (GA_IMAGE) {
          view.appendChild(makeNav("prev", "image", "Previous image"));
          view.appendChild(makeNav("next", "image", "Next image"));
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
          dimg.src = img.getAttribute("data-sd") || img.src;   /* the small copy, when there is one */
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
      frame.appendChild(dots);
      view.appendChild(stage);
      holder.appendChild(frame);
      holder.appendChild(view);
      gallery.appendChild(holder);

      /* The arrow rocker, when this carousel has one. It goes into the
         strip below, or over the photo when there is no strip. */
      if (!single && GA_BAR) {
        navCluster = doc.createElement("div");
        navCluster.className = "gallery__nav-cluster";
        navCluster.appendChild(makeNav("prev", "bar", "Previous image"));
        navCluster.appendChild(makeNav("next", "bar", "Next image"));
      }

      /* THE CAPTION STRIP. One cell holds the caption on screen and a hidden
         copy of every caption in the carousel. The cell is as tall as the
         longest caption at the width it has, so the strip keeps one height
         as the photos change, and nothing has to measure it. The strip takes
         no pointer, so a tap on it opens the viewer as a tap on the photo
         does, and a click on the rocker stops here. */
      if (anyCaption) {
        strip = doc.createElement("div");
        strip.className = "gallery__strip";
        strip.addEventListener("click", function (e) { e.stopPropagation(); });
        caption = doc.createElement("div");
        caption.className = "gallery__caption";
        var cell = doc.createElement("span");
        cell.className = "gallery__caption-cell";
        captionText = doc.createElement("span");
        captionText.className = "gallery__caption-text";
        cell.appendChild(captionText);
        imgs.forEach(function (im) {
          var words = im.getAttribute("data-caption") || "";
          if (!words) return;
          var sizer = doc.createElement("span");
          sizer.className = "gallery__caption-sizer";
          sizer.setAttribute("aria-hidden", "true");
          sizer.textContent = words;
          cell.appendChild(sizer);
        });
        caption.appendChild(cell);
        strip.appendChild(caption);
        if (navCluster) strip.appendChild(navCluster);
        holder.appendChild(strip);
      }

      /* The view's HUD: the slide count, and the rocker when no strip holds it. */
      var rockerInView = !!navCluster && !strip;
      if (rockerInView || (!single && GALLERY_SHOW_COUNTER)) {
        hud = doc.createElement("div");
        hud.className = "gallery__hud";
        hud.addEventListener("click", function (e) { e.stopPropagation(); });
        if (!single && GALLERY_SHOW_COUNTER) {
          counterText = doc.createElement("span");
          counterText.className = "gallery__counter";
          hud.appendChild(counterText);
        }
        if (rockerInView) hud.appendChild(navCluster);
        view.appendChild(hud);
      }
      gallery.classList.remove("gallery--landscape", "gallery--portrait");
      gallery.classList.add("is-ready", "gallery--" + shape.orientation);
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
        if (revealOnChange && changed) revealCounter();
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
  AMH.work = {
    buildGalleries: buildGalleries,
    /* the frame's shape for a list of photo sizes and a word; see section 5 */
    frameShape: frameShape,
    /* name the element whose carousels are one set for the viewer; see section 5 */
    viewerScope: viewerScope,
    lightbox: lightbox,
    sizeText: sizeText,
    /* The template the open deep-dive drawer was cloned from, or null. */
    openTemplate: function () { return openTpl; }
  };
})();
