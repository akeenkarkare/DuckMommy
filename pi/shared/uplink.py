"""WebSocket link to the relay, in a background thread.

  up = Uplink(url, token, on_settings, on_command, on_agenda); up.start()
  up.send_event("posture", {...})     # never blocks; queued while offline
  up.video_on / up.video_fps          # a dashboard asked for the live view (relay says when)
  up.send_frame(jpeg_bytes)           # never blocks; only the newest frame is kept, never queued

Reconnects with backoff and resends anything queued while the link was down.
Needs `pip install websockets` (sync client, websockets >= 12).
"""

from __future__ import annotations

import collections
import json
import sys
import threading
import time

MAX_QUEUE = 1000


def log(msg: str):
    print(f"# uplink: {msg}", file=sys.stderr, flush=True)


class Uplink:
    def __init__(self, url: str, token: str, on_settings, on_command, on_agenda=None):
        self.url, self.token = url, token
        self.on_settings, self.on_command, self.on_agenda = on_settings, on_command, on_agenda
        self._queue: collections.deque[str] = collections.deque(maxlen=MAX_QUEUE)
        self._ws = None
        self._lock = threading.Lock()
        self.connected = False
        self.video_on, self.video_fps = False, 5
        self._frame: bytes | None = None
        self._frame_cv = threading.Condition()

    def start(self):
        threading.Thread(target=self._run, daemon=True, name="uplink").start()
        threading.Thread(target=self._video_sender, daemon=True, name="uplink-video").start()

    def send_frame(self, jpeg: bytes) -> bool:
        """Live view frame (binary). Dropped unless someone is watching; a newer one replaces it."""
        if not (self.connected and self.video_on):
            return False
        with self._frame_cv:
            self._frame = jpeg
            self._frame_cv.notify()
        return True

    def _video_sender(self):
        # Separate thread so a slow link drops frames instead of stalling the camera loop.
        while True:
            with self._frame_cv:
                while self._frame is None:
                    self._frame_cv.wait()
                data, self._frame = self._frame, None
            with self._lock:
                ws = self._ws if self.connected and self.video_on else None
            if ws:
                try:
                    ws.send(data)
                except Exception:
                    pass

    def send_event(self, etype: str, value: dict):
        msg = json.dumps({"type": "event", "event": {"type": etype, "value": value, "ts": int(time.time() * 1000)}})
        with self._lock:
            ws = self._ws if self.connected else None
        if ws:
            try:
                ws.send(msg)
                return
            except Exception:
                pass
        self._queue.append(msg)

    def _run(self):
        from websockets.sync.client import connect
        backoff = 1
        while True:
            try:
                with connect(self.url, open_timeout=5, ping_interval=20) as ws:
                    ws.send(json.dumps({"type": "auth", "role": "duck", "token": self.token}))
                    for raw in ws:
                        msg = json.loads(raw)
                        if msg.get("type") == "auth_ok":
                            log(f"connected to {self.url}")
                            backoff = 1
                            with self._lock:
                                self._ws, self.connected = ws, True
                            while self._queue:
                                ws.send(self._queue.popleft())
                        elif msg.get("type") == "settings":
                            self.on_settings(msg.get("settings") or {})
                        elif msg.get("type") == "command":
                            self.on_command(msg.get("command") or {})
                        elif msg.get("type") == "agenda" and self.on_agenda:
                            self.on_agenda(msg.get("items") or [])
                        elif msg.get("type") == "video":
                            on = bool(msg.get("on"))
                            self.video_fps = max(1, min(15, int(msg.get("fps") or 5)))
                            if on != self.video_on:
                                log(f"live view {'on' if on else 'off'}" + (f" ({self.video_fps} fps)" if on else ""))
                            self.video_on = on
            except Exception as e:
                log(f"disconnected ({e.__class__.__name__}: {e}); retrying in {backoff}s")
            with self._lock:
                self._ws, self.connected = None, False
            self.video_on = False   # the relay re-sends it after reconnecting
            time.sleep(backoff)
            backoff = min(backoff * 2, 10)
