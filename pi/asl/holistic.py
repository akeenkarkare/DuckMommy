"""MediaPipe Holistic Landmarker -> what the rest of the duck wants from one camera frame.

One model pass gives the body (33 points, the same numbering as the Pose
Landmarker) and both hands, so word signs, posture and the sentry person check
can share it:
  * points: the ear/shoulder/hip Points that ../posture/judge.py wants (pixels)
  * frame:  the (75, 3) array that asl_engine.py wants (see landmarks.py)

Tasks API only (vision.HolisticLandmarker); `mp.solutions` no longer exists.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np

from judge import Point
from landmarks import result_to_array
from pose import WANTED

DEFAULT_MODEL = Path(__file__).resolve().parent.parent / "models" / "holistic_landmarker.task"


def to_points(pose_landmarks, width: int, height: int) -> dict[str, Point] | None:
    """Like pose.to_points. Holistic may leave visibility unset; count that as seen."""
    if not pose_landmarks:
        return None
    out = {}
    for name, i in WANTED.items():
        lm = pose_landmarks[i]
        vis = getattr(lm, "visibility", None)
        out[name] = Point(lm.x * width, lm.y * height, 1.0 if vis is None else vis)
    return out


class HolisticDetector:
    """One person, VIDEO mode (synchronous, timestamps must strictly increase)."""

    def __init__(self, model_path: str | Path = DEFAULT_MODEL):
        import mediapipe as mp                      # imported here so the tests need no mediapipe
        from mediapipe.tasks.python import BaseOptions, vision

        self._mp = mp
        self._landmarker = vision.HolisticLandmarker.create_from_options(
            vision.HolisticLandmarkerOptions(
                base_options=BaseOptions(model_asset_path=str(model_path)),
                running_mode=vision.RunningMode.VIDEO,
                min_pose_detection_confidence=0.5,
                min_hand_landmarks_confidence=0.5,
            )
        )
        self._last_ts = -1

    def detect(self, rgb, now_s: float):
        """rgb: HxWx3 uint8 numpy array in RGB order.
        Returns (points dict or None, (75, 3) frame or None)."""
        ts = max(int(now_s * 1000), self._last_ts + 1)
        self._last_ts = ts
        image = self._mp.Image(image_format=self._mp.ImageFormat.SRGB, data=np.ascontiguousarray(rgb))
        result = self._landmarker.detect_for_video(image, ts)
        if not result.pose_landmarks:
            return None, None
        h, w = rgb.shape[:2]
        return to_points(result.pose_landmarks, w, h), result_to_array(result, aspect=w / h)

    def close(self):
        self._landmarker.close()
