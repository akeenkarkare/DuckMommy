"""Turn a coach nudge (kind + facts) into one spoken line.

  writer = LineWriter(relay_http_url, token, settings)
  writer.write("deadline", facts, on_line)      # never blocks; on_line(text, source) later

First choice: the relay's POST /nudge, which asks Claude for a short, specific,
persuasive line (key stays on the laptop). If that fails or takes too long, a local
template is used, so the duck keeps coaching with no internet. Stdlib only.
"""

from __future__ import annotations

import json
import queue
import random
import sys
import threading
import urllib.request

NUDGE_TIMEOUT_S = 8
TONES = ("gentle", "coach", "savage")


def log(msg: str):
    print(f"# coach: {msg}", file=sys.stderr, flush=True)


def human_when(minutes: float | None, all_day: bool = False) -> str:
    if minutes is None:
        return "soon"
    m = max(0, round(minutes))
    if all_day and m >= 60:
        return "today" if m < 24 * 60 else "tomorrow" if m < 48 * 60 else f"in {round(m / 1440)} days"
    if m < 2:
        return "right now"
    if m < 60:
        return f"in {m} minutes"
    if m < 100:
        return "in about an hour"
    if m < 24 * 60:
        return f"in {round(m / 60)} hours"
    if m < 48 * 60:
        return "tomorrow"
    return f"in {round(m / 1440)} days"


# {title} {when} {mins} {focus} {left} {worked} {still} {brk} {added}
TEMPLATES = {
    "arrival": {   # right after the duck's own "welcome back", so no second greeting
        "gentle": ["Heads up, {title} is due {when}. Want to make a little progress on it?"],
        "coach": ["Today's mission: {title}, due {when}. Let's lock in and knock out the first piece.",
                  "{title} is due {when}. Future you is counting on the next half hour."],
        "savage": ["{title} is due {when}. So, are we working or decorating the chair?"],
    },
    "deadline": {
        "gentle": ["Just a heads up: {title} is due {when}."],
        "coach": ["{title} is due {when}. Close the extra tabs and give me one focused block.",
                  "Clock check: {title}, due {when}. Start with the easiest part, right now."],
        "savage": ["{title} is due {when}. It is not going to write itself, I checked."],
    },
    "event": {
        "gentle": ["{title} starts {when}. Time to wrap up what you're doing."],
        "coach": ["{title} starts {when}. Save your work and get ready."],
        "savage": ["{title} starts {when}. Move it."],
    },
    "checkin": {
        "gentle": ["You've been at it {mins} minutes. How's it going? Stay with it."],
        "coach": ["{mins} minutes in. Are you locked in, or just near your laptop? Pick one task and finish it.",
                  "Check in: what's the one thing you'll finish in the next 25 minutes? Go."],
        "savage": ["{mins} minutes at the desk. Be honest, how much of that was actual work?"],
    },
    "idle": {
        "gentle": ["You've been still for {still} minutes. Stretch, then back in?"],
        "coach": ["You've gone quiet for {still} minutes. Zoned out? Stand up, reset, then one small step."],
        "savage": ["{still} minutes without moving. Are you working or buffering?"],
    },
    "focus_start": {
        "gentle": ["Okay, {focus} minutes of focus. I'll keep quiet. You've got this."],
        "coach": ["Locking in for {focus} minutes. Phone down. I'll tell you when it's done."],
        "savage": ["{focus} minutes, no distractions. I'm watching."],
    },
    "focus_done": {
        "gentle": ["That's {worked} minutes of focus. Nice work. Take a short break."],
        "coach": ["{worked} minutes done. That's real progress. Take five, then we go again."],
        "savage": ["{worked} minutes. Not bad. Five minute break, don't get comfortable."],
    },
    "break_start": {
        "gentle": ["Break time. {brk} minutes. I'll let you know."],
        "coach": ["{brk} minute break. Stand up, drink some water. I'll call you back."],
        "savage": ["{brk} minutes. I'm counting."],
    },
    "break_over": {
        "gentle": ["Break's over. Ready to get back to it?"],
        "coach": ["Break's over. Back in. Pick up exactly where you left off."],
        "savage": ["Break's over. Chair. Now."],
    },
    "finish": {
        "gentle": ["Nice work today. Rest up."],
        "coach": ["Done. Good session. Future you says thanks."],
        "savage": ["Done already? Fine. Good work."],
    },
    "more_time": {
        "gentle": ["Sure, {added} more minutes. {left} to go."],
        "coach": ["Adding {added} minutes. {left} left. Make them count."],
        "savage": ["{added} more minutes. Last extension."],
    },
    "time_left": {
        "gentle": ["{left} minutes left."],
        "coach": ["{left} minutes left. Keep going."],
        "savage": ["{left} minutes. Eyes on the work."],
    },
}
NO_SESSION = "There's no timer running. Sign START FOCUS when you're ready to lock in."


