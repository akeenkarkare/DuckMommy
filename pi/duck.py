"""Duck Daddy on the Pi: one program that owns the camera and talks to the relay.

  python3 duck.py                      everything, using pins/devices from pi/.env
  python3 duck.py --source 0           laptop webcam instead of the Pi camera (dev)

What runs when:
  always        pressure sensor -> quack + `pat` event
                microphone -> doorbell/phone/alarm/... -> LED pattern + `sound` event
                relay link: settings in (dashboard), commands in (say / quack), events out
  at the desk   camera on: posture (`posture` events, sit-up prompts)
                           Sign to Duck (ASL handshapes -> spoken text + `sign` event)
  away          camera off unless sentry is on: ultrasonic (or camera) motion ->
                person check -> `sentry` event + sentry message
  arrive/leave  from the ultrasonic distance (or the camera, if no ultrasonic) -> `presence` event

The voice is ElevenLabs via the relay's /tts proxy (cached; espeak fallback).
Night vision is automatic (shared/sources.py).
"""

from __future__ import annotations

import argparse
import json
import sys
import threading
import time
from pathlib import Path

PI = Path(__file__).resolve().parent
sys.path.insert(0, str(PI))
sys.path.insert(0, str(PI / "posture"))   # pose.py and judge.py import each other by bare name

from judge import PostureJudge                              # noqa: E402
from sentry.watch import SentryWatch, UltrasonicMotion      # noqa: E402
from shared.config import load_env, pin                     # noqa: E402
from shared.presence import Presence                        # noqa: E402
from shared.sources import open_source                      # noqa: E402
from shared.uplink import Uplink                            # noqa: E402
from shared.voice import Voice                              # noqa: E402
from sign.signs import SignClassifier, SignReader           # noqa: E402
from sounds.alerts import SoundAlerts                       # noqa: E402
from sounds.led import AlertLED                             # noqa: E402

# Schema defaults, used until the relay pushes the active user's settings.
DEFAULT_SETTINGS = {
    "volume": 70, "posture_message": "Sit up straight!", "sentry_message": "Who goes there?",
    "presence_message": "Welcome back!", "posture_severity": 50, "posture_delay_s": 5,
    "sentry_enabled": False, "quack_enabled": True, "sign_enabled": True, "sound_alerts_enabled": True,
}
DESK_FPS_SIGN_EVERY = 2   # run the hand model on every 2nd frame at the desk
IDLE_CAMERA_FPS = 3       # camera-only presence/sentry while away
ULTRASONIC_HZ = 10


def log(msg: str):
    print(f"# duck: {msg}", file=sys.stderr, flush=True)


