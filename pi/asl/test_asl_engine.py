"""Fake-landmark tests for segmentation, features, classifiers and phrases.
Run: cd pi/asl && python3 -m unittest -v   (needs numpy only)

The "signs" here are made-up movements (an open hand circling, a pointing hand
tapping the chin, two fists moving apart), each recorded with random speed,
size, position and jitter, which is enough to check the whole pipeline.
"""

import json
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(1, str(HERE.parent / "posture"))  # holistic.py uses judge.py / pose.py

from asl_engine import AslEngine, Config, PhraseBuilder, Segmenter, WordSignReader  # noqa: E402
from holistic import to_points  # noqa: E402
from classifier import MlpClassifier, TemplateClassifier, load_classifier, train  # noqa: E402
from features import FRAMES, N_FEATURES, sequence_features  # noqa: E402
from landmarks import LEFT_HAND, RIGHT_HAND, mirror, result_to_array  # noqa: E402

FPS = 15


# ---- a fake signer -------------------------------------------------------------
def hand_shape(kind, size):
    """21 points relative to the wrist, roughly like a real hand pointing up."""
    pts = np.zeros((21, 3))
    fingers = [(1, 2, 3, 4), (5, 6, 7, 8), (9, 10, 11, 12), (13, 14, 15, 16), (17, 18, 19, 20)]
    for f, joints in enumerate(fingers):
        angle = np.radians(-50 + f * 25)
        for k, j in enumerate(joints):
            if kind == "open" or (kind == "point" and f == 1):
                reach = 0.35 + 0.3 * k
            else:  # curled into a fist
                reach = 0.35 + 0.08 * k
            pts[j, 0] = np.sin(angle) * reach * size
            pts[j, 1] = -np.cos(angle) * reach * size
    pts[9, :2] = (0, -0.35 * size)  # middle-finger knuckle sets the hand size
    return pts


def frame(person, right=None, left=None):
    """right/left = (wrist_x, wrist_y, shape) in image units, or None = hand down/hidden."""
    cx, cy, s = person
    f = np.full((75, 3), np.nan, dtype=np.float32)
    f[:, 2] = np.nan
    # Upper body: nose, shoulders, elbows.
    f[0] = (cx, cy - 0.9 * s, 0)
    f[11] = (cx + 0.5 * s, cy, 0)  # person's left shoulder is on image right
    f[12] = (cx - 0.5 * s, cy, 0)
    f[13] = (cx + 0.7 * s, cy + 0.8 * s, 0)
    f[14] = (cx - 0.7 * s, cy + 0.8 * s, 0)
    for side, h, start, wrist_row in (("right", right, RIGHT_HAND, 16), ("left", left, LEFT_HAND, 15)):
        if h is None:
            continue
        x, y, kind = h
        f[start : start + 21] = hand_shape(kind, 0.5 * s) + (x, y, 0)
        f[wrist_row] = (x, y, 0)
    return f


def sign_frames(name, rng, person=(0.5, 0.45, 0.2), left_handed=False):
    """One noisy performance of a made-up sign, hands up the whole time."""
    cx, cy, s = person
    n = int(FPS * rng.uniform(0.8, 1.3))
    t = np.linspace(0, 1, n)
    amp = rng.uniform(0.85, 1.15)
    out = []
    for u in t:
        if name == "CIRCLE":
            r = (cx - 0.1 * s + 0.4 * s * amp * np.cos(2 * np.pi * u), cy + 0.8 * s + 0.4 * s * amp * np.sin(2 * np.pi * u), "open")
            l = None
        elif name == "CHIN":
            y = cy - 0.4 * s + 0.15 * s * amp * abs(np.sin(2 * np.pi * u))
            r, l = (cx - 0.05 * s, y, "point"), None
        elif name == "APART":
            d = (0.2 + 0.8 * u * amp) * s
            r, l = (cx - d, cy + 0.9 * s, "fist"), (cx + d, cy + 0.9 * s, "fist")
        elif name == "_other":  # wandering open hand: scratching, fixing hair...
            r, l = (cx + rng.normal(0, 0.5) * s, cy + rng.normal(-0.3, 0.6) * s, "open"), None
        out.append(frame(person, r, l))
    seq = np.stack(out)
    seq[..., :2] += rng.normal(0, 0.002, seq[..., :2].shape)
    return mirror(seq) + np.array([2 * cx, 0, 0], dtype=np.float32) if left_handed else seq


