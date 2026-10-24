// Run: cd backend && npm test   (node's built-in test runner, no deps)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expandIcs, normalizeTz, parseIcs, wallToUtc } from '../src/ics.js';
import { buildAgenda, feedUrls } from '../src/calendar.js';

const NY = 'America/New_York';
const cal = (...events) => ['BEGIN:VCALENDAR', 'VERSION:2.0', ...events.flat(), 'END:VCALENDAR'].join('\r\n');
const at = (iso) => Date.parse(iso);
const items = (text, from, to, localTz = NY) => expandIcs(parseIcs(text, { localTz }), at(from), at(to));

test('wall time -> UTC across the November DST change', () => {
  assert.equal(wallToUtc({ y: 2026, m: 10, d: 30, h: 9, mi: 0 }, NY), at('2026-10-30T13:00:00Z')); // EDT
  assert.equal(wallToUtc({ y: 2026, m: 11, d: 2, h: 9, mi: 0 }, NY), at('2026-11-02T14:00:00Z'));  // EST
});

test('time zone names: IANA, Windows, Mozilla-style, junk', () => {
  assert.equal(normalizeTz('America/Chicago', NY), 'America/Chicago');
  assert.equal(normalizeTz('Eastern Standard Time', 'UTC'), NY);
  assert.equal(normalizeTz('/mozilla.org/20050126_1/America/Denver', NY), 'America/Denver');
  assert.equal(normalizeTz('Not/AZone', NY), NY);
});

test('Canvas-style assignment: UTC, zero length -> due', () => {
  const [hw] = items(cal('BEGIN:VEVENT', 'UID:a1', 'SUMMARY:Homework 3 [CSE320]',
    'DTSTART:20261027T035900Z', 'DTEND:20261027T035900Z', 'END:VEVENT'), '2026-10-24', '2026-10-31');
  assert.equal(hw.kind, 'due');
  assert.equal(hw.start, at('2026-10-27T03:59:00Z'));
  assert.equal(hw.title, 'Homework 3 [CSE320]');
});

test('all-day due date means the end of that day', () => {
  const [d] = items(cal('BEGIN:VEVENT', 'UID:b1', 'SUMMARY:Lab report due', 'DTSTART;VALUE=DATE:20261030',
    'DTEND;VALUE=DATE:20261031', 'END:VEVENT'), '2026-10-24', '2026-11-05');
  assert.equal(d.kind, 'due');
  assert.equal(d.all_day, false);
  assert.equal(d.start, wallToUtc({ y: 2026, m: 10, d: 30, h: 23, mi: 59 }, NY));
});

test('weekly lecture with TZID keeps 9:00 local through DST, honours EXDATE + override + cancel', () => {
  const text = cal(
    'BEGIN:VEVENT', 'UID:lec', 'SUMMARY:CSE 320 Lecture', 'DTSTART;TZID=America/New_York:20261026T090000',
    'DTEND;TZID=America/New_York:20261026T102000', 'RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=6',
    'EXDATE;TZID=America/New_York:20261028T090000', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:lec', 'RECURRENCE-ID;TZID=America/New_York:20261102T090000', 'SUMMARY:CSE 320 Lecture (room change)',
    'DTSTART;TZID=America/New_York:20261102T110000', 'DTEND;TZID=America/New_York:20261102T122000', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:lec', 'RECURRENCE-ID;TZID=America/New_York:20261104T090000', 'STATUS:CANCELLED',
    'DTSTART;TZID=America/New_York:20261104T090000', 'END:VEVENT',
  );
  const got = items(text, '2026-10-25', '2026-11-30').map((i) => [new Date(i.start).toISOString(), i.title, i.kind]);
  assert.deepEqual(got, [
    ['2026-10-26T13:00:00.000Z', 'CSE 320 Lecture', 'event'],              // Mon, EDT
    // Wed 10/28 excluded (EXDATE)
    ['2026-11-02T16:00:00.000Z', 'CSE 320 Lecture (room change)', 'event'], // moved to 11:00 EST
    // Wed 11/4 cancelled
    ['2026-11-09T14:00:00.000Z', 'CSE 320 Lecture', 'event'],              // Mon, EST
    ['2026-11-11T14:00:00.000Z', 'CSE 320 Lecture', 'event'],              // 6th = COUNT end
  ]);
});

