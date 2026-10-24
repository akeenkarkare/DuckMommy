// Duck Daddy relay: one duck <-> many dashboards, live only. Nothing here touches event storage.
//
//   duck      --auth {role:"duck", token}-->          events in, settings/commands out
//   dashboard --auth {role:"dashboard", access_token}--> buffer + live events in, commands out
//
// The duck belongs to the "active user": whoever most recently opened the dashboard.

import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { createClient } from '@supabase/supabase-js';
import { buildAgenda, feedUrls } from './calendar.js';
import { writeNudge } from './nudge.js';

const { SUPABASE_URL, SUPABASE_SECRET_KEY, DUCK_TOKEN, ELEVENLABS_API_KEY, ELEVENLABS_VOICE_ID, ANTHROPIC_API_KEY } = process.env;
const ELEVENLABS_MODEL_ID = process.env.ELEVENLABS_MODEL_ID || 'eleven_flash_v2_5';
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-haiku-5-5';
const TTS_SAMPLE_RATE = 22050;
const PORT = Number(process.env.RELAY_PORT ?? 8080);
for (const [k, v] of Object.entries({ SUPABASE_URL, SUPABASE_SECRET_KEY, DUCK_TOKEN })) {
  if (!v) throw new Error(`Missing ${k} in backend/.env`);
}

const BUFFER_MS = 5 * 60 * 1000;
const AUTH_TIMEOUT_MS = 5000;
const HEARTBEAT_MS = 15000;
const EVENT_TYPES = new Set(['posture', 'pat', 'sentry', 'focus', 'presence', 'sign', 'sound', 'coach']);
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
const AGENDA_REFRESH_MS = 10 * 60 * 1000;

const supabase = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

let duck = null;            // the one duck's socket
let activeUserId = null;    // who the duck belongs to right now
let activeSettings = null;  // that user's settings row
let activeName = null;      // their display name, for the coach's lines
const buffers = new Map();  // user_id -> events from the last 5 min
const agendas = new Map();  // user_id -> { key, items, errors, feeds, fetched_at }

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
  sendToUser(userId, { type: 'agenda', items: a.items, errors: a.errors, feeds: a.feeds, fetched_at: a.fetched_at });
  if (userId === activeUserId) {
    const items = a.items.map(({ id, title, kind, start, end, all_day }) => ({ id, title, kind, start, end, all_day }));
    send(duck, { type: 'agenda', items });
  }
}

const refreshing = new Set();
async function refreshAgenda(userId, urlsText, { force = false } = {}) {
  const key = feedUrls(urlsText).join('\n');
  const cached = agendas.get(userId);
  if (!force && cached && cached.key === key && Date.now() - cached.fetched_at < AGENDA_REFRESH_MS) {
    return sendAgenda(userId);
  }
  if (refreshing.has(userId)) return;
  refreshing.add(userId);
  try {
    const agenda = key ? await buildAgenda(key) : { items: [], errors: [], feeds: 0, fetched_at: Date.now() };
    agendas.set(userId, { key, ...agenda });
    if (key) log(`agenda for ${userId}: ${agenda.items.length} items from ${agenda.feeds} feed(s)${agenda.errors.length ? `, ${agenda.errors.length} error(s)` : ''}`);
    sendAgenda(userId);
  } finally {
    refreshing.delete(userId);
  }
}

setInterval(() => {
  if (activeUserId && activeSettings) refreshAgenda(activeUserId, activeSettings.calendar_urls, { force: true });
}, AGENDA_REFRESH_MS);

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
  if (!activeUserId) return log('dropped', msg.event.type, '(no active user)');

  const ts = Number.isFinite(msg.event.ts) ? msg.event.ts : Date.now();
  const event = { user_id: activeUserId, type: msg.event.type, value: msg.event.value ?? null, ts };
  recentEvents(activeUserId).push(event);
  sendToUser(activeUserId, { type: 'event', event });
  log('event', event.type, JSON.stringify(event.value));
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

  if (msg.type === 'agenda_refresh') {   // "refresh" button: re-read this user's own links
    supabase.from('settings').select('calendar_urls').eq('user_id', ws.userId).single()
      .then(({ data }) => refreshAgenda(ws.userId, data?.calendar_urls, { force: true }));
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
    const r = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(ELEVENLABS_VOICE_ID)}?output_format=pcm_${TTS_SAMPLE_RATE}`,
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
    const audio = Buffer.from(await r.arrayBuffer());
    res.writeHead(200, { 'content-type': `audio/L16; rate=${TTS_SAMPLE_RATE}; channels=1`, 'x-sample-rate': TTS_SAMPLE_RATE });
    res.end(audio);
    log(`tts ${audio.length} bytes: "${text.slice(0, 40)}"`);
  } catch (e) {
    log('tts error', e.message);
    res.writeHead(504).end();
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
    if (!text) return res.writeHead(502).end();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ text }));
    log(`nudge ${input.kind}: "${text.slice(0, 60)}"`);
  } catch (e) {
    log('nudge failed', e.message);
    res.writeHead(e.name === 'TimeoutError' ? 504 : 502).end();
  }
}

const server = createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/tts') return void handleTts(req, res);
  if (req.method === 'POST' && req.url === '/nudge') return void handleNudge(req, res);
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, duck_connected: !!duck, dashboards: dashboards().length, tts: !!(ELEVENLABS_API_KEY && ELEVENLABS_VOICE_ID), coach_ai: !!ANTHROPIC_API_KEY, live_view: VIDEO_VIEWERS.length > 0, watching: watchers().length }));
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
  log(`relay listening on ws://localhost:${PORT}`);
  log(!VIDEO_VIEWERS.length ? 'live view off (VIDEO_VIEWERS=off)'
    : VIDEO_VIEWERS.includes('*') ? 'live view on for any logged-in user the duck is with'
    : `live view only for: ${VIDEO_VIEWERS.join(', ')}`);
});
