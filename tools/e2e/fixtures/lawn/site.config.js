/* ============================================================
   site.config.js - the facts of Greenline Mowing, the e2e suite's
   second site on the engine.

   The engine reads this file and never writes it. The fields are
   the ones the engine's README documents.

   Rule: engineVersion is the version in the engine's release.js.
   An engine release sets both in the same commit, which is the
   upgrade procedure performed on this site every time.
   ============================================================ */
window.AMH = window.AMH || {};
AMH.config = {
  siteId: "lawn",
  engineVersion: "1.0.1",
  siteName: "Greenline Mowing",
  brand: "GREENLINE MOWING",
  publicUrl: "https://greenline.example/",
  description: "Lawn care for the north side.",
  avatar: "",
  ogImage: "",
  ogImageAlt: "",
  pages: [
    { path: "index.html", label: "Home" },
    { path: "services/mowing.html", label: "Mowing" },
    { path: "photos.html", label: "Photos" }
  ],
  sharedSlugs: ["brand-title", "nav-home", "nav-mowing", "nav-photos", "endbar"],
  blog: false
};
