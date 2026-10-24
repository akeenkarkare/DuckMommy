"""Raw landmark sequence (T, 75, 3) -> fixed-size feature matrix (FRAMES, N_FEATURES).

What the classifier sees for each frame, all measured in the signer's own body
units (origin = middle of the shoulders, 1 unit = shoulder width), so it does
not matter where the person sits or how far they are from the camera:

    upper body   nose, elbows and pose wrists, x/y                     10 values
    each hand    present flag                                           1
                 hand position (its wrist), x/y                         2
                 hand shape: 20 joints relative to the wrist, x/y/z,
                 divided by the hand's own size                        60
                 hand speed, x/y                                        2
                                                                      ---
                                                        10 + 2 * 65 = 140

Each group gets a weight so that hand position, hand shape and movement all
count; tune WEIGHTS with train.py (it prints cross-validated accuracy).
"""

from __future__ import annotations

import numpy as np

from landmarks import (
    LEFT_ELBOW, LEFT_HAND, LEFT_SHOULDER, LEFT_WRIST, MIDDLE_MCP, N_HAND, NOSE,
    RIGHT_ELBOW, RIGHT_HAND, RIGHT_SHOULDER, RIGHT_WRIST, WRIST,
)

FRAMES = 24  # every sign is stretched or squeezed to this many frames
BODY_POINTS = [NOSE, LEFT_ELBOW, RIGHT_ELBOW, LEFT_WRIST, RIGHT_WRIST]
N_FEATURES = 2 * len(BODY_POINTS) + 2 * (1 + 2 + 60 + 2)
MAX_GAP = 4  # hand dropouts up to this many frames are filled in (motion blur)

WEIGHTS = {
    "body": 0.5,
    "present": 1.5,
    "position": 2.0,
    "shape": 0.35,  # 60 numbers, so each one counts for less
    "speed": 4.0,  # per-frame speeds are small numbers
}


def body_frame(seq: np.ndarray):
    """Shoulder midpoint and shoulder width, as medians over the whole sign."""
    ls, rs = seq[:, LEFT_SHOULDER, :2], seq[:, RIGHT_SHOULDER, :2]
    ok = ~(np.isnan(ls[:, 0]) | np.isnan(rs[:, 0]))
    if not ok.any():
        return None
    center = np.median((ls[ok] + rs[ok]) / 2, axis=0)
    width = float(np.median(np.linalg.norm(ls[ok] - rs[ok], axis=1)))
    if width < 1e-3:
        return None
    return center, width


def _fill_short_gaps(hand_seq: np.ndarray) -> np.ndarray:
    """Linearly fill runs of missing frames no longer than MAX_GAP."""
    out = hand_seq.copy()
    present = ~np.isnan(out[:, WRIST, 0])
    idx = np.flatnonzero(present)
    for a, b in zip(idx[:-1], idx[1:]):
        if 1 < b - a <= MAX_GAP + 1:
            for t in range(a + 1, b):
                w = (t - a) / (b - a)
                out[t] = (1 - w) * out[a] + w * out[b]
    return out


def resample(x: np.ndarray, frames: int = FRAMES) -> np.ndarray:
    """Linear time resampling of a (T, ...) array to (frames, ...)."""
    t = len(x)
    if t == frames:
        return x.copy()
    pos = np.linspace(0, t - 1, frames)
    lo = np.floor(pos).astype(int)
    hi = np.minimum(lo + 1, t - 1)
    w = (pos - lo).reshape((-1,) + (1,) * (x.ndim - 1))
    return (1 - w) * x[lo] + w * x[hi]


def _hand_features(hand_seq, center, width):
    """(T, 21, 3) hand points -> (T, 1 + 2 + 60) present / position / shape."""
    t = len(hand_seq)
    present = ~np.isnan(hand_seq[:, WRIST, 0])
    out = np.zeros((t, 63), dtype=np.float32)
    if not present.any():
        return out, present
    h = hand_seq[present]
    wrist = h[:, WRIST]
    size = np.linalg.norm(h[:, MIDDLE_MCP, :2] - wrist[:, :2], axis=1, keepdims=True)
    size = np.maximum(size, 1e-4)
    out[present, 0] = 1.0
    out[present, 1:3] = (wrist[:, :2] - center) / width
    shape = (h[:, 1:] - wrist[:, None, :]) / size[:, :, None]
    out[present, 3:] = shape.reshape(len(h), -1)
    return out, present


def sequence_features(seq: np.ndarray, frames: int = FRAMES):
    """(T, 75, 3) raw sample -> (frames, N_FEATURES) float32, or None if unusable."""
    seq = np.asarray(seq, dtype=np.float32)
    if seq.ndim != 3 or len(seq) < 2:
        return None
    frame = body_frame(seq)
    if frame is None:
        return None
    center, width = frame

    body = (seq[:, BODY_POINTS, :2] - center) / width
    body = np.nan_to_num(body.reshape(len(seq), -1)) * WEIGHTS["body"]

    parts = [body]
    for start in (LEFT_HAND, RIGHT_HAND):
        hand_seq = _fill_short_gaps(seq[:, start : start + N_HAND])
        f, _ = _hand_features(hand_seq, center, width)
        parts.append(f)
    per_frame = np.concatenate(parts, axis=1)
    per_frame = resample(per_frame, frames)

    # Speeds are taken after resampling, so fast and slow signers look alike.
    out = []
    out.append(per_frame[:, : body.shape[1]])
    off = body.shape[1]
    for _ in range(2):
        f = per_frame[:, off : off + 63]
        speed = np.vstack([np.zeros((1, 2)), np.diff(f[:, 1:3], axis=0)])
        speed[f[:, 0] < 0.5] = 0.0  # no speed for frames where the hand is missing
        out += [
            f[:, 0:1] * WEIGHTS["present"],
            f[:, 1:3] * WEIGHTS["position"],
            f[:, 3:] * WEIGHTS["shape"],
            speed * WEIGHTS["speed"],
        ]
        off += 63
    return np.concatenate(out, axis=1).astype(np.float32)
