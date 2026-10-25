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


def render_jpeg(rgb, lines, points=None, quality: int = 70, max_width: int = 640,
                hands=None, rest_y: float | None = None) -> bytes | None:
    """Annotated JPEG: status lines top-left, plus the posture skeleton (hip-shoulder-ear) if given.

    hands: the Holistic (75, 3) frame from asl/landmarks.py (both hands drawn as dots).
    rest_y: Sign to Duck's rest line, as a fraction of the frame height.
    """
    import cv2
    img = cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)
    h, w = img.shape[:2]
    if rest_y is not None:
        y = int(rest_y * h)
        cv2.line(img, (0, y), (w, y), (0, 160, 255), 1)
        cv2.putText(img, "rest line", (8, y - 6), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 160, 255), 1)
    if hands is not None:
        aspect = w / h   # landmarks.py scaled x by width/height
        for p in hands[33:75]:   # LEFT_HAND..RIGHT_HAND+21
            if p[0] == p[0]:     # skip NaN (hand not found)
                cv2.circle(img, (int(p[0] / aspect * w), int(p[1] * h)), 3, (0, 200, 255), -1)
    if points:
        for side in ("left", "right"):
            chain = [points.get(f"{side}_{k}") for k in ("hip", "shoulder", "ear")]
            chain = [p for p in chain if p is not None and p.visibility >= 0.5]
            for a, b in zip(chain, chain[1:]):
                cv2.line(img, (int(a.x), int(a.y)), (int(b.x), int(b.y)), (0, 220, 255), 3)
            for p in chain:
                cv2.circle(img, (int(p.x), int(p.y)), 5, (255, 255, 255), -1)
    for i, (text, color) in enumerate(lines or []):
        y = 28 + i * 26
        cv2.putText(img, text, (10, y), cv2.FONT_HERSHEY_SIMPLEX, 0.65, (0, 0, 0), 4)
        cv2.putText(img, text, (10, y), cv2.FONT_HERSHEY_SIMPLEX, 0.65, color, 2)
    if w > max_width:
        img = cv2.resize(img, (max_width, int(h * max_width / w)), interpolation=cv2.INTER_AREA)
    ok, jpg = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, quality])
    return jpg.tobytes() if ok else None


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

    def push(self, rgb, lines: list[tuple[str, tuple[int, int, int]]], points=None, hands=None, rest_y=None):
        """lines: (text, BGR colour) drawn top-left. hands/rest_y: see render_jpeg."""
        if not self.viewers:
            return
        jpg = render_jpeg(rgb, lines, points, quality=70, max_width=10_000, hands=hands, rest_y=rest_y)
        if jpg:
            with self.cond:
                self.jpg = jpg
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
