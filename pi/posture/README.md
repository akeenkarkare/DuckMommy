# Posture detection

Runs entirely on the Pi: camera → MediaPipe Pose Landmarker → slouch judge →
spoken prompt + `posture` events. No video leaves the Pi.

**Status:** the slouch logic is unit-tested. The camera + MediaPipe loop
compiles, but nobody has run it on the Pi yet, so the first run is the real test.

## Setup on the Pi (once)
```bash
cd pi/posture
python3 -m venv --system-site-packages .venv   # needed to see apt's picamera2
source .venv/bin/activate
pip install mediapipe                          # Linux ARM64 wheel exists (1.1.1)
./get_model.sh lite
```

## Run
| Where | Command |
|---|---|
| Pi | `python3 run.py` |
| Pi, with the annotated view on your laptop | laptop: `../camera/view.sh`, then Pi: `python3 run.py --preview <laptop-ip>:5000` |
| Laptop webcam, no Pi | `python3 run.py --source 0 --show` (q quits, c recalibrates) |

Only one process can use the Pi camera, so stop `camera/stream.sh` first.
Tuning flags: `--severity 0..100` (default 50), `--delay <s>` (default 5).

Events print to stdout as JSON lines in the relay's wire format, ready for the
uplink client. The speak line goes to `espeak-ng`/`espeak` (Pi) or `say` (Mac)
if installed, and is printed otherwise.

## How it judges a slouch (side view)
- **Calibrates to each person.** When someone sits down, the duck says
  "Sit up tall for me!" and records their upright bend for 3 s (median).
  A slouch is bending past *their own* baseline, so tall/short people and
  different camera angles all work. Gone for 10 s → the next person is
  recalibrated. Restart `run.py` (or press `c` in the `--show` window) to
  redo it.
- **Bend** = angle at the shoulder between the hip→shoulder (torso) line and
  the shoulder→ear line. Leaning forward with a straight back keeps it near
  0°; a jutting head or rounded back raises it. Torso line drawn in blue.
- **No hip visible** (desk in the way): falls back to shoulder→ear vs.
  vertical, which *can't* tell a straight lean from a slouch. The overlay
  says `vs vertical (no hip)`. Frame the camera so the hip is in view.
- **How far past the baseline counts**, from `posture_severity`:
  0 → +9°, 50 → +5°, 100 → +1°. Clears 3° below the limit.
- Smoothed per frame, with 3° hysteresis so it doesn't flicker at the line.
- Prompt after `posture_delay_s` of continuous slouch, remind every 30 s,
  `upright` event when a prompted slouch ends. Lost tracking for 2 s ends it.

## Files
- `judge.py`: slouch logic, stdlib only. Tests: `python3 -m unittest -v`
- `pose.py`: MediaPipe Tasks API wrapper (the old `mp.solutions` API is gone).
- `run.py`: the loop, camera sources, TTS, debug overlay.
- `get_model.sh`: downloads the `.task` model file (gitignored).
