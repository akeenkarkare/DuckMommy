"""Camera-side helpers for sentry: is that a person, did anything move? (needs OpenCV)"""

from __future__ import annotations

MOTION_FRACTION = 0.02    # share of the (downscaled) frame that must change to count as motion
BODY = ("nose", "left_shoulder", "right_shoulder", "left_hip", "right_hip")


def person_confidence(points) -> float | None:
    """Mean visibility of the clearest body landmarks; None if no pose at all."""
    if not points:
        return None
    vis = sorted((points[k].visibility for k in BODY if k in points), reverse=True)
    return sum(vis[:3]) / 3 if len(vis) >= 3 else None


class Motion:
    """OpenCV background subtraction on a small grey frame. Works in IR (grey) too."""

    def __init__(self):
        import cv2
        self.cv2 = cv2
        self.bg = cv2.createBackgroundSubtractorMOG2(history=150, varThreshold=32, detectShadows=False)
        self.frames = 0

    def fraction(self, rgb) -> float:
        cv2 = self.cv2
        small = cv2.resize(cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY), (160, 120))
        small = cv2.GaussianBlur(small, (5, 5), 0)
        mask = self.bg.apply(small)
        self.frames += 1
        if self.frames < 15:                      # still learning the empty room
            return 0.0
        mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, None)   # drop sensor-noise speckle
        return cv2.countNonZero(mask) / mask.size
