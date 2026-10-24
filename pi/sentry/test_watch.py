"""python3 -m unittest -v   (from pi/sentry; no hardware or deps needed)"""

import unittest

import watch
from watch import SentryWatch, UltrasonicMotion

SETTINGS = {"sentry_enabled": True, "sentry_message": "Who goes there?"}


def kinds(actions):
    return [a[0] if a[0] != "camera" else f"camera_{a[1]}" for a in actions]


class TestUltrasonicMotion(unittest.TestCase):
    def setUp(self):
        self.m = UltrasonicMotion()
        for _ in range(10):
            self.m.update(300.0)   # door is 3 m away

    def test_steady_room_is_quiet(self):
        self.assertFalse(any(self.m.update(d) for d in [298, 302, 301, 299, 300]))

    def test_small_jitter_ignored(self):
        self.assertFalse(any(self.m.update(d) for d in [290, 315, 285, 310]))

    def test_person_in_beam_needs_two_readings(self):
        self.assertFalse(self.m.update(150))
        self.assertTrue(self.m.update(140))

    def test_single_glitch_ignored(self):
        self.assertFalse(self.m.update(40))
        self.assertFalse(self.m.update(300))
        self.assertFalse(self.m.update(300))

    def test_none_readings_ignored(self):
        self.assertFalse(self.m.update(None))
        self.assertEqual(self.m.baseline, 300)

    def test_no_trigger_before_baseline(self):
        m = UltrasonicMotion()
        self.assertFalse(any(m.update(d) for d in [100, 300, 50, 300]))

    def test_moved_furniture_becomes_baseline(self):
        for _ in range(UltrasonicMotion.ADOPT_AFTER):
            self.m.update(120)
        for _ in range(10):
            self.m.update(120)
        self.assertEqual(self.m.baseline, 120)
        self.assertFalse(self.m.update(121))


class TestSentryWatch(unittest.TestCase):
    def setUp(self):
        self.w = SentryWatch(dict(SETTINGS))

    def look(self, t0, confs, night=False, step=0.2):
        out, t = [], t0
        for c in confs:
            out += self.w.frame(t, c, night)
            t += step
        return out, t

    def test_trigger_turns_camera_on(self):
        self.assertEqual(kinds(self.w.trigger(0, 140, "ultrasonic")), ["camera_on"])
        self.assertTrue(self.w.looking)

    def test_person_confirmed_alerts_and_speaks(self):
        self.w.trigger(0, 140, "ultrasonic")
        out, _ = self.look(1.0, [0.9, 0.8, 0.85], night=True)
        self.assertEqual(kinds(out), ["event", "camera_off", "speak"])
        value = out[0][2]
        self.assertEqual(value, {"distance_cm": 140, "trigger": "ultrasonic",
                                 "person_confirmed": True, "confidence": 0.9, "night": True})
        self.assertEqual(out[2][1], "Who goes there?")

    def test_warmup_frames_ignored(self):
        self.w.trigger(0, 140, "ultrasonic")
        out, _ = self.look(0.0, [0.9, 0.9, 0.9], step=0.1)   # all inside WARMUP_S
        self.assertEqual(out, [])

    def test_flicker_needs_three_of_five(self):
        self.w.trigger(0, 140, "ultrasonic")
        out, _ = self.look(1.0, [0.9, 0.1, 0.9, 0.1])
        self.assertEqual(out, [])
        out, _ = self.look(2.0, [0.9])
        self.assertEqual(kinds(out)[0], "event")

    def test_no_person_reports_false_alarm_quietly(self):
        self.w.trigger(0, 140, "ultrasonic")
        out, t = self.look(1.0, [0.2, None, 0.3])
        out += self.w.tick(watch.LOOK_S + 0.1)
        self.assertEqual(kinds(out), ["event", "camera_off"])
        self.assertFalse(out[0][2]["person_confirmed"])
        self.assertEqual(out[0][2]["confidence"], 0.3)

    def test_cooldown_blocks_repeat_alerts(self):
        self.w.trigger(0, 140, "ultrasonic")
        self.look(1.0, [0.9, 0.9, 0.9])
        self.assertEqual(self.w.trigger(10, 140, "ultrasonic"), [])
        self.assertEqual(kinds(self.w.trigger(2 + watch.COOLDOWN_S, 140, "ultrasonic")), ["camera_on"])

    def test_false_alarm_has_shorter_cooldown(self):
        self.w.trigger(0, 140, "ultrasonic")
        self.w.tick(watch.LOOK_S + 0.1)
        t = watch.LOOK_S + 0.1 + watch.FALSE_COOLDOWN_S + 0.1
        self.assertEqual(kinds(self.w.trigger(t, 140, "ultrasonic")), ["camera_on"])

    def test_disabled_does_nothing(self):
        self.w.settings["sentry_enabled"] = False
        self.assertEqual(self.w.trigger(0, 140, "ultrasonic"), [])
        self.assertFalse(self.w.looking)

    def test_empty_message_stays_quiet(self):
        self.w.settings["sentry_message"] = ""
        self.w.trigger(0, None, "camera")
        out, _ = self.look(1.0, [0.9, 0.9, 0.9])
        self.assertEqual(kinds(out), ["event", "camera_off"])
        self.assertIsNone(out[0][2]["distance_cm"])
        self.assertEqual(out[0][2]["trigger"], "camera")

    def test_frames_outside_looking_ignored(self):
        self.assertEqual(self.w.frame(5, 0.99, False), [])


if __name__ == "__main__":
    unittest.main()
