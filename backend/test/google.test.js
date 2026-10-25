// Run: cd backend && npm test   (fake fetch plays Auth0 + Google; no network)
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { _resetCaches, authorizeUrl, exchangeCode, fetchGoogleEvents, googleConfigured, toItem } from '../src/google.js';
import { daySummary, dueReminders, LEAD_MS } from '../src/reminders.js';

const ENV = {
  AUTH0_DOMAIN: 'duck.us.auth0.com', AUTH0_CLIENT_ID: 'cid', AUTH0_CLIENT_SECRET: 'csecret',
  GOOGLE_CLIENT_ID: 'gid', GOOGLE_CLIENT_SECRET: 'gsecret', RELAY_PUBLIC_URL: 'http://localhost:8080/',
};
const NY = 'America/New_York';
const res = (status, body) => ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });
const jwt = (payload) => `x.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.y`;

beforeEach(() => _resetCaches());

test('configured only with Auth0 + a public relay URL', () => {
  assert.equal(googleConfigured(ENV), true);
  assert.equal(googleConfigured({ ...ENV, AUTH0_DOMAIN: '' }), false);
});

test('authorize URL asks Google for read-only calendar + offline access via Auth0', () => {
  const u = new URL(authorizeUrl(ENV, 'st8'));
  assert.equal(u.host, 'duck.us.auth0.com');
  assert.equal(u.searchParams.get('connection'), 'google-oauth2');
  assert.equal(u.searchParams.get('connection_scope'), 'https://www.googleapis.com/auth/calendar.readonly');
  assert.equal(u.searchParams.get('access_type'), 'offline');
  assert.equal(u.searchParams.get('redirect_uri'), 'http://localhost:8080/auth/google/callback');
  assert.equal(u.searchParams.get('state'), 'st8');
});

test('code exchange returns the Auth0 user id + email', async () => {
  const fetchImpl = async (url, init) => {
    assert.match(url, /\/oauth\/token$/);
    assert.equal(JSON.parse(init.body).grant_type, 'authorization_code');
    return res(200, { id_token: jwt({ sub: 'google-oauth2|42', email: 'j@x.com' }) });
  };
  assert.deepEqual(await exchangeCode(ENV, 'code1', { fetchImpl }), { sub: 'google-oauth2|42', email: 'j@x.com' });
});

function fakeGoogle({ expired = false } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push(url);
    const auth = init.headers?.authorization;
    if (url.endsWith('/oauth/token')) return res(200, { access_token: 'mgmt', expires_in: 86400 });
    if (url.includes('/api/v2/users/')) {
      assert.equal(auth, 'Bearer mgmt');
      return res(200, { identities: [{ provider: 'google-oauth2', access_token: 'old', refresh_token: 'r1' }] });
    }
    if (url === 'https://oauth2.googleapis.com/token') return res(200, { access_token: 'new', expires_in: 3600 });
    if (url.startsWith('https://www.googleapis.com/calendar/v3/')) {
      if (expired && auth === 'Bearer old') return res(401, { error: 'expired' });
      if (url.includes('/calendarList')) return res(200, { items: [{ id: 'me@x.com', primary: true }, { id: 'class', selected: true }, { id: 'hidden', selected: false }] });
      if (url.includes('/calendars/me%40x.com/events')) return res(200, { items: [
        { id: 'a', summary: 'CSE 320 lecture', start: { dateTime: '2026-10-24T14:00:00Z' }, end: { dateTime: '2026-10-24T15:20:00Z' }, htmlLink: 'https://calendar.google.com/event?eid=a' },
        { id: 'b', summary: 'Dropped', status: 'cancelled', start: { dateTime: '2026-10-24T16:00:00Z' } },
      ] });
      if (url.includes('/calendars/class/events')) return res(200, { items: [
        { id: 'c', summary: 'Hackathon', start: { date: '2026-10-25' }, end: { date: '2026-10-26' } },
      ] });
    }
    return res(404, {});
  };
  return { fetchImpl, calls };
}

