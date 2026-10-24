"""python3 -m unittest -v   (from pi/sounds; no mic or deps needed)"""

import unittest

from alerts import COOLDOWN_S, SoundAlerts


class TestSoundAlerts(unittest.TestCase):
    def setUp(self):
        self.a = SoundAlerts({"sound_alerts_enabled": True})

    def test_strong_doorbell_fires_once(self):
        out = self.a.update(0, [("Doorbell", 0.8), ("Speech", 0.4)])
        self.assertEqual(out, [("event", "sound", {"kind": "doorbell", "label": "Doorbell", "score": 0.8}),
                               ("led", "doorbell")])
        self.assertEqual(self.a.update(0.5, [("Doorbell", 0.9)]), [])                  # cooldown
        self.assertEqual(len(self.a.update(COOLDOWN_S["doorbell"] + 1, [("Ding-dong", 0.7)])), 2)

    def test_weak_needs_two_windows(self):
        self.assertEqual(self.a.update(0, [("Ringtone", 0.35)]), [])
        out = self.a.update(0.5, [("Telephone bell ringing", 0.32)])
        self.assertEqual(out[0][2]["kind"], "phone")

    def test_weak_with_gap_ignored(self):
        self.a.update(0, [("Ringtone", 0.35)])
        self.a.update(0.5, [("Speech", 0.9)])
        self.assertEqual(self.a.update(1.0, [("Ringtone", 0.35)]), [])

    def test_unrelated_sounds_ignored(self):
        self.assertEqual(self.a.update(0, [("Speech", 0.95), ("Music", 0.9), ("Duck", 0.8)]), [])

    def test_case_insensitive_and_best_label(self):
        out = self.a.update(0, [("smoke detector, smoke alarm", 0.6), ("Siren", 0.55)])
        self.assertEqual(out[0][2], {"kind": "alarm", "label": "smoke detector, smoke alarm", "score": 0.6})

    def test_two_groups_at_once(self):
        out = self.a.update(0, [("Doorbell", 0.7), ("Shout", 0.6)])
        self.assertEqual(sorted(a[1] for a in out if a[0] == "led"), ["calling", "doorbell"])

    def test_muted_while_duck_speaks(self):
        self.assertEqual(self.a.update(0, [("Doorbell", 0.9)], muted=True), [])

    def test_disabled(self):
        self.a.settings["sound_alerts_enabled"] = False
        self.assertEqual(self.a.update(0, [("Doorbell", 0.9)]), [])


if __name__ == "__main__":
    unittest.main()
