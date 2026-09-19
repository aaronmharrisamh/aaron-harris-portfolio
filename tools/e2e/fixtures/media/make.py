"""tools/e2e/fixtures/media/make.py - make the suite's real media files, once.

A person runs this, and the suite never does:

    py -3 tools/e2e/fixtures/media/make.py

It needs ffmpeg and ffprobe on the PATH. It writes each file into this
folder, then writes manifest.json and README.md with each file's bytes,
SHA-256, codecs, size and duration. The suite reads the files and checks
each hash against manifest.json, so a file that changed fails loudly and
a file made again must be committed with its new manifest.

The files are short and small on purpose: two or three seconds at 160x90.
They come from ffmpeg's own test sources, a colour pattern and a sine
tone, so they carry nobody's work. The two MIDI files are written here,
byte by byte, because ffmpeg does not write MIDI.
"""
import hashlib
import json
import os
import shutil
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))

# A picture, and a tone, from ffmpeg's test sources.
PICTURE = "testsrc2=size={size}:rate=15:duration={secs}"
TONE = "sine=frequency={freq}:sample_rate=22050:duration={secs}"
# No date, no encoder name and no stream titles in the files.
PLAIN = ["-map_metadata", "-1", "-fflags", "+bitexact", "-flags:v", "+bitexact", "-flags:a", "+bitexact"]

# name, what the suite proves with it, and the ffmpeg arguments after the inputs
FILES = [
    ("clip.mp4", "H.264 video with AAC sound: play, pause, seek, and the default player",
     {"size": "160x90", "secs": 3, "picture": True, "tone": True},
     ["-c:v", "libx264", "-profile:v", "baseline", "-pix_fmt", "yuv420p", "-crf", "30",
      "-c:a", "aac", "-b:a", "32k", "-ac", "1", "-movflags", "+faststart"]),
    ("square.mp4", "a square H.264 video with no sound",
     {"size": "120x120", "secs": 2, "picture": True},
     ["-c:v", "libx264", "-profile:v", "baseline", "-pix_fmt", "yuv420p", "-crf", "30", "-movflags", "+faststart"]),
    ("tall.webm", "a portrait VP8 video with no sound",
     {"size": "90x160", "secs": 2, "picture": True},
     ["-c:v", "libvpx", "-b:v", "120k"]),
    ("silent.webm", "a silent VP8 animation: muted autoplay, loop and nocontrols",
     {"size": "160x90", "secs": 2, "picture": True},
     ["-c:v", "libvpx", "-b:v", "120k"]),
    ("sound.webm", "VP8 video with Opus sound: mute, unmute and a refused audible autoplay",
     {"size": "160x90", "secs": 2, "picture": True, "tone": True},
     ["-c:v", "libvpx", "-b:v", "120k", "-c:a", "libopus", "-b:a", "24k", "-ac", "1"]),
    ("voice.weba", "Opus sound alone in WebM, with the .weba extension",
     {"secs": 2, "tone": True},
     ["-c:a", "libopus", "-b:a", "24k", "-ac", "1", "-f", "webm"]),
    ("tone.mp4", "AAC sound alone in MP4: the extension does not make it a video",
     {"secs": 2, "tone": True},
     ["-c:a", "aac", "-b:a", "32k", "-ac", "1", "-movflags", "+faststart"]),
    ("tone.webm", "Opus sound alone in WebM, with the .webm extension",
     {"secs": 2, "tone": True, "freq": 660},
     ["-c:a", "libopus", "-b:a", "24k", "-ac", "1"]),
    ("tone.mp3", "an MP3 sound",
     {"secs": 2, "tone": True},
     ["-c:a", "libmp3lame", "-b:a", "32k", "-ac", "1"]),
    ("tone.wav", "a PCM WAV sound",
     {"secs": 1, "tone": True},
     ["-c:a", "pcm_s16le", "-ac", "1", "-ar", "8000"]),
    ("tone.ogg", "Vorbis sound in Ogg",
     {"secs": 2, "tone": True},
     ["-c:a", "libvorbis", "-q:a", "0", "-ac", "1"]),
    ("theora.ogg", "Theora video in Ogg: a video by its header, which a browser may not play",
     {"size": "160x90", "secs": 2, "picture": True},
     ["-c:v", "libtheora", "-q:v", "3"]),
    ("oldcodec.mp4", "MPEG-4 Part 2 video in MP4: a valid file whose codec a browser does not play",
     {"size": "160x90", "secs": 1, "picture": True},
     ["-c:v", "mpeg4", "-q:v", "8", "-movflags", "+faststart"]),
]

