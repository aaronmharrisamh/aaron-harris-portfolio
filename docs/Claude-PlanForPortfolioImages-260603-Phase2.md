# Portfolio Images System: Plan (2026-06-03)

## Phase 2: The lightbox

> Part of a three-part plan. See:
> - `Claude-PlanForPortfolioImages-260603-Phase1.md` (foundation and inline gallery)
> - `Claude-PlanForPortfolioImages-260603-Phase3.md` (cleanup, verification, polish)
>
> Phase 2 assumes Phase 1 is in place: each project is a `.gallery` with an
> `<img>` list, and the active image carries a `data-lightbox` click hook.

---

## 1. Goal

Clicking the displayed photo opens a fullscreen lightbox. The experience is
intentionally split by device:

- **Desktop: dead simple.** The image fills the page, scaled to its own ratio
  (contained to the viewport). No zoom, no pan, nothing fancy.
- **Mobile: pinch-zoom and pan.** The same fullscreen image, plus elegant
  pinch-to-zoom and drag-to-pan so detail can be inspected. Kept lean, not
  over-engineered.

Both: an (X) close button, working prev/next arrows to move through the project's
images while fullscreen, and a slim, always-visible caption bar at the bottom.

All hand-rolled. No third-party libraries.

---

## 2. Structure

A single lightbox overlay is created once and reused for every gallery (not one
per project). Illustrative structure:

```
.lightbox[ hidden ]            <- fixed, full-viewport, dark scrim
  .lightbox__stage             <- centers and sizes the image; hosts zoom/pan on mobile
    img.lightbox__img
  button.lightbox__close       <- (X), top corner
  button.lightbox__nav--prev   <- previous image
  button.lightbox__nav--next   <- next image
  .lightbox__caption           <- slim always-on bottom bar (current image's caption)
```

Opening:

- A click on a gallery's active image (the `data-lightbox` hook from Phase 1)
  opens the lightbox at that image, within that project's image set.
- The lightbox holds a reference to the current gallery's model and index so its
  arrows and caption stay in sync with that project.

Closing:

- The (X) button, the Escape key, and a click on the backdrop (outside the image)
  all close it.
- On close, focus returns to the gallery image that opened it.

---

## 3. Desktop behavior

- Image is `object-fit: contain` to the viewport, centered, with a small safe
  margin so it never collides with the close button, arrows, or caption bar.
- No zoom and no pan. A click on the image does nothing special (or closes, to be
  decided in polish); clicking the backdrop closes.
- Prev/next arrows swap the image (cross-fade or instant; match the inline
  gallery's feel). Caption updates with each image.

Device split is by capability and width: treat as "desktop" when there is no
fine-grained touch as the primary input and the viewport is wide; otherwise use
the mobile path. Use a pragmatic check (pointer/touch and width) and keep it in
one place.

---

## 4. Mobile behavior (pinch-zoom and pan)

A lean, custom touch interaction on `.lightbox__stage`:

- **Pinch to zoom:** two-finger pinch scales the image around the gesture's
  midpoint, between 1x (fit) and a sensible max (for example 4x).
- **Drag to pan:** when zoomed in, one finger pans; panning is clamped so the
  image cannot be dragged completely off-screen.
- **Double-tap:** toggles between fit (1x) and a comfortable zoomed level,
  centered on the tap point. Optional but nice; include if it stays simple.
- **Reset on change:** opening a new image, or using prev/next, resets to 1x fit.
- **Arrow vs pan:** when zoomed in, horizontal drags pan rather than navigate; at
  1x, the prev/next arrows (and optionally horizontal swipe) navigate. Keep the
  rule simple and predictable.

Implementation notes:

- Track scale and translate in state; apply with a single CSS `transform` on the
  image for smoothness. Use `touch-action: none` on the stage to take over
  gestures. Listen to `touchstart`/`touchmove`/`touchend` (and `pointer` events
  if cleaner), computing distance and midpoint for pinch.
- Keep the math small and readable; avoid a general gesture engine. The goal is
  "works well and feels good," not exhaustive.
- Respect `prefers-reduced-motion` for any easing.

---

## 5. Caption bar

- A slim bar pinned to the bottom of the lightbox, always visible (distinct from
  the inline holder's fade-in scrim).
- Shows the current image's `data-caption`. If the current image has no caption,
  the bar collapses or hides so it does not show an empty strip.
- Updates as prev/next changes the image.

---

## 6. Accessibility

- The lightbox is a modal dialog: set `role="dialog"` and `aria-modal="true"`,
  with an accessible label.
- **Focus trap:** while open, keep keyboard focus within the lightbox; move focus
  to a sensible control (close or the image) on open; restore focus to the
  opener on close.
- **Keyboard:** Escape closes; Left/Right move between images; the close and
  arrow buttons are real, labeled `<button>`s.
- Hide background page content from assistive tech while open (for example
  `inert` or `aria-hidden` on the rest), if it does not complicate the code.
- Ensure tap and click targets are comfortably sized on mobile.

---

## 7. Phase 2 acceptance

Phase 2 is done when:

- Clicking a gallery image opens the fullscreen lightbox at that image, scoped to
  that project's set.
- Desktop shows the image fit to the page with no zoom; prev/next and the caption
  bar work; (X), Escape, and backdrop click all close it.
- Mobile supports smooth pinch-zoom and clamped pan, with reset on image change
  and predictable navigation versus pan behavior.
- The caption bar reflects the current image and hides when there is no caption.
- Focus is trapped while open and restored on close; keyboard navigation works.
- No libraries added; the code is a small, readable extension of the inline IIFE.
- Verified at desktop and mobile widths (including a real touch check for the
  pinch and pan).
