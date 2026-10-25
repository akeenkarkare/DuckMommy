"""The duck's voice: ElevenLabs (via the relay's /tts proxy), cached on disk, espeak fallback.

  voice.say("Sit up straight!")   queued, never blocks the caller
  voice.quack()                   plays assets/quack.wav right away (or says "Quack!")
  voice.busy()                    True while sound is coming out (the mic ignores itself)

Audio is 16-bit mono PCM. Volume comes from settings["volume"] (0-100), read live.
Playback: `aplay` on the Pi (alsa-utils, preinstalled), `afplay` on a Mac for dev.
"""

from __future__ import annotations

import array
import hashlib
import json
import queue
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
import wave
from pathlib import Path

from .config import PI_DIR, REPO_DIR

CACHE_DIR = PI_DIR / ".cache" / "tts"
QUACK_WAV = REPO_DIR / "assets" / "quack.wav"
TTS_RATE = 22050
STREAM_CHUNK = 4096   # ~0.1 s of audio
ESPEAK = next((c for c in ("espeak-ng", "espeak") if shutil.which(c)), None)
APLAY = shutil.which("aplay")
AFPLAY = shutil.which("afplay")


def log(msg: str):
    print(f"# voice: {msg}", file=sys.stderr, flush=True)


def _scale(pcm: bytes, volume: int) -> bytes:
    samples = array.array("h")
    samples.frombytes(pcm[: len(pcm) // 2 * 2])
    if sys.byteorder == "big":
        samples.byteswap()
    gain = max(0, min(100, volume)) / 100
    if gain < 1:
        samples = array.array("h", (int(s * gain) for s in samples))
    if sys.byteorder == "big":
        samples.byteswap()
    return samples.tobytes()


def _play_pcm(pcm: bytes, rate: int):
    if APLAY:
        subprocess.run([APLAY, "-q", "-f", "S16_LE", "-r", str(rate), "-c", "1", "-t", "raw", "-"],
                       input=pcm, check=False)
    elif AFPLAY:   # Mac, for dev
        with tempfile.NamedTemporaryFile(suffix=".wav") as f:
            with wave.open(f.name, "wb") as w:
                w.setnchannels(1), w.setsampwidth(2), w.setframerate(rate), w.writeframes(pcm)
            subprocess.run([AFPLAY, f.name], check=False)
    else:
        log("no audio player (aplay/afplay); not playing")


class _Stream:
    """aplay fed chunk by chunk; started on the first chunk, so a failed fetch plays nothing."""

    def __init__(self, voice: "Voice", rate: int):
        self.voice, self.rate, self.proc, self.samples, self.t0 = voice, rate, None, 0, 0.0

    def write(self, pcm: bytes):
        if not pcm:
            return
        if self.proc is None:
            self.proc = subprocess.Popen([APLAY, "-q", "-f", "S16_LE", "-r", str(self.rate), "-c", "1", "-t", "raw", "-"],
                                         stdin=subprocess.PIPE)
            self.t0 = time.monotonic()
        self.samples += len(pcm) // 2
        with self.voice._lock:   # busy until this audio has played out (the mic ignores the duck)
            self.voice._busy_until = max(self.voice._busy_until, self.t0 + self.samples / self.rate + 0.5)
        try:
            self.proc.stdin.write(_scale(pcm, self.voice._volume()))
        except BrokenPipeError:
            pass

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        if self.proc:
            try:
                self.proc.stdin.close()
            except BrokenPipeError:
                pass
            self.proc.wait()


class Voice:
    def __init__(self, settings: dict, tts_url: str | None, token: str | None):
        self.settings = settings
        self.tts_url, self.token = tts_url, token
        self._queue: queue.Queue[str] = queue.Queue(maxsize=5)
        self._busy_until = 0.0
        self._lock = threading.Lock()
        self._tts_down = False   # log the outage once, not on every line
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        threading.Thread(target=self._worker, daemon=True, name="voice").start()

    # ── public ──────────────────────────────────────────────────────────────
    def say(self, text: str):
        text = (text or "").strip()
        if not text:
            return
        log(f'say "{text}"')
        try:
            self._queue.put_nowait(text)
        except queue.Full:
            log("busy, dropped")

    def quack(self):
        threading.Thread(target=self._quack, daemon=True).start()

    def busy(self) -> bool:
        return time.monotonic() < self._busy_until

    def prefetch(self, texts):
        """Fetch clips ahead of time so the first prompt is instant and works offline."""
        def run():
            for t in texts:
                if t and not self._cache_path(t).exists():
                    self._fetch(t)
        threading.Thread(target=run, daemon=True).start()

    # ── internals ───────────────────────────────────────────────────────────
    def _volume(self) -> int:
        return int(self.settings.get("volume", 70))

    def _mark_busy(self, seconds: float):
        with self._lock:
            self._busy_until = max(self._busy_until, time.monotonic() + seconds + 0.5)

    def _cache_path(self, text: str) -> Path:
        return CACHE_DIR / (hashlib.sha1(text.encode()).hexdigest() + ".pcm")

    def _fetch(self, text: str, on_chunk=None) -> bytes | None:
        """The clip for `text`: from the cache, else from the relay. `on_chunk(pcm)` gets the audio
        as it streams in (so playback starts on the first chunk); the cache only gets whole clips."""
        path = self._cache_path(text)
        if path.exists():
            pcm = path.read_bytes()
            if on_chunk:
                on_chunk(pcm)
            return pcm
        if not self.tts_url:
            return None
        req = urllib.request.Request(self.tts_url, data=json.dumps({"text": text}).encode(), method="POST",
                                     headers={"content-type": "application/json", "authorization": f"Bearer {self.token}"})
        parts, odd = [], b""
        try:
            with urllib.request.urlopen(req, timeout=10) as r:
                while chunk := r.read1(STREAM_CHUNK):   # whatever has arrived, up to ~0.1 s
                    parts.append(chunk)
                    if on_chunk:   # whole 16-bit samples only
                        chunk, odd = odd + chunk, b""
                        if len(chunk) % 2:
                            chunk, odd = chunk[:-1], chunk[-1:]
                        on_chunk(chunk)
            pcm = b"".join(parts)
        except Exception as e:   # offline, relay down, ElevenLabs not configured: fall back
            if parts:   # cut off mid-clip: what played, played; don't cache half a clip
                log(f"TTS stream cut off: {e}")
                return b"".join(parts)
            if not self._tts_down:
                self._tts_down = True
                hint = " (ElevenLabs keys not set in backend/.env?)" if "503" in str(e) else ""
                log(f"ElevenLabs unavailable: {e}{hint}. Using espeak until it's back")
            return None
        if self._tts_down:
            self._tts_down = False
            log("ElevenLabs is back")
        path.write_bytes(pcm)
        return pcm

    def _worker(self):
        while True:
            text = self._queue.get()
            if APLAY:   # play while it downloads
                with _Stream(self, TTS_RATE) as out:
                    pcm = self._fetch(text, out.write)
            else:
                pcm = self._fetch(text)
                if pcm:
                    self._mark_busy(len(pcm) / 2 / TTS_RATE)
                    _play_pcm(_scale(pcm, self._volume()), TTS_RATE)
            if not pcm and ESPEAK:
                self._mark_busy(len(text) * 0.08)
                subprocess.run([ESPEAK, "-a", str(int(self._volume() * 2)), text], check=False,
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            elif not pcm:
                log(f'(no TTS) "{text}"')

    def _quack(self):
        if not QUACK_WAV.exists():
            return self.say("Quack!")
        with wave.open(str(QUACK_WAV), "rb") as w:
            rate, frames = w.getframerate(), w.readframes(w.getnframes())
            if w.getsampwidth() != 2 or w.getnchannels() != 1:
                log("quack.wav must be 16-bit mono"); return
        self._mark_busy(len(frames) / 2 / rate)
        _play_pcm(_scale(frames, self._volume()), rate)
