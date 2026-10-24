"""MediaPipe Pose Landmarker -> the ear/shoulder Points that judge.py wants.

Uses the Tasks API (mediapipe.tasks.python.vision.PoseLandmarker). The old
`mp.solutions.pose` API that most tutorials use no longer exists.
"""

from __future__ import annotations

from judge import Point

# MediaPipe's 33-landmark body model
NOSE, LEFT_EAR, RIGHT_EAR, LEFT_SHOULDER, RIGHT_SHOULDER, LEFT_HIP, RIGHT_HIP = 0, 7, 8, 11, 12, 23, 24
WANTED = {
    "nose": NOSE,
    "left_ear": LEFT_EAR, "right_ear": RIGHT_EAR,
    "left_shoulder": LEFT_SHOULDER, "right_shoulder": RIGHT_SHOULDER,
    "left_hip": LEFT_HIP, "right_hip": RIGHT_HIP,
}


def to_points(landmarks, width: int, height: int) -> dict[str, Point]:
    """MediaPipe gives x, y normalized 0..1 per axis. Scale to pixels so a
    640x480 frame doesn't squash angles."""
    return {
        name: Point(landmarks[i].x * width, landmarks[i].y * height,
                    getattr(landmarks[i], "visibility", 1.0) or 0.0)
        for name, i in WANTED.items()
    }


class PoseDetector:
    """One person, VIDEO mode (synchronous, timestamps must strictly increase)."""

    def __init__(self, model_path: str):
        import mediapipe as mp                      # imported here so judge tests need no mediapipe
        from mediapipe.tasks.python import BaseOptions, vision

        self._mp = mp
        self._landmarker = vision.PoseLandmarker.create_from_options(
            vision.PoseLandmarkerOptions(
                base_options=BaseOptions(model_asset_path=model_path),
                running_mode=vision.RunningMode.VIDEO,
                num_poses=1,
            )
        )
        self._last_ts = -1

    def detect(self, rgb, now_s: float):
        """rgb: HxWx3 uint8 numpy array in RGB order.
        Returns (points dict or None, raw landmark list or None)."""
        ts = max(int(now_s * 1000), self._last_ts + 1)
        self._last_ts = ts
        image = self._mp.Image(image_format=self._mp.ImageFormat.SRGB, data=rgb)
        result = self._landmarker.detect_for_video(image, ts)
        if not result.pose_landmarks:
            return None, None
        lm = result.pose_landmarks[0]
        h, w = rgb.shape[:2]
        return to_points(lm, w, h), lm

    def close(self):
        self._landmarker.close()
