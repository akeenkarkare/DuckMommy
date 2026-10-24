"""Sentry logic: "did someone come into the room?" Stdlib only, so it unit-tests anywhere.

Two stages, so the heavy camera only runs when something has moved:
  1. Trigger: the ultrasonic distance jumps away from the room's baseline
     (UltrasonicMotion), or, in camera-only mode, OpenCV sees motion.
  2. Confirm: the camera wakes up and the pose detector must see a person in
     NEED_HITS of the last WINDOW frames within LOOK_S. Works the same in
     night vision; the camera handles day/night itself.

Contract matches backend/sim/fake-duck.js and the dashboard:
  sentry event value: {distance_cm, person_confirmed, confidence, night, trigger}
  a confirmed person also speaks settings["sentry_message"]
  after an alert, COOLDOWN_S of quiet so one visitor isn't announced 20 times
"""

from __future__ import annotations

from collections import deque
from statistics import median

LOOK_S = 8.0             # camera stays on this long looking for a person
NEED_HITS, WINDOW = 3, 5  # person in 3 of the last 5 frames = confirmed
MIN_CONFIDENCE = 0.5     # per-frame person score that counts as a hit
COOLDOWN_S = 60.0        # after a confirmed person: no new alerts for this long
FALSE_COOLDOWN_S = 15.0  # after motion with no person: shorter quiet period
WARMUP_S = 0.7           # ignore frames right after the camera wakes (auto exposure settling)


class UltrasonicMotion:
    """Turns raw distance readings into "something moved".

    Keeps a rolling median of normal readings as the room's baseline (where the
    beam hits a wall or the door). A reading that differs by more than
    max(MIN_CHANGE_CM, REL_CHANGE * baseline) CONFIRM times in a row = motion.
    If the new distance sticks (furniture moved), it becomes the baseline.
    """

    MIN_CHANGE_CM = 25.0
    REL_CHANGE = 0.15
    CONFIRM = 2
    BASELINE_N = 30
    WARMUP_N = 5
    ADOPT_AFTER = 150        # ~15 s of "moved" readings at 10 Hz -> accept as new baseline

    def __init__(self):
        self.history: deque[float] = deque(maxlen=self.BASELINE_N)
        self.hits = 0

    @property
    def baseline(self) -> float | None:
        return median(self.history) if len(self.history) >= self.WARMUP_N else None

    def update(self, distance_cm: float | None) -> bool:
        if distance_cm is None:
            return False
        base = self.baseline
        if base is None:
            self.history.append(distance_cm)
            return False
        if abs(distance_cm - base) > max(self.MIN_CHANGE_CM, self.REL_CHANGE * base):
            self.hits += 1
            if self.hits >= self.ADOPT_AFTER:
                self.history.clear()
                self.hits = 0
            return self.hits >= self.CONFIRM
        self.hits = 0
        self.history.append(distance_cm)
        return False


class SentryWatch:
    """States: idle (camera off) -> looking (camera on) -> cooldown -> idle.

    Returns actions for the caller to carry out:
      ("camera", "on" | "off"), ("event", "sentry", value), ("speak", text)
    `settings` is the dict the relay pushes; read live.
    """

    def __init__(self, settings: dict):
        self.settings = settings
        self.state = "idle"
        self.until = 0.0                  # end of looking / cooldown
        self.looking_since = 0.0
        self.recent: deque[bool] = deque(maxlen=WINDOW)
        self.best = 0.0
        self.trigger_info: dict = {}
        self.night = False

    @property
    def looking(self) -> bool:
        return self.state == "looking"

    def tick(self, now: float) -> list[tuple]:
        if self.state == "cooldown" and now >= self.until:
            self.state = "idle"
        if self.state == "looking" and now >= self.until:
            return self._finish(now, confirmed=False)
        return []

    def trigger(self, now: float, distance_cm: float | None, source: str) -> list[tuple]:
        """Something moved. Start looking unless we're busy, cooling down or disabled."""
        actions = self.tick(now)
        if not self.settings.get("sentry_enabled", True) or self.state != "idle":
            return actions
        self.state = "looking"
        self.looking_since, self.until = now, now + LOOK_S
        self.recent.clear()
        self.best = 0.0
        self.night = False
        self.trigger_info = {"distance_cm": None if distance_cm is None else round(distance_cm), "trigger": source}
        return actions + [("camera", "on")]

    def frame(self, now: float, person_confidence: float | None, night: bool) -> list[tuple]:
        """One camera frame while looking. person_confidence: 0..1, or None for nobody."""
        if self.state != "looking":
            return []
        if now - self.looking_since < WARMUP_S:
            return []
        conf = person_confidence or 0.0
        self.best = max(self.best, conf)
        self.recent.append(conf >= MIN_CONFIDENCE)
        self.night = night
        if sum(self.recent) >= NEED_HITS:
            return self._finish(now, confirmed=True)
        return self.tick(now)

    def _finish(self, now: float, confirmed: bool) -> list[tuple]:
        value = {
            **self.trigger_info,
            "person_confirmed": confirmed,
            "confidence": round(self.best, 2),
            "night": self.night,
        }
        self.state = "cooldown"
        self.until = now + (COOLDOWN_S if confirmed else FALSE_COOLDOWN_S)
        actions = [("event", "sentry", value), ("camera", "off")]
        msg = self.settings.get("sentry_message")
        if confirmed and msg:
            actions.append(("speak", msg))
        return actions
