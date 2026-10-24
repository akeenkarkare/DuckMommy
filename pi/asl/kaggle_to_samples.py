"""Turn Google's Kaggle ASL landmarks (asl-signs) into training samples. Run on the laptop.

    python3 kaggle_to_samples.py ~/asl-signs --list        # which of our signs it has
    python3 kaggle_to_samples.py ~/asl-signs               # write them to data/
    python3 train.py

The dataset (Kaggle "Google - Isolated Sign Language Recognition", about 40 GB
zipped, needs a Kaggle account) is ~94k clips of 250 signs, already run through
MediaPipe Holistic, so no video processing: each clip's landmarks are copied
into our (75, 3) frame layout (face dropped), trimmed with the live rest-line
rule and saved as data/<GLOSS>/kaggle<participant>-<sequence>.npy.

It is a children's vocabulary (PopSign), so it covers about half of
phrases.json: HELP, STOP, START, FOCUS and other command signs aren't in it.
The end of the run lists what's missing; get those from ASL Citizen
(videos_to_samples.py --citizen) or record them with run.py.

Needs pandas + pyarrow (laptop only: pip install pandas pyarrow).
"""

from __future__ import annotations

import argparse
import csv
import json
from collections import defaultdict
from itertools import zip_longest
from pathlib import Path

import numpy as np

from asl_engine import Config, trim_to_sign
from datasets import match_glosses, safe_who
from landmarks import LEFT_HAND, N_POINTS, RIGHT_HAND

HERE = Path(__file__).resolve().parent
ROW_START = {"pose": 0, "left_hand": LEFT_HAND, "right_hand": RIGHT_HAND}   # "face" is dropped


def parquet_to_frames(path, aspect: float = 1.0) -> np.ndarray | None:
    """One clip's long-format landmarks (frame, type, landmark index, x, y, z per
    row) -> (T, 75, 3) float32, NaN where MediaPipe found nothing."""
    import pandas as pd

    df = pd.read_parquet(path)
    idx_col = "landmark_index" if "landmark_index" in df.columns else "landmark_idx"
    df = df[df["type"].isin(ROW_START)]
    if df.empty:
        return None
    frames = np.sort(df["frame"].unique())
    out = np.full((len(frames), N_POINTS, 3), np.nan, dtype=np.float32)
    rows = df["type"].map(ROW_START).to_numpy() + df[idx_col].to_numpy()
    out[np.searchsorted(frames, df["frame"].to_numpy()), rows] = df[["x", "y", "z"]].to_numpy(np.float32)
    out[..., 0] *= aspect   # same units as landmarks.py: x scaled by width / height
    return out


def pick_clips(rows, labels: set[str], per_sign: int) -> dict[str, list[dict]]:
    """Up to per_sign clips per label, taking one person at a time so the
    samples cover as many signers as possible."""
    by_label = defaultdict(lambda: defaultdict(list))
    for r in rows:
        if r["sign"] in labels:
            by_label[r["sign"]][r.get("participant_id", "")].append(r)
    picked = {}
    for label, people in by_label.items():
        rounds = zip_longest(*people.values())
        picked[label] = [r for rnd in rounds for r in rnd if r is not None][:per_sign]
    return picked


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("kaggle_dir", help="the unzipped asl-signs folder (train.csv, train_landmark_files/)")
    ap.add_argument("--out", default=str(HERE / "data"))
    ap.add_argument("--per-sign", type=int, default=15,
                    help="clips per sign; the DTW model compares against every one, so more = slower")
    ap.add_argument("--aspect", type=float, default=1.0,
                    help="width/height of the Kaggle videos, if known (x is scaled by it, like live)")
    ap.add_argument("--rest-line", type=float, default=Config.rest_line)
    ap.add_argument("--list", action="store_true", help="only show which of our signs the dataset has")
    args = ap.parse_args()

    root = Path(args.kaggle_dir).expanduser()
    with open(root / "train.csv", newline="") as f:
        rows = list(csv.DictReader(f))
    glosses = list(json.loads((HERE / "phrases.json").read_text())["signs"])
    found = match_glosses({r["sign"] for r in rows}, glosses)
    missing = [g for g in glosses if g not in found and not g.startswith("_")]
    print(f"{len(found)} of {len(glosses) - 1} signs are in the dataset:")
    print("  " + ", ".join(f"{g}" + ("" if found[g].lower() == g.lower() else f" ({found[g]})") for g in found))
    if args.list:
        print(f"missing ({len(missing)}): {', '.join(missing)}")
        return

    cfg = Config(rest_line=args.rest_line)
    picked = pick_clips(rows, set(found.values()), args.per_sign)
    for gloss, label in found.items():
        folder = Path(args.out) / gloss
        folder.mkdir(parents=True, exist_ok=True)
        saved = 0
        for r in picked.get(label, []):
            dest = folder / f"{safe_who('kaggle', r.get('participant_id', ''))}-{r.get('sequence_id', saved)}.npy"
            if dest.exists():
                saved += 1
                continue
            seq = parquet_to_frames(root / r["path"], args.aspect)
            seq = trim_to_sign(seq, cfg) if seq is not None else None
            if seq is None or len(seq) < 4:
                continue
            np.save(dest, seq)
            saved += 1
        print(f"{gloss}: {saved} samples")
    print(f"\nnot in the dataset ({len(missing)}): {', '.join(missing)}")
    print("next: python3 videos_to_samples.py --citizen <ASL Citizen folder>, then python3 train.py")


if __name__ == "__main__":
    main()
