// Phone alerts: a confirmed sentry person -> push via ntfy.sh (and the optional Mac iMessage bridge).
// The topic is the active user's own (profiles.ntfy_topic, passed in by the relay); NTFY_TOPIC is the
// shared fallback. No-op without either. Never throws: an alert failing must not affect the relay.

const NTFY_URL = (process.env.NTFY_URL || 'https://ntfy.sh').replace(/\/$/, '');
const NTFY_TOPIC = process.env.NTFY_TOPIC;
const ALERT_TZ = process.env.ALERT_TZ || 'America/New_York';

export function alertText(event) {
  const when = new Date(event.ts).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: ALERT_TZ });
  const dark = event.value?.night ? ' (lights are off)' : '';
  return `There's a person in your room${dark}. Seen at ${when}.`;
}

export async function alertPhone(event, log = console.log, topic = NTFY_TOPIC) {
  if (!topic || event.type !== 'sentry' || !event.value?.person_confirmed) return;
  try {
    const res = await fetch(`${NTFY_URL}/${encodeURIComponent(topic)}`, {
      method: 'POST',
      headers: { Title: 'DuckMommy sentry', Priority: 'high', Tags: 'duck,rotating_light' },
      body: alertText(event),
      signal: AbortSignal.timeout(5000),
    });
    log('phone alert', res.ok ? 'sent' : `failed (${res.status})`);
  } catch (e) {
    log('phone alert failed', e.message);
  }
}
