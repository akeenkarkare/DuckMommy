"""Slouch judging: pose landmarks in, posture events + "speak" actions out.

Library-agnostic and dependency-free. Whatever pose library runs on the Pi
just has to hand us ear/shoulder (side view) points in image coordinates
(x right, y DOWN), plus a visibility/confidence score per point.

Calibrated per person: when someone first appears the duck asks them to sit
up tall, records their upright bend for CALIBRATE_S, and only counts a slouch
when they bend `margin` degrees past that baseline. Fixed angles failed in
testing (one person's upright read 29-37 deg).

Contract matches backend/sim/fake-duck.js and the dashboard:
  * slouch must persist `posture_delay_s` before the first prompt
  * while still slouching, remind every REMIND_EVERY_S
  * when a *prompted* slouch ends, emit an `upright` event
  * slouches fixed before the delay never produce an event
  * posture_severity: 0 = only very bad slouches count, 100 = any lean counts
    (maps to how far past the baseline counts: 9 / 5 / 1 deg at 0 / 50 / 100)
Event value: {state: "slouch"|"upright", neck_angle_deg, slouch_duration_s}
"""

from __future__ import annotations

import math
from dataclasses import dataclass

REMIND_EVERY_S = 30          # same as the fake duck
HYSTERESIS_DEG = 3.0         # must drop this far below the limit to count as fixed
LOST_TRACKING_S = 2.0        # no usable pose this long -> slouch is over
MIN_VISIBILITY = 0.5         # ignore landmarks the pose model isn't sure about
MIN_HIP_VISIBILITY = 0.5     # below this, assume the desk hides the hip and use vertical instead
EMA_ALPHA = 0.3              # smoothing per frame (higher = snappier, noisier)

CALIBRATE_S = 3.0            # how long to record someone's upright posture
AWAY_RECALIBRATE_S = 10.0    # gone this long -> treat the next person as new
CALIBRATE_MESSAGE = "Sit up tall for me!"

# degrees past your own upright baseline that count as a slouch
# severity 0 -> 9, 50 -> 5, 100 -> 1
LENIENT_MARGIN = 9.0
STRICT_MARGIN = 1.0


def margin_deg(severity: float) -> float:
    s = min(100.0, max(0.0, float(severity)))
    return LENIENT_MARGIN - (LENIENT_MARGIN - STRICT_MARGIN) * s / 100.0


@dataclass
class Point:
    x: float
    y: float
    visibility: float = 1.0


def neck_angle_deg(ear: Point, shoulder: Point, hip: Point | None = None) -> float:
    """How far the head bends forward off the torso line, in degrees.

    With a hip: angle between the hip->shoulder line and the shoulder->ear line.
    Leaning the whole body forward with a straight back keeps the three points
    in line, so it stays near 0; a jutting head or rounded back raises it.
    Without a hip (hidden by the desk): fall back to the shoulder->ear line vs.
    vertical, which can't tell a straight lean from a slouch.
    """
    nx, ny = ear.x - shoulder.x, shoulder.y - ear.y          # image y points down
    if hip is None:
        tx, ty = 0.0, 1.0                                     # vertical
    else:
        tx, ty = shoulder.x - hip.x, hip.y - shoulder.y
    n_len, t_len = math.hypot(nx, ny), math.hypot(tx, ty)
    if n_len == 0 or t_len == 0:
        return 0.0
    cos = max(-1.0, min(1.0, (nx * tx + ny * ty) / (n_len * t_len)))
    return math.degrees(math.acos(cos))


def pick_side(landmarks: dict[str, Point]) -> tuple[Point, Point, Point | None] | None:
    """Use whichever side (left/right) the camera sees better. Keys:
    {left,right}_{ear,shoulder,hip} (missing keys are fine).
    Returns (ear, shoulder, hip-or-None)."""
    best, best_vis = None, MIN_VISIBILITY
    for side in ("left", "right"):
        ear, sh = landmarks.get(f"{side}_ear"), landmarks.get(f"{side}_shoulder")
        if ear is None or sh is None:
            continue
        vis = min(ear.visibility, sh.visibility)
        if vis >= best_vis:
            hip = landmarks.get(f"{side}_hip")
            if hip is not None and hip.visibility < MIN_HIP_VISIBILITY:
                hip = None
            best, best_vis = (ear, sh, hip), vis
    return best


