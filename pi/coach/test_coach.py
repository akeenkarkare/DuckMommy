"""Run: cd pi/coach && python3 -m unittest -v   (stdlib only)"""

import json
import random
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer

from coach import (ARRIVAL_DELAY_S, MIN_GAP_S, STILL_NUDGE_S, Coach)
from lines import LineWriter, TEMPLATES, fallback_line, human_when

WALL0 = 1_800_000_000.0          # a fixed "now" in epoch seconds
SETTINGS = {"coach_enabled": True, "coach_interval_min": 25, "coach_tone": "coach"}


def item(title, minutes_from_now, kind="due", all_day=False, id=None):
    return {"id": id or title, "title": title, "kind": kind, "all_day": all_day,
            "start": (WALL0 + minutes_from_now * 60) * 1000, "end": None}


def run(coach, t0, seconds, step=1.0, **kw):
    """Advance both clocks together; return [(t, kind, facts)]."""
    out, t = [], t0
    while t < t0 + seconds:
        for a in coach.update(t, WALL0 + t, **kw):
            out.append((t, a[1], a[2]))
        t += step
    return t, out


def kinds(out):
    return [k for _, k, _ in out]


def make(settings=None, agenda=()):
    c = Coach(dict(settings or SETTINGS), rng=lambda: 0.5)   # no jitter
    c.set_agenda(list(agenda))
    c.on_arrive(0)
    return c


class StayQuiet(unittest.TestCase):
    def test_nothing_when_disabled(self):
        c = make({**SETTINGS, "coach_enabled": False}, [item("HW3", 30)])
        _, out = run(c, 0, 3600)
        self.assertEqual(out, [])

    def test_nothing_when_nobody_is_there(self):
        c = Coach(dict(SETTINGS))
        c.set_agenda([item("HW3", 30)])
        _, out = run(c, 0, 3600)
        self.assertEqual(out, [])

    def test_quiet_defers_instead_of_dropping(self):
        c = make(agenda=[item("HW3", 120)])
        _, out = run(c, 0, 60, quiet=True)
        self.assertEqual(out, [])
        _, out = run(c, 60, 5)
        self.assertEqual(kinds(out), ["arrival"])

    def test_lines_are_spaced_out(self):
        c = make(agenda=[item("A", 100), item("B", 170, id="b"), item("C", 50, id="c")])
        _, out = run(c, 0, 1800, step=1)
        times = [t for t, _, _ in out]
        self.assertTrue(all(b - a >= MIN_GAP_S for a, b in zip(times, times[1:])), times)


