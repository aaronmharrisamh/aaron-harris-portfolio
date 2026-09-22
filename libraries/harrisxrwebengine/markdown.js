/* ============================================================
   markdown.js - the Markdown renderer.

   Turns a post's Markdown into HTML in the browser, for the composer's
   preview and for the publish. There is no package manager and no build,
   so the renderer is our own, and it is small on purpose: Notepad's set
   of Markdown, plus tables, quotes and code, plus the two cut flags. The
   set is the contract. tools/e2e/fixtures/markdown.txt holds one case for
   each feature and each edge, and the renderer is done when every case
   renders byte for byte. A feature outside the set is text.

   Two rules keep it honest. Anything not in the set is text. Raw HTML
   passes through untouched, which is the escape hatch for the one thing
   Markdown cannot say; the tag check before a publish still balances it.

   Tags, [img0001,Caption|Alt] and [nocarousel video0012,Caption], are
   not Markdown. A run of them is one block, passed on as it is, and
   AMH.blog.renderBody turns the run into a carousel, so the two never
   diverge: render(source, {date}) runs that expansion when a date is
   given and leaves the tags in place when it is not. Two runs with a
   blank line between them keep that blank line, because it is what makes
   them two carousels. Inside code a tag is code: its bracket is escaped,
   so the tag renderer cannot see it.

   Loaded by blog.html, before tool.js and publish.js, and by the home
   page for its deep dives. It reads no page and touches no DOM. It reads
   the tag's grammar from imagesengine.js, which loads before it.
   Publishes AMH.markdown.

   Sections:
     1. SETUP                    5. THE BLOCK SCANNER
     2. PATTERNS                 6. PLAIN TEXT
     3. INLINE                   7. EXPORTS
     4. BLOCKS WITH STATE
   ============================================================ */
