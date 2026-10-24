"""Motion detection tuning tool — standalone, stop duck.py before running this.

  On the Pi:           python3 run.py
  Laptop webcam:       python3 run.py --source 0 --show   (q quits)
  Override threshold:  python3 run.py --threshold 2000
  Override timeout:    python3 run.py --timeout 60

State changes are printed to stderr. No events are sent to the relay.
"""

from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))   # pi/ for shared/

from detect import MotionDetector, MOTION_PIXELS, IDLE_TIMEOUT_S   # noqa: E402
from shared.sources import open_source                              # noqa: E402


class Overlay:
    def __init__(self):
        import cv2
        self.cv2 = cv2

    def draw(self, frame, info: dict) -> bool:
        """Draw state label. Returns False if user pressed 'q'."""
        import cv2 as _cv2
        bgr = _cv2.cvtColor(frame, _cv2.COLOR_RGB2BGR)
        state = info["state"]
        idle_for = info["idle_for_s"]
        color = (0, 200, 0) if state == "IDLE" else (0, 80, 255)
        label = state
        if state == "ACTIVE" and idle_for is not None:
            remaining = max(0.0, info["timeout_s"] - idle_for)
            label = f"ACTIVE  idle-out in {remaining:.0f}s"
        self.cv2.putText(bgr, label, (10, 30), self.cv2.FONT_HERSHEY_SIMPLEX, 0.9, color, 2)
        self.cv2.imshow("duck motion", bgr)
        return (self.cv2.waitKey(1) & 0xFF) != ord("q")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--source", default="pi", help="'pi' (default), webcam index, or video path")
    ap.add_argument("--fps", type=float, default=30, help="target capture FPS (default 30)")
    ap.add_argument("--threshold", type=int, default=MOTION_PIXELS, help="changed-pixel threshold")
    ap.add_argument("--timeout", type=float, default=IDLE_TIMEOUT_S, help="idle timeout in seconds")
    ap.add_argument("--show", action="store_true", help="open debug window (laptop only)")
    ap.add_argument("--light", choices=["auto", "day", "night"], default="auto")
    ap.add_argument("--noir", action="store_true", help="NoIR camera: load IR tuning file")
    args = ap.parse_args()

    config = {"motion_pixels": args.threshold, "idle_timeout_s": args.timeout}
    detector = MotionDetector(config)
    cam = open_source(args.source, light=args.light, noir=args.noir)
    overlay = Overlay() if args.show else None

    print(f"# motion: source={args.source} threshold={args.threshold}px timeout={args.timeout}s",
          file=sys.stderr, flush=True)
    print("# state: IDLE", file=sys.stderr, flush=True)

    period = 1.0 / args.fps
    frames = 0
    t_report = time.monotonic()

    try:
        while True:
            t0 = time.monotonic()
            frame = cam.read()
            if frame is None:
                time.sleep(0.05)
                continue

            for action in detector.update(t0, frame):
                kind, value = action
                if kind == "state":
                    print(f"# state: {value}", file=sys.stderr, flush=True)

            if overlay and not overlay.draw(frame, detector.debug_info()):
                break

            frames += 1
            elapsed = time.monotonic() - t_report
            if elapsed >= 10:
                print(f"# {frames / elapsed:.1f} fps", file=sys.stderr, flush=True)
                frames, t_report = 0, time.monotonic()

            time.sleep(max(0.0, period - (time.monotonic() - t0)))

    except KeyboardInterrupt:
        pass
    finally:
        cam.close()
        if args.show:
            import cv2
            cv2.destroyAllWindows()
        print("# motion: stopped", file=sys.stderr, flush=True)


if __name__ == "__main__":
    main()
