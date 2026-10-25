"""Word signs on their own: tune the camera and record training samples.

duck.py runs this live. This tool is for setting it up:

  Tune:   python3 run.py --preview <laptop-ip>:5000   (run ../camera/view.sh on the laptop first)
  Record: python3 run.py --record HELLO --n 15 --who sara
          sign once, drop your hands below the rest line, repeat; stops after --n
          python3 run.py --record _other --n 20 --who sara   (NOT signs: scratch, drink, type)
  Train:  python3 train.py
  Laptop: python3 run.py --source 0 --show   (q quits, x clears pending signs)

The overlay shows both hands, the orange rest line (hands below it are resting)
and every guess with its top 3 alternatives. Stop duck.py first: only one
process can use the camera.
"""

from __future__ import annotations

import argparse
import socket
import sys
import time
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))                 # pi/ for shared/
sys.path.insert(1, str(HERE.parent / "posture"))     # judge.py, pose.py (used by holistic.py)

from asl_engine import AslEngine, Config, WordSignReader   # noqa: E402
from asl_model import make_engine, save_sample             # noqa: E402
from landmarks import LEFT_HAND, N_HAND, RIGHT_HAND        # noqa: E402
from shared.out import TTS, emit, speak                    # noqa: E402
from shared.sources import open_source                     # noqa: E402

