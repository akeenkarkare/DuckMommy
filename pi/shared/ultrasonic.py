"""HC-SR04-style ultrasonic sensor.

Wiring (5 V sensor, 3.3 V Pi):
  VCC -> 5V, GND -> GND, TRIG -> any GPIO (3.3 V is enough to trigger)
  ECHO -> voltage divider -> GPIO.  ECHO outputs 5 V, which can damage the Pi.
          e.g. ECHO -- 1kΩ --+-- GPIO
                             |
                            2kΩ
                             |
                            GND

Uses gpiozero (preinstalled on Raspberry Pi OS, with the lgpio backend that the
Pi 5 needs; RPi.GPIO does not work on the Pi 5).
"""

from __future__ import annotations

MAX_DISTANCE_M = 4.0


class Ultrasonic:
    def __init__(self, trigger: int, echo: int):
        from gpiozero import DistanceSensor
        # queue_len=3: small median filter inside gpiozero, keeps it responsive
        self.sensor = DistanceSensor(echo=echo, trigger=trigger, max_distance=MAX_DISTANCE_M, queue_len=3)

    def distance_cm(self) -> float | None:
        d = self.sensor.distance   # metres, clamped to 0..max_distance
        return None if d is None else round(d * 100, 1)

    def close(self):
        self.sensor.close()