def random_person(rng):
    return (rng.uniform(0.4, 0.6), rng.uniform(0.4, 0.5), rng.uniform(0.15, 0.25))


def rest(person, n):
    return [frame(person) for _ in range(n)]  # hands down out of view


SIGNS = ["CIRCLE", "CHIN", "APART", "_other"]


def dataset(rng, per_sign):
    feats, labels, groups = [], [], []
    for name in SIGNS:
        for i in range(per_sign):
            raw = sign_frames(name, rng, random_person(rng))
            for v in (raw, mirror(raw)):
                feats.append(sequence_features(v))
                labels.append(name)
                groups.append(f"{name}{i}")
    return feats, labels, groups


# ---- tests -----------------------------------------------------------------------
class FeatureTest(unittest.TestCase):
    def test_shape_and_body_invariance(self):
        rng = np.random.default_rng(1)
        a = sign_frames("CIRCLE", np.random.default_rng(5), person=(0.5, 0.45, 0.2))
        b = sign_frames("CIRCLE", np.random.default_rng(5), person=(0.3, 0.5, 0.3))  # nearer, moved
        fa, fb = sequence_features(a), sequence_features(b)
        self.assertEqual(fa.shape, (FRAMES, N_FEATURES))
        self.assertLess(np.abs(fa - fb).max(), 0.15)
        del rng

    def test_mirror_twice_is_identity(self):
        a = sign_frames("APART", np.random.default_rng(2))
        np.testing.assert_allclose(mirror(mirror(a)), a)

    def test_no_shoulders_is_unusable(self):
        a = sign_frames("CHIN", np.random.default_rng(3))
        a[:, 11:13] = np.nan
        self.assertIsNone(sequence_features(a))

    def test_short_hand_dropout_is_filled(self):
        a = sign_frames("CHIN", np.random.default_rng(4))
        b = a.copy()
        b[5:7, RIGHT_HAND : RIGHT_HAND + 21] = np.nan  # 2 blurry frames
        self.assertLess(np.abs(sequence_features(a) - sequence_features(b)).max(), 0.2)


class SegmenterTest(unittest.TestCase):
    def run_stream(self, frames):
        seg, out = Segmenter(Config()), []
        for i, f in enumerate(frames):
            s = seg.update(f, i / FPS)
            if s is not None:
                out.append(s)
        return out

    def test_two_signs_with_rest_between(self):
        rng, p = np.random.default_rng(0), (0.5, 0.45, 0.2)
        a, b = sign_frames("CIRCLE", rng, p), sign_frames("CHIN", rng, p)
        segs = self.run_stream(rest(p, 10) + list(a) + rest(p, 15) + list(b) + rest(p, 15))
        self.assertEqual(len(segs), 2)
        self.assertLessEqual(abs(len(segs[0]) - len(a)), 8)

    def test_hands_on_desk_do_not_count(self):
        p = (0.5, 0.45, 0.2)
        typing = [frame(p, (0.45, 0.95, "fist"), (0.55, 0.95, "fist")) for _ in range(60)]
        self.assertEqual(self.run_stream(typing), [])

    def test_twitch_is_ignored(self):
        p = (0.5, 0.45, 0.2)
        blip = [frame(p, (0.5, 0.5, "open"))] * 3
        self.assertEqual(self.run_stream(rest(p, 5) + blip + rest(p, 15)), [])

    def test_hands_held_up_is_cut_once(self):
        p = (0.5, 0.45, 0.2)
        held = [frame(p, (0.5, 0.5, "open"))] * (FPS * 8)
        self.assertEqual(len(self.run_stream(held + rest(p, 10))), 1)


class ClassifierTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        rng = np.random.default_rng(0)
        cls.train_set = dataset(rng, per_sign=6)
        cls.rng = np.random.default_rng(99)

    def check(self, model, min_acc=0.9):
        hits = total = 0
        for name in SIGNS[:3]:
            for left in (False, True):  # right- and left-handed signers
                for _ in range(8):
                    pred = model.predict(sequence_features(sign_frames(name, self.rng, random_person(self.rng), left)))
                    hits += pred.label == name
                    total += 1
        self.assertGreaterEqual(hits / total, min_acc, f"{hits}/{total}")
        # "_other" movements are never reported as signs.
        others = [model.predict(sequence_features(sign_frames("_other", self.rng))).label for _ in range(10)]
        self.assertLessEqual(sum(o is not None for o in others), 2, others)

    def test_templates(self):
        model = TemplateClassifier().fit(*self.train_set)
        self.check(model)

    def test_templates_reject_unknown_motion(self):
        model = TemplateClassifier().fit(*self.train_set)
        p = (0.5, 0.45, 0.2)
        weird = np.stack([frame(p, (0.5 + 0.3 * np.sin(i), 0.2, "point"), (0.3, 0.2, "open")) for i in range(15)])
        self.assertIsNone(model.predict(sequence_features(weird)).label)

    def test_templates_save_load(self):
        model = TemplateClassifier().fit(*self.train_set)
        with tempfile.TemporaryDirectory() as d:
            model.save(Path(d) / "m.npz")
            again = load_classifier(Path(d) / "m.npz")
        f = sequence_features(sign_frames("CHIN", self.rng))
        self.assertEqual(model.predict(f).raw_label, again.predict(f).raw_label)

    def test_mlp(self):
        try:
            import sklearn  # noqa: F401
        except ImportError:
            self.skipTest("scikit-learn not installed")
        rng = np.random.default_rng(1)
        model = train(*dataset(rng, per_sign=15), kind="mlp")
        self.assertIsInstance(model, MlpClassifier)
        self.check(model, min_acc=0.85)


VOCAB = json.loads((HERE / "phrases.json").read_text())


class PhraseTest(unittest.TestCase):
    def setUp(self):
        self.pb = PhraseBuilder(VOCAB, Config())

    def say(self, *glosses):
        for i, g in enumerate(glosses):
            p = self.pb.add(g, now=i * 1.0)
            if p:
                return p
        self.assertIsNone(self.pb.tick(len(glosses) - 1 + 0.5, signing=False))  # too soon
        return self.pb.tick(len(glosses) + 2.0, signing=False)

    def test_two_sign_command(self):
        p = self.say("START", "FOCUS")
        self.assertEqual(p.text, "Let's start a focus session.")
        self.assertEqual(p.commands, ["start_focus"])

    def test_longest_match_then_leftovers(self):
        p = self.say("HELLO", "ME", "HELP")
        self.assertEqual(p.text, "Hello! I need help.")
        self.assertEqual(p.commands, ["help"])

    def test_unknown_sequence_falls_back_to_words(self):
        p = self.say("ME", "WATER", "PLEASE")
        self.assertEqual(p.text, "I need some water. please.")
        p = self.say("TIME", "YES")
        self.assertEqual(p.commands, ["time_left", "yes"])

    def test_stop_is_immediate(self):
        self.pb.add("FOCUS", 0)
        p = self.pb.add("STOP", 0.5)
        self.assertEqual(p.commands, ["stop"])
        self.assertEqual(self.pb.pending, [])

    def test_no_phrase_while_still_signing(self):
        self.pb.add("HELLO", 0)
        self.assertIsNone(self.pb.tick(5.0, signing=True))
        self.assertIsNotNone(self.pb.tick(5.0, signing=False))


