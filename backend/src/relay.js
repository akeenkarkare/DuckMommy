// Duck Daddy relay: one duck <-> many dashboards, live only. Nothing here touches event storage.
//
//   duck      --auth {role:"duck", token}-->          events in, settings/commands out
//   dashboard --auth {role:"dashboard", access_token}--> buffer + live events in, commands out
//
// The duck belongs to the "active user": whoever most recently opened the dashboard.

import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { createClient } from '@supabase/supabase-js';
import { buildAgenda, feedUrls } from './calendar.js';
import { authorizeUrl, exchangeCode, fetchGoogleEvents, googleConfigured } from './google.js';
import { localTimeZone } from './ics.js';
import { imessageConfigured, sendIMessage, sentryText } from './imessage.js';
import { daySummary, dueReminders } from './reminders.js';
import { writeNudge } from './nudge.js';
import { alertPhone } from './notify.js';
import { mentionsDuck, quickIntent } from './quick.js';
import { answerAgenda, answerLookup, answerRecall, friendlyWhen, parseRemindAt, transcribe, understand } from './memory.js';

const { SUPABASE_URL, SUPABASE_SECRET_KEY, DUCK_TOKEN, ELEVENLABS_API_KEY, ELEVENLABS_VOICE_ID, ANTHROPIC_API_KEY } = process.env;
const ELEVENLABS_MODEL_ID = process.env.ELEVENLABS_MODEL_ID || 'eleven_flash_v2_5';
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-haiku-5-5';
// Memory locker (POST /voice): Claude cleans up what was said and answers "what did I tell you...".
const MEMORY_MODEL = process.env.MEMORY_MODEL || ANTHROPIC_MODEL;   // fast model: the duck answers out loud
const MEMORY_TZ = process.env.MEMORY_TZ || localTimeZone();
const MEMORY_RECALL_LIMIT = 500;      // newest N memories go to Claude for a recall question (~15k tokens)
const VOICE_MAX_BYTES = 1024 * 1024;  // ~30 s of 16 kHz mono WAV
// Voice reminders ("hey duck, remind me in 5 days to ..."): saved in `reminders`, spoken when due.
const VOICE_REMINDER_TICK_MS = 15 * 1000;
const LATE_REMINDER_MS = 10 * 60 * 1000;
// "Remind me to drink water" -> "Okay but when?": the duck listens again without the wake word, and the
// answer ("in two minutes") is read together with the first request. userId -> { heard, until }.
const FOLLOW_UP_MS = 30 * 1000;
// Where the duck is, for "what's the weather" / "near me" lookups (Claude's web search user_location).
const LOOKUP_PLACE = process.env.DUCK_PLACE || 'Stony Brook, New York';
const LOOKUP_LOCATION = process.env.DUCK_PLACE
  ? { city: process.env.DUCK_PLACE.split(',')[0].trim(), timezone: localTimeZone() }
  : { city: 'Stony Brook', region: 'New York', country: 'US', timezone: 'America/New_York' };
const voiceFollowUps = new Map();   // later than this (you were away) -> "earlier you asked me to..."
const TTS_SAMPLE_RATE = 22050;
const PORT = Number(process.env.RELAY_PORT ?? 8080);
for (const [k, v] of Object.entries({ SUPABASE_URL, SUPABASE_SECRET_KEY, DUCK_TOKEN })) {
  if (!v) throw new Error(`Missing ${k} in backend/.env`);
}

const BUFFER_MS = 5 * 60 * 1000;
const AUTH_TIMEOUT_MS = 5000;
const HEARTBEAT_MS = 15000;
const EVENT_TYPES = new Set(['posture', 'pat', 'sentry', 'focus', 'presence', 'sign', 'sound', 'coach', 'memory']);
// Pushed to the Pi. calendar_urls is deliberately NOT here: the links are secret and only the relay fetches them.
const SETTINGS_FIELDS = [
  'volume', 'posture_message', 'sentry_message', 'presence_message',
  'posture_severity', 'posture_delay_s', 'sentry_enabled', 'quack_enabled',
  'sign_enabled', 'sound_alerts_enabled',
  'coach_enabled', 'coach_interval_min', 'coach_tone',
];
const COACH_COMMANDS = new Set(['start_focus', 'break', 'finish', 'time_left', 'more_time']);

// Live camera view (dashboard Camera panel). Default: any logged-in user the duck is with.
// VIDEO_VIEWERS=a@x.com,b@y.com restricts it to those accounts; VIDEO_VIEWERS=off disables it.
// Frames are never stored.
const VIDEO_VIEWERS = (process.env.VIDEO_VIEWERS || '*').split(',').map((s) => s.trim().toLowerCase())
  .filter((s) => s && s !== 'off');
const VIDEO_FPS = Math.max(1, Math.min(15, Number(process.env.VIDEO_FPS) || 6));
const VIDEO_MAX_BUFFER = 1024 * 1024;   // a watcher this far behind skips frames
const videoAllowed = (email) => VIDEO_VIEWERS.includes('*') || (!!email && VIDEO_VIEWERS.includes(email.toLowerCase()));
const AGENDA_REFRESH_MS = 10 * 60 * 1000;   // iCal feeds
const GOOGLE_REFRESH_MS = 60 * 1000;        // Google Calendar (and the timer that drives both)

