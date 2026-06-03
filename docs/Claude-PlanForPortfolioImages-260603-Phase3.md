# Portfolio Images System: Plan (2026-06-03)

## Phase 3: Cleanup, verification, and final polish

> Part of a three-part plan. See:
> - `Claude-PlanForPortfolioImages-260603-Phase1.md` (foundation and inline gallery)
> - `Claude-PlanForPortfolioImages-260603-Phase2.md` (the lightbox)
>
> Phase 3 runs after the gallery and lightbox work. It removes what the new
> system replaces, proves the result holds up, and applies finishing touches.

---

## 1. Cleanup

### 1a. Archive the old placeholder images

The new system draws the holder in CSS and seeds galleries from `img/seed/`, so
the original per-project placeholder JPGs (with baked-in titles and the
"PLACEHOLDER" badge) become unused.

- Create a top-level `/archived/` folder.
- Move the originals there (do not delete), preserving names:
  - `img/placeholder-forerunner.jpg`
  - `img/placeholder-phillips.jpg`
  - `img/placeholder-planetarium.jpg`
  - `img/placeholder-planetarium-inset.jpg`
  - `img/placeholder-blockade.jpg`
  - `img/placeholder-aitooling.jpg`
  - `img/placeholder-aitooling-inset.jpg`
- Use `git mv` so history follows the files.
- Confirm nothing in `index.html` still references the moved paths after the
  gallery rewrite (grep for `placeholder-`).

### 1b. Remove the retired inset mechanism

The old overlapping `.figure-inset` is replaced by the optional next-image-preview
add-on (Phase 1). Remove its now-dead code:

- The `.figure-inset` CSS rules (desktop block around the projects styles, plus
  the mobile override that sets its width and position).
- Any remaining `<figure class="figure-inset">` markup, now that galleries own
  the multi-image and preview behavior.
- The Phase 1 auto-cull JS entry for `.figure-inset` (the empty-section sweep), if
  `.figure-inset` no longer exists. Re-check the sweep targets after the rewrite.

### 1c. General tidy

- Remove any leftover single-image `.figure` scaffolding the gallery supersedes.
- Make sure the cookie-cutter project comments from the earlier pass still read
  correctly against the new gallery markup; update the labels that referred to a
  single image or the inset.
- Keep the `tools/gen_placeholders.py` script and `img/seed/` for now (still the
  source of demo images until real photos land). Note in the doc that both can be
  retired once real images replace the seeds.

---

## 2. Verification

### 2a. Responsive and visual

- Capture desktop (for example 1920 and 1440 wide) and mobile (for example 412
  wide) renders of the Selected Work section.
- Confirm across projects:
  - The holder shows around every image with padding and a faint drop shadow.
  - Varied ratios (16:9, 1:1, 2:1 or 3:1, 1:3, 32x32) all sit neatly, no
    stretching, backdrop visible in the spare space.
  - Fade transitions look clean; the holder shows through during the fade.
  - Arrows and circles work, and both auto-hide on single-image projects.
  - The optional next-image preview shows only where opted in and advances on click.
  - Captions appear as the holder scrim where present and auto-hide where absent.

### 2b. Lightbox

- Desktop: opens to a page-fit image, no zoom; prev/next and caption bar work;
  (X), Escape, and backdrop click close it; focus returns to the opener.
- Mobile (real touch check): pinch-zoom and clamped pan feel good; reset on image
  change; navigation versus pan behaves predictably.

### 2c. Accessibility

- All controls (arrows, dots, preview, close) are real, labeled buttons, keyboard
  reachable and operable.
- Lightbox is a labeled modal with a focus trap; Escape and arrow keys work.
- Every gallery `<img>` has meaningful `alt` text.
- Honor `prefers-reduced-motion` for fades and any easing.
- Check visible focus states on the new controls.

### 2d. SEO and sharing

- Confirm the `<img>` tags and `alt` text remain in the static HTML source (not
  injected by JS), so crawlers and link-preview scrapers see the real images.
- Confirm the gallery enhancement degrades gracefully with JS disabled: the
  images should still be present and viewable (even if arrows, circles, and the
  lightbox are inert).

### 2e. Performance

- Keep `loading="lazy"` on gallery images below the fold.
- Sanity-check total image weight; note where a future `_sd.jpg` would help (the
  circle thumbnails and the first paint), since the markup already reserves
  `data-sd` for it.
- Confirm the added JS stays small and runs once on load without jank.

---

## 3. Final polish

- Tune the holder look: bokeh intensity, `+` grid density and opacity, chamfer
  amount, padding, and drop-shadow softness, until it matches the charm of the
  original stand-in.
- Tune transition timing and easing so swaps feel smooth, not flashy.
- Revisit the tiny-image case (for example 32x32): confirm the chosen "fit within
  the padded area" looks intentional; adjust the upscaling cap if it looks poor.
- Confirm the next-image preview's corner placement and size look right on both
  desktop and the single-column mobile layout.
- Verify no em dashes slipped into any visible copy (captions, alt text used as
  visible text, etc.), per the project house rule. Note: an existing em dash in
  the AI-tooling project lead copy predates this work; flag it to the owner
  rather than silently changing committed copy.
- Final `git status` review: confirm only intended files were added, changed,
  moved, or archived, and that the working tree is clean and ready to commit
  (next version bump).

---

## 4. Phase 3 acceptance

Phase 3 is done when:

- The original placeholder JPGs live in `/archived/` (moved with history), and
  nothing references their old paths.
- The retired `.figure-inset` CSS, markup, and JS are gone, with no dead
  references left behind.
- All verification checks (responsive, lightbox, accessibility, SEO, performance)
  pass, with desktop and mobile evidence captured.
- The holder and transitions are polished to match the intended charm.
- The working tree is clean and limited to intended changes, ready to commit.
