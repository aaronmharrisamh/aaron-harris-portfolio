# The suite's media files

Made once by `make.py` in this folder, from ffmpeg's own test sources.
The suite checks each file against its SHA-256 in `manifest.json`.
Do not edit a file by hand: run `make.py` again and commit the files,
`manifest.json` and this table together.

| File | Bytes | Container | Video | Sound | Size | Seconds | What it proves |
|---|---|---|---|---|---|---|---|
| `clip.mp4` | 36418 | mov,mp4,m4a,3gp,3g2,mj2 | h264 | aac | 160x90 | 3.0 | H.264 video with AAC sound: play, pause, seek, and the default player |
| `square.mp4` | 14877 | mov,mp4,m4a,3gp,3g2,mj2 | h264 | - | 120x120 | 2.0 | a square H.264 video with no sound |
| `tall.webm` | 30502 | matroska,webm | vp8 | - | 90x160 | 2.0 | a portrait VP8 video with no sound |
| `silent.webm` | 31726 | matroska,webm | vp8 | - | 160x90 | 2.0 | a silent VP8 animation: muted autoplay, loop and nocontrols |
| `sound.webm` | 40008 | matroska,webm | vp8 | opus | 160x90 | 2.01 | VP8 video with Opus sound: mute, unmute and a refused audible autoplay |
| `voice.weba` | 8567 | matroska,webm | - | opus | - | 2.01 | Opus sound alone in WebM, with the .weba extension |
| `tone.mp4` | 9361 | mov,mp4,m4a,3gp,3g2,mj2 | - | aac | - | 2.0 | AAC sound alone in MP4: the extension does not make it a video |
| `tone.webm` | 9065 | matroska,webm | - | opus | - | 2.01 | Opus sound alone in WebM, with the .webm extension |
| `tone.mp3` | 8457 | mp3 | - | mp3 | - | 2.0 | an MP3 sound |
| `tone.wav` | 16044 | wav | - | pcm_s16le | - | 1.0 | a PCM WAV sound |
| `tone.ogg` | 5549 | ogg | - | vorbis | - | 2.0 | Vorbis sound in Ogg |
| `theora.ogg` | 22587 | ogg | theora | - | 160x90 | 2.0 | Theora video in Ogg: a video by its header, which a browser may not play |
| `oldcodec.mp4` | 22625 | mov,mp4,m4a,3gp,3g2,mj2 | mpeg4 | - | 160x90 | 1.0 | MPEG-4 Part 2 video in MP4: a valid file whose codec a browser does not play |
| `song.mid` | 34 | midi | - | - | - | - | a MIDI file: a download with no player |
| `song.midi` | 42 | midi | - | - | - | - | a MIDI file with the .midi extension |

SHA-256 of each file is in `manifest.json`.
