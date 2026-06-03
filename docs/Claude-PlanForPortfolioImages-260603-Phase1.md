# Portfolio Images System: Plan (2026-06-03)

## Phase 1: Foundation and the inline gallery

> This is the entry document for a three-part plan. It carries the overall
> overview and phase map, then the full Phase 1 specification.
> Companion docs:
> - `Claude-PlanForPortfolioImages-260603-Phase2.md` (the lightbox)
> - `Claude-PlanForPortfolioImages-260603-Phase3.md` (cleanup, verification, polish)

---

## 1. Overview

Each Selected Work project currently shows a single static placeholder image
inside a `.project__media` figure. We are turning that media area into a small,
self-contained **image gallery** that is painless to author by hand and reads as
elegant and on-brand.

The core idea: a permanent, CSS-drawn **holder** (the styled "stand-in" look the
owner likes: blue bokeh glow, faint `+` grid, chamfered frame) stays in place as
a backdrop, and real photos of any aspect ratio rest on top of it, contained with
padding so the holder always frames them. Viewers move between a project's photos
with arrows and a row of circular thumbnails, optionally see a small "next image"
preview teaser, and can click any photo to open a fullscreen lightbox.

### Guiding principles

1. **Painless authoring.** Adding or removing a photo is one line of HTML inside a
   project. The JavaScript builds all the chrome (arrows, circles, captions,
   preview, lightbox) from whatever images are listed. No per-image wiring.
2. **The holder is a charm, not a placeholder.** It is generic, text-free, drawn
   in CSS so it scales crisply and can animate. It is meant to be seen around and
   behind the photos, not hidden.
3. **Any image, any shape, lands nicely.** 16:9, 1:1, 2:1, 3:1, 1:3, even 32x32:
   each is scaled to fit (never stretched), centered, padded, with a faint drop
   shadow, and the holder shows in the remaining space.
4. **Dependency-free.** No third-party libraries. Vanilla CSS and JS, in keeping
   with the rest of the site (one inline script today).
5. **SEO-friendly.** The `<img>` tags and their `alt` text live in the static
   HTML source (not injected by JS), so crawlers and link-preview scrapers see
   the real images. Only interactive chrome is JS-built.
6. **Future-ready.** Markup leaves a hook for a later low-resolution `_sd.jpg`
   (for the circle thumbnails and fast loads) without reworking anything now.

### House rules (from project CLAUDE.md)

- No em dashes in any user-visible webpage copy.
- Do not use the AskUserQuestion tool; ask questions in full prose.
- Current date for naming and relative-date conversion: 2026-06-03.

### Phase map

- **Phase 1 (this doc):** the `.py` seed generator, the CSS holder, the inline
  gallery (contained images, fade transitions, arrows, circle thumbnails,
  optional captions, optional next-image-preview add-on), auto-hide rules, and
  the per-image authoring contract.
- **Phase 2:** the hand-rolled lightbox (desktop full-page fit with no zoom,
  mobile pinch-zoom and pan, (X) close, working arrows, slim always-on caption
  bar, keyboard and focus accessibility).
- **Phase 3:** cleanup (archive the old placeholder JPGs, remove the retired
  inset mechanism), verification (responsive, accessibility, SEO, performance),
  and final polish.

---

## 2. The per-image authoring contract

Authoring stays declarative and minimal. Inside each project, the media area is a
single gallery container holding one `<img>` per photo. Everything else is
generated.

```html
<!-- one project's media area -->
<div class="gallery"><!-- add data-next-preview to opt this project into the preview teaser -->
  <img src="img/seed/forerunner-01.jpg" alt="Forerunner 3 orbital view"
       data-caption="Live TLE ingestion at 60fps">
  <img src="img/seed/forerunner-02.jpg" alt="Debris field timeline scrubber">
  <img src="img/seed/forerunner-03.jpg" alt="Google Earth tile fusion">
</div>
```

Per-image attributes:

| Attribute     | Required | Purpose                                                        |
|---------------|----------|----------------------------------------------------------------|
| `src`         | yes      | The full image to display (and, for now, to crop for circles). |
| `alt`         | yes      | Real alt text, in the HTML source for SEO and accessibility.   |
| `data-caption`| no       | Optional description. Drives the holder caption scrim and the lightbox caption bar. Omit for no caption. |
| `data-sd`     | no       | Optional future low-res image (for example `..._sd.jpg`) used by the circle thumbnails and as a fast first paint. If absent, `src` is used. Reserved for later, not generated in Phase 1. |

