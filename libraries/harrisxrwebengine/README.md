# HarrisXR Web Engine

This folder is the engine, and this file is its integration guide. It is
written so that a person, or an AI, can put the engine under a new site
from this file alone. The worked example in section 10 is a site built
from this guide, and the engine's test suite runs it on every commit.

## 1. What the engine is

Pages that edit themselves in the browser. The owner opens a page, turns
on the editor, and changes copy, photos, galleries and posts. The engine
hands back the changed files, as a zip or written straight into the
site's folder, and the owner commits them. Reading works from disk, and
editing works over HTTP or through the file hand-off.

What it is not: there is no server, no build step, no database, no CMS,
no accounts and no payments. Nothing reaches the site except as files the
owner commits.

The engine's namespace is `window.AMH`, and its console entry is
`window.edit`. The name `AMH` is the engine's own. It is not a claim on
the site that uses it.

## 2. The layout

```
<site root>/
  libraries/harrisxrwebengine/   this folder, whole
  site.config.js                 the site's facts
  site.css                       the site's style and theme
  index.html  ...                the site's pages, at any depth
```

| File | Job |
| --- | --- |
| `release.js` | The release: its id, its version, and the address of this folder. The one place the version is written. |
| `engine.css` | The style of everything the engine draws or drives, and a default for every theme token. |
| `site.js` | Shared page behavior, the site root, the pin check, the site's storage names, and the paths from a page to the root and back. |
| `work.js` | The carousels, the players, the deep-dive drawer and the lightbox. |
| `imagesengine.js` | The image engine: intake, the files held until a save, the image index, the log of super deletes, and the grammar of the tag that places a file in a post. |
| `blog.js` | The blog reader: the stream, the month chain and find. |
| `markdown.js` | The Markdown renderer. |
| `gallery.js` | The gallery page's tile packer and its editor. |
| `tool.js` | The editor, the splice and the export. It reaches the blog composer only through the slot the composer fills, `AMH.tool.blog`. |
| `publish.js` | The blog composer and the publish bundle. It fills the editor's slot when it loads. |
| `CHANGES.md` | The release notes: each release, newest first, with the summary of the commit that made it. |

Rule: a site takes this folder whole and never edits it in place.
A fix goes into the engine and comes back to the site as a release.

**The site root.** `site.js` finds the root from the address of this
folder: the root is two folders above it. A site that keeps this folder
somewhere else names its root in `site.config.js` as `siteRoot`. A page
can be at any depth below the root.

## 3. Load order

Every page links the engine's style first and the site's second, so the
site's rules win a tie and its tokens set the theme:

```html
<link rel="stylesheet" href="libraries/harrisxrwebengine/engine.css" />
<link rel="stylesheet" href="site.css" />
```

Every page then loads, with `defer`, `release.js`, `site.config.js`, and
its trunks from this folder. These are the sets, in order:

| Page | Trunks, after `release.js` and `site.config.js` |
| --- | --- |
| A page of copy and carousels | `site.js`, `work.js`, `imagesengine.js`, `tool.js` |
| A page with deep dives in Markdown | `site.js`, `work.js`, `imagesengine.js`, `markdown.js`, `tool.js` |
| A gallery page | `site.js`, `work.js`, `imagesengine.js`, `tool.js`, `gallery.js` |
| `blog.html` | `site.js`, `work.js`, `imagesengine.js`, `blog.js`, `markdown.js`, `tool.js`, `publish.js` |
| A month page in `blog/` | `site.js`, `work.js`, `imagesengine.js`, `blog.js`, `tool.js`, `publish.js` |

A page in a folder writes each path from where it is. This is the head
of a page one folder below the root:

```html
<link rel="stylesheet" href="../libraries/harrisxrwebengine/engine.css" />
<link rel="stylesheet" href="../site.css" />
<script defer src="../libraries/harrisxrwebengine/release.js"></script>
<script defer src="../site.config.js"></script>
<script defer src="../libraries/harrisxrwebengine/site.js"></script>
<script defer src="../libraries/harrisxrwebengine/work.js"></script>
<script defer src="../libraries/harrisxrwebengine/imagesengine.js"></script>
<script defer src="../libraries/harrisxrwebengine/tool.js"></script>
```

