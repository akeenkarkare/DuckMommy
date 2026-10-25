"""Talk to the duck: "hey duck, remember ..." / "what did I tell you ...?" / "remind me in 5 days to ..." /
"what's on my calendar tomorrow?" / "let's lock in" (the relay works out which; see backend/src/memory.js)

Runs on the mic thread. Every audio chunk from sounds/listener.py comes through feed():

  idle       the wake listener (wake.py, offline Vosk) waits for "hey duck"; the last
             PREROLL_S of audio is kept so words said in the same breath aren't lost
  recording  after the wake word, collect audio until the person stops talking (segment.py)
  sending    a background thread posts the WAV to the relay's /voice, which transcribes it,
             lets Claude work out what was meant, saves or looks up the memory, and returns
             the line the duck says

Audio is ignored while the duck itself is talking, so it can't wake itself up, and the wake
word only counts while the duck sees someone at the desk (present()), so a passer-by can't
ask it to read your notes out while you're away.
"""

from __future__ import annotations

import collections
import io
import json
import queue
import sys
import threading
import time
import urllib.request
import wave

try:
    from .segment import RATE, UtteranceRecorder
except ImportError:   # run from pi/memory (tests, run.py)
    from segment import RATE, UtteranceRecorder

PREROLL_S = 1.5   # audio kept from before the wake word fired ("hey duck remember...")
POST_TIMEOUT_S = 40   # relay makes up to 3 API calls of <= 10 s each
SAY_WAIT_S = 5       # how long to wait for the reply to start playing before listening again


def log(msg: str):
    print(f"# talk: {msg}", file=sys.stderr, flush=True)


def to_wav(pcm: bytes, rate: int = RATE) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1), w.setsampwidth(2), w.setframerate(rate), w.writeframes(pcm)
    return buf.getvalue()


def post_voice(url: str, token: str, wav: bytes) -> dict:
    req = urllib.request.Request(url, data=wav, method="POST",
                                 headers={"content-type": "audio/wav", "authorization": f"Bearer {token}"})
    with urllib.request.urlopen(req, timeout=POST_TIMEOUT_S) as r:
        return json.loads(r.read())


class TalkToDuck:
    def __init__(self, wake, voice, voice_url: str | None, token: str | None,
                 on_listening=None, post=post_voice, clock=time.monotonic, present=lambda: True):
        """wake: object with feed(pcm) -> bool and reset() (wake.WakeWord).
        voice: shared.voice.Voice (say/busy). on_listening(bool): e.g. LED on/off."""
        self.wake, self.voice = wake, voice
        self.voice_url, self.token = voice_url, token
        self.on_listening = on_listening or (lambda on: None)
        self.post, self.clock, self.present = post, clock, present
        self.preroll: collections.deque[bytes] = collections.deque()
        self.preroll_bytes = 0
        self.recorder: UtteranceRecorder | None = None
        self.sending = False
        self.say_wait_s = SAY_WAIT_S

    def threaded(self):
        """A non-blocking feed for the mic thread: chunks go through a small queue to our own
        thread, so a slow Vosk pass can never delay the sound alerts. Drops audio if it falls behind."""
        q: queue.Queue[bytes] = queue.Queue(maxsize=8)   # ~4 s of audio

        def worker():
            while True:
                self.feed(q.get())

        threading.Thread(target=worker, daemon=True, name="talk-in").start()

        def put(pcm: bytes):
            try:
                q.put_nowait(pcm)
            except queue.Full:
                log("falling behind, dropped 0.5 s of audio")
        return put

    def feed(self, pcm: bytes):
        """One chunk of 16 kHz mono S16_LE audio."""
        if self.voice.busy() or self.sending:
            if self.recorder is None:
                self._remember(pcm)
            return
        if self.recorder is not None:
            done = self.recorder.feed(pcm)
            if done is not None:
                self.recorder = None
                self.on_listening(False)
                self._send(done)
            return
        self._remember(pcm)
        if not self.present():
            return
        if self.wake.feed(pcm):
            log("wake word heard, listening")
            self.wake.reset()
            self.recorder = UtteranceRecorder(b"".join(self.preroll), clock=self.clock)
            self.preroll.clear()
            self.preroll_bytes = 0
            self.on_listening(True)

    def _remember(self, pcm: bytes):
        self.preroll.append(pcm)
        self.preroll_bytes += len(pcm)
        while self.preroll and self.preroll_bytes - len(self.preroll[0]) >= PREROLL_S * RATE * 2:
            self.preroll_bytes -= len(self.preroll.popleft())

    def _send(self, pcm: bytes):
        if not self.voice_url or not self.token:
            log("RELAY_URL/DUCK_TOKEN missing: can't reach the memory locker")
            self.voice.say("Not gonna lie, I can't reach my notes right now.")
            return
        self.sending = True
        threading.Thread(target=self._send_worker, args=(pcm,), daemon=True, name="talk").start()

    def _send_worker(self, pcm: bytes):
        try:
            reply = self.post(self.voice_url, self.token, to_wav(pcm))
            log(f'heard "{reply.get("heard", "")}" -> {reply.get("intent")}')
            if not reply.get("quiet"):   # quiet: the duck answers another way (e.g. the focus coach speaks)
                self.voice.say(reply.get("say") or "Sorry, I didn't catch that.")
        except Exception as e:   # relay down, offline, timeout
            log(f"voice request failed: {e}")
            self.voice.say("My brain is buffering. Try again in a sec.")
        finally:
            self._wait_until_quiet()
            self.sending = False

    def _wait_until_quiet(self):
        """Stay deaf until the reply has played, so the duck can't hear itself."""
        end = time.monotonic() + self.say_wait_s
        while not self.voice.busy() and time.monotonic() < end:
            time.sleep(0.05)
        while self.voice.busy():
            time.sleep(0.05)
        time.sleep(min(0.3, self.say_wait_s))