// Google Calendar through Auth0 (see google.js + backend/CLAUDE.md for the setup).
const GOOGLE_ENV = {
  AUTH0_DOMAIN: process.env.AUTH0_DOMAIN, AUTH0_CLIENT_ID: process.env.AUTH0_CLIENT_ID,
  AUTH0_CLIENT_SECRET: process.env.AUTH0_CLIENT_SECRET, GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET,
  // Where browsers reach this relay / the dashboard (the Google callback goes here). Set both on a server.
  RELAY_PUBLIC_URL: process.env.RELAY_PUBLIC_URL || `http://localhost:${process.env.RELAY_PORT ?? 8080}`,
};
const DASHBOARD_URL = (process.env.DASHBOARD_URL || 'http://localhost:3000').replace(/\/$/, '');
const CONNECT_STATE_MS = 10 * 60 * 1000;
// Sentry -> iMessage (Photon), to the active user's profiles.phone (else SENTRY_IMESSAGE_TO).
const IMESSAGE_ENV = {
  SPECTRUM_PROJECT_ID: process.env.SPECTRUM_PROJECT_ID, SPECTRUM_PROJECT_SECRET: process.env.SPECTRUM_PROJECT_SECRET,
  SENTRY_IMESSAGE_TO: process.env.SENTRY_IMESSAGE_TO?.trim(),
};
const IMESSAGE_COOLDOWN_MS = 60 * 1000;   // one text per sighting, not one per frame (Photon caps texts/day)
let lastIMessageAt = 0;
const REMINDER_TICK_MS = 10 * 1000;

const supabase = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

let duck = null;            // the one duck's socket
let duckPresent = null;     // last presence the duck reported (null = unknown)
let activeUserId = null;    // who the duck belongs to right now
let activeSettings = null;  // that user's settings row
let activeName = null;      // their display name, for the coach's lines
const buffers = new Map();  // user_id -> events from the last 5 min
const agendas = new Map();  // user_id -> { key, items, errors, feeds, fetched_at, google }
const googleLinks = new Map();   // user_id -> { sub, email } | null  (cache of the google_calendar table)
const connectStates = new Map(); // OAuth state -> { userId, exp }
const remindersFired = new Set(); // "<item id>@<start>:soon|now" already spoken

const log = (...args) => console.log(new Date().toISOString().slice(11, 19), ...args);
const send = (ws, msg) => ws?.readyState === 1 && ws.send(JSON.stringify(msg));

// ─── buffer ──────────────────────────────────────────────────────────────────
function recentEvents(userId) {
  const cutoff = Date.now() - BUFFER_MS;
  const events = (buffers.get(userId) ?? []).filter((e) => e.ts >= cutoff);
  buffers.set(userId, events);
  return events;
}

// ─── dashboards ──────────────────────────────────────────────────────────────
function dashboards() {
  return [...wss.clients].filter((ws) => ws.role === 'dashboard');
}

function sendToUser(userId, msg) {
  for (const ws of dashboards()) if (ws.userId === userId) send(ws, msg);
}

function broadcastStatus() {
  for (const ws of dashboards()) {
    send(ws, { type: 'status', duck_connected: !!duck, with_you: ws.userId === activeUserId });
  }
  updateVideo();
}

// ─── live view ───────────────────────────────────────────────────────────────
// Only the active user's own dashboards, only allowed accounts, only while they ask.
const watchers = () => dashboards().filter((ws) => ws.readyState === 1 && ws.watching && ws.userId === activeUserId && videoAllowed(ws.email));
let videoOn = false;
function updateVideo() {
  const on = !!duck && watchers().length > 0;
  for (const ws of dashboards()) {
    if (!ws.watching) continue;
    const reason = !videoAllowed(ws.email)
      ? (VIDEO_VIEWERS.length ? 'This account isn\'t allowed to watch (VIDEO_VIEWERS in backend/.env).' : 'Live view is turned off on this server (VIDEO_VIEWERS=off in backend/.env).')
      : ws.userId !== activeUserId ? 'The duck is with someone else.' : !duck ? 'Duck offline.' : null;
    send(ws, { type: 'video_status', streaming: on && !reason, reason, fps: VIDEO_FPS });
  }
  if (on !== videoOn) {
    videoOn = on;
    send(duck, { type: 'video', on, fps: VIDEO_FPS });
    log(`live view ${on ? 'on' : 'off'}`);
  }
}

function forwardFrame(data) {
  if (!activeUserId) return;
  for (const ws of watchers()) {
    if (ws.bufferedAmount < VIDEO_MAX_BUFFER) ws.send(data, { binary: true });
  }
}

// ─── settings ────────────────────────────────────────────────────────────────
function pushSettings() {
  if (!duck || !activeSettings) return;
  const settings = Object.fromEntries(SETTINGS_FIELDS.map((k) => [k, activeSettings[k]]));
  send(duck, { type: 'settings', settings });
  log('→ duck settings', JSON.stringify(settings));
}

async function loadSettings(userId) {
  const { data, error } = await supabase.from('settings').select('*').eq('user_id', userId).single();
  if (error) return log('settings load failed:', error.message);
  if (userId !== activeUserId) return; // active user changed while we waited
  activeSettings = data;
  pushSettings();
  refreshAgenda(userId, data.calendar_urls);
}