class EngineTest(unittest.TestCase):
    def test_end_to_end_signs_to_command(self):
        rng = np.random.default_rng(0)
        # Pretend our made-up CIRCLE is START and CHIN is FOCUS.
        feats, labels, groups = dataset(rng, per_sign=6)
        rename = {"CIRCLE": "START", "CHIN": "FOCUS", "APART": "HELLO"}
        model = TemplateClassifier().fit(feats, [rename.get(l, l) for l in labels], groups)
        engine = AslEngine(model, VOCAB)
        p = (0.5, 0.45, 0.2)
        stream = rest(p, 10) + list(sign_frames("CIRCLE", rng, p)) + rest(p, 10) + \
            list(sign_frames("CHIN", rng, p)) + rest(p, 40)
        snaps = [engine.update(f, i / FPS) for i, f in enumerate(stream)]
        self.assertIn("signing", {s["status"] for s in snaps})
        final = snaps[-1]
        self.assertEqual(final["last_sign"]["gloss"], "FOCUS")
        self.assertEqual(final["phrase"]["commands"], ["start_focus"])
        self.assertEqual(final["phrase"]["glosses"], ["START", "FOCUS"])

    def test_recording_mode_saves_n_samples_then_stops(self):
        saved = []
        engine = AslEngine(None, VOCAB, on_sample=lambda g, s, who: saved.append((g, who, len(s))))
        engine.start_recording("HELLO", 2, "sara")
        rng, p = np.random.default_rng(0), (0.5, 0.45, 0.2)
        stream = []
        for _ in range(3):
            stream += rest(p, 10) + list(sign_frames("APART", rng, p))
        stream += rest(p, 10)
        for i, f in enumerate(stream):
            snap = engine.update(f, i / FPS)
        self.assertEqual([(g, w) for g, w, _ in saved], [("HELLO", "sara"), ("HELLO", "sara")])
        self.assertIsNone(snap["recording"])

    def test_no_person(self):
        engine = AslEngine(None, VOCAB)
        snap = engine.update(None, 10.0)
        self.assertEqual(snap["status"], "no_person")


class LandmarkTest(unittest.TestCase):
    def test_result_to_array(self):
        pt = lambda x, y, v=0.99: SimpleNamespace(x=x, y=y, z=0.0, visibility=v)  # noqa: E731
        result = SimpleNamespace(
            pose_landmarks=[pt(0.5, 0.5)] * 32 + [pt(0.5, 0.9, v=0.1)],
            left_hand_landmarks=[],
            right_hand_landmarks=[pt(0.25, 0.4)] * 21,
        )
        a = result_to_array(result, aspect=16 / 9)
        self.assertEqual(a.shape, (75, 3))
        self.assertAlmostEqual(float(a[0, 0]), 0.5 * 16 / 9, places=5)
        self.assertTrue(np.isnan(a[32, 0]))  # low-visibility pose point dropped
        self.assertTrue(np.isnan(a[LEFT_HAND, 0]))
        self.assertAlmostEqual(float(a[RIGHT_HAND, 1]), 0.4, places=5)

    def test_missing_visibility_keeps_points(self):
        result = SimpleNamespace(
            pose_landmarks=[SimpleNamespace(x=0.5, y=0.5, z=0.0, visibility=None)] * 33,
            left_hand_landmarks=[], right_hand_landmarks=[],
        )
        self.assertFalse(np.isnan(result_to_array(result)[:33, 0]).any())


class WordSignReaderTest(unittest.TestCase):
    """The duck.py adapter: duck.py's action tuples."""

    @classmethod
    def setUpClass(cls):
        rng = np.random.default_rng(0)
        feats, labels, groups = dataset(rng, per_sign=6)
        rename = {"CIRCLE": "START", "CHIN": "FOCUS", "APART": "HELLO"}
        cls.model = TemplateClassifier().fit(feats, [rename.get(l, l) for l in labels], groups)

    def setUp(self):
        self.settings = {"sign_enabled": True}
        self.reader = WordSignReader(AslEngine(self.model, VOCAB), self.settings)
        self.rng, self.p = np.random.default_rng(1), (0.5, 0.45, 0.2)

    def feed(self, stream, start=0.0):
        out = []
        for i, f in enumerate(stream):
            out += self.reader.update(start + i / FPS, f)
        return out

    def test_sentence_becomes_sign_event_speech_and_command(self):
        p = self.p
        out = self.feed(rest(p, 10) + list(sign_frames("CIRCLE", self.rng, p)) + rest(p, 10)
                        + list(sign_frames("CHIN", self.rng, p)) + rest(p, 40))
        text = "Let's start a focus session."
        self.assertEqual(out, [
            ("led", "sign"), ("led", "sign"),
            ("event", "sign", {"text": text, "signs": ["START", "FOCUS"], "commands": ["start_focus"]}),
            ("speak", text), ("command", "start_focus"),
        ])

    def test_leaving_mid_sentence_still_says_it(self):
        p = self.p
        out = self.feed(rest(p, 10) + list(sign_frames("APART", self.rng, p)) + rest(p, 8))
        self.assertEqual(out, [("led", "sign")])          # waiting for the pause
        out = self.reader.finish()
        self.assertEqual(out[0], ("event", "sign", {"text": "Hello!", "signs": ["HELLO"], "commands": []}))
        self.assertEqual(self.reader.finish(), [])        # nothing new: nothing repeated

    def test_disabled_does_nothing(self):
        self.settings["sign_enabled"] = False
        p = self.p
        out = self.feed(rest(p, 10) + list(sign_frames("APART", self.rng, p)) + rest(p, 40))
        self.assertEqual(out, [])


