/* ============================================================
   tools/e2e/fixtures/media.js - media files for the suite, made in the
   page. The harness reads this file and runs it in the page under test.

   No binary fixture is committed. Each file is made from bytes here, so
   a check can say exactly what a file holds:

     wav(seconds)       a PCM WAV of a 440 Hz tone, which a browser plays
     midi()             a MIDI file of one note
     mp4(handlers)      an MP4 header: ftyp, and a moov box with one track
                        for each handler, "vide" or "soun"; with none, no
                        moov box at all, so the header says nothing
     webm(types)        a WebM header with one track of each type, 1 a
                        picture and 2 sound
     ogg(codecs)        Ogg first pages for "theora", "vorbis" or "opus"
     mp3()              an ID3 tag, then MPEG frames
     record(kind, mime, ms)  a recording the browser makes: a video from
                        a canvas. Resolves null when it cannot.

   The headers alone are not playable: a check that needs a player to
   play uses the WAV, or a recording.
   ============================================================ */
window.__media = (function () {
  function ascii(s) { return Array.prototype.map.call(s, function (c) { return c.charCodeAt(0); }); }
  function cat() {
    var out = [];
    Array.prototype.forEach.call(arguments, function (a) { out = out.concat(Array.prototype.slice.call(a)); });
    return out;
  }
  function zeros(n) { var z = []; for (var i = 0; i < n; i++) z.push(0); return z; }
  function u32(n) { return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]; }
  function box(type, payload) { return cat(u32(8 + payload.length), ascii(type), payload); }
  function file(bytes, name, type) { return new File([new Uint8Array(bytes)], name, { type: type || "" }); }
  function wav(seconds, rate) {
    rate = rate || 8000;
    var n = Math.floor(seconds * rate), data = n * 2;
    var b = new ArrayBuffer(44 + data), v = new DataView(b);
    function s(o, str) { for (var i = 0; i < str.length; i++) v.setUint8(o + i, str.charCodeAt(i)); }
    s(0, "RIFF"); v.setUint32(4, 36 + data, true); s(8, "WAVE"); s(12, "fmt "); v.setUint32(16, 16, true);
    v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true);
    v.setUint16(32, 2, true); v.setUint16(34, 16, true); s(36, "data"); v.setUint32(40, data, true);
    for (var i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.round(Math.sin(i / rate * 2 * Math.PI * 440) * 8000), true);
    return Array.prototype.slice.call(new Uint8Array(b));
  }
  function midi() {
    var track = [0x00, 0x90, 60, 64, 0x60, 0x80, 60, 0, 0x00, 0xFF, 0x2F, 0x00];
    return cat(ascii("MThd"), u32(6), [0, 0, 0, 1, 0, 96], ascii("MTrk"), u32(track.length), track);
  }
  function mp4(handlers) {
    var ftyp = box("ftyp", cat(ascii("isom"), [0, 0, 2, 0], ascii("isomiso2mp41")));
    if (!handlers) return cat(ftyp, box("free", zeros(64)), box("mdat", zeros(256)));
    var traks = [];
    handlers.forEach(function (h) {
      traks = traks.concat(box("trak", box("mdia", box("hdlr", cat([0, 0, 0, 0, 0, 0, 0, 0], ascii(h), zeros(12), [0])))));
    });
    return cat(ftyp, box("moov", traks), box("mdat", zeros(256)));
  }
  /* an EBML element with an eight-byte size */
  function el(id, payload) { return cat(id, [0x01, 0, 0, 0, 0, 0, 0, payload.length], payload); }
  function webm(types) {
    var head = el([0x1A, 0x45, 0xDF, 0xA3], el([0x42, 0x82], ascii("webm")));
    var entries = [];
    types.forEach(function (t, i) { entries = entries.concat(el([0xAE], cat(el([0xD7], [i + 1]), el([0x83], [t])))); });
    return cat(head, [0x18, 0x53, 0x80, 0x67, 0x01, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF],
      el([0x16, 0x54, 0xAE, 0x6B], entries), zeros(64));
  }
  function ogg(codecs) {
    var out = [];
    codecs.forEach(function (c, i) {
      var packet = c === "theora" ? cat([0x80], ascii("theora"), zeros(35))
        : c === "vorbis" ? cat([0x01], ascii("vorbis"), zeros(23))
        : c === "opus" ? cat(ascii("OpusHead"), [1, 2], zeros(9)) : zeros(20);
      out = out.concat(ascii("OggS"), [0, 2], zeros(8), [i + 1, 0, 0, 0], zeros(4), zeros(4), [1, packet.length], packet);
    });
    return out.concat(zeros(64));
  }
  function mp3() {
    var frame = cat([0xFF, 0xFB, 0x90, 0x00], zeros(413));
    return cat(ascii("ID3"), [4, 0, 0, 0, 0, 0, 0], frame, frame, frame, frame);
  }
  function record(kind, mime, ms) {
    return new Promise(function (resolve) {
      if (kind !== "video" || !window.MediaRecorder || !MediaRecorder.isTypeSupported(mime)) { resolve(null); return; }
      var cv = document.createElement("canvas");
      cv.width = 160; cv.height = 90;
      var cx = cv.getContext("2d");
      var t0 = Date.now();
      var paint = function () { cx.fillStyle = "hsl(" + (((Date.now() - t0) / 4) % 360) + ",70%,50%)"; cx.fillRect(0, 0, 160, 90); };
      paint();
      var iv = setInterval(paint, 40);
      try {
        var rec = new MediaRecorder(cv.captureStream(15), { mimeType: mime });
        var parts = [];
        rec.ondataavailable = function (e) { if (e.data && e.data.size) parts.push(e.data); };
        rec.onstop = function () { clearInterval(iv); resolve(parts.length ? new Blob(parts, { type: mime }) : null); };
        rec.start(200);
        setTimeout(function () { try { rec.stop(); } catch (e) { clearInterval(iv); resolve(null); } }, ms);
      } catch (err) { clearInterval(iv); resolve(null); }
    });
  }
  /* a file's bytes as base64, for a check that compares them */
  function base64(blob) {
    return blob.arrayBuffer().then(function (buf) {
      var b = new Uint8Array(buf), s = "";
      for (var i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
      return btoa(s);
    });
  }
  return { ascii: ascii, cat: cat, zeros: zeros, file: file, wav: wav, midi: midi, mp4: mp4, webm: webm,
           ogg: ogg, mp3: mp3, record: record, base64: base64 };
})();
