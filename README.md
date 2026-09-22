# aaron-harris-portfolio

This site runs on the HarrisXR Web Engine, in `libraries/harrisxrwebengine/`.
Its pages edit themselves in the browser, and the owner commits the files the
editor hands back. The engine's `README.md` is its integration guide: the layout,
the load order, `site.config.js`, the theme, the page contract, delivery and the
upgrade. `tools/e2e/fixtures/lawn/` is a second site built from that guide, and
the test suite runs both sites on every commit.
