End-to-end tests for the built-in copy editor and blog engine.

Run the full browser suite (starts its own local server + headless Chrome):

    node tools/e2e/e2e_test.mjs

Static marker integrity check (pairs, nesting, one element per region):

    py -3 tools/e2e/check_markers.py

Requirements: Node 22+, Google Chrome, Python 3 via the py launcher.
No packages to install; everything is dependency-free.

The suite serves a copy of the site in a temporary folder, with the
content the site's owner changes fixed: the home page's carousels come
from fixtures/home-galleries.html, the gallery page's sections from
fixtures/gallery-br.html, and the blog page is emptied. A change to a real
photo, section or post does not change what the checks see.
