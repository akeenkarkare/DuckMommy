import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { imessageConfigured, SENTRY_BODY, SENTRY_TITLE, sentryText } from '../src/imessage.js';

test('iMessage text is the dashboard notification, word for word', () => {
  const alert = readFileSync(new URL('../../dashboard/components/IntruderAlert.js', import.meta.url), 'utf8');
  assert.ok(alert.includes(`'${SENTRY_TITLE}'`), 'title differs from IntruderAlert.js');
  assert.ok(alert.includes(`'${SENTRY_BODY}'`), 'body differs from IntruderAlert.js');
  assert.equal(sentryText(), `${SENTRY_TITLE}\n${SENTRY_BODY}`);
});

test('off unless the Photon project id and secret are both set', () => {
  assert.equal(imessageConfigured({ SPECTRUM_PROJECT_ID: 'p' }), false);
  assert.equal(imessageConfigured({ SPECTRUM_PROJECT_ID: 'p', SPECTRUM_PROJECT_SECRET: 's' }), true);
});
