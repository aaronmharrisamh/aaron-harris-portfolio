End-to-end tests for the built-in copy editor and blog engine.

Run the full browser suite (starts its own local server + headless Chrome):

    node tools/e2e/e2e_test.mjs

Static marker integrity check (pairs, nesting, one element per region). It
checks the pages that site.config.js names:

    py -3 tools/e2e/check_markers.py

With --site, it checks another site's root instead:

    py -3 tools/e2e/check_markers.py --site tools/e2e/fixtures/lawn

Requirements: Node 22+, Google Chrome, Python 3 via the py launcher.
No packages to install; everything is dependency-free.

The suite serves a copy of the site in a temporary folder, with the
content the site's owner changes fixed: the home page's carousels come
from fixtures/home-galleries.html, the gallery page's sections from
fixtures/gallery-br.html, and the blog page is emptied. A change to a real
photo, section or post does not change what the checks see. The copy takes
the engine's folder, libraries/harrisxrwebengine/, whole, and site.config.js
and site.css as they are in the repo.

The suite also serves fixtures/lawn/, Greenline Mowing, a second site on
the engine, at /lawn/ on the same origin, with the engine's folder copied
under it. /lawnpin/ is the same site pinned to engine 0.0.0, and /amhpin/ is
this site's blog page pinned the same way. The LW section, the last in the
suite, runs its checks on them. fixtures/lawn/make.py draws the lawn's three
photos once, and fixtures/lawn/manifest.json holds their hashes.
