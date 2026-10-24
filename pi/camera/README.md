# Camera: live preview stream (dev tool)

Low-latency preview of the Pi camera on a laptop, for aiming the camera and
debugging. This is **not** part of the product pipeline: per the root
CLAUDE.md, video never goes to the server.

```
Pi camera → rpicam-vid (MJPEG) → UDP over Wi-Fi → ffplay on laptop
```

## Run it
1. **Laptop first:** `./view.sh` (default port 5000)
2. **Then on the Pi:** `./stream.sh <laptop-ip>` (e.g. `./stream.sh 192.168.1.163`)

Leave both running; Ctrl+C stops either. Both must be on the same network.
Find the laptop IP on macOS with `ipconfig getifaddr en0`.

## Night vision
Preview: `./stream.sh --night <laptop-ip>` (manual, because rpicam-vid can't auto-switch).
`posture/run.py` and `sentry/run.py` switch **automatically** (`--light auto`, the default) using the camera's per-frame lux estimate. See `../shared/sources.py`.

| Setting | Day | `--night` | Why |
|---|---|---|---|
| Frame rate | 30 fps | 15 fps | Each frame can expose for ~66 ms instead of ~33 ms: about 2× the light before gain (noise) goes up |
| Colour | on | off (B&W) | IR light carries no colour, only a pink cast and colour noise |
| Denoise | default | `cdn_hq` | Cleaner picture in the dark |

**`--noir`**: night-vision boards often have **no IR filter**, so daylight colour comes out pink. `--noir` loads the sensor's `<model>_noir.json` tuning, if the camera software ships one for that model. Camera Module 3 NoIR boards report themselves as `*_noir` and get the right tuning automatically. Cheap OV5647 night-vision boards report plain `ov5647` and need the flag.

**IR LEDs** on these boards usually switch on by themselves (a light sensor on the board), so there's nothing to control in software. To check, cover the light sensor and look for a faint red glow on the LEDs. Find the sensor model with `rpicam-hello --list-cameras`.

## Why these settings
| Before | After |
|---|---|
| H.264 (frames depend on neighbours) | MJPEG (each frame independent) |
| TCP, then UDP | UDP |
| Up to ~8 s delay | Looks instant (glass-to-glass latency not yet measured) |
| Playback buffer could build up | Minimal buffering, late frames dropped |

Switching to MJPEG made the biggest difference. 640×480 @ 30 fps at JPEG
quality 60 is the bandwidth/quality balance that worked.

## Hardware notes
- The Pi 5 has a **22-pin** CSI connector; most cameras ship a 15-pin ribbon.
  Use the official Pi 5 22→15-pin camera cable.
- Power off before reseating. Lift the latch, insert the ribbon straight until
  it stops, press the latch down evenly, and avoid sharp kinks.

## Heads-up for the posture code
Only one process can own the camera. While `stream.sh` is running, the
OpenCV/posture script can't open it (and vice versa). For debugging posture,
have the posture script draw its overlay and stream that instead.
