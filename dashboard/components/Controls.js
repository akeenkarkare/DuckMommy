'use client';

// Small settings controls bound to useSettings' { settings, change }.

export function RangeField({ s, k, label, min = 0, max = 100, hint, format = (v) => v }) {
  if (!s.settings || !(k in s.settings)) return null;
  const v = s.settings[k];
  return (
    <div className="field">
      <label htmlFor={k}>{label} <span className="value">{format(v)}</span></label>
      <input id={k} type="range" min={min} max={max} value={v} onChange={(e) => s.change(k, Number(e.target.value))} />
      {hint && <span className="hint">{hint}</span>}
    </div>
  );
}

export function TextField({ s, k, label, optional }) {
  if (!s.settings || !(k in s.settings)) return null;
  return (
    <div className="field">
      <label htmlFor={k}>{label}{optional && <span className="hint">empty = stay quiet</span>}</label>
      <input id={k} type="text" maxLength={200} value={s.settings[k] ?? ''}
        onChange={(e) => s.change(k, optional && !e.target.value ? null : e.target.value, 800)} />
    </div>
  );
}

export function Toggle({ s, k, label, hint }) {
  if (!s.settings) return null;
  if (!(k in s.settings)) {
    return <p className="hint">Run backend/supabase/migrations/002_sign_and_sound.sql to enable “{label}”.</p>;
  }
  return (
    <label className="switch">
      <span>{label}{hint && <><br /><span className="hint">{hint}</span></>}</span>
      <input type="checkbox" checked={!!s.settings[k]} onChange={(e) => s.change(k, e.target.checked, 0)} />
    </label>
  );
}
