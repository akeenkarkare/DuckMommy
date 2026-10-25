'use client';

import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { ForgetIcon, NestIcon, RefreshIcon, SOURCE_ICON, TypedIcon } from './NestIcons';

const MAX_LEN = 500;   // matches the check on public.memories.text
const SOURCE_LABEL = { voice: 'Said', sign: 'Signed', typed: 'Typed' };

function SourceIcon({ source }) {
  const Icon = SOURCE_ICON[source] ?? TypedIcon;
  return <span className="nest-src"><Icon label={SOURCE_LABEL[source] ?? 'Saved'} /></span>;
}

function stamp(ts, now) {
  const d = new Date(ts);
  const days = Math.floor((new Date(now).setHours(0, 0, 0, 0) - new Date(ts).setHours(0, 0, 0, 0)) / 86400000);
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (days === 0) return `Today ${time}`;
  if (days === 1) return `Yesterday ${time}`;
  if (days < 7) return `${d.toLocaleDateString([], { weekday: 'short' })} ${time}`;
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

// Nest: everything you told the duck to remember. Read straight from Supabase (RLS: your rows only);
// a live `memory` event from the relay means a new note was saved, so it reloads.
export default function NestPanel({ allEvents, now }) {
  const [notes, setNotes] = useState(null);
  const [error, setError] = useState(null);
  const [query, setQuery] = useState('');
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const { data, error } = await supabase.from('memories').select('id, text, source, created_at')
      .order('created_at', { ascending: false }).limit(500);
    if (error) {
      setError(error.code === '42P01' || error.code === 'PGRST205'
        ? 'Run backend/supabase/migrations/004_memories.sql to set up the Nest.'
        : `Couldn’t load your notes: ${error.message}`);
      return setNotes([]);
    }
    setError(null);
    setNotes(data);
  }, []);

  useEffect(() => { load(); }, [load]);

  const lastSaved = allEvents.findLast((e) => e.type === 'memory' && e.value?.action === 'saved')?.ts;
  useEffect(() => { if (lastSaved) load(); }, [lastSaved, load]);
  const lastRecall = allEvents.findLast((e) => e.type === 'memory' && e.value?.action === 'recall');

  async function add(e) {
    e.preventDefault();
    const text = draft.trim().slice(0, MAX_LEN);
    if (!text) return;
    setBusy(true);
    const { data: { session } } = await supabase.auth.getSession();
    const { error } = await supabase.from('memories').insert({ user_id: session?.user.id, text, source: 'typed' });
    setBusy(false);
    if (error) return setError(`Couldn’t save that: ${error.message}`);
    setDraft('');
    load();
  }

  async function forget(id) {
    setNotes((list) => list.filter((n) => n.id !== id));
    const { error } = await supabase.from('memories').delete().eq('id', id);
    if (error) { setError(`Couldn’t delete that: ${error.message}`); load(); }
  }

  const q = query.trim().toLowerCase();
  const shown = (notes ?? []).filter((n) => !q || n.text.toLowerCase().includes(q));

  return (
    <>
      <p className="hint" style={{ margin: 0 }}>
        Say <b>“hey duck, remember…”</b> and it lands here. Ask <b>“hey duck, what did I tell you…?”</b> and the duck answers from these notes.
      </p>

      {lastRecall && (
        <div className="card">
          <h2>Last thing you asked <span className="sub">{stamp(lastRecall.ts, now)}</span></h2>
          <p className="hint" style={{ margin: '0 0 6px' }}>“{lastRecall.value.question}”</p>
          <p style={{ margin: 0 }}>{lastRecall.value.answer}</p>
        </div>
      )}

      <form className="section" onSubmit={add}>
        <h3>Add a note</h3>
        <div className="row" style={{ flexWrap: 'nowrap' }}>
          <input className="input" type="text" maxLength={MAX_LEN} placeholder="My locker code is 427"
            aria-label="New note" value={draft} onChange={(e) => setDraft(e.target.value)} />
          <button className="btn primary" disabled={busy || !draft.trim()}>Save</button>
        </div>
      </form>

      <div className="section">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h3>Your notes{notes ? ` · ${notes.length}` : ''}</h3>
          <button className="chip nest-chip" onClick={load}><RefreshIcon />Refresh</button>
        </div>
        {notes?.length > 5 && (
          <input className="input" type="search" placeholder="Search your notes" aria-label="Search your notes"
            value={query} onChange={(e) => setQuery(e.target.value)} />
        )}
        {error && <p className="error">{error}</p>}
        {notes === null ? <p className="empty">Loading…</p> : shown.length === 0 ? (
          <p className="empty nest-empty">{!q && <NestIcon size={28} />}{q ? 'No notes match that.' : 'Nothing in the nest yet. Try “hey duck, remember my keys are in the blue drawer.”'}</p>
        ) : (
          <ul className="list nest-list">
            {shown.map((n) => (
              <li key={n.id}>
                <span className="nest-note"><SourceIcon source={n.source} /><span>{n.text}</span></span>
                <span className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
                  <span className="time">{stamp(n.created_at, now)}</span>
                  <button className="btn icon nest-forget" aria-label={`Forget “${n.text}”`} title="Forget this" onClick={() => forget(n.id)}><ForgetIcon /></button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <p className="hint" style={{ margin: 0 }}>
        Private to you. What you say after “hey duck” is sent to ElevenLabs (speech to text) and Anthropic’s Claude (to tidy it up and answer questions). Audio is never stored, only the cleaned-up note.
      </p>
      <p className="hint" style={{ margin: 0 }}>
        Notes belong to whoever has the dashboard open, and the duck reads them out loud when asked. The duck only listens for “hey duck” while it sees you at your desk.
      </p>
    </>
  );
}
