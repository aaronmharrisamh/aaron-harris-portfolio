# Changes

Each release of the engine, newest first. The version is the one in
`release.js`. Each entry is the summary of the commit that made the
release, word for word, and `V0NN` is that commit's number in the
engine's repository. Those commits also changed the engine's first
site, so some lines name that site's pages.

A site upgrades by the steps in section 9 of `README.md`. When an entry
says the month pages changed, the site runs a rebuild after the upgrade.

## 1.1.0

V102 - put About in a shared footer and bump the engine to 1.1.0
- add about.html with its own heading and SEO
- move About and Contact into one site footer
- share the seven About regions across every page
- lift the site footer into every month page
- make the portrait glow the default fill
- add CHANGES.md with the engine's commit summaries

## 1.0.1

V101 - repair the image index and bump the engine to 1.0.1
- read a staged bundle's index at first load
- keep the index waiting after a zip export
- put a folder-written index into the layer
- add three IR checks to the gate
- bump the engine and both pins to 1.0.1
- update the guide for the staging layer

## 1.0.0

V100 - add a second site on the engine and fix nested paths
- add the lawn fixture as a second site
- keep every editor path as a root path
- drop a reverted shared edit from every page
- add the LW section of 28 lawn checks
- add a site option to the marker checker
- write the library README as the integration guide

V099 - free the editor from the blog and scope storage per site
- add the composer slot the editor reads
- move the tag grammar into the image engine
- name every storage key through the site's id
- recognize a repo folder by its siteId
- restore the NUL escapes in markdown.js
- stop the edit link when the pin fails

V098 - move the engine into a library with a site config
- add release.js, engine.css and the pin check
- add site.config.js for the site's own facts
- move the eight trunks into libraries/harrisxrwebengine
- replace root guesses with helpers in site.js
- split site.css into engine.css and site.css
- reword the publish law for the staging layer