Container options:

| Hook                         | Purpose                                                            |
|------------------------------|-------------------------------------------------------------------|
| `data-next-preview` on `.gallery` | Opt this project into the "next image" foreground preview teaser. Off by default. |

Authoring actions:

- **Add a photo:** paste one `<img>` line. Arrows, circles, preview, and lightbox
  update automatically.
- **Remove a photo:** delete its `<img>` line.
- **Reorder:** move the `<img>` lines; order drives arrows, circles, and the
  "next" preview.
- **Single image:** if a project lists one image, arrows and circles auto-hide;
  the photo simply rests on the holder.

---

## 3. DOM and JavaScript structure

The author writes only the `.gallery` container and its `<img>` list. On load,
the gallery JS enhances each `.gallery` into this structure (illustrative):

```
.project__media
  .gallery[ data-next-preview? ]
    .gallery__holder            <- CSS backdrop (bokeh, + grid, chamfer frame)
      .gallery__stage           <- holds the stacked images, handles fade
        img.gallery__img.is-active
        img.gallery__img
        ...
      .gallery__caption         <- bottom scrim caption (per active image)
      .gallery__preview         <- optional next-image teaser (opt-in)
      button.gallery__nav--prev
      button.gallery__nav--next
    .gallery__dots              <- row of circle thumbnails beneath the holder
      button.gallery__dot ...
```

Behavior built by the JS:

- Read the `<img>` children in order; that list is the gallery model.
- Stack them in `.gallery__stage`; show one at a time via an `is-active` class.
- Build the circle thumbnails row (`.gallery__dots`), one per image.
- Build prev/next arrow buttons.
- If `data-caption` exists on the active image, fill and show the caption scrim;
  otherwise hide it.
- If the container has `data-next-preview`, build the preview teaser showing the
  next image; clicking it advances.
- If only one image, do not render arrows or dots (or render hidden).
- Clicking the active image opens the lightbox (wired in Phase 2). In Phase 1 the
  click target and a `data-lightbox` hook are present but the lightbox itself is
  a Phase 2 deliverable.

Keep the JS as a small, readable addition to the existing inline IIFE, matching
its style (`var`, plain functions, feature-detection).

---

## 4. The CSS holder

A constant 16:9 frame, drawn entirely in CSS, reusing techniques already in the
hero (the soft radial glows of `.hero__halo` / `.hero__glow`, the `+` motif of
`.hero__sparks`).

Holder composition:

- **Aspect:** fixed 16:9 (`aspect-ratio: 16 / 9`) so every project's layout is
  stable regardless of the photos inside.
- **Base:** the existing panel background and 1px border, consistent with `.figure`.
- **Bokeh glow:** one or two large, soft, low-opacity blue radial gradients,
  echoing the placeholder art. Static by default; can animate later.
- **`+` grid:** a faint, evenly tiled grid of small `+` marks at low opacity
  (a repeating background image or tiled SVG), distinct from the hero's random
  twinkle. This is the signature texture.
- **Chamfer frame:** a subtle clipped-corner treatment (clip-path or layered
  pseudo-element) to evoke the notched look of the placeholder badge, kept light.
- **Corner radius:** match the site's `--radius` for cohesion where chamfer is not
  used.

Image presentation on the holder:

- `object-fit: contain` so any ratio fits without distortion.
- **Padding inset:** the stage has padding so the holder always shows as a margin
  around the photo, even for a 16:9 image. The photo never reaches the holder edge.
- **Drop shadow:** a faint shadow on the image so it reads as floating on the holder.
- **Small or extreme images:** contained and centered with the same padding; the
  backdrop fills the rest. (Upscaling policy for tiny images, for example a 32x32,
  is "fit within the padded area," accepting softness; revisit in polish if needed.)

Transitions:

- **Cross-fade** between images: the outgoing image fades out as the incoming
  fades in, with the holder visible underneath throughout. Honor
  `prefers-reduced-motion` by reducing or removing the fade.

Caption scrim (optional, per image):

