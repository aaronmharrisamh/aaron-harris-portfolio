# HarrisXR Web Engine

Pages that edit themselves in the browser. The owner opens a page, turns on
the editor, and changes copy, photos, galleries and posts. The engine hands
back the changed files, as a zip or written straight into the site's folder,
and the owner commits them. There is no server, no build step and no
database. Reading works from disk, and editing works over HTTP or through the
file hand-off.

This folder is the engine. A site keeps it whole at
`<site root>/libraries/harrisxrwebengine/` and never edits it in place. An
upgrade replaces the whole folder.

## Files

| File | Job |
| --- | --- |
| `release.js` | The release: its id, its version, and the address of this folder. The one place the version is written. |
| `engine.css` | The style of everything the engine draws or drives, and a default for every theme token. |
| `site.js` | Shared page behavior, the site root, the pin check, and the site's storage names. |
| `work.js` | The carousels, the players, the deep-dive drawer and the lightbox. |
| `imagesengine.js` | The image engine: intake, the files held until a save, the image index, the log of super deletes, and the grammar of the tag that places a file in a post. |
| `blog.js` | The blog reader: the stream, the month chain and find. |
| `markdown.js` | The Markdown renderer. |
| `gallery.js` | The gallery page's tile packer and its editor. |
| `tool.js` | The editor, the splice and the export. It reaches the blog composer only through the slot the composer fills, `AMH.tool.blog`. |
| `publish.js` | The blog composer and the publish bundle. It fills the editor's slot when it loads. |

## The site's two files

A site keeps two files of its own at its root, beside its pages.

- `site.config.js` holds the site's facts: its `siteId`, the `engineVersion`
  it expects, its name and address, the pages the editor may write, the
  regions that read the same on every page, and whether it has a blog. The
  engine reads it and never writes it.
- `site.css` holds the site's own style and its theme tokens.

## Load order

Every page links the engine's style first and the site's second, so the
site's rules win a tie and its tokens set the theme:

```html
<link rel="stylesheet" href="libraries/harrisxrwebengine/engine.css" />
<link rel="stylesheet" href="site.css" />
```

Every page then loads, with `defer`, `release.js`, `site.config.js`, and its
trunks from this folder. These are the sets, in order:

| Page | Trunks, after `release.js` and `site.config.js` |
| --- | --- |
| A page of copy and carousels | `site.js`, `work.js`, `imagesengine.js`, `tool.js` |
| A page with deep dives in Markdown | `site.js`, `work.js`, `imagesengine.js`, `markdown.js`, `tool.js` |
| A gallery page | `site.js`, `work.js`, `imagesengine.js`, `tool.js`, `gallery.js` |
| `blog.html` | `site.js`, `work.js`, `imagesengine.js`, `blog.js`, `markdown.js`, `tool.js`, `publish.js` |
| A month page in `blog/` | `site.js`, `work.js`, `imagesengine.js`, `blog.js`, `tool.js`, `publish.js` |

A trunk that follows `tool.js` registers itself with the editor, which is why
it follows. The composer writes each month page, so a site never writes that
set by hand.

## The site root

`site.js` finds the site root from the address of this folder: the root is
two folders above it. Every path the engine reads or writes is a path from
that root, so a page can be at any depth. A site that keeps this folder
somewhere else names its root in `site.config.js` as `siteRoot`.

## The pin

`site.config.js` names the release the site expects in `engineVersion`, and
`site.js` compares it with `release.js`. While the two differ, or either file
is missing, the page still reads, and the editor refuses to open and says
why.

## Storage and the repo folder

Every name the engine keeps in the browser is the site's `siteId`, a dash and
a word: `AMH.site.key("pending-edits")`. Two sites on one origin keep their
drafts, held photos and remembered folders apart.

The editor writes into a repo folder only when the folder's own
`site.config.js` names the same `siteId` and the folder holds the site's
first page. The engine reads that file as text and never runs it. On a site
with a blog, the stamp in the folder's `blog.html` then says whether it is
the publish the page knows.

## A site with no blog

A site whose `site.config.js` says `blog: false` loads no `blog.js` and no
`publish.js`. Its editor shows no New post button, and the console's blog
commands answer "This site has no blog."

## The theme

`engine.css` reads these tokens from `:root` and gives each one a default. A
site sets any of them in the `:root` of its own `site.css`.

| Group | Tokens |
| --- | --- |
| Surfaces | `--bg`, `--bg-deep`, `--panel`, `--panel-2`, `--line`, `--line-soft` |
| Text | `--text`, `--text-soft`, `--muted`, `--dim` |
| Accent | `--accent`, `--accent-bright`, `--accent-deep`, `--accent-glow`, `--accent-faint` |
| Second colors | `--c-orange`, `--c-yellow`, `--c-lime` |
| Type | `--font` |
| Space | `--section-pad`, `--gutter`, `--maxw` |
| Shape and motion | `--radius`, `--radius-sm`, `--ease`, `--ease-soft` |

A custom property that a part of the engine sets on its own element is
internal, and a site does not set it.

## Upgrade

1. Replace this folder whole with the new release's folder. Do not merge
   files.
2. Set `engineVersion` in `site.config.js` to the new version.
3. Open each page. The editor opens, and `AMH.release.version` in the console
   is the new version.
4. When the release notes say the generated pages changed, open `blog.html`,
   run `edit.blog.rebuild()`, deliver the bundle, and commit it. A site with
   no blog skips this step.

## Versions

The version follows Semantic Versioning: a patch fixes, a minor adds, and a
major breaks a documented contract. The contracts are the fields of
`site.config.js`, the theme tokens, the page markers, the generated markup,
and the stored formats.