# ── debug overlay (tuning only; video never goes to the relay) ─────────────
class Overlay:
    def __init__(self, show: bool, preview: str | None):
        import cv2
        self.cv2, self.show = cv2, show
        self.sock = self.addr = None
        if preview:
            host, port = preview.rsplit(":", 1)
            self.sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            self.addr = (host, int(port))

    def draw(self, rgb, frame, engine: AslEngine, snap: dict):
        cv2 = self.cv2
        img = cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)
        h, w = img.shape[:2]
        aspect = w / h
        if frame is not None:
            for start in (LEFT_HAND, RIGHT_HAND):
                pts = frame[start:start + N_HAND]
                if not np.isnan(pts[0, 0]):
                    for p in pts:   # x was scaled by width/height in landmarks.py
                        cv2.circle(img, (int(p[0] / aspect * w), int(p[1] * h)), 3, (0, 200, 255), -1)
        seg = engine.segmenter
        if seg.shoulder_y is not None:
            y = int((seg.shoulder_y + engine.cfg.rest_line * seg.shoulder_w) * h)
            cv2.line(img, (0, y), (w, y), (0, 160, 255), 1)
            cv2.putText(img, "rest line", (8, y - 6), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 160, 255), 1)

        status = snap["status"].upper()
        if snap["recording"]:
            r = snap["recording"]
            status = f"RECORDING {r['gloss']} {r['done']}/{r['target']}"
        color = {"signing": (60, 200, 60), "recording": (40, 40, 230)}.get(snap["status"], (200, 200, 200))
        lines = [(status, color)]
        if snap["last_guess"]:
            g = snap["last_guess"]
            alts = "  ".join(f"{label} {score:.2f}" for label, score in g["alternatives"])
            lines.append(("last: " + (g["label"] or f"? ({g['raw_label']})") + f"  [{alts}]", (255, 255, 255)))
        if snap["pending"]:
            lines.append(("signs: " + " ".join(snap["pending"]), (255, 255, 0)))
        if snap["phrase"]:
            lines.append(('said: "' + snap["phrase"]["text"] + '"', (60, 220, 60)))
        if not snap["model_loaded"] and not snap["recording"]:
            lines.append(("no model yet: --record, then train.py", (0, 0, 255)))
        for i, (text, c) in enumerate(lines):
            cv2.putText(img, text, (10, 30 + 26 * i), cv2.FONT_HERSHEY_SIMPLEX, 0.7 if i == 0 else 0.6, c, 2)

        if self.show:
            cv2.imshow("duck word signs", img)
            key = cv2.waitKey(1) & 0xFF
            if key == ord("q"):
                raise KeyboardInterrupt
            if key == ord("x"):
                engine.clear()
        if self.sock:
            ok, jpg = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, 60])
            data = jpg.tobytes()
            for i in range(0, len(data), 1400):   # ffplay's mjpeg demuxer reassembles the byte stream
                self.sock.sendto(data[i:i + 1400], self.addr)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--source", default="pi", help="'pi' (default), webcam index, or video URL/file")
    ap.add_argument("--model", default=str(HERE.parent / "models" / "holistic_landmarker.task"))
    ap.add_argument("--asl-model", help="trained sign model (default: models/asl_templates.npz)")
    ap.add_argument("--fps", type=float, default=15, help="max frames analysed per second (signs are fast)")
    ap.add_argument("--rest-line", type=float, default=Config.rest_line,
                    help="shoulder widths below the shoulders; hands below it are resting")
    ap.add_argument("--phrase-gap", type=float, default=0.7,
                    help="seconds of no signing before the phrase is spoken (duck.py uses 1.6 for 2-sign phrases)")
    ap.add_argument("--record", metavar="GLOSS", help="save the next --n signs as samples of GLOSS")
    ap.add_argument("--n", type=int, default=15)
    ap.add_argument("--who", default="anon", help="signer name, so train.py can test on unseen signers")
    ap.add_argument("--show", action="store_true", help="debug window (laptop only)")
    ap.add_argument("--preview", metavar="HOST:PORT", help="send annotated MJPEG over UDP to ../camera/view.sh")
    ap.add_argument("--light", choices=["auto", "day", "night"], default="auto", help="Pi camera night vision mode (default auto)")
    ap.add_argument("--noir", action="store_true", help="Pi camera has no IR filter: load the sensor's NoIR tuning")
    args = ap.parse_args()

    engine, model_path = make_engine(args.rest_line, args.asl_model, on_sample=save_sample)
    engine.cfg.phrase_gap_seconds = args.phrase_gap
    if args.record:
        gloss = args.record if args.record.startswith("_") else args.record.upper()
        engine.start_recording(gloss, args.n, args.who.lower())
        print(f"# recording {args.n} x {gloss}: sign once, drop your hands, repeat", file=sys.stderr)
    reader = WordSignReader(engine, {"sign_enabled": True})

    from holistic import HolisticDetector
    detector = HolisticDetector(args.model)
    cam = open_source(args.source, light=args.light, noir=args.noir)
    overlay = Overlay(args.show, args.preview) if (args.show or args.preview) else None
    print(f"# word signs running: source={args.source} model={model_path or 'none yet'} "
          f"tts={TTS or 'none (print only)'}", file=sys.stderr)

    period, frames, t_report = 1.0 / args.fps, 0, time.monotonic()
    try:
        while True:
            t0 = time.monotonic()
            rgb = cam.read()
            if rgb is None:
                time.sleep(0.1)
                continue
            _, frame = detector.detect(rgb, t0)
            for action in reader.update(t0, frame):
                if action[0] == "event":
                    emit(action[1], action[2])
                elif action[0] == "speak":
                    speak(action[1])
                elif action[0] == "command":
                    print(f"# command: {action[1]}", file=sys.stderr)
            snap = engine.snapshot()
            if overlay:
                overlay.draw(rgb, frame, engine, snap)
            if args.record and snap["recording"] is None:
                print(f"# done: {args.n} samples of {gloss} in data/. Next sign, or python3 train.py",
                      file=sys.stderr)
                break

            frames += 1
            if t0 - t_report >= 10:
                print(f"# {frames / (t0 - t_report):.1f} fps analysed", file=sys.stderr)
                frames, t_report = 0, t0
            time.sleep(max(0.0, period - (time.monotonic() - t0)))
    except KeyboardInterrupt:
        pass
    finally:
        cam.close()
        detector.close()


if __name__ == "__main__":
    main()
