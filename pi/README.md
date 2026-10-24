# Pi: the duck itself

`duck.py` is the one program that runs on the Pi. It owns the camera, talks to the relay and runs every feature:

| Feature | Hardware | Code | Event |
|---|---|---|---|
| Quack when the head is pressed | pressure sensor (digital out) | `duck.py` + `shared/voice.py` | `pat {touch_ms}` |
| Voice: ElevenLabs, messages set on the dashboard | speakers | `shared/voice.py` (via relay `/tts`) | — |
| Posture prompts | camera | `posture/` | `posture` |
| Sign to Duck: 54 ASL word signs → phrases + commands | camera | `asl/` | `sign {text, signs, commands}` |
| Sound alerts: doorbell, phone, alarm, beeps, shouting → LED | USB mic + LED | `sounds/` | `sound {kind, label, score}` |
| Sentry (when away) + night vision | ultrasonic + camera | `sentry/`, `shared/sources.py` | `sentry` |
| At desk / away | ultrasonic (or camera) | `shared/presence.py` | `presence` |
| Live view on the dashboard (only while someone allowed is watching) | camera | `shared/uplink.py` `send_frame`, `shared/preview.py` `render_jpeg` | (binary frames, not events) |
| Lock-in coach: what's due when you sit down, deadline + event reminders, check-ins, focus sessions | calendar from the relay + camera | `coach/` (lines via relay `/nudge`, templates offline) | `coach {kind, text}` |
| Zoned out? 5 min with no movement → nudge, 5 more → away (`presence` reason `idle`) | camera | `motion/` | `coach`, `presence` |

**Status:** all the decision logic is unit-tested, and the relay link and voice proxy are
tested against the real relay. The camera, GPIO, mic and MediaPipe parts compile, but
nobody has run them on the Pi yet.

## Setup on the Pi (once)
```bash
cd pi
python3 -m venv --system-site-packages .venv     # sees apt's picamera2 + gpiozero
source .venv/bin/activate
pip install mediapipe websockets
./get_models.sh                                  # pose, hand and YAMNet models
cp .env.example .env                             # then fill in token, relay URL, pins, mic
```
Laptop side: put `ELEVENLABS_API_KEY` and `ELEVENLABS_VOICE_ID` in `backend/.env`, then
`cd backend && npm run make-quack` makes `assets/quack.wav` (copy the repo to the Pi after).

## Camera won't start?
`./doctor.sh` (from `pi/`, venv active) checks the usual causes in order (camera
detected, camera already in use, venv/picamera2/numpy, mediapipe version, models,
laptop camera permission) and prints the fix for each.

## Run
```bash
python3 duck.py                 # everything
python3 duck.py --no-mic        # skip sound alerts
python3 duck.py --source 0      # laptop webcam (dev; GPIO parts need the Pi)
```
Only one process can use the camera. `posture/run.py`, `sentry/run.py` and `asl/run.py`
are standalone tuning tools, so stop `duck.py` before running them.

## Wiring (BCM pin numbers go in `.env`)
- **Pressure sensor → `PRESS_PIN`.** A bare FSR is analog and the Pi has no ADC, so use an FSR
  module with a comparator (digital `DO` pin; set the threshold with its potentiometer), or any
  touch module. Set `PRESS_ACTIVE=low` if its output goes low when pressed.
- **LED → `LED_PIN`.** GPIO → 330 Ω → LED → GND. Patterns: doorbell fast blink, phone slow
  pulse, alarm strobe, notification 3 blinks, calling long glows.
- **Ultrasonic → `ULTRASONIC_TRIG` / `ULTRASONIC_ECHO`.** ECHO is 5 V and needs a 1 kΩ/2 kΩ divider.
- **Mic → `MIC_DEVICE`.** Find it with `arecord -l`. To see what the mic hears: `python3 sounds/listener.py <device>`.

## Sign to Duck
ASL word signs with movement (HELLO, HELP, START + FOCUS → "Let's start a focus session."),
one sign at a time with the hands lowered in between. It needs sign data and a trained model
first: see `asl/README.md`. Without one, everything else runs and nothing is recognised.

## Tests
`python3 -m unittest` in `asl/`, `sounds/`, `sentry/`, `posture/`, `coach/`, `motion/`; `python3 -m unittest test_presence` in `shared/`.
