"""Slouch judging: pose landmarks in, posture events + "speak" actions out.

Library-agnostic and dependency-free. Whatever pose library runs on the Pi
just has to hand us ear/shoulder (side view) points in image coordinates
(x right, y DOWN), plus a visibility/confidence score per point.

Contract matches backend/sim/fake-duck.js and the dashboard:
  * slouch must persist `posture_delay_s` before the first prompt
  * while still slouching, remind every REMIND_EVERY_S
  * when a *prompted* slouch ends, emit an `upright` event
  * slouches fixed before the delay never produce an event
  * posture_severity: 0 = only very bad slouches count, 100 = any lean counts
Event value: {state: "slouch"|"upright", neck_angle_deg, slouch_duration_s}
"""

from __future__ import annotations

import math
from dataclasses import dataclass

REMIND_EVERY_S = 30          # same as the fake duck
HYSTERESIS_DEG = 5.0         # must drop this far below threshold to count as fixed
LOST_TRACKING_S = 2.0        # no usable pose this long -> slouch is over
MIN_VISIBILITY = 0.5         # ignore landmarks the pose model isn't sure about
EMA_ALPHA = 0.3              # smoothing per frame (higher = snappier, noisier)

# severity 0 -> 45 deg, 50 -> 30 deg, 100 -> 15 deg (side-view neck inclination)
LENIENT_DEG = 45.0
STRICT_DEG = 15.0


def threshold_deg(severity: float) -> float:
    s = min(100.0, max(0.0, float(severity)))
    return LENIENT_DEG - (LENIENT_DEG - STRICT_DEG) * s / 100.0


@dataclass
class Point:
    x: float
    y: float
    visibility: float = 1.0


def neck_angle_deg(ear: Point, shoulder: Point) -> float:
    """Angle between vertical and the shoulder->ear line. 0 = head stacked over shoulder."""
    dx = abs(ear.x - shoulder.x)
    dy = shoulder.y - ear.y          # image y points down; ear above shoulder -> positive
    return math.degrees(math.atan2(dx, dy))


def pick_side(landmarks: dict[str, Point]) -> tuple[Point, Point] | None:
    """Use whichever side (left/right) the camera sees better. Keys:
    left_ear, left_shoulder, right_ear, right_shoulder (missing keys are fine)."""
    best, best_vis = None, MIN_VISIBILITY
    for side in ("left", "right"):
        ear, sh = landmarks.get(f"{side}_ear"), landmarks.get(f"{side}_shoulder")
        if ear is None or sh is None:
            continue
        vis = min(ear.visibility, sh.visibility)
        if vis >= best_vis:
            best, best_vis = (ear, sh), vis
    return best


class PostureJudge:
    """Feed it one frame at a time; it returns actions for the Pi to carry out.

    Actions: ("event", "posture", value_dict) and ("speak", text).
    `settings` is the dict the relay pushes; it's read live on every frame.
    """

    def __init__(self, settings: dict):
        self.settings = settings
        self.angle: float | None = None       # smoothed neck angle
        self.last_seen: float | None = None   # time of last usable pose
        self.slouch_since: float | None = None
        self.prompted = False
        self.last_prompt = 0.0

    # -- public -----------------------------------------------------------
    def update(self, now: float, landmarks: dict[str, Point] | None) -> list[tuple]:
        side = pick_side(landmarks) if landmarks else None
        if side is None:
            return self._no_pose(now)

        raw = neck_angle_deg(*side)
        self.angle = raw if self.angle is None else EMA_ALPHA * raw + (1 - EMA_ALPHA) * self.angle
        self.last_seen = now

        limit = threshold_deg(self.settings.get("posture_severity", 50))
        slouching_now = self.angle >= (limit if self.slouch_since is None else limit - HYSTERESIS_DEG)

        if slouching_now:
            return self._slouching(now)
        return self._end_slouch(now)

    def reset(self) -> list[tuple]:
        """Person left / camera turned off."""
        return self._end_slouch(self.last_seen or 0.0, clear_angle=True)

    # -- internals --------------------------------------------------------
    def _slouching(self, now: float) -> list[tuple]:
        if self.slouch_since is None:
            self.slouch_since = now
        held = now - self.slouch_since
        delay = float(self.settings.get("posture_delay_s", 5))

        due = (not self.prompted and held >= delay) or (
            self.prompted and now - self.last_prompt >= REMIND_EVERY_S)
        if not due:
            return []
        self.prompted, self.last_prompt = True, now
        actions = [("event", "posture", self._value("slouch", held))]
        msg = self.settings.get("posture_message")
        if msg:
            actions.append(("speak", msg))
        return actions

    def _end_slouch(self, now: float, clear_angle: bool = False) -> list[tuple]:
        actions = []
        if self.slouch_since is not None and self.prompted:
            actions.append(("event", "posture", self._value("upright", now - self.slouch_since)))
        self.slouch_since, self.prompted = None, False
        if clear_angle:
            self.angle = None
        return actions

    def _no_pose(self, now: float) -> list[tuple]:
        if self.last_seen is not None and now - self.last_seen >= LOST_TRACKING_S:
            return self._end_slouch(self.last_seen, clear_angle=True)
        return []

    def _value(self, state: str, held: float) -> dict:
        return {
            "state": state,
            "neck_angle_deg": None if self.angle is None else round(self.angle, 1),
            "slouch_duration_s": round(held),
        }