- A bottom-aligned gradient scrim (dark to transparent) with small light text.
- Fades in with its image; updates on navigation.
- Auto-hidden when the active image has no `data-caption`.

---

## 5. Arrows and circle thumbnails

**Arrows:**

- Prev/next buttons overlaid on the left and right edges of the holder.
- Keyboard accessible (real `<button>`s, focusable, Enter/Space activate; the
  gallery responds to Left/Right arrow keys when focused).
- Auto-hidden when the project has a single image.
- Wrap-around (next from the last image returns to the first), matching the
  preview teaser's cycling behavior.

**Circle thumbnails (dots):**

- A row beneath the holder, one circle per image.
- Each circle shows an **upper-left crop** of its image
  (`object-fit: cover; object-position: left top`) at small size, using the
  actual image now (or `data-sd` later). Enough to say "something is here, click
  to find out."
- The active image's circle gets an active state (ring or accent).
- Clicking a circle jumps directly to that image.
- Auto-hidden when the project has a single image.

---

## 6. The optional next-image-preview add-on

An opt-in, per-project foreground teaser that reuses the old inset's
corner-overlap placement and styling. It coexists with arrows and circles (it
never replaces them). Its purpose is to signal "there is another important thing
in this section worth seeing at the same time," useful for projects whose images
represent several distinct things (for example the AI-tooling block).

- **Opt-in:** present only when the `.gallery` has `data-next-preview`.
- **Content:** a mini of the **next** image in order.
- **Placement:** overlapping the holder's foreground corner (the old inset spot,
  for example bottom-right), with the inset's chamfer/border styling.
- **Interaction:** clicking it advances to that next image (cycling). After
  advancing, it updates to show the new "next" image.
- **Single image:** not shown (there is no "next").
- **Responsive:** on the single-column mobile layout, keep it tucked in the
  corner; if cramped, it may shrink or hide (decide in polish).

---

## 7. The `.py` seed generator

A standalone Python script that produces throwaway `.jpg` placeholders so we can
build and test the gallery before real photos arrive. These are stand-ins the
owner will replace shortly.

- **Location:** `tools/gen_placeholders.py` (a `tools/` folder; not shipped to
  the live page).
- **Output:** `.jpg` files into `img/seed/` (kept separate from real assets and
  from the soon-to-be-archived originals).
- **Library:** Pillow (PIL). When run, confirm Pillow is importable; if missing,
  either install into a local environment or fall back to `.png` output. The
  gallery treats `.png` and `.jpg` identically, and these are temporary anyway.
- **Ratios and sizes to cover:** at least 16:9, 1:1, 2:1 (or 3:1), 1:3, and a
  tiny 32x32, so the contain-with-padding behavior is visible across shapes.
- **Per-project counts:** seed projects at **different totals from 1 to 5** so we
  can see single-image, few-image, and fuller galleries (including the auto-hide
  behavior at a count of 1).
- **Appearance of each placeholder:** a distinct tint per image, with its pixel
  dimensions and an index label drawn on it, so each is easy to tell apart in the
  gallery, the circles, and the preview. No project-specific text baked in (the
  holder, not the image, carries the brand look).
- **Config-driven:** a small list at the top of the script mapping a project slug
  to its desired count and ratio mix, producing predictable filenames such as
  `img/seed/forerunner-01.jpg`, `img/seed/forerunner-02.jpg`, and so on. The HTML
  galleries reference these names.
- **Re-runnable:** safe to run repeatedly; overwrites its own output.

---

## 8. Phase 1 acceptance

Phase 1 is done when:

- Running `tools/gen_placeholders.py` produces the seed `.jpg` set in `img/seed/`.
- Each project's media area is a `.gallery` with a simple `<img>` list, and the
  JS renders the holder, contained padded images with drop shadow, fade
  transitions, arrows, and circle thumbnails.
- Optional per-image captions appear as the bottom scrim and auto-hide when absent.
- A project tagged `data-next-preview` shows the next-image teaser that advances
  on click; others do not.
- Single-image projects auto-hide arrows and circles.
- Images of varied ratios (including 32x32) all sit neatly on the holder.
- Verified visually at desktop and mobile widths.
- A `data-lightbox` click hook is present on the active image, ready for Phase 2.
- Only intended files are added or changed.
