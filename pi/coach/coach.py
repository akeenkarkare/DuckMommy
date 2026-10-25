"""Lock-in coach: decides WHEN the duck should nudge you and WHAT it knows. Stdlib only.

Like Tomo, the trick is knowing when to step in and when to stay quiet:

  step in   arrival brief    you sat down and something is due today / starts soon
            deadline         a due date crossed 24 h / 3 h / 1 h / 15 min (once each)
            (calendar events are announced by the relay instead: 5 min before + at the start)
            checkin          you've been at the desk a while (coach_interval_min, +-20%)
            idle             no movement for 5 min (camera motion): zoned out?
            focus sessions   from the START/FOCUS signs (or a dashboard command):
                             quiet while you work, then "focus_done" / "break_over"
  stay quiet  coach_enabled off, nobody at the desk, the duck is already talking,
              less than MIN_GAP_S since the last coach line, posture calibration,
              and no check-ins during a focus session (deadlines still get through)

update() returns ("coach", kind, facts) actions. facts is a small dict of plain
values (titles, minutes) that lines.py turns into a spoken line, via the relay's
/nudge (Claude) or local templates when offline.

Agenda items (from the relay, see backend/src/calendar.js):
  {"id", "title", "kind": "due"|"event", "start": epoch ms, "end": epoch ms|None, "all_day": bool}
For "due" items, start is the due time.
"""

from __future__ import annotations

import random
import time

MIN_GAP_S = 15 * 60          # between two coach lines (was 4 min: Akeen found it too chatty)
DEADLINE_GAP_S = 5 * 60      # a deadline crossing may come sooner after another line
CHECKIN_MIN_S = 45 * 60      # check-ins at most this often, whatever the focus length is
URGENT_GAP_S = 60            # event-starting-soon may cut the gap down to this
ARRIVAL_DELAY_S = 20         # let "welcome back" / "sit up tall" finish first
ARRIVAL_HORIZON_MIN = 24 * 60
ARRIVAL_REPEAT_S = 30 * 60   # back from a short break with the same agenda -> no second brief
DUE_THRESHOLDS_MIN = (180, 60, 15)   # the arrival brief already covers "due tomorrow"
EVENT_LEAD_MIN = 15
STILL_NUDGE_S = 300          # matches pi/motion IDLE_TIMEOUT_S
CHECKIN_JITTER = 0.2
BREAK_MIN = 5
MORE_TIME_MIN = 10
NEXT_ITEMS = 3

DEFAULTS = {"coach_enabled": True, "coach_interval_min": 25, "coach_tone": "coach"}


def time_of_day(wall: float) -> str:
    h = time.localtime(wall).tm_hour
    if 5 <= h < 12:
        return "morning"
    if 12 <= h < 17:
        return "afternoon"
    if 17 <= h < 22:
        return "evening"
    return "late night"


