// Minimal iCalendar (RFC 5545) reader for the duck's agenda. No dependencies.
//
//   const cal = parseIcs(text);
//   const items = expandIcs(cal, fromMs, toMs);   // [{id, title, kind, start, end, all_day}]
//
// Handles what calendar feeds actually send: line folding, escaped text, UTC / TZID /
// floating times (with DST via Intl), all-day dates, VEVENT + VTODO (DUE), RRULE
// (DAILY / WEEKLY + BYDAY / MONTHLY by day-of-month / YEARLY, with INTERVAL, COUNT,
// UNTIL), EXDATE, RECURRENCE-ID overrides and STATUS:CANCELLED.
// Not handled: MONTHLY/YEARLY rules with BYDAY/BYSETPOS ("2nd Tuesday"); those
// series only show their first instance.
//
// kind: "due" for things you hand in (VTODO, zero-length events, titles like
// "... due", "Assignment", "HW 3"), "event" for things you attend.

const DAY_MS = 86400000;
const MAX_INSTANCES = 2000;
const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
const DUE_TITLE = /\bdue\b|deadline|assignment|homework|\bhw\s?\d|submission|problem set|\bpset\b/i;
const WINDOWS_TZ = {
  'Eastern Standard Time': 'America/New_York', 'Central Standard Time': 'America/Chicago',
  'Mountain Standard Time': 'America/Denver', 'Pacific Standard Time': 'America/Los_Angeles',
  'GMT Standard Time': 'Europe/London', 'W. Europe Standard Time': 'Europe/Berlin',
  'India Standard Time': 'Asia/Kolkata', 'China Standard Time': 'Asia/Shanghai',
  'Tokyo Standard Time': 'Asia/Tokyo', UTC: 'UTC',
};

export const localTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

// ─── time zones ──────────────────────────────────────────────────────────────
const formatters = new Map();
function formatter(tz) {
  if (!formatters.has(tz)) {
    formatters.set(tz, new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }));
  }
  return formatters.get(tz);
}

export function normalizeTz(tzid, fallback) {
  if (!tzid) return fallback;
  let tz = WINDOWS_TZ[tzid] ?? tzid;
  const m = tz.match(/([A-Za-z_]+\/[A-Za-z_+-]+(?:\/[A-Za-z_+-]+)?)$/);   // "/mozilla.org/.../America/New_York"
  if (m && !WINDOWS_TZ[tzid]) tz = m[1];
  try { formatter(tz); return tz; } catch { return fallback; }
}

function offsetMs(utcMs, tz) {
  const p = Object.fromEntries(formatter(tz).formatToParts(new Date(utcMs)).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

/** Wall-clock time in `tz` -> epoch ms (two passes so DST edges land right). */
export function wallToUtc(w, tz) {
  const guess = Date.UTC(w.y, w.m - 1, w.d, w.h ?? 0, w.mi ?? 0, w.s ?? 0);
  const first = guess - offsetMs(guess, tz);
  const second = guess - offsetMs(first, tz);
  return second;
}

function utcToWall(ms, tz) {
  const p = Object.fromEntries(formatter(tz).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour % 24, mi: +p.minute, s: +p.second };
}

// ─── parsing ─────────────────────────────────────────────────────────────────
function unfold(text) {
  return String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n[ \t]/g, '').split('\n');
}

function parseLine(line) {
  // NAME;PARAM=a;PARAM2="b:c":VALUE  (colons inside quoted params don't end the name part)
  let i = 0, quoted = false;
  for (; i < line.length; i++) {
    if (line[i] === '"') quoted = !quoted;
    else if (line[i] === ':' && !quoted) break;
  }
  if (i >= line.length) return null;
  const [name, ...rawParams] = line.slice(0, i).split(';');
  const params = {};
  for (const p of rawParams) {
    const eq = p.indexOf('=');
    if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, '');
  }
  return { name: name.toUpperCase(), params, value: line.slice(i + 1) };
}

const unescapeText = (v) => v.replace(/\\n/gi, ' ').replace(/\\([,;\\])/g, '$1').replace(/\s+/g, ' ').trim();

