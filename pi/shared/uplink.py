"""WebSocket link to the relay, in a background thread.

  up = Uplink(url, token, on_settings, on_command); up.start()
  up.send_event("posture", {...})     # never blocks; queued while offline

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
    def __init__(self, url: str, token: str, on_settings, on_command):
        self.url, self.token = url, token
        self.on_settings, self.on_command = on_settings, on_command
        self._queue: collections.deque[str] = collections.deque(maxlen=MAX_QUEUE)
        self._ws = None
        self._lock = threading.Lock()
        self.connected = False

    def start(self):
        threading.Thread(target=self._run, daemon=True, name="uplink").start()

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
            except Exception as e:
                log(f"disconnected ({e.__class__.__name__}: {e}); retrying in {backoff}s")
            with self._lock:
                self._ws, self.connected = None, False
            time.sleep(backoff)
            backoff = min(backoff * 2, 10)
