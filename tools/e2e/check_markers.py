# -*- coding: utf-8 -*-
"""Validate the marker families in every managed page.

The pages are the ones the host's site.config.js names, read from that file,
so the list has one home. A page the engine may write has to obey the marker
rules, and a page it may not write is not checked here because nothing
splices it.

Three families share one page:

    [edit:slug]   one editable region; the editor replaces what is between
                  the pair, so the span must hold exactly one element
    [list:name]   a run of blocks the editor may add to and reorder
    [item:id]     one block of a list; its id is permanent

They share one stack, so a close marker that crosses a family boundary is an
error here rather than a silent reinterpretation at export time.

The site is the repo root unless --site names another site's root:

    py -3 tools/e2e/check_markers.py --site tools/e2e/fixtures/lawn
"""
import argparse, io, os, re, sys

REPO = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..")
ARGS = argparse.ArgumentParser(description="Validate the marker families in every managed page.")
ARGS.add_argument("--site", default=REPO, help="the site root to check (default: the repo root)")
ROOT = os.path.abspath(ARGS.parse_args().site)

def config_pages(root):
    """Every path in the pages list of site.config.js, in its order."""
    path = os.path.join(root, "site.config.js")
    if not os.path.exists(path):
        sys.exit("FAIL site.config.js is missing from %s" % os.path.abspath(root))
    with io.open(path, "r", encoding="utf-8") as f:
        text = f.read()
    m = re.search(r"\bpages\s*:\s*\[(.*?)\]", text, re.S)
    found = re.findall(r'\bpath\s*:\s*"([^"]+)"', m.group(1)) if m else []
    if not found:
        sys.exit("FAIL site.config.js names no pages")
    return found

PAGES = config_pages(ROOT)
VOID = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link",
        "meta", "param", "source", "track", "wbr"}
MARKER = re.compile(r"<!--\[(/?)(edit|list|item):([\w-]+)\]-->")

def scan_page(text):
    """Return (errors, slugs, spans, lists) for one page's source."""
    markers = [(m.start(), m.end(), m.group(1) == "/", m.group(2), m.group(3))
               for m in MARKER.finditer(text)]

    errors, slugs, spans = [], [], []
    lists = []          # [(name, [item id, ...])] in document order
    stack = []          # (family, name, end offset) for every open marker
    for start, end, closing, family, name in markers:
        if not closing:
            errors.extend(check_open(stack, lists, family, name))
            stack.append((family, name, end))
            continue
        if not stack or stack[-1][0] != family or stack[-1][1] != name:
            top = "%s %s" % (stack[-1][0], stack[-1][1]) if stack else "(none)"
            errors.append("close marker %s %s does not match open %s"
                          % (family, name, top))
            continue
        ofamily, oname, oend = stack.pop()
        if ofamily == "edit":
            slugs.append(oname)
            spans.append((oname, text[oend:start]))
    if stack:
        errors.append("unclosed markers: %s" % ["%s %s" % (f, n) for f, n, _ in stack])

    dupes = {x for x in slugs if slugs.count(x) > 1}
    if dupes:
        errors.append("duplicate slugs: %s" % dupes)

    for slug, span in spans:
        err = check_span(slug, span)
        if err:
            errors.append(err)
    return errors, slugs, spans, lists

def check_open(stack, lists, family, name):
    """The rules one opening marker has to obey, given what is already open."""
    errors = []
    if family == "edit":
        # dd-gallery regions nest one level inside deepdive; nothing nests deeper
        if sum(1 for x in stack if x[0] == "edit") >= 2:
            errors.append("marker %s nests deeper than one level" % name)
        return errors
    if family == "list":
        if any(x[0] == "list" for x in stack):
            errors.append("list %s opens inside another list" % name)
        if any(n == name for n, _ in lists):
            errors.append("duplicate list name: %s" % name)
        lists.append((name, []))
        return errors
    # item: directly inside a list, and named once in it. Lists cannot nest,
    # so the list being added to is always the last one opened.
    if not stack or stack[-1][0] != "list":
        errors.append("item %s is not directly inside a list" % name)
        return errors
    ids = lists[-1][1]
    if name in ids:
        errors.append("duplicate item id in list %s: %s" % (stack[-1][1], name))
    ids.append(name)
    return errors

def check_span(slug, span):
    body = span.strip()
    if not (body.startswith("<") and body.endswith(">")):
        return "%s: span does not start/end with a tag" % slug
    # tag-balance walk; also count top-level elements
    depth, top = 0, 0
    for m in re.finditer(r"<(/?)([a-zA-Z][\w-]*)((?:[^>\"']|\"[^\"]*\"|'[^']*')*)>", body):
        closing, name, attrs = m.group(1), m.group(2).lower(), m.group(3)
        if name in VOID or attrs.rstrip().endswith("/"):
            if not closing and depth == 0:
                top += 1
            continue
        if closing:
            depth -= 1
            if depth < 0:
                return "%s: unbalanced close </%s>" % (slug, name)
            if depth == 0:
                top += 1
        else:
            depth += 1
    if depth != 0:
        return "%s: unbalanced (depth %d at end)" % (slug, depth)
    if top != 1:
        return "%s: %d top-level elements (want exactly 1)" % (slug, top)
    return None

failed = 0
total = 0
for page in PAGES:
    path = os.path.join(ROOT, page)
    if not os.path.exists(path):
        print("FAIL %s: managed page is missing from the repo" % page)
        failed += 1
        continue
    with io.open(path, "r", encoding="utf-8") as f:
        errors, slugs, spans, lists = scan_page(f.read())
    if errors:
        failed += 1
        print("FAIL %s" % page)
        for e in errors:
            print(" -", e)
        continue
    total += len(spans)
    print("OK %s: %d regions, all pairs matched, unique slugs, one element each, "
          "tags balanced." % (page, len(spans)))
    print("  slugs:", ", ".join(slugs))
    for name, ids in lists:
        print("  list %s: %d item(s):" % (name, len(ids)), ", ".join(ids))

if failed:
    sys.exit(1)
print("OK: %d regions across %d page(s)." % (total, len(PAGES)))
