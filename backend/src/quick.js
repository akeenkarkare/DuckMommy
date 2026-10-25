// Fast path for the commands people say most: plain word matching, no Claude call (~2 s saved).
// Anything not matched here goes to Claude (memory.js understand) as before.

const WAKE = /\b(duck|ducky|doc|doctor|dock|dog|doug|duke|dark|duc|dukh|tuck)\b/i;

/** Did the transcript address the duck at all? (STT spells the wake word many ways.) */
export const mentionsDuck = (text) => WAKE.test(String(text ?? ''));

/** The words after the last wake phrase, lower case, no punctuation. */
function command(text) {
  const t = String(text ?? '').toLowerCase().replace(/[^a-z0-9' ]+/g, ' ');
  const words = t.split(/\s+/).filter(Boolean);
  let start = 0;
  words.forEach((w, i) => { if (WAKE.test(w)) start = i + 1; });
  return words.slice(start).join(' ');
}

const blank = { intent: 'other', memory: '', question: '', reminder: '', remind_at: '', focus: '', sentry: '', reply: '' };

/** A `understand()`-shaped result for a simple command, or null to ask Claude. */
export function quickIntent(text, { now = Date.now(), tz = 'UTC' } = {}) {
  const c = command(text);
  if (!c || c.split(' ').length > 12) return null;   // long or complex: let Claude read it

  if (/\b(sentry|guard (mode|my desk))\b/.test(c)) {
    const off = /\b(off|disable|stop|deactivate|disarm|cancel)\b/.test(c);
    const on = /\b(on|enable|start|activate|arm|turn it on)\b/.test(c);
    if (off !== on) return { ...blank, intent: 'sentry', sentry: on ? 'on' : 'off' };
    return null;
  }
  if (/\b(lock(ing)? in|start (a |the )?(focus|pomodoro)|focus (mode|session|time)( on)?|pomodoro)\b/.test(c)
      && !/\b(off|stop|end|done)\b/.test(c)) return { ...blank, intent: 'focus', focus: 'start_focus' };
  if (/\b(tak(e|ing) a break|break time|i need a break)\b/.test(c)) return { ...blank, intent: 'focus', focus: 'break' };
  if (/\b(how much time|time (is )?left|how long (is )?left)\b/.test(c)) return { ...blank, intent: 'focus', focus: 'time_left' };
  if (/\b(more time|extra time|add (ten|five|\d+) minutes)\b/.test(c)) return { ...blank, intent: 'focus', focus: 'more_time' };
  if (/\b(stop|end|finish) (the |my )?(focus|session|timer)\b|\bi'?m done\b/.test(c)) return { ...blank, intent: 'focus', focus: 'finish' };
  if (/\bwhat time is it\b|\bwhat'?s the time\b/.test(c)) {
    const time = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(now);
    return { ...blank, reply: `It's ${time}, bestie.` };
  }
  return null;
}