class Duck:
    def __init__(self, args, env: dict):
        self.args = args
        self.settings = dict(DEFAULT_SETTINGS)
        relay, token = env.get("RELAY_URL"), env.get("DUCK_TOKEN")
        tts_url = None
        if relay:
            tts_url = relay.replace("wss://", "https://").replace("ws://", "http://").rstrip("/") + "/tts"
        self.voice = Voice(self.settings, tts_url, token)
        self.uplink = Uplink(relay, token, self.on_settings, self.on_command) if relay and token else None
        if not self.uplink:
            log("RELAY_URL/DUCK_TOKEN missing in pi/.env: running offline (events print only)")

        self.sonar = self.button = None
        trig, echo = pin(env, "ULTRASONIC_TRIG"), pin(env, "ULTRASONIC_ECHO")
        if trig is not None and echo is not None:
            from shared.ultrasonic import Ultrasonic
            self.sonar = Ultrasonic(trig, echo)
        self.wake = args.sentry_wake or ("ultrasonic" if self.sonar else "camera")

        press = pin(env, "PRESS_PIN")
        if press is not None:
            from gpiozero import Button
            active_high = env.get("PRESS_ACTIVE", "high").lower() != "low"
            self.button = Button(press, pull_up=None, active_state=active_high, bounce_time=0.05)
            self.button.when_pressed = self.on_press
            self.button.when_released = self.on_release
        self._pressed_at = None

        self.led = AlertLED(pin(env, "LED_PIN"))
        self.alerts = SoundAlerts(self.settings)
        self.mic_device = env.get("MIC_DEVICE") or "default"
        log(f"ultrasonic={'on' if self.sonar else 'off (camera presence)'} sentry wake={self.wake} "
            f"pressure={'pin ' + str(press) if press is not None else 'off'} led={'on' if self.led.led else 'log only'}")

    # ── relay ───────────────────────────────────────────────────────────────
    def on_settings(self, s: dict):
        self.settings.update(s)
        log(f"settings from dashboard: {json.dumps(s)}")
        self.voice.prefetch([self.settings.get(k) for k in ("posture_message", "sentry_message", "presence_message")])

    def on_command(self, c: dict):
        if c.get("type") == "say":
            self.voice.say(c.get("text", ""))
        elif c.get("type") == "quack":
            self.voice.quack()

    def emit(self, etype: str, value: dict):
        print(json.dumps({"type": etype, "value": value}), flush=True)
        if self.uplink:
            self.uplink.send_event(etype, value)

    def act(self, actions):
        for a in actions:
            if a[0] == "event":
                self.emit(a[1], a[2])
            elif a[0] == "speak":
                self.voice.say(a[1])
            elif a[0] == "led":
                self.led.show(a[1])
            # ("camera", ...) from the sentry is ignored: the main loop decides when the camera runs

    # ── pressure sensor (gpiozero callback thread) ──────────────────────────
    def on_press(self):
        self._pressed_at = time.monotonic()
        if self.settings.get("quack_enabled", True):
            self.voice.quack()

    def on_release(self):
        if self._pressed_at is not None:
            self.emit("pat", {"touch_ms": int((time.monotonic() - self._pressed_at) * 1000)})
            self._pressed_at = None

    # ── microphone (listener thread) ────────────────────────────────────────
    def on_sound(self, now: float, categories):
        self.act(self.alerts.update(now, categories, muted=self.voice.busy()))

    # ── main loop (camera + ultrasonic) ─────────────────────────────────────
    def run(self):
        args = self.args
        if self.uplink:
            self.uplink.start()
        if not args.no_mic:
            from sounds.listener import SoundListener
            SoundListener(self.on_sound, self.mic_device).start()

        from pose import PoseDetector
        from sentry.vision import MOTION_FRACTION, Motion, person_confidence
        pose = PoseDetector(args.pose_model)
        hands = None
        if not args.no_sign:
            if Path(args.hand_model).exists():
                from sign.hands import HandDetector
                hands = HandDetector(args.hand_model)
            else:
                log(f"{args.hand_model} missing (run get_models.sh): Sign to Duck off")
        classifier = SignClassifier()
        if hands:
            log(f"Sign to Duck: {classifier.mode}")

        cam = open_source(args.source, light=args.light, noir=args.noir)
        judge, watch, reader = PostureJudge(self.settings), SentryWatch(self.settings), SignReader(self.settings)
        presence, umotion = Presence(), UltrasonicMotion()
        cmotion = Motion() if self.wake == "camera" else None
        frame_i = 0

        def on_presence(ev, distance):
            nonlocal umotion
            if ev == "arrive":
                self.emit("presence", {"present": True, "distance_cm": None if distance is None else round(distance)})
                if self.settings.get("presence_message"):
                    self.voice.say(self.settings["presence_message"])
            else:
                self.act(judge.reset())
                self.act(reader.finish())
                self.emit("presence", {"present": False, "distance_cm": None if distance is None else round(distance)})
                umotion = UltrasonicMotion()   # learn the empty room fresh
            log(ev)

        log("running (Ctrl+C to stop)")
        try:
            while True:
                now = time.monotonic()
                distance = self.sonar.distance_cm() if self.sonar else None
                if self.sonar:
                    ev = presence.update_distance(now, distance)
                    if ev:
                        on_presence(ev, distance)

                sentry_on = not presence.present and self.settings.get("sentry_enabled", False)
                if sentry_on and self.wake == "ultrasonic" and umotion.update(distance):
                    self.act(watch.trigger(now, distance, "ultrasonic"))

                need_cam = (presence.present or watch.looking or not self.sonar
                            or (sentry_on and self.wake == "camera"))
                cam.start() if need_cam else cam.stop()
                rgb = cam.read() if need_cam else None

                if rgb is not None:
                    points, _ = pose.detect(rgb, now)
                    if not self.sonar:
                        ev = presence.update_seen(now, points is not None)
                        if ev:
                            on_presence(ev, None)
                    if presence.present:
                        self.act(judge.update(now, points))
                        if hands and frame_i % DESK_FPS_SIGN_EVERY == 0:
                            pts, side = hands.detect(rgb, now)
                            self.act(reader.update(now, classifier.classify(pts, side), pts is not None))
                    elif watch.looking:
                        self.act(watch.frame(now, person_confidence(points), cam.night))
                    elif sentry_on and cmotion and cmotion.fraction(rgb) >= MOTION_FRACTION:
                        self.act(watch.trigger(now, None, "camera"))
                    frame_i += 1
                self.act(watch.tick(now))

                if presence.present or watch.looking:
                    period = 1.0 / args.fps
                elif need_cam:
                    period = 1.0 / IDLE_CAMERA_FPS
                else:
                    period = 1.0 / ULTRASONIC_HZ
                time.sleep(max(0.0, period - (time.monotonic() - now)))
        except KeyboardInterrupt:
            pass
        finally:
            cam.close()
            pose.close()
            if hands:
                hands.close()
            for dev in (self.sonar, self.button, self.led):
                if dev:
                    dev.close()


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--source", default="pi", help="'pi' (default), webcam index, or video URL/file")
    ap.add_argument("--light", choices=["auto", "day", "night"], default="auto", help="night vision (default auto)")
    ap.add_argument("--noir", action="store_true", help="camera has no IR filter: load the NoIR tuning")
    ap.add_argument("--sentry-wake", choices=["ultrasonic", "camera"],
                    help="what wakes the sentry check (default: ultrasonic if wired, else camera)")
    ap.add_argument("--fps", type=float, default=10, help="frames analysed per second at the desk")
    ap.add_argument("--no-mic", action="store_true", help="turn off sound alerts")
    ap.add_argument("--no-sign", action="store_true", help="turn off Sign to Duck")
    ap.add_argument("--pose-model", default=str(PI / "posture" / "pose_landmarker_lite.task"))
    ap.add_argument("--hand-model", default=str(PI / "models" / "hand_landmarker.task"))
    args = ap.parse_args()
    Duck(args, load_env()).run()


if __name__ == "__main__":
    main()
