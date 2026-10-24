// Fake duck: stands in for the Pi until the real sensors are wired up.
// Speaks the same protocol as the Pi will: auth with DUCK_TOKEN, send events, obey settings/commands.
// Reactions (TTS, quack) are printed instead of played.
// 
//   npm run duck        realistic pacing
//   npm run duck:fast   4x speed, for demos/testing

import WebSocket from 'ws';

const RELAY_URL = process.env.SIM_RELAY_URL ?? `ws://localhost:${process.env.RELAY_PORT ?? 8080}`;
const { DUCK_TOKEN } = process.env;
if (!DUCK_TOKEN) throw new Error('Missing DUCK_TOKEN in backend/.env');

const SPEED = process.argv.includes('--fast') ? 4 : 1;
const TICK_MS = 1000 / SPEED; // one tick = one simulated second

// Mirrors the schema defaults until the relay sends the real ones.
let settings = {
  volume: 70, posture_message: 'Sit up straight!', sentry_message: 'Who goes there?',
  presence_message: 'Welcome back!', posture_severity: 50, posture_delay_s: 5,
  sentry_enabled: false, quack_enabled: true, sign_enabled: true, sound_alerts_enabled: true,
};

const SIGN_PHRASES = [['hello'], ['I love you'], ['yes'], ['no'], ['hello', 'you'], ['D', 'U', 'C', 'K']];
const SOUNDS = [
  ['doorbell', 'Doorbell'], ['doorbell', 'Knock'], ['phone', 'Ringtone'],
  ['notification', 'Beep, bleep'], ['alarm', 'Smoke detector, smoke alarm'], ['calling', 'Shout'],
];

const rand = (min, max) => min + Math.random() * (max - min);
const randInt = (min, max) => Math.round(rand(min, max));
const chance = (perSecond) => Math.random() < perSecond;
const round1 = (n) => Math.round(n * 10) / 10;
const log = (...args) => console.log(new Date().toISOString().slice(11, 19), ...args);

// ─── uplink with offline queue (same behaviour the Pi needs) ───────────────
let ws = null;
let backoff = 1000;
const queue = [];

function connect() {
  ws = new WebSocket(RELAY_URL);
  ws.on('open', () => ws.send(JSON.stringify({ type: 'auth', role: 'duck', token: DUCK_TOKEN })));
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw);
    if (msg.type === 'auth_ok') {
      log(`connected to ${RELAY_URL}`);
      backoff = 1000;
      while (queue.length && ws.readyState === 1) ws.send(JSON.stringify(queue.shift()));
    } else if (msg.type === 'settings') {
      settings = { ...settings, ...msg.settings };
      log('settings updated', JSON.stringify(msg.settings));
    } else if (msg.type === 'command') {
      if (msg.command.type === 'say') speak(msg.command.text);
      if (msg.command.type === 'quack') quack();
      if (msg.command.type === 'coach') {   // the real duck runs pi/coach; this just answers
        const text = `(coach: ${msg.command.name})`;
        speak(text);
        emit('coach', { kind: msg.command.name, text, source: 'template', item: null, focus_minutes_left: null });
      }
    } else if (msg.type === 'agenda') {
      log(`agenda: ${msg.items.length} item(s)${msg.items[0] ? `, next "${msg.items[0].title}"` : ''}`);
    }
  });
  ws.on('close', (code, reason) => {
    log(`disconnected (${code}${reason.length ? ` ${reason}` : ''}), retrying in ${backoff / 1000}s`);
    setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, 10000);
  });
  ws.on('error', () => {}); // 'close' follows and handles the retry
}

function emit(type, value) {
  const msg = { type: 'event', event: { type, value, ts: Date.now() } };
  if (ws?.readyState === 1) ws.send(JSON.stringify(msg));
  else if (queue.push(msg) > 1000) queue.shift();
  log('event', type, JSON.stringify(value));
}

// ─── reactions (the real Pi plays these) ───────────────────────────────────
function speak(text) {
  log(`🔊 [vol ${settings.volume}] "${text}"`);
}
function quack() {
  log(`🦆 [vol ${settings.volume}] QUACK`);
}

