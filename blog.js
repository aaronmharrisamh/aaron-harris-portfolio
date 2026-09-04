/* ============================================================
   blog.js - the blog reading engine.

   Reads the manifest in #blogManifest and the stream the publisher
   wrote into the page. Publishes AMH.blog for the composer in
   publish.js.

   It fetches nothing on load. blog.html carries the newest month's
   posts in full, so the page reads from disk exactly as it reads over
   http. The months before it are one click away: section 6 walks the
   chain of month files and appends them.

   Loaded by blog.html and by every month page. It reads #blogStream
   and does nothing on a page that has no such container, so being
   loaded elsewhere is harmless rather than wrong.

   The manifest is the source of truth. A post's SOURCE lives in
   exactly one place, its month file (blog/YYMM.html), which is also a
   standalone page for a reader arriving from a search engine. The
   stream is a rendered copy of the newest month, and the publish owns
   it. This file only reads; writing is the composer's job.

   A month page loads this file too. It gets the chain, the same bar
   with its month picker, and the same zoom. It has no stream, so it
   has no deep link to answer and nothing to fold: a month page is the
   whole post.

   Eight sections, not seven. FIND is a distinct job that merges into
   none of the others: every other section reads the page it is on, and
   FIND reads a packed file about every post the blog has. It loads
   nothing until something asks.

   Sections:
     1. SETUP                    5. SHOWING A TARGET
     2. MANIFEST AND DATES       6. THE MONTH CHAIN
     3. BODY RENDERING           7. FIND
     4. THE STREAM               8. ENTRY POINT AND EXPORTS
   ============================================================ */
