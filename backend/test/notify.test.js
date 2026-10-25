// Run: cd backend && npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';

const sentry = (confirmed, extra = {}) => ({
  user_id: 'u', type: 'sentry', ts: Date.parse('2026-10-25T07:42:00Z'),
  value: { distance_cm: null, trigger: 'camera', person_confirmed: confirmed, confidence: 0.86, night: false, ...extra },
});

function stubFetch(impl) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => { calls.push({ url: String(url), init }); return impl(url, init); };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

process.env.NTFY_TOPIC = 'duckmommy-test';
process.env.ALERT_TZ = 'America/New_York';
const { alertPhone, alertText } = await import('../src/notify.js');

test('a confirmed person: one POST to ntfy.sh/<topic> with the alert text', async () => {
  const f = stubFetch(async () => new Response('', { status: 200 }));
  const logs = [];
  try {
    await alertPhone(sentry(true), (...a) => logs.push(a.join(' ')));
  } finally { f.restore(); }
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, 'https://ntfy.sh/duckmommy-test');
  assert.equal(f.calls[0].init.method, 'POST');
  assert.match(f.calls[0].init.body, /person in your room/);
  assert.equal(f.calls[0].init.headers.Priority, 'high');
  assert.deepEqual(logs, ['phone alert sent']);
});

test('motion only, other event types: no POST', async () => {
  const f = stubFetch(async () => new Response(''));
  try {
    await alertPhone(sentry(false));
    await alertPhone({ type: 'posture', value: { state: 'slouch' }, ts: 0 });
  } finally { f.restore(); }
  assert.equal(f.calls.length, 0);
});

test('a failing fetch never throws', async () => {
  const f = stubFetch(async () => { throw new Error('offline'); });
  const logs = [];
  try {
    await alertPhone(sentry(true), (...a) => logs.push(a.join(' ')));
  } finally { f.restore(); }
  assert.deepEqual(logs, ['phone alert failed offline']);
});

test('alertText: local time, says when the lights are off', () => {
  assert.equal(alertText(sentry(true)), "There's a person in your room. Seen at 3:42 AM.");
  assert.equal(alertText(sentry(true, { night: true })), "There's a person in your room (lights are off). Seen at 3:42 AM.");
});

test('NTFY_TOPIC unset: no POST', async () => {
  delete process.env.NTFY_TOPIC;
  const off = await import('../src/notify.js?off');
  const f = stubFetch(async () => new Response(''));
  try {
    await off.alertPhone(sentry(true));
  } finally { f.restore(); }
  assert.equal(f.calls.length, 0);
});
