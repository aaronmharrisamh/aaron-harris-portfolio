/* ============================================================
   blog.js - the blog reading engine.

   Reads the manifest in #blogManifest, fetches month files lazily and
   renders the stream into the page. Loads after work.js, because a
   rendered post can carry a gallery. Publishes AMH.blog for the
   composer in tool.js.

   Loaded only by blog.html. It renders into #blogFeed and does nothing
   on a page that has no such container, so being loaded elsewhere is
   harmless rather than wrong.

   The manifest is the source of truth. Post content lives in real
   per-month files (blog/YYMM.html) that also work as standalone pages
   for a reader arriving from a search engine. This file only reads.
   Writing is the composer's job, in tool.js.

   Sections:
     1. SETUP                    5. MONTH LOADING AND CACHE
     2. MANIFEST AND DATES       6. SHOWING A TARGET
     3. BODY RENDERING           7. ENTRY POINT AND EXPORTS
     4. THE STREAM
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
     4. THE STREAM
     ----------------------------------------------------------
     The containers the page provides, the jump nav, and the
     rendering of one month into the feed.
     ========================================================== */
  var blogFeed = null, blogSentinel = null, blogIO = null;
  var blogManifest = null;
  var blogLoaded = {};          /* yymm -> "loading" | "done" | "failed" */
  var blogQueue = [];           /* months not yet rendered, newest first */
  var blogCache = {};           /* yymm -> fetched month html (session cache) */
  var blogMonthsNav = null;     /* jump-nav row (from the manifest, no fetches) */
  var canonicalEl = doc.querySelector('link[rel="canonical"]');
  var CANONICAL_PAGE = canonicalEl ? canonicalEl.getAttribute("href") : "";

  /* Find the containers this page provides. Returns false on a page that has
     none, which is how every other page opts out of the whole engine. */
  function blogAttach() {
    if (blogFeed) return true;
    blogFeed = doc.getElementById("blogFeed");
    blogMonthsNav = doc.getElementById("blogMonths");
    return !!blogFeed;
  }

  /* While a month is in view, the month file is the canonical copy of those
     posts: it is the standalone page a search engine should send people to.
     With no month in view this page is its own canonical. */
  function blogSetCanonical(yymm) {
    if (!canonicalEl) return;
    canonicalEl.setAttribute("href", yymm
      ? CANONICAL_PAGE.replace(/\/[^\/]*$/, "") + "/blog/" + yymm + ".html"
      : CANONICAL_PAGE);
  }

  /* Give one rendered post its Edit button, if the editor is on and it has
     none. The editor exposes AMH.tool.editPost only while it is active. */
  function blogEditButton(art) {
    if (!(AMH.tool && AMH.tool.editPost)) return;
    var head = art.querySelector("header");
    if (!head || head.querySelector(".bs-retry")) return;
    var id = art.getAttribute("data-id") || "";
    var eb = doc.createElement("button");
    eb.type = "button";
    eb.className = "bs-retry";
    eb.textContent = "Edit p" + id;
    eb.style.marginTop = ".5rem";
    eb.addEventListener("click", function () { AMH.tool.editPost(id); });
    head.appendChild(eb);
  }

  /* Decorate every post already on screen. The editor calls this when it turns
     on, because the stream was rendered before that happened. */
  function blogEditButtons() {
    if (!blogFeed) return 0;
    var arts = blogFeed.querySelectorAll("article.blog-post");
    Array.prototype.forEach.call(arts, blogEditButton);
    return arts.length;
  }

  function blogRenderMonth(yymm, monthDoc) {
    var label = doc.createElement("h2");
    label.className = "bs-month";
    label.textContent = blogMonthTitle(yymm);
    blogFeed.appendChild(label);
    var arts = monthDoc.querySelectorAll("article.blog-post");
    Array.prototype.forEach.call(arts, function (a) {
      var srcEl = a.querySelector('script[type="text/x-blog-source"]');
      var art = doc.createElement("article");
      art.className = "blog-post";
      art.id = a.id;
      var date = a.getAttribute("data-date") || yymm + "01";
      art.innerHTML = "<header><h2>" +
        (a.getAttribute("data-title") || "").replace(/&/g, "&amp;").replace(/</g, "&lt;") +
        '</h2><time datetime="' + blogDateTime(date) + '">' + blogDateLabel(date) +
        "</time></header>" + '<div class="blog-post__body"></div>';
      blogEditButton(art);
      var body = art.querySelector(".blog-post__body");
      if (srcEl) {
        body.innerHTML = blogRenderBody(blogDecodeSource(srcEl.textContent).trim(), date, "stream");
      } else {
        /* no embedded source (foreign/hand-made file): reuse the static render,
           fixing its month-page-relative ../ paths for the root context */
        var st = a.querySelector(".blog-post__body");
        body.innerHTML = st ? st.innerHTML : "";
        Array.prototype.forEach.call(body.querySelectorAll("img"), function (im) {
          var s = im.getAttribute("src") || "";
          if (s.indexOf("../") === 0) im.setAttribute("src", s.slice(3));
        });
      }
      blogFeed.appendChild(art);
    });
    AMH.work.buildGalleries();   /* upgrade any tag runs to carousels */
  }

  /* ==========================================================
     5. MONTH LOADING AND CACHE
     ========================================================== */
  function blogLoadNextMonth() {
    if (!blogQueue.length) {
      if (blogSentinel) { blogSentinel.remove(); blogSentinel = null; }
      if (!blogFeed.querySelector(".bs-end")) {   /* open + bump can both land here */
        var end = doc.createElement("div");
        end.className = "bs-end";
        end.textContent = "· that's the whole blog ·";
        blogFeed.appendChild(end);
      }
      return Promise.resolve();
    }
    var yymm = blogQueue[0];
    if (blogLoaded[yymm] === "loading" || blogLoaded[yymm] === "done") return Promise.resolve();
    blogLoaded[yymm] = "loading";
    /* session cache: reopening the stream never refetches a month */
    var got = blogCache[yymm]
      ? Promise.resolve(blogCache[yymm])
      : fetch("blog/" + yymm + ".html").then(function (res) {
          if (!res.ok) throw new Error("HTTP " + res.status);
          return res.text();
        });
    return got
      .then(function (html) {
        blogCache[yymm] = html;
        blogLoaded[yymm] = "done";
        blogQueue.shift();
        blogRenderMonth(yymm, new DOMParser().parseFromString(html, "text/html"));
        blogBumpSentinel();
      })
      .catch(function (err) {
        blogLoaded[yymm] = "failed";
        var note = doc.createElement("div");
        note.className = "bs-note";
        note.appendChild(doc.createTextNode(
          "Couldn't load " + blogMonthTitle(yymm) + " (" + err.message + ")."));
        var retry = doc.createElement("button");
        retry.type = "button";
        retry.className = "bs-retry";
        retry.textContent = "Retry";
        retry.addEventListener("click", function () {
          note.remove();
          delete blogLoaded[yymm];
          blogLoadNextMonth();
        });
        note.appendChild(retry);
        blogFeed.appendChild(note);
      });
  }

  function blogBumpSentinel() {
    if (blogSentinel) blogSentinel.remove();
    blogSentinel = null;
    if (!blogQueue.length) { blogLoadNextMonth(); return; }
    blogSentinel = doc.createElement("div");
    blogSentinel.style.height = "1px";
    blogFeed.appendChild(blogSentinel);
    if (!blogIO && "IntersectionObserver" in window) {
      blogIO = new IntersectionObserver(function (entries) {
        entries.forEach(function (en) {
          if (en.isIntersecting) blogLoadNextMonth();
        });
      }, { rootMargin: "600px 0px" });
    }
    if (blogIO) blogIO.observe(blogSentinel);
    else blogLoadNextMonth();   /* no IntersectionObserver: load every month */
  }

  /* target: "" | "YYMM" | "pNNNN" */
  /* ==========================================================
     6. SHOWING A TARGET
     ========================================================== */

  /* Render the stream, landing on a month or a post.

     target: "" for the newest month first, "YYMM" for a month, "pNNNN" for a
     post. An unknown target shows the latest with a note, because sending a
     reader nowhere is worse than sending them somewhere with an explanation. */
  function blogShow(target, push) {
    if (!blogAttach()) return;
    blogManifest = blogManifest || blogParseManifest();
    var yymm = "", anchor = "";
    if (/^p\d{4}$/.test(target)) {
      var id = target.slice(1);
      var entry = null;
      blogManifest.entries.forEach(function (e) { if (e.id === id) entry = e; });
      if (entry) { yymm = entry.month; anchor = target; }
    } else if (/^\d{4}$/.test(target) && blogManifest.months.indexOf(target) !== -1) {
      yymm = target;
    }
    /* jump nav: month buttons straight from the manifest (no fetches) */
    if (blogMonthsNav) {
      blogMonthsNav.innerHTML = "";
      blogManifest.months.forEach(function (mo) {
        var b = doc.createElement("button");
        b.type = "button";
        b.className = "bs-retry" + (mo === yymm ? " on" : "");
        b.textContent = blogMonthTitle(mo);
        b.addEventListener("click", function () { blogShow(mo, true); });
        blogMonthsNav.appendChild(b);
      });
    }
    /* stream model: land at the target month, keep scrolling into OLDER
       months. No target = newest first. */
    blogQueue = blogManifest.months.slice();
    if (yymm) blogQueue = blogQueue.slice(blogQueue.indexOf(yymm));
    blogFeed.innerHTML = "";
    Object.keys(blogLoaded).forEach(function (k) { delete blogLoaded[k]; });
    if (target && !yymm && !anchor && blogManifest.entries.length) {
      var miss = doc.createElement("div");
      miss.className = "bs-note";
      miss.textContent = "That post or month wasn't found - showing the latest instead.";
      blogFeed.appendChild(miss);
    }
    if (!blogManifest.entries.length) {
      var note = doc.createElement("div");
      note.className = "bs-note";
      note.textContent = "No posts yet - check back soon.";
      blogFeed.appendChild(note);
      window.scrollTo(0, 0);
    } else {
      blogLoadNextMonth().then(function () {
        function toAnchor() {
          var el = doc.getElementById(anchor);
          if (el) el.scrollIntoView({ block: "start" });
        }
        if (anchor) {
          toAnchor();
          /* lazy images above the anchor shift layout as they land -
             re-anchor a couple of beats later */
          window.setTimeout(toAnchor, 700);
          window.setTimeout(toAnchor, 1800);
        } else {
          window.scrollTo(0, 0);
        }
        blogBumpSentinel();
      });
    }
    blogSetCanonical(yymm || (blogManifest.months[0] || ""));
    var wanted = target ? "?b=" + target : "";
    if (push && location.search !== wanted) {   /* don't stack duplicate entries */
      history.pushState({ blog: target || true }, "", location.pathname + wanted);
    }
    if (AMH.tool && AMH.tool.viewChanged) AMH.tool.viewChanged();
    AMH.site.requestTick();
  }

  /* ==========================================================
     7. ENTRY POINT AND EXPORTS
     ========================================================== */
  /* Render on load. "?b=" selects where to land; without it the newest month
     comes first. On a page with no feed container this returns immediately. */
  (function () {
    if (!blogAttach()) return;
    var m = /[?&]b=([^&]*)/.exec(location.search);
    blogShow(m ? decodeURIComponent(m[1]) : "", false);
  })();

  /* Back and forward move between months on this page. Without "?b=" the URL
     is the page itself, which means the newest month. */
  window.addEventListener("popstate", function () {
    if (!blogFeed) return;
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
       show(target, push)         -> render the stream at a target
       editButtons()              -> add the Edit button to posts on screen

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
