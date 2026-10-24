"""Run: cd pi/posture && python3 -m unittest -v   (stdlib only)"""

import math
import unittest

from judge import (CALIBRATE_MESSAGE, CALIBRATE_S, Point, PostureJudge,
                   margin_deg, neck_angle_deg)

SETTINGS = {"posture_severity": 50, "posture_delay_s": 5, "posture_message": "Sit up straight!"}
FPS = 10
UPRIGHT = 33          # Akeen's real upright reading in vertical mode was 29-37 deg


def pose(angle_deg, side="left", vis=0.9):
    """No hip. Shoulder at (300, 300); ear 100 px away at `angle_deg` from vertical."""
    sh = Point(300, 300, vis)
    ear = Point(300 + 100 * math.sin(math.radians(angle_deg)),
                300 - 100 * math.cos(math.radians(angle_deg)), vis)
    return {f"{side}_ear": ear, f"{side}_shoulder": sh}


def body(torso_deg, neck_deg, hip_vis=0.9, vis=0.9):
    """Side view with a hip. torso_deg: whole-body lean from vertical.
    neck_deg: head's lean from vertical (equal to torso_deg = straight back)."""
    hip = Point(300, 500, hip_vis)
    sh = Point(300 + 200 * math.sin(math.radians(torso_deg)),
               500 - 200 * math.cos(math.radians(torso_deg)), vis)
    ear = Point(sh.x + 100 * math.sin(math.radians(neck_deg)),
                sh.y - 100 * math.cos(math.radians(neck_deg)), vis)
    return {"left_hip": hip, "left_shoulder": sh, "left_ear": ear}


def run(judge, start, seconds, frame):
    """Feed `seconds` of frames; return (end_time, all actions)."""
    out, t = [], start
    for _ in range(int(round(seconds * FPS))):
        out += judge.update(t, frame)
        t += 1 / FPS
    return t, out


def events(actions):
    return [a[2] for a in actions if a[0] == "event"]


def calibrated(frame=None, settings=None):
    """A judge that has already recorded `frame` (default: upright, no hip) as baseline."""
    j = PostureJudge(dict(settings or SETTINGS))
    t, _ = run(j, 0, CALIBRATE_S + 0.5, frame or pose(UPRIGHT))
    return j, t


class Geometry(unittest.TestCase):
    def test_upright_is_zero(self):
        self.assertAlmostEqual(neck_angle_deg(Point(300, 200), Point(300, 300)), 0)

    def test_forward_head(self):
        self.assertAlmostEqual(neck_angle_deg(Point(400, 200), Point(300, 300)), 45)

    def test_facing_either_way(self):
        self.assertAlmostEqual(neck_angle_deg(Point(200, 200), Point(300, 300)), 45)

    def test_straight_lean_with_hip_is_zero(self):
        b = body(40, 40)
        self.assertAlmostEqual(neck_angle_deg(b["left_ear"], b["left_shoulder"], b["left_hip"]), 0, places=5)

    def test_head_forward_off_torso(self):
        b = body(0, 40)
        self.assertAlmostEqual(neck_angle_deg(b["left_ear"], b["left_shoulder"], b["left_hip"]), 40, places=5)

    def test_rounded_back_while_leaning(self):
        b = body(20, 55)                                  # torso leans 20, head juts to 55
        self.assertAlmostEqual(neck_angle_deg(b["left_ear"], b["left_shoulder"], b["left_hip"]), 35, places=5)

    def test_margin_mapping(self):
        self.assertEqual(margin_deg(0), 25)
        self.assertEqual(margin_deg(50), 15)
        self.assertEqual(margin_deg(100), 5)
        self.assertEqual(margin_deg(500), 5)


