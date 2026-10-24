# Sentry: who came into the room?

Runs entirely on the Pi. No video leaves it.

```
ultrasonic (10 Hz, camera off) --distance jumps--> camera wakes (8 s)
   --pose detector sees a person in 3 of 5 frames--> sentry event + "Who goes there?"
   --no person--> sentry event {person_confirmed: false}, camera back off
```

**Status:** the logic is unit-tested (`python3 -m unittest -v`). The camera, ultrasonic and
MediaPipe loop compiles, but nobody has run it on the Pi yet.

## Run
| Where | Command |
|---|---|
| Pi, ultrasonic wired | `python3 run.py --trig <BCM> --echo <BCM>` |
| Pi, no ultrasonic yet | `python3 run.py --no-ultrasonic` (OpenCV motion detection wakes the person check; camera stays on at 3 fps) |
| Pi, with the annotated view on your laptop | laptop: `../camera/view.sh`, then Pi: add `--preview <laptop-ip>:5000` |
| Laptop webcam | `python3 run.py --source 0 --no-ultrasonic --show` |

Setup is the same as `../posture` (venv + mediapipe + `get_model.sh`). This uses the same model file.
Only one process can use the camera, so stop `posture/run.py` and `camera/stream.sh` first.

## Night vision
Automatic. The camera's IR LEDs light the room by themselves in the dark. `--light auto`
(the default) switches the camera to night settings when it's dark (15 fps for longer
exposure, black & white, high-quality denoise). When the camera wakes, it picks day/night
from the first settled frame (~0.5 s), so a dark room is handled from the start.
Force a mode with `--light night` / `--light day`. If daylight looks pink, add `--noir`.
Details and thresholds are in `../shared/sources.py`. The preview overlay shows the live
`lux` value, which is how you tune `DARK_LUX` / `BRIGHT_LUX` for the real room.

## Ultrasonic wiring (HC-SR04)
- VCC → 5V, GND → GND, TRIG → any GPIO
- **ECHO is 5 V. Use a voltage divider** (1 kΩ from ECHO to the GPIO, 2 kΩ from the GPIO to GND), or it can damage the Pi.
- Point it across the room's entrance. It learns the empty-room distance (rolling median) and
  triggers when a reading differs by >25 cm (or 15%) twice in a row. A new distance that
  stays for ~15 s (moved furniture) becomes the new baseline.
- Uses `gpiozero` (preinstalled; RPi.GPIO doesn't work on the Pi 5).

## Tuning (top of `watch.py`)
`LOOK_S` 8 s · `NEED_HITS/WINDOW` 3 of 5 · `MIN_CONFIDENCE` 0.5 · `COOLDOWN_S` 60 s after an
alert · `FALSE_COOLDOWN_S` 15 s after motion with no person.

## Event
`{distance_cm, person_confirmed, confidence, night, trigger: "ultrasonic"|"camera"}`.
`distance_cm` is null in camera-only mode.
