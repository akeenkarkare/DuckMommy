# pi/ — the duck's body and brain

Everything that runs **inside the duck** (Raspberry Pi 5). Root rules in `/CLAUDE.md` apply:
hardcode before AI, video never leaves the Pi, ask before adding a dependency, no secrets in git.
Setup and wiring for humans: `README.md`. This file is the **mental model**: what each part
is, what data it needs, where that data comes from, and what it produces.

---

## 1. The one idea: a five-layer pipeline

Every feature is the same shape. Data flows **down**; nothing flows back up.

```
 ┌────────────── 1. SENSORS (hardware) ───────────────────────────────────────────┐
 │  Pi camera     ultrasonic     pressure pad     USB mic        relay WebSocket  │
 └──────┬────────────┬───────────────┬───────────────┬────────────────┬───────────┘
        │ RGB frame  │ distance cm   │ press/release │ 16 kHz PCM     │ settings, commands
 ┌──────▼────────────▼───────────────┼───────────────▼────────────────┼───────────┐
 │  2. PERCEPTION (models, turn raw signal into facts)                │           │
 │  Holistic ─► body Points + (75,3) hand frame   YAMNet ─► [(label, score)]       │
 │  MOG2 motion ─► fraction changed                                   │           │
 └──────┬────────────┬───────────────┬───────────────┬────────────────┼───────────┘
 ┌──────▼────────────▼───────────────▼───────────────▼────────────────▼───────────┐
 │  3. BRAINS (pure Python logic, no I/O, unit-tested; read `settings` live)        │
 │  Presence   PostureJudge   SentryWatch   WordSignReader   SoundAlerts  on_press  │
 └──────┬──────────────────────────────────────────────────────────────────────────┘
        │  list of ACTION tuples  (see §3: the only thing brains are allowed to return)
 ┌──────▼──────────────────────────────────────────────────────────────────────────┐
 │  4. DISPATCH  duck.py  Duck.act()  — routes each action to an output              │
 └──────┬──────────────┬──────────────┬──────────────┬─────────────────────────────┘
 ┌──────▼─────┐ ┌──────▼─────┐ ┌──────▼─────┐ ┌──────▼──────┐
 │ 5. Uplink  │ │   Voice    │ │ Alert LED  │ │ sign command│   OUTPUTS
 │ event→relay│ │ speak/quack│ │ blink kind │ │ (logged)    │
 └────────────┘ └────────────┘ └────────────┘ └─────────────┘
```

**Rule of thumb when adding or moving code:** decide which layer it is. Sensors and outputs
touch hardware. Perception touches models. Brains touch *nothing* — they take numbers + `now`
+ `settings` and return actions, so they unit-test on a laptop with fake data.

---

## 2. Component cards

Each card: **needs** (the data it looks at) · **gets it from** · **looks for** · **emits** · **files** · **knobs**.

### 🪑 Presence — "is someone at the desk?"
- **Needs:** distance in cm, *or* "camera sees a person" (bool).
- **Gets it from:** ultrasonic at 10 Hz (`shared/ultrasonic.py`, gpiozero `DistanceSensor`).
  No ultrasonic wired → falls back to the camera (`points is not None`).
- **Looks for:** closer than `NEAR_CM=110` for `ARRIVE_S=1.5` → arrive; past `FAR_CM=140`
  (hysteresis) or unseen for `LEAVE_S=8` → leave.
- **Emits:** `presence {present, distance_cm}` + speaks `presence_message` on arrive.
  **Its real job: gates the camera.** Present → camera on for posture + signs. Away → camera off (unless sentry).
- **Files:** `shared/presence.py` (brain), `shared/ultrasonic.py` (sensor).

### 🦢 Posture — "are they slouching?"
- **Needs:** ear, shoulder, hip points (pixels + visibility) per frame.
- **Gets it from:** camera → Holistic (or Pose Landmarker if the Holistic model is missing) → `Points`.
- **Looks for:** neck angle (ear–shoulder vs. torso, or vs. vertical when the desk hides the hip).
  Calibrates to *your* upright angle for `CALIBRATE_S=3` ("Sit up tall for me!"), then slouch =
  bend past baseline + margin (`posture_severity` 0/50/100 → 9/5/1°), held for `posture_delay_s`.
  Reminds every 30 s. Smoothed (EMA 0.3), 3° hysteresis.
