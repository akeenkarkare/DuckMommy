// Spoken calendar reminders for timed events: once 5 minutes before, once when it starts.
// Plain sentences (no AI). The relay calls these every few seconds for the duck's active user.

export const LEAD_MS = 5 * 60 * 1000;
const START_GRACE_MS = 2 * 60 * 1000;   // relay was down at start time? still say it within 2 min

const clean = (title) => String(title ?? '').replace(/\p{Extended_Pictographic}/gu, '').replace(/\s+/g, ' ').trim() || 'Your event';

/**
 * Which reminders are due now. `fired` is a Set of keys already spoken; it's updated.
 * Returns [{ key, when: "soon"|"now", title, start, text }].
 */
export function dueReminders(items, now, fired) {
  const out = [];
  for (const i of items ?? []) {
    if (i.kind !== 'event' || i.all_day || !Number.isFinite(i.start)) continue;
    const left = i.start - now;
    const soon = `${i.id}@${i.start}:soon`, start = `${i.id}@${i.start}:now`;
    if (left > 0 && left <= LEAD_MS && !fired.has(soon)) {
      fired.add(soon);
      out.push({ key: soon, when: 'soon', title: i.title, start: i.start, text: `In 5 minutes: ${clean(i.title)}.` });
    } else if (left <= 0 && left > -START_GRACE_MS && !fired.has(start)) {
      fired.add(start).add(soon);   // don't say "in 5 minutes" after it has started
      out.push({ key: start, when: 'now', title: i.title, start: i.start, text: `${clean(i.title)} is starting now.` });
    }
  }
  return out;
}

/** "Read my day aloud": today's remaining items as short sentences, each under maxLen chars. */
export function daySummary(items, now, { tz, maxLen = 200 } = {}) {
  const fmtDay = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
  const fmtTime = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' });
  const today = fmtDay.format(now);
  const left = (items ?? []).filter((i) => fmtDay.format(i.all_day ? i.start + 12 * 3600e3 : i.start) === today
    && (i.end ?? i.start) >= now);
  if (!left.length) return ['Nothing else on your calendar today.'];
  const lines = [`You have ${left.length} thing${left.length > 1 ? 's' : ''} left today.`];
  for (const i of left) {
    const when = i.all_day ? 'All day' : `At ${fmtTime.format(i.start)}`;
    lines.push(`${when}, ${clean(i.title)}${i.kind === 'due' ? ' is due' : ''}.`);
  }
  // pack sentences into chunks the duck's voice accepts
  const chunks = [];
  for (const line of lines) {
    const last = chunks[chunks.length - 1];
    if (last && last.length + 1 + line.length <= maxLen) chunks[chunks.length - 1] = `${last} ${line}`;
    else chunks.push(line.slice(0, maxLen));
  }
  return chunks.slice(0, 5);   // the duck's speech queue holds 5
}