/** One date/date-time value -> {wall, tz, utc, allDay}. */
function parseDate(value, params, defaultTz) {
  const v = value.trim();
  let m = v.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m || params.VALUE === 'DATE') {
    m = m ?? v.match(/^(\d{4})(\d{2})(\d{2})/);
    if (!m) return null;
    const wall = { y: +m[1], m: +m[2], d: +m[3] };
    return { wall, tz: defaultTz, allDay: true, utc: wallToUtc(wall, defaultTz) };
  }
  m = v.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z)?$/);
  if (!m) return null;
  const wall = { y: +m[1], m: +m[2], d: +m[3], h: +m[4], mi: +m[5], s: +(m[6] ?? 0) };
  const tz = m[7] ? 'UTC' : normalizeTz(params.TZID, defaultTz);
  return { wall, tz, allDay: false, utc: wallToUtc(wall, tz) };
}

function parseDuration(v) {
  const m = String(v).match(/^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
  if (!m) return null;
  const ms = ((+(m[2] ?? 0) * 7 + +(m[3] ?? 0)) * 24 * 3600 + +(m[4] ?? 0) * 3600 + +(m[5] ?? 0) * 60 + +(m[6] ?? 0)) * 1000;
  return m[1] === '-' ? -ms : ms;
}

function parseRrule(v) {
  const r = {};
  for (const part of v.split(';')) {
    const [k, val] = part.split('=');
    if (k && val !== undefined) r[k.toUpperCase()] = val;
  }
  return r;
}

export function parseIcs(text, { localTz = localTimeZone() } = {}) {
  const lines = unfold(text);
  const components = [];
  let calTz = null, cur = null, depth = 0;
  for (const line of lines) {
    if (!line) continue;
    const prop = parseLine(line);
    if (!prop) continue;
    if (prop.name === 'BEGIN') {
      const kind = prop.value.toUpperCase();
      if ((kind === 'VEVENT' || kind === 'VTODO') && !cur) { cur = { type: kind, props: [] }; depth = 0; }
      else if (cur) depth++;          // VALARM etc. inside an event: ignore its properties
      continue;
    }
    if (prop.name === 'END') {
      if (cur && depth > 0) depth--;
      else if (cur && (prop.value.toUpperCase() === cur.type)) { components.push(cur); cur = null; }
      continue;
    }
    if (cur && depth === 0) cur.props.push(prop);
    else if (!cur && prop.name === 'X-WR-TIMEZONE') calTz = prop.value.trim();
  }
  const defaultTz = normalizeTz(calTz, localTz);

  const entries = [];
  for (const c of components) {
    const get = (n) => c.props.find((p) => p.name === n);
    const all = (n) => c.props.filter((p) => p.name === n);
    const startProp = get('DTSTART') ?? (c.type === 'VTODO' ? get('DUE') : null);
    if (!startProp) continue;
    const start = parseDate(startProp.value, startProp.params, defaultTz);
    if (!start) continue;
    let end = null;
    const endProp = c.type === 'VTODO' ? null : get('DTEND');
    if (endProp) end = parseDate(endProp.value, endProp.params, defaultTz);
    const duration = get('DURATION') ? parseDuration(get('DURATION').value) : null;
    const title = unescapeText(get('SUMMARY')?.value ?? '(untitled)') || '(untitled)';
    const durMs = end ? end.utc - start.utc : duration ?? (start.allDay ? DAY_MS : 0);
    const exdates = new Set();
    for (const ex of all('EXDATE')) {
      for (const v of ex.value.split(',')) {
        const d = parseDate(v, ex.params, start.tz);
        if (d) exdates.add(d.utc);
      }
    }
    const rid = get('RECURRENCE-ID');
    const status = (get('STATUS')?.value ?? '').toUpperCase();
    const isDue = c.type === 'VTODO' || (!start.allDay && durMs === 0) || DUE_TITLE.test(title);
    entries.push({
      uid: get('UID')?.value ?? `${title}@${start.utc}`,
      title, start, durMs, exdates,
      rrule: get('RRULE') ? parseRrule(get('RRULE').value) : null,
      recurrenceId: rid ? parseDate(rid.value, rid.params, start.tz)?.utc ?? null : null,
      cancelled: status === 'CANCELLED',
      kind: isDue ? 'due' : 'event',
    });
  }
  return { entries, defaultTz };
}

// ─── recurrence ──────────────────────────────────────────────────────────────
const addDays = (w, n) => {
  const d = new Date(Date.UTC(w.y, w.m - 1, w.d + n));
  return { ...w, y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() };
};
const weekday = (w) => new Date(Date.UTC(w.y, w.m - 1, w.d)).getUTCDay();
const daysInMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/** Start times (epoch ms) of a series, in order, until `toMs`. */
function* occurrences(entry, toMs) {
  const { start, rrule: r } = entry;
  if (!r) { yield start.utc; return; }
  const freq = (r.FREQ ?? '').toUpperCase();
  const interval = Math.max(1, parseInt(r.INTERVAL ?? '1', 10) || 1);
  const count = r.COUNT ? parseInt(r.COUNT, 10) : Infinity;
  let until = Infinity;
  if (r.UNTIL) {
    const u = parseDate(r.UNTIL, {}, start.tz);
    if (u) until = u.allDay ? u.utc + DAY_MS - 1 : u.utc;
  }
  const byday = r.BYDAY ? r.BYDAY.split(',').map((d) => d.trim().toUpperCase()) : null;
  if ((freq === 'MONTHLY' || freq === 'YEARLY') && (byday || r.BYSETPOS)) { yield start.utc; return; }

  const toUtc = (w) => wallToUtc(w, start.tz);
  let n = 0;
  const emit = function* (w) {
    const ms = toUtc(w);
    if (ms < start.utc) return false;
    if (ms > until || n >= count || ms > toMs) return true;   // done
    n++;
    yield ms;
    return false;
  };

  for (let step = 0; step < MAX_INSTANCES; step++) {
    let batch;
    if (freq === 'DAILY') batch = [addDays(start.wall, step * interval)];
    else if (freq === 'WEEKLY') {
      const days = byday ? byday.map((d) => WEEKDAYS.indexOf(d.slice(-2))).filter((i) => i >= 0) : [weekday(start.wall)];
      const monday = addDays(start.wall, -((weekday(start.wall) + 6) % 7) + step * 7 * interval);
      batch = [...new Set(days)].map((d) => addDays(monday, (d + 6) % 7)).sort((a, b) => toUtc(a) - toUtc(b));
    } else if (freq === 'MONTHLY') {
      const total = start.wall.m - 1 + step * interval;
      const y = start.wall.y + Math.floor(total / 12), m = (total % 12) + 1;
      batch = start.wall.d <= daysInMonth(y, m) ? [{ ...start.wall, y, m }] : [];
    } else if (freq === 'YEARLY') {
      const y = start.wall.y + step * interval;
      batch = start.wall.d <= daysInMonth(y, start.wall.m) ? [{ ...start.wall, y }] : [];
    } else { yield start.utc; return; }
    for (const w of batch) {
      const done = yield* emit(w);
      if (done) return;
    }
  }
}

/** Everything that overlaps [fromMs, toMs], soonest first. */
export function expandIcs(cal, fromMs, toMs) {
  const overridden = new Set(cal.entries.filter((e) => e.recurrenceId !== null).map((e) => `${e.uid}@${e.recurrenceId}`));
  const items = [];
  for (const e of cal.entries) {
    const series = e.recurrenceId === null;
    for (const startMs of occurrences(e, toMs)) {
      if (items.length > MAX_INSTANCES) break;
      if (series && (e.exdates.has(startMs) || overridden.has(`${e.uid}@${startMs}`))) continue;
      if (e.cancelled) continue;
      let start = startMs, end = startMs + e.durMs;
      if (e.kind === 'due' && e.start.allDay) {           // "due Friday" = end of Friday
        const w = utcToWall(startMs, e.start.tz);
        start = end = wallToUtc({ ...w, h: 23, mi: 59, s: 0 }, e.start.tz);
      }
      if (Math.max(start, end) < fromMs || start > toMs) continue;
      items.push({
        id: `${e.uid}@${startMs}`, title: e.title.slice(0, 120), kind: e.kind,
        start, end: e.durMs > 0 && !(e.kind === 'due' && e.start.allDay) ? end : null,
        all_day: e.start.allDay && e.kind !== 'due',
      });
    }
  }
  return items.sort((a, b) => a.start - b.start);
}
