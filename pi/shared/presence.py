"""Is someone at the desk? Stdlib only.

Fed either ultrasonic distance (update_distance) or "camera sees a person"
(update_seen). Hysteresis + hold times so a fidget doesn't flip it.
Returns "arrive", "leave" or None.
"""

from __future__ import annotations

NEAR_CM = 110      # closer than this = someone in the chair
FAR_CM = 140       # must go past this to count as gone (hysteresis)
ARRIVE_S = 1.5     # near this long -> arrived
LEAVE_S = 8.0      # far / unseen this long -> left


class Presence:
    def __init__(self):
        self.present = False
        self._since = None   # when the reading started disagreeing with `present`

    def update_distance(self, now: float, distance_cm: float | None) -> str | None:
        if distance_cm is None:
            return None
        near = distance_cm < (FAR_CM if self.present else NEAR_CM)
        return self.update_seen(now, near)

    def update_seen(self, now: float, near: bool) -> str | None:
        if near == self.present:
            self._since = None
            return None
        if self._since is None:
            self._since = now
        if now - self._since >= (ARRIVE_S if near else LEAVE_S):
            self.present, self._since = near, None
            return "arrive" if near else "leave"
        return None

    def force_away(self):
        """Mark nobody present now (e.g. no movement for a long time), without a leave timer."""
        self.present, self._since = False, None
