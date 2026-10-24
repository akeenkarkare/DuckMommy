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

MOTION_PIXELS = 1500     # tune on real hardware; larger = less sensitive
IDLE_TIMEOUT_S = 300.0   # 5 minutes
BLUR_KERNEL = 21         # Gaussian blur kernel (odd; larger = smoother diff)
DIFF_THRESHOLD = 25      # per-pixel intensity delta that counts as changed


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

        diff = cv2.absdiff(self._prev_gray, gray)
        _, mask = cv2.threshold(diff, DIFF_THRESHOLD, 255, cv2.THRESH_BINARY)
        pixels = cv2.countNonZero(mask)
        self._prev_gray = gray

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

    def reset(self) -> None:
        """Discard frame history (call when the camera restarts)."""
        self._prev_gray = None

    def debug_info(self) -> dict:
        return {
            "state": self.state,
            "idle_for_s": round(time.monotonic() - self._last_motion, 1) if self._last_motion else None,
        }
