Do not use 'AskUserQuestion', instead write out questions fully.
Do not use em dashes in copy for the webpage.  They're a dead giveaway of AI in the year 2026.

# Project Instructions

## Rules

**Version:** 1.2  
**Last updated:** 2026-09-01  

### Core Philosophy

This project is a carefully built application. It should give people a simple,
dependable experience while correctly handling the complexity its purpose needs.

Prefer the smallest clear solution that works. Keep necessary complexity inside
the part of the app that owns it. Do not add abstractions, frameworks, or
enterprise patterns without a clear benefit.

Code must be easy to read, explain out loud, and teach from. A new contributor
should be able to identify what a file does, why a non-obvious decision exists,
and where to make a safe change.

### Primary Manifold: Seven Clear Sections

Use prominent comment banners to divide a large code file into its main jobs.
For a larger script or module, **seven primary sections are the normal
expectation**. Start with all seven sections, then bend the structure only when
a section would be artificial or would make the file harder to understand.

Use fewer sections for a small or specialised file when some jobs do not exist.
Use more than seven only when a distinct job cannot be sensibly merged with
another section. More than seven should be rare. Do not create a second layer
of architecture only to add headings.

When a file uses the full shape, use these section names in this order where
they apply:

1. **HEADER / SETUP** - File purpose, requirements, imports, and error settings.
2. **CONSTANTS & CONFIG** - Fixed values, paths, settings, and flags.
3. **HELPER FUNCTIONS** - Small, focused helper functions.
4. **INITIALIZATION** - One-time setup and validation.
5. **CORE LOGIC** - The main work of the file.
6. **CLEANUP / FINALIZATION** - Resource release and final handling.
7. **ENTRY POINT / ORCHESTRATION** - The top-level flow that calls the work.

Use the native comment syntax for the file's language. Keep one banner style
within the project and make every section easy to find by sight.

### Code Style

- Prefer clear names and direct control flow over clever or dense code.
- Keep functions, components, and blocks focused on one job.
- Use consistent names, indentation, spacing, and error handling.
- Keep domain, network, storage, and user-interface complexity in the parts of
  the app that own it.
- Add a boundary when it makes a hard problem easier to understand. Do not add
  a boundary only because a pattern exists.
- Keep the top-level flow easy to follow. Put deep technical detail behind a
  small, well-named interface.

### Comments and Documentation

Write for the person who must safely read or change the code later. First use a
clear name. Add a comment only when the code cannot show the reason, rule,
limitation, or surprising effect by itself.

Use these comment forms:

1. **File header** - State the file's purpose and boundary.
2. **Section banner** - Help readers navigate a large file.
3. **Why comment** - State a decision and its reason in one or two short lines.
4. **Public-interface documentation** - State what a public function, class,
   component, or module does. Include inputs, outputs, effects, errors, or
   limits when callers need that detail.
5. **Rule, warning, or TODO** - State a permanent rule, a safety concern, or
   specific work that remains.

Use the native comment syntax for the language. The default local-comment
pattern is one short rule followed by one short reason:

```text
Keep missing values distinct from empty values.
They have different meanings to the app and to the user.
```

Do not use comments to narrate obvious code. Do not leave phase history,
superseded plans, jokes, metaphors, or vague fillers such as "just," "quietly,"
"obviously," and "actually." Keep comments true as the app changes.

Use short, direct, STE100-style English:

- Use one main action, condition, or reason per sentence.
- Use active voice where possible.
- Use American English spelling.
- Define and use the same project term for the same thing.
- Treat code names, framework names, and domain names as technical terms.

These rules aim for the clarity of ASD-STE100. Do not claim strict ASD-STE100
compliance until comments and documentation are checked against its controlled
dictionary and writing rules.

### Project Addendums

This file is the common baseline. Add a titled project addendum when the stack,
domain, or delivery process needs rules that this baseline cannot provide.

An addendum can define language, framework, accessibility, testing, build,
deployment, naming, or domain terms. It must refine this baseline, not add
unnecessary process or conflict with these rules.