async function setActiveUser(userId) {
  const changed = userId !== activeUserId;
  activeUserId = userId;
  if (changed) {
    activeSettings = null;
    activeName = null;
    log('duck is now with', userId);
    supabase.from('profiles').select('display_name').eq('user_id', userId).single()
      .then(({ data }) => { if (userId === activeUserId) activeName = data?.display_name ?? null; });
  }
  await loadSettings(userId);
}

// ─── agenda (calendar feeds) ─────────────────────────────────────────────────
function sendAgenda(userId) {
  const a = agendas.get(userId);
  if (!a) return;
  sendToUser(userId, { type: 'agenda', items: a.items, errors: a.errors, feeds: a.feeds, fetched_at: a.fetched_at, google: a.google });
  if (userId === activeUserId) {
    const items = a.items.map(({ id, title, kind, start, end, all_day }) => ({ id, title, kind, start, end, all_day }));
    send(duck, { type: 'agenda', items });
  }
}

const refreshing = new Set();
async function refreshAgenda(userId, urlsText, { force = false } = {}) {
  const link = await googleLink(userId);
  const urls = feedUrls(urlsText).join('\n');
  const key = urls + (link ? `\ngoogle:${link.sub}` : '');
  const cached = agendas.get(userId);
  const maxAge = link ? GOOGLE_REFRESH_MS : AGENDA_REFRESH_MS;   // Google is cheap to ask; new events show within a minute
  if (!force && cached && cached.key === key && Date.now() - cached.fetched_at < maxAge) {
    return sendAgenda(userId);
  }
  if (refreshing.has(userId)) return;
  refreshing.add(userId);
  try {
    // iCal feeds are slow and change rarely: reuse them for AGENDA_REFRESH_MS unless forced by the user.
    let ics = cached?.urls === urls && Date.now() - cached.ics.fetched_at < AGENDA_REFRESH_MS && force !== 'all'
      ? cached.ics : null;
    if (!ics) ics = urls ? await buildAgenda(urls) : { items: [], errors: [], feeds: 0, fetched_at: Date.now() };
    const agenda = { ...ics, items: [...ics.items], errors: [...ics.errors], fetched_at: Date.now() };
    agenda.google = { available: googleConfigured(GOOGLE_ENV), connected: !!link, email: link?.email ?? null };
    if (link) {   // Google Calendar (via Auth0) joins the iCal feeds in one agenda
      try {
        const g = await fetchGoogleEvents(GOOGLE_ENV, link.sub);
        agenda.items = [...agenda.items, ...g.items].sort((a, b) => a.start - b.start).slice(0, 120);
        agenda.google.calendars = g.calendars;
        for (const e of g.errors ?? []) {
          log('google calendar read failed', e);
          agenda.errors.push(`Google Calendar · ${e.slice(0, 200)}`);
        }
      } catch (e) {
        log('google calendar failed', e.message);
        agenda.errors.push(`Google Calendar: ${e.message}`);
      }
    }
    agendas.set(userId, { key, urls, ics, ...agenda });
    if (key) log(`agenda for ${userId}: ${agenda.items.length} items from ${agenda.feeds} feed(s)${agenda.errors.length ? `, ${agenda.errors.length} error(s)` : ''}`);
    sendAgenda(userId);
  } finally {
    refreshing.delete(userId);
  }
}

setInterval(() => {
  if (activeUserId && activeSettings) refreshAgenda(activeUserId, activeSettings.calendar_urls, { force: true });
}, GOOGLE_REFRESH_MS);

// Backup path: dashboard writes settings to Supabase, Realtime tells us.
supabase
  .channel('settings-changes')
  .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'settings' }, ({ new: row }) => {
    if (row.user_id !== activeUserId) return;
    activeSettings = row;
    pushSettings();
    refreshAgenda(row.user_id, row.calendar_urls);
  })
  .subscribe((status) => log('realtime settings:', status));

