"""python3 -m unittest -v   (from pi/shared)"""

import unittest

from presence import ARRIVE_S, LEAVE_S, Presence


class TestPresence(unittest.TestCase):
    def setUp(self):
        self.p = Presence()

    def run_dist(self, t, d, seconds, step=0.1):
        out = []
        for i in range(round(seconds / step)):
            ev = self.p.update_distance(t + i * step, d)
            if ev:
                out.append(ev)
        return out, t + seconds

    def test_sit_down_then_leave(self):
        out, t = self.run_dist(0, 300, 2)
        self.assertEqual(out, [])
        out, t = self.run_dist(t, 60, ARRIVE_S + 0.2)
        self.assertEqual(out, ["arrive"])
        out, t = self.run_dist(t, 300, LEAVE_S + 0.2)
        self.assertEqual(out, ["leave"])

    def test_brief_lean_back_keeps_present(self):
        self.run_dist(0, 60, ARRIVE_S + 0.2)
        out, _ = self.run_dist(10, 300, LEAVE_S / 2)
        out += self.run_dist(20, 60, 1)[0]
        self.assertEqual(out, [])
        self.assertTrue(self.p.present)

    def test_hysteresis_band_counts_as_still_there(self):
        self.run_dist(0, 60, ARRIVE_S + 0.2)
        out, _ = self.run_dist(10, 125, LEAVE_S * 2)    # between NEAR and FAR
        self.assertEqual(out, [])

    def test_walking_past_does_not_arrive(self):
        out, _ = self.run_dist(0, 60, ARRIVE_S / 2)
        out += self.run_dist(5, 300, 1)[0]
        self.assertEqual(out, [])

    def test_none_ignored(self):
        self.assertIsNone(self.p.update_distance(0, None))

    def test_camera_mode(self):
        self.assertIsNone(self.p.update_seen(0, True))
        self.assertEqual(self.p.update_seen(ARRIVE_S, True), "arrive")


if __name__ == "__main__":
    unittest.main()