The tags are classic scripts, never modules. A browser refuses to load a
module from disk. A trunk that follows `tool.js` registers itself with the
editor, which is why it follows. The composer writes each month page, so a
site never writes that set by hand.

## 4. site.config.js

The site's facts. Every page loads it second. The engine reads it and
never writes it. A page without it still reads, and the editor refuses to
open and names the missing file.

```js
window.AMH = window.AMH || {};
AMH.config = {
  siteId: "lawn",
  engineVersion: "1.1.0",
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
```

| Field | Contract |
| --- | --- |
| `siteId` | Permanent. Names the site's browser storage and its repo folder. A new id loses what the browser keeps under the old one. |
| `engineVersion` | The exact release the site expects. `site.js` compares it with `release.js`. |
| `siteName`, `brand`, `description`, `avatar`, `ogImage`, `ogImageAlt` | What a generated month page and the feed say about the site. `brand` is the fallback when the page's wordmark cannot be read, because the wordmark is editable copy. `ogImage` is a 1200 by 630 image at the root. A site with no blog may leave the last three empty. |
| `publicUrl` | The site's canonical address, with a trailing slash. |
| `pages` | The pages the editor may read and write, as paths from the root. The first is the page a repo folder must hold. |
| `sharedSlugs` | The regions that read the same on every page. An edit to one is written to every page that carries it. |
| `blog` | `true` when the site has `blog.html` and `blog/`. |
| `siteRoot` | Optional. The site's absolute address, for a site that keeps this folder somewhere other than `libraries/harrisxrwebengine/`. |

## 5. The theme

`engine.css` reads these tokens from `:root` and gives each one a default,
so a site that sets none still gets a readable engine. A site sets any of
them in the `:root` of its own `site.css`, which loads second and wins.

| Group | Tokens | What they paint |
| --- | --- | --- |
| Surfaces | `--bg`, `--bg-deep`, `--panel`, `--panel-2`, `--line`, `--line-soft` | The page's ground, the panels the editor and the viewers draw on, and the lines between parts. |
| Text | `--text`, `--text-soft`, `--muted`, `--dim` | Four text colors, strongest first. Each must read on every surface. |
| Accent | `--accent`, `--accent-bright`, `--accent-deep`, `--accent-glow`, `--accent-faint` | The one color that marks what acts, and its lighter, darker, glowing and faint forms. |
| Second colors | `--c-orange`, `--c-yellow`, `--c-lime` | The editor's marks: orange for an edited region, a warning or a move that deletes, and yellow for work not yet saved. Lime is in the contract for the site's own use. |
| Type | `--font` | The font stack of everything the engine draws. |
| Space | `--section-pad`, `--gutter`, `--maxw` | A section's padding, the page's side gutter, and the widest a column grows. |
| Shape and motion | `--radius`, `--radius-sm`, `--ease`, `--ease-soft` | Corner radii and the two easing curves. |

A custom property that a part of the engine sets on its own element is
internal, and a site does not set it.

## 6. The page contract

**Regions.** A region the editor may change is a pair of comments around
exactly one element:

```html
<!--[edit:home-intro]-->
<p>We mow, edge and clear leaves.</p>
<!--[/edit:home-intro]-->
```

The editor replaces what is between the two markers and nothing else, so
every byte outside a region stays as the file holds it. A slug is unique
on its page. A pair nests at most one level deep, which is a deep dive's
carousel inside its deep dive. An element marked `data-ced="generated"`
belongs to the composer, and the editor opens it read-only.

**Lists.** A run of blocks the editor may reorder is a list, and each
block is an item. An item sits directly inside its list, lists do not
nest, and an item id is permanent:

```html
<!--[list:services]-->
<!--[item:mow]-->
<article class="service"> ... </article>
<!--[/item:mow]-->
<!--[/list:services]-->
```

**Shared regions.** A slug in `sharedSlugs` carries the same bytes on
every page. An edit to it on one page is written to all of them.

Rule: a shared region holds no path. The editor writes the same bytes to
every page, and one path leads to a different file at each depth. Keep a
link's address outside the markers, and only its label inside:

