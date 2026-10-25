'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabase';
import { useRelay } from '@/lib/useRelay';
import { useSettings } from '@/lib/useSettings';
import { useDuck } from '@/components/duck/DuckContext';
import { HOTSPOTS, ACTIVITY, CALENDAR, NEST } from '@/components/duck/hotspots';
import { PANELS, focusSession } from '@/components/Panels';
import ScenePicker from '@/components/ScenePicker';
import IntruderAlert, { raiseIntruderAlarm } from '@/components/IntruderAlert';
import Tour, { TOUR_KEY } from '@/components/Tour';
import BrandMark from '@/components/BrandMark';

const CAPTION_MS = 6000;
const TONE_BADGE = { gentle: '💛 Gentle', coach: '🧢 Coach', savage: '🕶️ Savage' };   // how long a signed sentence stays captioned above the dock

function useNow(ms) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

function DuckStatus({ connected, status }) {
  let tone = 'critical', text = 'Relay offline';
  if (connected && !status.duck_connected) { tone = 'warning'; text = 'Duck offline'; }
  else if (connected && !status.with_you) { tone = 'warning'; text = 'Duck is with someone else · reload to take it back'; }
  else if (connected) { tone = 'good'; text = 'Duck is with you'; }
  return <span className="pill glass" role="status" title={text}><span className={`dot ${tone}`} aria-hidden /><span className="pill-text">{text}</span></span>;
}