class Coach:
    def __init__(self, settings: dict, rng=random.random):
        self.settings = settings          # live dict pushed by the relay
        self.rng = rng
        self.agenda: list[dict] = []
        self._fired: set[tuple] = set()   # (item id, threshold or "event") already reminded
        self._last_line = float("-inf")
        self._arrived_at: float | None = None
        self._arrival_pending = False
        self._next_checkin: float | None = None
        self._still_nudged = False
        self._last_still: float | None = None
        self._last_brief: tuple[float, tuple] | None = None   # (when, item ids) of the last arrival brief
        self.focus_until: float | None = None    # monotonic end of the focus session
        self.break_until: float | None = None
        self._focus_started: float | None = None

    # ── settings ───────────────────────────────────────────────────────────
    def _get(self, key):
        value = self.settings.get(key)
        return DEFAULTS[key] if value is None else value

    @property
    def enabled(self) -> bool:
        return bool(self._get("coach_enabled"))

    @property
    def interval_s(self) -> float:
        return max(5, min(120, int(self._get("coach_interval_min")))) * 60

    # ── inputs ─────────────────────────────────────────────────────────────
    def set_agenda(self, items: list[dict]):
        clean = []
        for it in items or []:
            try:
                clean.append({
                    "id": str(it.get("id") or it["title"]), "title": str(it["title"])[:80],
                    "kind": "due" if it.get("kind") == "due" else "event",
                    "start": float(it["start"]), "end": None if it.get("end") is None else float(it["end"]),
                    "all_day": bool(it.get("all_day")),
                })
            except (KeyError, TypeError, ValueError):
                continue
        self.agenda = sorted(clean, key=lambda i: i["start"])

    def on_arrive(self, now: float):
        self._arrived_at = now
        self._arrival_pending = True
        self._still_nudged = False
        self._schedule_checkin(now)

    def on_leave(self, now: float):
        self._arrived_at = None
        self._arrival_pending = False
        self._next_checkin = None

    @property
    def present(self) -> bool:
        return self._arrived_at is not None

    # ── focus sessions (signs / dashboard) ─────────────────────────────────
    def command(self, name: str, now: float, wall: float) -> list[tuple]:
        """Sign or dashboard command -> immediate reply actions (not rate-limited)."""
        if name == "start_focus":
            mins = self.interval_s / 60
            self.focus_until, self.break_until, self._focus_started = now + self.interval_s, None, now
            return self._line(now, "focus_start", wall, {"focus_minutes": round(mins)})
        if name == "break":
            self.focus_until, self.break_until = None, now + BREAK_MIN * 60
            return self._line(now, "break_start", wall, {"break_minutes": BREAK_MIN})
        if name == "finish":
            worked = None if self._focus_started is None else round((now - self._focus_started) / 60)
            self.focus_until = self.break_until = self._focus_started = None
            return self._line(now, "finish", wall, {"worked_minutes": worked})
        if name == "more_time" and self.focus_until is not None:
            self.focus_until += MORE_TIME_MIN * 60
            return self._line(now, "more_time", wall, {"added_minutes": MORE_TIME_MIN,
                                                       "left_minutes": round((self.focus_until - now) / 60)})
        if name == "time_left":
            left = None
            if self.focus_until is not None:
                left = max(0, round((self.focus_until - now) / 60))
            elif self.break_until is not None:
                left = max(0, round((self.break_until - now) / 60))
            return self._line(now, "time_left", wall, {"left_minutes": left,
                                                       "in_focus": self.focus_until is not None})
        return []

    # ── the decision ───────────────────────────────────────────────────────
    def update(self, now: float, wall: float, *, quiet: bool = False,
               still_s: float | None = None, slouches: int = 0) -> list[tuple]:
        """now: monotonic s. wall: epoch s. quiet: the duck is talking / calibrating."""
        if still_s is not None:
            if self._last_still is not None and still_s < self._last_still - 1:
                self._still_nudged = False      # the stillness clock restarted: they moved
            self._last_still = still_s
        if not self.enabled or not self.present or quiet:
            return []
        since = now - self._last_line
        ctx = {"slouches": slouches, "still_s": still_s}

        # Timers you asked for always land (they're answers, not interruptions).
        if self.focus_until is not None and now >= self.focus_until:
            started = now if self._focus_started is None else self._focus_started
            worked = round((now - started) / 60)
            self.focus_until, self._focus_started = None, None
            self._next_checkin = now + self.checkin_s
            return self._line(now, "focus_done", wall, {"worked_minutes": worked}, ctx)
        if self.break_until is not None and now >= self.break_until:
            self.break_until = None
            return self._line(now, "break_over", wall, {}, ctx)

        soon = self._event_soon(wall)
        if soon and since >= URGENT_GAP_S:
            self._fired.add((soon["id"], "event"))
            return self._line(now, "event", wall, {"item": self._brief(soon, wall)}, ctx)
        due = self._due_crossed(wall) if since >= DEADLINE_GAP_S else None
        if since < MIN_GAP_S and not due:
            return []

        if self._arrival_pending:
            if now - self._arrived_at < ARRIVAL_DELAY_S:
                return []   # hold everything until the arrival brief
            self._arrival_pending = False
            upcoming = [i for i in self._upcoming(wall) if self._minutes_until(i, wall) <= ARRIVAL_HORIZON_MIN]
            ids = tuple(i["id"] for i in upcoming)
            repeat = (self._last_brief is not None and self._last_brief[1] == ids
                      and now - self._last_brief[0] < ARRIVAL_REPEAT_S)
            if upcoming and not repeat:
                for item in upcoming:
                    self._mark_due_fired(item, wall)
                self._last_brief = (now, ids)
                return self._line(now, "arrival", wall, {}, ctx)

        if due:
            for item in self._upcoming(wall):   # one line covers every deadline crossing right now,
                self._mark_due_fired(item, wall)   # not one line per item, four minutes apart
            return self._line(now, "deadline", wall, {"item": self._brief(due, wall)}, ctx)

        if (still_s is not None and still_s >= STILL_NUDGE_S and not self._still_nudged
                and self.break_until is None):
            self._still_nudged = True
            return self._line(now, "idle", wall, {"still_minutes": round(still_s / 60)}, ctx)

        in_session = self.focus_until is not None or self.break_until is not None
        if not in_session and self._next_checkin is not None and now >= self._next_checkin:
            self._schedule_checkin(now)
            return self._line(now, "checkin", wall, {}, ctx)
        return []

    # ── helpers ────────────────────────────────────────────────────────────
    @property
    def checkin_s(self) -> float:
        return max(self.interval_s, CHECKIN_MIN_S)

    def _schedule_checkin(self, now: float):
        jitter = 1 + CHECKIN_JITTER * (2 * self.rng() - 1)
        self._next_checkin = now + self.checkin_s * jitter

    @staticmethod
    def _minutes_until(item: dict, wall: float) -> float:
        return (item["start"] / 1000 - wall) / 60

    def _upcoming(self, wall: float) -> list[dict]:
        return [i for i in self.agenda if self._minutes_until(i, wall) > 0]

    def _brief(self, item: dict, wall: float) -> dict:
        return {"title": item["title"], "kind": item["kind"], "all_day": item["all_day"],
                "in_minutes": max(0, round(self._minutes_until(item, wall)))}

    def _event_soon(self, wall: float) -> dict | None:
        # Off: the relay says timed events 5 min before and at the start (backend/src/reminders.js),
        # so the coach would only repeat it. Deadlines ("due") are still the coach's job.
        return None
        for item in self._upcoming(wall):
            if (item["kind"] == "event" and not item["all_day"]
                    and self._minutes_until(item, wall) <= EVENT_LEAD_MIN
                    and (item["id"], "event") not in self._fired):
                return item
        return None

    def _due_crossed(self, wall: float) -> dict | None:
        for item in self._upcoming(wall):
            if item["kind"] != "due":
                continue
            left = self._minutes_until(item, wall)
            crossed = [t for t in DUE_THRESHOLDS_MIN if left <= t]
            if crossed and (item["id"], min(crossed)) not in self._fired:
                return item
        return None

    def _mark_due_fired(self, item: dict, wall: float):
        left = self._minutes_until(item, wall)
        for t in DUE_THRESHOLDS_MIN:
            # crossed, or so close that a second reminder would just be nagging (200 min -> skip 3 h)
            if left <= t or (left - t) < 0.25 * t:
                self._fired.add((item["id"], t))
        if item["kind"] == "event" and left <= EVENT_LEAD_MIN:
            self._fired.add((item["id"], "event"))

    def _line(self, now: float, kind: str, wall: float, extra: dict, ctx: dict | None = None) -> list[tuple]:
        self._last_line = now
        if self._next_checkin is not None and kind not in ("checkin", "focus_done"):
            self._next_checkin = max(self._next_checkin, now + self.checkin_s / 2)
        ctx = ctx or {}
        facts = {
            "time_of_day": time_of_day(wall),
            "minutes_at_desk": None if self._arrived_at is None else round((now - self._arrived_at) / 60),
            "slouches_this_session": ctx.get("slouches", 0),
            "next": [self._brief(i, wall) for i in self._upcoming(wall)[:NEXT_ITEMS]],
            **extra,
        }
        if self.focus_until is not None:
            facts["focus_minutes_left"] = max(0, round((self.focus_until - now) / 60))
        return [("coach", kind, facts)]