- **Emits:** `posture {state: slouch|upright, neck_angle_deg, slouch_duration_s}` + speaks `posture_message`.
- **Files:** `posture/judge.py` (brain), `posture/pose.py` (perception, fallback), `posture/run.py` (tuning tool).

### 🛡️ Sentry — "did someone walk in while you're away?"
- **Needs:** stage 1 trigger (motion), stage 2 confirm (person confidence per frame).
- **Gets it from:** stage 1 = ultrasonic jump from the room's median baseline
  (≥ max(25 cm, 15%), twice in a row) **or** camera MOG2 motion ≥ 2% of a 160×120 frame.
  Stage 2 = camera wakes, Holistic body points → mean visibility of nose/shoulders/hips.
- **Looks for:** person in 3 of last 5 frames within `LOOK_S=8` (after 0.7 s exposure warm-up).
  Cooldown 60 s after a real person, 15 s after a false alarm. Night vision automatic.
- **Emits:** `sentry {distance_cm, person_confirmed, confidence, night, trigger}` + speaks `sentry_message`.
- **Runs only when:** away **and** `sentry_enabled`.
- **Sitting down while it's on** (`duck.py`): the arrival is a possible intruder: `sentry` event (`trigger: "arrive"`) + `sentry_message`, and no welcome, coach brief, posture/signs or "hey duck" until `sentry_enabled` goes off (dashboard "It's me", which the dashboard pops up with an alarm). Voice: "hey duck, sentry mode on".
- **Files:** `sentry/watch.py` (brain), `sentry/vision.py` (perception), `sentry/run.py` (tool).

### 🤟 Sign to Duck — "what ASL word did they sign?"
- **Needs:** a `(75, 3)` frame per camera frame: 33 body + 21 left-hand + 21 right-hand points.
- **Gets it from:** camera → Holistic (one pass, shared with posture/sentry) → `landmarks.py`.
- **Looks for:** 1) **Segmenter** — a hand rises above the *rest line* (1.4 shoulder-widths below
  the shoulders) = sign starts; hands down 0.35 s = sign ends. 2) **Classifier** — DTW against
  templates in `asl/models/asl_templates.npz`, or "not a sign". 3) **PhraseBuilder** — no new
  sign for `phrase_gap_seconds` (1.6 s) → glosses become a sentence via `phrases.json`.
- **Emits:** `led sign` per word, then `sign {text, signs, commands}` + speaks the sentence +
  `command <name>` (start_focus, break, …), which drive the coach's focus timer.
- **Toggle:** `sign_enabled` (live). Without a trained model it runs and recognises nothing.
- **Files:** `asl/asl_engine.py` (brain), `asl/holistic.py` + `landmarks.py` + `features.py` +
  `classifier.py` (perception), `asl/run.py` (tool), `train.py` + importers (offline training).
- **⚠️ Licence:** `asl/data/citizen*` and `asl/models/` are built from ASL Citizen
  (non-commercial research, **no redistribution**). Keep them off GitHub and off machines
  that aren't yours.

### 🔔 Sound alerts — "doorbell? phone? alarm?"
- **Needs:** `[(label, score)]` for each ~1 s of audio.
- **Gets it from:** USB mic (`arecord`, 16 kHz mono, `MIC_DEVICE`) → YAMNet every 0.5 s,
  in a background thread (`sounds/listener.py`).
- **Looks for:** label groups (doorbell / phone / alarm / notification / calling). One window
  ≥ 0.5, or two in a row ≥ 0.3. Per-kind cooldown. Ignored while the duck itself is talking (`voice.busy()`).
- **Emits:** `sound {kind, label, score}` + `led <kind>` (each kind has its own blink pattern).
- **Files:** `sounds/alerts.py` (brain), `sounds/listener.py` (perception), `sounds/led.py` (output).

