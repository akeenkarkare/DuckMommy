"""Motion detector brain: numpy frames in, action tuples out. No hardware deps.

Actions:
  ("state", "ACTIVE")   just switched to active (motion detected)
  ("state", "IDLE")     just switched to idle (timeout expired)

config keys (all optional):
  motion_pixels  int   changed pixels to count as motion (default 1500)
  idle_timeout_s float seconds without motion before going idle (default 300)
"""

from __future__ import annotations

import time

import numpy as np

MOTION_PIXELS = 1500     # tune on real hardware; larger = less sensitive
IDLE_TIMEOUT_S = 300.0   # 5 minutes
BLUR_KERNEL = 21         # Gaussian blur kernel (odd; larger = smoother diff)
DIFF_THRESHOLD = 25      # per-pixel intensity delta that counts as changed
SCENE_CHANGE_FRACTION = 0.6   # more than this much of the frame changed at once =
                              # lights / exposure / day-night switch, not a person


class MotionDetector:
    """Frame-difference motion detector.

    Feed it uint8 HxWxC numpy frames (RGB or BGR — grayscale result is the same).
    Call update() once per frame; handle the returned action tuples.
    """

    def __init__(self, config: dict | None = None):
        self.config = config or {}
        self.state = "IDLE"
        self._prev_gray = None
        self._last_motion: float = 0.0
        self.last_pixels = 0

    @property
    def active(self) -> bool:
        return self.state == "ACTIVE"

    def update(self, now: float, frame) -> list[tuple]:
        """Process one frame. Returns a (possibly empty) list of action tuples."""
        import cv2

        gray = cv2.cvtColor(frame, cv2.COLOR_RGB2GRAY)
        gray = cv2.GaussianBlur(gray, (BLUR_KERNEL, BLUR_KERNEL), 0)

        if self._prev_gray is None:
            self._prev_gray = gray
            return []

        # Cancel a uniform brightness shift (auto-exposure, a lamp) before diffing.
        shift = float(gray.mean()) - float(self._prev_gray.mean())
        signed = gray.astype(np.int16) - self._prev_gray.astype(np.int16) - int(round(shift))
        diff = np.clip(np.abs(signed), 0, 255).astype(np.uint8)
        _, mask = cv2.threshold(diff, DIFF_THRESHOLD, 255, cv2.THRESH_BINARY)
        pixels = cv2.countNonZero(mask)
        self._prev_gray = gray
        self.last_pixels = pixels
        if pixels > SCENE_CHANGE_FRACTION * mask.size:
            return []   # whole scene changed (e.g. night vision kicked in): re-baseline, not motion

        threshold = int(self.config.get("motion_pixels", MOTION_PIXELS))
        timeout = float(self.config.get("idle_timeout_s", IDLE_TIMEOUT_S))

        if pixels >= threshold:
            self._last_motion = now
            if self.state == "IDLE":
                self.state = "ACTIVE"
                return [("state", "ACTIVE")]
        elif self.state == "ACTIVE" and (now - self._last_motion) >= timeout:
            self.state = "IDLE"
            return [("state", "IDLE")]

        return []

    def reset(self, now: float | None = None) -> None:
        """Discard frame history (call when the camera restarts).
        With `now`: also start counting stillness from now (someone just sat down)."""
        self._prev_gray = None
        if now is not None:
            self._last_motion = now
            self.state = "ACTIVE"

    @property
    def timeout_s(self) -> float:
        return float(self.config.get("idle_timeout_s", IDLE_TIMEOUT_S))

    def still_for(self, now: float) -> float:
        """Seconds since the last motion (0 if there hasn't been any yet)."""
        return now - self._last_motion if self._last_motion else 0.0

    def debug_info(self, now: float | None = None) -> dict:
        now = time.monotonic() if now is None else now
        return {
            "state": self.state,
            "idle_for_s": round(self.still_for(now), 1) if self._last_motion else None,
            "timeout_s": self.timeout_s,
            "pixels": self.last_pixels,
        }