def fallback_line(kind: str, facts: dict, tone: str = "coach", rng=random) -> str:
    tone = tone if tone in TONES else "coach"
    if kind == "time_left" and facts.get("left_minutes") is None:
        return NO_SESSION
    item = facts.get("item") or (facts.get("next") or [None])[0] or {}
    if kind in ("arrival", "deadline", "event") and not item.get("title"):
        kind = "checkin"
    options = TEMPLATES.get(kind, TEMPLATES["checkin"])
    text = rng.choice(options.get(tone) or options["coach"])
    return text.format(
        title=item.get("title", "your work"), when=human_when(item.get("in_minutes"), item.get("all_day", False)),
        mins=facts.get("minutes_at_desk") or 0, focus=facts.get("focus_minutes", 25),
        left=facts.get("left_minutes") if facts.get("left_minutes") is not None else facts.get("focus_minutes_left", 0),
        worked=facts.get("worked_minutes") or 0, still=facts.get("still_minutes", 5),
        brk=facts.get("break_minutes", 5), added=facts.get("added_minutes", 10),
    )


class LineWriter:
    def __init__(self, nudge_url: str | None, token: str | None, settings: dict):
        self.url, self.token, self.settings = nudge_url, token, settings
        self._queue: queue.Queue = queue.Queue(maxsize=3)
        self._down = False
        threading.Thread(target=self._worker, daemon=True, name="coach").start()

    def write(self, kind: str, facts: dict, on_line):
        try:
            self._queue.put_nowait((kind, facts, on_line))
        except queue.Full:
            log(f"busy, dropped {kind}")

    def _tone(self) -> str:
        tone = self.settings.get("coach_tone") or "coach"
        return tone if tone in TONES else "coach"

    def _ask_relay(self, kind: str, facts: dict) -> str | None:
        if not self.url:
            return None
        body = json.dumps({"kind": kind, "tone": self._tone(), "facts": facts}).encode()
        req = urllib.request.Request(self.url, data=body, method="POST", headers={
            "content-type": "application/json", "authorization": f"Bearer {self.token}"})
        try:
            with urllib.request.urlopen(req, timeout=NUDGE_TIMEOUT_S) as r:
                text = str(json.loads(r.read()).get("text") or "").strip()
        except Exception as e:
            if not self._down:
                self._down = True
                hint = " (ANTHROPIC_API_KEY not set in backend/.env?)" if "503" in str(e) else ""
                log(f"AI lines unavailable: {e}{hint}. Using templates until it's back")
            return None
        if self._down:
            self._down = False
            log("AI lines are back")
        return text[:220] or None

    def _worker(self):
        while True:
            kind, facts, on_line = self._queue.get()
            text = self._ask_relay(kind, facts)
            source = "ai"
            if not text:
                text, source = fallback_line(kind, facts, self._tone()), "template"
            try:
                on_line(text, source)
            except Exception as e:   # never kill the writer thread
                log(f"on_line failed: {e}")