class StepIn(unittest.TestCase):
    def test_arrival_brief_mentions_whats_due_today(self):
        c = make(agenda=[item("Lab report", 300)])
        _, out = run(c, 0, ARRIVAL_DELAY_S + 2)
        self.assertEqual(kinds(out), ["arrival"])
        self.assertEqual(out[0][2]["next"][0]["title"], "Lab report")

    def test_no_second_brief_after_a_short_break(self):
        c = make(agenda=[item("Lab report", 300)])
        t, out = run(c, 0, ARRIVAL_DELAY_S + 2)
        c.on_leave(t)
        c.on_arrive(t + 300)                                 # back after 5 min
        _, out2 = run(c, t + 300, ARRIVAL_DELAY_S + MIN_GAP_S)
        self.assertEqual(kinds(out), ["arrival"])
        self.assertNotIn("arrival", kinds(out2))

    def test_new_brief_when_the_agenda_changed(self):
        c = make(agenda=[item("Lab report", 300)])
        t, _ = run(c, 0, ARRIVAL_DELAY_S + 2)
        c.on_leave(t)
        c.set_agenda([item("Lab report", 300), item("Quiz", 600, id="quiz")])
        c.on_arrive(t + 300)
        _, out = run(c, t + 300, ARRIVAL_DELAY_S + MIN_GAP_S)
        self.assertIn("arrival", kinds(out))

    def test_no_arrival_brief_with_an_empty_day(self):
        c = make(agenda=[item("Far away", 5 * 24 * 60)])
        _, out = run(c, 0, 120)
        self.assertEqual(out, [])

    def test_arrival_covers_the_deadline_so_it_isnt_repeated(self):
        c = make(agenda=[item("Lab report", 300)])
        _, out = run(c, 0, 3000)
        self.assertEqual(kinds(out).count("deadline"), 0)   # 3 h threshold already covered...
        self.assertIn("checkin", kinds(out))                # ...but life goes on

    def test_deadline_crossing_fires_once_per_threshold(self):
        c = make(agenda=[item("Essay", 200)])
        c._arrival_pending = False                          # skip the arrival brief
        _, out = run(c, 0, 200 * 60, step=10)
        deadlines = [f["item"]["in_minutes"] for _, k, f in out if k == "deadline"]
        # first heard of at 200 min (and 3 h is too close to repeat), then 1 h, then 15 min
        self.assertEqual(len(deadlines), 3, deadlines)
        self.assertTrue(deadlines[0] == 200 and 55 <= deadlines[1] <= 60 and 10 <= deadlines[2] <= 15, deadlines)

    def test_far_deadline_gets_each_threshold(self):
        c = make(agenda=[item("Project", 25 * 60)])
        c._arrival_pending = False
        _, out = run(c, 0, 25 * 60 * 60, step=60)
        deadlines = [f["item"]["in_minutes"] for _, k, f in out if k == "deadline"]
        self.assertEqual(len(deadlines), 4, deadlines)      # 24 h, 3 h, 1 h, 15 min

    def test_event_heads_up_beats_the_gap(self):
        c = make(agenda=[item("CSE 320 lecture", 18, kind="event")])
        c._arrival_pending = False
        c._last_line = 0                                    # something was just said
        _, out = run(c, 1, 300, step=1)
        self.assertEqual(kinds(out), ["event"])
        self.assertLessEqual(out[0][2]["item"]["in_minutes"], 15)

    def test_all_day_events_dont_get_a_15_min_alarm(self):
        c = make(agenda=[item("Holiday", 10, kind="event", all_day=True)])
        c._arrival_pending = False
        _, out = run(c, 0, 600)
        self.assertNotIn("event", kinds(out))

    def test_past_items_are_ignored(self):
        c = make(agenda=[item("Old HW", -30)])
        _, out = run(c, 0, 600)
        self.assertEqual(out, [])

    def test_checkin_after_interval(self):
        c = make()
        _, out = run(c, 0, 25 * 60 + 5, step=5)
        self.assertEqual(kinds(out), ["checkin"])
        self.assertEqual(out[0][2]["minutes_at_desk"], 25)

    def test_idle_nudge_once_per_still_period(self):
        c = make()
        t, out = run(c, 0, 60, still_s=STILL_NUDGE_S + 1)
        t, out2 = run(c, t, 600, still_s=STILL_NUDGE_S + 100)
        self.assertEqual(kinds(out + out2), ["idle"])
        t, _ = run(c, t, 5, still_s=5)                      # moved
        _, out3 = run(c, t + MIN_GAP_S, 5, still_s=STILL_NUDGE_S + 1)
        self.assertEqual(kinds(out3), ["idle"])

    def test_idle_nudge_rearms_only_after_moving(self):
        c = make()
        out, t = [], 0
        for still in range(STILL_NUDGE_S, STILL_NUDGE_S + 2000, 1):   # still the whole time
            out += [a[1] for a in c.update(t, WALL0 + t, still_s=still)]
            t += 1
        self.assertEqual(out.count("idle"), 1)

    def test_interval_setting_is_live(self):
        c = make({**SETTINGS, "coach_interval_min": 10})
        _, out = run(c, 0, 11 * 60, step=5)
        self.assertEqual(kinds(out), ["checkin"])