// ─── simulated world ───────────────────────────────────────────────────────
let present = false;
let stateLeft = 3;           // seconds until the person arrives/leaves
let slouch = null;           // { since, angle, prompted, lastPrompt } while slouching
let cameraWarm = 0;          // sentry: seconds the camera stays on after motion

function arrive() {
  present = true;
  stateLeft = randInt(150, 360);
  emit('presence', { present: true, distance_cm: randInt(45, 75) });
  log('📷 camera on');
  if (settings.presence_message) speak(settings.presence_message);
}

function leave() {
  present = false;
  stateLeft = randInt(25, 90);
  if (slouch) endSlouch();
  emit('presence', { present: false, distance_cm: randInt(160, 320) });
  log('📷 camera off');
}

function endSlouch() {
  const duration = slouch.since;
  if (slouch.prompted) {
    emit('posture', { state: 'upright', neck_angle_deg: round1(rand(6, 14)), slouch_duration_s: duration });
  }
  slouch = null;
}

function tickPresent() {
  // Posture: occasional slouches; people usually fix it soon after the duck speaks.
  if (!slouch) {
    if (chance(1 / 35)) slouch = { since: 0, angle: rand(24, 38), prompted: false, lastPrompt: 0 };
  } else {
    slouch.since += 1;
    slouch.angle = Math.min(45, slouch.angle + rand(-0.8, 1.2));
    const delay = settings.posture_delay_s;

    if (!slouch.prompted && slouch.since >= delay) {
      slouch.prompted = true;
      slouch.lastPrompt = slouch.since;
      emit('posture', { state: 'slouch', neck_angle_deg: round1(slouch.angle), slouch_duration_s: slouch.since });
      speak(settings.posture_message);
    } else if (slouch.prompted && slouch.since - slouch.lastPrompt >= 30) {
      slouch.lastPrompt = slouch.since; // still slouching: remind
      emit('posture', { state: 'slouch', neck_angle_deg: round1(slouch.angle), slouch_duration_s: slouch.since });
      speak(settings.posture_message);
    } else if (chance(slouch.prompted ? 0.25 : 0.04)) {
      endSlouch(); // unprompted fixes before the delay never produce an event
    }
  }

  if (chance(1 / 50)) {
    emit('pat', { touch_ms: randInt(120, 650) });
    if (settings.quack_enabled) quack();
  }

  if (chance(1 / 400)) emit('focus', { source: 'nfc', action: 'tap' });

  // Sign to Duck: letters join into a word, words join with spaces (same as pi/sign/signs.py)
  if (settings.sign_enabled && chance(1 / 90)) {
    const signs = SIGN_PHRASES[randInt(0, SIGN_PHRASES.length - 1)];
    const text = signs.every((s) => s.length === 1) ? signs.join('').toLowerCase() : signs.join(' ');
    emit('sign', { text, signs });
    speak(text);
  }
}

// Microphone: doorbells, phones, alarms -> LED. Runs whether or not anyone's at the desk.
function tickSounds() {
  if (!settings.sound_alerts_enabled || !chance(1 / 150)) return;
  const [kind, label] = SOUNDS[randInt(0, SOUNDS.length - 1)];
  emit('sound', { kind, label, score: round1(rand(0.45, 0.95)) });
  log(`💡 LED: ${kind} pattern`);
}

function tickAway() {
  if (!settings.sentry_enabled) return;
  if (cameraWarm > 0) { cameraWarm -= 1; if (cameraWarm === 0) log('📷 camera off (sentry)'); return; }
  if (!chance(1 / 40)) return;

  // Ultrasonic sees motion -> camera wakes -> OpenCV decides if it's a person.
  cameraWarm = 8;
  log('📷 camera on (sentry: motion)');
  const person = Math.random() < 0.6;
  emit('sentry', {
    distance_cm: randInt(80, 220),
    person_confirmed: person,
    confidence: round1(person ? rand(0.7, 0.97) : rand(0.1, 0.45)),
    night: Math.random() < 0.5,
    trigger: 'ultrasonic',
  });
  if (person) speak(settings.sentry_message);
}

setInterval(() => {
  stateLeft -= 1;
  tickSounds();
  if (stateLeft <= 0) (present ? leave : arrive)();
  else if (present) tickPresent();
  else tickAway();
}, TICK_MS);

log(`fake duck starting (speed ${SPEED}x)`);
connect();
