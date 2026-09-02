# -*- coding: utf-8 -*-
"""Validate edit-marker integrity in every managed page.

Keep this list in step with MANAGED_PAGES in tool.js. A page the engine may
write has to obey the marker rules, and a page it may not write is not checked
here because nothing splices it.
"""
import io, os, re, sys

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..")
PAGES = ["index.html", "blog.html", "gallery.html"]
VOID = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link",
        "meta", "param", "source", "track", "wbr"}

def scan_page(text):
    """Return (errors, slugs, spans) for one page's source."""
    markers = [(m.start(), m.end(), m.group(1), m.group(2))
               for m in re.finditer(r"<!--\[(edit|/edit):([\w-]+)\]-->", text)]

    errors, slugs, spans = [], [], []
    # stack-based pairing: dd-gallery regions nest one level inside deepdive
    stack = []
    for s, e, kind, slug in markers:
        if kind == "edit":
            if len(stack) >= 2:
                errors.append("marker %s nests deeper than one level" % slug)
            stack.append((slug, e))
        else:
            if not stack or stack[-1][0] != slug:
                errors.append("close marker %s does not match open %s" %
                              (slug, stack[-1][0] if stack else "(none)"))
                continue
            oslug, oend = stack.pop()
            slugs.append(oslug)
            spans.append((oslug, text[oend:s]))
    if stack:
        errors.append("unclosed markers: %s" % [x[0] for x in stack])

    dupes = {x for x in slugs if slugs.count(x) > 1}
    if dupes:
        errors.append("duplicate slugs: %s" % dupes)

    for slug, span in spans:
        err = check_span(slug, span)
        if err:
            errors.append(err)
    return errors, slugs, spans

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
        errors, slugs, spans = scan_page(f.read())
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

if failed:
    sys.exit(1)
print("OK: %d regions across %d page(s)." % (total, len(PAGES)))
