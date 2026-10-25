"""Microphone -> YAMNet (MediaPipe Audio Classifier), in a background thread.

Audio comes from `arecord` (alsa-utils, preinstalled on Raspberry Pi OS), 16 kHz mono.
Every HOP_S we classify the last WINDOW_S and hand (label, score) pairs to a callback.
The raw chunks can also go to on_audio (memory/talk.py: "hey duck"), so the mic is opened once.
Model: pi/models/yamnet.tflite (see pi/get_models.sh).

Find your USB mic with `arecord -l`, then set MIC_DEVICE in pi/.env, e.g. plughw:CARD=Device,DEV=0.
Run alone to see what it hears:  python3 listener.py [device]
"""

from __future__ import annotations

import shutil
import subprocess
import sys
import threading
import time
from pathlib import Path

RATE = 16000
WINDOW_S = 0.975          # YAMNet's native window
HOP_S = 0.5
DEFAULT_MODEL = Path(__file__).resolve().parent.parent / "models" / "yamnet.tflite"


def log(msg: str):
    print(f"# mic: {msg}", file=sys.stderr, flush=True)


class SoundListener:
    def __init__(self, on_categories, device: str = "default", model_path: Path = DEFAULT_MODEL, on_audio=None):
        self.on_categories, self.device, self.model_path = on_categories, device, model_path
        self.on_audio = on_audio   # raw 16 kHz mono S16_LE chunks (HOP_S each), on the mic thread
        self.classify = True

    def start(self) -> bool:
        if not shutil.which("arecord"):
            log("arecord not found (Pi only); sound alerts off")
            return False
        if not Path(self.model_path).exists():
            log(f"{self.model_path} missing (run pi/get_models.sh); sound alerts off")
            if self.on_audio is None:
                return False
            self.classify = False
        threading.Thread(target=self._run, daemon=True, name="mic").start()
        return True

    def _run(self):
        import numpy as np

        classifier = None
        if self.classify:
            from mediapipe.tasks.python import BaseOptions, audio
            from mediapipe.tasks.python.components import containers
            classifier = audio.AudioClassifier.create_from_options(audio.AudioClassifierOptions(
                base_options=BaseOptions(model_asset_path=str(self.model_path)), max_results=5, score_threshold=0.15))
        window, hop = int(RATE * WINDOW_S), int(RATE * HOP_S)
        while True:
            proc = subprocess.Popen(["arecord", "-q", "-D", self.device, "-f", "S16_LE", "-r", str(RATE),
                                     "-c", "1", "-t", "raw"], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            log(f"listening on {self.device}")
            buf = np.zeros(0, dtype=np.float32)
            try:
                while True:
                    chunk = proc.stdout.read(hop * 2)
                    if not chunk:
                        break
                    if self.on_audio is not None:
                        try:
                            self.on_audio(chunk)
                        except Exception as e:   # never let talk-to-duck kill the sound alerts
                            log(f"on_audio failed: {e}")
                    if classifier is None:
                        continue
                    buf = np.concatenate([buf, np.frombuffer(chunk, dtype="<i2").astype(np.float32) / 32768.0])[-window:]
                    if len(buf) < window:
                        continue
                    results = classifier.classify(containers.AudioData.create_from_array(buf, RATE))
                    cats = [(c.category_name, c.score) for c in results[0].classifications[0].categories] if results else []
                    self.on_categories(time.monotonic(), cats)
            finally:
                proc.kill()
            log(f"arecord stopped ({proc.stderr.read().decode(errors='ignore').strip()[:120]}); retrying in 3 s")
            time.sleep(3)


if __name__ == "__main__":
    dev = sys.argv[1] if len(sys.argv) > 1 else "default"
    if SoundListener(lambda t, cats: cats and print(", ".join(f"{l} {s:.2f}" for l, s in cats)), dev).start():
        while True:
            time.sleep(1)