class HolisticPointsTest(unittest.TestCase):
    def test_points_in_pixels_and_unset_visibility_counts_as_seen(self):
        lms = [SimpleNamespace(x=0.5, y=0.25, z=0.0, visibility=None)] * 33
        pts = to_points(lms, 640, 480)
        self.assertEqual((pts["left_ear"].x, pts["left_ear"].y, pts["left_ear"].visibility), (320, 120, 1.0))
        self.assertIsNone(to_points([], 640, 480))


class DatasetTest(unittest.TestCase):
    """Matching our glosses to public datasets (kaggle_to_samples.py, videos_to_samples.py --citizen)."""

    def test_names_and_aliases(self):
        from datasets import match_glosses
        found = match_glosses(["thank you", "mine / my", "food", "hello", "TV"],
                              ["THANK-YOU", "MY", "EAT", "HELLO", "HELP", "_other"])
        self.assertEqual(found, {"THANK-YOU": "thank you", "MY": "mine / my", "EAT": "food", "HELLO": "hello"})

    def test_citizen_csv_with_suffixed_glosses(self):
        from datasets import citizen_clips
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            (root / "videos").mkdir()
            (root / "splits").mkdir()
            lines = ["Participant ID,Video file,Gloss"]
            for who in ("P1", "P2"):
                for i, gloss in enumerate(("HELLO1", "THANKYOU", "BANANA")):
                    name = f"{who}-{i}.mp4"
                    (root / "videos" / name).touch()
                    lines.append(f"{who},{name},{gloss}")
            (root / "splits" / "train.csv").write_text("\n".join(lines))
            clips, missing = citizen_clips(root, ["HELLO", "THANK-YOU", "HELP", "_other"], per_sign=1)
        self.assertEqual(sorted(clips), ["HELLO", "THANK-YOU"])
        self.assertEqual(len(clips["HELLO"]), 1)
        self.assertEqual(missing, ["HELP"])

    def test_kaggle_parquet_to_frames(self):
        try:
            import pandas as pd
            import pyarrow  # noqa: F401
        except ImportError:
            self.skipTest("pandas/pyarrow not installed")
        from kaggle_to_samples import parquet_to_frames, pick_clips
        rows = []
        for frame in (20, 21):
            for kind, n in (("face", 468), ("pose", 33), ("left_hand", 21), ("right_hand", 21)):
                for i in range(n):
                    x = np.nan if kind == "left_hand" else 0.5 + i / 1000
                    rows.append({"frame": frame, "row_id": f"{frame}-{kind}-{i}", "type": kind,
                                 "landmark_index": i, "x": x, "y": 0.25, "z": 0.0})
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "1.parquet"
            pd.DataFrame(rows).to_parquet(path)
            seq = parquet_to_frames(path, aspect=2.0)
        self.assertEqual(seq.shape, (2, 75, 3))
        self.assertAlmostEqual(float(seq[0, 11, 0]), (0.5 + 11 / 1000) * 2.0, places=5)   # pose kept, x scaled
        self.assertTrue(np.isnan(seq[0, LEFT_HAND, 0]))                                     # missing hand stays NaN
        self.assertAlmostEqual(float(seq[1, RIGHT_HAND + 3, 0]), (0.5 + 3 / 1000) * 2.0, places=5)

        clips = [{"sign": "hello", "participant_id": p, "sequence_id": str(i)} for p in "AAAB" for i in range(1)]
        picked = pick_clips(clips + [{"sign": "tv", "participant_id": "A"}], {"hello"}, per_sign=2)
        self.assertEqual([c["participant_id"] for c in picked["hello"]], ["A", "B"])   # one signer at a time


if __name__ == "__main__":
    unittest.main()
