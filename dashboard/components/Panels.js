'use client';

import { useState } from 'react';
import SlouchChart from './SlouchChart';
import SignCard from './SignCard';
import EventLog from './EventLog';
import LiveView from './LiveView';
import NestPanel from './NestPanel';
import { RangeField, SelectField, TextField, Toggle } from './Controls';

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

function CameraPanel({ events, now, windowMs, s, watch, video, canCommand }) {
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
      <LiveView watch={watch} video={video} canCommand={canCommand} />
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

// The running focus session, from the duck's own coach events: {left} minutes, or null.
export function focusSession(events, now) {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type !== 'coach') continue;
    if (['focus_done', 'finish', 'break_start', 'break_over'].includes(e.value?.kind)) return null;
    if (e.value?.focus_minutes_left != null) {
      const left = Math.round((e.ts + e.value.focus_minutes_left * 60000 - now) / 60000);
      return left > 0 ? { left } : null;
    }
  }
  return null;
}

const when = (ms, now, allDay) => {
  const min = Math.round((ms - now) / 60000);
  if (min < 0) return 'now';
  if (allDay) return min < 24 * 60 ? 'today' : new Date(ms).toLocaleDateString([], { weekday: 'short' });
  if (min < 60) return `in ${min} min`;
  if (min < 24 * 60) return `in ${Math.round(min / 60)} h · ${new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
  return new Date(ms).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
};

const FOCUS_BUTTONS = [
  ['start_focus', '🎯 Start focus', 'primary'], ['more_time', '+10 min'], ['time_left', 'Time left?'],
  ['break', '☕ Break'], ['finish', '✓ Done'],
];
const TONES = [['gentle', 'Gentle: sweet bestie'], ['coach', 'Coach: hype + a little roast'], ['savage', 'Savage: full Gen Z roast']];

function FocusPanel({ events, allEvents, now, s, send, canCommand, agenda }) {
  const taps = events.filter((e) => e.type === 'focus').slice(-6).reverse();
  const lines = allEvents.filter((e) => e.type === 'coach').slice(-6).reverse();
  const session = focusSession(allEvents, now);
  const nextDue = agenda.items.find((i) => i.kind === 'due' && i.start > now);
  const coach = (name) => send({ type: 'command', command: { type: 'coach', name } });
  return (
    <>
      <div className="tiles">
        <div className="tile"><div className="label">Focus</div><div className="value">{session ? `${session.left}m` : 'Off'}</div></div>
        <div className="tile"><div className="label">Next due</div><div className="value" title={nextDue?.title}>{nextDue ? when(nextDue.start, now).replace(/ ·.*/, '') : '—'}</div></div>
        <div className="tile"><div className="label">Coach</div><div className="value">{s.settings?.coach_enabled === false ? 'Off' : 'On'}</div></div>
      </div>
      <div className="chips">
        {FOCUS_BUTTONS.map(([name, text, kind]) => (
          <button key={name} className={kind === 'primary' ? 'btn primary' : 'chip'} disabled={!canCommand} onClick={() => coach(name)}>{text}</button>
        ))}
      </div>
      <p className="hint" style={{ margin: 0 }}>
        Or sign <b>START FOCUS</b>, <b>REST</b>, <b>FINISH</b>, <b>TIME</b>, <b>MORE TIME</b> at the duck. While you focus it stays quiet except for deadlines.
      </p>
      <div className="section">
        <h3>The duck said</h3>
        {lines.length === 0 ? <p className="empty">Nothing yet. It checks in while you work and reminds you before things are due.</p> : (
          <ul className="list">
            {lines.map((e, i) => (
              <li key={`${e.ts}-${i}`}><span><span className="icon">🦆</span>{e.value?.text}</span><span className="time">{ago(e.ts, now)}</span></li>
            ))}
          </ul>
        )}
      </div>
      <div className="section">
        <h3>Lock-in coach</h3>
        <Toggle s={s} k="coach_enabled" label="Nudge me to lock in" hint="Check-ins, deadline reminders, “zoned out?” after 5 min of no movement"
          migration="003_coach_and_calendar.sql" />
        <RangeField s={s} k="coach_interval_min" label="Check in / focus length" min={5} max={60} format={(v) => `${v} min`} />
        <SelectField s={s} k="coach_tone" label="Personality" options={TONES} />
      </div>
      <div className="section">
        <h3>NFC focus tag</h3>
        <p className="hint" style={{ margin: 0 }}>Tap your phone on the tag on its back. iOS opens the Focus shortcut and blocks distracting apps.</p>
        {taps.length > 0 && (
          <ul className="list">
            {taps.map((e, i) => <li key={`${e.ts}-${i}`}><span><span className="icon">🎯</span>Tag tapped</span><span className="time">{ago(e.ts, now)}</span></li>)}
          </ul>
        )}
      </div>
    </>
  );
}

function CalendarField({ s }) {
  if (!s.settings) return null;
  if (!('calendar_urls' in s.settings)) {
    return <p className="hint">Run backend/supabase/migrations/003_coach_and_calendar.sql to add calendars.</p>;
  }
  return (
    <div className="field">
      <label htmlFor="calendar_urls">Calendar links <span className="hint">one per line · private</span></label>
      <textarea id="calendar_urls" className="input" rows={3} maxLength={2000} spellCheck={false}
        placeholder={'https://calendar.google.com/calendar/ical/…/basic.ics\nhttps://…brightspace…/feed.ics'}
        value={s.settings.calendar_urls ?? ''}
        onChange={(e) => s.change('calendar_urls', e.target.value || null, 1200)} />
      <span className="hint">
        Google Calendar: Settings → your calendar → <i>Secret address in iCal format</i>. Brightspace / Canvas: Calendar → Subscribe / iCal feed.
        Only the relay on this laptop reads these links; the duck just gets titles and times.
      </span>
    </div>
  );
}

const GOOGLE_CALENDAR = 'https://calendar.google.com/';

function GoogleCalendar({ agenda, send, connected, notice }) {
  const g = agenda.google ?? {};
  if (g.connected) {
    return (
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <span><span className="icon">🟢</span>Google Calendar{g.email ? ` · ${g.email}` : ''}{g.calendars ? <span className="hint"> · {g.calendars} calendar{g.calendars > 1 ? 's' : ''}</span> : null}</span>
        <button className="chip" disabled={!connected} onClick={() => send({ type: 'google_disconnect' })}>Disconnect</button>
      </div>
    );
  }
  return (
    <div className="section">
      <button className="btn primary" disabled={!connected || g.available === false} onClick={() => send({ type: 'google_connect' })}>
        Connect Google Calendar
      </button>
      {g.available === false && <p className="hint" style={{ margin: 0 }}>Google sign-in isn’t set up on the relay yet (AUTH0_* in backend/.env).</p>}
      {notice && <p className={notice.ok ? 'hint' : 'error'} style={{ margin: 0 }}>{notice.text}</p>}
    </div>
  );
}

function CalendarPanel({ now, s, send, agenda, connected, canCommand, googleNotice }) {
  const upcoming = agenda.items.filter((i) => (i.end ?? i.start) >= now);
  const fetched = agenda.fetched_at ? ago(agenda.fetched_at, now) : null;
  const sources = (agenda.feeds ?? 0) + (agenda.google?.connected ? 1 : 0);
  return (
    <>
      {googleNotice?.ok && <p className="hint" style={{ margin: 0 }}>{googleNotice.text}</p>}
      <GoogleCalendar agenda={agenda} send={send} connected={connected} notice={googleNotice?.ok ? null : googleNotice} />
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <span className="hint">{sources ? `${sources} calendar source${sources > 1 ? 's' : ''}${fetched ? ` · updated ${fetched}` : ''}` : 'No calendars yet'}</span>
        <span className="row" style={{ gap: 6 }}>
          <button className="chip" disabled={!canCommand || !upcoming.length} onClick={() => send({ type: 'say_agenda' })}>🔊 Read my day</button>
          <button className="chip" disabled={!connected} onClick={() => send({ type: 'agenda_refresh' })}>↻ Refresh</button>
        </span>
      </div>
      {agenda.errors?.map((e) => <p key={e} className="error">{e}</p>)}
      <div className="section">
        <h3>Coming up · next 7 days</h3>
        {upcoming.length === 0 ? <p className="empty">{sources ? 'Nothing in the next 7 days. Enjoy it.' : 'Connect Google Calendar (or add a calendar link below) and the duck will remind you before things start.'}</p> : (
          <ul className="list cal-list">
            {upcoming.map((i) => (
              <li key={i.id}>
                <a href={i.link ?? GOOGLE_CALENDAR} target="_blank" rel="noreferrer" title="Open in Google Calendar">
                  <span><span className="icon">{i.kind === 'due' ? '📌' : '📅'}</span>{i.title}{i.kind === 'due' && <span className="hint"> · due</span>}</span>
                  <span className="time">{when(i.start, now, i.all_day)}</span>
                </a>
              </li>
            ))}
          </ul>
        )}
        <a className="btn" href={GOOGLE_CALENDAR} target="_blank" rel="noreferrer">Open Google Calendar ↗</a>
        <p className="hint" style={{ margin: 0 }}>Events: the duck says it out loud 5 minutes before and again when it starts. Deadlines: reminders 24 h, 3 h, 1 h and 15 min before, and when you sit down.</p>
      </div>
      <div className="section">
        <h3>Other calendars (iCal links)</h3>
        <CalendarField s={s} />
      </div>
    </>
  );
}

function ActivityPanel({ events }) {
  return <EventLog events={events} />;
}

export const PANELS = {
  camera: { kicker: 'Right eye', title: 'Camera', Body: CameraPanel },
  petting: { kicker: 'Top of head', title: 'Petting', Body: PettingPanel },
  voice: { kicker: 'Beak', title: 'Voice', Body: VoicePanel },
  microphone: { kicker: 'Chest', title: 'Microphone', Body: MicrophonePanel },
  focus: { kicker: 'Back', title: 'Focus & coach', Body: FocusPanel },
  calendar: { kicker: 'Deadlines', title: 'Calendar', Body: CalendarPanel },
  nest: { kicker: 'Memories', title: 'Nest', Body: NestPanel },
  activity: { kicker: 'Live', title: 'Activity', Body: ActivityPanel },
};
