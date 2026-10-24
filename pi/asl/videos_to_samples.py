"""Turn video clips (one sign per clip) into training samples.

Useful for phone recordings of a fluent signer, or clips from a dataset such as
ASL Citizen (research licence) for the signs in phrases.json.

    python3 videos_to_samples.py clips/ --who maya
        clips/HELLO/*.mp4, clips/HELP/*.mov, ...  ->  data/HELLO/maya-<n>.npy
    python3 videos_to_samples.py --citizen ~/ASL_Citizen
        finds our signs in ASL Citizen's CSVs, for every sign with fewer than
        --per-sign samples in data/ (so it fills in what kaggle_to_samples.py
        couldn't)  ->  data/HELP/citizen<signer>-<clip>.npy

Each clip is run through MediaPipe Holistic and trimmed to the part where a
hand is above the rest line, the same rule run.py uses live, so samples
from video look like samples recorded live.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import cv2
import mediapipe as mp
import numpy as np
from mediapipe.tasks.python import BaseOptions, vision

from asl_engine import Config, trim_to_sign
from datasets import citizen_clips, safe_who
from landmarks import result_to_array

HERE = Path(__file__).resolve().parent

VIDEO_EXT = {".mp4", ".mov", ".avi", ".mkv", ".webm"}


def clip_to_frames(path, model):
    options = vision.HolisticLandmarkerOptions(
        base_options=BaseOptions(model_asset_path=model), running_mode=vision.RunningMode.VIDEO
    )
    cap = cv2.VideoCapture(str(path))
    fps = cap.get(cv2.CAP_PROP_FPS) or 30
    step = max(1, round(fps / 20))  # ~20 fps, close to the live loop
    frames, i = [], 0
    with vision.HolisticLandmarker.create_from_options(options) as lm:
        while True:
            ok, frame = cap.read()
            if not ok:
                break
            if i % step == 0:
                h, w = frame.shape[:2]
                image = mp.Image(image_format=mp.ImageFormat.SRGB, data=cv2.cvtColor(frame, cv2.COLOR_BGR2RGB))
                frames.append(result_to_array(lm.detect_for_video(image, int(i * 1000 / fps)), aspect=w / h))
            i += 1
    cap.release()
    return np.stack(frames) if frames else None


def save(seq, out: Path, cfg) -> int | None:
    seq = trim_to_sign(seq, cfg) if seq is not None else None
    if seq is None or len(seq) < 4:
        return None
    out.parent.mkdir(parents=True, exist_ok=True)
    np.save(out, seq.astype(np.float32))
    return len(seq)


def from_folders(args, cfg):
    for sign_dir in sorted(Path(args.clips).iterdir()):
        if not sign_dir.is_dir():
            continue
        gloss = sign_dir.name if sign_dir.name.startswith("_") else sign_dir.name.upper()
        for n, clip in enumerate(sorted(p for p in sign_dir.iterdir() if p.suffix.lower() in VIDEO_EXT)):
            frames = save(clip_to_frames(clip, args.model), Path(args.out) / gloss / f"{args.who}-{clip.stem}-{n:03d}.npy", cfg)
            print(f"{gloss}: {clip.name} -> {frames} frames" if frames else f"skip {clip}: no raised hands found")


def from_citizen(args, cfg):
    glosses = list(json.loads((HERE / "phrases.json").read_text())["signs"])
    clips, missing = citizen_clips(Path(args.citizen).expanduser(), glosses, args.per_sign)
    for gloss, picked in clips.items():
        have = len(list((Path(args.out) / gloss).glob("*.npy")))
        if have >= args.per_sign:
            print(f"{gloss}: already {have} samples, skipped")
            continue
        saved = 0
        for who, clip in picked[: args.per_sign - have]:
            out = Path(args.out) / gloss / f"{safe_who('citizen', who)}-{clip.stem}.npy"
            if out.exists() or save(clip_to_frames(clip, args.model), out, cfg):
                saved += 1
        print(f"{gloss}: {saved} samples from ASL Citizen")
    print(f"\nnot in ASL Citizen ({len(missing)}): {', '.join(missing) or 'none'}")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("clips", nargs="?", help="folder with one sub-folder per sign (HELLO/, HELP/, ...)")
    ap.add_argument("--citizen", metavar="DIR", help="unzipped ASL Citizen download, instead of clips/")
    ap.add_argument("--per-sign", type=int, default=15, help="--citizen: fill each sign up to this many samples")
    ap.add_argument("--who", default="video", help="signer name, used for by-signer testing")
    ap.add_argument("--model", default=str(HERE.parent / "models" / "holistic_landmarker.task"))
    ap.add_argument("--out", default=str(HERE / "data"))
    ap.add_argument("--rest-line", type=float, default=Config.rest_line)
    args = ap.parse_args()
    if not (args.clips or args.citizen):
        ap.error("give a clips/ folder or --citizen DIR")
    cfg = Config(rest_line=args.rest_line)
    from_citizen(args, cfg) if args.citizen else from_folders(args, cfg)


if __name__ == "__main__":
    main()
