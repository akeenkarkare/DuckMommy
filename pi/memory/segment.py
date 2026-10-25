"""Cut one spoken request out of the mic stream: start after the wake word, stop when the
person goes quiet. Pure Python + numpy, so it's easy to test without a mic.

  rec = UtteranceRecorder(preroll_pcm)
  for chunk in mic:
      pcm = rec.feed(chunk)     # None while still listening, bytes when done
"""

from __future__ import annotations

import time

import numpy as np

RATE = 16000
END_SILENCE_S = 1.2     # this much quiet after speech = they're done
NO_SPEECH_S = 5.0       # nothing said at all after the wake word: give up and send what we have
MAX_S = 15.0            # hard cap on one request
MIN_RMS = 400           # absolute floor for "someone is talking" (16-bit samples)
NOISE_FACTOR = 2.5      # ...and at least this much louder than the room
MAX_NOISE = 1200        # cap on the room-noise estimate


def rms(pcm: bytes) -> float:
    samples = np.frombuffer(pcm, dtype="<i2").astype(np.float32)
    return float(np.sqrt(np.mean(samples * samples))) if samples.size else 0.0


class UtteranceRecorder:
    def __init__(self, preroll: bytes = b"", clock=time.monotonic):
        self.clock = clock
        self.start = clock()
        self.chunks = [preroll] if preroll else []
        # Room noise from the pre-roll's quietest 0.1 s (the wake word itself is loud). Too little
        # pre-roll to find a quiet bit = assume a quiet room. Capped so a noisy hall can't mute us.
        levels = [rms(preroll[i:i + 3200]) for i in range(0, len(preroll), 3200)]
        self.noise = min(min(levels), MAX_NOISE) if len(preroll) >= RATE * 2 else 0.0
        self.spoke = False
        self.quiet_since: float | None = None

    @property
    def threshold(self) -> float:
        return max(MIN_RMS, self.noise * NOISE_FACTOR)

    def feed(self, pcm: bytes) -> bytes | None:
        now = self.clock()
        self.chunks.append(pcm)
        if rms(pcm) >= self.threshold:
            self.spoke, self.quiet_since = True, None
        elif self.quiet_since is None:
            self.quiet_since = now
        elapsed = now - self.start
        done = (elapsed >= MAX_S
                or (self.spoke and self.quiet_since is not None and now - self.quiet_since >= END_SILENCE_S)
                or (not self.spoke and elapsed >= NO_SPEECH_S))
        return b"".join(self.chunks) if done else None
