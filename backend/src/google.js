// Google Calendar via Auth0 (Google social connection). No SDKs: plain fetch.
//
// Connect (once per user, from the dashboard's Calendar tab):
//   dashboard --ws google_connect--> relay --> Auth0 /authorize (connection=google-oauth2,
//   calendar.readonly, offline) --> Google consent --> Auth0 --> relay /auth/google/callback
//   --> code exchanged for the Auth0 user id (sub) --> saved in Supabase google_calendar.
// Read (every agenda refresh):
//   Auth0 Management API (read:users + read:user_idp_tokens) gives the user's Google tokens
//   --> Google Calendar API --> titles + times of every calendar in the user's list.
// The Google tokens live in Auth0; we only store the Auth0 user id.

import { localTimeZone, wallToUtc } from './ics.js';

const GOOGLE_SCOPE = 'https://www.googleapis.com/auth/calendar.readonly';
const CAL_API = 'https://www.googleapis.com/calendar/v3';
const PAST_MS = 60 * 60 * 1000;               // keep things that ended < 1 h ago (same as calendar.js)
const HORIZON_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_CALENDARS = 10;
const MAX_PER_CALENDAR = 100;
const TIMEOUT_MS = 10000;

export function googleConfigured(env) {
  return !!(env.AUTH0_DOMAIN && env.AUTH0_CLIENT_ID && env.AUTH0_CLIENT_SECRET && env.RELAY_PUBLIC_URL);
}

const callbackUrl = (env) => `${env.RELAY_PUBLIC_URL.replace(/\/$/, '')}/auth/google/callback`;

/** Where to send the browser to connect Google Calendar. */
export function authorizeUrl(env, state) {
  const u = new URL(`https://${env.AUTH0_DOMAIN}/authorize`);
  u.search = new URLSearchParams({
    response_type: 'code',
    client_id: env.AUTH0_CLIENT_ID,
    redirect_uri: callbackUrl(env),
    scope: 'openid email profile',
    connection: 'google-oauth2',
    connection_scope: GOOGLE_SCOPE,
    access_type: 'offline',     // Google refresh token, so it keeps working after the access token expires
    prompt: 'consent',
    state,
  }).toString();
  return u.toString();
}

async function json(r, what) {
  if (!r.ok) throw new Error(`${what}: HTTP ${r.status} ${(await r.text()).slice(0, 160)}`);
  return r.json();
}

/** Callback: authorization code -> { sub, email } of the Auth0 user. */
export async function exchangeCode(env, code, { fetchImpl = fetch } = {}) {
  const tokens = await json(await fetchImpl(`https://${env.AUTH0_DOMAIN}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'authorization_code', code, redirect_uri: callbackUrl(env),
      client_id: env.AUTH0_CLIENT_ID, client_secret: env.AUTH0_CLIENT_SECRET,
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }), 'Auth0 token exchange');
  // Straight from Auth0's token endpoint over TLS, so reading the payload is enough here.
  const payload = JSON.parse(Buffer.from(String(tokens.id_token).split('.')[1], 'base64url').toString());
  if (!payload.sub) throw new Error('Auth0 returned no user id');
  return { sub: payload.sub, email: payload.email ?? null };
}

// ── Auth0 Management API: the user's Google tokens ─────────────────────────────
let mgmt = { token: null, exp: 0 };
const googleAccess = new Map();   // sub -> { token, exp } (refreshed Google access tokens)

async function managementToken(env, fetchImpl) {
  if (mgmt.token && Date.now() < mgmt.exp - 60000) return mgmt.token;
  const t = await json(await fetchImpl(`https://${env.AUTH0_DOMAIN}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'client_credentials', audience: `https://${env.AUTH0_DOMAIN}/api/v2/`,
      client_id: env.AUTH0_CLIENT_ID, client_secret: env.AUTH0_CLIENT_SECRET,
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }), 'Auth0 Management token (authorize the app for the Management API: read:users, read:user_idp_tokens)');
  mgmt = { token: t.access_token, exp: Date.now() + (t.expires_in ?? 3600) * 1000 };
  return mgmt.token;
}

async function googleIdentity(env, sub, fetchImpl) {
  const token = await managementToken(env, fetchImpl);
  const user = await json(await fetchImpl(
    `https://${env.AUTH0_DOMAIN}/api/v2/users/${encodeURIComponent(sub)}?fields=identities&include_fields=true`,
    { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(TIMEOUT_MS) },
  ), 'Auth0 user lookup');
  const id = (user.identities ?? []).find((i) => i.provider === 'google-oauth2');
  if (!id?.access_token) throw new Error('no Google token on this Auth0 user (missing read:user_idp_tokens?)');
  return id;
}