(function () {
  "use strict";
  /* ==========================================================
     1. SETUP
     ========================================================== */
  var AMH = window.AMH = window.AMH || {};
  var doc = document;

  /* HOW LONG A POST SHOWS BEFORE IT FOLDS.

     These two are the whole tuning surface for the cuts. Lines and
     characters are both limits and the first one passed decides, because
     a post of twenty one-word lines and a post of two long paragraphs
     both need to fold and neither measure catches both.

     A line is a block in the body: a paragraph, a list item, a table row,
     a line of code. A figure is one line.

     {expandformore} and {pagebreak} in the source override these for the
     post that carries them. */
  var CUT_SOFT = { lines: 12, chars: 900 };    /* then "Expand for more" */
  var CUT_HARD = { lines: 40, chars: 3000 };   /* then "Read more" */

  /* ==========================================================
     2. MANIFEST AND DATES
     ----------------------------------------------------------
     Parse the manifest tag, and turn its packed dates into the
     labels and datetime values the stream shows.
     ========================================================== */
  var MONTHS_EN = ["January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"];

  /* The lines: next-post and next-img are the counters; stamp names the
     publish that wrote the manifest; month:YYMM=stamp names the publish
     that last wrote that month file; months: is the month list a month
     page states outright, having no entries of its own; every other line
     is entries. A line that matches nothing is reported and skipped.
     publish.js reads the same shape from the pristine source, and the two
     must agree line for line. */
  function blogParseManifest() {
    var el = doc.getElementById("blogManifest");
    var out = { nextPost: 1, nextImg: 1, entries: [], months: [], stamp: "", monthStamps: {} };
    if (!el) return out;
    var lines = el.textContent.split("\n").map(function (l) { return l.trim(); })
      .filter(function (l) { return l !== ""; });
    lines.forEach(function (l) {
      if (l.indexOf("next-post:") === 0) out.nextPost = parseInt(l.slice(10), 10) || 1;
      else if (l.indexOf("next-img:") === 0) out.nextImg = parseInt(l.slice(9), 10) || 1;
      else if (l.indexOf("stamp:") === 0) out.stamp = l.slice(6).trim();
      else if (l.indexOf("months:") === 0) out.months = l.slice(7).split(/\s+/).filter(Boolean);
      else if (/^month:\d{4}=/.test(l)) out.monthStamps[l.slice(6, 10)] = l.slice(11).trim();
      else {
        l.split("|").forEach(function (e) {
          var m = /^(\d{6})(\d{4})(.*)$/.exec(e);
          if (m) out.entries.push({ date: m[1], id: m[2], title: m[3], month: m[1].slice(0, 4) });
          else console.warn("[blog] manifest line not understood, skipped: " + e);
        });
      }
    });
    /* Unique months, newest first, from the entries (the manifest runs
       oldest to newest). A month page carries no entries and states its
       month list outright, so a stated list stands. */
    if (!out.months.length) {
      out.entries.slice().reverse().forEach(function (e) {
        if (out.months.indexOf(e.month) === -1) out.months.push(e.month);
      });
    }
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
  /* prefix is what a static image path is relative to. A month file sits
     in blog/, so its figures point at "../blog/...", which is the default
     and leaves every old caller unchanged. The stream on blog.html is at
     the root and passes "". */
  var BLOG_TAG_RE = /\[(img|png)(\d{4})(?:,([^\]|]*))?(?:\|([^\]]*))?\]/g;
  function blogRenderBody(source, postDate, mode, prefix) {
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
      var at = prefix === undefined ? "../" : prefix;
      return imgs.map(function (im) {
        return '<figure class="bp-fig"><img src="' + at + esc(im.src) + '" loading="lazy" alt="' +
          esc(im.alt) + '" /><figcaption>' +
          esc(im.caption).replace(/&quot;/g, '"') + "</figcaption></figure>";
      }).join("\n");
    });
  }

  /* ==========================================================
     4. THE STREAM
     ----------------------------------------------------------
     The reading surface of blog.html: the posts, the cuts that fold a
     long one, and the bar at the top of the column.

     The newest month's posts are in the page, written there by the
     publish. This section does not build them. It finds the container,
     adds the editor's own buttons when the editor is on, folds each
     post at its cut, and fills the month picker.

     Nothing here fetches. That is what lets this page work when it is
     opened from disk, where a fetch is refused but a link is not.
     ========================================================== */
  var blogStream = null;
  var blogManifest = null;

  /* Find the container this page provides. Returns false on a page that has
     none, which is how every other page opts out of the whole engine. */
  function blogAttach() {
    if (blogStream) return true;
    blogStream = doc.getElementById("blogStream");
    return !!blogStream;
  }

  /* Every post on this page: the stream on blog.html, and the month's
     own posts on a month page, which has no stream. */
  function blogPosts() {
    var root = blogStream || doc.querySelector("main");
    return root ? Array.prototype.slice.call(root.querySelectorAll(".bs-post")) : [];
  }

  /* Give one post its Edit button, if the editor is on and it has none. The
     editor exposes AMH.tool.editPost only while it is active. */
  function blogEditButton(post) {
    if (!(AMH.tool && AMH.tool.editPost)) return;
    if (post.querySelector(".bs-retry")) return;
    var id = post.getAttribute("data-id") || (post.id || "").replace(/^[sp]/, "");
    if (!id) return;
    var eb = doc.createElement("button");
    eb.type = "button";
    eb.className = "bs-retry";
    eb.textContent = "Edit p" + id;
    eb.addEventListener("click", function () { AMH.tool.editPost(id); });
    var by = post.querySelector(".bs-post__by") || post;
    by.appendChild(eb);
  }

  /* Decorate every post on screen. The editor calls this when it turns on,
     because the page was drawn long before that happened, and the loader
     calls it for each month it appends. */
  function blogEditButtons() {
    var posts = blogPosts();
    posts.forEach(blogEditButton);
    return posts.length;
  }

  /* ---------------- the cuts ----------------

     A long post shows to its cut and opens in place. The whole post is
     in the page throughout: the blocks past the cut are hidden, never
     removed. That is what lets a page opened from disk fold and unfold
     the same way, and what lets the search in Phase 3 read every word.

     Only the stream folds. A month page is the whole post, and its cut
     markers are hidden by CSS with nothing reading them. */

  /* One block's worth of lines. A list and a table are as long as they
     look; a code fence is as long as it is. */
  function blogBlockLines(el) {
    var tag = el.tagName;
    if (tag === "UL" || tag === "OL") return el.querySelectorAll("li").length || 1;
    if (tag === "TABLE") return el.querySelectorAll("tr").length || 1;
    if (tag === "PRE") return el.textContent.split("\n").length || 1;
    return 1;
  }
  function blogIsFlag(el, kind) {
    return el.classList && el.classList.contains("bp-cut") &&
      el.getAttribute("data-cut") === kind;
  }
  /* Move a cut off a bad landing. A heading with nothing under it is a
     promise the post does not keep, so the cut goes after it. A cut with
     nothing real left to hide is no cut at all. */
  function blogCutSkip(blocks, at) {
    while (at > 0 && at < blocks.length && /^H[1-6]$/.test(blocks[at - 1].tagName)) at++;
    for (var i = at; i < blocks.length; i++) {
      if (!(blocks[i].classList && blocks[i].classList.contains("bp-cut"))) return at;
    }
    return -1;
  }
  /* The first block to hide, or -1 for no cut. A flag decides it when the
     post carries one. Otherwise the limit does, and the block that crosses
     the limit is shown whole, so a cut never lands inside a figure or a
     table. */
  function blogCutAt(blocks, kind, limit) {
    var i;
    for (i = 0; i < blocks.length; i++) {
      if (blogIsFlag(blocks[i], kind)) return blogCutSkip(blocks, i);
    }
    var lines = 0, chars = 0;
    for (i = 0; i < blocks.length; i++) {
      if (blocks[i].classList && blocks[i].classList.contains("bp-cut")) continue;
      lines += blogBlockLines(blocks[i]);
      chars += blocks[i].textContent.length;
      if (lines >= limit.lines || chars >= limit.chars) return blogCutSkip(blocks, i + 1);
    }
    return -1;
  }
  /* Hide from the cut and put the control there. Expand opens as far as
     the hard cut and hands over to Read more; Read more opens the rest.
     Everything revealed is below the button, so the post grows downward
     and the page does not jump. */
  function blogCutApply(blocks, from, kind, hardAt) {
    var i;
    for (i = from; i < blocks.length; i++) blocks[i].hidden = true;
    var btn = doc.createElement("button");
    btn.type = "button";
    btn.className = "bs-more";
    btn.setAttribute("data-more", kind);
    btn.textContent = kind === "soft" ? "Expand for more" : "Read more";
    blocks[from].parentNode.insertBefore(btn, blocks[from]);
    btn.addEventListener("click", function () {
      var to = (kind === "soft" && hardAt !== -1) ? hardAt : blocks.length;
      for (var j = from; j < to; j++) blocks[j].hidden = false;
      if (btn.parentNode) btn.parentNode.removeChild(btn);
      if (kind === "soft" && hardAt !== -1) blogCutApply(blocks, hardAt, "hard", -1);
      if (AMH.site) AMH.site.requestTick();
    });
  }
  /* Fold one post, once. */
  function blogCutPost(post) {
    if (post.getAttribute("data-folded")) return false;
    post.setAttribute("data-folded", "1");
    var body = post.querySelector(".bs-post__body");
    if (!body) return false;
    var blocks = Array.prototype.slice.call(body.children);
    var soft = blogCutAt(blocks, "soft", CUT_SOFT);
    var hard = blogCutAt(blocks, "hard", CUT_HARD);
    /* a hard cut at or before the soft cut wins, and the soft one goes:
       two controls in a row would ask the reader to press twice for
       nothing */
    if (hard !== -1 && (soft === -1 || hard <= soft)) soft = -1;
    if (soft !== -1) blogCutApply(blocks, soft, "soft", hard);
    else if (hard !== -1) blogCutApply(blocks, hard, "hard", -1);
    else return false;
    return true;
  }
  /* Every post in the stream that has not been folded yet. The loader
     calls this for each month it appends. */
  function blogCutAll() {
    var n = 0;
    blogPosts().forEach(function (p) { if (blogCutPost(p)) n++; });
    return n;
  }

  /* ---------------- zoom ----------------

     Any image in a post opens the shared lightbox at that image, and the
     set is that post's own images in order, so the arrows walk the post
     and stop at its edges.

     One delegated handler on the surface, not one per figure, so a month
     the loader appends zooms with no second binding. work.js owns the
     viewer; a page that somehow lacks it lets the click alone. */
  function blogZoomAttach(root) {
    if (!root) return;
    root.addEventListener("click", function (e) {
      var img = e.target && e.target.closest ? e.target.closest(".bp-fig img") : null;
      if (!img || !(AMH.work && AMH.work.lightbox)) return;
      var post = img.closest(".bs-post") || img.closest(".blog-post") || root;
      var imgs = Array.prototype.slice.call(post.querySelectorAll(".bp-fig img"));
      e.preventDefault();
      AMH.work.lightbox.open(imgs.map(blogZoomItem), imgs.indexOf(img), { opener: img });
    });
  }
  /* The caption is the figure's own, not a data attribute: these figures
     are written with a figcaption, which is what a reader sees when the
     viewer is closed. */
  function blogZoomItem(img) {
    var cap = img.parentNode ? img.parentNode.querySelector("figcaption") : null;
    return {
      src: img.currentSrc || img.src,
      caption: cap ? cap.textContent.trim() : "",
      alt: img.getAttribute("alt") || ""
    };
  }

  /* ---------------- the sticky bar ----------------

     Authored chrome at the top of the column: the name, the slot the
     search pill takes in Phase 3, and the month picker. It sticks under
     the site header once the heading above it scrolls away. */
  var blogMonthSel = null;

  function blogBarFill() {
    blogMonthSel = doc.getElementById("blogMonth");
    if (!blogMonthSel) return false;
    blogManifest = blogManifest || blogParseManifest();
    blogMonthSel.innerHTML = "";
    blogMonthSel.appendChild(blogOption("", "All months"));
    /* the count comes from the manifest, not the index, so the picker is
       right the moment the page is, with nothing to wait for */
    var per = {};
    blogManifest.entries.forEach(function (e) { per[e.month] = (per[e.month] || 0) + 1; });
    blogManifest.months.forEach(function (mo) {
      blogMonthSel.appendChild(blogOption(mo,
        blogMonthTitle(mo) + (per[mo] ? " (" + per[mo] + ")" : "")));
    });
    blogMonthSel.addEventListener("change", function () {
      blogGoMonth(blogMonthSel.value);
    });
    return true;
  }
  function blogOption(value, label) {
    var o = doc.createElement("option");
    o.value = value;
    o.textContent = label;
    return o;
  }
  /* Is this month on the page already? */
  function blogFirstOf(yymm) {
    var hit = null;
    blogPosts().forEach(function (p) {
      if (!hit && (p.getAttribute("data-date") || "").slice(0, 4) === yymm) hit = p;
    });
    return hit;
  }
  /* Hop the chain until the month is on the page, or until the chain
     ends. Each hop is the same load the Older posts link runs. */
  function blogLoadUntil(yymm) {
    if (blogFirstOf(yymm)) return Promise.resolve(true);
    var link = blogStream ? blogStream.querySelector(".bm-older[href]") : null;
    if (!link) return Promise.resolve(false);
    return blogChainLoad(link).then(function (ok) {
      return ok ? blogLoadUntil(yymm) : false;
    });
  }
  /* The picker's three cases. From disk the month file is a page and a
     navigation is what works; on the live site the month comes to the
     reader. "All months" is the top of the stream. */
  function blogGoMonth(yymm) {
    /* On a month page there is no stream to load into: every choice is a
       navigation, and the month files are siblings of this one. */
    if (!blogStream) {
      location.href = yymm ? yymm + ".html" : "../blog.html";
      return;
    }
    if (!yymm) {
      blogStream.scrollIntoView({ block: "start" });
      return;
    }
    if (location.protocol === "file:") {
      location.href = "blog/" + yymm + ".html";
      return;
    }
    blogLoadUntil(yymm).then(function (there) {
      var post = there && blogFirstOf(yymm);
      if (post) post.scrollIntoView({ block: "start" });
      else console.warn("[blog] " + yymm + " is not in the chain from this page.");
    });
  }

  /* ==========================================================
     5. SHOWING A TARGET
     ----------------------------------------------------------
     A deep link, and nothing to load. The stream holds the newest
     month, so a post in it is a scroll; a post outside it lives on its
     own month page, which is a navigation. Both worked before this page
     became a stream and both work now.
     ========================================================== */

  /* target: "" for the top, "pNNNN" for one post, "YYMM" for one month.

     An unknown target shows the stream with a note, because sending a
     reader nowhere is worse than sending them somewhere with an
     explanation. */
  function blogShow(target, push) {
    if (!blogAttach()) return;
    blogManifest = blogManifest || blogParseManifest();
    var note = blogStream.querySelector(".bs-note--unknown");
    if (note) note.remove();
    var unknown = false;

    if (/^p\d{4}$/.test(target)) {
      var id = target.slice(1);
      var here = doc.getElementById("s" + id) || doc.getElementById(target);
      if (here) {
        blogPosts().forEach(function (p) { p.classList.toggle("is-target", p === here); });
        here.scrollIntoView({ block: "start" });
      } else {
        var entry = null;
        blogManifest.entries.forEach(function (e) { if (e.id === id) entry = e; });
        /* the post is in a month this page does not carry: its own page is
           where it lives, and a link is what works from disk */
        if (entry) { location.href = "blog/" + entry.month + ".html#" + target; return; }
        unknown = true;
      }
    } else if (/^\d{4}$/.test(target)) {
      if (blogManifest.months.indexOf(target) === -1) unknown = true;
      else {
        if (blogMonthSel) blogMonthSel.value = target;
        blogGoMonth(target);
        return;
      }
    }

    if (unknown) {
      var n = doc.createElement("p");
      n.className = "bs-note bs-note--unknown";
      n.textContent = "That post or month wasn't found - showing the latest instead.";
      blogStream.insertBefore(n, blogStream.firstChild);
    }
    if (push) {
      history.pushState(null, "", target ? "?b=" + target : location.pathname);
    }
    blogEditButtons();
    if (AMH.tool && AMH.tool.viewChanged) AMH.tool.viewChanged();
    AMH.site.requestTick();
  }

  /* ==========================================================
     6. THE MONTH CHAIN
     ----------------------------------------------------------
     Every month file points at the month before it with an "Older
     posts" link that works with no script and from disk. Over http a
     click loads that month in place: its posts go under the current
     ones with a divider, and the link moves to the new bottom.

     Two surfaces use it. A month page appends month blocks as they are.
     blog.html appends them into the stream, and there two things must
     change on the way in: a path written for a page in blog/ loses its
     one step up, and an id written as "p0007" becomes "s0007", because
     no document may carry the same id twice.

     Each hop is resolved against the url it fetched, so the second hop
     from blog/2608.html to 2607.html lands in blog/ and not at the root.
     ========================================================== */
  var BLOG_AVATAR = "aaron-portfolio-portrait-transparent.png";
  var blogChainAt = "";      /* the url the last hop came from */
  var blogChainRoot = false; /* the stream, rather than a month page */

  /* Returns true when this page is a month page, which is the surface
     that has nothing else to do. blog.html gets the chain too and
     answers its deep link as well, so it returns false there. */
  function blogChainAttach() {
    var onMonth = !!(doc.body && doc.body.classList.contains("blog-month"));
    var stream = doc.getElementById("blogStream");
    if (!onMonth && !stream) return false;
    blogChainRoot = !onMonth;
    blogChainAt = location.href;
    var link = (stream || doc).querySelector(".bm-older[href]");
    if (link) link.addEventListener("click", blogChainClick);
    if (onMonth) {
      /* a month page has the same bar, the same pill and the same zoom;
         it has no stream, so its posts are under main */
      blogBarFill();
      findAttach();
      blogZoomAttach(doc.querySelector("main"));
    }
    return onMonth;
  }
  /* Where the appended posts go: the stream on blog.html, the main
     element on a month page. */
  function blogChainInto() {
    return blogChainRoot ? doc.getElementById("blogStream") : doc.querySelector("main");
  }
  /* A path written for a page in blog/, read from the root. Only the one
     step up comes off, and only from the front. */
  function blogChainPaths(root) {
    Array.prototype.forEach.call(root.querySelectorAll("[src],[href]"), function (el) {
      ["src", "href"].forEach(function (at) {
        var v = el.getAttribute(at);
        if (v && v.slice(0, 3) === "../") el.setAttribute(at, v.slice(3));
      });
    });
  }
  function blogTimeLabel(hhmm) {
    var h = parseInt(hhmm.slice(0, 2), 10);
    var ap = h < 12 ? "am" : "pm";
    return (h % 12 || 12) + ":" + hhmm.slice(2) + " " + ap;
  }
  /* The name on the byline: the one the stream's own posts carry, so an
     appended month reads the same as the month above it. */
  function blogChainBrand() {
    var b = doc.querySelector(".bs-post__by b");
    return b ? b.textContent : "";
  }
  /* A month block in the month page's markup, turned into a stream post.
     publish.js writes the same shape as a string; this builds it as
     nodes, and the suite compares the two. Part 4 of this phase gives
     month pages the stream's own markup, and from then on this only
     renames the id. */
  function blogChainPost(article, brand) {
    var id = article.getAttribute("data-id") || "";
    var date = article.getAttribute("data-date") || "";
    if (article.classList.contains("bs-post")) {
      if (id) article.id = "s" + id;
      /* On its own page the timestamp is the anchor of the post. In the
         stream that anchor is another page's, so it becomes the link to
         it, which is what every post in the stream carries. */
      var when = article.querySelector(".bs-post__when");
      if (when && id && date) when.setAttribute("href", "blog/" + date.slice(0, 4) + ".html#p" + id);
      return article;
    }
    var time = article.getAttribute("data-time") || "";
    var zone = article.getAttribute("data-zone") || "";
    var tags = article.getAttribute("data-tags") || "";
    var title = article.getAttribute("data-title") || "";
    var body = article.querySelector(".blog-post__body");
    var post = doc.createElement("article");
    post.className = "bs-post";
    post.id = "s" + id;
    post.setAttribute("data-id", id);
    post.setAttribute("data-date", date);
    post.setAttribute("data-time", time);
    post.setAttribute("data-zone", zone);
    post.setAttribute("data-tags", tags);
    var by = doc.createElement("header");
    by.className = "bs-post__by";
    by.innerHTML = '<img class="bs-post__avatar" src="' + BLOG_AVATAR + '" alt="" />' +
      "<b></b>" +
      '<a class="bs-post__when" href="blog/' + date.slice(0, 4) + ".html#p" + id + '">' +
      '<time datetime="' + blogDateTime(date) +
      (time ? "T" + time.slice(0, 2) + ":" + time.slice(2) : "") + '"></time>' +
      (zone ? '<span class="bs-post__zone"></span>' : "") + "</a>";
    by.querySelector("b").textContent = brand;
    by.querySelector("time").textContent =
      blogDateLabel(date) + (time ? " · " + blogTimeLabel(time) : "");
    if (zone) by.querySelector(".bs-post__zone").textContent = zone;
    post.appendChild(by);
    if (title) {
      var h = doc.createElement("h3");
      h.className = "bs-post__title";
      h.textContent = title;
      post.appendChild(h);
    }
    var div = doc.createElement("div");
    div.className = "bs-post__body";
    if (body) while (body.firstChild) div.appendChild(body.firstChild);
    post.appendChild(div);
    var list = tags.split(/\s+/).filter(Boolean);
    if (list.length) {
      var td = doc.createElement("div");
      td.className = "bs-post__tags";
      list.forEach(function (t, i) {
        var a = doc.createElement("a");
        a.setAttribute("href", "blog.html?t=" + encodeURIComponent(t));
        a.textContent = "#" + t;
        if (i) td.appendChild(doc.createTextNode(" "));
        td.appendChild(a);
      });
      post.appendChild(td);
    }
    return post;
  }

  function blogChainClick(e) {
    if (location.protocol === "file:") return;   /* the link navigates */
    e.preventDefault();
    blogChainLoad(e.currentTarget);
  }
  /* One hop. Resolves true when the month is on the page, false when it
     could not be read or a hop is already running. The month picker waits
     on it, which is why it is a promise and not only a handler. */
  function blogChainLoad(link) {
    if (link.getAttribute("aria-busy") === "true") return Promise.resolve(false);
    var href = link.getAttribute("href");
    var url = new URL(href, blogChainAt);
    var yymm = (/(\d{4})\.html$/.exec(href) || [])[1] || "";
    var label = yymm ? blogMonthTitle(yymm) : href;
    link.setAttribute("aria-busy", "true");
    link.textContent = "Loading " + label + "...";
    return fetch(url.href, { cache: "no-store" })
      .then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.text();
      })
      .then(function (text) {
        var d = new DOMParser().parseFromString(text, "text/html");
        var main = d.querySelector("main");
        if (!main) throw new Error("no main in " + href);
        /* the source lives in its own file: it is stripped before insert,
           so no post's source is ever on two pages */
        Array.prototype.forEach.call(main.querySelectorAll('script[type="text/x-blog-source"]'),
          function (s) { s.parentNode.removeChild(s); });
        if (blogChainRoot) blogChainPaths(main);
        var here = blogChainInto();
        var divider = doc.createElement("h2");
        divider.className = "bm-divider";
        divider.tabIndex = -1;
        divider.textContent = label;
        here.appendChild(divider);
        var brand = blogChainBrand();
        Array.prototype.slice.call(main.children).forEach(function (node) {
          var el = doc.adoptNode(node);
          here.appendChild(blogChainRoot && el.tagName === "ARTICLE"
            ? blogChainPost(el, brand) : el);
        });
        /* the fetched page's own older link, or its end note, takes the
           clicked link's place */
        var older = d.querySelector(".bm-older");
        if (older) {
          older = doc.adoptNode(older);
          link.parentNode.replaceChild(older, link);
          if (older.getAttribute("href")) older.addEventListener("click", blogChainClick);
        } else {
          link.parentNode.removeChild(link);
        }
        blogChainAt = url.href;
        divider.focus();
        /* On a month page the address follows the month reached: replace,
           not push, so a refresh lands there and Back leaves the chain in
           one step. In the stream the address stays blog.html, because the
           page is still the stream and a refresh should return to its top. */
        if (!blogChainRoot) {
          history.replaceState(null, "", href);
          if (d.title) doc.title = d.title;
        }
        blogEditButtons();
        blogCutAll();
        if (AMH.site) AMH.site.requestTick();
        return true;
      })
      .catch(function (err) {
        console.warn("[blog] could not load " + href + ": " + err.message);
        link.removeAttribute("aria-busy");
        link.textContent = "Could not load " + label + ". Open it instead.";
        return false;
      });
  }

  /* ==========================================================
     7. FIND
     ----------------------------------------------------------
     search.js is everything the site knows about its posts in a form a
     browser can search: one line, `window.AMH_SEARCH = "..."`, holding
     base64 of gzip of JSON. The publish writes it; this reads it.

     It is a classic script and not a JSON file for one reason: a fetch
     is refused from disk and a script tag is not, and reading this site
     from disk has to work. Nothing here runs until something asks, so a
     reader who never searches never loads it.

     One unpacker. publish.js reads the deployed file through
     AMH.search.unpack, so the writer and the reader can never disagree
     about the format.
     ========================================================== */
  var SEARCH_RE = /window\.AMH_SEARCH\s*=\s*"([^"]*)"/;
  var SEARCH_EMPTY = { v: 1, stamp: "", posts: [] };
  var searchLoading = null;   /* the one load, cached as its promise */

  function searchBytes(b64) {
    var bin = atob(b64);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  /* Takes the file's text or the bare packed string. A publish holds the
     file it read; the loader holds the value the script tag set. */
  function searchUnpack(text) {
    var m = SEARCH_RE.exec(String(text || ""));
    var payload = m ? m[1] : String(text || "");
    if (!payload) return Promise.resolve(SEARCH_EMPTY);
    /* a browser with no CompressionStream writes the table unpacked, and
       says so with this prefix */
    if (payload.indexOf("plain:") === 0) {
      return Promise.resolve(JSON.parse(new TextDecoder().decode(searchBytes(payload.slice(6)))));
    }
    if (typeof DecompressionStream !== "function") {
      return Promise.reject(new Error("search is not available in this browser"));
    }
    var stream = new Blob([searchBytes(payload)]).stream()
      .pipeThrough(new DecompressionStream("gzip"));
    return new Response(stream).text().then(function (json) { return JSON.parse(json); });
  }

  /* The table, loaded once. The script tag is created on the first ask
     and never again; a missing file resolves empty, because a site
     published before the index existed has none and "no posts indexed
     yet" is a better answer than a failure. */
  function searchLoad() {
    if (searchLoading) return searchLoading;
    searchLoading = new Promise(function (resolve, reject) {
      if (window.AMH_SEARCH) { resolve(window.AMH_SEARCH); return; }
      var at = doc.body && doc.body.classList.contains("blog-month") ? "../" : "";
      var el = doc.createElement("script");
      el.src = at + "search.js";
      el.onload = function () { resolve(window.AMH_SEARCH || ""); };
      el.onerror = function () {
        console.info("[blog] no search.js on this site yet.");
        resolve("");
      };
      doc.head.appendChild(el);
    }).then(function (packed) {
      return packed ? searchUnpack(packed) : SEARCH_EMPTY;
    });
    return searchLoading;
  }
  /* Every tag the blog uses, with how many posts carry it. Most used
     first, and alphabetical between equals so the order is stable. */
  function searchTags() {
    return searchLoad().then(function (table) {
      var counts = {};
      table.posts.forEach(function (p) {
        String(p.tags || "").split(/\s+/).filter(Boolean).forEach(function (t) {
          counts[t] = (counts[t] || 0) + 1;
        });
      });
      return Object.keys(counts).map(function (t) { return { tag: t, count: counts[t] }; })
        .sort(function (a, b) {
          return a.count === b.count ? (a.tag < b.tag ? -1 : 1) : b.count - a.count;
        });
    });
  }

  /* ---------------- the grammar ----------------

     Three forms, and everything else is a word:

       dome, headset      either one. A comma is "or".
       dome headset       both, in one post. A space is "and".
       "dome projection"  those words in that order.
       #xr                the tag, not the word.

     A query is split on commas into groups; a post matches when any
     group matches, and a group matches when every term in it matches.
     An unclosed quote runs to the end of its group, because a person
     halfway through typing one should still see results.

     tools/e2e/fixtures/queries.txt holds the cases and their parsed
     form, and the parser is done when every line of it matches. */
  function searchParse(q) {
    var groups = [];
    String(q || "").split(",").forEach(function (part) {
      var terms = [];
      var re = /"([^"]*)(?:"|$)|(\S+)/g;
      var m;
      while ((m = re.exec(part))) {
        if (re.lastIndex === m.index) re.lastIndex++;   /* never spin on an empty match */
        if (m[1] !== undefined) {
          var phrase = m[1].trim().toLowerCase();
          if (phrase) terms.push({ kind: "phrase", value: phrase });
        } else if (m[2]) {
          var w = m[2].toLowerCase();
          if (w.charAt(0) === "#" && w.length > 1) terms.push({ kind: "tag", value: w.slice(1) });
          else terms.push({ kind: "word", value: w });
        }
      }
      if (terms.length) groups.push(terms);
    });
    return groups;
  }
  /* What each kind of term is compared against. A tag is compared with
     the tags alone, so #xr finds the tag and not the word; a phrase with
     the prose, where a phrase can occur; a word with everything. */
  function searchFields(post) {
    return {
      tags: String(post.tags || "").toLowerCase().split(/\s+/).filter(Boolean),
      prose: [post.title || "", post.text || "", (post.caps || []).join(" ")].join(" ").toLowerCase(),
      all: [post.title || "", post.text || "", (post.caps || []).join(" "),
            post.tags || ""].join(" ").toLowerCase()
    };
  }
  function searchMatch(post, groups) {
    var f = searchFields(post);
    return groups.some(function (terms) {
      return terms.every(function (t) {
        if (t.kind === "tag") return f.tags.indexOf(t.value) !== -1;
        if (t.kind === "phrase") return f.prose.indexOf(t.value) !== -1;
        return f.all.indexOf(t.value) !== -1;
      });
    });
  }

  /* The passage: the words around the first hit, so a result says why it
     is a result. The hit is looked for in the post's text and then in its
     captions; a query of tags alone has no hit to show, so the post's
     opening stands in for one.

     Returns { before, hit, after }. The caller builds the nodes, because
     a hit spliced into HTML would be a hole in the page. */
  var PASSAGE_SIDE = 60;
  function searchPassage(post, groups) {
    var want = [];
    groups.forEach(function (terms) {
      terms.forEach(function (t) { if (t.kind !== "tag") want.push(t.value); });
    });
    var sources = [post.text || ""].concat(post.caps || []);
    for (var i = 0; i < sources.length; i++) {
      var hay = sources[i].toLowerCase();
      for (var j = 0; j < want.length; j++) {
        var at = hay.indexOf(want[j]);
        if (at !== -1) return searchCut(sources[i], at, want[j].length);
      }
    }
    var opening = (post.text || "").slice(0, PASSAGE_SIDE);
    return { before: opening + ((post.text || "").length > PASSAGE_SIDE ? "..." : ""),
             hit: "", after: "" };
  }
  /* Sixty characters each side, cut on a word so no result begins in the
     middle of one. */
  function searchCut(text, at, len) {
    var from = Math.max(0, at - PASSAGE_SIDE);
    var to = Math.min(text.length, at + len + PASSAGE_SIDE);
    var before = text.slice(from, at);
    var after = text.slice(at + len, to);
    if (from > 0) {
      var sp = before.indexOf(" ");
      before = "..." + (sp === -1 ? before : before.slice(sp + 1));
    }
    if (to < text.length) {
      var sp2 = after.lastIndexOf(" ");
      after = (sp2 === -1 ? after : after.slice(0, sp2)) + "...";
    }
    return { before: before, hit: text.slice(at, at + len), after: after };
  }

  /* ---------------- the pill ----------------

     A search box in the bar, and a list of hits under it. The index is
     not loaded until the box is focused, so a reader who never searches
     never pays for it.

     Every hit is a real link to the post's own page. With script a click
     is caught and, when the post is already on this page, becomes a
     scroll; with no script it is the link it looks like. */
  var FIND_PAUSE = 150;    /* ms after the last key before a search runs */
  var findEl = null, findInput = null, findList = null, findTimer = null;
  var findHits = [], findAt = -1, findTable = null;

  var FIND_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" aria-hidden="true">' +
    '<circle cx="11" cy="11" r="7" /><line x1="16.5" y1="16.5" x2="21" y2="21" /></svg>';

  function findAttach() {
    findEl = doc.getElementById("blogFind");
    if (!findEl) return false;
    findEl.classList.add("bs-find");
    findEl.innerHTML = '<label class="bs-find__pill">' + FIND_ICON +
      '<input type="search" spellcheck="false" placeholder="Search posts, tags, captions" /></label>' +
      '<div class="bs-find__list" role="listbox" hidden></div>';
    findInput = findEl.querySelector("input");
    findList = findEl.querySelector(".bs-find__list");
    findInput.addEventListener("focus", findWake, { once: true });
    findInput.addEventListener("input", function () {
      window.clearTimeout(findTimer);
      findTimer = window.setTimeout(findRun, FIND_PAUSE);
    });
    findInput.addEventListener("keydown", findKeys);
    doc.addEventListener("click", function (e) {
      if (findEl && !findEl.contains(e.target)) findClose();
    });
    return true;
  }
  /* The first focus loads the index, and says so in the box when it
     cannot: a search that silently returns nothing is worse than one
     that explains itself. */
  function findWake() {
    searchLoad().then(function (table) {
      findTable = table;
      if (!table.posts.length) {
        findInput.placeholder = "No posts indexed yet";
      }
    }, function (err) {
      findInput.placeholder = "Search is not available in this browser";
      findInput.disabled = true;
      console.warn("[blog] " + err.message);
    });
  }
  function findRun() {
    if (!findTable) return;
    var groups = searchParse(findInput.value);
    if (!groups.length) { findClose(); return; }
    /* newest first, as the feed is */
    findHits = findTable.posts.filter(function (post) { return searchMatch(post, groups); }).reverse();
    findDraw(groups);
  }
  function findDraw(groups) {
    findList.innerHTML = "";
    var count = doc.createElement("div");
    count.className = "bs-find__count";
    count.textContent = findHits.length === 1 ? "1 post" : findHits.length + " posts";
    findList.appendChild(count);
    findHits.forEach(function (post) {
      findList.appendChild(findHit(post, groups));
    });
    findAt = -1;
    findList.hidden = false;
  }
  /* Where a post lives, from whichever surface is asking. */
  function findHref(post) {
    var at = doc.getElementById("blogStream") ? "blog/" : "";
    return at + post.date.slice(0, 4) + ".html#p" + post.id;
  }
  function findHit(post, groups) {
    var a = doc.createElement("a");
    a.className = "bs-find__hit";
    a.setAttribute("role", "option");
    a.setAttribute("href", findHref(post));
    a.setAttribute("data-id", post.id);
    if (post.thumb) {
      var img = doc.createElement("img");
      img.className = "bs-find__thumb";
      img.src = post.thumb;
      img.alt = "";
      a.appendChild(img);
    } else {
      var tile = doc.createElement("span");
      tile.className = "bs-find__thumb bs-find__thumb--text";
      tile.textContent = "TXT";
      a.appendChild(tile);
    }
    var b = doc.createElement("b");
    b.textContent = post.title || (post.text || "").split(/\s+/).slice(0, 6).join(" ");
    a.appendChild(b);
    var small = doc.createElement("small");
    small.textContent = blogDateLabel(post.date);
    a.appendChild(small);
    var pass = searchPassage(post, groups);
    var pEl = doc.createElement("p");
    pEl.appendChild(doc.createTextNode(pass.before));
    if (pass.hit) {
      var mark = doc.createElement("mark");
      mark.textContent = pass.hit;
      pEl.appendChild(mark);
    }
    pEl.appendChild(doc.createTextNode(pass.after));
    a.appendChild(pEl);
    a.addEventListener("click", findGo);
    return a;
  }
  /* A hit for a post that is already on this page is a scroll, not a
     navigation. Anything else is the link it already is. */
  function findGo(e) {
    var id = e.currentTarget.getAttribute("data-id");
    var here = doc.getElementById("s" + id) || doc.getElementById("p" + id);
    if (!here) return;
    e.preventDefault();
    findClose();
    blogPosts().forEach(function (post) { post.classList.toggle("is-target", post === here); });
    here.classList.add("is-target");
    here.scrollIntoView({ block: "start" });
  }
  function findClose() {
    if (!findList) return;
    findList.hidden = true;
    findAt = -1;
  }
  function findKeys(e) {
    if (e.key === "Escape") { findClose(); return; }
    if (findList.hidden || !findHits.length) return;
    var items = Array.prototype.slice.call(findList.querySelectorAll(".bs-find__hit"));
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      findAt = (findAt + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
      items.forEach(function (el, i) { el.classList.toggle("is-at", i === findAt); });
      items[findAt].scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter" && findAt !== -1) {
      e.preventDefault();
      items[findAt].click();
    }
  }

  /* ---------------- filtering by tag ----------------

     A tag chip is a real link to blog.html?t=tag, so it works with no
     script and from a month page. With script, a chip on this page
     filters it in place instead: the posts that carry the tag stay, the
     rest are hidden, and the posts in months this page does not hold are
     listed under it as links.

     Nothing is removed, only hidden, so clearing the filter is the same
     work backwards. */
  var tagLine = null, tagList = null, tagNow = "";

  function blogFilterTag(tag) {
    tag = String(tag || "").replace(/^#/, "").toLowerCase();
    tagNow = tag;
    var shown = 0;
    blogPosts().forEach(function (post) {
      var has = !tag || String(post.getAttribute("data-tags") || "").toLowerCase()
        .split(/\s+/).indexOf(tag) !== -1;
      post.hidden = !has;
      if (has) shown++;
    });
    blogTagLine(tag, shown);
    blogTagRest(tag);
    /* the address carries the filter, so a copied link shows what the
       person is looking at */
    try {
      history.replaceState(null, "", tag ? "?t=" + encodeURIComponent(tag) : location.pathname);
    } catch (err) {}
    if (AMH.site) AMH.site.requestTick();
  }
  /* The line under the bar: what is on screen, and the way out of it. */
  function blogTagLine(tag, shown) {
    if (!tag) {
      if (tagLine && tagLine.parentNode) tagLine.parentNode.removeChild(tagLine);
      tagLine = null;
      return;
    }
    var bar = doc.getElementById("blogBar");
    if (!bar) return;
    if (!tagLine) {
      tagLine = doc.createElement("p");
      tagLine.className = "bs-showing";
      bar.parentNode.insertBefore(tagLine, bar.nextSibling);
    }
    tagLine.innerHTML = "";
    var what = doc.createElement("b");
    what.textContent = "#" + tag;
    tagLine.appendChild(doc.createTextNode("Showing "));
    tagLine.appendChild(what);
    tagLine.appendChild(doc.createTextNode(" · " + shown + (shown === 1 ? " post here · " : " posts here · ")));
    var clear = doc.createElement("button");
    clear.type = "button";
    clear.className = "bs-showing__clear";
    clear.textContent = "clear";
    clear.addEventListener("click", function () { blogFilterTag(""); });
    tagLine.appendChild(clear);
  }
  /* The posts with this tag that are not on this page. A month page has
     only its own month and says nothing about the others, so the list is
     the stream's alone. */
  function blogTagRest(tag) {
    if (tagList && tagList.parentNode) tagList.parentNode.removeChild(tagList);
    tagList = null;
    if (!tag || !blogStream) return;
    searchLoad().then(function (table) {
      var here = {};
      blogPosts().forEach(function (post) { here[post.getAttribute("data-id")] = true; });
      var rest = table.posts.filter(function (post) {
        return !here[post.id] &&
          String(post.tags || "").toLowerCase().split(/\s+/).indexOf(tag) !== -1;
      }).reverse();
      if (!rest.length || tagNow !== tag) return;
      tagList = doc.createElement("div");
      tagList.className = "bs-find__list bs-tagrest";
      var count = doc.createElement("div");
      count.className = "bs-find__count";
      count.textContent = rest.length === 1 ? "1 more post" : rest.length + " more posts";
      tagList.appendChild(count);
      var groups = [[{ kind: "tag", value: tag }]];
      rest.forEach(function (post) { tagList.appendChild(findHit(post, groups)); });
      blogStream.parentNode.insertBefore(tagList, blogStream.nextSibling);
    }, function () {});
  }
  /* A chip is a link first. On the page it points at, it is a filter. */
  function blogTagClicks() {
    var root = blogStream || doc.querySelector("main");
    if (!root) return;
    root.addEventListener("click", function (e) {
      var a = e.target && e.target.closest ? e.target.closest(".bs-post__tags a") : null;
      if (!a || !blogStream) return;   /* a month page follows the link to the stream */
      var m = /[?&]t=([^&]*)/.exec(a.getAttribute("href") || "");
      if (!m) return;
      e.preventDefault();
      blogFilterTag(decodeURIComponent(m[1]));
    });
  }

  /* ==========================================================
     8. ENTRY POINT AND EXPORTS
     ========================================================== */
  /* Filter on load. "?b=" selects a month or a post; without it every post
     is shown. On a page with no index container this returns immediately.

     Note what does NOT happen here: nothing is rendered and nothing is
     fetched. The posts are already in the page, written by the publisher,
     so a reader with no script gets the newest month whole, and this
     only answers a deep link on top of it. blogChainAttach binds the
     older link on both surfaces and returns true on a month page, which
     has no deep link of its own to answer. */
  (function () {
    var onMonth = blogChainAttach();
    if (!onMonth && !blogAttach()) return;
    blogTagClicks();
    var t = /[?&]t=([^&]*)/.exec(location.search);
    if (onMonth) {
      if (t) blogFilterTag(decodeURIComponent(t[1]));
      return;
    }
    blogBarFill();
    findAttach();
    blogZoomAttach(blogStream);
    blogCutAll();
    if (t) { blogFilterTag(decodeURIComponent(t[1])); return; }
    var m = /[?&]b=([^&]*)/.exec(location.search);
    blogShow(m ? decodeURIComponent(m[1]) : "", false);
  })();

  /* Back and forward answer a deep link again. Without "?b=" the URL is
     the page itself, which is the newest month at the top. */
  window.addEventListener("popstate", function () {
    if (!blogStream) return;
    var m = /[?&]b=([^&]*)/.exec(location.search);
    blogShow(m ? decodeURIComponent(m[1]) : "", false);
  });

  /* AMH.blog
     The reading engine's internal surface, for the composer in tool.js.
     It is not a public API: the composer and this file ship together, so
     a member may change as long as both change with it.

       parseManifest()            -> { entries, months, nextPost, nextImg, stamp }
       renderBody(src, date, mode, prefix) -> HTML for one post body
       encodeSource(s) / decodeSource(s) -> the escaped form stored in a
                                   month file's x-blog-source tag
       monthTitle(yymm) / dateLabel(yymmdd) / dateTime(yymmdd) -> display
       show(target, push)         -> answer a deep link
       editButtons()              -> add the Edit button to the posts
       cut()                      -> fold every post in the stream that
                                  is not folded yet, and say how many

     AMH.search
       load()                     -> Promise of the packed index, read
                                  once and kept; empty when there is none
       tags()                     -> Promise of [{tag, count}]
       unpack(text)               -> Promise of a table, from a file's
                                  text or a bare packed string. The
                                  publish reads the deployed file with
                                  it, so there is one unpacker.
       parse(query)               -> the query as groups of terms
       match(post, groups)        -> does this post answer that query
       passage(post, groups)      -> { before, hit, after } around the
                                  first hit, for the results list

     AMH.blog.filterTag(tag)      show only the posts with that tag, and
                                  "" to show them all again

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
    editButtons: blogEditButtons,
    cut: blogCutAll,
    filterTag: blogFilterTag
  };
  AMH.search = { load: searchLoad, tags: searchTags, unpack: searchUnpack,
                 parse: searchParse, match: searchMatch, passage: searchPassage };
})();
