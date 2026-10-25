"""Frame sources with one interface: start(), stop(), read() -> RGB array or None, close().

PiCamera handles night vision. A NoIR camera (no infrared filter) sees infrared light, but the
Pi Camera Module 3 NoIR has NO IR LEDs of its own: in a dark room it needs an 850 nm IR
illuminator next to it (invisible to people, bright to the camera). Software makes the most of
whatever light there is:

  day    30 fps, colour, normal denoise
  night  8-30 fps (auto exposure may stretch frames to 125 ms and uses the long exposure mode,
         +1 EV), black & white (IR has no colour, only a pink cast + chroma noise),
         high-quality denoise
  auto   (default) switches using libcamera's per-frame Lux estimate, with
         hysteresis and a hold time so it can't flicker. Right after the
         camera wakes (sentry), it decides at once from the first settled frame.

Only one process can own the Pi camera at a time.
"""

from __future__ import annotations

import sys
import threading
import time

# auto mode: stay below DARK_LUX for HOLD_S -> night; above BRIGHT_LUX for HOLD_S -> day.
# Lux is libcamera's estimate. Tune on the real duck: run with --show/--preview, which print it.
DARK_LUX = 8.0
BRIGHT_LUX = 25.0
HOLD_S = 5.0
SETTLE_S = 0.5      # after the camera wakes, decide day/night from the first settled frame


def log(msg: str):
    print(f"# {msg}", file=sys.stderr, flush=True)


def _exposure_mode(lc, name: str) -> dict:
    mode = getattr(getattr(lc, "AeExposureModeEnum", None), name, None)
    return {"AeExposureMode": mode} if mode is not None else {}


def _day_controls(lc):
    return {
        "FrameDurationLimits": (33333, 33333),
        "Saturation": 1.0,
        "NoiseReductionMode": lc.draft.NoiseReductionModeEnum.Fast,
        "ExposureValue": 0.0,
        **_exposure_mode(lc, "Normal"),
    }


def _night_controls(lc):
    # Longer frames = more light per frame. 125 ms keeps ~8 fps, enough for presence, sentry
    # and posture (signs get worse in the dark anyway).
    return {
        "FrameDurationLimits": (33333, 125000),
        "Saturation": 0.0,
        "NoiseReductionMode": lc.draft.NoiseReductionModeEnum.HighQuality,
        "ExposureValue": 1.0,
        **_exposure_mode(lc, "Long"),
    }


def _noir_tuning(Picamera2):
    """No-IR-filter sensors look pink in daylight without their NoIR tuning file."""
    model = Picamera2.global_camera_info()[0]["Model"]
    if "noir" in model:
        return None   # libcamera already picked the NoIR tuning
    try:
        tuning = Picamera2.load_tuning_file(f"{model}_noir.json")
        log(f"using NoIR tuning for {model}")
        return tuning
    except (RuntimeError, FileNotFoundError):
        log(f"no NoIR tuning file for {model}, using the default")
        return None


class PiCamera:
    def __init__(self, width=640, height=480, light="auto", noir=False):
        from picamera2 import Picamera2   # apt: python3-picamera2
        from libcamera import controls as lc
        if light not in ("auto", "day", "night"):
            raise ValueError(f"light must be auto/day/night, not {light!r}")
        self._lc = lc
        self.light = light
        self.night = light == "night"
        self.lux: float | None = None
        self._dark_since = self._bright_since = None
        self._fresh = False

        self.cam = Picamera2(tuning=_noir_tuning(Picamera2) if noir else None)
        self._supported = self.cam.camera_controls
        # Picamera2 quirk: "BGR888" yields arrays in RGB order, which is what MediaPipe wants.
        self.cam.configure(self.cam.create_preview_configuration(
            main={"size": (width, height), "format": "BGR888"},
            controls=self._controls(self.night)))
        self.running = False
        self.started_at = 0.0
        self.start()

    def _controls(self, night: bool) -> dict:
        wanted = _night_controls(self._lc) if night else _day_controls(self._lc)
        for name in [k for k in wanted if k not in self._supported]:
            log(f"camera ignores {name} (not supported by this sensor)")
            del wanted[name]
        return wanted

    def start(self):
        if not self.running:
            self.cam.start()
            self.running, self.started_at = True, time.monotonic()
            self._fresh = True

    def stop(self):
        if self.running:
            self.cam.stop()
            self.running = False

    def read(self):
        if not self.running:
            return None
        request = self.cam.capture_request()
        try:
            frame = request.make_array("main")
            metadata = request.get_metadata()
        finally:
            request.release()
        self.lux = metadata.get("Lux")
        if self.light == "auto" and self.lux is not None:
            self._auto(self.lux, time.monotonic())
        return frame

    def _auto(self, lux: float, now: float):
        if self._fresh:
            if now - self.started_at < SETTLE_S:
                return
            self._fresh = False
            if (lux < DARK_LUX) != self.night and (lux < DARK_LUX or lux > BRIGHT_LUX):
                self._set_night(lux < DARK_LUX, lux)
            return
        if not self.night:
            self._dark_since = (self._dark_since or now) if lux < DARK_LUX else None
            if self._dark_since is not None and now - self._dark_since >= HOLD_S:
                self._set_night(True, lux)
        else:
            self._bright_since = (self._bright_since or now) if lux > BRIGHT_LUX else None
            if self._bright_since is not None and now - self._bright_since >= HOLD_S:
                self._set_night(False, lux)

    def _set_night(self, night: bool, lux: float):
        self.cam.set_controls(self._controls(night))
        self.night = night
        self._dark_since = self._bright_since = None
        log(f"{'night' if night else 'day'} mode (lux {lux:.1f})")

    def close(self):
        self.stop()
        self.cam.close()


