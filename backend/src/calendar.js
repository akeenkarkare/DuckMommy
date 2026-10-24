// Calendar feeds -> the active user's agenda. No dependencies.
//
// The user pastes iCal links on the dashboard (settings.calendar_urls, one per line):
//   * Google Calendar: Settings -> (your calendar) -> "Secret address in iCal format"
//   * Brightspace / Canvas / Outlook: the calendar "subscribe" / iCal feed link
// The relay fetches them (the Pi never sees the links), keeps the next week, and
// pushes it to the duck and to that user's dashboards.

import { expandIcs, localTimeZone, parseIcs } from './ics.js';

export const MAX_FEEDS = 5;
const MAX_BYTES = 5 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 10000;
const PAST_MS = 60 * 60 * 1000;           // keep things that ended < 1 h ago
const HORIZON_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_ITEMS = 60;

/** Split the settings text into usable http(s) URLs (webcal:// becomes https://). */
export function feedUrls(text) {
  return String(text ?? '')
    .split(/[\s,]+/)
    .map((u) => u.trim().replace(/^webcals?:\/\//i, 'https://'))
    .filter((u) => /^https?:\/\/[^\s/]+/i.test(u))
    .slice(0, MAX_FEEDS);
}

const hostOf = (url) => { try { return new URL(url).host; } catch { return 'invalid link'; } };

async function fetchText(url, fetchImpl) {
  const r = await fetchImpl(url, {
    headers: { accept: 'text/calendar, text/plain;q=0.9, */*;q=0.5', 'user-agent': 'DuckDaddy/1.0' },
    redirect: 'follow',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  if (Number(r.headers.get('content-length') ?? 0) > MAX_BYTES) throw new Error('feed too big');
  const text = await r.text();
  if (text.length > MAX_BYTES) throw new Error('feed too big');
  if (!/BEGIN:VCALENDAR/i.test(text)) throw new Error('not an iCal feed (did you copy the page link instead of the iCal link?)');
  return text;
}

/**
 * Fetch + merge every feed. Never throws: per-feed problems come back in `errors`
 * (by host only, because the links themselves are secret).
 */
export async function buildAgenda(urlsText, { now = Date.now(), fetchImpl = fetch, localTz = localTimeZone() } = {}) {
  const urls = feedUrls(urlsText);
  const results = await Promise.allSettled(urls.map((u) => fetchText(u, fetchImpl)));
  const items = [], errors = [], seen = new Set();
  results.forEach((res, i) => {
    const label = `Feed ${i + 1} (${hostOf(urls[i])})`;
    if (res.status === 'rejected') {
      errors.push(`${label}: ${res.reason?.name === 'TimeoutError' ? 'timed out' : res.reason?.message ?? 'failed'}`);
      return;
    }
    try {
      for (const item of expandIcs(parseIcs(res.value, { localTz }), now - PAST_MS, now + HORIZON_MS)) {
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        items.push({ ...item, source: i + 1 });
      }
    } catch (e) {
      errors.push(`${label}: couldn't read it (${e.message})`);
    }
  });
  items.sort((a, b) => a.start - b.start);
  return { items: items.slice(0, MAX_ITEMS), errors, feeds: urls.length, fetched_at: now };
}
