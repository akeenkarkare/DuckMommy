'use client';

import { useState } from 'react';
import SlouchChart from './SlouchChart';
import SignCard from './SignCard';
import EventLog from './EventLog';
import { RangeField, TextField, Toggle } from './Controls';

const clock = (ts) => new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
const ago = (ts, now) => {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  return s < 60 ? `${s}s ago` : `${Math.floor(s / 60)}m ago`;
};
const SOUND = {
  doorbell: ['🚪', 'Doorbell / knock', 'fast blink'],
  phone: ['📞', 'Phone ringing', 'slow pulse'],
  alarm: ['🚨', 'Alarm', 'strobe'],
  notification: ['🔔', 'Notification', 'three blinks'],
  calling: ['📣', 'Someone calling', 'long glows'],
};

function CameraPanel({ events, now, windowMs, s }) {
  const posture = [...events].reverse().find((e) => e.type === 'posture');
  const presence = [...events].reverse().find((e) => e.type === 'presence');
  const slouches = events.filter((e) => e.type === 'posture' && e.value?.state === 'slouch').length;
  const sentries = events.filter((e) => e.type === 'sentry').slice(-4).reverse();
  return (
    <>
      <div className="tiles">
        <div className="tile"><div className="label">Posture</div><div className="value">{!posture ? '—' : posture.value?.state === 'slouch' ? 'Slouch' : 'Upright'}</div></div>
        <div className="tile"><div className="label">Slouches · 5m</div><div className="value">{slouches}</div></div>
        <div className="tile"><div className="label">At desk</div><div className="value">{!presence ? '—' : presence.value?.present ? 'Yes' : 'Away'}</div></div>
      </div>
      <div className="card">
        <h2>Slouch prompts <span className="sub">per 30 s · last 5 min</span></h2>
        <SlouchChart events={events} now={now} windowMs={windowMs} />
      </div>
      <SignCard events={events} />
      <div className="section">
        <h3>Posture</h3>
        <RangeField s={s} k="posture_severity" label="Severity" hint="0 = only big slouches count · 100 = any lean counts" />
        <RangeField s={s} k="posture_delay_s" label="Speak after slouching for" min={1} max={30} format={(v) => `${v}s`} />
      </div>
      <div className="section">
        <h3>Sentry · night vision</h3>
        <Toggle s={s} k="sentry_enabled" label="Guard my desk while I'm away" />
        <Toggle s={s} k="sign_enabled" label="Sign to Duck" hint="Reads ASL signs aloud" />
        {sentries.length > 0 && (
          <ul className="list">
            {sentries.map((e, i) => (
              <li key={`${e.ts}-${i}`}>
                <span><span className="icon">{e.value?.person_confirmed ? '🕵️' : '👣'}</span>
                  {e.value?.person_confirmed ? 'Person spotted' : 'Motion only'}{e.value?.night ? ' · night' : ''}</span>
                <span className="time">{ago(e.ts, now)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}

function PettingPanel({ events, now, s, send, canCommand, duck }) {
  const pats = events.filter((e) => e.type === 'pat');
  const last = pats[pats.length - 1];
  return (
    <>
      <div>
        <div className="big-stat">{pats.length}<small>pats · 5 min</small></div>
        <p className="hint">{last ? `Last pat ${ago(last.ts, now)}, held ${last.value?.touch_ms} ms` : 'Press the top of its head. It quacks.'}</p>
      </div>
      <div className="row">
        <button className="btn primary" disabled={!canCommand}
          onClick={() => { send({ type: 'command', command: { type: 'quack' } }); duck.react({ type: 'quack' }); }}>
          🦆 Make it quack
        </button>
        {!canCommand && <span className="hint">Duck offline</span>}
      </div>
      <div className="section">
        <h3>Behaviour</h3>
        <Toggle s={s} k="quack_enabled" label="Quack when its head is pressed" />
        <RangeField s={s} k="volume" label="Volume" />
      </div>
      {pats.length > 0 && (
        <ul className="list">
          {pats.slice(-5).reverse().map((e, i) => (
            <li key={`${e.ts}-${i}`}><span><span className="icon">✋</span>{e.value?.touch_ms} ms press</span><span className="time">{clock(e.ts)}</span></li>
          ))}
        </ul>
      )}
    </>
  );
}

function MicrophonePanel({ events, now, s }) {
  const sounds = events.filter((e) => e.type === 'sound').slice(-8).reverse();
  return (
    <>
      <p className="hint" style={{ margin: 0 }}>The duck listens for sounds you might miss and flashes its LED. Each sound has its own pattern.</p>
      <Toggle s={s} k="sound_alerts_enabled" label="Flash for doorbells, phones and alarms" />
      <div className="section">
        <h3>Heard recently</h3>
        {sounds.length === 0 ? <p className="empty">All quiet.</p> : (
          <ul className="list">
            {sounds.map((e, i) => {
              const [icon, name, led] = SOUND[e.value?.kind] ?? ['🔊', e.value?.label, 'blink'];
              return (
                <li key={`${e.ts}-${i}`}>
                  <span><span className="icon">{icon}</span>{name} <span className="hint">· LED {led}</span></span>
                  <span className="time">{ago(e.ts, now)}</span>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <div className="section">
        <h3>LED patterns</h3>
        <ul className="list">
          {Object.entries(SOUND).map(([k, [icon, name, led]]) => (
            <li key={k}><span><span className="icon">{icon}</span>{name}</span><span className="time">{led}</span></li>
          ))}
        </ul>
      </div>
    </>
  );
}

const QUICK = ['Hello!', 'Time for a break 🧘', 'Great posture!', 'Drink some water', 'Quack quack'];

function VoicePanel({ s, send, canCommand, duck, lastAck, now }) {
  const [text, setText] = useState('');
  const say = (t) => {
    if (!t.trim()) return;
    send({ type: 'command', command: { type: 'say', text: t } });
    duck.react({ type: 'say', value: { text: t } });
  };
  return (
    <>
      <form className="row" onSubmit={(e) => { e.preventDefault(); say(text); setText(''); }}>
        <input className="input" style={{ flex: 1, minWidth: 0 }} maxLength={200} placeholder="Make the duck say…" value={text} onChange={(e) => setText(e.target.value)} />
        <button className="btn primary" type="submit" disabled={!canCommand}>Say</button>
      </form>
      <div className="chips">
        {QUICK.map((q) => <button key={q} className="chip" disabled={!canCommand} onClick={() => say(q)}>{q}</button>)}
      </div>
      {lastAck && !lastAck.ok && now - lastAck.at < 10000 && <p className="error">The duck didn’t get that.</p>}
      <div className="section">
        <h3>What it says</h3>
        <TextField s={s} k="posture_message" label="When you slouch" />
        <TextField s={s} k="presence_message" label="When you sit down" optional />
        <TextField s={s} k="sentry_message" label="When it spots someone" />
        <RangeField s={s} k="volume" label="Volume" />
        <p className="hint">Spoken in the duck’s own ElevenLabs voice.</p>
      </div>
    </>
  );
}

function FocusPanel({ events, now }) {
  const taps = events.filter((e) => e.type === 'focus').slice(-6).reverse();
  return (
    <>
      <div>
        <div className="big-stat">{taps.length}<small>taps · 5 min</small></div>
        <p className="hint">Tap your phone on the tag on its back to start a focus session. iOS opens the Focus shortcut and blocks distracting apps.</p>
      </div>
      {taps.length > 0 && (
        <ul className="list">
          {taps.map((e, i) => <li key={`${e.ts}-${i}`}><span><span className="icon">🎯</span>Focus started</span><span className="time">{ago(e.ts, now)}</span></li>)}
        </ul>
      )}
    </>
  );
}

function ActivityPanel({ events }) {
  return <EventLog events={events} />;
}

export const PANELS = {
  camera: { kicker: 'Left eye', title: 'Camera', Body: CameraPanel },
  petting: { kicker: 'Top of head', title: 'Petting', Body: PettingPanel },
  voice: { kicker: 'Beak', title: 'Voice', Body: VoicePanel },
  microphone: { kicker: 'Chest', title: 'Microphone', Body: MicrophonePanel },
  focus: { kicker: 'Back', title: 'Focus tag', Body: FocusPanel },
  activity: { kicker: 'Live', title: 'Activity', Body: ActivityPanel },
};