test('reads every selected calendar, drops cancelled, keeps links and all-day', async () => {
  const { fetchImpl, calls } = fakeGoogle();
  const out = await fetchGoogleEvents(ENV, 'google-oauth2|42', { now: Date.parse('2026-10-24T12:00:00Z'), fetchImpl, tz: NY });
  assert.equal(out.calendars, 2);
  assert.deepEqual(out.items.map((i) => i.title), ['CSE 320 lecture', 'Hackathon']);
  assert.equal(out.items[0].link, 'https://calendar.google.com/event?eid=a');
  assert.equal(out.items[1].all_day, true);
  assert.equal(out.items[1].start, Date.parse('2026-10-25T04:00:00Z'));   // local midnight in New York
  assert.ok(!calls.some((u) => u.includes('/calendars/hidden/')));
});

test('expired Google token: refreshed once with the refresh token from Auth0', async () => {
  const { fetchImpl, calls } = fakeGoogle({ expired: true });
  const out = await fetchGoogleEvents(ENV, 'google-oauth2|42', { now: Date.parse('2026-10-24T12:00:00Z'), fetchImpl, tz: NY });
  assert.equal(out.items.length, 2);
  assert.equal(calls.filter((u) => u === 'https://oauth2.googleapis.com/token').length, 1);
});

test('toItem: missing title and odd events', () => {
  assert.equal(toItem({ id: 'x', start: { dateTime: '2026-10-24T14:00:00Z' } }, 'c').title, '(no title)');
  assert.equal(toItem({ id: 'x', status: 'cancelled', start: { dateTime: '2026-10-24T14:00:00Z' } }, 'c'), null);
  assert.equal(toItem({ id: 'x' }, 'c'), null);
});

// ── reminders ───────────────────────────────────────────────────────────────
const T0 = Date.parse('2026-10-24T14:00:00Z');
const ev = (over = {}) => ({ id: 'e1', title: 'CSE 320 lecture', kind: 'event', start: T0, end: T0 + 3600e3, all_day: false, ...over });

test('says it 5 minutes before and once at the start, never twice', () => {
  const fired = new Set();
  assert.deepEqual(dueReminders([ev()], T0 - LEAD_MS - 1000, fired), []);
  const soon = dueReminders([ev()], T0 - LEAD_MS + 1000, fired);
  assert.equal(soon[0].text, 'Heads up, CSE 320 lecture starts in 5 minutes. Wrap it up.');
  assert.deepEqual(dueReminders([ev()], T0 - 60000, fired), []);
  assert.equal(dueReminders([ev()], T0 + 1000, fired)[0].text, "CSE 320 lecture is starting now. Don't be late, it's not the vibe.");
  assert.deepEqual(dueReminders([ev()], T0 + 5000, fired), []);
});

test('relay starts late: skips "in 5 minutes", still says "starting now"', () => {
  const fired = new Set();
  const out = dueReminders([ev()], T0 + 30000, fired);
  assert.deepEqual(out.map((r) => r.when), ['now']);
  assert.deepEqual(dueReminders([ev()], T0 + 31000, fired), []);
});

test('ignores all-day events, deadlines and long-past starts', () => {
  const fired = new Set();
  assert.deepEqual(dueReminders([ev({ all_day: true }), ev({ id: 'd', kind: 'due' })], T0 - 60000, fired), []);
  assert.deepEqual(dueReminders([ev()], T0 + 10 * 60000, fired), []);
});

test('moved event gets reminded again at its new time', () => {
  const fired = new Set();
  dueReminders([ev()], T0 + 1000, fired);
  assert.equal(dueReminders([ev({ start: T0 + 3600e3 })], T0 + 3600e3 - 60000, fired)[0].when, 'soon');
});

test('day summary: today only, in chunks the duck can say', () => {
  const now = Date.parse('2026-10-24T13:00:00Z');   // 9:00 in New York
  const items = [
    ev(), ev({ id: 'e2', title: 'Lab', start: Date.parse('2026-10-24T18:30:00Z') }),
    ev({ id: 'e3', title: 'Tomorrow thing', start: Date.parse('2026-10-25T14:00:00Z') }),
    ev({ id: 'e4', title: 'HW 4', kind: 'due', start: Date.parse('2026-10-25T03:59:00Z') }),
  ];
  const lines = daySummary(items, now, { tz: NY });
  assert.equal(lines.join(' '), 'You have 3 things left today. At 10:00 AM, CSE 320 lecture. At 2:30 PM, Lab. At 11:59 PM, HW 4 is due.');
  assert.ok(lines.every((l) => l.length <= 200));
  assert.deepEqual(daySummary([], now, { tz: NY }), ["Nothing else on your calendar today. You're free, bestie."]);
});
