"""Offline "hey duck" detector: Vosk with a tiny grammar, so it only ever chooses between the
wake phrases and "[unk]" (anything else). Nothing leaves the Pi until the wake word is heard.

Model: pi/models/vosk-small-en (see pi/get_models.sh). pip install vosk.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

DEFAULT_MODEL = Path(__file__).resolve().parent.parent / "models" / "vosk-small-en"
WAKE_PHRASES = ("hey duck", "okay duck", "hi duck")


def log(msg: str):
    print(f"# wake: {msg}", file=sys.stderr, flush=True)


def heard_wake(text: str, phrases=WAKE_PHRASES) -> bool:
    text = " ".join(text.lower().split())
    return any(p in text for p in phrases)


class WakeWord:
    def __init__(self, model_dir: Path = DEFAULT_MODEL, phrases=WAKE_PHRASES, rate: int = 16000):
        from vosk import KaldiRecognizer, Model, SetLogLevel
        SetLogLevel(-1)
        self.phrases = phrases
        self.rec = KaldiRecognizer(Model(str(model_dir)), rate, json.dumps([*phrases, "[unk]"]))

    @staticmethod
    def available(model_dir: Path = DEFAULT_MODEL) -> bool:
        try:
            import vosk  # noqa: F401
        except ImportError:
            log("vosk not installed (pip install vosk): talk to duck off")
            return False
        if not Path(model_dir).exists():
            log(f"{model_dir} missing (run pi/get_models.sh): talk to duck off")
            return False
        return True

    def feed(self, pcm: bytes) -> bool:
        if self.rec.AcceptWaveform(pcm):
            text = json.loads(self.rec.Result()).get("text", "")
        else:
            text = json.loads(self.rec.PartialResult()).get("partial", "")
        return heard_wake(text, self.phrases)

    def reset(self):
        self.rec.Reset()