(function () {
  "use strict";
  /* ==========================================================
     1. SETUP
     ========================================================== */
  var AMH = window.AMH = window.AMH || {};
  /* A tag is read with the image engine's grammar, so this file stops when
     imagesengine.js is missing, rather than read tags by a rule of its own. */
  if (!AMH.images || !AMH.images.tag) {
    console.warn("[markdown] markdown.js needs imagesengine.js, which did not load before it.");
    return;
  }

  /* ==========================================================
     2. PATTERNS
     ----------------------------------------------------------
     One pattern for each line shape the scanner knows. A line that
     matches none of them is part of a paragraph.
     ========================================================== */
  /* THE FLAGS, NAMED ONCE.

     A flag is a line that is nothing but a brace word. The renderer is what
     decides which words count, so the words live here and every other file
     reads them. The composer's toolbar writes them and its help panel lists
     them, and a panel written from a second list is a promise that breaks
     the first time a flag is added.

     Each flag carries what every reader of this list needs:

     label: what a button for it is called, for a reader who hears the
     toolbar rather than sees it. The name is the word that goes in the
     text, and nobody says "expandformore" out loud.

     for: which writing surfaces offer this flag on their toolbar. A flag
     the renderer knows is not a flag every surface has a use for: a post is
     read in a stream that folds, and nothing else on the site is. A flag
     another surface owns is still a flag here, and {!name} writes one as
     text, which is the escape every command has.

     kind: a CUT hides what follows it until a reader asks, and a MARK places
     something where it is written. The renderer leaves a different sign for
     each, and the surface reading them decides what to do there.

     cut: which of the two the stream makes, for a flag whose kind is cut.
     blog.js reads it off the marker this renderer leaves behind. */
  var FLAGS = [
    { name: "expandformore", label: "Expand", kind: "cut", cut: "soft", for: ["post"],
      does: "The stream folds here and offers Expand." },
    { name: "pagebreak", label: "Break", kind: "cut", cut: "hard", for: ["post"],
      does: "The stream stops here and offers Read more, which opens the post's own page." },
    { name: "gallery", label: "Photographs", kind: "mark", for: ["deepdive"],
      does: "Puts this project's photographs here, as one carousel." },
    { name: "note", label: "Note", kind: "mark", for: ["deepdive"],
      does: "Makes the paragraph it is on the closing note." }
  ];
  /* A flag ANYWHERE on a line, not only alone on one. RE.flag still holds
     the line-anchored form, because a flag on its own line is its own block
     and is read before a paragraph is gathered. This one finds the rest. */
  var FLAG_NAMES = FLAGS.map(function (f) { return f.name; }).join("|");
  var FLAG_ANY = new RegExp("\\{(" + FLAG_NAMES + ")\\}", "g");
  /* THE TAG'S WORDS: the options a tag can open with, each kind's word,
     and the number. They are the image engine's, in AMH.images.tag, the
     one place a tag's grammar is written. */
  var TAG = AMH.images.tag;
  var TAG_OPTIONS = TAG.OPTIONS;
  var TAG_KIND = TAG.KIND;
  /* THE ESCAPES. {!name} writes a flag as text, and [!img0001] and
     [!nocarousel video0012] write a tag as text. The mark answers only
     for a command the renderer knows, so {!hello} is not an escape and
     stays exactly as typed. */
  var ESC_FLAG = new RegExp("\\{!(" + FLAG_NAMES + ")\\}", "g");
  var ESC_TAG = new RegExp("\\[!((?:" + TAG_OPTIONS + ") )?(" + TAG_KIND + ")(" + TAG.ID + ")", "g");
  /* Taken off LAST, once nothing is looking for a command any more. Undo it
     earlier and the thing the mark was protecting would be obeyed. */
  function unmark(s) {
    return String(s).replace(ESC_FLAG, "{$1}").replace(ESC_TAG, "[$1$2$3");
  }
  function flagOf(name) {
    for (var i = 0; i < FLAGS.length; i++) if (FLAGS[i].name === name) return FLAGS[i];
    return null;
  }

  var RE = {
    heading: /^(#{1,3}) +(.+)$/,
    rule: /^---\s*$/,
    quote: /^> ?(.*)$/,
    fence: /^```/,
    bullet: /^( *)[-*] +(.*)$/,
    number: /^( *)\d+\. +(.*)$/,
    pipe: /^\s*\|.*\|\s*$/,
    delim: /^\s*\|(\s*:?-+:?\s*\|)+\s*$/,
    /* a line that is nothing but tags */
    tagRun: new RegExp("^(?:\\s*\\[(?:(?:" + TAG_OPTIONS + ") )?(?:" + TAG_KIND + ")" + TAG.ID +
      "(?:,[^\\]|]*)?(?:\\|[^\\]]*)?\\])+\\s*$"),
    flag: new RegExp("^\\{(" + FLAGS.map(function (f) { return f.name; }).join("|") + ")\\}\\s*$"),
    html: /^<[a-zA-Z\/!]/,
    blank: /^\s*$/
  };
  /* One tag, with its groups: the options, the kind's word, the number,
     the caption, the alt. The image engine builds it, and blog.js reads
     tags with the same pattern. */
  var TAG_G = TAG.pattern("g");
  /* a link: text, then a url that may hold one level of parentheses,
     which is what a javascript: url in the fixture needs to be caught whole */
  var LINK_G = /\[([^\]\n]+)\]\(((?:[^()\s]|\([^()\s]*\))+)\)/g;
  var CODE_G = /`([^`\n]+)`/g;

  /* ==========================================================
     3. INLINE
     ----------------------------------------------------------
     The marks inside a line: code first, because nothing inside code is
     a mark; then links; then bold, italic and strikethrough. Raw tags
     are left as they are.
     ========================================================== */
  function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  /* code also hides the bracket, so an image tag in code stays code
     when the tag renderer runs over the whole body later */
  function escCode(s) { return esc(s).replace(/\[/g, "&#91;"); }
  function escAttr(s) { return esc(s).replace(/"/g, "&quot;"); }

  function link(_, text, url) {
    var u = url.trim();
    /* a javascript: url is dropped to its text; there is no reason for one
       in a post, and no reason to let one through by accident */
    if (/^javascript:/i.test(u)) return text;
    var scheme = /^[a-z][a-z0-9+.-]*:/i.test(u);
    return '<a href="' + escAttr(u) + '"' + (scheme ? ' rel="noopener"' : "") + ">" + text + "</a>";
  }
  /* Split one paragraph at every flag it carries. The words BEFORE a flag
     stay visible and the words after it are what the cut hides, because the
     flag is written where the cut is wanted.

     A flag inside a code span is text. The spans are put aside first, so a
     post can show a flag in backticks without obeying it. */
  /* Put one flag's marker into the block list.

     A rule of the surface, not a rule of Markdown: this writes where the
     flag stood, and whoever reads the marker decides what happens there.
     block is true for a flag alone on its line. */
  function pushFlag(out, name, block) {
    var f = flagOf(name);
    if (!f) return;
    if (f.kind !== "mark") {
      /* a cut with nothing above it would hide the whole post and leave a
         control over nothing, so one before the first block is dropped */
      if (!out.length) return;
      out.push('<span class="bp-cut" data-cut="' + (f.cut || "soft") + '"></span>');
      return;
    }
    /* A mark puts something where it is written rather than hiding what
       follows, so one before the first block is kept: a deep dive whose
       photographs come first is written that way.

       A flag alone on its line is a block of its own; one written in a
       sentence is a point inside the text. The surface that resolves them
       needs to tell those apart. */
    out.push(block
      ? '<div class="md-mark" data-mark="' + name + '"></div>'
      : '<span class="md-mark" data-mark="' + name + '"></span>');
  }
  function flagSplit(text) {
    var codes = [];
    var masked = String(text).replace(CODE_G, function (m) {
      codes.push(m);
      return "\u0000" + (codes.length - 1) + "\u0000";
    });
    function back(s) {
      return s.replace(/\u0000(\d+)\u0000/g, function (_, n) { return codes[n]; });
    }
    var out = [], last = 0, m2;
    FLAG_ANY.lastIndex = 0;
    while ((m2 = FLAG_ANY.exec(masked))) {
      out.push({ text: back(masked.slice(last, m2.index)) });
      out.push({ flag: m2[1] });
      last = m2.index + m2[0].length;
    }
    out.push({ text: back(masked.slice(last)) });
    return out;
  }

  function inline(text) {
    var codes = [];
    var out = text.replace(CODE_G, function (_, c) {
      codes.push("<code>" + escCode(c) + "</code>");
      return "\u0000" + (codes.length - 1) + "\u0000";
    });
    out = out.replace(LINK_G, link);
    out = out.replace(/\*\*(\S(?:[^*]*?\S)?)\*\*/g, "<strong>$1</strong>");
    out = out.replace(/~~(\S(?:[^~]*?\S)?)~~/g, "<s>$1</s>");
    out = out.replace(/\*(\S(?:[^*\n]*?\S)?)\*/g, "<em>$1</em>");
    /* an underscore inside a word is text: snake_case stays as typed */
    out = out.replace(/(^|[^\w])_(\S(?:[^_\n]*?\S)?)_(?=[^\w]|$)/g, "$1<em>$2</em>");
    return out.replace(/\u0000(\d+)\u0000/g, function (_, n) { return codes[n]; });
  }

  /* ==========================================================
     4. BLOCKS WITH STATE
     ----------------------------------------------------------
     The three blocks that run over several lines and have to remember
     where they are: a fence, a list, a table. Each takes the lines and
     a start index, and returns the HTML and the index after the block.
     ========================================================== */
  function fenceAt(lines, i) {
    var body = [];
    var j = i + 1;
    while (j < lines.length && !RE.fence.test(lines[j])) { body.push(lines[j]); j++; }
    /* an unclosed fence runs to the end: the person is still typing it */
    return { html: "<pre><code>" + escCode(body.join("\n")) + "</code></pre>",
             next: j < lines.length ? j + 1 : j };
  }

  /* One level of nesting, by two spaces. The kind of a list is the kind
     of its first line; a child list takes the kind of its first child. */
  function listAt(lines, i) {
    var items = [];
    var kind = RE.bullet.test(lines[i]) ? "ul" : "ol";
    var j = i, m;
    while (j < lines.length && (m = RE.bullet.exec(lines[j]) || RE.number.exec(lines[j]))) {
      var child = m[1].length >= 2 && items.length;
      if (child) {
        var it = items[items.length - 1];
        if (!it.kind) it.kind = RE.bullet.test(lines[j]) ? "ul" : "ol";
        it.kids.push(m[2]);
      } else {
        items.push({ text: m[2], kids: [], kind: null });
      }
      j++;
    }
    var html = "<" + kind + ">\n" + items.map(function (it) {
      var s = "<li>" + inline(it.text);
      if (it.kids.length) {
        s += "\n<" + it.kind + ">\n" + it.kids.map(function (k) { return "<li>" + inline(k) + "</li>"; })
          .join("\n") + "\n</" + it.kind + ">\n";
      }
      return s + "</li>";
    }).join("\n") + "\n</" + kind + ">";
    return { html: html, next: j };
  }

  function isTable(lines, i) {
    return RE.pipe.test(lines[i]) && i + 1 < lines.length && RE.delim.test(lines[i + 1]);
  }
  function cells(row) {
    return row.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|")
      .map(function (c) { return c.trim(); });
  }
  /* The header row sets the width. A short row is padded with empty
     cells and a long row is cut, so the table is always rectangular. */
  function tableAt(lines, i) {
    var head = cells(lines[i]);
    var aligns = cells(lines[i + 1]).map(function (d) {
      var l = d.charAt(0) === ":", r = d.slice(-1) === ":";
      return l && r ? "center" : r ? "right" : l ? "left" : "";
    });
    function style(k) { return aligns[k] ? ' style="text-align:' + aligns[k] + '"' : ""; }
    var rows = [];
    var j = i + 2;
    while (j < lines.length && RE.pipe.test(lines[j])) { rows.push(cells(lines[j])); j++; }
    var html = "<table>\n<thead>\n<tr>" + head.map(function (c, k) {
      return "<th" + style(k) + ">" + inline(c) + "</th>";
    }).join("") + "</tr>\n</thead>\n<tbody>\n" + rows.map(function (r) {
      return "<tr>" + head.map(function (_, k) {
        return "<td" + style(k) + ">" + inline(r[k] || "") + "</td>";
      }).join("") + "</tr>";
    }).join("\n") + (rows.length ? "\n" : "") + "</tbody>\n</table>";
    return { html: html, next: j };
  }

  /* ==========================================================
     5. THE BLOCK SCANNER
     ----------------------------------------------------------
     One pass over the lines. Each line is tried against the block shapes
     in a fixed order, and what matches nothing is a paragraph until a
     blank line or the start of another block. Blocks are joined by one
     newline, so the output is stable enough to compare byte for byte.
     ========================================================== */
  function startsBlock(lines, i) {
    var l = lines[i];
    return RE.fence.test(l) || RE.heading.test(l) || RE.rule.test(l) || RE.flag.test(l) ||
      RE.quote.test(l) || RE.bullet.test(l) || RE.number.test(l) || isTable(lines, i) ||
      RE.tagRun.test(l) || RE.html.test(l);
  }
  /* render(source, opts) -> HTML
       opts.date    the post date; with it, each run of tags becomes a
                    carousel through AMH.blog.renderBody, as an HTML post's
                    does
       opts.prefix  what renderBody makes a path relative to: "" for the
                    stream and the preview; a month page's "../" when it
                    is not given
       opts.images  the site's { num: entry }, which renderBody draws from

     A caller that draws a post's tags passes these, and never calls
     renderBody on what comes back: the escapes are off by then, so an
     escaped tag would be drawn after all. */
  function render(source, opts) {
    var lines = String(source).replace(/\r\n?/g, "\n").split("\n");
    var out = [];
    var i = 0, m, r;
    var lastRun = -2;    /* where the last run of image tags went in out */
    while (i < lines.length) {
      var line = lines[i];
      if (RE.blank.test(line)) { i++; continue; }
      if (RE.fence.test(line)) { r = fenceAt(lines, i); out.push(r.html); i = r.next; continue; }
      if ((m = RE.heading.exec(line))) {
        /* the post's own title is the article's h2, so a heading in the
           body starts one level down */
        var level = m[1].length + 1;
        out.push("<h" + level + ">" + inline(m[2].trim()) + "</h" + level + ">");
        i++; continue;
      }
      if (RE.rule.test(line)) { out.push("<hr>"); i++; continue; }
      if ((m = RE.flag.exec(line))) {
        pushFlag(out, m[1], true);
        i++; continue;
      }
      if (RE.quote.test(line)) {
        var q = [];
        while (i < lines.length && (m = RE.quote.exec(lines[i]))) { q.push(m[1]); i++; }
        out.push("<blockquote><p>" + inline(q.join("\n")) + "</p></blockquote>");
        continue;
      }
      if (RE.bullet.test(line) || RE.number.test(line)) {
        r = listAt(lines, i); out.push(r.html); i = r.next; continue;
      }
      if (isTable(lines, i)) { r = tableAt(lines, i); out.push(r.html); i = r.next; continue; }
      if (RE.tagRun.test(line)) {
        var run = [];
        while (i < lines.length && RE.tagRun.test(lines[i])) { run.push(lines[i].trim()); i++; }
        /* two runs that a blank line kept apart stay apart: the blank line is
           what tells the tag renderer they are two carousels */
        if (out.length && lastRun === out.length - 1) out.push("");
        out.push(run.join("\n"));
        lastRun = out.length - 1;
        continue;
      }
      if (RE.html.test(line)) {
        var h = [];
        while (i < lines.length && !RE.blank.test(lines[i])) { h.push(lines[i]); i++; }
        out.push(h.join("\n"));
        continue;
      }
      var p = [line];
      i++;
      while (i < lines.length && !RE.blank.test(lines[i]) && !startsBlock(lines, i)) { p.push(lines[i]); i++; }
      var body = p.join("\n");
      var pieces = flagSplit(body);
      if (pieces.length === 1) { out.push("<p>" + inline(body) + "</p>"); continue; }
      for (var pi = 0; pi < pieces.length; pi++) {
        if (pieces[pi].flag) { pushFlag(out, pieces[pi].flag, false); continue; }
        var pt = pieces[pi].text.trim();
        if (pt) out.push("<p>" + inline(pt) + "</p>");
      }
    }
    var html = out.join("\n");
    /* renderBody is what turns an image tag into an image, so the tag's
       escape has to survive until after it has run. */
    if (opts && opts.date && AMH.blog && AMH.blog.renderBody) {
      html = AMH.blog.renderBody(html, opts.date, opts.prefix, opts.images);
    }
    return unmark(html);
  }

  /* A source with its code filled in, fences and inline spans alike, for a
     reader that looks for commands: a tag written in code is text, and the
     renderer never draws it. Each line keeps its length. A fence becomes an
     empty line, as the block it is, and a span becomes marks and not
     spaces, so tags on either side of it stay two runs, as they render. */
  function withoutCode(source) {
    var inFence = false;
    return String(source).replace(/\r\n?/g, "\n").split("\n").map(function (l) {
      if (RE.fence.test(l)) { inFence = !inFence; return ""; }
      if (inFence) return "";
      return l.replace(CODE_G, function (m) { return new Array(m.length + 1).join("#"); });
    }).join("\n");
  }

  /* ==========================================================
     6. PLAIN TEXT
     ----------------------------------------------------------
     The words of a post with every mark removed, for the excerpt on a
     card and for the search index: code kept as text, links kept as
     their text, an image tag replaced by its caption and alt in
     parentheses so a caption can be found, tables flattened to cells
     with a space between, flags and rules removed, whitespace collapsed.
     ========================================================== */
  function text(source) {
    var lines = String(source).replace(/\r\n?/g, "\n").split("\n");
    var out = [];
    var i = 0, m;
    while (i < lines.length) {
      var l = lines[i];
      if (RE.fence.test(l)) {
        i++;
        while (i < lines.length && !RE.fence.test(lines[i])) { out.push(lines[i]); i++; }
        i++; continue;
      }
      if (RE.rule.test(l) || RE.flag.test(l) || RE.delim.test(l)) { i++; continue; }
      if ((m = RE.heading.exec(l))) l = m[2];
      else if ((m = RE.quote.exec(l))) l = m[1];
      else if ((m = RE.bullet.exec(l) || RE.number.exec(l))) l = m[2];
      else if (RE.pipe.test(l)) l = cells(l).join(" ");
      out.push(l);
      i++;
    }
    var s = out.join(" ");
    s = s.replace(CODE_G, "$1");
    /* a flag is an instruction and not a word, so it is not part of the
       post's name or of what a search reads */
    s = s.replace(FLAG_ANY, " ");
    s = unmark(s);
    s = s.replace(LINK_G, "$1");
    s = s.replace(TAG_G, function (_, word, fmt, num, cap, alt) {
      var words = [(cap || "").trim(), (alt || "").trim()].filter(Boolean).join(" ");
      return words ? "(" + words + ")" : "";
    });
    s = s.replace(/<[^>]+>/g, " ");
    s = s.replace(/\*\*([^*]+)\*\*/g, "$1").replace(/~~([^~]+)~~/g, "$1")
      .replace(/\*([^*\n]+)\*/g, "$1").replace(/(^|[^\w])_([^_\n]+)_(?=[^\w]|$)/g, "$1$2");
    return s.replace(/\s+/g, " ").trim();
  }

  /* ==========================================================
     7. EXPORTS
     ----------------------------------------------------------
     AMH.markdown
       render(source, opts) -> HTML, blocks joined by one newline
       text(source)         -> the words, marks removed, whitespace collapsed
       withoutCode(source)  -> the source with its code filled in, for a
                               reader that looks for commands
     ========================================================== */
  /* flags is the list above. The composer reads it for the two buttons that
     write a flag and for the panel that says what every one of them does. */
  AMH.markdown = { render: render, text: text, withoutCode: withoutCode, flags: FLAGS };
})();
