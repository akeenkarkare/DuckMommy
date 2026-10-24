"""Frames of landmarks in, signs and phrases out.

No camera, network or model files here, so this file can be unit tested with
fake landmarks (see test_asl_engine.py).

The pipeline, once per camera frame:

  1. Segmenter     Watches the hands. A sign starts when a hand comes up above
                   the "rest line" (a bit below the chest) and ends when the
                   hands drop back down. Signing one word at a time with the
                   hands lowered in between is what makes this reliable; it is
                   also how the training samples are cut, so the two match.
  2. Classifier    Says which sign the cut-out piece was, or "not a sign".
  3. PhraseBuilder Collects signs until the signer pauses, then turns the
                   gloss list (START FOCUS) into an English sentence and an
                   optional duck command ("Starting a focus session", start_focus).

WordSignReader (bottom) wraps it all in the actions interface duck.py uses.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field

import numpy as np

from features import sequence_features
from landmarks import LEFT_SHOULDER, N_POINTS, RIGHT_SHOULDER, WRIST, hand


@dataclass
class Config:
    # Rest line, in shoulder widths below the shoulders (about the belly).
    # Hands below it (on the desk, in the lap) are "resting".
    rest_line: float = 1.4
    start_frames: int = 2  # hand must be up this many frames to start a sign
    end_seconds: float = 0.35  # hands down this long ends the sign
    min_sign_seconds: float = 0.25  # shorter = a twitch, ignored
    max_sign_seconds: float = 3.5  # longer = cut and classified anyway
    lost_person_seconds: float = 2.0
    phrase_gap_seconds: float = 1.6  # no new sign this long = sentence finished
    max_phrase_signs: int = 6  # a sentence this long is finished anyway
    history: int = 10


# ---- 1. segmentation ----------------------------------------------------------
class Segmenter:
    def __init__(self, cfg: Config):
        self.cfg = cfg
        self.frames: list[np.ndarray] = []
        self.active = False
        self.up_count = 0
        self.started_at = 0.0
        self.last_up = 0.0
        self.last_up_index = 0
        self.shoulder_y = None
        self.shoulder_w = None

    def hands_up(self, frame: np.ndarray) -> bool:
        ls, rs = frame[LEFT_SHOULDER], frame[RIGHT_SHOULDER]
        if not (np.isnan(ls[0]) or np.isnan(rs[0])):
            # Remember the body size so a half-visible body still works.
            self.shoulder_y = (ls[1] + rs[1]) / 2
            self.shoulder_w = float(np.hypot(*(ls[:2] - rs[:2])))
        for side in ("left", "right"):
            w = hand(frame, side)[WRIST]
            if np.isnan(w[0]):
                continue
            if self.shoulder_y is None:
                return True  # no body yet: any visible hand counts
            if w[1] < self.shoulder_y + self.cfg.rest_line * self.shoulder_w:
                return True
        return False

    def update(self, frame: np.ndarray, now: float):
        """Feed one (75, 3) frame. Returns a finished (T, 75, 3) sign or None."""
        cfg = self.cfg
        up = self.hands_up(frame)
        if up:
            self.up_count += 1
        else:
            self.up_count = 0  # also ends the wait after a too-long sign

        if not self.active:
            self.frames = (self.frames + [frame])[-cfg.start_frames :]  # keep the lead-in
            if self.up_count >= cfg.start_frames:
                self.active, self.started_at, self.last_up = True, now, now
                self.last_up_index = len(self.frames) - 1
            return None

        self.frames.append(frame)
        if up:
            self.last_up, self.last_up_index = now, len(self.frames) - 1
        too_long = now - self.started_at >= cfg.max_sign_seconds
        if now - self.last_up >= cfg.end_seconds or too_long:
            # Drop the hands-down frames at the end; keep one so the sign "lands".
            seq = np.stack(self.frames[: self.last_up_index + 2])
            length = self.last_up - self.started_at
            self.active, self.frames, self.up_count = False, [], 0
            if too_long:
                self.up_count = -10**9  # wait for the hands to come down first
            if length >= cfg.min_sign_seconds:
                return seq
        return None


def trim_to_sign(seq: np.ndarray, cfg: Config) -> np.ndarray | None:
    """Cut a one-sign clip (T, 75, 3) to where a hand is above the rest line, the
    same rule the live segmenter uses, so samples from video or datasets look
    like samples recorded live. None if no hand ever comes up."""
    seg = Segmenter(cfg)
    up = np.array([seg.hands_up(f) for f in seq])
    if not up.any():
        return None
    a, b = np.flatnonzero(up)[[0, -1]]
    return seq[max(0, a - 1) : b + 2]


# ---- 3. gloss list -> sentence --------------------------------------------------
@dataclass
class Phrase:
    id: int
    glosses: list
    text: str
    commands: list

    def as_dict(self):
        return {"id": self.id, "glosses": self.glosses, "text": self.text, "commands": self.commands}


class PhraseBuilder:
    """vocab = the "phrases.json" dict: {"signs": {...}, "phrases": [...]}."""

    def __init__(self, vocab: dict, cfg: Config):
        self.cfg = cfg
        self.words = {g: info.get("word", g.lower().replace("-", " ")) for g, info in vocab.get("signs", {}).items()}
        self.phrases = sorted(vocab.get("phrases", []), key=lambda p: -len(p["signs"]))
        self.pending: list[str] = []
        self.last_sign_at = 0.0
        self.next_id = 1

    def _entry(self, glosses):
        for p in self.phrases:
            if p["signs"] == glosses:
                return p
        return None

    def add(self, gloss: str, now: float):
        """Returns a Phrase right away for "immediate" signs like STOP."""
        entry = self._entry([gloss])
        if entry and entry.get("immediate"):
            self.pending = []
            return self._make([gloss], entry["text"], [entry["command"]] if entry.get("command") else [])
        self.pending.append(gloss)
        self.last_sign_at = now
        return self.flush() if len(self.pending) >= self.cfg.max_phrase_signs else None

    def tick(self, now: float, signing: bool):
        if self.pending and not signing and now - self.last_sign_at >= self.cfg.phrase_gap_seconds:
            return self.flush()
        return None

    def flush(self):
        if not self.pending:
            return None
        glosses, self.pending = self.pending, []
        texts, commands, i = [], [], 0
        while i < len(glosses):
            # Longest known phrase starting here, else the plain English word.
            for p in self.phrases:
                n = len(p["signs"])
                if glosses[i : i + n] == p["signs"]:
                    texts.append(p["text"])
                    if p.get("command"):
                        commands.append(p["command"])
                    i += n
                    break
            else:
                texts.append(self.words.get(glosses[i], glosses[i].lower()))
                i += 1
        text = " ".join(texts)
        if text and text[-1] not in ".!?":
            text = text[0].upper() + text[1:] + "."
        return self._make(glosses, text, commands)

    def _make(self, glosses, text, commands):
        p = Phrase(self.next_id, list(glosses), text, commands)
        self.next_id += 1
        return p


# ---- everything together ----------------------------------------------------------
@dataclass
class State:
    status: str = "no_person"  # no_person | idle | signing | recording
    last_seen: float = 0.0
    sign_id: int = 0
    last_sign: dict | None = None  # accepted sign
    last_guess: dict | None = None  # every classified segment, for the debug view
    rejected: int = 0
    phrase: dict | None = None
    history: list = field(default_factory=list)
    recording: dict | None = None  # {"gloss", "done", "target", "who"}


class AslEngine:
    def __init__(self, classifier, vocab: dict, cfg: Config | None = None, on_sample=None):
        self.cfg = cfg or Config()
        self.classifier = classifier  # None until a model is trained
        self.segmenter = Segmenter(self.cfg)
        self.phrases = PhraseBuilder(vocab, self.cfg)
        self.on_sample = on_sample  # callback(gloss, raw_seq, who) while recording
        self.s = State()

    # -- recording training data ------------------------------------------------
    def start_recording(self, gloss: str, count: int, who: str = "anon"):
        self.s.recording = {"gloss": gloss, "done": 0, "target": count, "who": who}

    def stop_recording(self):
        self.s.recording = None

    # -- per-frame update ---------------------------------------------------------
    def update(self, frame: np.ndarray | None, now: float | None = None) -> dict:
        now = time.monotonic() if now is None else now
        s = self.s
        person = frame is not None and not np.all(np.isnan(frame[:, 0]))
        if person:
            s.last_seen = now
            seq = self.segmenter.update(frame, now)
            if seq is not None:
                self._handle_segment(seq, now)
        elif now - s.last_seen > self.cfg.lost_person_seconds:
            self.segmenter.active, self.segmenter.frames = False, []
            s.status = "no_person"
        elif self.segmenter.active:
            # Body lost for a moment (blur, hands over the face): count it as
            # hands down so the sign can still end and be classified.
            seq = self.segmenter.update(np.full((N_POINTS, 3), np.nan, dtype=np.float32), now)
            if seq is not None:
                self._handle_segment(seq, now)

        phrase = self.phrases.tick(now, signing=self.segmenter.active)
        if phrase:
            self._publish(phrase)
        if person or now - s.last_seen <= self.cfg.lost_person_seconds:
            s.status = "recording" if s.recording else ("signing" if self.segmenter.active else "idle")
        return self.snapshot()

    def _handle_segment(self, seq, now):
        s = self.s
        if s.recording:
            if self.on_sample:
                self.on_sample(s.recording["gloss"], seq, s.recording["who"])
            s.recording["done"] += 1
            if s.recording["done"] >= s.recording["target"]:
                s.recording = None
            return
        if self.classifier is None:
            return
        feat = sequence_features(seq)
        if feat is None:
            return
        pred = self.classifier.predict(feat)
        s.last_guess = {**pred.as_dict(), "frames": len(seq)}
        if pred.label is None:
            s.rejected += 1
            return
        s.sign_id += 1
        s.last_sign = {"id": s.sign_id, "gloss": pred.label, "score": round(pred.score, 3)}
        phrase = self.phrases.add(pred.label, now)
        if phrase:
            self._publish(phrase)

    def _publish(self, phrase: Phrase):
        self.s.phrase = phrase.as_dict()
        self.s.history = (self.s.history + [phrase.as_dict()])[-self.cfg.history :]

    def clear(self):
        self.phrases.pending = []

    def finish(self):
        """The signer left: say what they signed so far instead of waiting for the pause."""
        phrase = self.phrases.flush()
        if phrase:
            self._publish(phrase)
        self.segmenter.active, self.segmenter.frames = False, []

    def snapshot(self) -> dict:
        s = self.s
        return {
            "status": s.status,
            "signing": self.segmenter.active,
            "last_sign": s.last_sign,  # new sign -> its "id" changes
            "pending": list(self.phrases.pending),  # signs waiting for the pause
            "phrase": s.phrase,  # new sentence -> its "id" changes
            "last_guess": s.last_guess,
            "rejected": s.rejected,
            "recording": dict(s.recording) if s.recording else None,
            "model_loaded": self.classifier is not None,
            "history": list(s.history),
        }


# ---- duck.py adapter ------------------------------------------------------------
class WordSignReader:
    """Holistic frames in, duck actions out (duck.py's action tuples):

      ("led", "sign")                       each recognised sign: the signer's visual "got it"
      ("event", "sign", {text, signs, commands}) + ("speak", text)   each finished sentence
      ("command", name)                     each duck command in that sentence

    `settings` is the dict the relay pushes; `sign_enabled` is read live.
    """

    def __init__(self, engine: AslEngine, settings: dict):
        self.engine = engine
        self.settings = settings
        self._sign_id = self._phrase_id = None

    def update(self, now: float, frame: np.ndarray | None) -> list[tuple]:
        if not self.settings.get("sign_enabled", True):
            self.engine.clear()
            return []
        return self._actions(self.engine.update(frame, now))

    def finish(self) -> list[tuple]:
        self.engine.finish()
        return self._actions(self.engine.snapshot())

    def _actions(self, snap: dict) -> list[tuple]:
        actions = []
        sign, phrase = snap["last_sign"] or {}, snap["phrase"] or {}
        if sign and sign["id"] != self._sign_id:
            self._sign_id = sign["id"]
            actions.append(("led", "sign"))
        if phrase and phrase["id"] != self._phrase_id:
            self._phrase_id = phrase["id"]
            value = {"text": phrase["text"], "signs": phrase["glosses"], "commands": phrase["commands"]}
            actions += [("event", "sign", value), ("speak", phrase["text"])]
            actions += [("command", name) for name in phrase["commands"]]
        return actions
