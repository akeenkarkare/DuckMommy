"""Try the memory locker without running the whole duck.

  python3 run.py --text "remember my keys are in the blue drawer"    type instead of talking
  python3 run.py --text "what did I tell you to remember 5 days ago"
  python3 run.py                                                     mic: say "hey duck, ..."

Uses RELAY_URL + DUCK_TOKEN from pi/.env. The relay needs ANTHROPIC_API_KEY (and
ELEVENLABS_API_KEY for the mic mode), and a dashboard must be open so it knows whose memories.
On a laptop, the mic mode needs `arecord` (Linux); on a Mac use --text.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.request
from pathlib import Path

PI = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PI))

from shared.config import load_env  # noqa: E402


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--text", help="send this text instead of listening")
    args = ap.parse_args()

    env = load_env()
    relay, token = env.get("RELAY_URL"), env.get("DUCK_TOKEN")
    if not relay or not token:
        sys.exit("set RELAY_URL and DUCK_TOKEN in pi/.env")
    http = relay.replace("wss://", "https://").replace("ws://", "http://").rstrip("/")

    if args.text:
        req = urllib.request.Request(http + "/voice", data=json.dumps({"text": args.text}).encode(), method="POST",
                                     headers={"content-type": "application/json", "authorization": f"Bearer {token}"})
        with urllib.request.urlopen(req, timeout=30) as r:
            print(json.dumps(json.loads(r.read()), indent=2))
        return

    from memory.talk import TalkToDuck
    from memory.wake import WakeWord
    from shared.voice import Voice
    from sounds.listener import SoundListener

    if not WakeWord.available():
        sys.exit(1)
    voice = Voice({"volume": 70}, http + "/tts", token)
    talk = TalkToDuck(WakeWord(), voice, http + "/voice", token,
                      on_listening=lambda on: print("listening..." if on else "sending...", flush=True))
    if not SoundListener(lambda t, c: None, env.get("MIC_DEVICE") or "default", on_audio=talk.threaded()).start():
        sys.exit(1)
    print('say "hey duck, remember ..." or "hey duck, what did I tell you ...?"  (Ctrl+C to stop)')
    while True:
        time.sleep(1)


if __name__ == "__main__":
    main()