export default function Dashboard() {
  const router = useRouter();
  const duck = useDuck();
  const { focus, setFocus, setBadges, bridge, setTone } = duck;
  const [user, setUser] = useState(null);
  const [name, setName] = useState('');
  const [touched, setTouched] = useState(false);
  const now = useNow(5000);
  const [intruder, setIntruder] = useState(null);   // { event, compact }: sentry spotted someone
  const [liveRequest, setLiveRequest] = useState(0); // bump to open the Camera panel's live view
  const [tour, setTour] = useState(false);
  const [caption, setCaption] = useState(null);      // { text, ts }: last ASL sentence, shown above the dock

  const s = useSettings(user?.id, () => send({ type: 'settings_changed' }));

  // Live events animate the 3D duck (with the user's own messages in its speech bubble).
  const onEvent = useCallback((e) => {
    if (e.type === 'sign' && e.value?.text) setCaption({ text: e.value.text, ts: Date.now() });
    if (e.type === 'sentry' && e.value?.person_confirmed) {
      setIntruder({ event: e, compact: false });
      raiseIntruderAlarm();
    }
    if (e.type === 'coach' && e.value?.kind === 'focus_start') bridge.current.react({ type: 'whistle' });
    if (e.type === 'coach' && e.value?.text) return bridge.current.react({ type: 'say', value: { text: e.value.text } });
    if (e.type === 'memory') {
      const v = e.value ?? {};
      const text = v.action === 'recall' || v.action === 'agenda' || v.action === 'lookup' ? v.answer
        : v.action === 'reminder_set' ? `⏰ ${v.text}` : v.action === 'reminder_due' ? `⏰ Time to ${v.text}` : 'Saved to your nest';
      return bridge.current.react({ type: 'say', value: { text } });
    }
    const st = s.settings ?? {};
    const message = e.type === 'posture' ? st.posture_message : e.type === 'sentry' ? st.sentry_message : e.type === 'presence' ? st.presence_message : undefined;
    bridge.current.react({ ...e, message });
  }, [bridge, s.settings]);

  const { connected, status, events, lastAck, send, agenda, googleError, video, watch, bufferMs } = useRelay(!!user, onEvent, s.apply);
  const [calendarNotice, setCalendarNotice] = useState(null);
  const googleNotice = googleError ? { ok: false, text: googleError } : calendarNotice;
  const canCommand = connected && status.duck_connected && status.with_you;

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      if (!data.session) return router.replace('/welcome');
      setUser(data.session.user);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_OUT' || !session) router.replace('/welcome');
    });
    return () => sub.subscription.unsubscribe();
  }, [router]);

  useEffect(() => {
    if (!user) return;
    setName(user.user_metadata?.display_name || '');   // right away; the profile row may say otherwise
    supabase.from('profiles').select('display_name').eq('user_id', user.id).single()
      .then(({ data }) => setName(data?.display_name || user.email));
  }, [user]);

  // Clicking the duck's head quacks the real duck.
  useEffect(() => {
    bridge.current.onPet = () => canCommand && send({ type: 'command', command: { type: 'quack' } });
  }, [bridge, canCommand, send]);

  // The duck dresses for its personality (cap + whistle, aviators, or nothing).
  const tone = s.settings?.coach_tone;
  useEffect(() => { if (tone) setTone(tone); }, [tone, setTone]);

  const recent = events.filter((e) => e.ts >= now - bufferMs);

  // Live text under each label on the duck.
  useEffect(() => {
    const last = (type) => [...recent].reverse().find((e) => e.type === type);
    const count = (type) => recent.filter((e) => e.type === type).length;
    const posture = last('posture');
    const sound = last('sound');
    const nextDue = agenda.items.find((i) => i.kind === 'due' && i.start > now);
    const session = focusSession(events, now);
    setBadges({
      camera: posture ? (posture.value?.state === 'slouch' ? 'Slouching 👀' : 'Upright ✓') : 'Posture · Sentry · Signs',
      petting: `${count('pat')} pats · 5 min`,
      voice: s.settings ? `Volume ${s.settings.volume}` : 'What it says',
      microphone: sound ? `Heard: ${sound.value?.label ?? sound.value?.kind}` : 'Listening',
      focus: session ? `Focus · ${session.left}m left` : nextDue ? `Next: ${nextDue.title.slice(0, 22)}` : TONE_BADGE[s.settings?.coach_tone] ?? 'Lock in',
    });
  }, [events, now, s.settings, setBadges, agenda]);

  useEffect(() => {
    if (focus) setTouched(true);
  }, [focus]);

  // First visit: the tour opens once the duck has shrunk into place.
  useEffect(() => {
    if (!user) return;
    let seen = true;
    try { seen = !!localStorage.getItem(TOUR_KEY); } catch {}
    if (seen) return;
    const id = setTimeout(() => { setFocus(null); setTour(true); }, 1800);
    return () => clearTimeout(id);
  }, [user, setFocus]);

  useEffect(() => {
    if (!caption) return;
    const id = setTimeout(() => setCaption(null), CAPTION_MS);
    return () => clearTimeout(id);
  }, [caption]);

  // Back from Google sign-in (relay /auth/google/callback): open the Calendar tab and say how it went.
  useEffect(() => {
    if (!user) return;
    const q = new URLSearchParams(window.location.search);
    const result = q.get('calendar');
    if (!result) return;
    setCalendarNotice(result === 'connected'
      ? { ok: true, text: 'Google Calendar connected. The duck will remind you 5 minutes before each event.' }
      : { ok: false, text: `Couldn’t connect Google Calendar: ${q.get('reason') || 'unknown error'}` });
    setFocus('calendar');
    window.history.replaceState(null, '', window.location.pathname);
  }, [user, setFocus]);

  if (!user) return null;

  const panel = focus && PANELS[focus];
  const Body = panel?.Body;
  const dockItems = [...HOTSPOTS, CALENDAR, NEST, ACTIVITY];

  return (
    <>
      <header className="topbar">
        <div className="brand">
          <BrandMark size={30} />
          <div>
            <h1>Duck Mommy</h1>
            <div className="who">{name ? `Hi, ${name}` : 'Hi!'}</div>
          </div>
        </div>
        <div className="row">
          <ScenePicker />
          <DuckStatus connected={connected} status={status} />
          <button className="btn icon glass" aria-label="Show me around" title="Show me around"
            onClick={() => { setFocus(null); setTour(true); }}>?</button>
          <button className="btn glass" onClick={() => supabase.auth.signOut()}>Log out</button>
        </div>
      </header>

      <p className="hint-float" style={{ opacity: touched || focus || tour ? 0 : 1 }}>
        Drag to spin · tilt up for a top view · click a label to dive in · tap its head to quack
      </p>

      {caption && (
        <p className={`caption ${panel ? 'shifted' : ''}`} key={caption.ts} role="status" aria-live="polite">
          <span className="caption-kicker">Signed</span> {caption.text}
        </p>
      )}

      <nav className={`dock glass ${panel ? 'shifted' : ''}`} aria-label="Duck parts">
        {dockItems.map((h) => (
          <button key={h.id} aria-pressed={focus === h.id} onClick={() => setFocus(focus === h.id ? null : h.id)}>
            <span className="t">{h.title}</span>
          </button>
        ))}
      </nav>

      <IntruderAlert alert={intruder}
        onWatch={() => { setFocus('camera'); setLiveRequest((n) => n + 1); setIntruder((a) => a && { ...a, compact: true }); }}
        onMine={() => { s.change('sentry_enabled', false, 0); setIntruder(null); }}
        onDismiss={() => setIntruder(null)} />

      <Tour open={tour} onClose={() => setTour(false)} bridge={bridge} />

      <aside className={`panel glass ${panel ? 'open' : ''}`} aria-hidden={!panel}>
        {panel && (
          <>
            <div className="panel-head">
              <div>
                <div className="kicker">{panel.kicker}</div>
                <h2>{panel.title}</h2>
              </div>
              <button className="btn icon" aria-label="Close" onClick={() => setFocus(null)}>✕</button>
            </div>
            <div className="panel-body" key={focus}>
              <Body events={recent} now={now} windowMs={bufferMs} s={s} send={send} canCommand={canCommand}
                duck={bridge.current} lastAck={lastAck} agenda={agenda} googleNotice={googleNotice} connected={connected} allEvents={events} watch={watch} video={video} liveRequest={liveRequest} />
              {s.state && <p className="hint">{s.state}</p>}
            </div>
          </>
        )}
      </aside>
    </>
  );
}
