"""Run: cd pi/posture && python3 -m unittest -v   (stdlib only)"""

import math
import unittest

from judge import Point, PostureJudge, neck_angle_deg, threshold_deg

SETTINGS = {"posture_severity": 50, "posture_delay_s": 5, "posture_message": "Sit up straight!"}
FPS = 10


def pose(angle_deg, side="left", vis=0.9):
    """Shoulder at (300, 300); ear 100 px away at `angle_deg` from vertical."""
    sh = Point(300, 300, vis)
    ear = Point(300 + 100 * math.sin(math.radians(angle_deg)),
                300 - 100 * math.cos(math.radians(angle_deg)), vis)
    return {f"{side}_ear": ear, f"{side}_shoulder": sh}


def run(judge, start, seconds, frame):
    """Feed `seconds` of frames; return (end_time, all actions)."""
    out, t = [], start
    for _ in range(int(seconds * FPS)):
        out += judge.update(t, frame)
        t += 1 / FPS
    return t, out


def events(actions):
    return [a[2] for a in actions if a[0] == "event"]


class Geometry(unittest.TestCase):
    def test_upright_is_zero(self):
        self.assertAlmostEqual(neck_angle_deg(Point(300, 200), Point(300, 300)), 0)

    def test_forward_head(self):
        self.assertAlmostEqual(neck_angle_deg(Point(400, 200), Point(300, 300)), 45)

    def test_facing_either_way(self):
        self.assertAlmostEqual(neck_angle_deg(Point(200, 200), Point(300, 300)), 45)

    def test_severity_mapping(self):
        self.assertEqual(threshold_deg(0), 45)
        self.assertEqual(threshold_deg(50), 30)
        self.assertEqual(threshold_deg(100), 15)
        self.assertEqual(threshold_deg(500), 15)


class Timing(unittest.TestCase):
    def test_upright_never_fires(self):
        _, acts = run(PostureJudge(dict(SETTINGS)), 0, 60, pose(10))
        self.assertEqual(acts, [])

    def test_short_slouch_is_silent(self):
        j = PostureJudge(dict(SETTINGS))
        t, a1 = run(j, 0, 3, pose(40))
        _, a2 = run(j, t, 3, pose(10))
        self.assertEqual(a1 + a2, [])

    def test_slouch_prompts_after_delay_then_reminds(self):
        j = PostureJudge(dict(SETTINGS))
        _, acts = run(j, 0, 40, pose(40))
        evs = events(acts)
        self.assertEqual(len(evs), 2)                     # first prompt + one 30 s reminder
        self.assertEqual(evs[0]["state"], "slouch")
        self.assertGreaterEqual(evs[0]["slouch_duration_s"], 5)
        self.assertIn(("speak", "Sit up straight!"), acts)

    def test_upright_event_after_prompted_slouch(self):
        j = PostureJudge(dict(SETTINGS))
        t, _ = run(j, 0, 8, pose(40))
        _, acts = run(j, t, 3, pose(5))
        evs = events(acts)
        self.assertEqual([e["state"] for e in evs], ["upright"])
        self.assertGreaterEqual(evs[0]["slouch_duration_s"], 8)

    def test_hysteresis_ignores_jitter_near_threshold(self):
        j = PostureJudge(dict(SETTINGS))
        t, _ = run(j, 0, 8, pose(35))
        _, acts = run(j, t, 5, pose(28))                  # below 30, above 25: still slouching
        self.assertEqual([e for e in events(acts) if e["state"] == "upright"], [])

    def test_lost_tracking_ends_slouch(self):
        j = PostureJudge(dict(SETTINGS))
        t, _ = run(j, 0, 8, pose(40))
        _, acts = run(j, t, 3, None)
        self.assertEqual([e["state"] for e in events(acts)], ["upright"])

    def test_low_visibility_is_ignored(self):
        _, acts = run(PostureJudge(dict(SETTINGS)), 0, 10, pose(40, vis=0.2))
        self.assertEqual(acts, [])

    def test_uses_whichever_side_is_visible(self):
        _, acts = run(PostureJudge(dict(SETTINGS)), 0, 8, pose(40, side="right"))
        self.assertEqual(len(events(acts)), 1)

    def test_settings_are_live(self):
        s = dict(SETTINGS)
        j = PostureJudge(s)
        s["posture_severity"] = 0                         # 45 deg threshold: 40 no longer counts
        _, acts = run(j, 0, 10, pose(40))
        self.assertEqual(acts, [])

    def test_reset_on_leave(self):
        j = PostureJudge(dict(SETTINGS))
        run(j, 0, 8, pose(40))
        self.assertEqual([e["state"] for e in events(j.reset())], ["upright"])


if __name__ == "__main__":
    unittest.main()
