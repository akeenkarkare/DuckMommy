"""Record a sign so Sign to Duck can recognise it.

  python3 record.py hello            hold the sign in front of the camera
  python3 record.py A --samples 60   letters work too (one char = fingerspelling)
  python3 record.py --list           what's recorded
  python3 record.py --delete hello

Samples go in signs.json. Once any sign is recorded, recorded signs replace the
built-in rules, so record every sign you want (hello, I love you, ...).
Move your hand a little while recording (angle, distance) so it generalises.
Stop duck.py first (only one process can use the camera).
"""

from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from shared.sources import open_source                 # noqa: E402
from signs import features, load_samples, save_samples  # noqa: E402


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("label", nargs="?", help="what the sign means (one letter = fingerspelling)")
    ap.add_argument("--samples", type=int, default=40)
    ap.add_argument("--source", default="pi", help="'pi' (default), webcam index, or video URL/file")
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--delete", metavar="LABEL")
    args = ap.parse_args()

    samples = load_samples()
    if args.list:
        for label, vecs in sorted(samples.items()):
            print(f"{label!r}: {len(vecs)} samples")
        return
    if args.delete:
        samples.pop(args.delete, None)
        save_samples(samples)
        print(f"deleted {args.delete!r}")
        return
    if not args.label:
        ap.error("give a label, or --list / --delete")

    from hands import HandDetector
    detector = HandDetector()
    cam = open_source(args.source)
    got: list[list[float]] = []
    print(f"Hold the sign for {args.label!r}. Starting in 3 s…")
    time.sleep(3)
    try:
        while len(got) < args.samples:
            rgb = cam.read()
            if rgb is None:
                continue
            pts, side = detector.detect(rgb, time.monotonic())
            if pts is not None:
                got.append([round(v, 4) for v in features(pts, side)])
                print(f"\r{len(got)}/{args.samples}", end="", flush=True)
            time.sleep(0.1)
    finally:
        cam.close()
        detector.close()
    samples.setdefault(args.label, []).extend(got)
    save_samples(samples)
    print(f"\nsaved {len(got)} samples for {args.label!r} ({len(samples[args.label])} total)")


if __name__ == "__main__":
    main()
