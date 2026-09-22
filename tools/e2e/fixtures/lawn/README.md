# Greenline Mowing: the engine's second site

A small site for a fictional lawn care business. It is the worked example
of the engine's integration guide, `libraries/harrisxrwebengine/README.md`,
and the e2e suite runs the engine on it on every commit. The business, its
copy and its photos are invented. They name no real person.

## What it proves

- The engine runs a site that is not the portfolio: another `siteId`, no
  blog, a light theme, and a page one folder below the root.
- An edit, a shared edit and a photo work from the nested page, and a tile
  works on the gallery page. Each export and each save leaves every byte
  outside the edited regions the same.
- Two sites on one origin keep their browser storage and their repo folders
  apart.
- A wrong `engineVersion` leaves the pages readable and the editor closed.

The checks are the `LW` section of `tools/e2e/e2e_test.mjs`: every check
whose name starts with `lawn:`.

## Files

| File | Job |
| --- | --- |
| `index.html` | The front page: the header, an intro, a list of three services, and the footer. |
| `services/mowing.html` | The nested page: the header, an intro, and a carousel of one photo. |
| `photos.html` | The gallery page: one section of three tiles. |
| `site.config.js` | The site's facts: `siteId` `"lawn"`, the engine pin, three pages, five shared regions, and `blog: false`. |
| `site.css` | The theme, all 26 tokens in a light green palette, and the layout of the three pages. |
| `img/yard-1.png` to `img/yard-3.png` | The three photos. `make.py` draws them. |
| `make.py` | Writes the photos and `manifest.json`. A person runs it once, and the suite never does. |
| `manifest.json` | Each photo's bytes, SHA-256, width and height. The suite checks the files against it. |

The folder holds no engine file. The suite copies the engine's folder,
`libraries/harrisxrwebengine/`, under its served copy of this site, so the
site always runs the engine the commit holds.

## How the suite serves it

The suite serves this folder at `/lawn/`, beside the portfolio on the same
origin. It serves a second copy at `/lawnpin/` whose `site.config.js` pins
`engineVersion` to `"0.0.0"`, for the pin check.

## Rules

- A shared region holds no path. The editor writes one region's bytes to
  every page, and `services/mowing.html` sits one folder below the others.
  Each nav link keeps its address outside its markers, and only its label
  is inside them.
- `engineVersion` is the version in the engine's `release.js`. An engine
  release sets both in the same commit.
- Photos change only through `make.py`. Run it again and commit the photos
  and `manifest.json` together.
- No em dashes in the copy.
