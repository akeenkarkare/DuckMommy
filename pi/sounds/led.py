"""Alert LED with a different blink pattern per sound, so you can tell them apart at a glance.

Wire: GPIO -> 330 Ω resistor -> LED long leg; LED short leg -> GND. Uses gpiozero (preinstalled).
Without a pin (LED_PIN blank in pi/.env) the pattern is just logged.
"""

from __future__ import annotations

import sys

# kind -> (on_s, off_s, repeats)
PATTERNS = {
    "doorbell": (0.15, 0.15, 30),      # fast blink ~9 s
    "phone": (0.8, 0.4, 10),           # slow ring rhythm ~12 s
    "alarm": (0.08, 0.08, 90),         # strobe ~14 s
    "notification": (0.3, 0.3, 3),     # three blinks
    "calling": (2.0, 0.5, 3),          # long glows
    "sign": (0.1, 0.1, 2),             # quick double blink: word sign recognised (pi/asl)
    "listening": (0.25, 0.25, 30),     # "hey duck" heard: blinking while it listens (stopped by "heard")
    "heard": (0.05, 0.05, 1),          # done listening (replaces the listening blink)
}


class AlertLED:
    def __init__(self, pin: int | None):
        self.led = None
        if pin is not None:
            from gpiozero import LED
            self.led = LED(pin)

    def show(self, kind: str):
        on, off, n = PATTERNS.get(kind, (0.5, 0.5, 4))
        print(f"# led: {kind} pattern", file=sys.stderr, flush=True)
        if self.led:
            self.led.blink(on_time=on, off_time=off, n=n, background=True)   # replaces any running pattern

    def close(self):
        if self.led:
            self.led.close()
