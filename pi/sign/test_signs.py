"""python3 -m unittest -v   (from pi/sign; no camera or deps needed)"""

import unittest

import signs
from signs import KNN, SignReader, features, fingers_extended, join_signs, rule_label


def hand(thumb, index, middle, ring, pinky, thumb_down=False, dx=0.0, scale=1.0):
    """Synthetic upright right hand (image y down). Wrist at (100, 300)."""
    pts = [None] * 21
    pts[0] = (100, 300)
    for f, (x, ext) in enumerate(zip((80, 100, 120, 140), (index, middle, ring, pinky))):
        base = 5 + 4 * f
        pts[base] = (x, 220)                                   # MCP
        if ext:
            pts[base + 1], pts[base + 2], pts[base + 3] = (x, 180), (x, 150), (x, 120)
        else:                                                  # curled back toward the palm
            pts[base + 1], pts[base + 2], pts[base + 3] = (x, 190), (x, 215), (x, 235)
    pts[1], pts[2] = (85, 285), (65, 260)                      # CMC, MCP
    if thumb and thumb_down:
        pts[3], pts[4] = (60, 290), (58, 330)
    elif thumb and index == middle == ring == pinky == 0:       # thumbs up
        pts[3], pts[4] = (62, 225), (60, 185)
    elif thumb:                                                # out to the side
        pts[3], pts[4] = (45, 245), (25, 230)
    else:                                                      # tucked across the palm
        pts[3], pts[4] = (95, 245), (120, 240)
    return [((x - 100) * scale + 100 + dx, (y - 300) * scale + 300) for x, y in pts]


class TestRules(unittest.TestCase):
    def test_finger_states(self):
        self.assertEqual(fingers_extended(hand(1, 1, 1, 1, 1)), (1, 1, 1, 1, 1))
        self.assertEqual(fingers_extended(hand(0, 0, 0, 0, 0)), (0, 0, 0, 0, 0))
        self.assertEqual(fingers_extended(hand(1, 1, 0, 0, 1)), (1, 1, 0, 0, 1))
        self.assertEqual(fingers_extended(hand(0, 1, 1, 0, 0)), (0, 1, 1, 0, 0))

    def test_word_rules(self):
        self.assertEqual(rule_label(hand(1, 1, 1, 1, 1)), "hello")
        self.assertEqual(rule_label(hand(1, 1, 0, 0, 1)), "I love you")
        self.assertEqual(rule_label(hand(0, 1, 0, 0, 0)), "you")
        self.assertEqual(rule_label(hand(1, 0, 0, 0, 0)), "yes")
        self.assertEqual(rule_label(hand(1, 0, 0, 0, 0, thumb_down=True)), "no")
        self.assertIsNone(rule_label(hand(0, 1, 1, 0, 0)))     # V: not a built-in word

    def test_rules_ignore_position_and_size(self):
        self.assertEqual(rule_label(hand(1, 1, 0, 0, 1, dx=200, scale=0.4)), "I love you")


class TestKNN(unittest.TestCase):
    def setUp(self):
        self.knn = KNN({
            "V": [features(hand(0, 1, 1, 0, 0, dx=d)) for d in (0, 5, 10, -5, -10)],
            "W": [features(hand(0, 1, 1, 1, 0, dx=d)) for d in (0, 5, 10, -5, -10)],
        })

    def test_classifies_recorded_shapes(self):
        self.assertEqual(self.knn.classify(features(hand(0, 1, 1, 0, 0, dx=50, scale=0.7))), "V")
        self.assertEqual(self.knn.classify(features(hand(0, 1, 1, 1, 0, scale=1.5))), "W")

    def test_unknown_shape_rejected(self):
        self.assertIsNone(self.knn.classify(features(hand(1, 1, 1, 1, 1))))

    def test_left_hand_mirrored(self):
        right = features(hand(0, 1, 1, 0, 0))
        left = features([(200 - x, y) for x, y in hand(0, 1, 1, 0, 0)], "Left")
        for a, b in zip(right, left):
            self.assertAlmostEqual(a, b)


class TestJoin(unittest.TestCase):
    def test_words_and_spelling(self):
        self.assertEqual(join_signs(["hello", "D", "U", "C", "K"]), "hello duck")
        self.assertEqual(join_signs(["I love you"]), "I love you")
        self.assertEqual(join_signs(["H", "I", "you"]), "hi you")


class TestReader(unittest.TestCase):
    def setUp(self):
        self.r = SignReader({"sign_enabled": True})

    def feed(self, t, label, seconds, hand_seen=True, step=0.1):
        out = []
        for i in range(round(seconds / step)):
            out += self.r.update(t + i * step, label, hand_seen)
        return out, t + seconds

    def test_hold_then_drop_speaks(self):
        out, t = self.feed(0, "hello", 1.0)
        self.assertEqual(out, [])
        out, t = self.feed(t, None, 2.0, hand_seen=False)
        self.assertEqual(out, [("event", "sign", {"text": "hello", "signs": ["hello"]}), ("speak", "hello")])

    def test_brief_shape_ignored(self):
        out, t = self.feed(0, "hello", signs.HOLD_S / 2)
        out += self.feed(t, None, 2.0, hand_seen=False)[0]
        self.assertEqual(out, [])

    def test_held_sign_counts_once(self):
        out, t = self.feed(0, "yes", 3.0)
        out += self.feed(t, None, 2.0, hand_seen=False)[0]
        self.assertEqual(out[0][2]["signs"], ["yes"])

    def test_fingerspelling_with_transitions(self):
        t = 0
        for letter in "DUCK":
            t = self.feed(t, letter, 0.8)[1]
            t = self.feed(t, None, 0.3)[1]          # hand still up, between letters
        out, _ = self.feed(t, None, 2.0, hand_seen=False)
        self.assertEqual(out[0][2]["text"], "duck")

    def test_disabled_does_nothing(self):
        self.r.settings["sign_enabled"] = False
        out, t = self.feed(0, "hello", 1.0)
        out += self.feed(t, None, 2.0, hand_seen=False)[0]
        self.assertEqual(out, [])


if __name__ == "__main__":
    unittest.main()
