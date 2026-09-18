/* ============================================================
   imagesengine.js - the site's image engine: what an uploaded image
   becomes, how it is held until a save writes it, what an <img>
   says about its files, and which files nothing uses any more.

   Every page loads it, after work.js and before markdown.js and
   tool.js. It owns no box, no folder and no page. tool.js draws the
   boxes and writes the files, and each consumer names its files.

   Seven sections:
     1. SETUP                    5. CORE LOGIC
     2. CONSTANTS AND CONFIG     6. CLEANUP
     3. HELPER FUNCTIONS         7. PUBLIC API
     4. THE METADATA CUT

   Section 4 stands where initialization would. The engine sets
   nothing up at load, and cutting metadata out of a file is a job
   with rules of its own.

   One upload is three files, from the RENDITIONS list in section 2:

     <base>_sd.webp          480px on its long edge, for a small slot
     <base>.jpg              1920px, what a page shows
     <base>_original.<ext>   the file as it came, less its metadata

   The consumer names <base>. The site pages use img/work/<slug>-<hash>,
   where the hash is six characters from the original's bytes, so the
   same file always gets the same name.

   A GIF is taken too. Its two copies are stills of the first frame, and
   its original keeps every frame, so a page that shows the original shows
   it move. That is what Display Maximum UHD does: the image's own switch,
   written into its markup, puts the original where the display copy was.

   Display True Pixel Size is the second switch. It shows the original at
   its own size, never enlarged, and a small image keeps hard pixel edges.
   A GIF and a small PNG start with it on.

   A MEDIA FILE is a video, a sound or a MIDI file. It is not made into
   copies: it is one file, kept byte for byte as it came, and a blog names
   it blog/<date>_media<num>.<ext>. FORMATS, in section 2, is every
   extension the engine takes and the kinds each one can be.

   images.js, at the repo root, is the one record of every image and media
   file the site holds, either scheme: what each is, when it was added, and
   where it is used. This engine reads it and gives its text; tool.js and
   publish.js write the file. It loads on demand, only for the editor, so a
   reader never fetches it. superdeleted.js, beside it, is the log of every
   Super Delete, and it loads the same way.
   ============================================================ */
/* ==========================================================
   1. SETUP
   ----------------------------------------------------------
   One engine per page. A second load keeps the first, and the
   photos it holds.
   ========================================================== */
