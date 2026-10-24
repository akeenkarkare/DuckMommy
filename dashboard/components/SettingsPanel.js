'use client';

import { useEffect, useRef, useState } from 'react';
import { supabase } from '@/lib/supabase';

// Saves to Supabase on change (RLS: own row only), then pings the relay to push to the duck.
export default function SettingsPanel({ userId, onSaved }) {
  const [settings, setSettings] = useState(null);
  const [state, setState] = useState('');
  const timer = useRef(null);
  const pending = useRef({});

  useEffect(() => {
    supabase.from('settings').select('*').eq('user_id', userId).single()
      .then(({ data, error }) => (error ? setState(error.message) : setSettings(data)));
    return () => clearTimeout(timer.current);
  }, [userId]);

  function change(key, value, debounceMs = 500) {
    setSettings((s) => ({ ...s, [key]: value }));
    pending.current[key] = value;
    setState('Saving…');
    clearTimeout(timer.current);
    timer.current = setTimeout(save, debounceMs);
  }

  async function save() {
    const patch = pending.current;
    pending.current = {};
    const { error } = await supabase.from('settings').update(patch).eq('user_id', userId);
    if (error) return setState(`Not saved: ${error.message}`);
    setState('Saved');
    onSaved();
  }

  if (!settings) return <div className="card"><h2>Settings</h2><p className="empty">{state || 'Loading…'}</p></div>;

  const text = (key, label, { optional } = {}) => (
    <div className="field">
      <label htmlFor={key}>{label}{optional && <span className="hint">empty = stay quiet</span>}</label>
      <input id={key} type="text" maxLength={200} value={settings[key] ?? ''}
        onChange={(e) => change(key, optional && !e.target.value ? null : e.target.value, 800)} />
    </div>
  );

  return (
    <div className="card">
      <h2>Settings <span className="sub">{state}</span></h2>

      <div className="field">
        <label htmlFor="volume">Volume <span>{settings.volume}</span></label>
        <input id="volume" type="range" min={0} max={100} value={settings.volume}
          onChange={(e) => change('volume', Number(e.target.value))} />
      </div>

      {text('posture_message', 'Slouch message')}
      {text('sentry_message', 'Sentry message')}
      {text('presence_message', 'Welcome message', { optional: true })}

      <div className="field">
        <label htmlFor="severity">Posture severity <span>{settings.posture_severity}</span></label>
        <input id="severity" type="range" min={0} max={100} value={settings.posture_severity}
          onChange={(e) => change('posture_severity', Number(e.target.value))} />
        <span className="hint">0 = only very bad slouches count · 100 = any lean counts</span>
      </div>

      <div className="field">
        <label htmlFor="delay">Speak after slouching for (seconds)</label>
        <input id="delay" type="number" min={1} max={120} value={settings.posture_delay_s}
          onChange={(e) => {
            const v = Math.max(1, Math.min(120, Math.round(Number(e.target.value) || 1)));
            change('posture_delay_s', v);
          }} />
      </div>

      <label className="check">
        <input type="checkbox" checked={settings.quack_enabled} onChange={(e) => change('quack_enabled', e.target.checked, 0)} />
        Quack when its head is pressed
      </label>
      <label className="check">
        <input type="checkbox" checked={settings.sentry_enabled} onChange={(e) => change('sentry_enabled', e.target.checked, 0)} />
        Sentry mode while you're away
      </label>
      {'sign_enabled' in settings && (
        <label className="check">
          <input type="checkbox" checked={settings.sign_enabled} onChange={(e) => change('sign_enabled', e.target.checked, 0)} />
          Sign to Duck (reads ASL signs aloud)
        </label>
      )}
      {'sound_alerts_enabled' in settings ? (
        <label className="check">
          <input type="checkbox" checked={settings.sound_alerts_enabled} onChange={(e) => change('sound_alerts_enabled', e.target.checked, 0)} />
          Flash the LED for doorbells, phones and alarms
        </label>
      ) : (
        <p className="hint">Run backend/supabase/migrations/002_sign_and_sound.sql to get the Sign to Duck and sound alert toggles.</p>
      )}
    </div>
  );
}
