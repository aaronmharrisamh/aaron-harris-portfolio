/* ============================================================
   blog.js - the blog reading engine.

   Reads the manifest in #blogManifest and filters the index the
   publisher wrote into the page. Publishes AMH.blog for the composer
   in publish.js.

   It fetches nothing. The page carries one card for each post, and
   each card links into the month file that holds it. A link works
   from a page opened from disk; a fetch does not, which is why the
   stream this replaced could only ever read a month over http.

   Loaded only by blog.html. It reads #blogIndex and does nothing
   on a page that has no such container, so being loaded elsewhere is
   harmless rather than wrong.

   The manifest is the source of truth. The full text of a post lives
   in exactly one place, its month file (blog/YYMM.html), which is a
   standalone page for a reader arriving from a search engine. This
   page carries a summary and a link. This file only reads; writing is
   the composer's job, in publish.js.

   Sections:
     1. SETUP                    4. THE INDEX
     2. MANIFEST AND DATES       5. SHOWING A TARGET
     3. BODY RENDERING           6. ENTRY POINT AND EXPORTS
   ============================================================ */
(function () {
  "use strict";
  /* ==========================================================
     1. SETUP
     ========================================================== */
  var AMH = window.AMH = window.AMH || {};
  var doc = document;

  /* ==========================================================
     2. MANIFEST AND DATES
     ----------------------------------------------------------
     Parse the manifest tag, and turn its packed dates into the
     labels and datetime values the stream shows.
     ========================================================== */
  var MONTHS_EN = ["January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"];

  function blogParseManifest() {
    var el = doc.getElementById("blogManifest");
    var out = { nextPost: 1, nextImg: 1, entries: [], months: [] };
    if (!el) return out;
    var lines = el.textContent.split("\n").map(function (l) { return l.trim(); })
      .filter(function (l) { return l !== ""; });
    lines.forEach(function (l) {
      if (l.indexOf("next-post:") === 0) out.nextPost = parseInt(l.slice(10), 10) || 1;
      else if (l.indexOf("next-img:") === 0) out.nextImg = parseInt(l.slice(9), 10) || 1;
      else {
        l.split("|").forEach(function (e) {
          var m = /^(\d{6})(\d{4})(.*)$/.exec(e);
          if (m) out.entries.push({ date: m[1], id: m[2], title: m[3], month: m[1].slice(0, 4) });
        });
      }
    });
    /* unique months, newest first (manifest is oldest-to-newest) */
    out.entries.slice().reverse().forEach(function (e) {
      if (out.months.indexOf(e.month) === -1) out.months.push(e.month);
    });
    return out;
  }

  function blogMonthTitle(yymm) {
    return MONTHS_EN[parseInt(yymm.slice(2, 4), 10) - 1] + " 20" + yymm.slice(0, 2);
  }
  function blogDateLabel(yymmdd) {
    return MONTHS_EN[parseInt(yymmdd.slice(2, 4), 10) - 1] + " " +
      parseInt(yymmdd.slice(4, 6), 10) + ", 20" + yymmdd.slice(0, 2);
  }
  function blogDateTime(yymmdd) {
    return "20" + yymmdd.slice(0, 2) + "-" + yymmdd.slice(2, 4) + "-" + yymmdd.slice(4, 6);
  }
  function blogDecodeSource(s) {
    return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  }
  function blogEncodeSource(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  /* [img####,caption|alt] / [png####,caption|alt] - runs of adjacent tags
     (whitespace only between) become ONE unit. Returns HTML for a post body.
     mode "stream": tag runs -> .gallery markup (upgraded to carousels).
     mode "static": tag runs -> stacked <figure class="bp-fig"> blocks. */
  /* ==========================================================
     3. BODY RENDERING
     ----------------------------------------------------------
     A post body is plain HTML plus image tags of the form
     [img0001,caption|alt]. Expand those into figures.
     ========================================================== */
  var BLOG_TAG_RE = /\[(img|png)(\d{4})(?:,([^\]|]*))?(?:\|([^\]]*))?\]/g;
  function blogRenderBody(source, postDate, mode) {
    var esc = function (s) {
      return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
    };
    var RUN_RE = /(?:\[(?:img|png)\d{4}(?:,[^\]|]*)?(?:\|[^\]]*)?\]\s*)+/g;
    return source.replace(RUN_RE, function (run) {
      var imgs = [];
      run.replace(BLOG_TAG_RE, function (_, fmt, num, cap, alt) {
        imgs.push({
          src: "blog/" + postDate + "_img" + num + (fmt === "png" ? ".png" : ".jpg"),
          caption: (cap || "").trim(),
          alt: (alt || "").trim() || (cap || "").trim() || ("Blog image " + num)
        });
        return _;
      });
      if (!imgs.length) return run;
      if (mode === "stream") {
        return '<div class="gallery">' + imgs.map(function (im) {
          return '<img src="' + esc(im.src) + '" loading="lazy" alt="' + esc(im.alt) + '"' +
            (im.caption ? ' data-caption="' + esc(im.caption) + '"' : "") + " />";
        }).join("") + "</div>";
      }
      return imgs.map(function (im) {
        return '<figure class="bp-fig"><img src="../' + esc(im.src) + '" loading="lazy" alt="' +
          esc(im.alt) + '" /><figcaption>' +
          esc(im.caption).replace(/&quot;/g, '"') + "</figcaption></figure>";
      }).join("\n");
    });
  }

  /* ==========================================================
     4. THE INDEX
     ----------------------------------------------------------
     The cards are already on the page: the publisher writes them,
     and they are plain markup with a link into the month file that
     holds each post.

     So this section reads the page rather than building it. It draws
     the month filter from the manifest, hides the cards that do not
     match, and moves to a post when a deep link asks for one.

     Nothing here fetches. That is what lets this page work when it
     is opened from disk, where a fetch is refused but a link is not.
     ========================================================== */
  var blogIndex = null;
  var blogManifest = null;
  var blogMonthsNav = null;     /* the filter row, from the manifest */
  var canonicalEl = doc.querySelector('link[rel="canonical"]');
  var CANONICAL_PAGE = canonicalEl ? canonicalEl.getAttribute("href") : "";

  /* Find the containers this page provides. Returns false on a page that has
     none, which is how every other page opts out of the whole engine. */
  function blogAttach() {
    if (blogIndex) return true;
    blogIndex = doc.getElementById("blogIndex");
    blogMonthsNav = doc.getElementById("blogMonths");
    return !!blogIndex;
  }

  function blogCards() {
    return blogIndex
      ? Array.prototype.slice.call(blogIndex.querySelectorAll(".bs-card"))
      : [];
  }

  /* While one month is filtered to, that month file is the canonical copy of
     those posts: it is the standalone page a search engine should send people
     to. With no filter this page is its own canonical. */
  function blogSetCanonical(yymm) {
    if (!canonicalEl) return;
    canonicalEl.setAttribute("href", yymm
      ? CANONICAL_PAGE.replace(/\/[^\/]*$/, "") + "/blog/" + yymm + ".html"
      : CANONICAL_PAGE);
  }

  /* Give one card its Edit button, if the editor is on and it has none. The
     editor exposes AMH.tool.editPost only while it is active. */
  function blogEditButton(card) {
    if (!(AMH.tool && AMH.tool.editPost)) return;
    if (card.querySelector(".bs-retry")) return;
    var id = (card.id || "").replace(/^p/, "");
    if (!id) return;
    var eb = doc.createElement("button");
    eb.type = "button";
    eb.className = "bs-retry";
    eb.textContent = "Edit p" + id;
    eb.style.marginLeft = ".6rem";
    eb.addEventListener("click", function () { AMH.tool.editPost(id); });
    card.appendChild(eb);
  }

  /* Decorate every card on screen. The editor calls this when it turns on,
     because the page was drawn long before that happened. */
  function blogEditButtons() {
    var cards = blogCards();
    cards.forEach(blogEditButton);
    return cards.length;
  }

  /* ==========================================================
     5. SHOWING A TARGET
     ----------------------------------------------------------
     A filter and a scroll. There is nothing to load.
     ========================================================== */

  /* target: "" for every post, "YYMM" for one month, "pNNNN" for one post.

     An unknown target shows everything with a note, because sending a reader
     nowhere is worse than sending them somewhere with an explanation. */
  function blogShow(target, push) {
    if (!blogAttach()) return;
    blogManifest = blogManifest || blogParseManifest();
    var cards = blogCards();
    var yymm = "", anchor = "", unknown = false;

    if (/^p\d{4}$/.test(target)) {
      var entry = null;
      blogManifest.entries.forEach(function (e) {
        if (e.id === target.slice(1)) entry = e;
      });
      if (entry) { yymm = entry.month; anchor = target; }
      else unknown = true;
    } else if (/^\d{4}$/.test(target)) {
      if (blogManifest.months.indexOf(target) !== -1) yymm = target;
      else unknown = true;
    }

    /* the filter row, straight from the manifest */
    if (blogMonthsNav) {
      blogMonthsNav.innerHTML = "";
      blogManifest.months.forEach(function (mo) {
        var b = doc.createElement("button");
        b.type = "button";
        b.className = "bs-retry" + (mo === yymm ? " on" : "");
        b.textContent = blogMonthTitle(mo);
        b.addEventListener("click", function () {
          blogShow(mo === yymm ? "" : mo, true);
        });
        blogMonthsNav.appendChild(b);
      });
    }

    /* hidden, not removed: the cards are the page's own markup and the
       publisher owns them, so this file never takes one away */
    cards.forEach(function (c) {
      c.hidden = !!(yymm && c.getAttribute("data-month") !== yymm);
      c.classList.toggle("is-target", !!anchor && c.id === anchor);
    });

    var note = blogIndex.querySelector(".bs-note--unknown");
    if (note) note.remove();
    if (unknown) {
      var n = doc.createElement("p");
      n.className = "bs-note bs-note--unknown";
      n.textContent = "That post or month wasn't found - showing everything instead.";
      blogIndex.insertBefore(n, blogIndex.firstChild);
    }

    blogSetCanonical(yymm);
    if (push) {
      var q = target ? "?b=" + target : location.pathname;
      history.pushState(null, "", target ? q : location.pathname);
    }
    if (anchor) {
      var el = doc.getElementById(anchor);
      if (el) el.scrollIntoView({ block: "center" });
    }
    blogEditButtons();
    if (AMH.tool && AMH.tool.viewChanged) AMH.tool.viewChanged();
    AMH.site.requestTick();
  }

  /* ==========================================================
     6. ENTRY POINT AND EXPORTS
     ========================================================== */
  /* Filter on load. "?b=" selects a month or a post; without it every post
     is shown. On a page with no index container this returns immediately.

     Note what does NOT happen here: nothing is rendered and nothing is
     fetched. The cards are already in the page, written by the publisher,
     so a reader with no script gets the whole index and this only adds the
     filter on top of it. */
  (function () {
    if (!blogAttach()) return;
    var m = /[?&]b=([^&]*)/.exec(location.search);
    blogShow(m ? decodeURIComponent(m[1]) : "", false);
  })();

  /* Back and forward move between months on this page. Without "?b=" the URL
     is the page itself, which means the newest month. */
  window.addEventListener("popstate", function () {
    if (!blogIndex) return;
    var m = /[?&]b=([^&]*)/.exec(location.search);
    blogShow(m ? decodeURIComponent(m[1]) : "", false);
  });

  /* AMH.blog
     The reading engine's internal surface, for the composer in tool.js.
     It is not a public API: the composer and this file ship together, so
     a member may change as long as both change with it.

       parseManifest()            -> { entries, nextPost, nextImg }
       renderBody(src, date, mode) -> HTML for one post body
       encodeSource(s) / decodeSource(s) -> the escaped form stored in a
                                   month file's x-blog-source tag
       monthTitle(yymm) / dateLabel(yymmdd) / dateTime(yymmdd) -> display
       show(target, push)         -> filter the index to a target
       editButtons()              -> add the Edit button to the cards

     There is no close. The blog is a page now, so leaving it is a
     navigation like any other. */
  AMH.blog = {
    parseManifest: blogParseManifest,
    renderBody: blogRenderBody,
    encodeSource: blogEncodeSource,
    decodeSource: blogDecodeSource,
    monthTitle: blogMonthTitle,
    dateLabel: blogDateLabel,
    dateTime: blogDateTime,
    show: blogShow,
    editButtons: blogEditButtons
  };
})();