test('daily rule with UNTIL, monthly by day-of-month, interval', () => {
  const daily = items(cal('BEGIN:VEVENT', 'UID:d', 'SUMMARY:Standup', 'DTSTART:20261024T140000Z', 'DURATION:PT15M',
    'RRULE:FREQ=DAILY;INTERVAL=2;UNTIL=20261030T000000Z', 'END:VEVENT'), '2026-10-24', '2026-11-30');
  assert.deepEqual(daily.map((i) => i.start), ['2026-10-24T14:00Z', '2026-10-26T14:00Z', '2026-10-28T14:00Z'].map(at));
  assert.equal(daily[0].end - daily[0].start, 15 * 60000);
  const monthly = items(cal('BEGIN:VEVENT', 'UID:m', 'SUMMARY:Rent', 'DTSTART;VALUE=DATE:20260131',
    'RRULE:FREQ=MONTHLY', 'END:VEVENT'), '2026-01-01', '2026-06-01');
  assert.deepEqual(monthly.map((i) => new Date(i.start).toISOString().slice(0, 10)),
    ['2026-01-31', '2026-03-31', '2026-05-31'].map((d) => new Date(wallToUtc({ y: +d.slice(0, 4), m: +d.slice(5, 7), d: +d.slice(8) }, NY)).toISOString().slice(0, 10)));
});

test('VTODO with DUE, folded + escaped text, alarms ignored, floating time', () => {
  const text = cal(
    'BEGIN:VTODO', 'UID:t1', 'SUMMARY:Read chapter 4\\, take', '  notes', 'DUE:20261025T170000', 'END:VTODO',
    'BEGIN:VEVENT', 'UID:e1', 'SUMMARY:Club meeting', 'DTSTART:20261025T190000', 'DTEND:20261025T200000',
    'BEGIN:VALARM', 'TRIGGER:-PT15M', 'SUMMARY:alarm text', 'END:VALARM', 'END:VEVENT',
  );
  const [todo, ev] = items(text, '2026-10-24', '2026-10-31');
  assert.equal(todo.kind, 'due');
  assert.equal(todo.title, 'Read chapter 4, take notes');
  assert.equal(todo.start, wallToUtc({ y: 2026, m: 10, d: 25, h: 17 }, NY));
  assert.equal(ev.title, 'Club meeting');
  assert.equal(ev.kind, 'event');
});

test('window: past and far-future items are left out', () => {
  const text = cal('BEGIN:VEVENT', 'UID:p', 'SUMMARY:Old', 'DTSTART:20260101T100000Z', 'DTEND:20260101T110000Z', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:f', 'SUMMARY:Far', 'DTSTART:20270101T100000Z', 'DTEND:20270101T110000Z', 'END:VEVENT');
  assert.deepEqual(items(text, '2026-10-24', '2026-10-31'), []);
});

test('feedUrls: webcal, junk, limit', () => {
  assert.deepEqual(feedUrls('webcal://p01.calendar.example/a.ics\nnot a url\nhttps://x.edu/feed.ics, ftp://no'),
    ['https://p01.calendar.example/a.ics', 'https://x.edu/feed.ics']);
  assert.equal(feedUrls(Array(9).fill('https://a.b/c').join('\n')).length, 5);
  assert.deepEqual(feedUrls(null), []);
});

test('buildAgenda merges feeds and reports failures by host only', async () => {
  const good = cal('BEGIN:VEVENT', 'UID:g', 'SUMMARY:Quiz 2', 'DTSTART:20261026T150000Z', 'DTEND:20261026T150000Z', 'END:VEVENT');
  const fetchImpl = async (url) => {
    if (url.includes('good')) return new Response(good, { status: 200 });
    if (url.includes('html')) return new Response('<html>login</html>', { status: 200 });
    return new Response('nope', { status: 404 });
  };
  const out = await buildAgenda('https://good.edu/secret-token-123.ics\nhttps://bad.example/x.ics\nhttps://html.example/y',
    { now: at('2026-10-24T12:00:00Z'), fetchImpl, localTz: NY });
  assert.equal(out.items.length, 1);
  assert.equal(out.items[0].title, 'Quiz 2');
  assert.equal(out.items[0].source, 1);
  assert.equal(out.errors.length, 2);
  assert.match(out.errors[0], /Feed 2 \(bad\.example\): HTTP 404/);
  assert.match(out.errors[1], /not an iCal feed/);
  assert.ok(!out.errors.join(' ').includes('secret-token'), 'secret path must not leak into errors');
});

test('buildAgenda with no links is empty, not an error', async () => {
  const out = await buildAgenda('', { fetchImpl: async () => { throw new Error('should not fetch'); } });
  assert.deepEqual([out.items, out.errors, out.feeds], [[], [], 0]);
});
