/* ============================================================
   site.js - shared page behavior, the site root, and the pin that
   ties this site to the engine release it expects.

   The first trunk on every page. release.js loads before it and
   creates window.AMH, the single global the engine shares, and the
   host's site.config.js loads between the two:

     AMH.release   the engine's id, version and folder  (release.js)
     AMH.config    this site's facts                     (site.config.js)
     AMH.site      the root, the pin, the address        (this file)
     AMH.work      buildGalleries, lightbox, players     (work.js)
     AMH.images    the image engine                      (imagesengine.js)
     AMH.blog      the reading engine's internal API     (blog.js)
     AMH.markdown  the Markdown renderer                 (markdown.js)
     AMH.gallery   the tile packer, and its regions      (gallery.js)
     AMH.tool      the editor kit: the image-region
                   core, the splice, the page list,
                   and what a consumer needs to draw
                   its own region                        (tool.js)
     AMH.publish   what edit.blog() calls                (publish.js)

   Each member is documented where it is published. AMH.tool is the
   largest by far, because it is what the other trunks build on; see
   section 7 of tool.js.

   window.edit is the one other global. It is the documented console
   entry point for the editor, so it keeps its name.

   Load order is release.js, site.config.js, then this file and the
   trunks the page needs, declared in each page and asserted by the
   contract test. The engine's README.md lists the set for each kind
   of page. The two trunks that follow tool.js register themselves
   with the editor kit, which is why they follow it.

   Sections:
     1. SETUP                            4. NAV AND IN-PAGE LINKS
     2. HEADER STATE AND PROGRESS        5. PAGE SWEEPS
     3. THE ROOT, THE ADDRESS AND THE    6. EXPORTS
        VISIT

   There is no cleanup section. The page never tears this down, so an
   empty one would be a heading with nothing under it.
   ============================================================ */
