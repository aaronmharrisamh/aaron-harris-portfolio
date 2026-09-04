/* ============================================================
   site.js - shared page behavior, and the one namespace the site's
   own scripts use to talk to each other.

   Loaded first on every page. It creates window.AMH, the single
   global the trunks share:

     AMH.site      requestTick                          (this file)
     AMH.work      buildGalleries, lightbox             (work.js)
     AMH.blog      the reading engine's internal API    (blog.js)
     AMH.gallery   the tile packer, and its regions     (gallery.js)
     AMH.tool      the editor kit: the image-region
                   core, the splice, the page list,
                   and what a consumer needs to draw
                   its own region                       (tool.js)
     AMH.publish   what edit.blog() calls               (publish.js)

   Each member is documented where it is published. AMH.tool is the
   largest by far, because it is what the other trunks build on; see
   section 7 of tool.js.

   window.edit is the one other global. It is the documented console
   entry point for the editor, so it keeps its name.

   Load order is site.js, work.js, blog.js, tool.js, gallery.js,
   publish.js, declared in the head of every page and asserted by the
   contract test. Each page loads only the trunks it needs; the two
   that follow tool.js register themselves with the editor kit, which
   is why they follow it.

   Sections:
     1. SETUP                       4. PAGE SWEEPS
     2. HEADER STATE AND PROGRESS   5. EXPORTS
     3. NAV AND IN-PAGE LINKS

   There is no cleanup section. The page never tears this down, so an
   empty one would be a heading with nothing under it.
   ============================================================ */
