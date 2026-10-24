"""Duck Daddy on the Pi: one program that owns the camera and talks to the relay.

  python3 duck.py                      everything, using pins/devices from pi/.env
  python3 duck.py --source 0           laptop webcam instead of the Pi camera (dev)
  python3 duck.py --preview            + live annotated view at http://<pi-ip>:8090 (dev)

What runs when:
  always        pressure sensor -> quack + `pat` event
                microphone -> doorbell/phone/alarm/... -> LED pattern + `sound` event
                relay link: settings in (dashboard), commands in (say / quack), events out
  at the desk   camera on: posture (`posture` events, sit-up prompts)
                           Sign to Duck (ASL word signs -> phrase + commands, spoken + `sign` event)
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
import time
from pathlib import Path

PI = Path(__file__).resolve().parent
sys.path.insert(0, str(PI))
sys.path.insert(0, str(PI / "posture"))   # pose.py and judge.py import each other by bare name
sys.path.insert(1, str(PI / "asl"))       # word signs: same bare-name imports

from judge import PostureJudge                              # noqa: E402
from sentry.watch import SentryWatch, UltrasonicMotion      # noqa: E402
from shared.config import load_env, pin                     # noqa: E402
from shared.presence import Presence                        # noqa: E402
from shared.sources import open_source                      # noqa: E402
from shared.uplink import Uplink                            # noqa: E402
from shared.voice import Voice                              # noqa: E402
from sounds.alerts import SoundAlerts                       # noqa: E402
from sounds.led import AlertLED                             # noqa: E402

# Schema defaults, used until the relay pushes the active user's settings.
DEFAULT_SETTINGS = {
    "volume": 70, "posture_message": "Sit up straight!", "sentry_message": "Who goes there?",
    "presence_message": "Welcome back!", "posture_severity": 50, "posture_delay_s": 5,
    "sentry_enabled": False, "quack_enabled": True, "sign_enabled": True, "sound_alerts_enabled": True,
}
IDLE_CAMERA_FPS = 3       # camera-only presence/sentry while away
ULTRASONIC_HZ = 10
STATUS_EVERY_S = 5        # one-line heartbeat so you can see it working


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
            elif a[0] == "command":
                self.on_sign_command(a[1])
            # ("camera", ...) from the sentry is ignored: the main loop decides when the camera runs

    def on_sign_command(self, name: str):
        # From pi/asl/phrases.json (start_focus, break, help, ...). The duck has no focus
        # timer yet, so they're logged; the `sign` event carries them to the dashboard too.
        log(f"sign command: {name}")

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

    # ── dev preview overlay ─────────────────────────────────────────────────
    @staticmethod
    def _overlay(presence, points, judge, watch, words, cam):
        green, red, white, amber = (0, 200, 0), (0, 0, 255), (255, 255, 255), (0, 190, 255)
        lines = [(f"{'AT DESK' if presence.present else 'AWAY'}   person: {'yes' if points else 'no'}",
                  green if points else white)]
        if presence.present:
            if judge.angle is None:
                lines.append(("posture: no pose", white))
            elif judge.limit is None:
                lines.append((f"posture: calibrating (bend {judge.angle:.0f}) - sit up tall", amber))
            else:
                slouch = judge.slouch_since is not None
                lines.append((f"posture: bend {judge.angle:.0f} / limit {judge.limit:.0f}  {'SLOUCH' if slouch else 'ok'}",
                              red if slouch else green))
            lines.append((f"sign to duck: {'on' if words else 'off'}", white))
        else:
            lines.append((f"sentry: {watch.state}", red if watch.looking else white))
        lux = "--" if cam.lux is None else f"{cam.lux:.0f}"
        lines.append((f"{'NIGHT' if cam.night else 'DAY'}  lux {lux}", white))
        return lines

    # ── main loop (camera + ultrasonic) ─────────────────────────────────────
    def run(self):
        args = self.args
        if self.uplink:
            self.uplink.start()
        if not args.no_mic:
            from sounds.listener import SoundListener
            SoundListener(self.on_sound, self.mic_device).start()

        from sentry.vision import MOTION_FRACTION, Motion, person_confidence
        words = None
        if not args.no_sign and Path(args.holistic_model).exists():
            # One Holistic pass gives the body (posture, presence, sentry) and both hands.
            from asl_engine import WordSignReader
            from asl_model import make_engine
            from holistic import HolisticDetector
            engine, model_path = make_engine()
            pose = HolisticDetector(args.holistic_model)
            words = WordSignReader(engine, self.settings)
            log(f"Sign to Duck: model {model_path or 'missing (get sign data + train in pi/asl)'}")
        else:
            if not args.no_sign:
                log(f"{args.holistic_model} missing (run get_models.sh): Sign to Duck off")
            from pose import PoseDetector
            pose = PoseDetector(args.pose_model)

        cam = open_source(args.source, light=args.light, noir=args.noir)
        judge, watch = PostureJudge(self.settings), SentryWatch(self.settings)
        presence, umotion = Presence(), UltrasonicMotion()
        cmotion = Motion() if self.wake == "camera" else None
        preview = None
        if args.preview:
            from shared.preview import PreviewServer
            preview = PreviewServer(args.preview_port)
        stat = {"t": time.monotonic(), "frames": 0, "pose": 0}

        def on_presence(ev, distance):
            nonlocal umotion
            if ev == "arrive":
                self.emit("presence", {"present": True, "distance_cm": None if distance is None else round(distance)})
                if self.settings.get("presence_message"):
                    self.voice.say(self.settings["presence_message"])
            else:
                self.act(judge.reset())
                if words:
                    self.act(words.finish())
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
                    points, body = pose.detect(rgb, now)   # body: Holistic frame (None with the pose model)
                    stat["frames"] += 1
                    stat["pose"] += points is not None
                    if not self.sonar:
                        ev = presence.update_seen(now, points is not None)
                        if ev:
                            on_presence(ev, None)
                    if presence.present:
                        self.act(judge.update(now, points))
                        if words:   # every frame: word signs are fast movements
                            self.act(words.update(now, body))
                    elif watch.looking:
                        self.act(watch.frame(now, person_confidence(points), cam.night))
                    elif sentry_on and cmotion and cmotion.fraction(rgb) >= MOTION_FRACTION:
                        self.act(watch.trigger(now, None, "camera"))
                    if preview:
                        preview.push(rgb, self._overlay(presence, points, judge, watch, words, cam))
                self.act(watch.tick(now))

                if now - stat["t"] >= STATUS_EVERY_S:
                    secs = now - stat["t"]
                    lux = "--" if cam.lux is None else f"{cam.lux:.0f}"
                    log(f"status: {'AT DESK' if presence.present else 'away'} · person in {stat['pose']}/{stat['frames']} frames "
                        f"· {stat['frames'] / secs:.1f} fps · camera {'on' if need_cam else 'off'} "
                        f"· {'night' if cam.night else 'day'} (lux {lux})"
                        + (f" · distance {distance:.0f} cm" if distance is not None else ""))
                    stat.update(t=now, frames=0, pose=0)

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
    ap.add_argument("--preview", action="store_true", help="live annotated view at http://<pi-ip>:8090 (dev only)")
    ap.add_argument("--preview-port", type=int, default=8090)
    ap.add_argument("--pose-model", default=str(PI / "posture" / "pose_landmarker_lite.task"))
    ap.add_argument("--holistic-model", default=str(PI / "models" / "holistic_landmarker.task"))
    args = ap.parse_args()
    Duck(args, load_env()).run()


if __name__ == "__main__":
    main()