(function () {
  "use strict";
  /* ==========================================================
     1. SETUP
     ----------------------------------------------------------
     The namespace other trunks read, the pin, and the one class the
     CSS entrance animations wait for.
     ========================================================== */
  var AMH = window.AMH = window.AMH || {};
  var doc = document;

  /* THE PIN. The engine this folder holds and the engine this site
     expects must be the same release, or the editor would write with
     code the site was not made for. The answer is "" or one sentence
     that says what to do. Only the editor reads it: reading the page is
     never stopped. */
  function pinProblem() {
    var rel = AMH.release, cfg = AMH.config;
    if (!rel || !rel.root) {
      return "release.js did not load before site.js, so this page names no engine release.";
    }
    if (!cfg) {
      return "site.config.js did not load. A page loads it after release.js and before site.js.";
    }
    if (cfg.engineVersion !== rel.version) {
      return "This site pins engine " + (cfg.engineVersion || "(none)") + " and the folder holds " +
        rel.version + ". Set engineVersion in site.config.js after you replace the library.";
    }
    if (pathOf(location.href) === null) {
      return "This page is not inside the site root, " + root() +
        ", so the editor cannot tell which page it is.";
    }
    return "";
  }
  var problem = pinProblem();

  /* THE SITE'S STORAGE NAMES. Every name the engine keeps in the browser
     starts with the site's id, so two sites on one origin never read each
     other's work. The word after the id is permanent: a new word loses
     what a person has already stored under the old one. */
  function key(word) {
    return ((AMH.config && AMH.config.siteId) || "site") + "-" + word;
  }

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

  /* The header is shorter once it takes its scrolled look, and the mobile
     drawer docks under it at --header-h. Republish the height when the
     state flips, and again when the padding transition ends, or the drawer
     opens against the height the header no longer has. --header-top does
     not follow this: see setHeaderH. */
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
     3. THE ROOT, THE ADDRESS AND THE VISIT
     ----------------------------------------------------------
     Three jobs that every page shares, and that no page can own
     alone.

     THE ROOT. Every path the engine reads or writes is a path from
     the site root, and the root is found from where the library is:
     it sits two folders below the root, in
     libraries/harrisxrwebengine/. A host that puts it somewhere else
     names the root in site.config.js as siteRoot. A body class or a
     count of folders in the page's address is never the answer,
     because a page can be at any depth.

     THE ADDRESS. Five places on this site rewrite the address as the
     reader works: a deep link, a month hop, a tag filter, the editor
     leaving, and an in-page nav link. Each one used to pass null as the
     state, which threw away whatever the page remembered, and two of
     them rebuilt the address from the path alone, which dropped every
     other parameter. setUrl and paramUrl are the two repairs.

     THE VISIT. A post link is a real link, so the browser owns Back and
     restores the reader's place. The only thing the browser cannot tell
     the arriving page is whether THIS site sent the reader, which is
     what decides whether a Back control is offered at all.

     The referrer cannot answer that. It names the page that linked here,
     not the entry before this one, and the redirect above writes no entry
     at all. So the departure is recorded instead of guessed: one key,
     written by the click that leaves, read once on arrival.

     This lives here because the home page carries post links and does not
     load blog.js. It stays two strings. It is not a record of the
     reader's browsing state, and it must not grow into one.
     ========================================================== */
  function libraryRoot() {
    return (AMH.release && AMH.release.root) || "";
  }
  function root() {
    var own = AMH.config && AMH.config.siteRoot;
    if (own) return String(own).replace(/\/?$/, "/");
    var lib = libraryRoot();
    if (!lib) return "";
    try { return new URL("../../", lib).href; } catch (e) { return ""; }
  }
  /* The path from the site root that an address leads to. A relative
     address is read from this page, and a folder's address is its
     index.html. null when the address leads outside the root. */
  function pathOf(href) {
    var r = root(), u;
    if (!r) return null;
    try { u = new URL(href, location.href).href; } catch (e) { return null; }
    u = u.split("#")[0].split("?")[0];
    if (u.indexOf(r) !== 0) return null;
    var p = u.slice(r.length);
    try { p = decodeURI(p); } catch (e) { /* a path that will not decode is used as it is */ }
    if (!p || p.slice(-1) === "/") p += "index.html";
    return p;
  }
  /* This page's path from the site root. Outside the root, its file name,
     which is the most a page list could name it by. */
  function pagePath() {
    var p = pathOf(location.href);
    return p !== null ? p : (location.pathname.replace(/^.*\//, "") || "index.html");
  }
  /* The way from this page up to the site root: "" at the root, and "../"
     for each folder below it. It goes in front of a path from the root to
     make a path from this page. */
  function prefix() {
    var p = pathOf(location.href);
    if (p === null) return "";
    return prefixOf(p);
  }
  /* The same way up, from any page. page is a path from the site root. */
  function prefixOf(page) {
    return new Array(String(page || "").split("/").length).join("../");
  }
  /* True for an address that is not a path from a page: one with a scheme,
     such as https: or blob:, or one that starts at the server's root. It
     means the same on every page, so it is written as it is. */
  function isAddress(ref) {
    return ref.charAt(0) === "/" || /^[a-z][a-z0-9+.-]*:/i.test(ref);
  }
  /* A path written on page, as a path from the site root. page is a path
     from the root. This is text arithmetic and reads no address, so it can
     read a page that is not on screen. A path that climbs out of the root
     keeps one "../" for each folder it climbs. An address, and a path that
     is only a query or a fragment, come back as they are. */
  function fromPage(page, ref) {
    var s = String(ref || "");
    var cut = s.search(/[?#]/);
    if (!s || cut === 0 || isAddress(s)) return s;
    var tail = cut === -1 ? "" : s.slice(cut);
    var out = String(page || "").split("/").slice(0, -1), up = [];
    (cut === -1 ? s : s.slice(0, cut)).split("/").forEach(function (seg) {
      if (seg === "..") { if (out.length) out.pop(); else up.push(".."); }
      else if (seg !== ".") out.push(seg);
    });
    return up.concat(out).join("/") + tail;
  }
  /* A path from the site root, as this page writes it. An address goes as
     it is. */
  function onPage(path) {
    var s = String(path || "");
    return !s || isAddress(s) ? s : prefix() + s;
  }

  /* Write the address and keep what the page remembers. */
  function setUrl(url, push) {
    try {
      var st = history.state;
      if (push) history.pushState(st, "", url);
      else history.replaceState(st, "", url);
    } catch (e) { /* a disk page can refuse; the reading is unharmed */ }
  }
  /* This address with some parameters changed. A null value removes one,
     and a parameter this does not name is left alone. */
  function paramUrl(changes) {
    var u = new URL(location.href);
    Object.keys(changes).forEach(function (k) {
      if (changes[k] === null || changes[k] === "") u.searchParams.delete(k);
      else u.searchParams.set(k, changes[k]);
    });
    return u.pathname + u.search + u.hash;
  }
  /* Merge one field into the state of the entry showing now. */
  function markState(patch) {
    try {
      var st = history.state;
      if (!st || typeof st !== "object") st = {};
      Object.keys(patch).forEach(function (k) { st[k] = patch[k]; });
      history.replaceState(st, "", location.href);
    } catch (e) {}
  }

  var HOP_KEY = key("hop");
  var HOP_MAX = 60000;   /* a token older than this belongs to another trip */

  /* Record a departure this site is making, for the page it is going to.
     Only a plain left click in this tab counts. A middle click, a
     modified click, a download, and a link that opens a new tab all leave
     this tab where it is, so none of them is a departure. */
  function hopWatch() {
    /* Bubble phase, not capture. A handler nearer the link may answer the
       click itself, and only after it has run is defaultPrevented true.
       In capture this would record a departure that never happens. */
    doc.addEventListener("click", function (e) {
      if (e.defaultPrevented || e.button !== 0) return;
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      var a = e.target && e.target.closest ? e.target.closest("a[href]") : null;
      if (!a || a.hasAttribute("download")) return;
      if (a.target && a.target !== "_self") return;
      var url;
      try { url = new URL(a.getAttribute("href"), location.href); } catch (err) { return; }
      if (url.origin !== location.origin) return;
      /* Any destination that replaces this document. A link to a fragment
         of this same page moves the reader without leaving it, so it is
         not a departure and must not spend a token.

         This once took only a post or a tag, because those were the two
         views that offered Back. The foot of a month page offers it now
         as well, and a month is reached by a plain address, so the test
         is the document and not the shape of the address. */
      if (url.pathname === location.pathname && url.search === location.search) return;
      try {
        sessionStorage.setItem(HOP_KEY, JSON.stringify(
          { to: url.href, at: Date.now() }));
      } catch (err) { /* storage refused: the reader gets the plain way out */ }
    });
  }
  /* Did this site send the reader to the page they are on?

     True only for a departure this tab recorded, for this address, just
     now. The token is read once and removed, so a second page cannot
     claim it and a duplicated tab finds nothing. The answer is then kept
     in the state of this entry, so a refresh does not lose it. */
  function cameFromHere() {
    var raw = null;
    try {
      raw = sessionStorage.getItem(HOP_KEY);
      if (raw) sessionStorage.removeItem(HOP_KEY);
    } catch (e) { raw = null; }
    var rec = null;
    if (raw) { try { rec = JSON.parse(raw); } catch (e) { rec = null; } }
    if (rec && rec.to === location.href && Date.now() - rec.at < HOP_MAX) {
      markState({ amhBack: 1 });
      return true;
    }
    return !!(history.state && history.state.amhBack);
  }
  hopWatch();

  /* ==========================================================
     4. NAV AND IN-PAGE LINKS
     ========================================================== */
  /* The fragment a nav link points at WITHIN this page, or "" when the link
     leads somewhere else.

     The chrome is one set of bytes on every page, so a link into the Work
     section reads "index.html#work" everywhere. On the home page that is an
     in-page anchor and here it is treated as one; on any other page the
     browser follows it. A bare "#contact" is in-page on every page that has
     a contact section, and stays written that way. */

  /* Where a shared nav link goes when THIS page has no section for it.
     Every page carries the contact block today, so this is the safety
     net; it is also the one place to change when contact becomes a page
     of its own. The path is written from the site root. */
  var AWAY = { "#contact": "index.html#contact" };

  function ownFragment(href) {
    if (!href) return "";
    if (href.charAt(0) === "#") return href;
    var cut = href.indexOf("#");
    if (pathOf(cut === -1 ? href : href.slice(0, cut)) !== pagePath()) return "";
    return cut === -1 ? "#" : href.slice(cut);
  }

  /* ---- mobile nav toggle ---- */
  var toggle = doc.getElementById("navToggle");
  var nav = doc.getElementById("nav");
  var overlay = doc.getElementById("navOverlay");

  /* The drawer docks under the header, whose height varies with the
     breakpoint and with the scrolled state. Publish it as a custom
     property so the CSS does not have to guess.

     --header-top is the same height BEFORE the header takes its scrolled
     look, and it is the one a page uses to clear a fixed header. It must
     not follow the scrolled state: the header loses .6rem when it shrinks,
     and a clearance that followed it would pull the whole page up by that
     much in the middle of a scroll. It is read while the header is at its
     full size, which is every time the reader is at the top. */
  function setHeaderH() {
    if (!header) return;
    var h = header.offsetHeight;
    doc.documentElement.style.setProperty("--header-h", h + "px");
    if (!header.classList.contains("scrolled")) {
      doc.documentElement.style.setProperty("--header-top", h + "px");
    }
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
           read "#work", the way it did before the chrome was shared. A
           fragment-only reference keeps the path and the query, so a
           focused post keeps its "?post=" when the reader uses the nav. */
        setUrl(frag, false);
        return;
      }
      /* This page has no section by that name. Silently doing nothing is
         the worst answer, so the link follows the site's own copy of it. */
      if (AWAY[frag]) location.href = prefix() + AWAY[frag];
      return;
    }

    /* external, tel, sms and resume links: close the drawer and let the
       browser follow the link */
    closeNav();
  });

  doc.addEventListener("keydown", function (e) { if (e.key === "Escape") closeNav(); });

  /* Mark the nav item that names this page. It cannot be authored, because
     the chrome is the same bytes everywhere; a link with a fragment names a
     section rather than a page, so only a link with no fragment counts. */
  var herePath = pagePath();
  Array.prototype.forEach.call(hasNav ? nav.querySelectorAll("a") : [], function (a) {
    var href = a.getAttribute("href");
    if (!href || href.indexOf("#") !== -1) return;
    var to = pathOf(href);
    if (to === herePath) a.setAttribute("aria-current", "page");
    /* A month file is a page of the blog, in blog/. The reader is still in
       the blog, so the Blog item says so. */
    else if (to === "blog.html" && herePath.indexOf("blog/") === 0) a.setAttribute("aria-current", "page");
  });

  /* ==========================================================
     5. PAGE SWEEPS
     ----------------------------------------------------------
     Three one-time passes over the whole page: reveal on scroll,
     the active nav link, and the cull of empty optional blocks.
     ========================================================== */
  /* ---- scroll reveal ---- */
  var revealIO = "IntersectionObserver" in window
    ? new IntersectionObserver(function (entries) {
        entries.forEach(function (en) {
          if (en.isIntersecting) { en.target.classList.add("in"); revealIO.unobserve(en.target); }
        });
      }, { threshold: 0.12, rootMargin: "0px 0px -8% 0px" })
    : null;

  /* Watch the reveals inside one element, or the whole page.

     A block added to the page after load has never been watched, so it
     would stay at the opacity a reveal starts at: invisible. The editor
     hands over what it adds, and a browser with no observer shows
     everything at once, which is what it already did. */
  function watchReveals(root) {
    var box = root || doc;
    var all = box.querySelectorAll(".reveal");
    if (box !== doc && box.classList && box.classList.contains("reveal")) {
      all = [box].concat(Array.prototype.slice.call(all));
    }
    Array.prototype.forEach.call(all, function (el) {
      if (revealIO) revealIO.observe(el);
      else el.classList.add("in");
    });
  }
  watchReveals(null);

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
     6. EXPORTS
     ========================================================== */
  /* AMH.site.requestTick()
     Re-run the scroll handler on the next animation frame.
     blog.js calls it when the takeover view opens or closes, because that
     hides or re-shows the hero and so changes the header's look.

     AMH.site.setUrl(url, push)
     Write the address and keep history.state. Every writer on this site
     uses it, because passing null throws away what the page remembers.

     AMH.site.paramUrl(changes)
     This address with named parameters changed, and the rest left alone.
     A null or "" value removes one.

     AMH.site.cameFromHere()
     True when this site sent the reader to the page they are on, in this
     tab, just now. Reads the departure token once and remembers the
     answer on this history entry, so a refresh keeps it. It is what
     decides whether a page can offer Back.

     AMH.site.problem
     "" when this page may be edited. Otherwise one sentence: release.js
     or site.config.js did not load, the two name different releases, or
     the page is outside the site root. The editor shows the sentence and
     opens nothing. Reading is never stopped.

     AMH.site.root(), AMH.site.libraryRoot()
     The absolute address of the site root and of the engine's folder,
     each with a trailing slash.

     AMH.site.prefix(), AMH.site.prefixOf(page)
     The way from this page, or from page, up to the site root: "" at the
     root, "../" one folder down. The prefix in front of a path from the
     root makes a path from that page.

     AMH.site.fromPage(page, ref), AMH.site.onPage(path)
     The two ends of a path the engine keeps. fromPage turns ref, a path
     written on page, into a path from the site root, and onPage turns a
     path from the root into the path this page writes. An address with a
     scheme, such as a blob: URL, passes through both as it is.

     AMH.site.pagePath()
     This page's path from the site root: "index.html" for the root's own
     address, and "blog/2609.html" on a month page.

     AMH.site.pathOf(href)
     The path from the site root that href leads to, read from this page,
     or null when it leads outside the root.

     AMH.site.key(word)
     The name this site keeps word under in the browser: the site's id, a
     dash, and word: amh-pending-edits is the portfolio's pending edits,
     and every trunk names its storage this way. */
  AMH.site = {
    requestTick: requestTick,
    setUrl: setUrl,
    paramUrl: paramUrl,
    cameFromHere: cameFromHere,
    watchReveals: watchReveals,
    problem: problem,
    root: root,
    libraryRoot: libraryRoot,
    prefix: prefix,
    prefixOf: prefixOf,
    fromPage: fromPage,
    onPage: onPage,
    pagePath: pagePath,
    pathOf: pathOf,
    key: key
  };
})();