### 🧠 Memory locker — "hey duck, remember ..." / "what did I tell you ...?"
- **Needs:** the same 0.5 s mic chunks as sound alerts (`SoundListener(on_audio=...)`, so the mic is opened once).
- **Wake word:** offline Vosk with a grammar of just `hey duck` / `okay duck` / `hi duck` (`models/vosk-small-en`).
  Nothing leaves the Pi before the wake word. The last 1.5 s are kept so "hey duck remember…" in one breath works.
- **Then:** records until 0.8 s of quiet (15 s max), LED `listening` while it does, posts the WAV to the relay's
  `POST /voice`. The relay transcribes (ElevenLabs), Claude works out what was meant and returns the line to say:
  remember / recall (Supabase `memories`), **remind** ("remind me in 5 days to…" → `reminders`; the relay says it
  when due, once you're at the desk), **agenda** ("what's on my calendar tomorrow?"), **focus** ("let's lock in" →
  the coach's timer; reply is `quiet` so the coach speaks instead), anything else gets a short Gen Z reply. Ignored while the duck is talking.
- **One turn at a time:** from the wake word until the reply has played, `Duck.say` holds other lines (coach, reminders; posture
  prompts are dropped, they repeat) and sign reading pauses. A reply with `listen: true` ("okay but when?") reopens the mic without the wake word.
- **Files:** `memory/wake.py` (Vosk), `memory/segment.py` (when to stop recording), `memory/talk.py` (glue),
  `memory/run.py` (try it alone, or `--text` without a mic). Off with `--no-talk`.

### 🦆 Press to quack
- **Needs:** press / release edges. **Gets it from:** pressure module digital out on `PRESS_PIN` (gpiozero `Button`, callback thread).
- **Emits:** quack immediately on press (if `quack_enabled`), `pat {touch_ms}` on release.
- **Files:** inline in `duck.py` (`on_press` / `on_release`).

### 🏃 Motion — "are they still moving?"
- **Needs:** camera frames while someone is at the desk.
- **Looks for:** changed pixels ≥ `motion_pixels` (1500) = movement; `still_for(now)` = seconds since the last one.
- **Feeds:** the coach's "zoned out?" nudge after 5 min still, then `IDLE_AWAY_AFTER_S` (5 more min) → marked away until the camera sees motion again.
- **Files:** `motion/detect.py` (brain), `motion/run.py` (tool).
- **Overlap:** `sentry/vision.py` also does camera motion (MOG2, for sentry wake-up). A reorg should merge them into one `perception/motion.py`.

### 🎯 Lock-in coach — "when should the duck nudge you?"
- **Needs:** presence, stillness (motion), slouch count, the agenda (calendar items pushed by the relay; links never reach the Pi), focus commands (START/FOCUS signs or dashboard).
- **Looks for:** arrival brief, deadlines crossing 3 h / 1 h / 15 min (one line for all items crossing at once), periodic check-ins (`coach_interval_min`, but at most every 45 min), idle 5 min. Stays quiet while the duck talks, during calibration, < 15 min after its last line (deadlines: 5 min), and (except deadlines) during focus.
- **Emits:** `("coach", kind, facts)` → `coach/lines.py` writes the line (relay `/nudge` = Claude, templates offline) → spoken + `coach` event.
- **Files:** `coach/coach.py` (brain), `coach/lines.py` (line writer). Thread-shared: guarded by `Duck.coach_lock`.

### 🗣️ Voice (output)
- `say(text)` queues; never blocks. Fetches PCM from the relay's `POST /tts` (ElevenLabs),
  caches in `pi/.cache/tts/`, falls back to espeak. `quack()` plays `assets/quack.wav`.
  Volume = `settings.volume`, live. Prefetches the three messages whenever settings arrive.
- **File:** `shared/voice.py`. (Standalone tools use the simpler `shared/out.py` instead.)

### 📡 Uplink (input *and* output)
- WebSocket to `RELAY_URL`, auth with `DUCK_TOKEN`, background thread, reconnects with backoff,
  queues up to 1000 events while offline. **The duck keeps working with no relay.**
- In: `settings` → `Duck.on_settings`, `command {say|quack}` → `Duck.on_command`.
- Out: `{type:"event", event:{type, value, ts}}`. Wire protocol owner: `backend/CLAUDE.md`.
- **File:** `shared/uplink.py`.

---

## 3. The contracts (don't break these)

**Action tuples** — the *only* thing a brain returns:

| Action | Meaning | Routed by `Duck.act()` to |
|---|---|---|
| `("event", type, value)` | something happened | stdout + `uplink.send_event` |
| `("speak", text)` | say this | `voice.say` |
| `("led", kind)` | blink pattern `kind` | `AlertLED.show` |
| `("command", name)` | duck command from a sign phrase | `on_sign_command` → coach (focus timer) |
| `("coach", kind, facts)` | coach wants to say something | `LineWriter` → voice + `coach` event |
| `("camera", "on"/"off")` | sentry's wish | **ignored** — the main loop owns the camera |

**Events** (value shapes must match `backend/sim/fake-duck.js` + the dashboard):
`presence {present, distance_cm}` · `posture {state, neck_angle_deg, slouch_duration_s}` ·
`sentry {distance_cm, person_confirmed, confidence, night, trigger}` · `sign {text, signs, commands}` ·
`sound {kind, label, score}` · `pat {touch_ms}` · `coach {kind, text, source, item, …}`. Never put `user_id` in an event — the relay adds it.

**Settings** (pushed by the relay, defaults in `duck.py DEFAULT_SETTINGS`, read **live** — brains
keep a reference to the dict, never copy it): `volume`, `posture_message`, `sentry_message`,
`presence_message`, `posture_severity`, `posture_delay_s`, `sentry_enabled`, `quack_enabled`,
`sign_enabled`, `sound_alerts_enabled`, `coach_enabled`, `coach_interval_min`, `coach_tone`.

**Frames:** every camera source has `start() / stop() / read() -> RGB ndarray | None / close()`,
plus `.night` and `.lux`. `read()` may return `None`; callers must skip that frame.

---

## 4. The main loop (`duck.py Duck.run`) — who runs when

```
threads:  uplink (WS)   ·   mic listener (YAMNet + hey duck)   ·   gpiozero button callbacks   ·   voice worker
main loop, every tick:
  1. ultrasonic distance → Presence → arrive/leave
  2. sentry stage 1 (if away + sentry_enabled + ultrasonic wake)
  3. need_cam = present OR sentry looking OR no ultrasonic OR camera-wake sentry
  4. frame → Holistic → points (body) + body (75,3)
       present      → PostureJudge.update(points) + WordSignReader.update(body)
       sentry look  → SentryWatch.frame(person_confidence)
       away+sentry  → camera motion → SentryWatch.trigger
  5. SentryWatch.tick, status line every 5 s
  6. sleep:  10 fps at desk  ·  3 fps camera-only idle  ·  10 Hz ultrasonic-only
```

**Only one process can own the camera.** `posture/run.py`, `sentry/run.py`, `asl/run.py` are
tuning tools: stop `duck.py` before using them.

---

## 5. Where things live today (and what's awkward)

```
pi/
├── duck.py              runtime: wires everything, owns the loop          [dispatch]
├── shared/              grab bag ─ config, uplink, voice, out, presence,
│                        sources (camera), ultrasonic, preview             [mixed layers]
├── posture/             judge (brain) + pose (perception) + run (tool)
│   └── pose_landmarker_lite.task  ← model lives here, not in models/
├── sentry/              watch (brain) + vision (perception) + run (tool)
├── sounds/              alerts (brain) + listener (perception) + led (output)
├── asl/                 engine (brain) + holistic/landmarks/features/classifier
│                        (perception) + run (tool) + train/importers (offline)
│   └── models/, data/   trained templates + samples (licensed, local only)
├── camera/              stream.sh / view.sh — dev video preview, not product
├── models/              holistic_landmarker.task, yamnet.tflite
├── doctor.sh, get_models.sh, .env(.example)
```

Pain points a reorg should fix:
1. **`asl/holistic.py` is the duck's main eyes** (posture + sentry + signs all use it) but lives in `asl/`.
2. **`shared/` mixes layers**: hardware drivers, network, logic and dev tools side by side.
3. **Models in two places** (`posture/*.task` vs `models/`).
4. **`sys.path` hacks**: `posture/` and `asl/` import by bare name, so `duck.py` patches `sys.path`.
5. **Two speech paths**: `shared/voice.py` (product) and `shared/out.py` (tools).
6. **Runtime and offline training mixed** in `asl/` (train.py, dataset importers next to the engine).

---

## 6. Proposed layout (reorganise towards this)

Folders = layers; one folder per feature brain. A move should be a `git mv` + import fix,
no logic changes, one PR per step, tests green after each.

```
pi/
├── duck.py                     the runtime (unchanged role)
├── core/                       config.py · uplink.py · actions.py (the tuple contract, §3)
├── hardware/                   ← talks to physical things only
│   ├── camera.py               (shared/sources.py)
│   ├── ultrasonic.py · button.py (from duck.py) · led.py (sounds/led.py)
│   ├── mic.py                  (arecord part of sounds/listener.py)
│   └── speaker.py              (shared/voice.py)
├── perception/                 ← models: raw signal → facts
│   ├── holistic.py             (asl/holistic.py)  ← the shared eyes
│   ├── pose.py                 (posture/pose.py, fallback)
│   ├── landmarks.py            (asl/landmarks.py)
│   ├── motion.py               (sentry/vision.py)
│   └── yamnet.py               (classifier part of sounds/listener.py)
├── brains/                     ← pure logic, no I/O, each with its test
│   ├── presence.py · posture.py (judge) · sentry.py (watch) · sounds.py (alerts)
│   └── asl/                    engine.py · features.py · classifier.py · phrases.json
├── training/asl/               train.py · run.py --record · importers · data/ · (gitignored)
├── tools/                      posture_run.py · sentry_run.py · asl_run.py · camera/ · doctor.sh · preview.py
├── models/                     every downloaded / trained model (gitignored)
└── tests/                      or keep test_*.py beside each brain
```

Make `pi/` a package (`python3 -m duck` or `pi/__init__.py` + relative imports) so the
`sys.path` lines in `duck.py` and the tools can go. Fold `shared/out.py` into `hardware/speaker.py`.
Make sure `.gitignore` covers `asl/models/`, `models/`, `training/**/data/`.

---

## 7. Adding a feature (checklist)

1. Which sensor? Is there already a perception module for it (usually **Holistic** — reuse it, don't add a second camera model)?
2. Write the brain as a class with `update(now, facts) -> list[action]`, reading `settings` live. No imports of cv2/gpiozero/mediapipe in it.
3. Unit-test it with fake facts (see `posture/test_judge.py`, `sentry/test_watch.py`).
4. Wire it into `Duck.run()` behind the right gate (present / away / always) and a settings toggle.
5. New event type or value shape → update `backend/sim/fake-duck.js`, `backend/CLAUDE.md` and the dashboard **in the same PR** (API contract: get it reviewed).
6. New dependency → ask first (Pi installs are slow and can break the camera stack).

## Commands
- **On the duck:** `./install-service.sh` once → `duck.py` starts at boot and restarts on crash (systemd user service). Then: `systemctl --user restart duck` (after `git pull`), `systemctl --user stop duck`, logs `tail -f ~/duck.log`. Don't also start it by hand (two can't share the camera).
- Run: `python3 duck.py` · `--no-mic` · `--no-sign` · `--source 0` (laptop webcam) · `--preview` (http://<pi-ip>:8090)
- Camera won't start: `./doctor.sh`
- Models: `./get_models.sh`
- Tests: `python3 -m unittest` in `asl/`, `posture/`, `sentry/`, `sounds/`, `coach/`, `motion/`; `python3 -m unittest test_presence` in `shared/`