class PostureJudge:
    """Feed it one frame at a time; it returns actions for the Pi to carry out.

    Actions: ("event", "posture", value_dict) and ("speak", text).
    `settings` is the dict the relay pushes; it's read live on every frame.
    """

    def __init__(self, settings: dict):
        self.settings = settings
        self.angle: float | None = None       # smoothed neck angle
        self.using_hip = False                # last reading used the torso line (vs. vertical)
        self.last_seen: float | None = None   # time of last usable pose
        self.slouch_since: float | None = None
        self.prompted = False
        self.last_prompt = 0.0
        # calibration: separate baselines for torso mode (True) and vertical mode (False)
        self.baseline: dict[bool, float] = {}
        self.calib_start: float | None = None
        self.calib_samples: list[float] = []
        self.greeted = False                  # asked this person to sit up tall yet?

    @property
    def calibrating(self) -> bool:
        return self.calib_start is not None

    @property
    def limit(self) -> float | None:
        """Current slouch threshold in degrees, or None until calibrated."""
        base = self.baseline.get(self.using_hip)
        if base is None:
            return None
        return base + margin_deg(self.settings.get("posture_severity", 50))

    def recalibrate(self) -> None:
        """Forget baselines; the next frames re-record upright posture (and re-ask)."""
        self.baseline.clear()
        self.calib_start, self.calib_samples, self.greeted = None, [], False

    # -- public -----------------------------------------------------------
    def update(self, now: float, landmarks: dict[str, Point] | None) -> list[tuple]:
        side = pick_side(landmarks) if landmarks else None
        if side is None:
            return self._no_pose(now)

        raw = neck_angle_deg(*side)
        mode_changed = self.angle is not None and self.using_hip != (side[2] is not None)
        self.using_hip = side[2] is not None
        self.angle = raw if (self.angle is None or mode_changed) else EMA_ALPHA * raw + (1 - EMA_ALPHA) * self.angle
        self.last_seen = now

        if self.using_hip not in self.baseline:
            return self._calibrate(now, raw)

        limit = self.limit
        slouching_now = self.angle >= (limit if self.slouch_since is None else limit - HYSTERESIS_DEG)

        if slouching_now:
            return self._slouching(now)
        return self._end_slouch(now)

    def reset(self) -> list[tuple]:
        """Person left / camera turned off. The next person gets calibrated."""
        actions = self._end_slouch(self.last_seen or 0.0, clear_angle=True)
        self.recalibrate()
        return actions

    # -- internals --------------------------------------------------------
    def _calibrate(self, now: float, raw: float) -> list[tuple]:
        actions = self._end_slouch(now)   # mode switch mid-slouch: close it out
        if self.calib_start is None:
            self.calib_start, self.calib_samples = now, []
            if not self.greeted:          # ask once per person, not on every mode switch
                self.greeted = True
                actions.append(("speak", CALIBRATE_MESSAGE))
        self.calib_samples.append(raw)
        if now - self.calib_start >= CALIBRATE_S:
            ordered = sorted(self.calib_samples)
            self.baseline[self.using_hip] = ordered[len(ordered) // 2]   # median
            self.calib_start, self.calib_samples = None, []
        return actions

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
        if self.last_seen is None:
            return []
        away = now - self.last_seen
        if away >= AWAY_RECALIBRATE_S and (self.baseline or self.greeted):
            self.recalibrate()
        if away >= LOST_TRACKING_S:
            self.calib_start, self.calib_samples = None, []   # restart an interrupted calibration
            return self._end_slouch(self.last_seen, clear_angle=True)
        return []

    def _value(self, state: str, held: float) -> dict:
        return {
            "state": state,
            "neck_angle_deg": None if self.angle is None else round(self.angle, 1),
            "slouch_duration_s": round(held),
        }
