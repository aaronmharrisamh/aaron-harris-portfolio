/* ============================================================
   site.config.js - this site's facts, for the engine in
   libraries/harrisxrwebengine/.

   Every page loads it second, after the engine's release.js and
   before site.js. The engine reads these values and never writes
   them. A page without this file still reads, and the editor refuses
   to open and names the missing file.

     siteId          Permanent. Names this site's browser storage and
                     its repo folder.
     engineVersion   The engine release this site expects. site.js
                     compares it with release.js.
     siteName, brand, description, avatar, ogImage, ogImageAlt
                     What a generated month page and the feed say
                     about the site. brand is the fallback when the
                     page's wordmark cannot be read, because the
                     wordmark is editable copy. ogImage is a 1200 by
                     630 image at the site root.
     publicUrl       The site's canonical address, with a trailing
                     slash.
     pages           The pages the editor may read and write, as paths
                     from the site root. The sitemap lists them.
     sharedSlugs     The regions that read the same on every page. An
                     edit to one is staged for every page.
     blog            True when the site has blog.html and blog/.
   ============================================================ */
window.AMH = window.AMH || {};
AMH.config = {
  siteId: "amh",
  engineVersion: "1.0.1",
  siteName: "Aaron M. Harris",
  brand: "AARON M. HARRIS",
  description: "Thoughts, musings, and fun new developments from Aaron M. Harris",
  avatar: "aaron-portfolio-portrait-transparent.png",
  ogImage: "og-image.png",
  ogImageAlt: "Aaron M. Harris, Technical Lead & Solutions Architect.",
  publicUrl: "https://aaronmichaelharris.com/",
  pages: [
    { path: "index.html", label: "Home" },
    { path: "gallery.html", label: "Gallery" },
    { path: "blog.html", label: "Blog" }
  ],
  sharedSlugs: ["brand-title", "brand-sub", "nav-work", "nav-gallery", "nav-blog", "nav-about",
    "nav-contact", "contact-eyebrow", "contact-h2", "contact-email", "contact-btn-email",
    "contact-btn-call", "contact-btn-txt", "contact-btn-resume", "endbar"],
  blog: true
};
