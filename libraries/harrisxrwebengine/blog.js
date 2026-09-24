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
  /* The tag's grammar is the image engine's, and every tag reader here is
     built from it, so this file stops when imagesengine.js is missing. The
     posts a page carries still read. */
  if (!AMH.images || !AMH.images.tag) {
    console.warn("[blog] blog.js needs imagesengine.js, which did not load before it.");
    return;
  }

  /* HOW LONG A POST SHOWS BEFORE IT FOLDS.

     These two are the whole tuning surface for the cuts. Lines and
     characters are both limits and the first one passed decides, because
     a post of twenty one-word lines and a post of two long paragraphs
     both need to fold and neither measure catches both.

     A line is a block in the body: a paragraph, a list item, a table row,
     a line of code. A carousel is one line.

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

  /* One image on the site, as a manifest from before the image index
     states it:

       image:0001=260903 png 4032x3024 3145728 uhd

     the date its files are named for, the ORIGINAL's format, size and
     bytes, and then the flags that hold: uhd when the page shows the
     original in the display copy's place, truesize when it shows the
     original at its own size, gif when it moves. A line with truesize
     carries uhd as well, so a reader that knows only uhd still shows the
     original.

     The date and the number give every path, so nothing else is written
     down. These facts live in images.js now. Such a line is read so that a
     manifest from before the index still opens, and the next rebuild moves
     it into the index; nothing writes one again. publish.js reads the
     same line, and the two must agree. */
  function blogImageLine(line) {
    var m = /^image:([0-9a-z]\d{3})=(\d{6})\s+([a-z0-9]+)\s+(\d+)x(\d+)\s+(\d+)(.*)$/.exec(line);
    if (!m) return null;
    var flags = m[7].split(/\s+/).filter(Boolean);
    var truesize = flags.indexOf("truesize") !== -1;
    return { num: m[1], date: m[2], type: m[3], ow: +m[4], oh: +m[5], bytes: +m[6],
             uhd: truesize || flags.indexOf("uhd") !== -1, truesize: truesize,
             animated: flags.indexOf("gif") !== -1 };
  }

  /* The lines: next-post is the post counter; stamp names the publish that
     wrote the manifest; month:YYMM=stamp names the publish that last
     wrote that month file; months: is the month list a month page states
     outright, having no entries of its own; every other line is entries.
     next-img and image:NNNN= are from before images.js held the image
     counter and every image: a manifest that still carries them is read
     with them, and the next rebuild writes it without them. A line that
     matches nothing is reported and skipped. publish.js reads the same
     shape from the pristine source, and the two must agree line for line. */
  /* AN ID, FOR A POST OR AN IMAGE.

     Four characters. The first place counts in base 36 and the last three
     in decimal: 0000 to 9999, then a000 to a999, and so on to z999. That
     is 36,000 ids, every existing id unchanged, digits until the
     ten-thousandth, and a letter then says which block an id is in. Ids
     sort as strings, because a digit sorts before a letter. */
  var ID_DIGITS = "0123456789abcdefghijklmnopqrstuvwxyz";
  var BLOG_ID = "[0-9a-z]\\d{3}";
  /* the id of the n-th post or image, from 0 to 35999 */
  function blogIdOf(n) {
    n = Math.floor(Number(n));
    if (!(n >= 0 && n < 36000)) throw new Error("The site has no id left for a new post or image.");
    return ID_DIGITS.charAt(Math.floor(n / 1000)) + ("00" + (n % 1000)).slice(-3);
  }
  /* the number an id stands for, or 0 for anything that is not an id */
  function blogIdNum(id) {
    var s = String(id || "").trim();
    if (!/^[0-9a-z]\d{3}$/.test(s)) return 0;
    return ID_DIGITS.indexOf(s.charAt(0)) * 1000 + parseInt(s.slice(1), 10);
  }

  /* THE IMAGE COUNTER: the id the next image or media file takes. It never
     goes down. Once z999, the last id, is taken, the counter says
     "exhausted": a word no tag and no file name can be, so it can never
     be read as an id and handed out again.

     These two are the one way between a counter's text and a number.
     Every other way loses the end: an id function throws at 36,000, and
     "exhausted" read as an id is 0, which a fallback of 1 turns into 0001.
     A counter that is not a counter reads as 0, so a caller can take a
     larger value from elsewhere and never believe this one. */
  var BLOG_ID_COUNT = 36000;
  var BLOG_COUNTER_DONE = "exhausted";
  /* the next number a counter names: 1 to 36000, where 36000 is
     "exhausted", or 0 for text that is not a counter. New numbers start
     at 0001, so a counter of 0000 names 1. */
  function blogCounterNum(text) {
    var s = String(text == null ? "" : text).trim();
    if (s === BLOG_COUNTER_DONE) return BLOG_ID_COUNT;
    if (!/^[0-9a-z]\d{3}$/.test(s)) return 0;
    return Math.max(1, blogIdNum(s));
  }
  /* a number as a counter's text: an id, or "exhausted" from 36000 up */
  function blogCounterText(n) {
    n = Math.floor(Number(n)) || 0;
    if (n >= BLOG_ID_COUNT) return BLOG_COUNTER_DONE;
    return blogIdOf(Math.max(1, n));
  }

  function blogParseManifest() {
    var el = doc.getElementById("blogManifest");
    var out = { nextPost: 1, nextImg: 1, entries: [], months: [], stamp: "",
                monthStamps: {}, images: {} };
    if (!el) return out;
    var lines = el.textContent.split("\n").map(function (l) { return l.trim(); })
      .filter(function (l) { return l !== ""; });
    lines.forEach(function (l) {
      if (l.indexOf("next-post:") === 0) out.nextPost = blogIdNum(l.slice(10)) || 1;
      else if (l.indexOf("next-img:") === 0) out.nextImg = blogCounterNum(l.slice(9)) || 1;
      else if (l.indexOf("stamp:") === 0) out.stamp = l.slice(6).trim();
      else if (l.indexOf("months:") === 0) out.months = l.slice(7).split(/\s+/).filter(Boolean);
      else if (/^month:\d{4}=/.test(l)) out.monthStamps[l.slice(6, 10)] = l.slice(11).trim();
      else if (l.indexOf("image:") === 0) {
        var img = blogImageLine(l);
        if (img) out.images[img.num] = img;
        else console.warn("[blog] manifest image line not understood, skipped: " + l);
      }
      else {
        l.split("|").forEach(function (e) {
          var m = /^(\d{6})([0-9a-z]\d{3})(.*)$/.exec(e);
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

  /* WHERE A POST LIVES. Every post URL on the site comes from here.

     A post lives in the month file its own date names, so the date is
     the argument and not the month: a post appended from an older month
     still points at the file that holds it.

     `from` is the surface that asks. A page at the site root says "root"
     and gets the blog/ step; a page in blog/ says "month" and does not.
     `focus` asks for the reading view that shows that post alone.

     The fragment stays on a focused URL. With no script the month is
     still readable and the anchor still finds the post, so the address
     degrades to the one the site has always used. */
  function blogPostUrl(date, id, from, focus) {
    var file = String(date).slice(0, 4) + ".html";
    return (from === "month" ? "" : "blog/") + file +
      (focus ? "?post=p" + id : "") + "#p" + id;
  }
  /* Which surface this page is. The stream sits at the site root and a
     month file sits in blog/, so a post URL differs by one step and every
     builder on the page has to ask. The stream container is the test,
     because it exists in the markup before any of this runs. */
  function blogSurface() {
    return doc.getElementById("blogStream") ? "root" : "month";
  }

  /* ==========================================================
     3. BODY RENDERING
     ----------------------------------------------------------
     A post body is plain HTML plus tags of the form
     [img0001,caption|alt] and [video0012,caption|description]. Each run
     of tags becomes one carousel, which work.js builds on the page the
     way it builds the home page's. A tag that says nocarousel is a block
     of its own.
     ========================================================== */
  /* How wide a blog image is drawn, which the browser has to be told before
     it picks a copy.

     The stream and a month page draw the SAME column: 600px at most, less
     the column's own padding and the card's, which is about 500px on a
     desktop and about 80vw on a phone. That is deliberate - see the note
     over .bs-stream in engine.css section 6 - so one measurement serves both.

     widest is the widest the string above can ask for, 80vw at 700px. A
     carousel draws a photo at its own size, and a srcset would stretch a
     photo narrower than the slot, so such a photo is written without one. */
  var BLOG_SIZES = "(max-width: 700px) 80vw, 520px";
  var BLOG_SLOT = { sizes: BLOG_SIZES, widest: 560 };

  /* THE TAG.

       [portrait img0001,caption|alt]
       [nocarousel noborders video0012,caption|description]

     Its grammar is the image engine's, in AMH.images.tag: see THE TAG in
     section 2 of imagesengine.js. A match has five groups: the options as
     one string, or nothing when a tag has none; the kind's word; the
     number; the caption; the alt. A tag with one frame word has that word
     alone in the first group, as it always had.

     markdown.js reads tags too, and it loads on the home page, where this
     file does not, which is why the grammar is not this file's. publish.js
     builds every tag reader it has from the three names below, so a tag
     means one thing to the composer, the renderer and the page. */
  var BLOG_TAG_RULE = AMH.images.tag;
  var BLOG_OPTIONS = BLOG_TAG_RULE.options;
  /* each kind's word, and the kind it names */
  var BLOG_KINDS = BLOG_TAG_RULE.kinds;
  var BLOG_TAG = BLOG_TAG_RULE.source;

  /* "a", "a and b", "a, b and c" */
  function blogAnd(list) {
    if (list.length < 2) return list.join("");
    return list.slice(0, -1).join(", ") + " and " + list[list.length - 1];
  }

  /* A TAG'S OPTIONS, BY NAME.

       shape       the frame word: portrait, landscape, or portrait1:1 for
                   a square; "" for none
       nocarousel  a block of its own, outside any carousel
       noborders   a frame with no border, background, shadow or inset
       nocontrols  the player's own controls hidden
       autoplay    play, once the player can be seen and the browser lets it
       sound       "muted", "unmuted", or "" for the default, which is sound
       loop        play again from the start at the end

     The first frame word is the tag's. A second, different one is a
     problem, and so is a tag that says both muted and unmuted. A word
     written twice is read once. problems lists each as a short phrase. */
  var BLOG_SHAPES = BLOG_TAG_RULE.shapes;
  function blogTagOptions(text) {
    var o = { shape: "", nocarousel: false, noborders: false, nocontrols: false,
              autoplay: false, sound: "", loop: false, problems: [] };
    var said = function (p) { if (o.problems.indexOf(p) === -1) o.problems.push(p); };
    String(text || "").split(" ").forEach(function (w) {
      if (!w) return;
      if (BLOG_SHAPES.indexOf(w) !== -1) {
        if (!o.shape) o.shape = w;
        else if (o.shape !== w) said("two frame words, " + o.shape + " and " + w);
      } else if (w === "muted" || w === "unmuted") {
        if (!o.sound) o.sound = w;
        else if (o.sound !== w) said("both muted and unmuted");
      } else if (BLOG_OPTIONS.indexOf(w) !== -1) {
        o[w] = true;
      }
    });
    return o;
  }
  /* The options as a tag writes them: each one once, in one order. A tag
     the composer writes says the same thing in the same words each time. */
  function blogOptionsText(o) {
    var out = [];
    if (o.nocarousel) out.push("nocarousel");
    if (o.shape) out.push(o.shape);
    if (o.noborders) out.push("noborders");
    if (o.nocontrols) out.push("nocontrols");
    if (o.autoplay) out.push("autoplay");
    if (o.sound) out.push(o.sound);
    if (o.loop) out.push("loop");
    return out.join(" ");
  }

  /* ONE TAG, READ: a match of BLOG_TAG as the options above, and

       text      the tag as it is written
       at        where it starts in the text it was found in
       word      the kind's word as written: img, png, video, audio or midi
       kind      "image", "video", "audio" or "midi"
       num       the id
       caption   the caption, trimmed; "" for none
       alt       the alt text or the description, trimmed; "" for none

     A playback option on a picture or a MIDI file is a problem too: it
     asks for a player that the page never draws. */
  var BLOG_PLAYBACK = ["nocontrols", "autoplay", "loop"];
  function blogTagRead(m) {
    var r = BLOG_TAG_RULE.read(m);
    var o = blogTagOptions(r.options);
    o.text = r.text; o.at = m.index; o.word = r.word; o.kind = r.kind; o.num = r.num;
    o.caption = r.caption; o.alt = r.alt;
    if (o.kind !== "video" && o.kind !== "audio") {
      var asks = BLOG_PLAYBACK.filter(function (w) { return o[w]; });
      if (o.sound) asks.push(o.sound);
      if (asks.length) o.problems.push(blogAnd(asks) + (asks.length === 1 ? " is" : " are") + " for audio and video only");
    }
    return o;
  }
  /* every tag in a text, read, in the order they are written */
  function blogTagsOf(source) {
    var re = new RegExp(BLOG_TAG, "g");
    var out = [], m;
    while ((m = re.exec(String(source || "")))) out.push(blogTagRead(m));
    return out;
  }

  /* TEXT THAT IS ALMOST A TAG.

     A bracketed run that holds a kind's word and an id, and that the tag
     rule does not match whole: [unsupportedshape img0005,...], [Portrait
     img0005], [img 0005], [Video0012]. The kind's word is found in any
     case, because a capital is the likeliest slip. A link's text, the
     brackets before "(", is never one. The composer names such text while
     it is typed and once more at publish, because a typo here used to cost
     the image. The escape [!img0005] is a deliberate non-tag and is never
     named. */
  var NEAR_TAG = new RegExp("\\[(?!!)[^\\]\\n]*\\b(?:" + BLOG_TAG_RULE.KIND + ")\\s?" + BLOG_TAG_RULE.ID +
    "\\b[^\\]\\n]*\\](?!\\()", "gi");
  function blogNearTags(source) {
    var whole = new RegExp("^" + BLOG_TAG + "$");
    var out = [], m;
    NEAR_TAG.lastIndex = 0;
    while ((m = NEAR_TAG.exec(String(source || "")))) {
      if (!whole.test(m[0]) && out.indexOf(m[0]) === -1) out.push(m[0]);
    }
    return out;
  }

  /* One image tag, as an entry the engine writes markup from. The manifest
     names the original's format and size; every path and the copies' sizes
     follow from those. A number the manifest does not know is an image from
     before the engine: it gets the one path it always had. */
  function blogImageEntry(num, postDate, fmt, images) {
    var img = images && images[num];
    if (!img) {
      return { src: "blog/" + postDate + "_img" + num + (fmt === "png" ? ".png" : ".jpg") };
    }
    var base = "blog/" + img.date + "_img" + img.num;
    var hd = AMH.images.copySize(img.ow, img.oh, "hd");
    var sd = AMH.images.copySize(img.ow, img.oh, "sd");
    return { src: base + ".jpg", sd: base + "_sd.webp", sdw: sd.w,
             w: hd.w, h: hd.h, ow: img.ow, oh: img.oh,
             original: base + "_original." + img.type, bytes: img.bytes, uhd: img.uhd,
             truesize: img.truesize };
  }

  /* The runs of tags in a body. Tags with nothing between them but white
     space holding at most one line break are one run, so tags on back-to-
     back lines are one run, and a blank line or any text starts the next.
     Returns [{ start, end, tags }], each tag a match of BLOG_TAG. */
  function blogTagRuns(source) {
    var re = new RegExp(BLOG_TAG, "g");
    var runs = [], run = null, m;
    while ((m = re.exec(source))) {
      if (run && /^[ \t]*(?:\r?\n)?[ \t]*$/.test(source.slice(run.end, m.index))) {
        run.tags.push(m);
        run.end = re.lastIndex;
      } else {
        run = { start: m.index, end: re.lastIndex, tags: [m] };
        runs.push(run);
      }
    }
    return runs;
  }
  /* The runs of a text, each tag read: [{ start, end, tags }]. The
     composer asks, to say which carousel a placement is in. */
  function blogRunsOf(source) {
    return blogTagRuns(String(source || "")).map(function (run) {
      return { start: run.start, end: run.end, tags: run.tags.map(blogTagRead) };
    });
  }
  /* A run's carousels, each a list of read tags: the run cut at each tag
     that says nocarousel, which belongs to none of them. */
  function blogStretches(tags) {
    var out = [], stretch = [];
    tags.forEach(function (t) {
      if (!t.nocarousel) { stretch.push(t); return; }
      if (stretch.length) out.push(stretch);
      stretch = [];
    });
    if (stretch.length) out.push(stretch);
    return out;
  }

  /* WHAT THE COMPOSER SAYS ABOUT A BODY'S TAGS: { problems, notices }.

     A problem stops a publish, because the tag cannot be shown as it is
     written: two frame words, both muted and unmuted, a playback option on
     a picture or a MIDI file, or an id that names a file of another kind.
     A notice does not: a word in a carousel's later tag that the first
     tag already decides, so the page does not use it.

     map is the site's { num: entry }. Without one, no kind is compared.
     Each message starts with the tag as it is written. */
  function blogTagIssues(source, map) {
    var problems = [], notices = [];
    var add = function (list, s) { if (list.indexOf(s) === -1) list.push(s); };
    blogTagRuns(String(source || "")).forEach(function (run) {
      var tags = run.tags.map(blogTagRead);
      tags.forEach(function (t) {
        t.problems.forEach(function (p) { add(problems, t.text + ": " + p + "."); });
        var rec = map ? map[t.num] : null;
        var kind = rec ? rec.kind || "image" : "";
        if (rec && kind !== t.kind) {
          add(problems, t.text + ": " + t.num + " is " + AMH.images.kindWords(kind) + ". Write " +
            AMH.images.tagWordOf(kind) + t.num + ".");
        }
      });
      blogStretches(tags).forEach(function (stretch) {
        var shape = "";
        stretch.forEach(function (t, i) {
          if (t.shape && !shape) shape = t.shape;
          else if (t.shape && t.shape !== shape) {
            add(notices, t.text + ": " + t.shape + " is not used. The carousel's first frame word, " +
              shape + ", sets its frame.");
          }
          if (i > 0 && t.noborders && !stretch[0].noborders) {
            add(notices, t.text + ": noborders is not used. The carousel's first tag sets its borders.");
          }
        });
      });
    });
    return { problems: problems, notices: notices };
  }

  /* An attribute's value, and the text of an element, escaped. */
  function blogAttr(s) {
    return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  }
  /* A path under the page's prefix. A blob: URL, a rooted path and an
     address with a scheme are already whole. AMH.images.attrs follows the
     same rule for an image's paths. */
  function blogPut(prefix, path) {
    return path && prefix && path.indexOf("blob:") !== 0 && path.indexOf("/") !== 0 &&
      !/^[a-z]+:/i.test(path) ? prefix + path : path;
  }

  /* The entry a tag is drawn from, or null when the tag stays as its own
     text. An image tag with no entry is an image from before the engine,
     which blogImageEntry still names. A media tag never is: with no entry
     of its own kind there is no file to play, and a guessed path would be
     a player for nothing. An image tag that names a media file is the same
     slip the other way round. */
  function blogEntryFor(t, postDate, images) {
    var rec = images ? images[t.num] : null;
    var kind = rec ? rec.kind || "image" : "";
    if (t.kind === "image") return rec && kind !== "image" ? null : blogImageEntry(t.num, postDate, t.word, images);
    return rec && kind === t.kind ? rec : null;
  }

  /* One image, as the <img> a carousel shows, with the markup contract on it. */
  function blogImgHtml(t, opts) {
    var attrs = AMH.images.attrs(t.entry, BLOG_SLOT, opts)
      .map(function (a) { return " " + a[0] + '="' + blogAttr(a[1]) + '"'; }).join("");
    return "<img" + attrs + ' loading="lazy" alt="' + blogAttr(t.alt || t.caption || ("Blog image " + t.num)) + '"' +
      (t.caption ? ' data-caption="' + blogAttr(t.caption) + '"' : "") + " />";
  }
  /* One image on its own, outside any carousel: a figure, with its caption
     under the picture. */
  function blogAloneImageHtml(t, opts) {
    return '<figure class="bp-media bp-media--alone" data-kind="image"' +
      (t.shape ? ' data-shape="' + t.shape + '"' : "") + (t.noborders ? ' data-noborders="1"' : "") + ">" +
      blogImgHtml(t, opts) +
      (t.caption ? '<figcaption class="bp-media__cap">' + blogAttr(t.caption) + "</figcaption>" : "") + "</figure>";
  }

  /* THE MEDIA PLACEMENT, NAMED ONCE: one video, sound or MIDI file as a
     figure that works with no script. A video or a sound is the browser's
     own player, with its controls, paused, and loading nothing until it is
     played. A MIDI file is a link to the file, because a browser has no
     player for one. Every figure carries a link that downloads the file
     under the name it was added with.

     What the tag asks for rides on the figure as data, for work.js:
     data-nocontrols, data-autoplay, data-sound and data-loop, and, on a
     figure of its own, data-shape and data-noborders. muted and loop are
     the player's own attributes too, which work with no script. autoplay
     is data only: a page must not start by itself, so the script decides
     when it may ask. The controls stay in the markup for nocontrols as
     well; they come off only once something else can play and pause. */
  var BLOG_KIND_NAMES = { video: "video", audio: "audio", midi: "MIDI file" };
  function blogMediaHtml(t, opts, alone) {
    var e = t.entry;
    var src = blogPut(opts.prefix, AMH.images.filesOf(e).source);
    var name = e.from || src.replace(/^.*\//, "");
    var said = t.alt || t.caption || ("Blog " + BLOG_KIND_NAMES[t.kind] + " " + t.num);
    var size = e.bytes && AMH.work && AMH.work.sizeText ? " (" + AMH.work.sizeText(e.bytes) + ")" : "";
    var plays = t.kind === "video" || t.kind === "audio";
    var player = !plays ? "" : "<" + t.kind + ' controls preload="none"' +
      (t.kind === "video" ? " playsinline" : "") + (t.sound === "muted" ? " muted" : "") + (t.loop ? " loop" : "") +
      (t.kind === "video" && e.ow && e.oh ? ' width="' + e.ow + '" height="' + e.oh + '"' : "") +
      ' aria-label="' + blogAttr(said) + '"><source src="' + blogAttr(src) + '" type="' + blogAttr(e.mime) + '" />' +
      "</" + t.kind + ">";
    return '<figure class="bp-media' + (alone ? " bp-media--alone" : "") + '" data-kind="' + t.kind + '"' +
      (alone && t.shape ? ' data-shape="' + t.shape + '"' : "") +
      (alone && t.noborders ? ' data-noborders="1"' : "") +
      (plays && t.nocontrols ? ' data-nocontrols="1"' : "") + (plays && t.autoplay ? ' data-autoplay="1"' : "") +
      (plays && t.sound ? ' data-sound="' + t.sound + '"' : "") + (plays && t.loop ? ' data-loop="1"' : "") +
      (t.caption ? ' data-caption="' + blogAttr(t.caption) + '"' : "") + ">" + player +
      (t.caption ? '<figcaption class="bp-media__cap">' + blogAttr(t.caption) + "</figcaption>" : "") +
      '<a class="bp-media__file" href="' + blogAttr(src) + '" download="' + blogAttr(name) + '" type="' +
      blogAttr(e.mime) + '">Download ' + blogAttr(name) + size + "</a></figure>";
  }

  /* One carousel: a .gallery for a stretch of tags, with an <img> for each
     image and a figure for each media file, in the order they are written.
     The first frame word in the stretch becomes its data-shape; with none,
     work.js takes the frame's shape from the pictures. The first tag's
     noborders is the carousel's, so the frame does not change from one
     slide to the next. */
  function blogCarouselHtml(tags, opts) {
    var shape = "";
    var items = tags.map(function (t) {
      if (!shape && t.shape) shape = t.shape;
      return t.kind === "image" ? blogImgHtml(t, opts) : blogMediaHtml(t, opts, false);
    });
    return '<div class="gallery"' + (shape ? ' data-shape="' + shape + '"' : "") +
      (tags[0].noborders ? ' data-noborders="1"' : "") + ">" + items.join("") + "</div>";
  }
  /* One run of tags as the blocks it makes. The tags of a run are one
     carousel until a tag says nocarousel: that tag is a block of its own,
     and the tags after it start the next carousel, so two such tags side
     by side are two blocks. A tag with no entry to draw from stays as the
     text it is, with the space before it, and ends the carousel before it
     the same way. text is the whole text the run was found in. */
  function blogRunHtml(text, tags, postDate, images, opts) {
    var html = "", stretch = [];
    function close() {
      if (stretch.length) html += blogCarouselHtml(stretch, opts);
      stretch = [];
    }
    tags.forEach(function (t, i) {
      t.entry = blogEntryFor(t, postDate, images);
      if (!t.entry) {
        close();
        html += (i ? text.slice(tags[i - 1].at + tags[i - 1].text.length, t.at) : "") + t.text;
        return;
      }
      if (!t.nocarousel) { stretch.push(t); return; }
      close();
      html += t.kind === "image" ? blogAloneImageHtml(t, opts) : blogMediaHtml(t, opts, true);
    });
    close();
    return html;
  }

  /* A post body with each run of tags written as the blocks it makes: a
     .gallery for a carousel, and a figure for a tag on its own.

       source    the body's HTML; a Markdown post's is rendered first
       postDate  its YYMMDD, for an image from before the engine
       prefix    what a path is relative to: "" on blog.html and in the
                 preview, "../" on a month page, which sits in blog/
       images    the site's map of what it holds, { num: entry }. Without
                 one an image tag is written as it was before the engine,
                 with one src, and a media tag stays as text

     Everything outside the runs is the source, byte for byte. */
  function blogRenderBody(source, postDate, prefix, images) {
    var opts = { prefix: prefix === undefined ? "../" : prefix };
    var text = String(source);
    var out = "", at = 0;
    blogTagRuns(text).forEach(function (run) {
      out += text.slice(at, run.start) + blogRunHtml(text, run.tags.map(blogTagRead), postDate, images, opts);
      at = run.end;
    });
    return out + text.slice(at);
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
  /* The mark on the post edit chip. Drawn once, here, and inlined into each
     chip: an <img> would be a request per post, and the stroke has to be
     currentColor so it stays black on the yellow ground. */
  /* The arrow on Back. Drawn here like the caret and the pencil, so it is
     one request fewer and takes currentColor with the chip it sits in. */
  var BLOG_BACK =
    '<svg class="bm-back__i" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M19 12H5" /><path d="m12 19-7-7 7-7" /></svg>';

  /* The mark on the stream's older link: down, because the month arrives
     below rather than replacing the page. publish.js carries the same
     glyph as BC_DOWN, for the link it writes before any append. */
  var BLOG_DOWN =
    '<svg class="bm-older__i" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M12 5v14" /><path d="m19 12-7 7-7-7" /></svg>';

  var BLOG_PENCIL =
    '<svg class="bs-retry__i" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M12 20h9" /><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg>';

  function blogEditButton(post) {
    if (!(AMH.tool && AMH.tool.editPost)) return;
    if (post.querySelector(".bs-retry")) return;
    var id = post.getAttribute("data-id") || (post.id || "").replace(/^[sp]/, "");
    if (!id) return;
    var eb = doc.createElement("button");
    eb.type = "button";
    /* Two classes, two jobs: bs-retry places it in the post's grid, and
       ced-pill is the paint every one of the editor's pills wears. */
    eb.className = "bs-retry ced-pill";
    /* The pencil is decoration, so it is hidden from a screen reader and
       carries no title: a title element would put words into textContent,
       and the label is the button's only text. */
    eb.innerHTML = BLOG_PENCIL;
    eb.appendChild(doc.createTextNode("Edit p" + id));
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
    blogNewPostPills();
    return posts.length;
  }

  /* THE NEW POST PILLS. While the editor is on, one at the end of the bar at
     the top of the column, and one after the last post on the page, which
     moves down each time the chain appends a month. They are the editor's:
     they come with AMH.tool.newPost, and the editor's teardown takes them. */
  var BLOG_PLUS =
    '<svg class="bs-retry__i" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M12 5v14" /><path d="M5 12h14" /></svg>';

  function blogNewPostPill(where) {
    var b = doc.createElement("button");
    b.type = "button";
    /* Two classes, two jobs, as on the Edit pill: bs-newpost places it,
       and ced-pill is the paint every one of the editor's pills wears. */
    b.className = "bs-newpost bs-newpost--" + where + " ced-pill";
    b.innerHTML = BLOG_PLUS;
    b.appendChild(doc.createTextNode("New post"));
    b.addEventListener("click", function () {
      if (AMH.tool && AMH.tool.newPost) AMH.tool.newPost();
    });
    return b;
  }

  function blogNewPostPills() {
    if (!(AMH.tool && AMH.tool.newPost)) return;
    var bar = doc.getElementById("blogBar");
    if (bar && !bar.querySelector(".bs-newpost")) bar.appendChild(blogNewPostPill("top"));
    var posts = blogPosts();
    var last = posts[posts.length - 1];
    if (!last || !last.parentNode) return;
    var foot = doc.querySelector(".bs-newpost--foot") || blogNewPostPill("foot");
    if (last.nextSibling !== foot) last.parentNode.insertBefore(foot, last.nextSibling);
  }

  /* ---------------- the cuts ----------------

     A long post shows to its cut and opens in place. The whole post is
     in the page throughout: the blocks past the cut are hidden, never
     removed. That is what lets a page opened from disk fold and unfold
     the same way, and what lets the search in Phase 3 read every word.

     Only the stream folds. A month page is the whole post, and its cut
     markers are hidden by CSS with nothing reading them. */

  /* The page hid or showed a part of a post: a fold, an Expand, a tag
     filter or one post on its own. Every player looks again, so one
     that nobody can see stops where it is, and nothing starts before its
     part of the post is on screen. work.js holds the players' rules. */
  function blogPlayersLook() {
    if (AMH.work && AMH.work.mediaSync) AMH.work.mediaSync();
  }

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
     the limit is shown whole, so a cut never lands inside a carousel or a
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
     the hard cut and hands over to Read more; Read more is a link to the
     post's own page, where it is read whole. */
  function blogCutApply(post, blocks, from, kind, hardAt) {
    var i;
    for (i = from; i < blocks.length; i++) blocks[i].hidden = true;
    /* The hard cut is where a post stops being an item in a stream and
       becomes something to read, so it is a link to the post's own page.
       The soft cut is still an expansion, and stays a button. */
    if (kind === "hard") {
      var a = doc.createElement("a");
      a.className = "bs-more";
      a.setAttribute("data-more", "hard");
      a.href = blogPostUrl(post.getAttribute("data-date") || "",
                           post.getAttribute("data-id") || "", blogSurface(), true);
      a.textContent = "Read more";
      blocks[from].parentNode.insertBefore(a, blocks[from]);
      return;
    }
    var btn = doc.createElement("button");
    btn.type = "button";
    btn.className = "bs-more";
    btn.setAttribute("data-more", "soft");
    btn.textContent = "Expand for more";
    blocks[from].parentNode.insertBefore(btn, blocks[from]);
    btn.addEventListener("click", function () {
      var to = hardAt !== -1 ? hardAt : blocks.length;
      for (var j = from; j < to; j++) blocks[j].hidden = false;
      if (btn.parentNode) btn.parentNode.removeChild(btn);
      /* everything revealed is below the control, so the post grows
         downward and the page does not jump */
      if (hardAt !== -1) blogCutApply(post, blocks, hardAt, "hard", -1);
      if (AMH.site) AMH.site.requestTick();
      blogPlayersLook();
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
    if (soft !== -1) blogCutApply(post, blocks, soft, "soft", hard);
    else if (hard !== -1) blogCutApply(post, blocks, hard, "hard", -1);
    else return false;
    blogPlayersLook();
    return true;
  }
  /* Fold the posts that are not folded yet, and say how many.

     `only` is the posts to consider, and the loader passes the ones it
     appended. Without it this reads the whole page, and on a month page
     blogPosts() answers with that month's own posts: folding those would
     close the posts the reader is reading, to append an older month. */
  function blogCutAll(only) {
    /* A focused post is read whole, past both cut points. Nothing folds
       while that view is on, whichever caller asks. */
    if (doc.body && doc.body.classList.contains("is-focus")) return 0;
    var n = 0;
    (only || blogPosts()).forEach(function (p) { if (blogCutPost(p)) n++; });
    return n;
  }

  /* ---------------- the sticky bar ----------------

     Authored chrome at the top of the column: the name, the slot the
     search pill takes in Phase 3, and the month picker. It sticks under
     the site header once the heading above it scrolls away. */
  /* ---------------- the month picker ----------------

     A combobox the page draws, in the select-only shape of the ARIA
     pattern: a button that names the current month, and a listbox under
     it. It is not a <select>.

     Why not. A native select's open list is drawn by the operating
     system, and CSS reaches none of it but its colour scheme. On a dark
     page that left a light highlight band and a light border in the
     middle of the blog, and nothing in a stylesheet could touch either.
     The page draws the list, so the list matches the page.

     What is given up: a phone opens a native select with its own picker,
     which a thumb handles better than any list a page draws. Two months
     do not need that. Forty would, and then the native control should
     come back for touch screens. */
  var blogMonthBox = null;    /* the element the bar authored */
  var blogMonthBtn = null;    /* the button that names the month */
  var blogMonthList = null;   /* the listbox */
  var blogMonthValue = "";    /* "" for every month */
  var blogMonthAt = -1;       /* the option the keyboard is on */

  var BLOG_CARET =
    '<svg class="bs-picker__caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="m6 9 6 6 6-6" /></svg>';

  function blogMonthOptions() {
    return blogMonthList
      ? Array.prototype.slice.call(blogMonthList.querySelectorAll('[role="option"]'))
      : [];
  }
  function blogMonthLabel(value) {
    var hit = null;
    blogMonthOptions().forEach(function (o) {
      if (o.getAttribute("data-value") === value) hit = o;
    });
    return hit ? hit.textContent : "All months";
  }
  /* The button says what is chosen, and the rail above marks the same
     month. This is the one place the value changes, so marking here is
     what keeps the two controls saying the same thing. */
  function blogMonthSet(value) {
    blogMonthValue = value;
    if (blogMonthBtn) blogMonthBtn.firstChild.nodeValue = blogMonthLabel(value);
    blogMonthOptions().forEach(function (o) {
      o.setAttribute("aria-selected",
        o.getAttribute("data-value") === value ? "true" : "false");
    });
    blogRailMark();
  }
  function blogMonthOpen(open) {
    if (!blogMonthList) return;
    blogMonthList.hidden = !open;
    blogMonthBtn.setAttribute("aria-expanded", open ? "true" : "false");
    if (!open) {
      blogMonthAt = -1;
      blogMonthBtn.removeAttribute("aria-activedescendant");
      return;
    }
    /* opening lands on what is chosen, so the list starts where the
       reader left it rather than at the top */
    var opts = blogMonthOptions();
    opts.forEach(function (o, i) {
      if (o.getAttribute("data-value") === blogMonthValue) blogMonthAt = i;
    });
    blogMonthMark();
  }
  function blogMonthMark() {
    var opts = blogMonthOptions();
    opts.forEach(function (o, i) { o.classList.toggle("is-at", i === blogMonthAt); });
    if (opts[blogMonthAt]) {
      blogMonthBtn.setAttribute("aria-activedescendant", opts[blogMonthAt].id);
      opts[blogMonthAt].scrollIntoView({ block: "nearest" });
    }
  }
  function blogMonthTake(i) {
    var opts = blogMonthOptions();
    if (!opts[i]) return;
    var value = opts[i].getAttribute("data-value");
    blogMonthSet(value);
    blogMonthOpen(false);
    blogMonthBtn.focus();
    blogGoMonth(value);
  }
  /* The keys a select answers, so the control is a select in every way
     but who draws it. */
  function blogMonthKeys(e) {
    var opts = blogMonthOptions();
    var open = blogMonthList && !blogMonthList.hidden;
    if (e.key === "Escape") { if (open) { e.preventDefault(); blogMonthOpen(false); } return; }
    if (e.key === "Tab") { if (open) blogMonthOpen(false); return; }
    if (e.key === "Enter" || e.key === " " || e.key === "Spacebar") {
      e.preventDefault();
      if (!open) blogMonthOpen(true);
      else blogMonthTake(blogMonthAt);
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) { blogMonthOpen(true); return; }
      blogMonthAt = (blogMonthAt + (e.key === "ArrowDown" ? 1 : -1) + opts.length) % opts.length;
      blogMonthMark();
      return;
    }
    if (open && (e.key === "Home" || e.key === "End")) {
      e.preventDefault();
      blogMonthAt = e.key === "Home" ? 0 : opts.length - 1;
      blogMonthMark();
    }
  }

  function blogBarFill() {
    blogMonthBox = doc.getElementById("blogMonth");
    if (!blogMonthBox) return false;
    blogManifest = blogManifest || blogParseManifest();
    /* the count comes from the manifest, not the index, so the picker is
       right the moment the page is, with nothing to wait for */
    var per = {};
    blogManifest.entries.forEach(function (e) { per[e.month] = (per[e.month] || 0) + 1; });
    var rows = [{ value: "", label: "All months" }];
    blogManifest.months.forEach(function (mo) {
      rows.push({ value: mo,
                  label: blogMonthTitle(mo) + (per[mo] ? " (" + per[mo] + ")" : "") });
    });

    blogMonthBox.className = "bs-picker";
    blogMonthBox.innerHTML =
      '<button type="button" class="bs-picker__btn" id="blogMonthBtn" role="combobox" ' +
      'aria-haspopup="listbox" aria-expanded="false" aria-controls="blogMonthList" ' +
      'aria-label="Jump to a month">All months' + BLOG_CARET + "</button>" +
      '<ul class="bs-picker__list" id="blogMonthList" role="listbox" ' +
      'aria-label="Months" hidden></ul>';
    blogMonthBtn = blogMonthBox.querySelector(".bs-picker__btn");
    blogMonthList = blogMonthBox.querySelector(".bs-picker__list");
    rows.forEach(function (r, i) {
      var li = doc.createElement("li");
      li.className = "bs-picker__opt";
      li.id = "bs-pick-" + (r.value || "all");
      li.setAttribute("role", "option");
      li.setAttribute("data-value", r.value);
      li.setAttribute("aria-selected", i === 0 ? "true" : "false");
      li.textContent = r.label;
      li.addEventListener("click", function () { blogMonthTake(i); });
      blogMonthList.appendChild(li);
    });
    blogMonthSet(blogMonthValue);

    blogMonthBtn.addEventListener("click", function () {
      blogMonthOpen(blogMonthList.hidden);
    });
    blogMonthBtn.addEventListener("keydown", blogMonthKeys);
    blogMonthList.addEventListener("keydown", blogMonthKeys);
    /* a click anywhere else closes it, as a native list does */
    doc.addEventListener("click", function (e) {
      if (blogMonthBox && !blogMonthBox.contains(e.target)) blogMonthOpen(false);
    });
    return true;
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
  /* The picker's four cases, in the order they are asked. "All months"
     is the top of the stream. A month already on the page is a scroll. A
     month that is not is fetched over http, and from disk is the month
     file itself, because a page opened from disk cannot fetch. */
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
    /* Ask the page before asking the protocol. The stream always carries
       the newest month, and a chain hop may have brought older ones in,
       so the month is often already here. This test must come first: a
       reader who follows "Read in the full stream" from blog/2609.html
       arrives at blog.html?b=2609, and from disk a protocol test alone
       would send them straight back to the month page they just left. */
    var here = blogFirstOf(yymm);
    if (here) { here.scrollIntoView({ block: "start" }); return; }
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

    if (/^p[0-9a-z]\d{3}$/.test(target)) {
      var id = target.slice(1);
      var entry = null;
      blogManifest.entries.forEach(function (e) { if (e.id === id) entry = e; });
      /* A post has one address, and it is the reading view on its own
         month page. "?b=" is the route the blog used before it had a
         page, so it resolves to that address wherever the post lives.

         replace, not assign: the old address is a hop and must not
         become a stop on the way back. */
      if (entry) { location.replace(blogPostUrl(entry.date, id, "root", true)); return; }
      unknown = true;
    } else if (/^\d{4}$/.test(target)) {
      if (blogManifest.months.indexOf(target) === -1) unknown = true;
      else {
        if (blogMonthBtn) blogMonthSet(target);
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
    /* keep the state and every other parameter: this used to pass null
       and rebuild from the path, which dropped both */
    if (push) AMH.site.setUrl(AMH.site.paramUrl({ b: target || null }), true);
    blogEditButtons();
    if (AMH.tool && AMH.tool.viewChanged) AMH.tool.viewChanged();
    AMH.site.requestTick();
  }

  /* ---------------- one post on its own ----------------

     "?post=pNNNN" on a month page reads that post alone. The month file
     already holds every post whole, so this hides the others; it never
     fetches, renders, or unfolds anything.

     A month page is the only surface with this view. The stream sends a
     reader to the month file, so there is one focused address for each
     post and not two. */

  /* The post the address asks for, or "" for ordinary browsing. */
  function blogWantPost() {
    var m = /[?&]post=p([0-9a-z]\d{3})/.exec(location.search);
    return m ? m[1] : "";
  }
  /* The article that id names, and only when this month holds it. An id
     from another month must not empty the page or start a search. */
  function blogFocusFind(id) {
    var el = id ? doc.getElementById("p" + id) : null;
    return el && el.classList.contains("bs-post") ? el : null;
  }
  /* The heading a focused post reads under: its own title, or its date
     when it has none. An untitled post still needs a name here, because
     this is the page's only h1. */
  function blogFocusName(post) {
    return post.getAttribute("data-title") ||
      blogDateLabel(post.getAttribute("data-date") || "");
  }
  /* Show one post and hide the rest of the month.

     Runs before the folding path, so nothing here has to undo a cut.
     Safe to call twice: it sets state rather than toggling it, and it
     replaces its own controls instead of adding a second one. */
  function blogFocusApply() {
    var id = blogWantPost();
    if (!id) return false;
    var main = doc.querySelector("main");
    if (!main) return false;
    var post = blogFocusFind(id);
    if (!post) { blogFocusMiss(main); return false; }

    doc.body.classList.add("is-focus");
    blogPosts().forEach(function (p) { p.hidden = p !== post; });
    blogPlayersLook();
    /* the ways to the other months belong to the month view: a reader
       here asked for one post, and the rest of the chain answers a
       question they did not ask.

       This reads the document and not main, because the foot is main's
       sibling and not its child. Both names are listed because the
       stream has the bare link and a month page has the whole foot. */
    Array.prototype.forEach.call(doc.querySelectorAll(".bm-older, .bm-chain"),
      function (el) { el.hidden = true; });

    var name = blogFocusName(post);
    var head = doc.querySelector(".bm-top__month");
    if (head) head.textContent = name;
    doc.title = blogFocusTitle(name);
    blogFocusSelf(post);
    blogBackChip();
    return true;
  }
  /* The post's own title and timestamp are links to this view. A link to
     where the reader already is only adds a history entry that goes
     nowhere, so in this view they are not links. */
  function blogFocusSelf(post) {
    var t = post.querySelector(".bs-post__title a");
    if (t) {
      var plain = doc.createElement("span");
      plain.textContent = t.textContent;
      t.parentNode.replaceChild(plain, t);
    }
    var when = post.querySelector("a.bs-post__when");
    if (when) when.removeAttribute("href");
  }
  /* The tab title keeps the site's own shape and swaps the last part,
     so a focused post reads like every other page of the site. */
  function blogFocusTitle(name) {
    var parts = String(doc.title).split(" · ");
    parts[parts.length - 1] = name;
    return parts.join(" · ");
  }
  /* Back, under the bar, where the eye already is after the rail.

     It is offered by any view that narrows what the reader sees: one post,
     or one tag. Both are places a reader arrives at and then wants out of,
     and neither can be left by the browser alone when the address was
     rewritten in place.

     Back is offered only when this site sent the reader here in this tab.
     A pasted address, a new tab, and a duplicated tab get none, because
     Back there would leave the site or do nothing.

     There is no "view the whole month" any more. The rail under the
     heading carries this month as a link, so that destination is said
     once instead of twice, and the rail says where the month sits among
     the others while it does it.

     It is a filled chip, because it is the one thing a reader in this
     view is most likely to want, and the rail above it is outlined. */
  function blogBackChip() {
    var old = doc.querySelector(".bm-back");
    if (old) old.parentNode.removeChild(old);
    var bar = doc.getElementById("blogBar");
    if (!bar) return;
    if (!blogCameFromHere()) return;
    var wrap = doc.createElement("div");
    wrap.className = "bm-back";
    wrap.appendChild(blogBackButton());
    /* under the tag heading when there is one, so the reader gets the
       question before the way out of it. One post has no heading, and
       there Back is the first thing under the bar. */
    var after = doc.querySelector(".bs-results") || bar;
    after.parentNode.insertBefore(wrap, after.nextSibling);
  }
  /* Back, again, at the head of the chain row.

     The rail and the bar are nearly three screens above by the time a
     reader reaches the end of a month, so the way back has to be here as
     well as up there. The publish cannot write it: only the page knows
     whether this site sent the reader, and a pasted address gets no Back
     at the foot for the same reason it gets none under the bar. */
  function blogBackFoot() {
    var row = doc.querySelector(".bm-chain__row");
    if (!row || row.querySelector(".bm-chip--back")) return;
    if (!blogCameFromHere()) return;
    row.insertBefore(blogBackButton(), row.firstChild);
  }
  /* Did this site send the reader here? site.js owns the answer, and a
     page that loads without it offers no Back rather than a broken one. */
  function blogCameFromHere() {
    return !!(AMH.site && AMH.site.cameFromHere && AMH.site.cameFromHere());
  }
  /* The control itself. Both places that offer Back build it here, so the
     look and the behaviour cannot drift apart. */
  function blogBackButton() {
    var b = doc.createElement("button");
    b.type = "button";
    b.className = "bm-chip bm-chip--back";
    b.innerHTML = BLOG_BACK;
    /* the label is a text node after the mark, so textContent stays
       "Back" and the arrow adds nothing a screen reader must read */
    b.appendChild(doc.createTextNode("Back"));
    /* traverse the entry that is already there. Navigating to a copy of
       it would append a second entry and break Forward. */
    b.addEventListener("click", function () { history.back(); });
    return b;
  }
  /* A month file carries a boot style that hides the other posts before
     this script runs, so the whole month never flashes past first. From
     here the hidden property does that work, and a bad id needs the whole
     month back, so the style goes either way. */
  function blogFocusBoot() {
    var s = doc.getElementById("postBoot");
    if (s && s.parentNode) s.parentNode.removeChild(s);
  }
  /* An id this month does not hold. The month stays readable and says so,
     because a blank page tells the reader nothing. */
  function blogFocusMiss(main) {
    if (main.querySelector(".bs-note--nopost")) return;
    var n = doc.createElement("p");
    n.className = "bs-note bs-note--nopost";
    n.textContent = "That post isn't in this month - showing the whole month instead.";
    main.insertBefore(n, main.firstChild);
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
  /* the byline's picture, from the host's site.config.js; "" for none */
  var BLOG_AVATAR = (AMH.config && AMH.config.avatar) || "";
  var blogChainAt = "";      /* the url the last hop came from */
  var blogChainRoot = false; /* the stream, rather than a month page */

  /* THE RAIL'S MONTHS, in the order they are shown: oldest on the left,
     newest on the right.

     A blog runs for years, and a strip that carries every month it ever
     had is a strip nobody reads. The rail is the quick move to recent
     work; the picker in the bar below is the full list, and that is the
     division between the two controls.

     The strip reads left to right and time runs the same way, so the
     newest month ends beside Newest, which is pinned to the right. The
     selection is made newest first, because that is the order `months`
     comes in and the newest few are what the rail keeps; the list is then
     turned around for the reader.

     The month being read joins the selection last when it falls outside
     the newest few. It is older than all of them, so turning the list
     around puts it leftmost, and the strip stays in date order either
     way.

     publish.js calls this through AMH.blog so a month file and the stream
     cap and order the same way. One rule, two surfaces. */
  var BLOG_RAIL_KEEP = 3;

  function blogRailMonths(months, current) {
    var all = (months || []).slice();
    var keep = all.slice(0, BLOG_RAIL_KEEP);
    if (current && keep.indexOf(current) === -1 && all.indexOf(current) !== -1) {
      keep.push(current);
    }
    return keep.reverse();
  }
  /* THE RAIL, on the stream. A month file has its rail written into it by
     the publish; this page draws its own from the entries it holds, so
     the two surfaces carry the same control in the same place.

     Its month chips address month files, because a month is a page. The
     picker below stays the way to every month and to All months, which is
     the one destination the rail has no chip for. */
  function blogRailFill() {
    var slot = doc.getElementById("blogRail");
    if (!slot) return false;
    blogManifest = blogManifest || blogParseManifest();
    var per = {};
    blogManifest.entries.forEach(function (e) { per[e.month] = (per[e.month] || 0) + 1; });
    var show = blogRailMonths(blogManifest.months, blogMonthValue || "");
    if (!show.length) return false;

    slot.className = "bm-rail";
    slot.setAttribute("aria-label", "Months");
    var strip = doc.createElement("ul");
    strip.className = "bm-rail__strip";
    show.forEach(function (mo) {
      var li = doc.createElement("li");
      var a = doc.createElement("a");
      a.className = "bm-chip";
      a.href = "blog/" + mo + ".html";
      a.textContent = blogMonthTitle(mo).replace(/^(\w{3})\w*/, "$1");
      if (per[mo]) {
        var n = doc.createElement("span");
        n.className = "bm-chip__n";
        n.textContent = per[mo];
        a.appendChild(doc.createTextNode(" "));
        a.appendChild(n);
      }
      li.appendChild(a);
      strip.appendChild(li);
    });
    slot.innerHTML = "";
    slot.appendChild(strip);
    slot.appendChild(blogRailPin());
    blogRailMark();
    return true;
  }
  /* Newest, pinned outside the strip. It is a live link on every surface
     and in every state, including the newest month itself, where it moves
     the reader to the newest post rather than doing nothing. A control
     that is sometimes inert has to be read before it can be used. */
  function blogRailPin() {
    var a = doc.createElement("a");
    a.className = "bm-chip bm-chip--newest";
    a.textContent = "Newest";
    var top = blogManifest.entries[blogManifest.entries.length - 1];
    a.href = top ? blogPostUrl(top.date, top.id, "root", false)
                 : "blog/" + blogManifest.months[0] + ".html";
    return a;
  }
  /* Which chip is the reader standing in. On the stream that is the month
     the page is scoped to, which changes as they use the picker, so this
     runs again rather than being set once.

     It reads the slot by id and not the rail by class, so a month page is
     left alone: its mark is written by the publish and is the month the
     file IS, which no picker on it can change. */
  function blogRailMark() {
    var slot = doc.getElementById("blogRail");
    if (!slot) return;
    Array.prototype.forEach.call(slot.querySelectorAll(".bm-rail__strip a"),
      function (a) {
        var mine = a.getAttribute("href") === "blog/" + blogMonthValue + ".html";
        a.classList.toggle("is-now", !!blogMonthValue && mine);
        if (!!blogMonthValue && mine) a.setAttribute("aria-current", "page");
        else a.removeAttribute("aria-current");
      });
  }

  /* Returns true when this page is a month page, which is the surface
     that has nothing else to do. blog.html gets the chain too and
     answers its deep link as well, so it returns false there. */
  function blogChainAttach() {
    var onMonth = !!(doc.body && doc.body.classList.contains("blog-month"));
    var stream = doc.getElementById("blogStream");
    if (!onMonth && !stream) return false;
    blogChainRoot = !onMonth;
    blogChainAt = location.href;
    /* The chain appends into the stream only. On a month page the link is
       left alone and navigates, because the rail there already carries
       every month: appending was a second way to move that had to be kept
       in step with the first, and when it was not, the address named one
       month while the heading and the rail named another. */
    if (!onMonth) {
      var link = stream.querySelector(".bm-older[href]");
      if (link) link.addEventListener("click", blogChainClick);
    }
    if (onMonth) {
      /* the address is answered first, so the reader sees one post
         rather than the whole month for a frame and then one post */
      var focused = blogFocusApply();
      blogFocusBoot();
      /* a month page has the same bar and the same pill. It has no stream,
         so its posts are under main, and work.js built their carousels. */
      blogBarFill();
      findAttach();
      /* the focused view hides the foot, so Back there would go into a
         place the reader cannot reach. That view has its own, under the
         bar, put there by blogFocusApply. */
      if (!focused) blogBackFoot();
    }
    return onMonth;
  }
  /* The stream's own way back through the chain, for the month that comes
     after the one just appended.

     It is the same chip every other way through the blog is, so the
     column reads as one set of controls. What it does is still different:
     the month arrives below rather than replacing the page, and the down
     arrow is what says so.

     publish.js writes the same chip into a stream that has never been
     appended to, so the two must be changed together. */
  function blogChainLink(yymm) {
    var a = doc.createElement("a");
    a.className = "bm-older";
    a.setAttribute("href", "blog/" + yymm + ".html");
    a.setAttribute("rel", "prev");
    a.innerHTML = BLOG_DOWN;
    a.appendChild(doc.createTextNode("Older posts: " + blogMonthTitle(yymm)));
    a.addEventListener("click", blogChainClick);
    return a;
  }
  /* Where the appended posts go: the stream on blog.html, the main
     element on a month page. */
  function blogChainInto() {
    return blogChainRoot ? doc.getElementById("blogStream") : doc.querySelector("main");
  }
  /* A path written for a page in blog/, read from the root. Only the one
     step up comes off, and only from the front: of src and href, of each
     candidate in a srcset, and of the paths the image engine writes into
     data attributes, which the carousel and the viewer read. */
  var BLOG_PATH_ATTRS = ["src", "href", "data-sd", "data-original", "data-hd"];
  function blogChainPaths(root) {
    var found = root.querySelectorAll("[src],[href],[srcset],[data-sd],[data-original],[data-hd]");
    Array.prototype.forEach.call(found, function (el) {
      BLOG_PATH_ATTRS.forEach(function (at) {
        var v = el.getAttribute(at);
        if (v && v.slice(0, 3) === "../") el.setAttribute(at, v.slice(3));
      });
      var set = el.getAttribute("srcset");
      if (set) el.setAttribute("srcset", set.replace(/(^|,\s*)\.\.\//g, "$1"));
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
      if (when && id && date) when.setAttribute("href", blogPostUrl(date, id, "root", true));
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
    by.innerHTML = (BLOG_AVATAR ? '<img class="bs-post__avatar" src="' +
      (AMH.site.prefix() + BLOG_AVATAR).replace(/"/g, "&quot;") + '" alt="" />' : "") +
      "<b></b>" +
      '<a class="bs-post__when" href="' + blogPostUrl(date, id, "root", true) + '">' +
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
        var added = [];
        Array.prototype.slice.call(main.children).forEach(function (node) {
          var el = doc.adoptNode(node);
          var out = blogChainRoot && el.tagName === "ARTICLE"
            ? blogChainPost(el, brand) : el;
          here.appendChild(out);
          if (out.classList && out.classList.contains("bs-post")) added.push(out);
        });
        /* The fetched page says where the chain goes next. Its own link
           is read for that and not adopted: it is a month page's chip,
           worded and marked for a reader who is standing on the month,
           and this surface writes its own. Adopting it left the stream
           carrying two shapes of the same control.

           A month with no older link is the first month, and the stream
           says so in the words the publish writes into a stream that
           needs no chain at all. */
        var older = d.querySelector(".bm-older[href]");
        var next = older && /(\d{4})\.html/.exec(older.getAttribute("href") || "");
        if (next) {
          link.parentNode.replaceChild(blogChainLink(next[1]), link);
        } else {
          var end = doc.createElement("p");
          end.className = "bm-older bm-older--end";
          end.textContent = "This is the first month.";
          link.parentNode.replaceChild(end, link);
        }
        blogChainAt = url.href;
        divider.focus();
        /* On a month page the address follows the month reached: replace,
           not push, so a refresh lands there and Back leaves the chain in
           one step. In the stream the address stays blog.html, because the
           page is still the stream and a refresh should return to its top. */
        if (!blogChainRoot) {
          /* the address still follows the month reached, as above. Only
             the state changes hands: null threw the visit away. */
          AMH.site.setUrl(href, false);
          if (d.title) doc.title = d.title;
        }
        /* the month's carousels arrived as plain lists of images */
        if (AMH.work) AMH.work.buildGalleries();
        blogEditButtons();
        blogCutAll(added);
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
     browser can search: one statement, `window.AMH_SEARCH = { ... }`,
     holding the table as readable JSON. The publish writes it; this
     reads it.

     It is a classic script and not a JSON file for one reason: a fetch
     is refused from disk and a script tag is not, and reading this site
     from disk has to work. Nothing here runs until something asks, so a
     reader who never searches never loads it.

     The table was base64 of gzip until V057. The change was not made
     for size: the server's own compression leaves about four percent
     between the two forms. It was made because a file that is one long
     opaque string is the shape a virus scanner reads as a packed
     payload, and Windows called search.js a dangerous file.

     One unpacker. publish.js reads the deployed file through
     AMH.search.unpack, so the writer and the reader can never disagree
     about the format.
     ========================================================== */
  var SEARCH_EMPTY = { v: 1, stamp: "", posts: [] };
  /* An index this build cannot read. It is empty like the one above, and
     it says why, so the pill can tell the reader instead of showing
     nothing. See the carry-over note in searchUnpack. */
  var SEARCH_STALE = { v: 1, stamp: "", posts: [], stale: true };
  var searchLoading = null;   /* the one load, cached as its promise */

  /* Takes the table itself or the text of the file that holds it. The
     loader has the object the script tag assigned; a publish has the
     bytes it read back from the deployed site. */
  function searchUnpack(source) {
    if (source && typeof source === "object") return Promise.resolve(source);
    var text = String(source || "");
    if (!text) return Promise.resolve(SEARCH_EMPTY);
    var open = text.indexOf("{");
    var close = text.lastIndexOf("}");
    /* CARRY-OVER: an index written before V057 is base64 of gzip, which
       holds no object at all. One publish replaces the file and this
       branch stops being reachable; remove it then. */
    if (open === -1 || close < open) return Promise.resolve(SEARCH_STALE);
    try {
      return Promise.resolve(JSON.parse(text.slice(open, close + 1)));
    } catch (err) {
      return Promise.reject(err);
    }
  }

  /* The table, loaded once. The script tag is created on the first ask
     and never again; a missing file resolves empty, because a site
     published before the index existed has none and "no posts indexed
     yet" is a better answer than a failure. */
  function searchLoad() {
    if (searchLoading) return searchLoading;
    searchLoading = new Promise(function (resolve, reject) {
      if (window.AMH_SEARCH) { resolve(window.AMH_SEARCH); return; }
      var el = doc.createElement("script");
      el.src = AMH.site.prefix() + "search.js";
      el.onload = function () { resolve(window.AMH_SEARCH || ""); };
      el.onerror = function () {
        console.info("[blog] no search.js on this site yet.");
        resolve("");
      };
      doc.head.appendChild(el);
    }).then(function (assigned) {
      return assigned ? searchUnpack(assigned) : SEARCH_EMPTY;
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
       "dome projection"  those words in that order, and in that case.
       #xr                the tag, not the word.

     Case: a plain word ignores it, so omg finds OMG. A quoted phrase
     keeps it, so "OMG" finds OMG and not omg. Quotes are the way to ask
     for exactly what you typed.

     A query is split on commas into groups; a post matches when any
     group matches, and a group matches when every term in it matches.
     An unclosed quote runs to the end of its group, because a person
     halfway through typing one should still see results.

     A test fixture holds the cases and their parsed form, and the
     parser is done when every line of it matches. */
  function searchParse(q) {
    var groups = [];
    String(q || "").split(",").forEach(function (part) {
      var terms = [];
      var re = /"([^"]*)(?:"|$)|(\S+)/g;
      var m;
      while ((m = re.exec(part))) {
        if (re.lastIndex === m.index) re.lastIndex++;   /* never spin on an empty match */
        if (m[1] !== undefined) {
          /* kept as typed: a quoted phrase is the exact-match form */
          var phrase = m[1].trim();
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
     the prose, where a phrase can occur; a word with everything.

     The prose is held twice, once lowered and once as written, because a
     quoted phrase is compared as typed and every other term is not. */
  function searchFields(post) {
    var prose = [post.title || "", post.text || "", (post.caps || []).join(" ")].join(" ");
    return {
      tags: String(post.tags || "").toLowerCase().split(/\s+/).filter(Boolean),
      prose: prose.toLowerCase(),
      proseAsWritten: prose,
      all: [prose, post.tags || ""].join(" ").toLowerCase()
    };
  }
  function searchMatch(post, groups) {
    var f = searchFields(post);
    return groups.some(function (terms) {
      return terms.every(function (t) {
        if (t.kind === "tag") return f.tags.indexOf(t.value) !== -1;
        if (t.kind === "phrase") return f.proseAsWritten.indexOf(t.value) !== -1;
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
      terms.forEach(function (t) {
        /* a phrase was matched as typed, so it is found the same way here:
           looking for it in lowered text would highlight what did not match */
        if (t.kind !== "tag") want.push({ value: t.value, exact: t.kind === "phrase" });
      });
    });
    var sources = [post.text || ""].concat(post.caps || []);
    for (var i = 0; i < sources.length; i++) {
      var lowered = sources[i].toLowerCase();
      for (var j = 0; j < want.length; j++) {
        var at = want[j].exact
          ? sources[i].indexOf(want[j].value)
          : lowered.indexOf(want[j].value);
        if (at !== -1) return searchCut(sources[i], at, want[j].value.length);
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
      '<span class="ced-sr">Search the blog</span>' +
      '<input type="search" spellcheck="false" role="combobox" aria-expanded="false" ' +
      'aria-controls="blogFindList" aria-autocomplete="list" ' +
      'placeholder="Search posts, tags, captions" /></label>' +
      '<div class="bs-find__list" id="blogFindList" role="listbox" ' +
      'aria-label="Search results" hidden></div>';
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
        /* the two ways to have no posts are not the same problem, and a
           reader who can act on one should not be told the other */
        findInput.placeholder = table.stale
          ? "Search index needs one more publish"
          : "No posts indexed yet";
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
    findInput.setAttribute("aria-expanded", "true");
    findInput.removeAttribute("aria-activedescendant");
  }
  /* Where a post lives, from whichever surface is asking. */
  function findHref(post) {
    return blogPostUrl(post.date, post.id, blogSurface(), true);
  }
  function findHit(post, groups) {
    var a = doc.createElement("a");
    a.className = "bs-find__hit";
    a.setAttribute("role", "option");
    a.setAttribute("aria-selected", "false");
    /* aria-activedescendant on the input points at one of these by id, so
       each option needs one that is unique on the page */
    a.id = "bs-hit-" + post.id;
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
    return a;
  }
  /* A hit is the link it is, and nothing here answers the click.

     It used to scroll instead when the post was already on the page,
     which gave one post two destinations and, in the focused view,
     scrolled to a post that was hidden. Every hit now opens the post's
     own reading view, whether or not this page happens to carry it. */
  function findClose() {
    if (!findList) return;
    findList.hidden = true;
    findAt = -1;
    if (findInput) {
      findInput.setAttribute("aria-expanded", "false");
      findInput.removeAttribute("aria-activedescendant");
    }
  }
  function findKeys(e) {
    if (e.key === "Escape") { findClose(); return; }
    if (findList.hidden || !findHits.length) return;
    var items = Array.prototype.slice.call(findList.querySelectorAll(".bs-find__hit"));
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      findAt = (findAt + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
      items.forEach(function (el, i) {
        var at = i === findAt;
        el.classList.toggle("is-at", at);
        el.setAttribute("aria-selected", at ? "true" : "false");
      });
      items[findAt].scrollIntoView({ block: "nearest" });
      findInput.setAttribute("aria-activedescendant", items[findAt].id);
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
    blogPlayersLook();
    blogTagLine(tag, shown);
    blogTagRest(tag);
    /* the address carries the filter, so a copied link shows what the
       person is looking at */
    AMH.site.setUrl(AMH.site.paramUrl({ t: tag || null }), false);
    if (AMH.site) AMH.site.requestTick();
  }
  /* THE HEADING OF A TAG VIEW: the question the reader asked, above the
     answer, in the words they asked it in.

     It is a heading and not another status line, because it names what is
     on screen and the page has no other name for this state. It goes
     directly under the bar, and Back goes under it, so the column reads
     question, way out, then the size of the answer.

     It takes a list, so several tags read as one question: "Results for
     #one, #two". The address carries one tag today. */
  function blogTagHead(tags) {
    var head = doc.querySelector(".bs-results");
    if (!tags.length) {
      if (head && head.parentNode) head.parentNode.removeChild(head);
      return;
    }
    var bar = doc.getElementById("blogBar");
    if (!bar) return;
    if (!head) {
      head = doc.createElement("h2");
      head.className = "bs-results";
      bar.parentNode.insertBefore(head, bar.nextSibling);
    }
    head.innerHTML = "";
    var what = doc.createElement("b");
    what.textContent = tags.map(function (t) { return "#" + t; }).join(", ");
    head.appendChild(doc.createTextNode("Results for "));
    head.appendChild(what);
  }
  /* The line under the heading: how much of the answer is on this page,
     and the way to put the whole blog back. */
  function blogTagLine(tag, shown) {
    blogTagHead(tag ? [tag] : []);
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
      /* last of the three, so the order never depends on which of them
         was drawn first */
      var after = doc.querySelector(".bm-back") ||
                  doc.querySelector(".bs-results") || bar;
      after.parentNode.insertBefore(tagLine, after.nextSibling);
    }
    tagLine.innerHTML = "";
    tagLine.appendChild(doc.createTextNode(
      shown + (shown === 1 ? " post here · " : " posts here · ")));
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
    /* One viewer for a post: a photo opens the viewer on every photo of
       its post, from its first carousel to its last, a photo on its own
       included, and never on a player. */
    if (AMH.work && AMH.work.viewerScope) {
      AMH.work.viewerScope(function (gallery) { return gallery.closest(".bs-post"); });
    }
    blogTagClicks();
    var t = /[?&]t=([^&]*)/.exec(location.search);
    if (onMonth) {
      if (t) { blogFilterTag(decodeURIComponent(t[1])); blogBackChip(); }
      return;
    }
    blogRailFill();
    blogBarFill();
    findAttach();
    blogCutAll();
    /* a tag view narrows what the reader sees, so it gets the same way
       out as one post does */
    if (t) { blogFilterTag(decodeURIComponent(t[1])); blogBackChip(); return; }
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
       renderBody(src, date, prefix, images) -> HTML for one post body,
                                  each run of tags a carousel, and each
                                  nocarousel tag a block of its own
       TAG                        the tag's pattern, as a regular
                                  expression's source; see section 3
       OPTIONS / KINDS            the option words, and each kind's word
       readTag(match)             one match of TAG, by name
       tagsOf(source)             every tag in a text, read
       runsOf(source)             the runs of tags, each tag read
       stretchesOf(tags)          a run's carousels: the run cut at each
                                  tag that says nocarousel
       options(text)              an options string, by name
       optionsText(options)       the same, written the one way a tag is
       tagIssues(source, map)     { problems, notices } about a body's tags
       ID                         an id's pattern, [0-9a-z]\d{3}
       idOf(n) / idNum(id)        the id of the n-th post or image, and
                                  the number an id stands for
       counterNum(text) / counterText(n) -> the image counter, read and
                                  written; "exhausted" once z999 is taken
       nearTags(source)           the pieces of a body that are almost a
                                  tag and are not one
       encodeSource(s) / decodeSource(s) -> the escaped form stored in a
                                   month file's x-blog-source tag
       monthTitle(yymm) / dateLabel(yymmdd) / dateTime(yymmdd) -> display
       postUrl(date, id, from, focus) -> where a post lives. `from` is
                                  "root" or "month", and `focus` asks for
                                  the address that reads it alone. Every
                                  post URL the site writes comes from here.
       railMonths(months, current) -> the months the rail shows: the
                                  newest few, plus the month being read
                                  when it falls outside them. publish.js
                                  calls it so a month file and the stream
                                  cap the same way.
       focusApply()               -> read "?post=pNNNN" and show that post
                                  alone. Month pages only, and true when a
                                  post was selected. Safe to call twice.
       show(target, push)         -> answer a deep link
       editButtons()              -> add the Edit button to the posts,
                                  and the two New post pills
       cut(only)                  -> fold the posts that are not folded
                                  yet, and say how many. `only` limits it
                                  to a list, which the loader uses for the
                                  posts it appended.
       fold(post)                 -> fold one post where the stream would,
                                  whatever view the page is in, and say
                                  whether it folded. The composer's preview
                                  uses it, in the page and in its phone.

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
    TAG: BLOG_TAG,
    OPTIONS: BLOG_OPTIONS,
    KINDS: BLOG_KINDS,
    readTag: blogTagRead,
    tagsOf: blogTagsOf,
    runsOf: blogRunsOf,
    stretchesOf: blogStretches,
    options: blogTagOptions,
    optionsText: blogOptionsText,
    tagIssues: blogTagIssues,
    ID: BLOG_ID,
    idOf: blogIdOf,
    idNum: blogIdNum,
    ID_COUNT: BLOG_ID_COUNT,
    counterNum: blogCounterNum,
    counterText: blogCounterText,
    nearTags: blogNearTags,
    encodeSource: blogEncodeSource,
    decodeSource: blogDecodeSource,
    monthTitle: blogMonthTitle,
    dateLabel: blogDateLabel,
    dateTime: blogDateTime,
    postUrl: blogPostUrl,
    /* the rail's month rule, so a month file caps its strip the same way
       this page does. publish.js is the only other caller. */
    railMonths: blogRailMonths,
    focusApply: blogFocusApply,
    show: blogShow,
    editButtons: blogEditButtons,
    cut: blogCutAll,
    fold: blogCutPost,
    filterTag: blogFilterTag
  };
  AMH.search = { load: searchLoad, tags: searchTags, unpack: searchUnpack,
                 parse: searchParse, match: searchMatch, passage: searchPassage };
})();