### Project Conventions

- Identify the authoritative version source for this project. Keep user-visible
  version text and documentation consistent with it.
- The user handles all Git work unless they deliberately ask for it. Do not run
  Git commands or make Git changes on your own initiative. Ask the user when
  the required Git action is unclear.
- Identify this project's startup path and entry points. Keep launchers or
  startup wrappers focused on setup and application startup.
- Keep generated files clearly marked. Edit their source file or generator,
  then regenerate them.
- Keep user documentation, code comments, and tests current. Remove or rewrite
  implementation-phase notes after the related work is complete.

## Project Addendum: aaron-harris-portfolio

**Addendum version:** 1.0  
**Added:** 2026-09-01  

The baseline above states the philosophy. This addendum states the facts of this
project only. It does not repeat the baseline.

### Delivery Constraints

- No build step, no framework, no package manager, no bundler, no launcher.
- Every file is a file that a browser reads directly. GitHub Pages serves the
  repository as it is.
- Use classic `<script src>` tags in a fixed, documented order. Do not use ES
  modules. A browser refuses to load a module from disk, and the only repair for
  that is a launcher.
- The site must work when a person opens it from disk. Reading works offline.
  The blog stream and the publish tool need HTTP or the file hand-off.

### File Map

This is the target state after Phase 4 of the expansion program. Files appear
here before they exist on disk.

| File | Job |
| --- | --- |
| `index.html` | Home page. Hero, work, about, and contact. |
| `gallery.html` | Gallery page. The six-column tile grid. |
| `blog.html` | Blog page. The reading engine and the post manifest. |
| `site.css` | All page style. Replaces the inline style block. |
| `site.js` | Shared page behavior for every page. |
| `work.js` | Carousels, the deep-dive drawer, and the shared lightbox. |
| `blog.js` | The blog reading engine. `blog.html` only. |
| `gallery.js` | The tile packer and the editor's tile consumer. `gallery.html` only. |
| `tool.js` | The copy editor, image editing, and the export. |
| `publish.js` | The blog composer and the publish bundle. `blog.html` only. |
| `blog/YYMM.html` | Generated month pages. Do not edit these by hand. |
| `img/seed/`, `img/work/` | Placeholder images and real project images. |
| `tools/e2e/` | The test harness. |

Each JavaScript trunk is a seven-section manifold. Stretch a trunk to eight
sections only when a distinct job cannot merge into another section. Two files
are at eight and say why in their own headers: `gallery.js`, which both decides
a layout and is an editing surface, and `site.css`, whose gallery grid is a
whole page's layout system with an invariant of its own.

### The Self-Editing Laws

- The site edits the site. Every page carries the editor. The tool writes the
  change.
- Export reads the pristine bytes of a page and splices only between markers.
  Everything outside an edited region stays byte-identical. This is the reason
  export never serializes the live DOM.
- No database, no server, no CMS. Every generated file is standalone HTML that
  works on its own.
- Publish from a clean repository that matches the deployed site. One publish
  for each page load.
- Post ids and anchors are permanent. A rename, a new date, or the deletion of a
  sibling must not change an existing `#p0007` link.
- The tool proposes and the user decides. Nothing reaches the site except as a
  difference that the user commits.
- A machine-owned region is written again at each publish. Do not edit a
  machine-owned region by hand.

### Project Conventions

- The version format is `V0NN`. The commit message carries it, and nothing
  else records it: there is no version file, and no file states a current
  version. `git log` is the answer to "what version is this".
- The user makes every commit and push. Claude never runs a Git write command.
- `node tools/e2e/e2e_test.mjs` and `py -3 tools/e2e/check_markers.py` must both
  pass before each commit.
- Do not use em dashes in copy for the webpage.
- `docs/` is in `.gitignore`. It holds the plans, the manual, and the mockups.
- `CLAUDE.md` is committed. It is not in `.gitignore`, because the rules ship
  with the code they describe.