// ─── auth ────────────────────────────────────────────────────────────────────
function tokenMatches(given) {
  const a = Buffer.from(String(given ?? ''));
  const b = Buffer.from(DUCK_TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function handleAuth(ws, msg) {
  if (msg.type !== 'auth') return ws.close(4001, 'auth first');

  if (msg.role === 'duck') {
    if (!tokenMatches(msg.token)) return ws.close(4003, 'bad duck token');
    if (duck && duck !== ws) duck.close(4000, 'replaced by new duck connection');
    duck = ws;
    ws.role = 'duck';
    send(ws, { type: 'auth_ok' });
    log('duck connected');
    videoOn = false;   // fresh duck: tell it again if anyone is watching (broadcastStatus -> updateVideo)
    pushSettings();
    if (activeUserId) sendAgenda(activeUserId);
    broadcastStatus();
    return;
  }

  if (msg.role === 'dashboard') {
    const { data, error } = await supabase.auth.getUser(msg.access_token);
    if (error || !data?.user) return ws.close(4003, 'bad session');
    ws.role = 'dashboard';
    ws.userId = data.user.id; // from the verified JWT only
    ws.email = data.user.email ?? null;
    send(ws, { type: 'auth_ok', user_id: ws.userId });
    send(ws, { type: 'buffer', events: recentEvents(ws.userId) });
    log('dashboard connected', ws.userId);
    await setActiveUser(ws.userId);
    broadcastStatus();
    return;
  }

  ws.close(4001, 'unknown role');
}

// ─── messages ────────────────────────────────────────────────────────────────
function handleDuck(msg) {
  if (msg.type !== 'event' || !EVENT_TYPES.has(msg.event?.type)) return;
  if (msg.event.type === 'presence') duckPresent = !!msg.event.value?.present;   // voice reminders wait until you're back
  if (!activeUserId) return log('dropped', msg.event.type, '(no active user)');

  const ts = Number.isFinite(msg.event.ts) ? msg.event.ts : Date.now();
  const event = { user_id: activeUserId, type: msg.event.type, value: msg.event.value ?? null, ts };
  recentEvents(activeUserId).push(event);
  sendToUser(activeUserId, { type: 'event', event });
  log('event', event.type, JSON.stringify(event.value));
  if (event.type === 'sentry' && event.value?.person_confirmed) sentryAlerts(event);   // fire and forget
}

// A confirmed person: push to the active user's own ntfy topic and text their phone number.
// The profile is read now, so a topic or number changed a minute ago on the dashboard is the one used.
async function sentryAlerts(event) {
  const userId = event.user_id;
  const { data: profile, error } = await supabase.from('profiles').select('*').eq('user_id', userId).maybeSingle();
  if (error) log('sentry alerts: profile lookup failed', error.message);
  alertPhone(event, log, profile?.ntfy_topic || undefined);   // undefined -> the shared NTFY_TOPIC, if any
  textSentryAlert(profile?.phone);
}

// Same moment and same words as the dashboard's "Possible intruder" pop-up, even with no tab open.
async function textSentryAlert(phone) {
  if (!imessageConfigured(IMESSAGE_ENV) || Date.now() - lastIMessageAt < IMESSAGE_COOLDOWN_MS) return;
  lastIMessageAt = Date.now();
  const to = phone || IMESSAGE_ENV.SENTRY_IMESSAGE_TO;
  if (!to) return log('sentry iMessage skipped: no phone on the profile and no SENTRY_IMESSAGE_TO');
  try {
    await sendIMessage(IMESSAGE_ENV, to, sentryText());
    log('sentry iMessage sent');
  } catch (e) {
    log('sentry iMessage failed', e.message);
  }
}

function handleDashboard(ws, msg) {
  const isActive = ws.userId === activeUserId;

  if (msg.type === 'settings_changed') {
    if (isActive) loadSettings(ws.userId);
    return;
  }

  if (msg.type === 'video') {   // {type:"video", on} from the Camera panel's live view
    ws.watching = !!msg.on;
    if (!msg.on) send(ws, { type: 'video_status', streaming: false, reason: null, fps: VIDEO_FPS });
    updateVideo();
    return;
  }

  if (msg.type === 'google_connect') {   // Calendar tab: "Connect Google Calendar"
    if (!googleConfigured(GOOGLE_ENV)) return send(ws, { type: 'google_error', error: 'Google Calendar isn\'t set up on the relay yet (AUTH0_* in backend/.env).' });
    const state = randomBytes(18).toString('base64url');
    connectStates.set(state, { userId: ws.userId, exp: Date.now() + CONNECT_STATE_MS });
    return send(ws, { type: 'google_auth_url', url: authorizeUrl(GOOGLE_ENV, state) });
  }

  if (msg.type === 'google_disconnect') {
    supabase.from('google_calendar').delete().eq('user_id', ws.userId).then(({ error }) => {
      if (error) return send(ws, { type: 'google_error', error: error.message });
      googleLinks.set(ws.userId, null);
      log('google calendar disconnected for', ws.userId);
      return supabase.from('settings').select('calendar_urls').eq('user_id', ws.userId).single()
        .then(({ data }) => refreshAgenda(ws.userId, data?.calendar_urls, { force: true }));
    });
    return;
  }

  if (msg.type === 'say_agenda') {   // "Read my day aloud"
    const a = agendas.get(ws.userId);
    const ok = isActive && !!duck;
    if (ok) for (const text of daySummary(a?.items ?? [], Date.now(), { tz: localTimeZone() })) send(duck, { type: 'command', command: { type: 'say', text } });
    return send(ws, { type: 'command_ack', ok, command: 'say_agenda' });
  }

  if (msg.type === 'agenda_refresh') {   // "refresh" button: re-read this user's own links
    supabase.from('settings').select('calendar_urls').eq('user_id', ws.userId).single()
      .then(({ data }) => refreshAgenda(ws.userId, data?.calendar_urls, { force: 'all' }));
    return;
  }

  if (msg.type === 'command') {
    const { command } = msg;
    let ok = isActive && !!duck;
    if (ok && command?.type === 'say') {
      const text = String(command.text ?? '').trim().slice(0, 200);
      ok = !!text;
      if (ok) send(duck, { type: 'command', command: { type: 'say', text } });
    } else if (ok && command?.type === 'quack') {
      send(duck, { type: 'command', command: { type: 'quack' } });
    } else if (ok && command?.type === 'coach' && COACH_COMMANDS.has(command.name)) {
      send(duck, { type: 'command', command: { type: 'coach', name: command.name } });
    } else {
      ok = false;
    }
    send(ws, { type: 'command_ack', ok, command: command?.type });
    if (ok) log('→ duck command', command.type);
  }
}

// ─── server ──────────────────────────────────────────────────────────────────
// ─── TTS proxy: the duck posts text, we return ElevenLabs audio ─────────────
// Keeps the API key on the laptop and works when the Pi has no internet of its own.
// Response: raw 16-bit little-endian mono PCM at TTS_SAMPLE_RATE.
async function handleTts(req, res) {
  const auth = String(req.headers.authorization ?? '');
  if (!tokenMatches(auth.replace(/^Bearer /, ''))) return res.writeHead(401).end();
  if (!ELEVENLABS_API_KEY || !ELEVENLABS_VOICE_ID) return res.writeHead(503).end('ElevenLabs not configured');

  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 4096) return res.writeHead(413).end();
  }
  let text;
  try { text = String(JSON.parse(body).text ?? '').trim().slice(0, 300); } catch { return res.writeHead(400).end(); }
  if (!text) return res.writeHead(400).end();

  try {
    const t0 = Date.now();
    const r = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(ELEVENLABS_VOICE_ID)}/stream?output_format=pcm_${TTS_SAMPLE_RATE}`,
      {
        method: 'POST',
        headers: { 'xi-api-key': ELEVENLABS_API_KEY, 'content-type': 'application/json' },
        body: JSON.stringify({ text, model_id: ELEVENLABS_MODEL_ID }),
        signal: AbortSignal.timeout(15000),
      },
    );
    if (!r.ok) {
      log('tts failed', r.status, (await r.text()).slice(0, 200));
      return res.writeHead(502).end();
    }
    // Stream it through: the duck starts playing on the first chunk instead of after the whole clip.
    res.writeHead(200, { 'content-type': `audio/L16; rate=${TTS_SAMPLE_RATE}; channels=1`, 'x-sample-rate': TTS_SAMPLE_RATE });
    let bytes = 0, first = 0;
    for await (const chunk of r.body) { if (!bytes) first = Date.now() - t0; bytes += chunk.length; res.write(chunk); }
    res.end();
    log(`tts ${bytes} bytes, first audio ${first} ms, done ${Date.now() - t0} ms: "${text.slice(0, 40)}"`);
  } catch (e) {
    log('tts error', e.message);
    if (res.headersSent) res.destroy();   // cut off mid-stream: the duck drops the partial clip
    else res.writeHead(504).end();
  }
}

// ─── coach lines: the duck posts {kind, tone, facts}, we return {text} from Claude ──
// Same deal as /tts: the key stays here. 503 when not configured -> the Pi uses templates.
async function handleNudge(req, res) {
  const auth = String(req.headers.authorization ?? '');
  if (!tokenMatches(auth.replace(/^Bearer /, ''))) return res.writeHead(401).end();
  if (!ANTHROPIC_API_KEY) return res.writeHead(503).end('Anthropic not configured');
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 8192) return res.writeHead(413).end();
  }
  let input;
  try { input = JSON.parse(body); } catch { return res.writeHead(400).end(); }
  try {
    const text = await writeNudge({
      apiKey: ANTHROPIC_API_KEY, model: ANTHROPIC_MODEL,
      kind: input.kind, tone: input.tone, facts: input.facts, name: activeName,
    });
    if (!text) { log('nudge failed: empty reply'); return res.writeHead(502).end(); }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ text }));
    log(`nudge ${input.kind}: "${text.slice(0, 60)}"`);
  } catch (e) {
    log('nudge failed', e.message);
    res.writeHead(e.name === 'TimeoutError' ? 504 : 502).end();
  }
}

// ─── Google Calendar: link storage, OAuth callback, spoken reminders ────────────
async function googleLink(userId) {
  if (googleLinks.has(userId)) return googleLinks.get(userId);
  const { data, error } = await supabase.from('google_calendar').select('auth0_sub, email').eq('user_id', userId).maybeSingle();
  if (error) {   // table missing until migration 004 is run: behave as "not connected"
    log('google_calendar lookup failed (run migration 004?):', error.message);
    return null;
  }
  const link = data ? { sub: data.auth0_sub, email: data.email } : null;
  googleLinks.set(userId, link);
  return link;
}

async function handleGoogleCallback(req, res) {
  const back = (result, reason) => {
    res.writeHead(302, { location: `${DASHBOARD_URL}/?calendar=${result}${reason ? `&reason=${encodeURIComponent(reason)}` : ''}` });
    res.end();
  };
  const q = new URL(req.url, 'http://relay').searchParams;
  const pending = connectStates.get(q.get('state'));
  connectStates.delete(q.get('state'));
  if (!pending || pending.exp < Date.now()) return back('error', 'That link expired. Try Connect again.');
  if (q.get('error')) return back('error', q.get('error_description') || q.get('error'));
  try {
    const { sub, email } = await exchangeCode(GOOGLE_ENV, q.get('code'));
    const { error } = await supabase.from('google_calendar')
      .upsert({ user_id: pending.userId, auth0_sub: sub, email, connected_at: new Date().toISOString() });
    if (error) throw new Error(error.message);
    googleLinks.set(pending.userId, { sub, email });
    log('google calendar connected for', pending.userId, email ?? sub);
    const { data } = await supabase.from('settings').select('calendar_urls').eq('user_id', pending.userId).single();
    refreshAgenda(pending.userId, data?.calendar_urls, { force: true });
    back('connected');
  } catch (e) {
    log('google connect failed', e.message);
    back('error', e.message.slice(0, 160));
  }
}

// 5 minutes before and at the start of each timed event: the duck says it, the dashboard shows it.
setInterval(() => {
  for (const [state, p] of connectStates) if (p.exp < Date.now()) connectStates.delete(state);
  if (!activeUserId) return;
  const a = agendas.get(activeUserId);
  for (const r of dueReminders(a?.items, Date.now(), remindersFired)) {
    if (duck) send(duck, { type: 'command', command: { type: 'say', text: r.text } });
    const event = { user_id: activeUserId, type: 'calendar', value: { text: r.text, title: r.title, when: r.when, start: r.start }, ts: Date.now() };
    recentEvents(activeUserId).push(event);
    sendToUser(activeUserId, { type: 'event', event });
    log('reminder:', r.text);
  }
}, REMINDER_TICK_MS);

// ─── Memory locker: "hey duck, remember ..." / "hey duck, what did I tell you ..." ─
// The duck records what was said after the wake word and posts it as audio/wav (or JSON {text}
// for testing). We transcribe it, let Claude work out what was meant, then save to or search the
// active user's `memories` table. Response: { say, intent, heard } — the duck speaks `say`.
function voiceReply(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function emitToActive(type, value) {
  if (!activeUserId) return;
  const event = { user_id: activeUserId, type, value, ts: Date.now() };
  recentEvents(activeUserId).push(event);
  sendToUser(activeUserId, { type: 'event', event });
}

async function handleVoice(req, res) {
  const auth = String(req.headers.authorization ?? '');
  if (!tokenMatches(auth.replace(/^Bearer /, ''))) return res.writeHead(401).end();
  if (!ANTHROPIC_API_KEY) return res.writeHead(503).end('Anthropic not configured');

  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > VOICE_MAX_BYTES) { res.writeHead(413).end(); return void req.destroy(); }
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks);
  const userId = activeUserId;   // pin both: the active user could change while we wait on the APIs
  const name = activeName;
  if (!userId) return voiceReply(res, 200, { intent: 'none', heard: '', say: 'Open the dashboard first so I know who you are.' });

  const t0 = Date.now(), timing = {};
  res.on('finish', () => log(`voice timing: speech-to-text ${timing.stt ?? '-'} ms, understand ${timing.understand ?? '-'} ms, lookup ${timing.lookup ?? '-'} ms, total ${Date.now() - t0} ms (${timing.path === 'quick' ? 'quick path, no Claude' : MEMORY_MODEL})`));
  try {
    let heard;
    if (String(req.headers['content-type'] ?? '').startsWith('application/json')) {
      let parsed;
      try { parsed = JSON.parse(body.toString()); } catch { return res.writeHead(400).end(); }
      heard = String(parsed?.text ?? '').trim().slice(0, 1000);
    } else {
      if (!ELEVENLABS_API_KEY) return res.writeHead(503).end('ElevenLabs not configured');
      heard = await transcribe({ apiKey: ELEVENLABS_API_KEY, wav: body });
    }
    timing.stt = Date.now() - t0;
    log(`voice heard ${heard.length} chars`);   // not the words: they can be private
    if (!heard) return voiceReply(res, 200, { intent: 'other', heard, say: "Sorry, I didn't catch that." });

    const now = Date.now();
    const pending = voiceFollowUps.get(userId);
    voiceFollowUps.delete(userId);
    const transcript = pending && pending.until > now ? `${pending.heard} ... ${heard}` : heard;
    // Simple commands ("sentry mode on", "let's lock in", "what time is it") skip Claude: ~2 s faster.
    const quick = pending ? null : quickIntent(heard, { now, tz: MEMORY_TZ });
    const meant = quick ?? await understand({ apiKey: ANTHROPIC_API_KEY, model: MEMORY_MODEL, transcript, name, now, tz: MEMORY_TZ });
    timing.path = quick ? 'quick' : 'claude';
    timing.understand = Date.now() - now;
    const askBack = (say) => {   // a question back: remember what was said, listen for the answer
      voiceFollowUps.set(userId, { heard: transcript, until: Date.now() + FOLLOW_UP_MS });
      return voiceReply(res, 200, { intent: 'remind', heard, say, listen: true });
    };

    if (meant.intent === 'remember' && meant.memory) {
      const { error } = await supabase.from('memories').insert({ user_id: userId, text: meant.memory, source: 'voice' });
      if (error) {
        log('memory save failed', error.message);
        return voiceReply(res, 200, { intent: 'remember', heard, say: "Sorry, I couldn't save that one." });
      }
      if (userId === activeUserId) emitToActive('memory', { action: 'saved', text: meant.memory });
      log('memory saved');
      return voiceReply(res, 200, { intent: 'remember', heard, memory: meant.memory, say: "Got it, I'll remember that." });
    }

    if (meant.intent === 'recall') {
      const { data, error } = await supabase.from('memories').select('id, text, created_at')
        .eq('user_id', userId).order('created_at', { ascending: false }).limit(MEMORY_RECALL_LIMIT);
      if (error) {
        log('memory load failed', error.message);
        return voiceReply(res, 200, { intent: 'recall', heard, say: "Not gonna lie, I can't reach my notes right now." });
      }
      const question = meant.question || heard;
      const { text: answer, sources } = await answerRecall({
        apiKey: ANTHROPIC_API_KEY, model: MEMORY_MODEL, question,
        memories: (data ?? []).reverse(), tz: MEMORY_TZ, name,
      });
      // sources: ids of the notes the answer came from; the Nest flashes them
      if (userId === activeUserId) emitToActive('memory', { action: 'recall', question, answer, sources });
      log('memory recall answered');
      return voiceReply(res, 200, { intent: 'recall', heard, say: answer || "I don't have a note about that, bestie. Did you actually tell me?" });
    }

    if (meant.intent === 'remind') {
      if (!meant.reminder) return askBack('Remind you about what, bestie?');
      const due = parseRemindAt(meant.remind_at, MEMORY_TZ, now);
      if (!due) return askBack(`Okay but when should I remind you to ${meant.reminder}?`);
      const { error } = await supabase.from('reminders')
        .insert({ user_id: userId, text: meant.reminder, due_at: new Date(due).toISOString(), source: 'voice' });
      if (error) {
        log('reminder save failed (run migration 005?):', error.message);
        return voiceReply(res, 200, { intent: 'remind', heard, say: "That reminder did not go through, that's an L. Try again?" });
      }
      if (userId === activeUserId) emitToActive('memory', { action: 'reminder_set', text: meant.reminder, due_at: due });
      log('reminder set for', new Date(due).toISOString());
      return voiceReply(res, 200, { intent: 'remind', heard, say: `Bet. I'll remind you ${friendlyWhen(due, now, MEMORY_TZ)} to ${meant.reminder}. No cap.` });
    }

    if (meant.intent === 'agenda') {
      const items = (agendas.get(userId)?.items ?? []).filter((i) => (i.end ?? i.start) >= now);
      const { data: pending } = await supabase.from('reminders').select('text, due_at')
        .eq('user_id', userId).is('delivered_at', null).order('due_at', { ascending: true }).limit(20);
      const question = meant.question || heard;
      const answer = await answerAgenda({
        apiKey: ANTHROPIC_API_KEY, model: MEMORY_MODEL, question, items, reminders: pending ?? [], now, tz: MEMORY_TZ, name,
      });
      if (userId === activeUserId) emitToActive('memory', { action: 'agenda', question, answer });
      log('agenda question answered');
      return voiceReply(res, 200, { intent: 'agenda', heard, say: answer || "Nothing on your calendar for that. You're free, bestie." });
    }

    if (meant.intent === 'lookup') {   // Claude + web search: weather, news, scores, hours...
      if (userId === activeUserId && duck) {   // searching takes a few seconds: say something now
        send(duck, { type: 'command', command: { type: 'say', text: 'Hold up, let me look that up.', now: true } });
      }
      const question = meant.question || heard;
      let answer = '';
      try {
        answer = await answerLookup({ apiKey: ANTHROPIC_API_KEY, model: MEMORY_MODEL, question, now, tz: MEMORY_TZ, name,
          place: LOOKUP_PLACE, location: LOOKUP_LOCATION });
      } catch (e) {
        log('lookup failed', e.message);
      }
      timing.lookup = Date.now() - now - (timing.understand ?? 0);
      if (answer && userId === activeUserId) emitToActive('memory', { action: 'lookup', question, answer });
      return voiceReply(res, 200, { intent: 'lookup', heard, say: answer || "I couldn't look that up right now. Try again in a sec." });
    }

    if (meant.intent === 'sentry') {   // "hey duck, sentry mode on": same setting as the dashboard toggle
      const on = meant.sentry === 'on';
      const { error } = await supabase.from('settings').update({ sentry_enabled: on }).eq('user_id', userId);
      if (error) {
        log('sentry setting failed', error.message);
        return voiceReply(res, 200, { intent: 'sentry', heard, say: "Couldn't flip sentry mode, that's an L. Try the dashboard." });
      }
      if (userId === activeUserId && activeSettings) {
        activeSettings.sentry_enabled = on;
        pushSettings();
      }
      sendToUser(userId, { type: 'settings_patch', settings: { sentry_enabled: on } });   // flips the dashboard toggle
      log('voice sentry', on ? 'on' : 'off');
      return voiceReply(res, 200, { intent: 'sentry', heard, say: on
        ? "Sentry mode on. Go do your thing, I'll guard the desk and ping your laptop if anyone shows up."
        : 'Sentry mode off. The desk is all yours, bestie.' });
    }

    if (meant.intent === 'focus') {   // the duck's own coach answers ("Locking in for 25...")
      if (userId !== activeUserId || !duck) return voiceReply(res, 200, { intent: 'focus', heard, say: "My focus timer is ghosting me right now. Try again in a sec." });
      send(duck, { type: 'command', command: { type: 'coach', name: meant.focus } });
      log('voice focus command', meant.focus);
      return voiceReply(res, 200, { intent: 'focus', heard, focus: meant.focus, say: '', quiet: true });
    }

    // The wake word misfired on a conversation nearby (no "duck" anywhere in it): don't butt in.
    if (!pending && !mentionsDuck(heard)) {
      log('voice ignored: no wake word in the transcript');
      return voiceReply(res, 200, { intent: 'none', heard, say: '', quiet: true });
    }
    return voiceReply(res, 200, { intent: 'other', heard, say: meant.reply || "Wait, what? Say that again. You can say remember, remind me, or ask what's on your calendar." });
  } catch (e) {
    log('voice failed', e.message);
    return voiceReply(res, e.name === 'TimeoutError' ? 504 : 502, { intent: 'error', heard: '', say: 'My brain is buffering. Try again in a sec.' });
  }

}
// Voice reminders that are due: said by the duck once you're at the desk, then marked delivered.
let reminderBusy = false, reminderTableWarned = false;
setInterval(async () => {
  if (reminderBusy || !activeUserId || !duck || duckPresent === false) return;
  reminderBusy = true;
  const userId = activeUserId, name = activeName;
  try {
    const now = Date.now();
    const { data, error } = await supabase.from('reminders').select('id, text, due_at')
      .eq('user_id', userId).is('delivered_at', null).lte('due_at', new Date(now).toISOString())
      .order('due_at', { ascending: true }).limit(3);
    if (error) {
      if (!reminderTableWarned) log('voice reminders off (run migrations/005_reminders.sql?):', error.message);
      reminderTableWarned = true;
      return;
    }
    for (const r of data ?? []) {
      // claim it first so a slow tick or a second relay can't say it twice
      const { data: claimed } = await supabase.from('reminders').update({ delivered_at: new Date().toISOString() })
        .eq('id', r.id).is('delivered_at', null).select('id');
      if (!claimed?.length || userId !== activeUserId || !duck) continue;
      const hey = name ? `Yo ${String(name).split(/\s+/)[0]}, ` : 'Yo bestie, ';
      const late = now - Date.parse(r.due_at) > LATE_REMINDER_MS;
      const text = late ? `${hey}you told me to remind you to ${r.text}. I'm just the messenger.` : `${hey}it's time to ${r.text}. No excuses.`;
      send(duck, { type: 'command', command: { type: 'say', text } });
      emitToActive('memory', { action: 'reminder_due', text: r.text, due_at: Date.parse(r.due_at), late });
      log('voice reminder delivered', late ? '(late)' : '');
    }
  } catch (e) {
    log('voice reminder tick failed', e.message);
  } finally {
    reminderBusy = false;
  }
}, VOICE_REMINDER_TICK_MS);

