'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabase';
import { useRelay } from '@/lib/useRelay';
import SlouchChart from '@/components/SlouchChart';
import SettingsPanel from '@/components/SettingsPanel';
import EventLog from '@/components/EventLog';
import SignCard from '@/components/SignCard';

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
  else if (connected && !status.with_you) { tone = 'warning'; text = 'Duck is with someone else. Reload to take it back.'; }
  else if (connected) { tone = 'good'; text = 'Duck is with you'; }
  return <span className="pill" role="status"><span className={`dot ${tone}`} aria-hidden />{text}</span>;
}

export default function Dashboard() {
  const router = useRouter();
  const [user, setUser] = useState(null);
  const [name, setName] = useState('');
  const { connected, status, events, lastAck, send, bufferMs } = useRelay(!!user);
  const now = useNow(5000);
  const [sayText, setSayText] = useState('');

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

  if (!user) return null;

  const recent = events.filter((e) => e.ts >= now - bufferMs);
  const slouches = recent.filter((e) => e.type === 'posture' && e.value?.state === 'slouch').length;
  const pats = recent.filter((e) => e.type === 'pat').length;
  const lastPosture = [...events].reverse().find((e) => e.type === 'posture');
  const lastPresence = [...events].reverse().find((e) => e.type === 'presence');
  const canCommand = connected && status.duck_connected && status.with_you;

  return (
    <main className="page">
      <header className="header">
        <div>
          <h1>🦆 Duck Daddy</h1>
          <div className="who">Hi, {name}</div>
        </div>
        <div className="row">
          <DuckStatus connected={connected} status={status} />
          <button className="btn" onClick={() => supabase.auth.signOut()}>Log out</button>
        </div>
      </header>

      <section className="tiles" style={{ marginBottom: 16 }}>
        <div className="tile"><div className="label">Slouch prompts · 5 min</div><div className="value">{slouches}</div></div>
        <div className="tile"><div className="label">Head pats · 5 min</div><div className="value">{pats}</div></div>
        <div className="tile">
          <div className="label">Posture now</div>
          <div className="value">{!lastPosture ? '—' : lastPosture.value?.state === 'slouch' ? 'Slouching' : 'Upright'}</div>
        </div>
        <div className="tile">
          <div className="label">At desk</div>
          <div className="value">{!lastPresence ? '—' : lastPresence.value?.present ? 'Yes' : 'Away'}</div>
        </div>
      </section>

      <div className="grid">
        <div className="stack">
          <div className="card">
            <h2>Slouch prompts <span className="sub">per 30 seconds · last 5 minutes</span></h2>
            <SlouchChart events={events} now={now} windowMs={bufferMs} />
          </div>
          <EventLog events={recent} />
        </div>

        <div className="stack">
          <SignCard events={recent} />
          <div className="card">
            <h2>Talk to the duck</h2>
            <form className="row" onSubmit={(e) => {
              e.preventDefault();
              if (!sayText.trim()) return;
              send({ type: 'command', command: { type: 'say', text: sayText } });
              setSayText('');
            }}>
              <input type="text" maxLength={200} placeholder="Say something…" value={sayText}
                onChange={(e) => setSayText(e.target.value)}
                style={{ flex: 1, minWidth: 0, padding: '7px 10px', border: '1px solid var(--border)', borderRadius: 8, background: 'var(--bg)' }} />
              <button className="btn primary" type="submit" disabled={!canCommand}>Say</button>
              <button className="btn" type="button" disabled={!canCommand}
                onClick={() => send({ type: 'command', command: { type: 'quack' } })}>Quack</button>
            </form>
            {lastAck && !lastAck.ok && now - lastAck.at < 10000 && <p className="error">The duck didn't get that.</p>}
          </div>
          <SettingsPanel userId={user.id} onSaved={() => send({ type: 'settings_changed' })} />
        </div>
      </div>
    </main>
  );
}
