"""What the Pi programs do to the outside world: speak and emit events."""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
import time

TTS = next((c for c in ("espeak-ng", "espeak", "say") if shutil.which(c)), None)
_speaking = None


def speak(text: str):
    """Non-blocking TTS with whatever's installed; never stalls the camera loop."""
    global _speaking
    print(f"# speak: {text}", file=sys.stderr)
    if not TTS or (_speaking and _speaking.poll() is None):
        return
    _speaking = subprocess.Popen([TTS, text], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def emit(etype: str, value: dict):
    """One JSON line on stdout in the relay's wire format, ready for the uplink client."""
    msg = {"type": "event", "event": {"type": etype, "value": value, "ts": int(time.time() * 1000)}}
    print(json.dumps(msg), flush=True)
