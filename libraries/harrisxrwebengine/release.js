/* ============================================================
   release.js - the engine release this folder holds.

   Every page loads it first, before the host's site.config.js and
   before site.js. It creates window.AMH, the one global the engine
   shares, and names the release in AMH.release:

     id        the engine's name
     version   the release, in Semantic Versioning: a patch fixes,
               a minor adds, and a major breaks a documented contract
     root      the absolute URL of this folder, with a trailing slash

   This file is the one place the engine's version is written. A site
   names the release it expects in its site.config.js, and site.js
   compares the two before the editor can open.
   ============================================================ */
(function () {
  "use strict";
  var AMH = window.AMH = window.AMH || {};
  /* The address of this file while it runs. A deferred classic script
     has one, so no other file has to know where the folder was put. */
  var src = (document.currentScript && document.currentScript.src) || "";
  AMH.release = {
    id: "harrisxrwebengine",
    version: "1.0.0",
    root: src.replace(/[^\/]*$/, "")
  };
})();
