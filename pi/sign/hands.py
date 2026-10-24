"""MediaPipe Hand Landmarker -> 21 (x, y, z) points in pixels + handedness."""

from __future__ import annotations

from pathlib import Path

DEFAULT_MODEL = Path(__file__).resolve().parent.parent / "models" / "hand_landmarker.task"


class HandDetector:
    """One hand, VIDEO mode (timestamps must strictly increase)."""

    def __init__(self, model_path: str | Path = DEFAULT_MODEL):
        import mediapipe as mp
        from mediapipe.tasks.python import BaseOptions, vision

        self._mp = mp
        self._landmarker = vision.HandLandmarker.create_from_options(
            vision.HandLandmarkerOptions(
                base_options=BaseOptions(model_asset_path=str(model_path)),
                running_mode=vision.RunningMode.VIDEO,
                num_hands=1,
                min_hand_detection_confidence=0.5,
            )
        )
        self._last_ts = -1

    def detect(self, rgb, now_s: float):
        """Returns (points, handedness) or (None, None). handedness: "Left"/"Right"."""
        ts = max(int(now_s * 1000), self._last_ts + 1)
        self._last_ts = ts
        image = self._mp.Image(image_format=self._mp.ImageFormat.SRGB, data=rgb)
        result = self._landmarker.detect_for_video(image, ts)
        if not result.hand_landmarks:
            return None, None
        h, w = rgb.shape[:2]
        pts = [(p.x * w, p.y * h, p.z * w) for p in result.hand_landmarks[0]]
        side = result.handedness[0][0].category_name if result.handedness else "Right"
        return pts, side

    def close(self):
        self._landmarker.close()