```html
<a href="../photos.html">
  <!--[edit:nav-photos]-->
  <span>Photos</span>
  <!--[/edit:nav-photos]-->
</a>
```

A path in a shared region works while every page that carries it is at
the root. It breaks when a page moves into a folder.

**Paths.** The engine keeps every path as a path from the site root, and
writes it on each page from that page: `img/work/lawn-4k2x9a.jpg` is
written as `../img/work/lawn-4k2x9a.jpg` on a page one folder down. A photo
the engine takes in becomes three files in `img/work/`: a display copy, a
small copy and the original. An image under `img/seed/` is a placeholder:
it shows only while its carousel holds no photo of its own, and the first
photo added takes its place.

**The chrome.** These ids are optional. `site.js` drives each one that a
page has and ignores each one it does not: `#header` and `#progress`, the
header's look and the scroll bar; `.hero__portrait`, whose scroll decides
the header's look; `#navToggle`, `#nav` and `#navOverlay`, the drawer on a
narrow screen. A nav link whose address is the page's own is marked
`aria-current="page"`.

**The footer.** A page may close with `<footer class="site-footer">`,
after `main`. Keep it the same on every page and list its regions in
`sharedSlugs`, and an edit to it reaches every page. On a site with a
blog, a month page carries it too: see section 7.

**The carousel.** A plain list of images. `work.js` builds the carousel,
its arrows, its dots and its lightbox from it:

```html
<!--[edit:mow-gallery]-->
<div class="gallery">
  <img src="../img/yard-1.png" loading="lazy" alt="A striped lawn."
       data-caption="After a weekly mow" />
</div>
<!--[/edit:mow-gallery]-->
```

The editor writes more onto an image it adds, such as `srcset`, `width`,
`height`, `data-sd` and `data-original`, and it reads them back. An image
written by hand needs only `src` and `alt`.

**The gallery.** A gallery page holds one `[list:gallery]` inside
`.gal .wrap`. Each section is an item whose region holds one `gal-train`:

```html
<section class="gal" id="gallery">
  <div class="wrap">
    <!--[list:gallery]-->
    <!--[item:yards]-->
    <!--[edit:gal-yards]-->
    <div class="gal-train" data-section="yards">
      <header class="gal-train__head">
        <span class="gal-train__n"><i class="gal-train__i"></i>Season</span>
        <h3 class="gal-train__title">North side yards</h3>
        <span class="gal-train__rule" aria-hidden="true"></span>
        <span class="gal-train__meta"><span class="gal-train__year">2026</span><span class="gal-train__count">1 image</span></span>
      </header>
      <figure class="gal-tile" data-w="2" data-priority="1" data-span="2">
        <img src="img/yard-1.png" alt="A striped lawn" loading="lazy" decoding="async"
             width="640" height="360" />
        <figcaption class="gal-tile__cap">After a weekly mow</figcaption>
      </figure>
    </div>
    <!--[/edit:gal-yards]-->
    <!--[/item:yards]-->
    <!--[/list:gallery]-->
  </div>
</section>
```

The item id, the slug after `gal-` and `data-section` are the same word,
and it is permanent. `data-w` is the width the author asks for, in
columns of six, and `data-span` is the width a reader with no script
gets. The packer in `gallery.js` sets the width on screen.

**The corner mark.** `tool.js` draws the editor's button in the page's
bottom left corner at load, on every page. Pressing it opens the editor,
and so does `edit()` in the console. Nothing about it is written into a
page.

The engine's own repository checks the marker rules with
`tools/e2e/check_markers.py --site <site root>`.

## 7. The blog contract

A site with a blog says `blog: true` and keeps its blog at the fixed
names: `blog.html` at the root and the month pages in `blog/`.

`blog.html` holds these parts. Each id is the one the engine reads:

- `section#blogPage`, the blog's own section.
- `[edit:blog-h2]` around `h2.bm-top__month`, the month the stream shows,
  marked `data-ced="generated"`.
- `#blogRail`, and `#blogBar` with `#blogFind` and `#blogMonth`, as empty
  containers that `blog.js` fills.
- `[edit:blog-stream]` around `div#blogStream`, marked
  `data-ced="generated"`. `blog.js` does nothing on a page without it.