class Calibration(unittest.TestCase):
    def test_asks_to_sit_tall_once_and_never_judges_while_calibrating(self):
        j = PostureJudge(dict(SETTINGS))
        _, acts = run(j, 0, CALIBRATE_S - 0.5, pose(70))
        self.assertEqual(acts, [("speak", CALIBRATE_MESSAGE)])
        self.assertTrue(j.calibrating)

    def test_baseline_is_your_upright_reading(self):
        j, _ = calibrated()
        self.assertAlmostEqual(j.baseline[False], UPRIGHT, places=5)
        self.assertAlmostEqual(j.limit, UPRIGHT + 15, places=5)

    def test_akeens_natural_posture_is_not_a_slouch(self):
        j, t = calibrated()
        _, acts = run(j, t, 60, pose(37))                 # the reading that used to trigger it
        self.assertEqual(acts, [])

    def test_different_people_get_different_baselines(self):
        j, _ = calibrated(pose(10))
        self.assertAlmostEqual(j.limit, 25, places=5)

    def test_new_person_after_long_absence_recalibrates(self):
        j, t = calibrated()
        t, _ = run(j, t, 11, None)                        # away > 10 s
        self.assertEqual(j.baseline, {})
        _, acts = run(j, t, 1, pose(UPRIGHT))
        self.assertIn(("speak", CALIBRATE_MESSAGE), acts)

    def test_short_dropout_keeps_baseline(self):
        j, t = calibrated()
        t, _ = run(j, t, 3, None)                         # flaky tracking, < 10 s
        self.assertIn(False, j.baseline)
        _, acts = run(j, t, 1, pose(UPRIGHT))
        self.assertEqual(acts, [])

    def test_reset_forgets_baseline(self):
        j, _ = calibrated()
        j.reset()
        self.assertEqual(j.baseline, {})

    def test_hip_appearing_calibrates_torso_mode_silently(self):
        j, t = calibrated()
        _, acts = run(j, t, CALIBRATE_S + 0.5, body(5, 25))
        self.assertNotIn(("speak", CALIBRATE_MESSAGE), acts)   # already asked this person
        self.assertIn(True, j.baseline)


class Timing(unittest.TestCase):
    def test_short_slouch_is_silent(self):
        j, t = calibrated()
        t, a1 = run(j, t, 3, pose(60))
        _, a2 = run(j, t, 3, pose(UPRIGHT))
        self.assertEqual(a1 + a2, [])

    def test_slouch_prompts_after_delay_then_reminds(self):
        j, t = calibrated()
        _, acts = run(j, t, 40, pose(60))
        evs = events(acts)
        self.assertEqual(len(evs), 2)                     # first prompt + one 30 s reminder
        self.assertEqual(evs[0]["state"], "slouch")
        self.assertGreaterEqual(evs[0]["slouch_duration_s"], 5)
        self.assertIn(("speak", "Sit up straight!"), acts)

    def test_upright_event_after_prompted_slouch(self):
        j, t = calibrated()
        t, _ = run(j, t, 8, pose(60))
        _, acts = run(j, t, 3, pose(UPRIGHT))
        evs = events(acts)
        self.assertEqual([e["state"] for e in evs], ["upright"])
        self.assertGreaterEqual(evs[0]["slouch_duration_s"], 8)

    def test_hysteresis_ignores_jitter_near_threshold(self):
        j, t = calibrated()                               # limit 48, clears below 43
        t, _ = run(j, t, 8, pose(55))
        _, acts = run(j, t, 5, pose(45))
        self.assertEqual([e for e in events(acts) if e["state"] == "upright"], [])

    def test_lost_tracking_ends_slouch(self):
        j, t = calibrated()
        t, _ = run(j, t, 8, pose(60))
        _, acts = run(j, t, 3, None)
        self.assertEqual([e["state"] for e in events(acts)], ["upright"])

    def test_low_visibility_is_ignored(self):
        _, acts = run(PostureJudge(dict(SETTINGS)), 0, 10, pose(60, vis=0.2))
        self.assertEqual(acts, [])

    def test_uses_whichever_side_is_visible(self):
        j, t = calibrated(pose(UPRIGHT, side="right"))
        _, acts = run(j, t, 8, pose(60, side="right"))
        self.assertEqual(len(events(acts)), 1)

    def test_settings_are_live(self):
        j, t = calibrated()
        j.settings["posture_severity"] = 0                # margin 25 -> limit 58: 55 no longer counts
        _, acts = run(j, t, 10, pose(55))
        self.assertEqual(acts, [])

    def test_leaning_forward_straight_is_not_a_slouch(self):
        j, t = calibrated(body(0, 15))
        _, acts = run(j, t, 20, body(40, 55))             # whole body leans 40, head stays in line
        self.assertEqual(acts, [])

    def test_head_jut_with_hip_is_a_slouch(self):
        j, t = calibrated(body(0, 15))
        _, acts = run(j, t, 8, body(5, 50))
        self.assertEqual([e["state"] for e in events(acts)], ["slouch"])


if __name__ == "__main__":
    unittest.main()
