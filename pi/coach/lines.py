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
# Gen Z voice (Akeen asked). Slang is spelled out ("for real", not "fr") because it's read aloud.
TEMPLATES = {
    "arrival": {   # right after the duck's own "welcome back", so no second greeting
        "gentle": ["Okay bestie, {title} is due {when}. Lowkey a great time to start, no pressure.",
                   "Heads up, {title} is due {when}. Small progress still counts, for real."],
        "coach": ["{title} is due {when}. We are locking in, no cap. First piece, right now.",
                  "Chat, {title} is due {when}. Future you is begging. Let's get this bread.",
                  "{title} is due {when}. Main character energy only. Open it up."],
        "savage": ["{title} is due {when} and you're just sitting there? It's giving cooked.",
                   "Oh, you showed up? Cute. {title} is due {when}, so maybe do it.",
                   "{title} is due {when}. Your aura is in the negatives until you start."],
    },
    "deadline": {
        "gentle": ["Friendly reminder, bestie: {title} is due {when}. You got this."],
        "coach": ["{title} is due {when}. Close the tabs, it's lock in o'clock.",
                  "Not gonna lie, {title} due {when} is a vibe check. Start with the easy part, now.",
                  "{title} is due {when}. Be so for real and open it."],
        "savage": ["{title} is due {when}. It is not gonna write itself, I checked. Twice.",
                   "{title} is due {when} and you're still delulu about having time. Start.",
                   "{title} is due {when}. Absolutely cooked if you don't move. Go."],
    },
    "event": {
        "gentle": ["{title} starts {when}. Wrap it up whenever you're ready, bestie."],
        "coach": ["{title} starts {when}. Save your stuff and slide.",
                  "{title} starts {when}. Pack it up, we're moving."],
        "savage": ["{title} starts {when}. Being late is not the aesthetic. Move.",
                   "{title} starts {when}. Chop chop, no NPC behavior."],
    },
    "checkin": {
        "gentle": ["{mins} minutes in. Lowkey proud of you. Keep that energy.",
                   "{mins} minutes in. How's it going, bestie? Stay with it."],
        "coach": ["{mins} minutes in. Are we locked in, or just vibing near the laptop? Pick one task and finish it.",
                  "Vibe check, {mins} minutes in. What's the one thing you're finishing next? Go.",
                  "{mins} minutes at the desk. Let's make it count, no cap."],
        "savage": ["{mins} minutes at the desk. Be honest, how much of that was doomscrolling?",
                   "{mins} minutes in and the work is giving untouched. Bruh.",
                   "{mins} minutes. If you opened TikTok even once, that's an L. Back to work."],
    },
    "idle": {
        "gentle": ["You've been still for {still} minutes. Stretch it out, then back in?"],
        "coach": ["{still} minutes without moving. You good? Stand up, reset, then one small step.",
                  "You've been frozen for {still} minutes. The brainrot is winning. Shake it off."],
        "savage": ["{still} minutes without moving. Are you working or buffering?",
                   "{still} minutes of zero movement. Blink twice if the assignment is holding you hostage."],
    },
    "focus_start": {
        "gentle": ["Okay, {focus} minutes of focus. I'll be quiet. You got this, bestie."],
        "coach": ["Locking in for {focus} minutes. Phone down, no cap. I'll tell you when it's done.",
                  "{focus} minutes of pure lock in. Let's cook."],
        "savage": ["{focus} minutes, no distractions. I'm watching. Always watching.",
                   "{focus} minutes. Touch your phone and I'm telling everyone."],
    },
    "focus_done": {
        "gentle": ["That's {worked} minutes of focus. You ate. Take a little break."],
        "coach": ["{worked} minutes done. That's a W. Take five, then we run it back.",
                  "{worked} minutes locked in. You ate that. Five minute break."],
        "savage": ["{worked} minutes. Okay, not bad. Five minute break, don't get comfortable.",
                   "{worked} minutes. Actually slay. Don't let it go to your head."],
    },
    "break_start": {
        "gentle": ["Break time. {brk} minutes. Hydrate, bestie."],
        "coach": ["{brk} minute break. Touch grass, drink water. I'll call you back."],
        "savage": ["{brk} minutes. I'm counting. Every second.",
                   "{brk} minute break. Minutes, not hours. I know you."],
    },
    "break_over": {
        "gentle": ["Break's over. Ready to get back to it?"],
        "coach": ["Break's over. We are so back. Lock in.",
                  "Break's over. Back in, no cap."],
        "savage": ["Break's over. Chair. Now.",
                   "Break's over. Put the phone down, I can hear you scrolling."],
    },
    "finish": {
        "gentle": ["Nice work today. Go rest, you earned it."],
        "coach": ["Done. Good session, you ate. Future you says thanks.",
                  "That's a wrap. Huge W today."],
        "savage": ["Done already? Fine. Lowkey proud of you.",
                   "Logging off? Okay, you earned it. Barely."],
    },
    "more_time": {
        "gentle": ["Sure, {added} more minutes. {left} to go."],
        "coach": ["Bet, adding {added} minutes. {left} left. Make them count."],
        "savage": ["{added} more minutes. Last extension, I mean it this time."],
    },
    "time_left": {
        "gentle": ["{left} minutes left. You're doing great."],
        "coach": ["{left} minutes left. Keep cooking."],
        "savage": ["{left} minutes. Eyes on the work, not on me."],
    },
}
NO_SESSION = "There's no timer running, bestie. Sign START FOCUS or say, hey duck, let's lock in."


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
