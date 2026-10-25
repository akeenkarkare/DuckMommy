// Run: cd backend && npm test   (node's built-in test runner, no deps)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { answerRecall, buildRecallPrompt, cleanText, localTime, transcribe, understand } from '../src/memory.js';

const NY = 'America/New_York';
let last;
const claudeReply = (text, extra = {}) => async (url, init) => {
  last = { url, body: JSON.parse(init.body), headers: init.headers };
  return new Response(JSON.stringify({ stop_reason: 'end_turn', content: [{ type: 'text', text }], ...extra }));
};

test('understand: garbled remember -> clean sentence, sends the structured-output schema', async () => {
  const fetchImpl = claudeReply(JSON.stringify({ intent: 'remember', memory: 'My keys are in the blue drawer.', question: '' }));
  const out = await understand({ apiKey: 'k', model: 'claude-opus-5-5', transcript: 'um remember like my keys r in the blew draw', fetchImpl });
  assert.deepEqual(out, { intent: 'remember', memory: 'My keys are in the blue drawer.', question: '' });
  assert.equal(last.body.model, 'claude-opus-5-5');
  assert.equal(last.body.max_tokens, 4096);
  assert.equal(last.body.output_config.format.type, 'json_schema');
  assert.equal(last.body.fallbacks, 'default');
  assert.equal(last.headers['anthropic-beta'], 'server-side-fallback-2026-07-01');
  assert.ok(!('temperature' in last.body));
  assert.match(last.body.messages[0].content, /blew draw/);
});

test('understand: unknown intent or bad JSON falls back to other', async () => {
  let out = await understand({ apiKey: 'k', model: 'm', transcript: 'x', fetchImpl: claudeReply('not json') });
  assert.equal(out.intent, 'other');
  out = await understand({ apiKey: 'k', model: 'm', transcript: 'x', fetchImpl: claudeReply('{"intent":"dance","memory":"","question":""}') });
  assert.equal(out.intent, 'other');
});

test('Claude refusal, cut-off and HTTP errors throw', async () => {
  await assert.rejects(understand({ apiKey: 'k', model: 'm', transcript: 'x', fetchImpl: claudeReply('{"in', { stop_reason: 'max_tokens' }) }), /cut off/);
  await assert.rejects(understand({ apiKey: 'k', model: 'm', transcript: 'x', fetchImpl: claudeReply('', { stop_reason: 'refusal' }) }), /refused/);
  await assert.rejects(understand({ apiKey: 'k', model: 'm', transcript: 'x', fetchImpl: async () => new Response('nope', { status: 500 }) }), /HTTP 500/);
});

test('recall prompt: dates every memory in local time and states today', () => {
  const now = Date.parse('2026-10-24T23:00:00Z');   // Sat Oct 24, 7 PM in New York
  const { system, user } = buildRecallPrompt({
    question: 'What did I tell you to remember 5 days ago?',
    memories: [{ text: 'My keys are in the blue drawer.', created_at: '2026-10-19T14:30:00Z' }],
    now, tz: NY,
  });
  assert.match(system, /Saturday, October 24, 2026/);
  assert.match(user, /\[Monday, October 19, 2026 at 10:30 AM\] "My keys are in the blue drawer\."/);
  assert.match(user, /5 days ago/);
});

test('recall prompt: an empty list says so', () => {
  const { user } = buildRecallPrompt({ question: 'q', memories: [], now: 0, tz: NY });
  assert.match(user, /no memories saved yet/);
});

test('answerRecall returns a speakable line', async () => {
  const fetchImpl = claudeReply('**Five days ago**, on Monday, you said your keys are in the blue drawer. 🦆');
  const text = await answerRecall({ apiKey: 'k', model: 'm', question: 'q', memories: [], now: 0, tz: NY, fetchImpl });
  assert.equal(text, 'Five days ago, on Monday, you said your keys are in the blue drawer.');
  assert.equal(last.body.output_config.format, undefined);
});

test('transcribe posts multipart to ElevenLabs and returns the text', async () => {
  let seen;
  const fetchImpl = async (url, init) => { seen = { url, init }; return new Response(JSON.stringify({ text: ' hey there ' })); };
  const text = await transcribe({ apiKey: 'xi', wav: Buffer.from('RIFF'), fetchImpl });
  assert.equal(text, 'hey there');
  assert.equal(seen.url, 'https://api.elevenlabs.io/v1/speech-to-text');
  assert.equal(seen.init.headers['xi-api-key'], 'xi');
  assert.equal(seen.init.body.get('model_id'), 'scribe_v2');
  assert.ok(seen.init.body.get('file') instanceof Blob);
});

test('cleanText strips quotes and cuts long lines at a sentence', () => {
  assert.equal(cleanText('"hello"', 50), 'hello');
  assert.equal(cleanText('Your keys are in the drawer. Second part is much longer than the limit', 40), 'Your keys are in the drawer.');
  assert.equal(localTime(Date.parse('2026-01-05T15:00:00Z'), NY), 'Monday, January 5, 2026 at 10:00 AM');
});
