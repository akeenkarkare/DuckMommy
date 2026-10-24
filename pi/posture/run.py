"""Posture loop: camera -> MediaPipe pose -> slouch judge -> speak + events.

  On the Pi:       python3 run.py
  Laptop webcam:   python3 run.py --source 0 --show
  Pi + tuning view on the laptop (run ../camera/view.sh there first):
                   python3 run.py --preview <laptop-ip>:5000

Events are printed as JSON lines in the relay's wire format, one per line:
  {"type": "event", "event": {"type": "posture", "value": {...}, "ts": ...}}
so the uplink client can forward them as-is.
"""

from __future__ import annotations

import argparse
import json
import math
import shutil
import socket
import subprocess
import sys
import time

from judge import PostureJudge, pick_side, threshold_deg

# Same defaults as the schema / fake duck until the relay pushes real settings.
DEFAULT_SETTINGS = {
    "posture_severity": 50,
    "posture_delay_s": 5,
    "posture_message": "Sit up straight!",
    "volume": 70,
}


# ── frame sources (all return RGB numpy arrays) ────────────────────────────
class PiCamera:
    def __init__(self, width=640, height=480):
        from picamera2 import Picamera2   # apt: python3-picamera2
        self.cam = Picamera2()
        # Picamera2 quirk: "BGR888" yields arrays in RGB order, which is what MediaPipe wants.
        self.cam.configure(self.cam.create_preview_configuration(
            main={"size": (width, height), "format": "BGR888"}))
        self.cam.start()

    def read(self):
        return self.cam.capture_array("main")

    def close(self):
        self.cam.stop()


class OpenCVCamera:
    """Laptop webcam (index) or a stream/file URL, for testing without the Pi."""

    def __init__(self, source):
        import cv2
        self.cv2 = cv2
        self.cap = cv2.VideoCapture(int(source) if str(source).isdigit() else source)
        if not self.cap.isOpened():
            raise SystemExit(f"cannot open video source {source!r}")

    def read(self):
        ok, bgr = self.cap.read()
        return self.cv2.cvtColor(bgr, self.cv2.COLOR_BGR2RGB) if ok else None

    def close(self):
        self.cap.release()


# ── reactions ──────────────────────────────────────────────────────────────
TTS = next((c for c in ("espeak-ng", "espeak", "say") if shutil.which(c)), None)
_speaking = None


def speak(text: str):
    """Non-blocking TTS with whatever's installed; never stalls the camera loop."""
    global _speaking
    print(f"# speak: {text}", file=sys.stderr)
    if not TTS or (_speaking and _speaking.poll() is None):
        return
    _speaking = subprocess.Popen([TTS, text], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def emit(etype: str, value: dict):
    msg = {"type": "event", "event": {"type": etype, "value": value, "ts": int(time.time() * 1000)}}
    print(json.dumps(msg), flush=True)


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

    def draw(self, rgb, points, judge: PostureJudge):
        cv2 = self.cv2
        img = cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)
        side = pick_side(points) if points else None
        if side:
            ear, sh, hip = side
            cv2.line(img, (int(sh.x), int(sh.y)), (int(ear.x), int(ear.y)), (0, 255, 255), 3)
            if hip is not None:   # torso line the neck is measured against
                cv2.line(img, (int(hip.x), int(hip.y)), (int(sh.x), int(sh.y)), (255, 128, 0), 3)
            else:                 # no hip: measured against vertical
                cv2.line(img, (int(sh.x), int(sh.y)), (int(sh.x), int(sh.y) - 120), (255, 255, 255), 1)
        limit = threshold_deg(judge.settings.get("posture_severity", 50))
        angle = "--" if judge.angle is None else f"{judge.angle:.0f}"
        state = "no pose" if judge.angle is None else ("SLOUCH" if judge.slouch_since is not None else "upright")
        color = (0, 0, 255) if state == "SLOUCH" else (0, 200, 0)
        mode = "vs torso" if judge.using_hip else "vs vertical (no hip)"
        cv2.putText(img, f"bend {angle} / limit {limit:.0f}  {state}", (10, 30),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.8, color, 2)
        cv2.putText(img, mode, (10, 60), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 1)
        if self.show:
            cv2.imshow("duck posture", img)
            if cv2.waitKey(1) & 0xFF == ord("q"):
                raise KeyboardInterrupt
        if self.sock:
            ok, jpg = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, 60])
            data = jpg.tobytes()
            for i in range(0, len(data), 1400):   # ffplay's mjpeg demuxer reassembles the byte stream
                self.sock.sendto(data[i:i + 1400], self.addr)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--source", default="pi", help="'pi' (default), webcam index, or video URL/file")
    ap.add_argument("--model", default="pose_landmarker_lite.task")
    ap.add_argument("--fps", type=float, default=10, help="max frames analysed per second")
    ap.add_argument("--show", action="store_true", help="debug window (laptop only)")
    ap.add_argument("--preview", metavar="HOST:PORT", help="send annotated MJPEG over UDP to ../camera/view.sh")
    ap.add_argument("--severity", type=int, help="override posture_severity (0-100)")
    ap.add_argument("--delay", type=int, help="override posture_delay_s")
    args = ap.parse_args()

    settings = dict(DEFAULT_SETTINGS)
    if args.severity is not None:
        settings["posture_severity"] = args.severity
    if args.delay is not None:
        settings["posture_delay_s"] = args.delay

    from pose import PoseDetector
    detector = PoseDetector(args.model)
    cam = PiCamera() if args.source == "pi" else OpenCVCamera(args.source)
    judge = PostureJudge(settings)
    overlay = Overlay(args.show, args.preview) if (args.show or args.preview) else None
    print(f"# posture running: source={args.source} tts={TTS or 'none (print only)'}", file=sys.stderr)

    period, frames, t_report = 1.0 / args.fps, 0, time.monotonic()
    try:
        while True:
            t0 = time.monotonic()
            rgb = cam.read()
            if rgb is None:
                time.sleep(0.1)
                continue
            points, _ = detector.detect(rgb, t0)
            for action in judge.update(t0, points):
                if action[0] == "event":
                    emit(action[1], action[2])
                elif action[0] == "speak":
                    speak(action[1])
            if overlay:
                overlay.draw(rgb, points, judge)

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