(function () {
  "use strict";
  var AMH = window.AMH = window.AMH || {};
  if (AMH.images) return;
  var doc = document;

  /* ==========================================================
     2. CONSTANTS AND CONFIG
     ========================================================== */

  /* What an upload becomes, in the order the files are made.

     A rendition with an edge is drawn from the decoded picture, scaled
     down to fit that edge and never up. The rendition with no edge is
     the original. Changing an edge or a quality changes the next upload
     only: nothing already written is made again.

     The keys are names the markup contract uses: "sd" is the small copy
     in srcset and data-sd, and "hd" is the src. */
  var RENDITIONS = [
    { key: "sd", suffix: "_sd", type: "image/webp", edge: 480, quality: 0.72 },
    { key: "hd", suffix: "", type: "image/jpeg", edge: 1920, quality: 0.85 },
    { key: "original", suffix: "_original" }
  ];

  /* The longest side a browser can decode before it runs out of memory.
     A file over it is refused, because no warning makes the decode work. */
  var MAX_SIDE = 12000;

  /* The largest file GitHub takes in a push. A file over it is taken
     anyway, and the photo says so, so a box can tell the author to
     upload that file by hand. */
  var GIT_FILE_LIMIT_MB = 100;

  /* The longest side, in pixels, of a small image. A PNG this small starts
     with Display True Pixel Size on.

     An image at most half this size is also crisp: it keeps hard pixel
     edges when a screen draws it larger than its file. The limit is half
     because a browser draws a shrink with hard edges too, and a shrunk
     image with hard edges is jagged. At half, it fits a carousel on a
     390 px phone at its own size. */
  var SMALL_IMAGE_PX = 480;

  /* THE FORMATS, NAMED ONCE.

     Every file the engine takes, by its extension: the kinds a file with
     that extension can be, and the MIME type each kind is served as. An
     image is made into three files. A video, a sound and a MIDI file are
     each kept as one file, byte for byte.

     An extension is not proof of what a file holds. MP4, WebM and Ogg
     each carry video or sound, so the kind is decided when the file is
     taken, and its record says it from then on. MIDI is notes for a
     synthesizer and not sound, so a page offers it as a file to download.

     The list is the whole list. A new extension needs a line here, and a
     test file that proves it. */
  var FORMATS = {
    jpg:  { image: "image/jpeg" },
    png:  { image: "image/png" },
    webp: { image: "image/webp" },
    gif:  { image: "image/gif" },
    mp4:  { video: "video/mp4", audio: "audio/mp4" },
    webm: { video: "video/webm", audio: "audio/webm" },
    weba: { audio: "audio/webm" },
    mp3:  { audio: "audio/mpeg" },
    wav:  { audio: "audio/wav" },
    ogg:  { audio: "audio/ogg", video: "video/ogg" },
    mid:  { midi: "audio/midi" },
    midi: { midi: "audio/midi" }
  };
  /* The word a blog tag names each kind with: [img0001], [video0012].
     png is the older name of img. A tag is read with it and never written
     with it. */
  var TAG_WORDS = { image: "img", video: "video", audio: "audio", midi: "midi" };

  /* The image formats the engine reads, by MIME type, and the extension
     each is written with: the image lines of FORMATS, turned round. */
  var TYPES = {};
  Object.keys(FORMATS).forEach(function (ext) {
    if (FORMATS[ext].image) TYPES[FORMATS[ext].image] = ext;
  });

  /* Where the site pages keep their images, and where an orphan goes. */
  var SITE_DIR = "img/work/";
  var DELETE_DIR = "deletethese/";

  /* The name schemes the engine gives, each with the extensions its files
     can have. A file named any other way is never an orphan, however it
     got into the folder.

     A blog display copy named .png is an image from before the engine.
     That is the one reason the blog's rule still takes .png.

     A media file is the third scheme, for the blog only. The longest
     extension is tried first, so a .midi file is never read as .mid. */
  var SITE_NAME = /^img\/work\/[a-z0-9]+(?:-[a-z0-9]+)*-[0-9a-z]{6}(?:_sd\.webp|\.jpg|_original\.(?:jpg|png|webp|gif))$/;
  var BLOG_NAME = /^blog\/\d{6}_img[0-9a-z]\d{3}(?:_sd\.webp|\.(?:jpg|png)|_original\.(?:jpg|png|webp|gif))$/;
  var MEDIA_EXT = "(?:" + Object.keys(FORMATS).filter(function (ext) { return !FORMATS[ext].image; })
    .sort(function (a, b) { return b.length - a.length; }).join("|") + ")";
  var MEDIA_BASE = /^blog\/\d{6}_media[0-9a-z]\d{3}$/;
  var MEDIA_NAME = new RegExp("^blog\\/\\d{6}_media[0-9a-z]\\d{3}\\." + MEDIA_EXT + "$");
  /* Any scheme, found inside a page's text. Each match is tested against
     the rules above before it counts. A blog number's first place counts
     in base 36, so the ten-thousandth image is imga000. */
  var NAMED_IN_TEXT = new RegExp("(?:img\\/work\\/[a-z0-9-]+|blog\\/\\d{6}_img[0-9a-z]\\d{3})" +
    "(?:_sd\\.webp|_original\\.(?:jpg|png|webp|gif)|\\.(?:jpg|png))" +
    "|blog\\/\\d{6}_media[0-9a-z]\\d{3}\\." + MEDIA_EXT, "g");

  /* A JPG has no transparent pixel, so every drawn copy is painted on the
     page's own ground. The small copy is painted too: a browser swaps one
     copy for the other at a breakpoint, and the two must look the same. */
  var GROUND = "#16181d";

  /* The database a held photo waits in until a save writes it. */
  var DB_NAME = "amh-images", DB_STORE = "images";
  /* The tab key is permanent. A new name gives an open tab a new id, and
     its held photos would then look like another tab's. */
  var TAB_KEY = "amh-photo-tab";
  /* A record another tab left is kept this long, in case that tab is still
     open with the edit that shows it. */
  var STALE_MS = 24 * 60 * 60 * 1000;

  /* ==========================================================
     3. HELPER FUNCTIONS
     ========================================================== */

  /* "Blockade Runner_01.PNG" -> "blockade-runner-01". Capped, so a long
     file name still makes a path a person can read. */
  function slugOf(fileName) {
    return String(fileName || "").replace(/\.[a-z0-9]+$/i, "").toLowerCase()
      .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60)
      .replace(/-+$/, "") || "photo";
  }

  /* The name the site pages give: img/work/<slug>-<hash>. */
  function siteName(parts) {
    return SITE_DIR + parts.slug + "-" + parts.hash;
  }

  /* Six base36 characters from a 32-bit FNV-1a hash of the bytes. It is
     the arithmetic of stamp() in tool.js, taken over bytes and not text,
     so the same file always gives the same six characters. */
  var HASH_SPACE = 2176782336;   /* 36^6 */
  function hashBytes(bytes) {
    var h = 0x811c9dc5;
    for (var i = 0; i < bytes.length; i++) {
      h ^= bytes[i];
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return ("00000" + (h % HASH_SPACE).toString(36)).slice(-6);
  }

  /* The extension a path ends in, lower case, or "". */
  function extOf(path) {
    var m = /\.([a-z0-9]+)$/i.exec(String(path || ""));
    return m ? m[1].toLowerCase() : "";
  }

  /* A whole number from an attribute, or 0. */
  function count(text) {
    var n = parseInt(text, 10);
    return n > 0 ? n : 0;
  }

  function isEngineName(path) {
    return SITE_NAME.test(path) || BLOG_NAME.test(path) || MEDIA_NAME.test(path);
  }

  /* ---------------- formats ---------------- */

  /* A table's own value for a key, or null. A key read from a file can be
     any text, and "constructor" must not find what every object has. */
  function own(table, key) {
    return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : null;
  }
  /* The kinds a file with this extension can be, in FORMATS' order, or []
     for an extension the engine does not take. An extension is read in
     any case and written in lower case. */
  function kindsOf(ext) {
    var line = own(FORMATS, String(ext || "").toLowerCase());
    return line ? Object.keys(line) : [];
  }
  /* The MIME type a file of this extension is served as when it is of
     this kind, or "" when the extension and the kind do not go together. */
  function mimeOf(ext, kind) {
    var line = own(FORMATS, String(ext || "").toLowerCase());
    return (line && own(line, kind)) || "";
  }
  /* The word a blog tag names a kind with, or "" for a kind that is not
     one. */
  function tagWordOf(kind) {
    return own(TAG_WORDS, kind) || "";
  }

  /* ---------------- bytes ---------------- */

  function u16(b, i, le) {
    return le ? (b[i] | (b[i + 1] << 8)) : ((b[i] << 8) | b[i + 1]);
  }
  function u32(b, i, le) {
    return le
      ? (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0
      : ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
  }
  function ascii(b, i, n) {
    var s = "";
    for (var k = 0; k < n && i + k < b.length; k++) s += String.fromCharCode(b[i + k]);
    return s;
  }
  function joinBytes(parts) {
    var total = 0;
    parts.forEach(function (p) { total += p.length; });
    var out = new Uint8Array(total);
    var at = 0;
    parts.forEach(function (p) { out.set(p, at); at += p.length; });
    return out;
  }
  var crcTable = null;
  function crc32(bytes) {
    if (!crcTable) {
      crcTable = [];
      for (var n = 0; n < 256; n++) {
        var c = n;
        for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        crcTable[n] = c >>> 0;
      }
    }
    var crc = 0xFFFFFFFF;
    for (var i = 0; i < bytes.length; i++) crc = crcTable[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  /* ---------------- pictures ---------------- */

  /* Decode once, with a phone photo's orientation applied, so every drawn
     copy is upright. */
  function decode(file) {
    if (window.createImageBitmap) {
      return createImageBitmap(file, { imageOrientation: "from-image" })
        .catch(function () { return createImageBitmap(file); });
    }
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var im = new Image();
      im.onload = function () { URL.revokeObjectURL(url); resolve(im); };
      im.onerror = function () { URL.revokeObjectURL(url); reject(new Error("decode failed")); };
      im.src = url;
    });
  }

  function release(pic) {
    if (pic && pic.close) pic.close();
  }

  /* Draw one rendition of a decoded picture. Resolves { blob, w, h }. */
  function draw(pic, r) {
    var scale = Math.min(1, r.edge / Math.max(pic.width, pic.height));
    var w = Math.max(1, Math.round(pic.width * scale));
    var h = Math.max(1, Math.round(pic.height * scale));
    var cv = doc.createElement("canvas");
    cv.width = w;
    cv.height = h;
    var cx = cv.getContext("2d");
    cx.fillStyle = GROUND;
    cx.fillRect(0, 0, w, h);
    cx.imageSmoothingQuality = "high";
    cx.drawImage(pic, 0, 0, w, h);
    return new Promise(function (resolve, reject) {
      cv.toBlob(function (blob) {
        /* A browser that cannot write a format hands back a PNG instead,
           and a PNG named .webp is a file no page can trust. */
        if (!blob) reject(new Error("The browser could not encode the photo."));
        else if (blob.type !== r.type) {
          reject(new Error("This browser cannot write " + TYPES[r.type].toUpperCase() +
            " files, so it cannot make the photo's copies. Use Chrome, Edge or Firefox."));
        } else resolve({ blob: blob, w: w, h: h });
      }, r.type, r.quality);
    });
  }

  function revokeLater(urls) {
    /* deferred, because an <img> or an open viewer may still be painting it */
    Object.keys(urls || {}).forEach(function (k) {
      var url = urls[k];
      window.setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
    });
  }

  /* ---------------- the store's database ---------------- */

  /* One connection for each job, closed with it, so a run of photo writes
     does not leave a connection open for each. */
  function idb(mode, run) {
    return new Promise(function (resolve, reject) {
      if (typeof indexedDB === "undefined" || !indexedDB) {
        reject(new Error("this browser keeps no IndexedDB"));
        return;
      }
      var q = indexedDB.open(DB_NAME, 1);
      q.onupgradeneeded = function () { q.result.createObjectStore(DB_STORE); };
      q.onerror = function () { reject(q.error || new Error("IndexedDB refused")); };
      q.onblocked = function () { reject(new Error("IndexedDB blocked")); };
      q.onsuccess = function () {
        var db = q.result;
        var tx = db.transaction(DB_STORE, mode);
        var req = run(tx.objectStore(DB_STORE));
        tx.oncomplete = function () { db.close(); resolve(req ? req.result : undefined); };
        tx.onerror = function () { db.close(); reject(tx.error); };
        tx.onabort = function () { db.close(); reject(tx.error || new Error("aborted")); };
      };
    });
  }

  /* The id this tab's records carry, made once and kept for the tab. A
     browser that refuses sessionStorage gets one for the page load. */
  var tabId = "";
  function tab() {
    if (tabId) return tabId;
    try { tabId = window.sessionStorage.getItem(TAB_KEY) || ""; } catch (err) {}
    if (!tabId) {
      tabId = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      try { window.sessionStorage.setItem(TAB_KEY, tabId); } catch (err) {}
    }
    return tabId;
  }
  function recordKey(base) { return tab() + "|" + base; }

  /* ==========================================================
     4. THE METADATA CUT
     ----------------------------------------------------------
     A phone photo carries where it was taken, and the site is
     public. The drawn copies never carry it, because a canvas has
     no metadata. The original does, so it is cut here, at the byte
     level and with no new encoding, so the picture is exactly the
     one that came in.

     KEPT is what changes how the picture looks: its colour profile,
     and its orientation, so a phone photo does not open sideways.
     CUT is everything that says where, when, and with what.

       JPG   cut: APP1 Exif and XMP, APP13 IPTC, APP2 MPF, comments,
             and anything after the end of the picture. kept: an APP1
             with the Orientation tag alone, when it is not 1, and
             every other segment, APP2 ICC included.
       PNG   cut: eXIf, tEXt, zTXt, iTXt and tIME. kept: an eXIf with
             the Orientation tag alone, when it is not 1, and every
             other chunk, iCCP included.
       WebP  cut: EXIF and XMP, with the header's flags corrected.
             kept: every other chunk, ICCP included.
       GIF   cut: comment blocks, the XMP block, and anything after the
             trailer. kept: every other block, so every frame and the
             loop count stay.

     A FILE THE CUTTER CANNOT WALK IS KEPT WHOLE, and meta.kept says
     so. A broken cut is a broken original, and that is the worse loss.
     ========================================================== */

  function noFacts() {
    return { location: false, camera: false, date: false, kept: false };
  }
  function whole(bytes, meta, frames) {
    meta.kept = true;
    return { bytes: bytes, meta: meta, frames: frames || 0 };
  }

  /* What an EXIF block says, from the TIFF header at b[start]. Reads what
     it can reach inside the block and stops at the first value outside it. */
  function tiffFacts(b, start, end, meta) {
    var orientation = 1;
    if (end - start < 8) return orientation;
    var le = b[start] === 0x49 && b[start + 1] === 0x49;
    if (!le && !(b[start] === 0x4D && b[start + 1] === 0x4D)) return orientation;
    function ifd(offset, visit) {
      var at = start + offset;
      if (offset < 8 || at + 2 > end) return;
      var n = u16(b, at, le);
      for (var k = 0; k < n; k++) {
        var e = at + 2 + k * 12;
        if (e + 12 > end) return;
        visit(u16(b, e, le), e + 8);
      }
    }
    ifd(u32(b, start + 4, le), function (tag, value) {
      if (tag === 0x0112) orientation = u16(b, value, le) || 1;
      else if (tag === 0x010F || tag === 0x0110) meta.camera = true;
      else if (tag === 0x0132) meta.date = true;
      else if (tag === 0x8825) ifd(u32(b, value, le), function () { meta.location = true; });
      else if (tag === 0x8769) {
        ifd(u32(b, value, le), function (t) {
          if (t === 0x9003 || t === 0x9004) meta.date = true;
          else if (t === 0xA431 || t === 0xA433 || t === 0xA434) meta.camera = true;
        });
      }
    });
    return orientation;
  }

  /* What an XMP packet says. It is text, so a name is enough. */
  function xmpFacts(text, meta) {
    if (/GPSLatitude|GPSLongitude/.test(text)) meta.location = true;
    if (/tiff:Make|tiff:Model|LensModel/.test(text)) meta.camera = true;
    if (/DateTimeOriginal|xmp:CreateDate|photoshop:DateCreated/.test(text)) meta.date = true;
  }

  /* A TIFF block holding the Orientation tag and nothing else. */
  function orientationTiff(o) {
    return new Uint8Array([0x4D, 0x4D, 0x00, 0x2A, 0x00, 0x00, 0x00, 0x08,
      0x00, 0x01, 0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, o, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00]);
  }

  /* The first byte after a JPG scan's data: the next marker that is not a
     stuffed byte, a restart or a fill byte. */
  function scanEnd(b, from) {
    for (var j = from; j + 1 < b.length; j++) {
      if (b[j] !== 0xFF) continue;
      var n = b[j + 1];
      if (n === 0x00 || n === 0xFF || (n >= 0xD0 && n <= 0xD7)) continue;
      return j;
    }
    return b.length;
  }

  function cutJpg(b, keepMeta) {
    var meta = noFacts();
    if (b.length < 4 || b[0] !== 0xFF || b[1] !== 0xD8) return whole(b, meta);
    var parts = [b.subarray(0, 2)];
    var i = 2;
    while (i < b.length) {
      if (b[i] !== 0xFF || i + 1 >= b.length) return whole(b, meta);
      var m = b[i + 1];
      if (m === 0xFF) { i++; continue; }
      if (m === 0xD9) { parts.push(b.subarray(i, i + 2)); i += 2; break; }
      if (m === 0x01 || (m >= 0xD0 && m <= 0xD7)) { parts.push(b.subarray(i, i + 2)); i += 2; continue; }
      if (i + 4 > b.length) return whole(b, meta);
      var end = i + 2 + u16(b, i + 2, false);
      if (end < i + 4 || end > b.length) return whole(b, meta);
      if (m === 0xDA) {
        /* a scan header, and the picture's data after it */
        var data = scanEnd(b, end);
        parts.push(b.subarray(i, data));
        i = data;
        continue;
      }
      var cut = false;
      if (m === 0xE1 && ascii(b, i + 4, 6) === "Exif\u0000\u0000") {
        var o = tiffFacts(b, i + 10, end, meta);
        cut = true;
        /* the one tag that decides which way up the picture is */
        if (!keepMeta && o > 1 && o <= 8) {
          parts.push(joinBytes([new Uint8Array([0xFF, 0xE1, 0x00, 0x22,
            0x45, 0x78, 0x69, 0x66, 0x00, 0x00]), orientationTiff(o)]));
        }
      } else if (m === 0xE1 && ascii(b, i + 4, 20).indexOf("http://ns.adobe.com/") === 0) {
        xmpFacts(ascii(b, i + 4, end - i - 4), meta);
        cut = true;
      } else if (m === 0xED) {
        cut = true;
      } else if (m === 0xE2 && ascii(b, i + 4, 4) === "MPF\u0000") {
        cut = true;
      } else if (m === 0xFE) {
        cut = true;
      }
      if (!cut) parts.push(b.subarray(i, end));
      i = end;
    }
    if (keepMeta) return whole(b, meta);
    return { bytes: joinBytes(parts), meta: meta };
  }

  var PNG_SIGNATURE = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
  var PNG_CUT = { eXIf: 1, tEXt: 1, zTXt: 1, iTXt: 1, tIME: 1 };

  /* One PNG chunk: length, type, data and the CRC over type and data. */
  function pngChunk(type, data) {
    var head = new Uint8Array([0, 0, 0, 0, type.charCodeAt(0), type.charCodeAt(1),
      type.charCodeAt(2), type.charCodeAt(3)]);
    var n = data.length;
    head[0] = (n >>> 24) & 255; head[1] = (n >>> 16) & 255; head[2] = (n >>> 8) & 255; head[3] = n & 255;
    var c = crc32(joinBytes([head.subarray(4), data]));
    return joinBytes([head, data, new Uint8Array([(c >>> 24) & 255, (c >>> 16) & 255,
      (c >>> 8) & 255, c & 255])]);
  }

  function cutPng(b, keepMeta) {
    var meta = noFacts();
    for (var s = 0; s < 8; s++) if (b[s] !== PNG_SIGNATURE[s]) return whole(b, meta);
    var parts = [b.subarray(0, 8)];
    var i = 8, ended = false;
    while (i + 12 <= b.length) {
      var len = u32(b, i, false);
      var type = ascii(b, i + 4, 4);
      var end = i + 12 + len;
      if (end > b.length) return whole(b, meta);
      var dataAt = i + 8;
      if (type === "eXIf") {
        var o = tiffFacts(b, dataAt, dataAt + len, meta);
        if (!keepMeta && o > 1 && o <= 8) parts.push(pngChunk("eXIf", orientationTiff(o)));
      } else if (type === "tEXt" || type === "zTXt" || type === "iTXt") {
        var word = ascii(b, dataAt, Math.min(len, 80)).split("\u0000")[0];
        if (word === "XML:com.adobe.xmp") xmpFacts(ascii(b, dataAt, len), meta);
        else if (/^(Creation Time|Date)/.test(word)) meta.date = true;
      } else if (type === "tIME") {
        meta.date = true;
      }
      if (!PNG_CUT[type]) parts.push(b.subarray(i, end));
      i = end;
      if (type === "IEND") { ended = true; break; }
    }
    if (!ended || keepMeta) return whole(b, meta);
    return { bytes: joinBytes(parts), meta: meta };
  }

  function cutWebp(b, keepMeta) {
    var meta = noFacts();
    if (b.length < 20 || ascii(b, 0, 4) !== "RIFF" || ascii(b, 8, 4) !== "WEBP") return whole(b, meta);
    var parts = [], flags = null, dropped = 0;
    var i = 12;
    while (i + 8 <= b.length) {
      var type = ascii(b, i, 4);
      var len = u32(b, i + 4, true);
      if (i + 8 + len > b.length) return whole(b, meta);
      /* a chunk is padded to an even length; the last one may miss its pad */
      var end = Math.min(b.length, i + 8 + len + (len & 1));
      if (type === "EXIF") {
        var at = i + 8;
        if (ascii(b, at, 6) === "Exif\u0000\u0000") at += 6;
        tiffFacts(b, at, i + 8 + len, meta);
      } else if (type === "XMP ") {
        xmpFacts(ascii(b, i + 8, len), meta);
      }
      if (type === "EXIF" || type === "XMP ") {
        dropped |= type === "EXIF" ? 0x08 : 0x04;
      } else {
        var chunk = b.slice(i, end);
        if (type === "VP8X" && chunk.length > 8) flags = chunk;
        parts.push(chunk);
      }
      i = end;
    }
    if (keepMeta) return whole(b, meta);
    /* the extended header says which chunks follow, so it stops naming
       the ones that were cut */
    if (flags) flags[8] &= ~dropped;
    var body = joinBytes(parts);
    var head = new Uint8Array(12);
    head.set([0x52, 0x49, 0x46, 0x46], 0);
    var size = body.length + 4;
    head[4] = size & 255; head[5] = (size >>> 8) & 255; head[6] = (size >>> 16) & 255; head[7] = (size >>> 24) & 255;
    head.set([0x57, 0x45, 0x42, 0x50], 8);
    return { bytes: joinBytes([head, body]), meta: meta };
  }

  /* A GIF is a header, a screen descriptor and an optional colour table,
     then extensions and images to the trailer. Each image descriptor is a
     frame, so the walk also counts the frames: more than one moves. */
  function cutGif(b, keepMeta) {
    var meta = noFacts();
    var head = ascii(b, 0, 6);
    if (b.length < 14 || (head !== "GIF87a" && head !== "GIF89a")) return whole(b, meta);
    var i = 13;
    if (b[10] & 0x80) i += 3 * (1 << ((b[10] & 7) + 1));
    var parts = [b.subarray(0, i)];
    var frames = 0, ended = false;
    /* the index after a run of sub-blocks, or -1 when the run is cut short */
    function blocksEnd(from) {
      for (var j = from; j < b.length; j += b[j] + 1) {
        if (b[j] === 0) return j + 1;
      }
      return -1;
    }
    while (i < b.length) {
      if (b[i] === 0x3B) { parts.push(b.subarray(i, i + 1)); ended = true; break; }
      var end;
      if (b[i] === 0x2C) {
        if (i + 10 > b.length) return whole(b, meta, frames);
        var data = i + 10;
        if (b[i + 9] & 0x80) data += 3 * (1 << ((b[i + 9] & 7) + 1));
        /* one byte of LZW code size, then the picture's sub-blocks */
        end = blocksEnd(data + 1);
        if (end < 0) return whole(b, meta, frames);
        parts.push(b.subarray(i, end));
        frames++;
      } else if (b[i] === 0x21 && i + 2 < b.length) {
        var label = b[i + 1];
        end = blocksEnd(i + 2);
        if (end < 0) return whole(b, meta, frames);
        var xmp = label === 0xFF && b[i + 2] === 11 && ascii(b, i + 3, 11) === "XMP DataXMP";
        if (xmp) xmpFacts(ascii(b, i + 14, end - i - 14), meta);
        if (label !== 0xFE && !xmp) parts.push(b.subarray(i, end));
      } else {
        return whole(b, meta, frames);
      }
      i = end;
    }
    if (!ended || keepMeta) return whole(b, meta, frames);
    return { bytes: joinBytes(parts), meta: meta, frames: frames };
  }

  /* The original's bytes, cut for its format: { bytes, meta, frames }.
     frames is counted for a GIF only. It never throws, because a file it
     cannot cut comes back whole. */
  function cutMeta(bytes, ext, keepMeta) {
    try {
      if (ext === "jpg") return cutJpg(bytes, keepMeta);
      if (ext === "png") return cutPng(bytes, keepMeta);
      if (ext === "webp") return cutWebp(bytes, keepMeta);
      if (ext === "gif") return cutGif(bytes, keepMeta);
    } catch (err) {
      return whole(bytes, noFacts());
    }
    return whole(bytes, noFacts());
  }

  /* ==========================================================
     5. CORE LOGIC
     ========================================================== */

  /* ---------------- intake ----------------

     AMH.images.intake(file, opts) -> Promise<photo>

       opts.name(parts)  the base path, from { hash, slug, ext }. The
                         site pages' scheme when not given.
       opts.keepMeta     true keeps the original's metadata whole

     The photo it resolves:

       base        the base path, "img/work/hangar-bay-k3f9zq"
       files       { sd, hd, original }, each a path
       blobs       the three files, until a save writes them
       urls        a blob: URL for each, for every preview of the photo
       w, h        the display copy's size
       sdw, sdh    the small copy's size
       ow, oh      the original's size, upright
       kind        "image"; a media file held the same way says "video",
                   "audio" or "midi", and has one file, keyed source
       type        the original's format: "jpg", "png", "webp" or "gif"
       mime        the MIME type FORMATS gives that format and kind
       animated    true for a GIF of more than one frame
       bytes       the original's size as it is written
       from        the name the file had
       meta        { location, camera, date, kept }: what the original
                   carried, and whether it still carries it
       overLimit   true when the original is over GIT_FILE_LIMIT_MB
       saved       true once a save has written it

     Rejects with an Error whose message a box shows as it is. */
  function intake(file, opts) {
    opts = opts || {};
    if (!file) return Promise.reject(new Error("No file was given."));
    var called = '"' + (file.name || "That file") + '"';
    if (/^image\/hei[cf]$/i.test(file.type || "") || /\.hei[cf]$/i.test(file.name || "")) {
      return Promise.reject(new Error(called + " is a HEIC photo, the format an iPhone " +
        "saves by default, and a browser cannot read it. Export it from Photos as a " +
        "JPEG, or set the iPhone's Settings > Camera > Formats to Most Compatible, " +
        "then add the JPG."));
    }
    var ext = TYPES[file.type];
    if (!ext) {
      return Promise.reject(new Error("This editor reads JPG, PNG, WebP and GIF images. " +
        called + " is not one of them."));
    }
    var original = null, pic = null, made = {};
    return file.arrayBuffer().then(function (buf) {
      original = cutMeta(new Uint8Array(buf), ext, !!opts.keepMeta);
      return decode(file).then(null, function () {
        throw new Error(called + " could not be read as a photo.");
      });
    }).then(function (decoded) {
      pic = decoded;
      if (Math.max(pic.width, pic.height) > MAX_SIDE) {
        throw new Error(called + " is over " + MAX_SIDE + "px on a side.");
      }
      return RENDITIONS.filter(function (r) { return r.edge; }).reduce(function (chain, r) {
        return chain.then(function () {
          return draw(pic, r).then(function (out) { made[r.key] = out; });
        });
      }, Promise.resolve());
    }).then(function () {
      var ow = pic.width, oh = pic.height;
      release(pic);
      pic = null;
      var hash = hashBytes(original.bytes);
      var base = (opts.name || siteName)({ hash: hash, slug: slugOf(file.name), ext: ext });
      var photo = {
        base: base, files: {}, blobs: {}, urls: {},
        w: made.hd.w, h: made.hd.h, sdw: made.sd.w, sdh: made.sd.h, ow: ow, oh: oh,
        kind: "image", type: ext, mime: mimeOf(ext, "image"), animated: original.frames > 1,
        bytes: original.bytes.length, from: file.name || "photo",
        meta: original.meta,
        overLimit: original.bytes.length > api.GIT_FILE_LIMIT_MB * 1024 * 1024,
        saved: false
      };
      RENDITIONS.forEach(function (r) {
        photo.files[r.key] = base + r.suffix + "." + (r.type ? TYPES[r.type] : ext);
        photo.blobs[r.key] = r.edge ? made[r.key].blob
          : new Blob([original.bytes], { type: file.type });
        photo.urls[r.key] = URL.createObjectURL(photo.blobs[r.key]);
      });
      return photo;
    }, function (err) {
      release(pic);
      throw err;
    });
  }

  /* ---------------- the held store ----------------

     A photo a page shows is held here until a save writes it: in memory,
     and in IndexedDB for this tab, so a reload or a walk to another page
     does not lose it. A record keys on the photo's base path. */
  var held = {};

  /* A held file's kind and MIME type. A record from before the engine
     took media files has neither: it is an image, and its type gives the
     rest. */
  function kindOfRow(row) { return (row && row.kind) || "image"; }
  function mimeOfRow(row) { return (row && row.mime) || mimeOf(row && row.type, kindOfRow(row)); }

  function toRecord(photo) {
    return { base: photo.base, kind: kindOfRow(photo), mime: mimeOfRow(photo),
             files: photo.files, blobs: photo.blobs, tab: tab(),
             at: Date.now(), w: photo.w, h: photo.h, sdw: photo.sdw, sdh: photo.sdh,
             ow: photo.ow, oh: photo.oh, type: photo.type, animated: photo.animated,
             bytes: photo.bytes, from: photo.from, meta: photo.meta,
             overLimit: photo.overLimit };
  }
  function fromRecord(row) {
    var photo = { base: row.base, kind: kindOfRow(row), mime: mimeOfRow(row),
                  files: row.files, blobs: row.blobs, urls: {},
                  w: row.w, h: row.h, sdw: row.sdw, sdh: row.sdh, ow: row.ow, oh: row.oh,
                  type: row.type, animated: !!row.animated, bytes: row.bytes,
                  from: row.from, meta: row.meta, overLimit: row.overLimit, saved: false };
    Object.keys(row.blobs).forEach(function (k) { photo.urls[k] = URL.createObjectURL(row.blobs[k]); });
    return photo;
  }

  /* One held file under another name.

     The blog names a file for the date it will be published under, and
     that date can change before it is. Renaming re-keys the record and
     rewrites its paths, the three of an image or the one of a media file;
     the bytes and the blob: URLs a page is painting are untouched, so
     nothing on screen flickers.

     Returns the photo, or null when it is not held or the new name is
     taken. A name that is already this photo's is a no-op. */
  function rename(base, newBase) {
    var photo = held[base];
    if (!photo || !newBase || base === newBase) return photo || null;
    if (held[newBase]) return null;
    delete held[base];
    photo.base = newBase;
    photo.files = filesOf({ base: newBase, kind: kindOfRow(photo), type: photo.type });
    held[newBase] = photo;
    /* both writes in the one transaction, so a record can never be under
       two names at once or under none */
    idb("readwrite", function (st) {
      st.delete(recordKey(base));
      return st.put(toRecord(photo), recordKey(newBase));
    }).then(null, function () {});
    return photo;
  }

  /* A page shows this photo now, so it is held until a save writes it.
     The same file added twice is held once: the first photo stands for
     both, and the bytes are the same. */
  function hold(photo) {
    if (!photo || held[photo.base]) return;
    held[photo.base] = photo;
    idb("readwrite", function (st) {
      return st.put(toRecord(photo), recordKey(photo.base));
    }).then(null, function (err) {
      console.warn("[images] " + (photo.files.hd || photo.files.source || photo.base) + " is held on this page only (" +
        (err && err.message ? err.message : "no storage") + "). Save before you " +
        "leave the page, or the photo has to be added again.");
    });
  }

  /* This tab's held photos, back from IndexedDB after a reload or a walk
     from another page. Never rejects: a browser that keeps nothing costs
     the reader those photos, not an error. */
  function recall() {
    return idb("readonly", function (st) { return st.getAll(); }).then(function (rows) {
      (rows || []).forEach(function (row) {
        if (!row || row.tab !== tab() || !row.blobs || held[row.base]) return;
        held[row.base] = fromRecord(row);
      });
    }, function () {});
  }

  /* The held photo for a base path, or null. */
  function photoFor(base) {
    return held[base] || null;
  }

  /* Every file of these held photos that no save has written, as the
     bytes a save or a bundle puts beside the page: { path: Uint8Array }. */
  function files(bases) {
    return recall().then(function () {
      var out = {};
      var jobs = [];
      (bases || []).forEach(function (base) {
        var photo = held[base];
        if (!photo || photo.saved) return;
        Object.keys(photo.files).forEach(function (k) {
          var path = photo.files[k];
          jobs.push(photo.blobs[k].arrayBuffer().then(function (buf) {
            out[path] = new Uint8Array(buf);
          }));
        });
      });
      return Promise.all(jobs).then(function () { return out; });
    });
  }

  /* A save wrote these paths. A photo whose three files are all among
     them is on disk now, so it is not written again and the tab no longer
     keeps a copy. Its URLs stay, because a page may still be painting it. */
  function saved(paths) {
    var wrote = {};
    (paths || []).forEach(function (p) { wrote[p] = true; });
    Object.keys(held).forEach(function (base) {
      var photo = held[base];
      if (photo.saved) return;
      var all = Object.keys(photo.files).every(function (k) { return wrote[photo.files[k]]; });
      if (!all) return;
      photo.saved = true;
      idb("readwrite", function (st) { return st.delete(recordKey(base)); })
        .then(null, function () {});
    });
  }

  /* What the store holds, for the console and the tests: one record for
     each photo, without its bytes. */
  function list() {
    return Object.keys(held).sort().map(function (base) {
      var p = held[base];
      return { base: base, kind: kindOfRow(p), mime: mimeOfRow(p), files: p.files,
               w: p.w, h: p.h, sdw: p.sdw, sdh: p.sdh,
               ow: p.ow, oh: p.oh, type: p.type, animated: p.animated, bytes: p.bytes,
               from: p.from, meta: p.meta, overLimit: p.overLimit, saved: p.saved };
    });
  }

  /* ---------------- the markup contract ----------------

     One function writes what an <img> says about its files, and one reads
     it back. Every serializer calls the first and every reader the second,
     so the shape exists in this one place.

     An entry's file fields:

       src        the display copy
       sd, sdw    the small copy, and its width
       w, h       the display copy's size
       ow, oh     the original's size
       original   the original
       bytes      the original's size
       uhd        true to show the original where the display copy was
       truesize   true to show the original at its own size; it turns
                  uhd on with it

     An image with only a src, a seed or a hand-written image, has none of
     the others, and gets its src back and nothing else. */

  /* The attributes for an entry, as [name, value] pairs in the order they
     are written. alt and data-caption are the caller's to write.

     slot is the consumer's, because only the consumer knows how wide its
     picture is drawn: { sizes, widest }, the sizes string and the most CSS
     pixels that string ever gives.

     srcset offers the small copy and the display copy, and the browser
     takes the small one for a small slot. It is written only for a display
     copy at least as wide as the slot's widest. With srcset the browser
     draws the picture at the slot's width, and a narrower picture would be
     stretched to fill it; without srcset it keeps its own size.

     width and height hold the space open before the file arrives. data-sd
     is the small copy on its own, which the carousel's dots and backdrop
     read, and data-original is what the viewer offers. */
  function attrs(entry, slot, opts) {
    /* Display True Pixel Size: the original at its own size. It is UHD
       with no srcset, because with a srcset a browser draws the picture at
       the slot's width and not at its own. */
    var truesize = !!(entry.truesize && entry.original);
    /* Display Maximum UHD: the original stands where the display copy
       stood, and the small copy still serves a small slot */
    var uhd = truesize || !!(entry.uhd && entry.original);
    var gif = extOf(entry.original) === "gif";
    /* A page in a folder says where the root is. Every candidate carries
       it, because a browser resolves a srcset against the page and not
       against the src. A blob: URL is already absolute and takes none. */
    var at = (opts && opts.prefix) || "";
    var put = function (path) {
      return path && at && path.indexOf("blob:") !== 0 && path.indexOf("/") !== 0 &&
        !/^[a-z]+:/i.test(path) ? at + path : path;
    };
    var src = put(uhd ? entry.original : entry.src);
    var sd = put(entry.sd);
    var srcWidth = uhd ? entry.ow : entry.w;
    var out = [["src", src || ""]];
    /* A GIF shown whole writes no srcset. Its small copy is a still, and a
       phone would be handed the still. */
    if (slot && entry.sd && entry.sdw && srcWidth && srcWidth >= slot.widest && !(uhd && gif) && !truesize) {
      out.push(["srcset", sd + " " + entry.sdw + "w, " + src + " " + srcWidth + "w"]);
      out.push(["sizes", slot.sizes]);
    }
    /* the display copy's size, in both modes: the original has the same
       shape, so the space held open is the same */
    if (entry.w && entry.h) {
      out.push(["width", String(entry.w)]);
      out.push(["height", String(entry.h)]);
    }
    /* the display copy's path is kept, so the switch can be turned off
       again with no upload */
    if (uhd) {
      out.push(["data-uhd", "1"]);
      out.push(["data-hd", put(entry.src)]);
    }
    if (truesize) {
      out.push(["data-truesize", "1"]);
      /* A paint hint, written from the original's size and never read
         back: a small image keeps hard pixel edges when it is drawn
         larger than its file. */
      if (isCrisp(entry.ow, entry.oh)) out.push(["data-crisp", "1"]);
    }
    if (entry.sd) out.push(["data-sd", sd]);
    if (entry.original) {
      out.push(["data-original", put(entry.original)]);
      if (entry.ow && entry.oh) out.push(["data-original-size", entry.ow + "x" + entry.oh]);
      if (entry.bytes) out.push(["data-original-bytes", String(entry.bytes)]);
    }
    return out;
  }

  /* The file fields of an <img>, read from what attrs() wrote. src is the
     display copy's path whichever copy the page shows. type is the
     original's format, from its extension. An image with data-truesize
     shows its original, so it reads uhd too, with or without data-uhd. */
  function read(el) {
    function get(name) { return el.getAttribute(name) || ""; }
    var truesize = get("data-truesize") === "1";
    var uhd = truesize || get("data-uhd") === "1";
    var size = /^(\d+)x(\d+)$/.exec(get("data-original-size"));
    var out = { src: uhd ? (get("data-hd") || get("src")) : get("src"),
                sd: get("data-sd"), sdw: 0,
                w: count(get("width")), h: count(get("height")),
                ow: size ? +size[1] : 0, oh: size ? +size[2] : 0,
                original: get("data-original"), bytes: count(get("data-original-bytes")),
                uhd: uhd, truesize: truesize, type: extOf(get("data-original")) };
    if (out.sd) {
      get("srcset").split(",").forEach(function (candidate) {
        var m = /^\s*(\S+)\s+(\d+)w\s*$/.exec(candidate);
        if (m && m[1] === out.sd) out.sdw = +m[2];
      });
    }
    return out;
  }

  /* True when a longest side of w and h is known and is at most
     SMALL_IMAGE_PX. The setting is read from the API each time, so the
     console can try another value. */
  function isSmall(w, h) {
    var longest = Math.max(w || 0, h || 0);
    return longest > 0 && longest <= api.SMALL_IMAGE_PX;
  }

  /* True for an image that keeps hard pixel edges: a longest side of at
     most half of SMALL_IMAGE_PX. See SMALL_IMAGE_PX for why half. */
  function isCrisp(w, h) {
    var longest = Math.max(w || 0, h || 0);
    return longest > 0 && longest <= api.SMALL_IMAGE_PX / 2;
  }

  /* The two switches a photo starts with when it is added, as { uhd,
     truesize }. A GIF is taken to move and a small PNG to be an icon, so
     both show the original at its own size. Every other photo starts with
     both off. An image already on a page keeps the switches it has. */
  function defaults(photo) {
    var p = photo || {};
    var on = p.type === "gif" || (p.type === "png" && isSmall(p.ow, p.oh));
    return { uhd: on, truesize: on };
  }

  /* The file fields a new entry takes from a photo: the paths a save
     writes. Whether it shows its original is the author's to say. */
  function fieldsOf(photo) {
    return { src: photo.files.hd, sd: photo.files.sd, sdw: photo.sdw, w: photo.w,
             h: photo.h, ow: photo.ow, oh: photo.oh, original: photo.files.original,
             bytes: photo.bytes };
  }

  /* The same fields with the photo's blob: URLs in place of its paths, for
     a page that shows a photo no save has written yet. No slot goes with
     it, so no srcset is written: a preview is one copy. */
  function previewOf(photo) {
    return { src: photo.urls.hd, sd: photo.urls.sd, sdw: photo.sdw, w: photo.w,
             h: photo.h, ow: photo.ow, oh: photo.oh, original: photo.urls.original,
             bytes: photo.bytes };
  }

  /* The size one copy is drawn at, for a reader that knows the original's
     size and not the copy's. The same arithmetic draw() uses, published so
     nothing has to repeat it: the blog's manifest states an original's size
     and its reader works the rest out from here. */
  function copySize(ow, oh, key) {
    var r = null;
    RENDITIONS.forEach(function (x) { if (x.key === key) r = x; });
    if (!r || !r.edge || !ow || !oh) return { w: ow || 0, h: oh || 0 };
    var scale = Math.min(1, r.edge / Math.max(ow, oh));
    return { w: Math.max(1, Math.round(ow * scale)), h: Math.max(1, Math.round(oh * scale)) };
  }

  /* The base path of any file the engine names: one of an image's three,
     or a media file's one. */
  function baseOf(path) {
    return String(path || "").replace(/(?:_sd|_original)?\.[a-z0-9]+$/i, "");
  }

  /* ---------------- the image index ----------------

     One record of every image and media file the site holds, in images.js:

       window.AMH_IMAGES = { v: 2, stamp, nextImg, images: [ entry ] }

     An entry: base, the base path of its files; kind, "image", "video",
     "audio" or "midi"; type, the original's extension; mime, the MIME type
     FORMATS gives that extension and kind; from, the name the file had
     when it was added, or "" when that is not known; ow, oh and bytes, the
     original's facts; added, the day it was first written, YYMMDD; used,
     where it is shown, "pNNNN" for a post and "page#slug" for a region, as
     of the last write of that post or page; words, what each of those
     places says about it.

     An image adds animated. A blog entry adds num and date, and a blog
     image adds uhd and truesize, which its manifest line used to carry. A
     media file has none of the three switches, because they are an
     image's. It has no size either when it is a sound: ow and oh are 0.

     nextImg is the blog's counter, for images and media files together:
     the id the next file takes. It never goes down. Once z999, the last
     id, is taken, it says "exhausted", which no tag or file can be named.

     A VERSION 1 FILE has no kind, no mime and no from. It is read as
     images, each with an empty from and the MIME type its extension
     gives, and the next write makes it version 2. A version this editor
     does not know is never written: the fields it cannot read would be
     lost. An older editor cannot read version 2 either, so the editor and
     the file are committed together.

     It loads by a script tag and not a fetch, so a page opened from disk
     reads it, and only when something asks: the editor turning on, the
     composer, a save or a publish. A reader never loads it. */
  var INDEX_FILE = "images.js";
  var INDEX_V = 2;
  var indexRec = null;        /* the record, once loaded */
  var indexLoading = null;    /* the one load, cached as its promise */
  var indexProblem = "";      /* why the file on the site must not be written, or "" */
  /* a counter's text: an id, or the word it says once the last id is taken */
  var COUNTER_TEXT = /^(?:[0-9a-z]\d{3}|exhausted)$/;

  function indexEmpty() { return { v: INDEX_V, stamp: "", nextImg: "0001", images: [] }; }

  /* "an image", "a video", "an audio file" or "a MIDI file", for a
     sentence about a kind */
  var KIND_WORDS = { image: "an image", video: "a video", audio: "an audio file", midi: "a MIDI file" };
  function kindWords(kind) { return own(KIND_WORDS, kind) || "a file of the kind \"" + kind + "\""; }

  /* AN IMAGE'S WORDS.

     What each place says about an image: its caption, then its alt text.
     The words are kept by place, the way used is, because the record has
     two writers that each see part of the site: a save sees the pages it
     writes and a publish the post it writes. Each replaces the words of
     the places it writes and touches no other place, so no writer has to
     read a page it did not come to write, and the words never swing
     between the two. A reader takes them as one string. */
  var WORDS_JOIN = " · ";
  /* One place's words from its parts, in order: each trimmed, an empty
     one dropped, and a repeat written once. */
  function phraseOf(parts) {
    var out = [];
    (parts || []).forEach(function (p) {
      p = String(p == null ? "" : p).trim();
      if (p && out.indexOf(p) === -1) out.push(p);
    });
    return out.join(WORDS_JOIN);
  }
  /* The words an entry keeps: a string for each place it is used, in the
     order used lists them. A place it is not used any more has no words,
     so a writer that takes a use away takes its words with it. */
  function wordsNormal(words, used) {
    var out = {};
    var w = words && typeof words === "object" ? words : {};
    used.forEach(function (u) {
      var s = w[u] == null ? "" : String(w[u]).trim();
      if (s) out[u] = s;
    });
    return out;
  }

  /* ONE ENTRY, TYPED. Every entry of the index and every entry the log
     keeps comes through here, so the two can never keep different fields.
     The fields come out in one order, so a line of the file changes only
     when a fact does.

     An entry with no kind is an image: version 1 knew no other kind. A
     kind that is there is kept as it is, a wrong one too, so entryProblem
     can name it. Nothing writes a wrong kind back as an image. */
  function entryNormal(e) {
    var s = e && typeof e === "object" ? e : {};
    var kind = s.kind == null || s.kind === "" ? "image" : String(s.kind);
    var type = String(s.type || "").toLowerCase();
    var n = { base: String(s.base || ""), kind: kind, type: type,
              mime: s.mime ? String(s.mime) : mimeOf(type, kind), from: String(s.from || ""),
              ow: +s.ow || 0, oh: +s.oh || 0, bytes: +s.bytes || 0 };
    if (kind === "image") n.animated = !!s.animated;
    n.added = String(s.added || "");
    n.used = (Array.isArray(s.used) ? s.used : []).map(String);
    n.words = wordsNormal(s.words, n.used);
    if (s.num) {
      n.num = String(s.num);
      n.date = String(s.date || "");
      if (kind === "image") { n.uhd = !!s.uhd; n.truesize = !!s.truesize; }
    }
    return n;
  }
  /* What is wrong with a typed entry, as a sentence, or "". The kind is
     one the engine knows, the extension is one that kind can have, and
     the MIME type is the one FORMATS gives the two. A media file is only
     ever a blog file, named by the blog's media scheme. */
  function entryProblem(n) {
    var name = n.base || "An entry with no base";
    if (!own(TAG_WORDS, n.kind)) return name + " is of the kind \"" + n.kind + "\", which this editor does not know.";
    var mime = mimeOf(n.type, n.kind);
    if (!mime) return name + " is " + kindWords(n.kind) + " with the extension \"" + n.type + "\", which the editor does not take for it.";
    if (n.mime !== mime) return name + " says " + n.mime + ", and " + kindWords(n.kind) + " with the extension ." + n.type + " is " + mime + ".";
    if (n.kind !== "image" && !(MEDIA_BASE.test(n.base) && n.num && n.base.slice(-4) === n.num)) {
      return name + " is " + kindWords(n.kind) + " without a blog media name, blog/YYMMDD_mediaNNNN.";
    }
    return "";
  }

  /* the record with every field present and typed, so a reader never
     asks whether a field is there */
  function indexNormal(rec) {
    var out = indexEmpty();
    if (rec && typeof rec === "object") {
      out.stamp = String(rec.stamp || "");
      out.nextImg = String(rec.nextImg || "0001");
      out.images = (Array.isArray(rec.images) ? rec.images : []).map(entryNormal);
    }
    return out;
  }
  /* What a record must be before it is written: a counter the editor can
     read, and every entry right. The first thing wrong, or "". */
  function recordProblem(r) {
    if (!COUNTER_TEXT.test(r.nextImg)) {
      return INDEX_FILE + " says the next id is \"" + r.nextImg + "\", which is not an id.";
    }
    for (var i = 0; i < r.images.length; i++) {
      var problem = entryProblem(r.images[i]);
      if (problem) return problem;
    }
    return "";
  }
  /* Whether the record a load found may be written again: "" when it may,
     or the reason it may not, written for the author. A file that set no
     record could not be read. A version above INDEX_V comes from a newer
     editor. A version 2 entry says its kind, and every entry is one the
     engine can serve. */
  function indexCheck(raw) {
    var never = " Nothing writes " + INDEX_FILE + " until it is fixed.";
    if (!raw || typeof raw !== "object" || !Array.isArray(raw.images)) {
      return INDEX_FILE + " is on the site and could not be read." + never + " Restore it from git.";
    }
    var v = raw.v == null ? 1 : Number(raw.v);
    if (!(v >= 1 && v % 1 === 0)) return INDEX_FILE + " says it is version \"" + raw.v + "\", which is not a version." + never;
    if (v > INDEX_V) {
      return INDEX_FILE + " is version " + v + ", and this editor reads versions 1 to " + INDEX_V + "." +
        " Nothing writes it until the editor is updated.";
    }
    for (var i = 0; i < raw.images.length; i++) {
      var e = raw.images[i];
      if (v >= 2 && !(e && e.kind)) return ((e && e.base) || "An entry") + " in " + INDEX_FILE + " does not say its kind." + never;
    }
    var problem = recordProblem(indexNormal(raw));
    return problem ? problem + never : "";
  }
  /* A generated file, loaded by a script tag: its one statement sets a
     window global, read once the tag has run. A page from disk can load a
     tag where it cannot fetch. Resolves false when the site has no such
     file yet.

     A month page sits in blog/, one step below the file. Over HTTP the
     address carries the moment, so a browser never answers with a cached
     copy: the counter in an old copy would number a photo twice. From
     disk there is no cache to fool, and a query would be a different file
     name to some systems. */
  function loadTag(file) {
    return new Promise(function (resolve) {
      var at = doc.body && doc.body.classList.contains("blog-month") ? "../" : "";
      var el = doc.createElement("script");
      el.src = at + file + (location.protocol === "file:" ? "" : "?t=" + Date.now());
      el.onload = function () { resolve(true); };
      el.onerror = function () { resolve(false); };
      doc.head.appendChild(el);
    });
  }
  /* A file the tag found and could not read still loads: a script with a
     fault fires load and sets nothing. The check names that, so it never
     becomes an empty index that the next write would put on the site. */
  function indexLoad() {
    if (!indexLoading) {
      indexLoading = (window.AMH_IMAGES ? Promise.resolve(true) : loadTag(INDEX_FILE)).then(function (found) {
        if (!found) console.info("[images] no " + INDEX_FILE + " on this site yet. The next save or publish writes it.");
        indexProblem = found ? indexCheck(window.AMH_IMAGES) : "";
        if (indexProblem) console.warn("[images] " + indexProblem);
        indexRec = indexNormal(window.AMH_IMAGES);
      });
    }
    /* the record as it stands, and not as the load found it: a write since
       then replaced it, and the next write builds on that one */
    return indexLoading.then(function () { return indexRec; });
  }
  /* Why no write may replace the file on the site, or "". A writer asks
     before it builds, and indexText refuses in any case. */
  function indexProblemNow() { return indexProblem; }
  function indexGet() { return indexRec; }
  /* the record a write leaves, kept as the current one so the next write
     builds on it */
  function indexSet(rec) { indexRec = indexNormal(rec); window.AMH_IMAGES = indexRec; return indexRec; }
  function indexEntry(base) {
    var hit = null;
    (indexRec ? indexRec.images : []).forEach(function (e) { if (e.base === base) hit = e; });
    return hit;
  }
  function indexBlog(num) {
    var hit = null;
    (indexRec ? indexRec.images : []).forEach(function (e) { if (e.num === num) hit = e; });
    return hit;
  }
  /* the { num: entry } map the blog's renderer and composer take */
  function indexBlogMap() {
    var out = {};
    (indexRec ? indexRec.images : []).forEach(function (e) { if (e.num) out[e.num] = e; });
    return out;
  }
  /* an entry for a file the engine took, at its base path */
  function indexFromPhoto(photo, base, added) {
    return entryNormal({ base: base, kind: kindOfRow(photo), type: photo.type, mime: mimeOfRow(photo),
                         from: photo.from || "", ow: photo.ow, oh: photo.oh, bytes: photo.bytes,
                         animated: !!photo.animated, added: added, used: [], words: {} });
  }
  /* An entry's words as one string: every place's, each phrase once. */
  function indexWords(entry) {
    var parts = [];
    var w = entry && entry.words ? entry.words : {};
    ((entry && entry.used) || Object.keys(w)).forEach(function (u) {
      if (w[u]) parts = parts.concat(String(w[u]).split(WORDS_JOIN));
    });
    return phraseOf(parts);
  }
  /* The text a stamp is taken over: the images and the counter, and not
     the date or the stamp itself, so an unchanged record keeps its stamp
     and an unchanged file makes no diff. */
  function indexStampText(rec) {
    var r = indexNormal(rec);
    return r.nextImg + "\n" + r.images.map(function (e) { return JSON.stringify(e); }).join("\n");
  }
  /* The first line of a generated file: the day, the stamp and the rule. */
  function genHeader(stamp) {
    var day = new Date();
    var when = day.getFullYear() + "-" + ("0" + (day.getMonth() + 1)).slice(-2) + "-" + ("0" + day.getDate()).slice(-2);
    return "/* GENERATED by the site editor on " + when + "; stamp:" + stamp +
      "; hand edits are overwritten */\n";
  }
  /* The file's text: a header, then one statement with one entry a line,
     so a diff moves one line when one file changes. It throws, and writes
     nothing, for a file on the site that must not be replaced and for a
     record that is wrong: every writer builds its text here, so no writer
     can put either on the site. */
  function indexText(rec, stamp) {
    if (indexProblem) throw new Error(indexProblem);
    var r = indexNormal(rec);
    var problem = recordProblem(r);
    if (problem) throw new Error(problem + " Nothing was written.");
    r.stamp = String(stamp || "");
    var lines = r.images.map(function (e) { return JSON.stringify(e); });
    return genHeader(r.stamp) +
      "window.AMH_IMAGES = {\"v\":" + INDEX_V + ",\"stamp\":" + JSON.stringify(r.stamp) +
      ",\"nextImg\":" + JSON.stringify(r.nextImg) + ",\"images\":[" +
      (lines.length ? "\n" + lines.join(",\n") + "\n" : "") + "]};\n";
  }
  /* AN ENTRY'S FILES, keyed as a held photo's are: an image's three, from
     the renditions, or a media file's one, keyed source. The display copy
     is always a JPG, and an original keeps its type. pathsOf gives the
     same paths as a list, in that order.

     Every path a save, a bundle, a Super Delete or a Restore names comes
     from here, so no path is made up for a kind that has no such file. */
  function filesOf(entry) {
    if (entry && entry.kind && entry.kind !== "image") return { source: entry.base + "." + entry.type };
    var out = {};
    RENDITIONS.forEach(function (r) {
      out[r.key] = entry.base + r.suffix + "." + (r.type ? TYPES[r.type] : entry.type);
    });
    return out;
  }
  function pathsOf(entry) {
    var files = filesOf(entry);
    return Object.keys(files).map(function (k) { return files[k]; });
  }
  /* Every site image a page's regions show, in the order the page shows
     them: { base, where, tag }, where is "path#slug" and tag is the whole
     <img> tag. Read from the page's text, region by region, so a page
     that is not on screen can answer. An image inside a nested region is
     the innermost region's. Only the site scheme counts: a blog image's
     use is its post, which the publish records, and the stream on
     blog.html is a copy. usageOf and wordsOf both read this, so the places
     an image is used and the places its words come from cannot differ. */
  function siteImagesOf(pageText, path) {
    var text = String(pageText || "");
    var regions = [];
    var re = /<!--\[edit:([\w-]+)\]-->([\s\S]*?)<!--\[\/edit:\1\]-->/g, m;
    while ((m = re.exec(text))) {
      regions.push({ slug: m[1], start: m.index, end: m.index + m[0].length });
      re.lastIndex = m.index + 1;   /* a region inside this one starts inside it */
    }
    var out = [];
    /* a quoted value is stepped over whole: the page writes a > in a
       caption as it is, and it must not end the tag */
    var im = /<img\b(?:[^>"']|"[^"]*"|'[^']*')*>/g, i;
    while ((i = im.exec(text))) {
      var orig = /\sdata-original="([^"]*)"/.exec(i[0]);
      if (!orig) continue;
      var base = baseOf(orig[1]);
      if (base.indexOf(SITE_DIR) !== 0) continue;
      var best = null;
      regions.forEach(function (r) {
        if (i.index >= r.start && i.index < r.end && (!best || r.end - r.start < best.end - best.start)) best = r;
      });
      if (best) out.push({ base: base, where: path + "#" + best.slug, tag: i[0] });
    }
    return out;
  }
  /* Where a page's regions show the site's images: { base: ["path#slug"] }. */
  function usageOf(pageText, path) {
    var out = {};
    siteImagesOf(pageText, path).forEach(function (s) {
      if (!out[s.base]) out[s.base] = [];
      if (out[s.base].indexOf(s.where) === -1) out[s.base].push(s.where);
    });
    return out;
  }
  /* One attribute of a tag, as its text: the page escapes what it writes */
  function attrOf(tag, name) {
    var m = new RegExp("\\s" + name + '="([^"]*)"').exec(tag);
    return m ? m[1].replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">").replace(/&amp;/g, "&") : "";
  }
  /* What a page's regions say about the site's images:
     { base: { "path#slug": words } }, each place's caption and alt text.
     An image a region shows twice gives that place the words of both. */
  function wordsOf(pageText, path) {
    var parts = {};
    siteImagesOf(pageText, path).forEach(function (s) {
      var byPlace = parts[s.base] || (parts[s.base] = {});
      var list = byPlace[s.where] || (byPlace[s.where] = []);
      list.push(attrOf(s.tag, "data-caption"), attrOf(s.tag, "alt"));
    });
    var out = {};
    Object.keys(parts).forEach(function (base) {
      Object.keys(parts[base]).forEach(function (where) {
        var said = phraseOf(parts[base][where]);
        if (!said) return;
        (out[base] || (out[base] = {}))[where] = said;
      });
    });
    return out;
  }

  /* THE LOG OF SUPER DELETES.

     superdeleted.js, at the repo root, is committed with the site. It
     holds one line for each file Super Delete moved out: when, the base,
     the paths, the entry as it was, and when it was restored, or "". An
     image's line names its three files and a media file's line its one.
     A line is appended and never removed, so the log is the history, and
     each line names the files to purge from git history if that is ever
     wanted. Restore reads the entry back from it. It loads as the index
     does, on demand, by a script tag.

       window.AMH_SUPERDELETED = { v: 2, stamp, deleted: [ line ] }

     Its versions follow the index's. A version 1 line is an image, and
     a version this editor does not know is never written. */
  var LOG_FILE = "superdeleted.js";
  var LOG_V = 2;
  var logRec = null;
  var logLoading = null;
  var logProblem = "";

  function logEmpty() { return { v: LOG_V, stamp: "", deleted: [] }; }
  function logNormal(rec) {
    var out = logEmpty();
    if (rec && typeof rec === "object") {
      out.stamp = String(rec.stamp || "");
      out.deleted = (Array.isArray(rec.deleted) ? rec.deleted : []).map(function (d) {
        var s = d && typeof d === "object" ? d : {};
        return { at: String(s.at || ""), base: String(s.base || ""),
                 paths: (Array.isArray(s.paths) ? s.paths : []).map(String),
                 entry: entryNormal(s.entry),
                 restored: String(s.restored || "") };
      });
    }
    return out;
  }
  /* The first entry of the log that is wrong, as a sentence, or "". */
  function logEntriesProblem(r) {
    for (var i = 0; i < r.deleted.length; i++) {
      var problem = entryProblem(r.deleted[i].entry);
      if (problem) return problem;
    }
    return "";
  }
  /* Whether the log a load found may be written again, by the index's
     rules: "" when it may, or the reason it may not. */
  function logCheck(raw) {
    var never = " Nothing writes " + LOG_FILE + " until it is fixed.";
    if (!raw || typeof raw !== "object" || !Array.isArray(raw.deleted)) {
      return LOG_FILE + " is on the site and could not be read." + never + " Restore it from git.";
    }
    var v = raw.v == null ? 1 : Number(raw.v);
    if (!(v >= 1 && v % 1 === 0)) return LOG_FILE + " says it is version \"" + raw.v + "\", which is not a version." + never;
    if (v > LOG_V) {
      return LOG_FILE + " is version " + v + ", and this editor reads versions 1 to " + LOG_V + "." +
        " Nothing writes it until the editor is updated.";
    }
    for (var i = 0; i < raw.deleted.length; i++) {
      var d = raw.deleted[i];
      if (v >= 2 && !(d && d.entry && d.entry.kind)) return "A line in " + LOG_FILE + " does not say its kind." + never;
    }
    var problem = logEntriesProblem(logNormal(raw));
    return problem ? problem + never : "";
  }
  function logLoad() {
    if (!logLoading) {
      logLoading = (window.AMH_SUPERDELETED ? Promise.resolve(true) : loadTag(LOG_FILE)).then(function (found) {
        logProblem = found ? logCheck(window.AMH_SUPERDELETED) : "";
        if (logProblem) console.warn("[images] " + logProblem);
        logRec = logNormal(window.AMH_SUPERDELETED);
      });
    }
    return logLoading.then(function () { return logRec; });
  }
  function logProblemNow() { return logProblem; }
  function logGet() { return logRec; }
  function logSet(rec) { logRec = logNormal(rec); window.AMH_SUPERDELETED = logRec; return logRec; }
  /* the moment a line records: local time, YYMMDD-HHMMSS */
  function logNow() {
    var d = new Date();
    function two(n) { return ("0" + n).slice(-2); }
    return String(d.getFullYear()).slice(2) + two(d.getMonth() + 1) + two(d.getDate()) + "-" +
      two(d.getHours()) + two(d.getMinutes()) + two(d.getSeconds());
  }
  function logStampText(rec) {
    return logNormal(rec).deleted.map(function (d) { return JSON.stringify(d); }).join("\n");
  }
  /* The file's text. It throws, and writes nothing, on the index's terms. */
  function logText(rec, stamp) {
    if (logProblem) throw new Error(logProblem);
    var r = logNormal(rec);
    var problem = logEntriesProblem(r);
    if (problem) throw new Error(problem + " Nothing was written.");
    r.stamp = String(stamp || "");
    var lines = r.deleted.map(function (d) { return JSON.stringify(d); });
    return genHeader(r.stamp) +
      "window.AMH_SUPERDELETED = {\"v\":" + LOG_V + ",\"stamp\":" + JSON.stringify(r.stamp) + ",\"deleted\":[" +
      (lines.length ? "\n" + lines.join(",\n") + "\n" : "") + "]};\n";
  }

  /* ==========================================================
     6. CLEANUP
     ========================================================== */

  /* A box let a prepared photo go without adding it. A held photo is not
     the box's to release: the store lets that go. */
  function letGo(photo) {
    if (!photo || held[photo.base] === photo) return;
    revokeLater(photo.urls);
  }

  /* Stop holding every photo no edit shows. used is { base: true } for
     every base path an edit still shows, on any page. A record another
     tab left is removed only once it is old enough that the tab is surely
     closed. */
  function prune(used) {
    used = used || {};
    Object.keys(held).forEach(function (base) {
      if (used[base]) return;
      revokeLater(held[base].urls);
      delete held[base];
    });
    var now = Date.now(), mine = tab();
    idb("readwrite", function (st) {
      var walk = st.openCursor();
      walk.onsuccess = function () {
        var at = walk.result;
        if (!at) return;
        var row = at.value || {};
        var gone = row.tab === mine ? !used[row.base] : now - (row.at || 0) > STALE_MS;
        if (gone) at.delete();
        at.continue();
      };
      return null;
    }).then(null, function () {});
  }

  /* Every file the engine named that a text mentions, sorted, once each. */
  function named(text) {
    var seen = {};
    (String(text || "").match(NAMED_IN_TEXT) || []).forEach(function (path) {
      if (isEngineName(path)) seen[path] = true;
    });
    return Object.keys(seen).sort();
  }

  /* The files nothing uses.

     listing is every path to consider, and texts is every page and month
     file that could point at one. A path is unused when its name is one
     the engine gives and no text contains it. A file with any other name is
     never counted, whatever its folder: that rule is the reason the names
     carry a hash. This finds and never moves: a file the engine wrote stays
     until Super Delete moves it. */
  function unused(listing, texts) {
    texts = texts || [];
    return (listing || []).filter(function (path) {
      if (!isEngineName(path)) return false;
      for (var i = 0; i < texts.length; i++) {
        if (String(texts[i]).indexOf(path) !== -1) return false;
      }
      return true;
    }).sort();
  }

  /* ==========================================================
     7. PUBLIC API
     ----------------------------------------------------------
     AMH.images is the engine, for tool.js and every consumer.
     The settings are read from here each time they are used, so
     the console and the tests can try a lower Git limit, another
     rendition or another small size without an edit to this file.
     ========================================================== */
  var api = {
    RENDITIONS: RENDITIONS,
    GIT_FILE_LIMIT_MB: GIT_FILE_LIMIT_MB,
    SMALL_IMAGE_PX: SMALL_IMAGE_PX,
    MAX_SIDE: MAX_SIDE,
    /* the image formats a picker takes; a media file is the blog's alone */
    ACCEPT: Object.keys(TYPES).join(","),
    DELETE_DIR: DELETE_DIR,
    /* every extension the engine takes, and the kinds each can be. See
       FORMATS in section 2. */
    FORMATS: FORMATS,
    kindsOf: kindsOf,          /* the kinds an extension can be */
    mimeOf: mimeOf,            /* the MIME type of an extension as a kind, or "" */
    tagWordOf: tagWordOf,      /* the word a blog tag names a kind with */
    kindWords: kindWords,      /* "a video", for a sentence about a kind */

    intake: intake,            /* a file, made into a photo */
    hold: hold,                /* a page shows it: keep it until a save */
    letGo: letGo,              /* a box closed without it */
    recall: recall,            /* this tab's photos, back from IndexedDB */
    rename: rename,            /* a held photo under another name */
    prune: prune,              /* stop holding what no edit shows */
    photo: photoFor,           /* the held photo for a base path */
    files: files,              /* the bytes a save writes */
    saved: saved,              /* a save wrote these paths */
    list: list,                /* what is held, without the bytes */

    attrs: attrs,              /* an entry, as <img> attributes */
    read: read,                /* an <img>, as an entry's file fields */
    fields: fieldsOf,          /* a photo, as an entry's file fields */
    defaults: defaults,        /* the two switches a new photo starts with */
    preview: previewOf,        /* the same, on blob: URLs */
    baseOf: baseOf,            /* a file path, as its photo's base path */
    copySize: copySize,        /* the size a copy is drawn at, from the original's */
    /* the image index: images.js, loaded on demand and written by a save
       or a publish. See the index above for the record's shape. */
    index: {
      file: INDEX_FILE,
      load: indexLoad,         /* the record, as a promise; loads the file once */
      get: indexGet,           /* the record, or null before load() settled */
      set: indexSet,           /* the record a write left */
      problem: indexProblemNow, /* why the file on the site must not be written, or "" */
      check: indexCheck,       /* the same answer for any record, as a file holds it */
      entry: indexEntry,       /* one entry by base path */
      blog: indexBlog,         /* one blog entry by number */
      blogMap: indexBlogMap,   /* { num: entry }, the map the blog takes */
      fromPhoto: indexFromPhoto,
      typed: entryNormal,      /* one entry with every field, typed */
      entryProblem: entryProblem, /* what is wrong with a typed entry, or "" */
      text: indexText,         /* the file's text, for a stamp; throws for a refused write */
      stampText: indexStampText,
      words: indexWords        /* an entry's words, as one string */
    },
    phrase: phraseOf,          /* one place's words, from its caption and alt */
    wordsOf: wordsOf,          /* what a page's regions say about the site's images */
    /* the log of super deletes: superdeleted.js, loaded on demand and
       written by Super Delete and Restore. See the log above. */
    log: {
      file: LOG_FILE,
      load: logLoad,           /* the log, as a promise; loads the file once */
      get: logGet,             /* the log, or null before load() settled */
      set: logSet,             /* the log a write left */
      problem: logProblemNow,  /* why the file on the site must not be written, or "" */
      check: logCheck,         /* the same answer for any log, as a file holds it */
      text: logText,           /* the file's text, for a stamp; throws for a refused write */
      stampText: logStampText,
      now: logNow              /* the moment a line records */
    },
    filesOf: filesOf,          /* an entry's files, keyed: an image's three, a media file's source */
    pathsOf: pathsOf,          /* the same paths, in order */
    usageOf: usageOf,          /* where a page's regions show the site's images */
    named: named,              /* the engine's file names in a text */
    unused: unused,            /* the engine's files that nothing uses */
    slug: slugOf,
    hash: hashBytes,
    cut: cutMeta               /* bytes, with the metadata cut */
  };
  AMH.images = api;
})();
