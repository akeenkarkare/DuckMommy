"""Run: cd pi/motion && python3 -m unittest -v   (needs numpy + opencv, like the Pi)"""

import unittest

import numpy as np

from detect import MotionDetector

STILL = np.full((480, 640, 3), 120, np.uint8)


def with_box(frame, value=220):
    f = frame.copy()
    f[100:300, 200:400] = value          # a 200x200 object (a hand, a head) appears
    return f


def feed(d, t, frame, secs, fps=10):
    acts = []
    for _ in range(int(round(secs * fps))):
        acts += d.update(t, frame)
        t += 1 / fps
    return t, acts


class Motion(unittest.TestCase):
    def test_first_frame_is_baseline_only(self):
        self.assertEqual(MotionDetector().update(0, STILL), [])

    def test_movement_goes_active(self):
        d = MotionDetector()
        d.update(0, STILL)
        self.assertEqual(d.update(0.1, with_box(STILL)), [("state", "ACTIVE")])

    def test_idle_after_timeout(self):
        d = MotionDetector({"idle_timeout_s": 10})
        t, _ = feed(d, 0, STILL, 1)
        t, _ = feed(d, t, with_box(STILL), 0.1)
        t, acts = feed(d, t, STILL, 9)
        self.assertEqual(acts, [])
        _, acts = feed(d, t, STILL, 2)
        self.assertEqual(acts, [("state", "IDLE")])

    def test_sensor_noise_is_not_motion(self):
        d, rng = MotionDetector(), np.random.default_rng(0)
        acts = []
        for i in range(50):
            noisy = np.clip(STILL.astype(int) + rng.integers(-12, 13, STILL.shape), 0, 255).astype(np.uint8)
            acts += d.update(i / 10, noisy)
        self.assertEqual(acts, [])

    def test_uniform_brightness_change_is_not_motion(self):
        d = MotionDetector()
        d.update(0, STILL)
        self.assertEqual(d.update(0.1, np.full_like(STILL, 160)), [])   # lamp / auto-exposure

    def test_whole_scene_change_rebaselines(self):
        d = MotionDetector()
        d.update(0, STILL)
        rng = np.random.default_rng(1)
        scene = rng.integers(0, 255, STILL.shape, dtype=np.uint8)       # night mode: everything differs
        self.assertEqual(d.update(0.1, scene), [])
        self.assertEqual(d.update(0.2, scene), [])                       # and it's the new normal

    def test_movement_during_brightness_change_still_counts(self):
        d = MotionDetector()
        d.update(0, STILL)
        brighter = np.full_like(STILL, 140)
        self.assertEqual(d.update(0.1, with_box(brighter, 40)), [("state", "ACTIVE")])

    def test_still_for_and_timeout(self):
        d = MotionDetector({"idle_timeout_s": 60})
        d.update(0, STILL)
        d.update(1, with_box(STILL))
        self.assertAlmostEqual(d.still_for(31), 30)
        self.assertEqual(d.debug_info(31)["timeout_s"], 60)


if __name__ == "__main__":
    unittest.main()
