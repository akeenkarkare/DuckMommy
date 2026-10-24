"""Sound alerts: YAMNet labels -> "doorbell" / "phone" / ... -> LED. Stdlib only.

YAMNet (pi/sounds/listener.py) scores each ~1 s of audio against 521 AudioSet
classes. We only care about a few groups. A group fires when one window
scores >= STRONG, or two windows in a row score >= WEAK, then stays quiet for
COOLDOWN_S so one ringing phone is one alert.
Event value: {kind, label, score}
"""

from __future__ import annotations

# group -> YAMNet class names (exact AudioSet display names, matched lowercase)
GROUPS = {
    "doorbell": {"doorbell", "ding-dong", "knock"},
    "phone": {"telephone", "telephone bell ringing", "ringtone", "telephone dialing, dtmf"},
    "alarm": {"alarm", "alarm clock", "smoke detector, smoke alarm", "fire alarm", "siren",
              "civil defense siren", "buzzer", "beep, bleep"},
    "notification": {"ding", "chime", "bell", "jingle bell", "tuning fork"},
    "calling": {"shout", "yell", "children shouting", "screaming"},
}
# "beep, bleep" sits in alarm on purpose: smoke-alarm chirps are classed as beeps.

STRONG, WEAK = 0.5, 0.3
COOLDOWN_S = {"doorbell": 15, "phone": 20, "alarm": 30, "notification": 10, "calling": 10}

_LOOKUP = {name: group for group, names in GROUPS.items() for name in names}


class SoundAlerts:
    """update(now, [(label, score), ...]) per audio window -> actions:
    ("event", "sound", value), ("led", kind)."""

    def __init__(self, settings: dict):
        self.settings = settings
        self.prev: dict[str, float] = {}         # group -> best score in the previous window
        self.quiet_until: dict[str, float] = {}

    def update(self, now: float, categories: list[tuple[str, float]], muted: bool = False) -> list[tuple]:
        if muted or not self.settings.get("sound_alerts_enabled", True):
            self.prev = {}
            return []
        best: dict[str, tuple[float, str]] = {}
        for label, score in categories:
            group = _LOOKUP.get(label.lower())
            if group and score > best.get(group, (0.0, ""))[0]:
                best[group] = (score, label)

        actions = []
        for group, (score, label) in best.items():
            fire = score >= STRONG or (score >= WEAK and self.prev.get(group, 0.0) >= WEAK)
            if fire and now >= self.quiet_until.get(group, 0.0):
                self.quiet_until[group] = now + COOLDOWN_S[group]
                actions += [("event", "sound", {"kind": group, "label": label, "score": round(score, 2)}),
                            ("led", group)]
        self.prev = {g: s for g, (s, _) in best.items()}
        return actions
