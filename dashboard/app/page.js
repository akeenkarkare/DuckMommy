'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabase';
import { useRelay } from '@/lib/useRelay';
import { useSettings } from '@/lib/useSettings';
import { useDuck } from '@/components/duck/DuckContext';
import { HOTSPOTS, ACTIVITY, CALENDAR } from '@/components/duck/hotspots';
import { PANELS, focusSession } from '@/components/Panels';

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
  const { focus, setFocus, setBadges, bridge } = duck;
  const [user, setUser] = useState(null);
  const [name, setName] = useState('');
  const [touched, setTouched] = useState(false);
  const now = useNow(5000);

  const s = useSettings(user?.id, () => send({ type: 'settings_changed' }));

  // Live events animate the 3D duck (with the user's own messages in its speech bubble).
  const onEvent = useCallback((e) => {
    if (e.type === 'coach' && e.value?.text) return bridge.current.react({ type: 'say', value: { text: e.value.text } });
    const st = s.settings ?? {};
    const message = e.type === 'posture' ? st.posture_message : e.type === 'sentry' ? st.sentry_message : e.type === 'presence' ? st.presence_message : undefined;
    bridge.current.react({ ...e, message });
  }, [bridge, s.settings]);

  const { connected, status, events, lastAck, send, agenda, bufferMs } = useRelay(!!user, onEvent);
  const canCommand = connected && status.duck_connected && status.with_you;

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      if (!data.session) return router.replace('/login');
      setUser(data.session.user);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_OUT' || !session) router.replace('/login');
    });
    return () => sub.subscription.unsubscribe();
  }, [router]);

  useEffect(() => {
    if (!user) return;
    supabase.from('profiles').select('display_name').eq('user_id', user.id).single()
      .then(({ data }) => setName(data?.display_name || user.email));
  }, [user]);

  // Clicking the duck's head quacks the real duck.
  useEffect(() => {
    bridge.current.onPet = () => canCommand && send({ type: 'command', command: { type: 'quack' } });
  }, [bridge, canCommand, send]);

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
      focus: session ? `Focus · ${session.left}m left` : nextDue ? `Next: ${nextDue.title.slice(0, 22)}` : `${count('focus')} focus taps`,
    });
  }, [events, now, s.settings, setBadges, agenda]);

  useEffect(() => {
    if (focus) setTouched(true);
  }, [focus]);

  if (!user) return null;

  const panel = focus && PANELS[focus];
  const Body = panel?.Body;
  const dockItems = [...HOTSPOTS, CALENDAR, ACTIVITY];

  return (
    <>
      <header className="topbar">
        <div className="brand">
          <span style={{ fontSize: 26 }} aria-hidden>🦆</span>
          <div>
            <h1>Duck Daddy</h1>
            <div className="who">Hi, {name}</div>
          </div>
        </div>
        <div className="row">
          <DuckStatus connected={connected} status={status} />
          <button className="btn glass" onClick={() => supabase.auth.signOut()}>Log out</button>
        </div>
      </header>

      <p className="hint-float" style={{ opacity: touched || focus ? 0 : 1 }}>
        Drag to spin · tilt up for a top view · click a label to dive in · tap its head to quack
      </p>

      <nav className={`dock glass ${panel ? 'shifted' : ''}`} aria-label="Duck parts">
        {dockItems.map((h) => (
          <button key={h.id} aria-pressed={focus === h.id} onClick={() => setFocus(focus === h.id ? null : h.id)}>
            <span className="t">{h.title}</span>
          </button>
        ))}
      </nav>

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
                duck={bridge.current} lastAck={lastAck} agenda={agenda} connected={connected} allEvents={events} />
              {s.state && <p className="hint">{s.state}</p>}
            </div>
          </>
        )}
      </aside>
    </>
  );
}
