"""Dev-only live view: annotated camera frames as an MJPEG web page on the Pi.

  python3 duck.py --preview        then open http://<pi-ip>:8090 in a browser

Frames are only encoded while someone is watching. This is a LAN debugging aid,
like camera/stream.sh; video never goes to the relay or the server.
"""

from __future__ import annotations

import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class PreviewServer:
    def __init__(self, port: int = 8090):
        import cv2
        self.cv2 = cv2
        self.jpg: bytes | None = None
        self.viewers = 0
        self.cond = threading.Condition()
        server = ThreadingHTTPServer(("0.0.0.0", port), self._handler())
        server.daemon_threads = True
        threading.Thread(target=server.serve_forever, daemon=True, name="preview").start()
        print(f"# preview: open http://<this-pi's-ip>:{port} in a browser", file=sys.stderr, flush=True)

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
                if self.path != "/":
                    self.send_error(404)
                    return
                self.send_response(200)
                self.send_header("Content-Type", "multipart/x-mixed-replace; boundary=frame")
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
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
                    preview.viewers -= 1

        return Handler
