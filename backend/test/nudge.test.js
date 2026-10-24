import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPrompt, cleanLine, writeNudge } from '../src/nudge.js';

const facts = { minutes_at_desk: 30, item: { title: 'CSE 320 HW3', kind: 'due', in_minutes: 180 }, next: [] };

test('prompt carries the facts, tone and no-invention rule', () => {
  const { system, user } = buildPrompt({ kind: 'deadline', tone: 'savage', facts, name: 'Akeen' });
  assert.match(user, /CSE 320 HW3/);
  assert.match(user, /due soon/);
  assert.match(system, /roasting/);
  assert.match(system, /Never invent deadlines/);
  assert.match(system, /Akeen/);
});

test('unknown kind / tone fall back safely', () => {
  const { system, user } = buildPrompt({ kind: 'nope', tone: 'evil', facts: {} });
  assert.match(system, /confident coach/);
  assert.match(user, /check-in/);
  assert.doesNotMatch(system, /Their name/);
});

test('cleanLine strips quotes, markdown, emoji, speaker labels and newlines', () => {
  assert.equal(cleanLine('"**Lock in.** 🦆\nHW3 is due in three hours."'), 'Lock in. HW3 is due in three hours.');
  assert.equal(cleanLine('Duck Daddy: Get to it.'), 'Get to it.');
  assert.equal(cleanLine(''), '');
});

test('cleanLine cuts long replies at a sentence end', () => {
  const long = 'First sentence is here and it is fine. ' + 'word '.repeat(80);
  const out = cleanLine(long);
  assert.ok(out.length <= 220);
  assert.equal(out, 'First sentence is here and it is fine.');
});

test('writeNudge calls the Messages API and returns the cleaned text', async () => {
  let sent;
  const fetchImpl = async (url, opts) => {
    sent = { url, headers: opts.headers, body: JSON.parse(opts.body) };
    return new Response(JSON.stringify({ content: [{ type: 'text', text: '"Three hours. Open HW3 now."' }] }), { status: 200 });
  };
  const text = await writeNudge({ apiKey: 'k', model: 'claude-haiku-5-5', kind: 'deadline', tone: 'coach', facts, fetchImpl });
  assert.equal(text, 'Three hours. Open HW3 now.');
  assert.equal(sent.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(sent.headers['x-api-key'], 'k');
  assert.equal(sent.headers['anthropic-version'], '2023-06-01');
  assert.equal(sent.body.model, 'claude-haiku-5-5');
  assert.equal(sent.body.messages[0].role, 'user');
});

test('writeNudge surfaces API errors', async () => {
  const fetchImpl = async () => new Response('{"error":"bad key"}', { status: 401 });
  await assert.rejects(writeNudge({ apiKey: 'x', model: 'm', kind: 'checkin', facts: {}, fetchImpl }), /HTTP 401/);
});