const server = createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/tts') return void handleTts(req, res);
  if (req.method === 'POST' && req.url === '/nudge') return void handleNudge(req, res);
  if (req.method === 'POST' && req.url === '/voice') return void handleVoice(req, res);
  if (req.method === 'GET' && req.url.startsWith('/auth/google/callback')) return void handleGoogleCallback(req, res);
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, duck_connected: !!duck, dashboards: dashboards().length, tts: !!(ELEVENLABS_API_KEY && ELEVENLABS_VOICE_ID), coach_ai: !!ANTHROPIC_API_KEY, memory: !!(ANTHROPIC_API_KEY && ELEVENLABS_API_KEY), google_calendar: googleConfigured(GOOGLE_ENV), sentry_imessage: imessageConfigured(IMESSAGE_ENV), live_view: VIDEO_VIEWERS.length > 0, watching: watchers().length }));
  }
  res.writeHead(404).end();
});

const wss = new WebSocketServer({ server, maxPayload: 512 * 1024 });   // room for a camera frame

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => (ws.isAlive = true));
  const authTimer = setTimeout(() => !ws.role && ws.close(4001, 'auth timeout'), AUTH_TIMEOUT_MS);

  ws.on('message', async (raw, isBinary) => {
    if (isBinary) {   // only the authenticated duck may send frames
      if (ws.role === 'duck' && ws === duck) forwardFrame(raw);
      return;
    }
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!ws.role) {
      if (ws.authing) return;
      ws.authing = true;
      try { await handleAuth(ws, msg); } finally { ws.authing = false; }
      if (ws.role) clearTimeout(authTimer);
      return;
    }
    if (ws.role === 'duck') handleDuck(msg);
    else handleDashboard(ws, msg);
  });

  ws.on('close', () => {
    clearTimeout(authTimer);
    if (ws === duck) {
      duck = null;
      duckPresent = null;
      log('duck disconnected');
    } else if (ws.role === 'dashboard') {
      log('dashboard disconnected', ws.userId);
    }
    broadcastStatus();
  });
});

setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, HEARTBEAT_MS);

server.listen(PORT, () => {
  log(`relay listening on port ${PORT} (${GOOGLE_ENV.RELAY_PUBLIC_URL.replace(/^http/, 'ws')})`);
  log(!VIDEO_VIEWERS.length ? 'live view off (VIDEO_VIEWERS=off)'
    : VIDEO_VIEWERS.includes('*') ? 'live view on for any logged-in user the duck is with'
    : `live view only for: ${VIDEO_VIEWERS.join(', ')}`);
});
