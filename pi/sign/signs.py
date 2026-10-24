"""Sign to Duck: hand landmarks -> sign labels -> sentences. Stdlib only.

MediaPipe gives 21 hand landmarks per frame (pi/sign/hands.py). From those:

  1. Classify the handshape (static signs; signs that need motion, like J/Z
     or "thank you", aren't supported):
       * Recorded signs (signs.json, made with record.py): k-nearest-neighbours
         on wrist-relative, size-normalised landmarks. Add any sign or letter.
       * Built-in fallback when nothing is recorded: finger up/down rules for
         a few word signs (RULES below).
  2. SignReader turns the per-frame labels into text: a sign must be held
     HOLD_S to count, single letters join into a fingerspelled word, and
     when the hand drops for END_S the sentence is spoken and sent.

Landmark ids: 0 wrist; thumb 1-4; index 5-8; middle 9-12; ring 13-16; pinky 17-20
(each finger: MCP, PIP, DIP, TIP; thumb: CMC, MCP, IP, TIP).
"""

from __future__ import annotations

import json
import math
from collections import Counter
from pathlib import Path

SIGNS_FILE = Path(__file__).resolve().parent / "signs.json"

HOLD_S = 0.6          # a handshape must be steady this long to count
END_S = 1.5           # hand gone this long -> sentence finished
MAX_SIGNS = 12        # safety cap per sentence
K = 5
MAX_KNN_DIST = 0.45   # mean distance of the winning neighbours; above this = "not a known sign"

# (thumb, index, middle, ring, pinky) extended -> word
RULES = {
    (1, 1, 1, 1, 1): "hello",        # open palm
    (1, 1, 0, 0, 1): "I love you",   # ILY handshape
    (0, 1, 0, 0, 0): "you",          # point
}
# thumb only: up = "yes", down = "no" (decided by thumb direction, see rule_label)


def _dist(a, b) -> float:
    return math.hypot(a[0] - b[0], a[1] - b[1])


def fingers_extended(pts) -> tuple[int, int, int, int, int]:
    """pts: 21 (x, y[, z]) in pixels. A finger is extended if its tip is clearly
    farther from the wrist than its middle joint; the thumb if its tip is
    farther from the pinky knuckle than its IP joint."""
    wrist = pts[0]
    thumb = int(_dist(pts[4], pts[17]) > 1.1 * _dist(pts[3], pts[17]))
    others = tuple(int(_dist(pts[tip], wrist) > 1.2 * _dist(pts[pip], wrist))
                   for pip, tip in ((6, 8), (10, 12), (14, 16), (18, 20)))
    return (thumb, *others)


def rule_label(pts) -> str | None:
    state = fingers_extended(pts)
    if state == (1, 0, 0, 0, 0):
        tip, base = pts[4], pts[2]
        if abs(tip[1] - base[1]) > abs(tip[0] - base[0]):   # thumb mostly vertical
            return "yes" if tip[1] < base[1] else "no"      # image y points down
        return None
    return RULES.get(state)


def features(pts, handedness: str = "Right") -> list[float]:
    """Wrist-relative, scaled by palm size, left hands mirrored: 42 numbers."""
    wx, wy = pts[0][0], pts[0][1]
    scale = _dist(pts[0], pts[9]) or 1.0          # wrist -> middle knuckle
    flip = -1.0 if handedness == "Left" else 1.0
    out = []
    for p in pts:
        out += [flip * (p[0] - wx) / scale, (p[1] - wy) / scale]
    return out


class KNN:
    def __init__(self, samples: dict[str, list[list[float]]]):
        self.data = [(label, vec) for label, vecs in samples.items() for vec in vecs]

    def __bool__(self):
        return bool(self.data)

    def classify(self, vec: list[float]) -> str | None:
        if not self.data:
            return None
        nearest = sorted(((math.dist(vec, v), label) for label, v in self.data))[:K]
        label, votes = Counter(l for _, l in nearest).most_common(1)[0]
        if votes <= K // 2:
            return None
        mean = sum(d for d, l in nearest if l == label) / votes
        return label if mean <= MAX_KNN_DIST * math.sqrt(len(vec) / 2) else None


def load_samples(path: Path = SIGNS_FILE) -> dict[str, list[list[float]]]:
    return json.loads(path.read_text()) if path.exists() else {}


def save_samples(samples: dict, path: Path = SIGNS_FILE):
    path.write_text(json.dumps(samples, separators=(",", ":")))


class SignClassifier:
    """Recorded signs if there are any, otherwise the built-in rules."""

    def __init__(self, samples: dict | None = None):
        self.knn = KNN(load_samples() if samples is None else samples)

    @property
    def mode(self) -> str:
        return f"recorded ({len({l for l, _ in self.knn.data})} signs)" if self.knn else "built-in rules"

    def classify(self, pts, handedness: str = "Right") -> str | None:
        if pts is None:
            return None
        return self.knn.classify(features(pts, handedness)) if self.knn else rule_label(pts)


def join_signs(signs: list[str]) -> str:
    """Letters next to each other form one word: [hello, D, U, C, K] -> "hello duck"."""
    words, spelled = [], ""
    for s in signs:
        if len(s) == 1:
            spelled += s
        else:
            if spelled:
                words.append(spelled.lower()); spelled = ""
            words.append(s)
    if spelled:
        words.append(spelled.lower())
    return " ".join(words)


class SignReader:
    """Per-frame labels in, actions out: ("event", "sign", value), ("speak", text)."""

    def __init__(self, settings: dict):
        self.settings = settings
        self.signs: list[str] = []
        self.current: str | None = None   # label being held
        self.since = 0.0
        self.accepted = False             # current hold already counted
        self.last_hand = None             # last time any hand was seen

    def update(self, now: float, label: str | None, hand_seen: bool) -> list[tuple]:
        if not self.settings.get("sign_enabled", True):
            self.signs.clear()
            return []
        if hand_seen:
            self.last_hand = now
        if label != self.current:
            self.current, self.since, self.accepted = label, now, False
        elif label and not self.accepted and now - self.since >= HOLD_S:
            self.accepted = True          # repeating a sign needs a different shape in between
            if len(self.signs) < MAX_SIGNS:
                self.signs.append(label)
        if self.signs and not hand_seen and self.last_hand is not None and now - self.last_hand >= END_S:
            return self.finish()
        return []

    def finish(self) -> list[tuple]:
        if not self.signs:
            return []
        text = join_signs(self.signs)
        value = {"text": text, "signs": list(self.signs)}
        self.signs.clear()
        self.current, self.accepted = None, False
        return [("event", "sign", value), ("speak", text)]
