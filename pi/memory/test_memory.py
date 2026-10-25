"""Run: cd pi/memory && python3 -m unittest -v   (numpy only; no mic, Vosk or relay needed)"""

import io
import math
import time
import unittest
import wave

import numpy as np

from segment import END_SILENCE_S, MAX_S, NO_SPEECH_S, RATE, UtteranceRecorder
from talk import PREROLL_S, TalkToDuck, to_wav
from wake import heard_wake

CHUNK_S = 0.5


def tone(seconds=CHUNK_S, level=3000):
    n = int(RATE * seconds)
    return (np.sin(np.arange(n) * 2 * np.pi * 220 / RATE) * level).astype("<i2").tobytes()


def hush(seconds=CHUNK_S, level=60):
    n = int(RATE * seconds)
    return (np.random.default_rng(0).normal(0, level, n)).astype("<i2").tobytes()


class Clock:
    def __init__(self):
        self.t = 0.0

    def __call__(self):
        return self.t

    def tick(self, s=CHUNK_S):
        self.t += s


def run(rec, clock, chunks):
    for c in chunks:
        clock.tick()
        out = rec.feed(c)
        if out is not None:
            return out
    return None


class TestSegment(unittest.TestCase):
    def test_stops_after_quiet_following_speech(self):
        clock = Clock()
        rec = UtteranceRecorder(hush(1.0), clock=clock)
        quiet_chunks = math.ceil(END_SILENCE_S / CHUNK_S) + 1
        out = run(rec, clock, [tone()] * 4 + [hush()] * quiet_chunks)
        self.assertIsNotNone(out)
        self.assertEqual(len(out), len(hush(1.0)) + len(tone()) * 4 + len(hush()) * quiet_chunks)

    def test_short_pause_does_not_cut_off(self):
        clock = Clock()
        rec = UtteranceRecorder(clock=clock)
        self.assertIsNone(run(rec, clock, [tone(), hush(), tone(), hush()]))

    def test_gives_up_when_nothing_is_said(self):
        clock = Clock()
        rec = UtteranceRecorder(clock=clock)
        self.assertIsNotNone(run(rec, clock, [hush()] * int(NO_SPEECH_S / CHUNK_S + 1)))

    def test_hard_cap(self):
        clock = Clock()
        rec = UtteranceRecorder(clock=clock)
        self.assertIsNotNone(run(rec, clock, [tone()] * int(MAX_S / CHUNK_S + 1)))

    def test_loud_room_raises_threshold(self):
        rec = UtteranceRecorder(hush(1.0, level=900))
        self.assertGreater(rec.threshold, 900)


class TestWakeText(unittest.TestCase):
    def test_phrases(self):
        self.assertTrue(heard_wake("hey duck"))
        self.assertTrue(heard_wake("[unk] okay   duck"))
        self.assertFalse(heard_wake("duck"))
        self.assertFalse(heard_wake("hey dude"))


class FakeVoice:
    def __init__(self):
        self.said, self.talking = [], False

    def say(self, text):
        self.said.append(text)

    def busy(self):
        return self.talking


class FakeWake:
    """Fires on the chunk after `fire_on` chunks."""
    def __init__(self, fire_on):
        self.n, self.fire_on, self.resets = 0, fire_on, 0

    def feed(self, pcm):
        self.n += 1
        return self.n == self.fire_on

    def reset(self):
        self.resets += 1


class TestTalkToDuck(unittest.TestCase):
    def make(self, fire_on=3, reply=None, fail=False):
        self.posted = []

        def post(url, token, wav):
            self.posted.append((url, token, wav))
            if fail:
                raise OSError("relay down")
            return reply or {"intent": "remember", "heard": "hey duck remember x", "say": "Got it, I'll remember that."}

        self.clock, self.voice, self.leds = Clock(), FakeVoice(), []
        self.wake = FakeWake(fire_on)
        talk = TalkToDuck(self.wake, self.voice, "http://relay/voice", "tok",
                          on_listening=self.leds.append, post=post, clock=self.clock)
        talk.say_wait_s = 0
        return talk

    def feed_all(self, talk, chunks):
        for c in chunks:
            self.clock.tick()
            talk.feed(c)
        for _ in range(100):          # let the sender thread finish
            if not talk.sending:
                break
            time.sleep(0.01)

    def test_wake_record_send_speak(self):
        talk = self.make(fire_on=3)
        quiet = [hush()] * (math.ceil(END_SILENCE_S / CHUNK_S) + 1)
        self.feed_all(talk, [hush(), tone(), tone()] + [tone()] * 3 + quiet)
        self.assertEqual(self.leds, [True, False])
        self.assertEqual(len(self.posted), 1)
        url, token, wav = self.posted[0]
        self.assertEqual((url, token), ("http://relay/voice", "tok"))
        with wave.open(io.BytesIO(wav)) as w:
            self.assertEqual((w.getframerate(), w.getnchannels(), w.getsampwidth()), (RATE, 1, 2))
            seconds = w.getnframes() / RATE
        # pre-roll (capped at PREROLL_S, includes the wake chunk) + what came after
        self.assertAlmostEqual(seconds, min(PREROLL_S, 3 * CHUNK_S) + 3 * CHUNK_S + len(quiet) * CHUNK_S, places=2)
        self.assertEqual(self.voice.said, ["Got it, I'll remember that."])
        self.assertEqual(self.wake.resets, 1)

    def test_ignores_itself_while_talking(self):
        talk = self.make(fire_on=1)
        self.voice.talking = True
        self.feed_all(talk, [tone()] * 3)
        self.assertEqual(self.wake.n, 0)
        self.assertEqual(self.posted, [])

    def test_nobody_at_desk_ignores_wake(self):
        talk = self.make(fire_on=1)
        talk.present = lambda: False
        self.feed_all(talk, [tone()] * 4 + [hush()] * 4)
        self.assertEqual((self.wake.n, self.posted, self.leds), (0, [], []))

    def test_quiet_reply_is_not_spoken(self):
        # "hey duck, let's lock in": the relay starts the coach's focus timer and the coach talks instead
        talk = self.make(fire_on=1, reply={"intent": "focus", "heard": "lets lock in", "say": "", "quiet": True})
        self.feed_all(talk, [tone()] + [tone()] * 2 + [hush()] * 4)
        self.assertEqual(len(self.posted), 1)
        self.assertEqual(self.voice.said, [])

    def test_relay_down_says_so(self):
        talk = self.make(fire_on=1, fail=True)
        self.feed_all(talk, [tone()] + [tone()] * 2 + [hush()] * 4)
        self.assertEqual(self.voice.said, ["My brain is offline right now, try again in a bit."])

    def test_preroll_is_capped(self):
        talk = self.make(fire_on=10_000)
        self.feed_all(talk, [hush()] * 20)
        self.assertLessEqual(talk.preroll_bytes, (PREROLL_S + CHUNK_S) * RATE * 2)

    def test_threaded_feed_reaches_wake(self):
        talk = self.make(fire_on=10_000)
        put = talk.threaded()
        for _ in range(3):
            put(hush())
        for _ in range(100):
            if self.wake.n == 3:
                break
            time.sleep(0.01)
        self.assertEqual(self.wake.n, 3)

    def test_wav(self):
        with wave.open(io.BytesIO(to_wav(tone(1.0)))) as w:
            self.assertEqual(w.getnframes(), RATE)


if __name__ == "__main__":
    unittest.main()
