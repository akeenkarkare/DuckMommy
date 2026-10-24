"""Sentry loop: ultrasonic motion -> camera wakes -> pose detector confirms a person.

  On the Pi (ultrasonic on BCM pins, e.g. TRIG=23 ECHO=24):
      python3 run.py --trig 23 --echo 24
  Camera-only (no ultrasonic wired yet; OpenCV motion detection wakes the check):
      python3 run.py --no-ultrasonic
  Annotated view on the laptop (run ../camera/view.sh there first):
      python3 run.py --no-ultrasonic --preview <laptop-ip>:5000
  Laptop webcam, no Pi:
      python3 run.py --source 0 --no-ultrasonic --show

Night vision is automatic (--light auto): IR LEDs light the room and the
camera switches to night settings when it gets dark. See ../shared/sources.py.

Events are printed as JSON lines in the relay's wire format, like posture/run.py.
"""

from __future__ import annotations

import argparse
import socket
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))           # pi/ for shared/
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "posture"))  # pose.py

from shared.out import TTS, emit, speak          # noqa: E402
from shared.sources import log, open_source      # noqa: E402
from vision import MOTION_FRACTION, Motion, person_confidence  # noqa: E402
from watch import SentryWatch, UltrasonicMotion  # noqa: E402

DEFAULT_SETTINGS = {"sentry_enabled": True, "sentry_message": "Who goes there?"}

ULTRASONIC_HZ = 10
MOTION_FPS = 3            # camera-only mode: how often to check for motion while idle
class Preview:
    """Annotated frames to a window or to ../camera/view.sh. Tuning only."""

    def __init__(self, show: bool, preview: str | None):
        import cv2
        self.cv2, self.show = cv2, show
        self.sock = self.addr = None
        if preview:
            host, port = preview.rsplit(":", 1)
            self.sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            self.addr = (host, int(port))

    def draw(self, rgb, watch: SentryWatch, conf, cam, distance, baseline, motion):
        cv2 = self.cv2
        img = cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)
        mode = "NIGHT" if cam.night else "DAY"
        lux = "--" if cam.lux is None else f"{cam.lux:.1f}"
        person = "--" if conf is None else f"{conf:.2f}"
        color = (0, 0, 255) if conf is not None and conf >= 0.5 else (0, 200, 0)
        cv2.putText(img, f"{watch.state.upper()}  person {person}", (10, 30), cv2.FONT_HERSHEY_SIMPLEX, 0.8, color, 2)
        dist = "--" if distance is None else f"{distance:.0f}"
        base = "--" if baseline is None else f"{baseline:.0f}"
        cv2.putText(img, f"{mode} lux {lux}  dist {dist}/{base} cm  motion {motion:.3f}",
                    (10, 60), cv2.FONT_HERSHEY_SIMPLEX, 0.55, (255, 255, 255), 1)
        if self.show:
            cv2.imshow("duck sentry", img)
            if cv2.waitKey(1) & 0xFF == ord("q"):
                raise KeyboardInterrupt
        if self.sock:
            ok, jpg = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, 60])
            data = jpg.tobytes()
            for i in range(0, len(data), 1400):
                self.sock.sendto(data[i:i + 1400], self.addr)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--source", default="pi", help="'pi' (default), webcam index, or video URL/file")
    ap.add_argument("--model", default=str(Path(__file__).resolve().parent.parent / "posture" / "pose_landmarker_lite.task"))
    ap.add_argument("--light", choices=["auto", "day", "night"], default="auto", help="night vision mode (default auto)")
    ap.add_argument("--noir", action="store_true", help="camera has no IR filter: load the sensor's NoIR tuning")
    ap.add_argument("--trig", type=int, help="ultrasonic TRIG pin (BCM number)")
    ap.add_argument("--echo", type=int, help="ultrasonic ECHO pin (BCM number, via a voltage divider)")
    ap.add_argument("--no-ultrasonic", action="store_true", help="wake on camera motion instead (camera stays on at low fps)")
    ap.add_argument("--fps", type=float, default=10, help="frames analysed per second while looking")
    ap.add_argument("--show", action="store_true", help="debug window (laptop only)")
    ap.add_argument("--preview", metavar="HOST:PORT", help="send annotated MJPEG over UDP to ../camera/view.sh")
    ap.add_argument("--message", help="override sentry_message")
    args = ap.parse_args()
    if not args.no_ultrasonic and (args.trig is None or args.echo is None):
        ap.error("pass --trig and --echo (BCM pins), or --no-ultrasonic")

    settings = dict(DEFAULT_SETTINGS)
    if args.message is not None:
        settings["sentry_message"] = args.message

    from pose import PoseDetector
    detector = PoseDetector(args.model)
    cam = open_source(args.source, light=args.light, noir=args.noir)
    watch = SentryWatch(settings)
    preview = Preview(args.show, args.preview) if (args.show or args.preview) else None

    sonar = motion_us = motion_cam = None
    if args.no_ultrasonic:
        motion_cam = Motion()               # camera must stay on to watch for motion
    else:
        from shared.ultrasonic import Ultrasonic
        sonar, motion_us = Ultrasonic(args.trig, args.echo), UltrasonicMotion()
        cam.stop()                          # camera sleeps until the ultrasonic sees something
    log(f"sentry running: source={args.source} light={args.light} "
        f"wake={'camera motion' if args.no_ultrasonic else f'ultrasonic TRIG={args.trig} ECHO={args.echo}'} "
        f"tts={TTS or 'none (print only)'}")

    def act(actions):
        for a in actions:
            if a[0] == "event":
                emit(a[1], a[2])
            elif a[0] == "speak":
                speak(a[1])
            elif a[0] == "camera" and sonar:   # camera-only mode keeps it running
                cam.start() if a[1] == "on" else cam.stop()

    distance = None
    try:
        while True:
            t0 = time.monotonic()
            frac = 0.0

            if sonar:
                distance = sonar.distance_cm()
                if motion_us.update(distance):
                    act(watch.trigger(t0, distance, "ultrasonic"))

            rgb = cam.read() if (watch.looking or motion_cam) else None
            conf = None
            if rgb is not None:
                if watch.looking:
                    points, _ = detector.detect(rgb, t0)
                    conf = person_confidence(points)
                    act(watch.frame(t0, conf, cam.night))
                elif motion_cam:
                    frac = motion_cam.fraction(rgb)
                    if frac >= MOTION_FRACTION:
                        act(watch.trigger(t0, None, "camera"))
                if preview:
                    preview.draw(rgb, watch, conf, cam, distance, motion_us.baseline if motion_us else None, frac)
            act(watch.tick(t0))

            if watch.looking:
                period = 1.0 / args.fps
            elif motion_cam:
                period = 1.0 / MOTION_FPS
            else:
                period = 1.0 / ULTRASONIC_HZ
            time.sleep(max(0.0, period - (time.monotonic() - t0)))
    except KeyboardInterrupt:
        pass
    finally:
        cam.close()
        detector.close()
        if sonar:
            sonar.close()


if __name__ == "__main__":
    main()
