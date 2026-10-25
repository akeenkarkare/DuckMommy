'use client';

import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
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

const clockTime = (ts) => new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

/** Day header for the notes list: Today, Yesterday, a weekday this week, else the date. */
function dayLabel(ts, now) {
  const d = new Date(ts);
  const days = Math.floor((new Date(now).setHours(0, 0, 0, 0) - new Date(ts).setHours(0, 0, 0, 0)) / 86400000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return d.toLocaleDateString([], { weekday: 'long' });
  return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', year: d.getFullYear() === new Date(now).getFullYear() ? undefined : 'numeric' });
}

const RECALL_FLASH_MS = 2 * 60 * 1000;   // notes behind the last answer stay highlighted this long

// Nest: everything you told the duck to remember. Read straight from Supabase (RLS: your rows only);
// a live `memory` event from the relay means a new note was saved, so it reloads.
function dueStamp(ts, now) {
  const d = new Date(ts);
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const days = Math.round((new Date(ts).setHours(0, 0, 0, 0) - new Date(now).setHours(0, 0, 0, 0)) / 86400000);
  if (ts - now < 60 * 60 * 1000 && ts > now) return `in ${Math.max(1, Math.round((ts - now) / 60000))} min`;
  if (days <= 0) return `Today ${time}`;
  if (days === 1) return `Tomorrow ${time}`;
  if (days < 7) return `${d.toLocaleDateString([], { weekday: 'short' })} ${time}`;
  return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${time}`;
}

// Voice reminders ("hey duck, remind me in 5 days to ..."): still to be said. The relay says them when due.
function Reminders({ allEvents, now }) {
  const [list, setList] = useState(null);
  const [error, setError] = useState(null);
  const load = useCallback(async () => {
    const { data, error } = await supabase.from('reminders').select('id, text, due_at')
      .is('delivered_at', null).order('due_at', { ascending: true }).limit(50);
    if (error) {
      setError(error.code === '42P01' || error.code === 'PGRST205'
        ? 'Run backend/supabase/migrations/005_reminders.sql to turn on voice reminders.'
        : `Couldn’t load reminders: ${error.message}`);
      return setList([]);
    }
    setError(null);
    setList(data);
  }, []);
  useEffect(() => { load(); }, [load]);
  const lastChange = allEvents.findLast((e) => e.type === 'memory' && ['reminder_set', 'reminder_due'].includes(e.value?.action))?.ts;
  useEffect(() => { if (lastChange) load(); }, [lastChange, load]);

  async function cancel(id) {
    setList((l) => l.filter((r) => r.id !== id));
    const { error } = await supabase.from('reminders').delete().eq('id', id);
    if (error) { setError(`Couldn’t cancel that: ${error.message}`); load(); }
  }

  return (
    <div className="section">
      <h3>Upcoming reminders{list?.length ? ` · ${list.length}` : ''}</h3>
      {error && <p className="error">{error}</p>}
      {list === null ? <p className="empty">Loading…</p> : list.length === 0 ? (
        !error && <p className="empty">None set. Try “hey duck, remind me in 5 days to email my TA.”</p>
      ) : (
        <ul className="list nest-list">
          {list.map((r) => (
            <li key={r.id}>
              <span className="nest-note"><span aria-hidden>⏰</span><span>{r.text}</span></span>
              <span className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
                <span className="time">{dueStamp(Date.parse(r.due_at), now)}</span>
                <button className="btn icon nest-forget" aria-label={`Cancel reminder “${r.text}”`} title="Cancel" onClick={() => cancel(r.id)}><ForgetIcon /></button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

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
  // The notes the duck's last answer came from (relay sends their ids): flash them and scroll to the first.
  const sources = new Set(lastRecall && now - lastRecall.ts < RECALL_FLASH_MS ? lastRecall.value.sources ?? [] : []);
  const listRef = useRef(null);
  useEffect(() => {
    if (!lastRecall?.value?.sources?.length) return;
    const id = setTimeout(() => listRef.current?.querySelector('li.flash')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }), 300);
    return () => clearTimeout(id);
  }, [lastRecall?.ts, notes]);   // eslint-disable-line react-hooks/exhaustive-deps

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
        Also: <b>“remind me in 5 days to…”</b>, <b>“what’s on my calendar tomorrow?”</b>, <b>“let’s lock in”</b>.
      </p>

      {lastRecall && (
        <div className="card">
          <h2>Last thing you asked <span className="sub">{stamp(lastRecall.ts, now)}</span></h2>
          <p className="hint" style={{ margin: '0 0 6px' }}>“{lastRecall.value.question}”</p>
          <p style={{ margin: 0 }}>{lastRecall.value.answer}</p>
          {sources.size > 0 && <p className="hint" style={{ margin: '6px 0 0' }}>From {sources.size === 1 ? 'the highlighted note' : `the ${sources.size} highlighted notes`} below.</p>}
        </div>
      )}

      <Reminders allEvents={allEvents} now={now} />

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
          <ul className="list nest-list" ref={listRef}>
            {shown.map((n, i) => (
              <Fragment key={n.id}>
              {(i === 0 || dayLabel(shown[i - 1].created_at, now) !== dayLabel(n.created_at, now)) && (
                <li className="nest-day" aria-hidden>{dayLabel(n.created_at, now)}</li>
              )}
              <li className={sources.has(n.id) ? 'flash' : undefined}>
                <span className="nest-note"><SourceIcon source={n.source} /><span>{n.text}</span></span>
                <span className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
                  <span className="time">{clockTime(n.created_at)}</span>
                  <button className="btn icon nest-forget" aria-label={`Forget “${n.text}”`} title="Forget this" onClick={() => forget(n.id)}><ForgetIcon /></button>
                </span>
              </li>
              </Fragment>
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
