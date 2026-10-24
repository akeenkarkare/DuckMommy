"""Turn a MediaPipe HolisticLandmarkerResult into one small numpy array per frame.

Every frame becomes a (75, 3) float32 array of x, y, z:
    rows  0-32  pose (MediaPipe Pose numbering)
    rows 33-53  the person's LEFT hand (21 hand points)
    rows 54-74  the person's RIGHT hand
Anything MediaPipe did not find is NaN. x is multiplied by width / height so
x and y use the same units. Recorded training samples are stacks of these
frames, shape (T, 75, 3), saved as .npy files.

Landmark docs:
https://ai.google.dev/edge/mediapipe/solutions/vision/holistic_landmarker
"""

from __future__ import annotations

import numpy as np

N_POSE, N_HAND = 33, 21
LEFT_HAND, RIGHT_HAND = N_POSE, N_POSE + N_HAND  # first row of each hand
N_POINTS = N_POSE + 2 * N_HAND  # 75

# Pose indices used elsewhere.
NOSE = 0
LEFT_SHOULDER, RIGHT_SHOULDER = 11, 12
LEFT_ELBOW, RIGHT_ELBOW = 13, 14
LEFT_WRIST, RIGHT_WRIST = 15, 16
# Hand indices.
WRIST, MIDDLE_MCP = 0, 9

# Left/right pose pairs, for mirroring a left-handed signer.
POSE_PAIRS = [(1, 4), (2, 5), (3, 6), (7, 8), (9, 10)] + [(i, i + 1) for i in range(11, 33, 2)]


def _fill(out, start, points, aspect, min_visibility=None):
    for i, p in enumerate(points):
        vis = getattr(p, "visibility", None)  # can be None depending on the MediaPipe build
        if min_visibility is not None and vis is not None and vis < min_visibility:
            continue  # pose points guessed off-screen are worse than missing
        out[start + i] = (p.x * aspect, p.y, p.z)


def result_to_array(result, aspect: float = 1.0, min_pose_visibility: float = 0.5) -> np.ndarray:
    """One HolisticLandmarkerResult -> (75, 3) array with NaN for missing parts."""
    out = np.full((N_POINTS, 3), np.nan, dtype=np.float32)
    if result.pose_landmarks:
        _fill(out, 0, result.pose_landmarks, aspect, min_pose_visibility)
    if result.left_hand_landmarks:
        _fill(out, LEFT_HAND, result.left_hand_landmarks, aspect)
    if result.right_hand_landmarks:
        _fill(out, RIGHT_HAND, result.right_hand_landmarks, aspect)
    return out


def hand(frame: np.ndarray, side: str) -> np.ndarray:
    start = LEFT_HAND if side == "left" else RIGHT_HAND
    return frame[start : start + N_HAND]


def has_hand(frame: np.ndarray, side: str) -> bool:
    return not np.isnan(hand(frame, side)[WRIST, 0])


def mirror(seq: np.ndarray) -> np.ndarray:
    """Flip a (T, 75, 3) or (75, 3) sample left-right, as if signed with the other hand.

    Features are measured from the shoulder midpoint, so negating x is enough;
    the constant offset cancels out.
    """
    m = np.array(seq, copy=True)
    m[..., 0] = -m[..., 0]
    for a, b in POSE_PAIRS:
        m[..., [a, b], :] = m[..., [b, a], :]
    left = m[..., LEFT_HAND : LEFT_HAND + N_HAND, :].copy()
    m[..., LEFT_HAND : LEFT_HAND + N_HAND, :] = m[..., RIGHT_HAND : RIGHT_HAND + N_HAND, :]
    m[..., RIGHT_HAND : RIGHT_HAND + N_HAND, :] = left
    return m