# Two small MIDI files: one note, and two. The track ends with its End of
# Track event, and the header says one track at 96 ticks a beat.
def midi_bytes(notes):
    track = []
    for note in notes:
        track += [0x00, 0x90, note, 64, 0x60, 0x80, note, 0]
    track += [0x00, 0xFF, 0x2F, 0x00]
    header = b"MThd" + (6).to_bytes(4, "big") + bytes([0, 0, 0, 1, 0, 96])
    return header + b"MTrk" + len(track).to_bytes(4, "big") + bytes(track)

MIDI = [
    ("song.mid", "a MIDI file: a download with no player", [60]),
    ("song.midi", "a MIDI file with the .midi extension", [60, 64]),
]


def run(args):
    done = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if done.returncode != 0:
        sys.exit("ffmpeg failed:\n" + " ".join(args) + "\n" + done.stderr.decode("utf-8", "replace"))
    return done.stdout


def make(name, spec, tail):
    ins = []
    if spec.get("picture"):
        ins += ["-f", "lavfi", "-i", PICTURE.format(size=spec["size"], secs=spec["secs"])]
    if spec.get("tone"):
        ins += ["-f", "lavfi", "-i", TONE.format(secs=spec["secs"], freq=spec.get("freq", 440))]
    run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y"] + ins + PLAIN + tail + [os.path.join(HERE, name)])


def facts(name, purpose):
    path = os.path.join(HERE, name)
    data = open(path, "rb").read()
    row = {"name": name, "purpose": purpose, "bytes": len(data),
           "sha256": hashlib.sha256(data).hexdigest(),
           "container": "", "video": None, "audio": None, "width": 0, "height": 0, "seconds": 0}
    if name.endswith((".mid", ".midi")):
        row["container"] = "midi"
        return row
    probe = json.loads(run(["ffprobe", "-v", "error", "-show_format", "-show_streams", "-of", "json", path]))
    row["container"] = probe["format"]["format_name"]
    row["seconds"] = round(float(probe["format"].get("duration", 0)), 2)
    for s in probe.get("streams", []):
        if s["codec_type"] == "video" and row["video"] is None:
            row["video"] = s["codec_name"]
            row["width"], row["height"] = s.get("width", 0), s.get("height", 0)
        elif s["codec_type"] == "audio" and row["audio"] is None:
            row["audio"] = s["codec_name"]
    return row


def main():
    for tool in ("ffmpeg", "ffprobe"):
        if not shutil.which(tool):
            sys.exit(tool + " is not on the PATH.")
    rows = []
    for name, purpose, spec, tail in FILES:
        make(name, spec, tail)
        rows.append(facts(name, purpose))
    for name, purpose, notes in MIDI:
        open(os.path.join(HERE, name), "wb").write(midi_bytes(notes))
        rows.append(facts(name, purpose))
    manifest = {"made_by": "tools/e2e/fixtures/media/make.py", "files": rows}
    with open(os.path.join(HERE, "manifest.json"), "w", encoding="utf-8", newline="\n") as f:
        json.dump(manifest, f, indent=2)
        f.write("\n")
    lines = [
        "# The suite's media files",
        "",
        "Made once by `make.py` in this folder, from ffmpeg's own test sources.",
        "The suite checks each file against its SHA-256 in `manifest.json`.",
        "Do not edit a file by hand: run `make.py` again and commit the files,",
        "`manifest.json` and this table together.",
        "",
        "| File | Bytes | Container | Video | Sound | Size | Seconds | What it proves |",
        "|---|---|---|---|---|---|---|---|",
    ]
    for r in rows:
        size = "%dx%d" % (r["width"], r["height"]) if r["width"] else "-"
        lines.append("| `%s` | %d | %s | %s | %s | %s | %s | %s |" % (
            r["name"], r["bytes"], r["container"], r["video"] or "-", r["audio"] or "-",
            size, r["seconds"] or "-", r["purpose"]))
    lines += ["", "SHA-256 of each file is in `manifest.json`."]
    with open(os.path.join(HERE, "README.md"), "w", encoding="utf-8", newline="\n") as f:
        f.write("\n".join(lines) + "\n")
    print("made %d files, %d bytes in all" % (len(rows), sum(r["bytes"] for r in rows)))


if __name__ == "__main__":
    main()
