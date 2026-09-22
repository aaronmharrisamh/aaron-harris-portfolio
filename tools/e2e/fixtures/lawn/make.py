"""tools/e2e/fixtures/lawn/make.py - make the lawn fixture's three photos, once.

A person runs this, and the suite never does:

    py -3 tools/e2e/fixtures/lawn/make.py

It writes three small PNG files into img/ and then writes manifest.json
with each file's bytes, SHA-256, width and height. The suite checks each
file against manifest.json, so a file that changed fails loudly. A file
made again must be committed with its new manifest.

The pictures are flat patterns of two greens, drawn here pixel by pixel,
so they carry nobody's work. The PNG writer is the smallest one the
format allows: a signature, a header, one compressed data chunk and an
end chunk, with no color profile, no date and no text.
"""
import hashlib
import json
import os
import struct
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))

# The two greens of a mowed lawn, and a pale sky.
DARK = (74, 138, 60)
LIGHT = (112, 170, 86)
SKY = (196, 224, 240)

# name, what the suite proves with it, width, height, and the pattern
FILES = [
    ("img/yard-1.png", "the mowing page's carousel photo, a wide frame",
     640, 360, lambda x, y: SKY if y < 90 else (DARK if (x // 40) % 2 else LIGHT)),
    ("img/yard-2.png", "a gallery tile in a four by three frame",
     480, 360, lambda x, y: DARK if ((x + y) // 30) % 2 else LIGHT),
    ("img/yard-3.png", "a square gallery tile",
     360, 360, lambda x, y: DARK if ((x // 60) + (y // 60)) % 2 else LIGHT),
]


def chunk(kind, data):
    """One PNG chunk: its length, its type, its data, and a CRC of the last two."""
    body = kind + data
    return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)


def png_bytes(width, height, pixel):
    """A truecolor PNG at eight bits a channel. Each row starts with filter 0."""
    rows = bytearray()
    for y in range(height):
        rows.append(0)
        for x in range(width):
            rows.extend(pixel(x, y))
    header = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) +
            chunk(b"IDAT", zlib.compress(bytes(rows), 9)) + chunk(b"IEND", b""))


def main():
    rows = []
    for name, purpose, width, height, pixel in FILES:
        data = png_bytes(width, height, pixel)
        path = os.path.join(HERE, *name.split("/"))
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "wb") as f:
            f.write(data)
        rows.append({"name": name, "purpose": purpose, "bytes": len(data),
                     "sha256": hashlib.sha256(data).hexdigest(),
                     "width": width, "height": height})
    manifest = {"made_by": "tools/e2e/fixtures/lawn/make.py", "files": rows}
    with open(os.path.join(HERE, "manifest.json"), "w", encoding="utf-8", newline="\n") as f:
        json.dump(manifest, f, indent=2)
        f.write("\n")
    print("made %d files, %d bytes in all" % (len(rows), sum(r["bytes"] for r in rows)))


if __name__ == "__main__":
    main()