- `[edit:blog-manifest]` around `script#blogManifest`, of type
  `text/plain` and marked `data-ced="blog"`: the blog's counters, its
  publish stamp and one line for each post.

A month page is a page of the site. At each publish and rebuild, the
composer copies the header of `blog.html`, `header.site-header`, and its
footer, `footer.site-footer`, into the month page whole. It writes each
relative path in them for a page one folder down. A `blog.html` with no
such footer gives its `section.contact` instead.

The composer writes the month pages, `search.js`, `feed.xml`,
`sitemap.xml` and `robots.txt`. A save, a publish, a Super Delete and a
Restore write the image index, `images.js`, and a Super Delete and a
Restore write their log, `superdeleted.js`. Each generated file says so at
its top. Do not edit one by hand: the next write replaces it.

No worked example of a second site with a blog exists yet.

## 8. Delivery

**Export.** One changed page downloads as itself. More than one, or a
page with a new photo, downloads as `publish.zip`, laid out the way the
site's folder is, so it unzips over the site. An export leaves the edits
and the photos waiting, and the image index waits with them: the save
after it writes `images.js`.

**Save to repo.** The owner picks the site's folder once, and the editor
writes the changed files into it. It writes into a folder only when the
folder's own `site.config.js` names the same `siteId` and the folder holds
the site's first page. The engine reads that file as text and never runs
it. On a site with a blog, the stamp in the folder's `blog.html` then says
whether it is the publish the page knows.

**A write that stops.** The editor writes one file at a time, in path
order. When a write stops, each file before it is written, the file it
stopped on keeps its old bytes, and a new file it could not fill is taken
away again. The box names the files that were written, the edits stay on
the page, and a second save writes the rest.

**Storage.** Every name the engine keeps in the browser is the site's
`siteId`, a dash and a word: `AMH.site.key("pending-edits")`. Two sites on
one origin keep their drafts, held photos and remembered folders apart.
An applied edit waits in the tab's session storage until a save writes
it or the owner discards it, so it follows the owner from page to page.

**The staging layer.** A blog publish, a delete or a rebuild builds a
bundle and leaves it to the owner to upload. Until the site shows that
bundle's stamp, the tab keeps its text files and reads through them, so
the next bundle builds on the last one. The image index reads the
bundle's `images.js` before the site's, and a save into the folder puts
the `images.js` it wrote into the layer.

## 9. Upgrade and versions

1. Replace this folder whole with the new release's folder. Do not merge
   files.
2. Set `engineVersion` in `site.config.js` to the new version.
3. Open each page. The editor opens, and `AMH.release.version` in the
   console is the new version. A page that says the pin is wrong has an
   old `site.config.js` or an old folder.
4. When `CHANGES.md` says the month pages changed, open `blog.html`,
   run `edit.blog.rebuild()`, deliver the bundle, and commit it. A site
   with no blog skips this step.

The site keeps its pages, its content, its `site.css` and its
`site.config.js` through every upgrade. A release that needs a change to
any of them is a major version, and its entry in `CHANGES.md` says what
to change.

**Changes.** `CHANGES.md` in this folder lists each release, newest
first, with the summary of the commit that made it. A release adds its
entry in the commit that changes the version.

**The pin.** While `engineVersion` and `release.js` differ, or either file
is missing, the page still reads. The editor refuses to open, and its box
names both versions and what to do.

**Versions.** The version follows Semantic Versioning: a patch fixes, a
minor adds, and a major breaks a documented contract. The contracts are
the fields of `site.config.js`, the theme tokens, the page markers and
lists, the carousel and gallery markup, the blog page's parts, the
generated markup, and the stored formats.

## 10. The worked example

`tools/e2e/fixtures/lawn/` in the engine's repository is Greenline
Mowing, a fictional lawn care site built from this guide: three pages,
one of them a folder down, a gallery, no blog, and a light green theme in
its own `site.css`. It holds no engine file. The test suite copies this
folder under it and runs it beside the engine's first site on one origin,
on every commit: the load order, the pin, an edit, a shared edit, a photo
on the nested page, a gallery tile, both delivery routes, and the storage
names. Its `README.md` says what each file is for.
