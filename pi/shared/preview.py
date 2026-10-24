"""Dev-only live view: annotated camera frames as an MJPEG web page on the Pi.

  python3 duck.py --preview        then open http://<pi-ip>:8090 in a browser

Frames are only encoded while someone is watching. This is a LAN debugging aid,
like camera/stream.sh; video never goes to the relay or the server.

The URL carries a random key (printed at start, new every run) so other people on
the same venue Wi-Fi can't watch the camera. Set PREVIEW_KEY in pi/.env to keep
one fixed key across restarts.
"""

from __future__ import annotations

import hmac
import os
import secrets
import socket
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit


def _lan_ip() -> str:
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("10.255.255.255", 1))   # no packets sent; just picks the outgoing interface
            return s.getsockname()[0]
    except OSError:
        return "<this-pi's-ip>"


class PreviewServer:
    def __init__(self, port: int = 8090, key: str | None = None):
        import cv2
        self.cv2 = cv2
        self.jpg: bytes | None = None
        self.viewers = 0
        self.key = key or os.environ.get("PREVIEW_KEY") or secrets.token_urlsafe(6)
        self.cond = threading.Condition()
        server = ThreadingHTTPServer(("0.0.0.0", port), self._handler())
        server.daemon_threads = True
        threading.Thread(target=server.serve_forever, daemon=True, name="preview").start()
        print(f"# preview: open http://{_lan_ip()}:{port}/?k={self.key} in a browser", file=sys.stderr, flush=True)

    def push(self, rgb, lines: list[tuple[str, tuple[int, int, int]]]):
        """lines: (text, BGR colour) drawn top-left."""
        if not self.viewers:
            return
        cv2 = self.cv2
        img = cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)
        for i, (text, color) in enumerate(lines):
            y = 28 + i * 26
            cv2.putText(img, text, (10, y), cv2.FONT_HERSHEY_SIMPLEX, 0.65, (0, 0, 0), 4)
            cv2.putText(img, text, (10, y), cv2.FONT_HERSHEY_SIMPLEX, 0.65, color, 2)
        ok, jpg = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, 70])
        if ok:
            with self.cond:
                self.jpg = jpg.tobytes()
                self.cond.notify_all()

    def _handler(self):
        preview = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_GET(self):
                url = urlsplit(self.path)
                given = (parse_qs(url.query).get("k") or [""])[0]
                if url.path != "/" or not hmac.compare_digest(given.encode(), preview.key.encode()):
                    self.send_error(404)
                    return
                self.send_response(200)
                self.send_header("Content-Type", "multipart/x-mixed-replace; boundary=frame")
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                with preview.cond:
                    preview.viewers += 1
                try:
                    while True:
                        with preview.cond:
                            preview.cond.wait(timeout=2)
                            data = preview.jpg
                        if data:
                            self.wfile.write(b"--frame\r\nContent-Type: image/jpeg\r\nContent-Length: "
                                             + str(len(data)).encode() + b"\r\n\r\n" + data + b"\r\n")
                except (BrokenPipeError, ConnectionResetError):
                    pass
                finally:
                    with preview.cond:
                        preview.viewers -= 1

        return Handler