class FocusSessions(unittest.TestCase):
    def test_focus_session_is_quiet_then_reports(self):
        c = make()
        reply = c.command("start_focus", 0, WALL0)
        self.assertEqual(reply[0][1], "focus_start")
        self.assertEqual(reply[0][2]["focus_minutes"], 25)
        _, out = run(c, 1, 25 * 60 + 5, step=5)
        self.assertEqual(kinds(out), ["focus_done"])        # no check-in during the session
        self.assertEqual(out[0][2]["worked_minutes"], 25)

    def test_deadlines_still_get_through_during_focus(self):
        c = make(agenda=[item("Quiz", 70)])
        c._arrival_pending = False
        c.command("start_focus", 0, WALL0)
        _, out = run(c, MIN_GAP_S, 30 * 60, step=5)
        self.assertIn("deadline", kinds(out))

    def test_break_then_back_to_work(self):
        c = make()
        c.command("break", 0, WALL0)
        _, out = run(c, 1, 6 * 60, step=5, still_s=STILL_NUDGE_S + 10)
        self.assertEqual(kinds(out), ["break_over"])        # no "you're idle" during a break

    def test_more_time_and_time_left(self):
        c = make()
        c.command("start_focus", 0, WALL0)
        more = c.command("more_time", 60, WALL0 + 60)[0]
        self.assertEqual(more[2]["left_minutes"], 34)
        left = c.command("time_left", 120, WALL0 + 120)[0]
        self.assertEqual(left[2]["left_minutes"], 33)

    def test_time_left_without_a_session(self):
        c = make()
        facts = c.command("time_left", 0, WALL0)[0][2]
        self.assertIsNone(facts["left_minutes"])
        self.assertIn("no timer", fallback_line("time_left", facts).lower())

    def test_finish_ends_the_session(self):
        c = make()
        c.command("start_focus", 0, WALL0)
        self.assertEqual(c.command("finish", 600, WALL0 + 600)[0][2]["worked_minutes"], 10)
        self.assertIsNone(c.focus_until)

    def test_unknown_command_does_nothing(self):
        self.assertEqual(make().command("help", 0, WALL0), [])


class Lines(unittest.TestCase):
    def test_human_when(self):
        self.assertEqual(human_when(45), "in 45 minutes")
        self.assertEqual(human_when(70), "in about an hour")
        self.assertEqual(human_when(300), "in 5 hours")
        self.assertEqual(human_when(30 * 60), "tomorrow")
        self.assertEqual(human_when(300, all_day=True), "today")

    def test_every_template_formats_for_every_tone(self):
        facts = {"minutes_at_desk": 30, "next": [{"title": "HW3", "in_minutes": 90, "all_day": False}],
                 "item": {"title": "HW3", "in_minutes": 90, "all_day": False}, "focus_minutes": 25,
                 "left_minutes": 10, "worked_minutes": 25, "still_minutes": 5, "break_minutes": 5,
                 "added_minutes": 10}
        for kind in TEMPLATES:
            for tone in ("gentle", "coach", "savage", "bogus"):
                text = fallback_line(kind, facts, tone, rng=random.Random(0))
                self.assertNotIn("{", text, (kind, tone))
                self.assertTrue(text.strip())

    def test_deadline_without_an_item_becomes_a_checkin(self):
        text = fallback_line("deadline", {"minutes_at_desk": 3, "next": []}, rng=random.Random(0))
        self.assertNotIn("{", text)


class Writer(unittest.TestCase):
    def _serve(self, status, body):
        class H(BaseHTTPRequestHandler):
            def log_message(self, *a): pass

            def do_POST(self):
                H.got = json.loads(self.rfile.read(int(self.headers["content-length"])))
                H.auth = self.headers["authorization"]
                self.send_response(status)
                self.end_headers()
                self.wfile.write(json.dumps(body).encode())
        srv = HTTPServer(("127.0.0.1", 0), H)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        self.addCleanup(srv.shutdown)
        return f"http://127.0.0.1:{srv.server_port}/nudge", H

    def _write(self, url, kind="checkin", facts=None):
        done, got = threading.Event(), {}
        w = LineWriter(url, "tok", {"coach_tone": "savage"})
        w.write(kind, facts or {"minutes_at_desk": 30, "next": []},
                lambda text, src: (got.update(text=text, src=src), done.set()))
        self.assertTrue(done.wait(10))
        return got

    def test_uses_the_ai_line(self):
        url, H = self._serve(200, {"text": "Thirty minutes in. Show me something."})
        got = self._write(url)
        self.assertEqual(got, {"text": "Thirty minutes in. Show me something.", "src": "ai"})
        self.assertEqual(H.got["tone"], "savage")
        self.assertEqual(H.auth, "Bearer tok")

    def test_falls_back_when_relay_says_no(self):
        url, _ = self._serve(503, {})
        got = self._write(url)
        self.assertEqual(got["src"], "template")

    def test_falls_back_with_no_relay(self):
        self.assertEqual(self._write(None)["src"], "template")


if __name__ == "__main__":
    unittest.main()