(function () {
  "use strict";
  /* ==========================================================
     1. SETUP
     ----------------------------------------------------------
     The namespace other trunks read, and the one class the CSS
     entrance animations wait for.
     ========================================================== */
  var AMH = window.AMH = window.AMH || {};
  var doc = document;

  /* Old links to the blog takeover.

     "?b=..." was the blog's URL from V035 until the blog got its own page, so
     it can sit in a browser history or in something already shared. Send it on
     with the same query. replace, not assign, so Back skips the hop rather
     than bouncing between the two pages.

     Runs before anything else here, and only on a page that has no blog feed
     of its own, so blog.html never redirects to itself. */
  (function () {
    /* The blog page is the one with the stream container. Test for it before
       redirecting: a page that IS the blog and fails this test sends itself
       to itself, forever. Rename that container and this has to change with
       it, which is why the id is named here and nowhere else. */
    if (doc.getElementById("blogStream")) return;
    var m = /[?&]b=([^&]*)/.exec(location.search);
    if (!m) return;
    location.replace("blog.html?b=" + m[1]);
  })();

  /* .loaded gates the hero entrance animation in the CSS */
  window.addEventListener("load", function () {
    requestAnimationFrame(function () { doc.body.classList.add("loaded"); });
  });
  /* fallback in case 'load' already fired */
  if (doc.readyState === "complete") doc.body.classList.add("loaded");

  /* ==========================================================
     2. HEADER STATE AND PROGRESS
     ========================================================== */
  /* ---- header scrolled state + scroll progress bar ----
     The header switches to its `scrolled` look (black bar + portrait + compact
     name) once enough of the hero portrait has scrolled up under the header.
     We measure that coverage VERTICALLY only (see portraitShownRatio): the
     desktop portrait is scaled to its true aspect ratio and intentionally
     bleeds off the right edge, so an IntersectionObserver's 2D area ratio would
     read below 100% even at the very top and wrongly flip the header dark
     before any scrolling. The progress bar already runs every scroll, so doing
     this in the same rAF-throttled handler costs nothing extra. */
  /* A month page loads this file for requestTick and the reveal, and has
     none of the site chrome: no header, no progress bar, no nav. Every
     reference to the chrome below is guarded, so the file is inert there
     and still exports AMH.site. */
  var header = doc.getElementById("header");
  var progress = doc.getElementById("progress");
  var heroPortrait = doc.querySelector(".hero__portrait");
  var ticking = false;

  /* The header is shorter once it takes its scrolled look, and the blog
     page's bar sticks under it at --header-h. Republish the height when
     the state flips, and again when the padding transition ends, or a
     seam of page content shows between the two bars. */
  var scrolledNow = null;
  function setScrolled(on) {
    if (!header) return;
    header.classList.toggle("scrolled", on);
    if (on !== scrolledNow) { scrolledNow = on; setHeaderH(); }
  }

  /* Desktop reveals the header much earlier than mobile: the desktop hero
     portrait is large and off to the side, so we don't wait for much of it
     to leave. Mobile triggers when ~25% has scrolled away. */
  function revealThreshold() { return window.innerWidth > 880 ? 0.9 : 0.75; }

  /* Fraction of the portrait still visible below the header, VERTICAL only —
     immune to the portrait bleeding off the right edge. null if no portrait. */
  function portraitShownRatio() {
    if (!heroPortrait) return null;
    var r = heroPortrait.getBoundingClientRect();
    if (r.height <= 0) return null;
    var top = (header ? header.offsetHeight : 0) || 56;
    var shown = Math.min(r.bottom, window.innerHeight) - Math.max(r.top, top);
    return shown / r.height;
  }

  function onScroll() {
    var y = window.scrollY || doc.documentElement.scrollTop;
    /* blog takeover hides the hero: keep the solid header, always */
    var ratio = portraitShownRatio();
    setScrolled(ratio === null ? y > 24 : ratio < revealThreshold());
    var h = doc.documentElement.scrollHeight - window.innerHeight;
    var p = h > 0 ? y / h : 0;
    if (progress) progress.style.transform = "scaleX(" + p + ")";
    ticking = false;
  }
  function requestTick() {
    if (!ticking) { window.requestAnimationFrame(onScroll); ticking = true; }
  }
  window.addEventListener("scroll", requestTick, { passive: true });
  /* Re-evaluate on resize. Both the threshold and the portrait's geometry
     depend on viewport width, so a resize can change the header's look
     with no scrolling at all. */
  window.addEventListener("resize", requestTick, { passive: true });
  onScroll();

  /* ==========================================================
     3. NAV AND IN-PAGE LINKS
     ========================================================== */
  /* The file name of the page being viewed. A directory URL ("/", "/blog/")
     serves the index of that directory. Every managed page is at the site
     root, so a file name is enough here; tool.js has the fuller version. */
  var HERE = location.pathname.split("/").pop() || "index.html";

  /* The fragment a nav link points at WITHIN this page, or "" when the link
     leads somewhere else.

     The chrome is one set of bytes on every page, so a link into the Work
     section reads "index.html#work" everywhere. On the home page that is an
     in-page anchor and here it is treated as one; on any other page the
     browser follows it. A bare "#contact" is in-page on every page that has
     a contact section, and stays written that way. */
  function ownFragment(href) {
    if (!href) return "";
    if (href.charAt(0) === "#") return href;
    var cut = href.indexOf("#");
    if ((cut === -1 ? href : href.slice(0, cut)) !== HERE) return "";
    return cut === -1 ? "#" : href.slice(cut);
  }

  /* ---- mobile nav toggle ---- */
  var toggle = doc.getElementById("navToggle");
  var nav = doc.getElementById("nav");
  var overlay = doc.getElementById("navOverlay");

  /* The drawer docks under the header, whose height varies with the
     breakpoint and with the scrolled state. Publish it as a custom
     property so the CSS does not have to guess. */
  function setHeaderH() {
    if (!header) return;
    doc.documentElement.style.setProperty("--header-h", header.offsetHeight + "px");
  }
  setHeaderH();
  window.addEventListener("resize", setHeaderH);
  window.addEventListener("load", setHeaderH);
  if (header) header.addEventListener("transitionend", function (e) {
    if (e.target === header && /^padding/.test(e.propertyName)) setHeaderH();
  });

  /* the drawer and its links exist only on a page with the site chrome */
  var hasNav = !!(toggle && nav && overlay);
  function setNav(open) {
    if (!hasNav) return;
    if (open) setHeaderH();
    nav.classList.toggle("open", open);
    toggle.classList.toggle("open", open);
    overlay.classList.toggle("open", open);
    doc.body.classList.toggle("nav-open", open);
    toggle.setAttribute("aria-expanded", open ? "true" : "false");
  }
  function closeNav() { setNav(false); }
  if (hasNav) toggle.addEventListener("click", function () {
    setNav(!nav.classList.contains("open"));
  });
  if (hasNav) overlay.addEventListener("click", closeNav);

  if (hasNav) nav.addEventListener("click", function (e) {
    var a = e.target.closest("a");
    if (!a) return;
    var href = a.getAttribute("href");

    /* ---- INSTANT JUMP for in-page drawer links (no smooth scroll) ----
       To restore smooth scrolling from the drawer, delete this `if` block;
       the `else` branch below already closes the drawer and lets the browser
       scroll smoothly via the CSS `scroll-behavior: smooth` default. */
    var frag = ownFragment(href);
    if (frag) {
      e.preventDefault();
      var target = frag.length > 1 ? doc.querySelector(frag) : doc.body;
      closeNav();                 // releases the body scroll-lock immediately
      if (target) {
        var html = doc.documentElement;
        var prev = html.style.scrollBehavior;
        html.style.scrollBehavior = "auto";   // force instant for this jump
        target.scrollIntoView();
        html.style.scrollBehavior = prev;      // restore page default
        /* the bare fragment, not the page-qualified href: the URL bar should
           read "#work", the way it did before the chrome was shared */
        history.replaceState(null, "", frag);
      }
      return;
    }

    /* external, tel, sms and resume links: close the drawer and let the
       browser follow the link */
    closeNav();
  });

  doc.addEventListener("keydown", function (e) { if (e.key === "Escape") closeNav(); });

  /* Mark the nav item that names this page. It cannot be authored, because
     the chrome is the same bytes everywhere; a link with a fragment names a
     section rather than a page, so only a bare file name counts. */
  Array.prototype.forEach.call(hasNav ? nav.querySelectorAll("a") : [], function (a) {
    if (a.getAttribute("href") === HERE) a.setAttribute("aria-current", "page");
  });

  /* ==========================================================
     4. PAGE SWEEPS
     ----------------------------------------------------------
     Three one-time passes over the whole page: reveal on scroll,
     the active nav link, and the cull of empty optional blocks.
     ========================================================== */
  /* ---- scroll reveal ---- */
  var reveals = doc.querySelectorAll(".reveal");
  if ("IntersectionObserver" in window) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) { en.target.classList.add("in"); io.unobserve(en.target); }
      });
    }, { threshold: 0.12, rootMargin: "0px 0px -8% 0px" });
    reveals.forEach(function (el) { io.observe(el); });
  } else {
    reveals.forEach(function (el) { el.classList.add("in"); });
  }

  /* ---- active nav link via section observation ---- */
  /* Only links into a section of THIS page participate. "#" alone is the top
     of the page and names no section, so it is left out too. */
  function navFragment(a) {
    var frag = ownFragment(a.getAttribute("href"));
    return frag.length > 1 ? frag : "";
  }
  var navLinks = Array.prototype.slice.call(hasNav ? nav.querySelectorAll("a") : [])
    .filter(navFragment);
  var sections = navLinks
    .map(function (a) { return doc.querySelector(navFragment(a)); })
    .filter(Boolean);
  if ("IntersectionObserver" in window && sections.length) {
    var spy = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) {
          navLinks.forEach(function (a) {
            a.classList.toggle("active", navFragment(a) === "#" + en.target.id);
          });
        }
      });
    }, { threshold: 0.5, rootMargin: "-20% 0px -55% 0px" });
    sections.forEach(function (s) { spy.observe(s); });
  }

  /* ---- auto-cull empty optional project sections ----
     Every project block keeps its optional bits (stats, highlights) as tags
     even when unused, so the markup stays copy-paste uniform. CSS :empty hides
     the cleanly-empty ones with no flash; this sweep is the backstop that also
     removes any left with only whitespace (which would defeat :empty), so an
     editor never ends up with a stray empty box on the page. */
  var optionalBits = doc.querySelectorAll(".project .stats, .project .highlights");
  Array.prototype.forEach.call(optionalBits, function (el) {
    var hasContent = el.children.length > 0 || el.textContent.replace(/\s+/g, "") !== "";
    if (hasContent || !el.parentNode) return;
    /* copy-editor regions keep their element (removing it would orphan the
       [edit:] comment pair) - empty it instead so the :empty CSS hides it. */
    var prev = el.previousSibling;
    while (prev && prev.nodeType === 3 && prev.nodeValue.trim() === "") prev = prev.previousSibling;
    if (prev && prev.nodeType === 8 && /^\[edit:[\w-]+\]$/.test(prev.nodeValue.trim())) {
      el.textContent = "";
    } else {
      el.parentNode.removeChild(el);
    }
  });
  /* ==========================================================
     5. EXPORTS
     ========================================================== */
  /* AMH.site.requestTick()
     Re-run the scroll handler on the next animation frame.
     blog.js calls it when the takeover view opens or closes, because that
     hides or re-shows the hero and so changes the header's look. */
  AMH.site = { requestTick: requestTick };
})();
