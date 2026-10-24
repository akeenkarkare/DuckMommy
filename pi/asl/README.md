# Sign to Duck: ASL word signs

Reads **ASL word signs with movement** (START, FOCUS, HELP, THANK-YOU, ... 54 in
`phrases.json`) and turns short sequences into sentences and duck commands:
START + FOCUS → "Let's start a focus session." + `start_focus`. Runs entirely
on the Pi; no video leaves it.

```
camera → MediaPipe Holistic (body + both hands, one pass)
   ├─ body points → posture judge, presence, sentry person check (as before)
   └─ (75, 3) frame → segmenter (hand above the rest line = signing)
                    → DTW classifier (once per sign) → phrase builder (1.6 s pause)
                    → LED double blink per sign, `sign` event + spoken sentence
```

**Status:** segmentation, features, both classifiers, phrases and the duck.py
adapter are unit-tested with a synthetic signer, and `duck.py` was
smoke-tested end to end with a fake camera. Nobody has run Holistic on the Pi 5
yet, so the frame rate there is unknown: check the `# N fps analysed` line.

## Setup (once, on top of `../README.md`)
```bash
cd pi && ./get_models.sh      # now also fetches models/holistic_landmarker.task
```
No new packages: numpy comes with mediapipe. scikit-learn is only for the
optional `train.py --kind mlp`.

## Get sign data
Nothing is recognised until `models/asl_templates.npz` exists. No ready-made
model covers these signs on a Pi, so the templates are built from public
datasets, then topped up with your own recordings. Run the imports on the
laptop (they need `pip install pandas pyarrow`), then copy `data/` to the Pi.

**1. Google's Kaggle ASL landmarks** (`asl-signs`, about 40 GB zipped, needs a
Kaggle account; CC BY 4.0 according to projects that use it, so check the
competition rules). Already MediaPipe Holistic landmarks, so it converts
straight in. It's a children's vocabulary, so it has roughly half our signs
(HELLO, THANK-YOU, YES, NO, WATER, TIME, PLEASE, ...) but not HELP, STOP,
START or FOCUS.
```bash
kaggle competitions download -c asl-signs && unzip asl-signs.zip -d ~/asl-signs
python3 kaggle_to_samples.py ~/asl-signs --list   # which of our signs it has
python3 kaggle_to_samples.py ~/asl-signs          # 15 clips per sign, one signer at a time
```

**2. ASL Citizen** (Microsoft, 2,731 signs by 52 Deaf signers, .mp4 videos)
for the signs Kaggle lacks: https://www.microsoft.com/en-us/download/details.aspx?id=105253.
Its licence is **non-commercial research only and forbids sharing the data or
anything made from it**, so `citizen*` samples are gitignored: keep them on
your own machines. Its CSV layout isn't documented, so the script finds the
gloss/video/participant columns by name; check the first run's output.
```bash
python3 videos_to_samples.py --citizen ~/ASL_Citizen   # only fills signs with < 15 samples
```

**3. Your own** recordings through the duck's camera. Datasets are filmed
close up on phones and webcams, so a few samples from the real wide-angle duck
camera matter more than more dataset clips. Stop `duck.py` first.
```bash
python3 run.py --preview <laptop-ip>:5000          # check the rest line (laptop: ../camera/view.sh)
python3 run.py --record HELLO --n 5 --who sara     # sign once, hands down, repeat
python3 run.py --record _other --n 20 --who sara   # NOT signs: scratch, drink, type (no dataset has these)
```

Then `python3 train.py`: it reports accuracy by sample and **by signer**
(train on everyone else, test on one person); the by-signer number is the
honest one. Notes:
- Hands resting on the desk must be **below** the orange rest line. Move it
  with `--rest-line 1.2` (higher) or `1.6` (lower), in shoulder widths.
- Every sample is compared at each sign, so keep it to about 15 per sign:
  54 signs x 15 (x2 with left-handed copies) takes roughly 0.1-0.3 s per sign.
- Bad sample: delete it from `data/<GLOSS>/`. Your own phone clips:
  `python3 videos_to_samples.py clips/ --who maya` (`clips/HELLO/*.mp4`, ...).
- Kaggle's videos have an unknown width/height ratio; `--aspect` sets it
  (default 1.0). If dataset samples score badly against your recordings, try
  `--aspect 0.5625` (portrait phone) and compare `train.py` results.

## Run on the duck
```bash
cd pi && python3 duck.py
```
Holistic replaces both the pose and hand models, so posture, presence and
sentry keep working from the same pass. Without a trained model nothing is
recognised (the log says so); everything else runs normally. The dashboard's
`sign_enabled` toggle switches it off live.

## What comes out
The `sign` event, now with the commands, so the dashboard's Sign to
Duck card works unchanged:
```json
{"type": "sign", "value": {"text": "Let's start a focus session.", "signs": ["START", "FOCUS"], "commands": ["start_focus"]}}
```
Commands (`start_focus`, `break`, `help`, `time_left`, `more_time`, `repeat`,
`pause`, `music`, `mute`, ...) are logged by `Duck.on_sign_command` in
`duck.py` until the duck has a focus timer for them to drive.

## Files
- `asl_engine.py`: segmenter, phrase builder, `AslEngine`, and `WordSignReader`
  (the duck.py adapter). No I/O.
- `holistic.py`: MediaPipe Holistic → posture Points + (75, 3) frame.
- `landmarks.py`, `features.py`, `classifier.py`: landmarks → features → sign
  (DTW templates by default, small MLP optional).
- `asl_model.py`: loads `phrases.json` and the trained model; saves samples.
- `phrases.json`: vocabulary, sentences, commands. Edit this, not code.
- `run.py`: tuning view + recording. `train.py`: training.
- `kaggle_to_samples.py`, `videos_to_samples.py` (`--citizen`), `datasets.py`: dataset imports.
- Tests: `python3 -m unittest -v` (numpy only)