class OpenCVCamera:
    """Laptop webcam (index) or a stream/file URL, for testing without the Pi."""

    night = False
    lux = None
    started_at = 0.0

    def __init__(self, source):
        import cv2
        self.cv2 = cv2
        self.cap = cv2.VideoCapture(int(source) if str(source).isdigit() else source)
        if not self.cap.isOpened():
            raise SystemExit(f"cannot open video source {source!r}")
        self.running = True
        # Webcams queue frames while the caller is busy (Holistic is slower than
        # 30 fps), so reading in the loop falls further and further behind.
        # A thread keeps only the newest frame. Files are read in order instead.
        self.live = str(source).isdigit()
        self.latest, self.lock, self.closed = None, threading.Lock(), False
        if self.live:
            threading.Thread(target=self._grab, daemon=True).start()

    def _grab(self):
        while not self.closed:
            ok, bgr = self.cap.read()
            if not ok:
                time.sleep(0.01)
                continue
            with self.lock:
                self.latest = bgr

    def start(self):
        self.running = True

    def stop(self):
        self.running = False   # keep the device open; webcams are slow to reopen

    def read(self):
        if not self.running:
            return None
        if self.live:
            with self.lock:
                bgr, self.latest = self.latest, None
            if bgr is None:
                time.sleep(0.005)
                return None
            return self.cv2.cvtColor(bgr, self.cv2.COLOR_BGR2RGB)
        ok, bgr = self.cap.read()
        return self.cv2.cvtColor(bgr, self.cv2.COLOR_BGR2RGB) if ok else None

    def close(self):
        self.closed = True
        time.sleep(0.05)
        self.cap.release()


def open_source(source: str, light: str = "auto", noir: bool = False):
    return PiCamera(light=light, noir=noir) if source == "pi" else OpenCVCamera(source)


class RetryingCamera:
    """The camera, opened lazily and re-tried if it's busy, so the duck stays online without it.

    Only one program can own the Pi camera. If something else has it (asl/run.py, stream.sh, ...)
    the duck keeps running (relay link, quacks, coach) and grabs the camera as soon as it's free.
    """

    RETRY_S = 10.0

    def __init__(self, opener):
        self._opener = opener
        self.cam = None
        self._next_try = 0.0
        self._last_error: str | None = None

    def _ready(self) -> bool:
        if self.cam is not None:
            return True
        now = time.monotonic()
        if now < self._next_try:
            return False
        try:
            self.cam = self._opener()
            log("camera ready" + (" (it was busy before)" if self._last_error else ""))
            self._last_error = None
            return True
        except (Exception, SystemExit) as e:
            self._next_try = now + self.RETRY_S
            err = str(e) or e.__class__.__name__
            if err != self._last_error:
                log(f"camera unavailable ({err}). Another program may be using it (asl/run.py, "
                    f"posture/run.py, camera/stream.sh); the duck stays online and retries every {self.RETRY_S:.0f} s")
                self._last_error = err
            return False

    @property
    def available(self) -> bool:
        return self.cam is not None

    @property
    def night(self) -> bool:
        return bool(self.cam and self.cam.night)

    @property
    def lux(self):
        return self.cam.lux if self.cam else None

    def start(self):
        if self._ready():
            self.cam.start()

    def stop(self):
        if self.cam:
            self.cam.stop()

    def read(self):
        return self.cam.read() if self._ready() else None

    def close(self):
        if self.cam:
            self.cam.close()
