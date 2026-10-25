// Run: cd backend && npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mentionsDuck, quickIntent } from '../src/quick.js';

const q = (t) => quickIntent(t, { now: Date.parse('2026-10-25T10:40:00Z'), tz: 'America/New_York' });

test('sentry on/off from real transcripts', () => {
  assert.deepEqual([q('Hey Doc, turn on sentry mode').intent, q('Hey Doc, turn on sentry mode').sentry], ['sentry', 'on']);
  assert.equal(q('Hey Doc, turn off Sentry mode and Focus mode, please').sentry, 'off');
  assert.equal(q('hey duck guard my desk on').sentry, 'on');
  assert.equal(q('hey duck sentry mode'), null);   // on or off? ask Claude
});

test('posture on/off', () => {
  assert.deepEqual([q('Hey duck, turn off posture').intent, q('Hey duck, turn off posture').posture], ['posture', 'off']);
  assert.equal(q('hey doc posture checks back on').posture, 'on');
  assert.equal(q('hey duck stop telling me to sit up').posture, 'off');
  assert.equal(q("hey duck how's my posture"), null);   // a question, not a toggle: Claude
});

test('focus commands', () => {
  assert.equal(q("hey duck let's lock in").focus, 'start_focus');
  assert.equal(q("Hey duck, I'm taking a break").focus, 'break');
  assert.equal(q('hey duck how much time is left').focus, 'time_left');
  assert.equal(q('hey duck give me more time').focus, 'more_time');
  assert.equal(q("hey duck i'm done").focus, 'finish');
});

test('what time is it answers locally', () => {
  assert.deepEqual([q('hey duck what time is it').intent, q('hey duck what time is it').reply], ['other', "It's 6:40 AM, bestie."]);
});

test('everything else goes to Claude', () => {
  assert.equal(q('hey duck remind me in 5 days to email my TA'), null);
  assert.equal(q("hey duck what's on my calendar tomorrow"), null);
  assert.equal(q('hey duck remember my locker code is 427'), null);
  assert.equal(q('hey duck ' + 'blah '.repeat(20) + 'sentry on'), null);   // long: Claude reads it
});

test('mentionsDuck catches the usual mishearings, not chatter', () => {
  for (const t of ['Hey Doc, turn on sentry', 'hey duck', 'Hey doctor? no', 'ok dog what time']) assert.equal(mentionsDuck(t), true);
  assert.equal(mentionsDuck("No, no, I can't. I'm supposed to go to another pickup."), false);
});