async function refreshGoogle(env, refreshToken, fetchImpl) {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) throw new Error('Google token expired; set GOOGLE_CLIENT_ID/SECRET so the relay can refresh it');
  const t = await json(await fetchImpl('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token', refresh_token: refreshToken,
      client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET,
    }).toString(),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }), 'Google token refresh');
  return { token: t.access_token, exp: Date.now() + (t.expires_in ?? 3600) * 1000 };
}

/** GET a Calendar API path, refreshing the Google token once if it has expired. */
async function calendarGet(env, sub, path, fetchImpl) {
  const cached = googleAccess.get(sub);
  let identity = null;
  let token = cached && Date.now() < cached.exp - 60000 ? cached.token : null;
  if (!token) {
    identity = await googleIdentity(env, sub, fetchImpl);
    token = identity.access_token;
  }
  const get = (t) => fetchImpl(`${CAL_API}${path}`, { headers: { authorization: `Bearer ${t}` }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  let r = await get(token);
  if (r.status === 401) {
    identity ??= await googleIdentity(env, sub, fetchImpl);
    if (!identity.refresh_token) throw new Error('Google access expired and there is no refresh token: reconnect Google Calendar');
    const fresh = await refreshGoogle(env, identity.refresh_token, fetchImpl);
    googleAccess.set(sub, fresh);
    r = await get(fresh.token);
  } else if (!cached || cached.token !== token) {
    googleAccess.set(sub, { token, exp: Date.now() + 50 * 60 * 1000 });
  }
  return json(r, `Google Calendar ${path.split('?')[0]}`);
}

/** All-day "2026-10-24" -> local midnight (epoch ms) in the relay's time zone. */
function dayStart(date, tz) {
  const [y, m, d] = date.split('-').map(Number);
  return wallToUtc({ y, m, d, h: 0, mi: 0 }, tz);
}

/** Google event -> agenda item (same shape as calendar.js / ics.js, plus a link to it). */
export function toItem(ev, calendarId, tz = localTimeZone()) {
  if (ev.status === 'cancelled' || !ev.start) return null;
  const allDay = !!ev.start.date;
  const start = allDay ? dayStart(ev.start.date, tz) : Date.parse(ev.start.dateTime);
  const end = ev.end ? (ev.end.date ? dayStart(ev.end.date, tz) : Date.parse(ev.end.dateTime)) : null;
  if (!Number.isFinite(start)) return null;
  return {
    id: `g:${calendarId}:${ev.id}`,
    title: String(ev.summary || '(no title)').slice(0, 120),
    kind: 'event',
    start, end, all_day: allDay,
    link: ev.htmlLink || 'https://calendar.google.com/',
    source: 'google',
  };
}

/** Every calendar in the user's Google list -> agenda items for the next week. */
export async function fetchGoogleEvents(env, sub, { now = Date.now(), fetchImpl = fetch, tz = localTimeZone() } = {}) {
  const list = await calendarGet(env, sub, '/users/me/calendarList?minAccessRole=reader&fields=items(id,selected,primary)', fetchImpl);
  const calendars = (list.items ?? []).filter((c) => c.selected || c.primary).slice(0, MAX_CALENDARS);
  const range = new URLSearchParams({
    singleEvents: 'true', orderBy: 'startTime', maxResults: String(MAX_PER_CALENDAR),
    timeMin: new Date(now - PAST_MS).toISOString(), timeMax: new Date(now + HORIZON_MS).toISOString(),
    fields: 'items(id,summary,status,start,end,htmlLink)',
  }).toString();
  const results = await Promise.allSettled(calendars.map((c) =>
    calendarGet(env, sub, `/calendars/${encodeURIComponent(c.id)}/events?${range}`, fetchImpl)
      .then((page) => (page.items ?? []).map((ev) => toItem(ev, c.id, tz)).filter(Boolean))));
  const items = results.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
  const failed = results.filter((r) => r.status === 'rejected').length;
  items.sort((a, b) => a.start - b.start);
  return { items, calendars: calendars.length, failed };
}

/** For tests: forget cached tokens. */
export function _resetCaches() {
  mgmt = { token: null, exp: 0 };
  googleAccess.clear();
}
