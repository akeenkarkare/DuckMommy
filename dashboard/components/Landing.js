'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { supabase } from '@/lib/supabase';
import { useDuck } from '@/components/duck/DuckContext';
import ScenePicker from '@/components/ScenePicker';
import BrandMark from '@/components/BrandMark';
import { HandIcon, TargetIcon } from '@/components/Icons';

// /welcome: a scroll-driven tour of the duck for logged-out visitors, on the persistent stage.
// One scroll container (main.landing) over the fixed 3D duck. The section crossing the middle of
// the screen is `active`; its `stage` sets the duck (mode + focus). See dashboard/CLAUDE.md.
//
// The container is an ordinary scroller (wheel, trackpad, touch, scrollbar, keys). While it's
// mounted, the duck's hotspot labels sit above it (body.landing-on), so they stay clickable.

const TONES = {
  gentle: 'Hey bestie, maybe roll those shoulders back? No pressure.',
  coach: 'Shoulders back, chin up. Two more pomodoros. Let’s go.',
  savage: 'You’re folding like a lawn chair. Sit up.',
};

// Real phrases from pi/asl/phrases.json (signs in, sentence out).
const ASL = [
  { signs: ['HELLO'], text: 'Hello!' },
  { signs: ['START', 'FOCUS'], text: 'Let’s start a focus session.' },
  { signs: ['ME', 'NEED', 'MORE', 'TIME'], text: 'I need more time.' },
  { signs: ['WATER', 'PLEASE'], text: 'Water, please.' },
  { signs: ['NOT', 'UNDERSTAND'], text: 'I don’t understand.' },
  { signs: ['ME', 'REST'], text: 'I need a break.' },
  { signs: ['THANK-YOU'], text: 'Thank you!' },
];

// The LED patterns from pi/sounds/led.py, one per sound the mic listens for.
const LEDS = [
  { kind: 'doorbell', label: 'Doorbell', pattern: 'fast blink' },
  { kind: 'phone', label: 'Phone ringing', pattern: 'slow pulse' },
  { kind: 'alarm', label: 'Alarm', pattern: 'strobe' },
  { kind: 'notification', label: 'Notification', pattern: 'three blinks' },
  { kind: 'calling', label: 'Someone calling', pattern: 'long glows' },
];

// stage: what the duck does while this section is active. react: its reaction on first arrival.
// tone: the personality it wears there (accessories.js), so the look changes as you scroll;
// the Voice section wears whatever the switch is on.
const SECTIONS = [
  { id: 'hero', tone: 'savage', stage: null, focus: null, delay: 1500, react: () => [{ type: 'wink' }, { type: 'say', value: { text: 'Hiii.' } }] },
  { id: 'overview', tone: 'coach', stage: 'dashboard', focus: null },   // the hero -> dashboard change spins it on its own
  { id: 'camera', tone: 'gentle', part: 'Camera', stage: 'dashboard', focus: 'camera', react: () => [{ type: 'posture', value: { state: 'slouch' }, message: 'Sit up straight.' }] },
  { id: 'petting', tone: 'coach', part: 'Petting', stage: 'dashboard', focus: 'petting', react: () => [{ type: 'quack' }] },
  { id: 'voice', part: 'Voice', stage: 'dashboard', focus: 'voice', react: (tone) => [{ type: 'say', value: { text: TONES[tone] } }] },
  { id: 'microphone', tone: 'gentle', part: 'Microphone', stage: 'dashboard', focus: 'microphone', react: () => [{ type: 'sound', label: 'Doorbell', value: { kind: 'doorbell' } }] },
  { id: 'focus', tone: 'coach', part: 'Focus', stage: 'dashboard', focus: 'focus', react: () => [{ type: 'focus' }, { type: 'whistle' }] },
  { id: 'signs', tone: 'savage', part: 'Signs', stage: 'dashboard', focus: 'camera', react: () => [{ type: 'sign', value: { text: 'Hello!' } }] },
  { id: 'nest', tone: 'gentle', part: 'Nest', stage: 'dashboard', focus: 'aside', react: () => [{ type: 'say', value: { text: 'Noted.' } }] },
  { id: 'end', tone: 'savage', stage: null, focus: null, react: () => [{ type: 'say', value: { text: 'Adopt me.' } }] },
];
const REACT_AFTER_MS = 700;   // after the camera has flown to the part
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

function AslDemo() {
  const [i, setI] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setI((n) => (n + 1) % ASL.length), 2800);
    return () => clearInterval(id);
  }, []);
  const p = ASL[i];
  return (
    <div className="asl-demo demo" key={i}>
      <div className="glosses">{p.signs.map((g, j) => <span className="gloss" key={g + j} style={{ animationDelay: `${j * 0.18}s` }}>{g}</span>)}</div>
      <div className="asl-arrow" aria-hidden>↓ the duck says</div>
      <div className="asl-out" style={{ animationDelay: `${p.signs.length * 0.18 + 0.2}s` }}>“{p.text}”</div>
    </div>
  );
}

function NestChat({ duck }) {
  const [notes, setNotes] = useState(['my locker code is 427']);
  const [msgs, setMsgs] = useState([
    { me: true, text: 'hey duck, remember my locker code is 427' },
    { me: false, text: 'Noted. It’s in your nest.' },
  ]);
  const [draft, setDraft] = useState('');
  const logRef = useRef(null);
  // scroll the chat itself, never the page (scrollIntoView would drag the landing down to here)
  useEffect(() => { const el = logRef.current; if (el) el.scrollTop = el.scrollHeight; }, [msgs]);

  const reply = (q) => {
    const said = q.replace(/^(hey|ok(ay)?|hi)\s+duck,?\s*/i, '');
    const remember = said.match(/^remember\s+(?:that\s+)?(.+)/i);
    if (remember) { setNotes((n) => [...n, remember[1]]); return 'Noted. It’s in your nest.'; }
    const words = said.toLowerCase().match(/[a-z0-9]{3,}/g) ?? [];
    const hit = notes.findLast((n) => words.some((w) => !['what', 'did', 'tell', 'you', 'the', 'remember', 'whats'].includes(w) && n.toLowerCase().includes(w)));
    return hit ? `You told me ${hit.replace(/^my /, 'your ')}.` : 'I don’t have a note about that, bestie. Did you actually tell me?';
  };
  const send = (e) => {
    e.preventDefault();
    const q = draft.trim();
    if (!q) return;
    const a = reply(q);
    setMsgs((m) => [...m, { me: true, text: q }, { me: false, text: a }]);
    setDraft('');
    duck.current.react({ type: 'say', value: { text: a } });
  };
  return (
    <form className="chat demo" onSubmit={send}>
      <div className="chat-log" ref={logRef}>
        {msgs.map((m, i) => <p key={i} className={`msg ${m.me ? 'me' : 'duck'}`}>{m.text}</p>)}
      </div>
      <div className="row" style={{ flexWrap: 'nowrap' }}>
        <input className="input" type="text" maxLength={140} placeholder="hey duck, what’s my locker code?" aria-label="Say something to the duck"
          value={draft} onChange={(e) => setDraft(e.target.value)} />
        <button className="btn primary" disabled={!draft.trim()}>Say</button>
      </div>
    </form>
  );
}

export default function Landing() {
  const { setStage, setFocus, bridge, setTone: dress } = useDuck();
  const scrollRef = useRef(null);
  const secRefs = useRef([]);
  const reacted = useRef(new Set());
  const [active, setActive] = useState(0);
  const [tone, setTone] = useState('savage');
  const [lit, setLit] = useState(null);   // LED tile just clicked
  const [loggedIn, setLoggedIn] = useState(false);
  const toneRef = useRef(tone);
  toneRef.current = tone;

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setLoggedIn(!!data.session));
  }, []);

  const goTo = (id) => {
    const i = SECTIONS.findIndex((s) => s.id === id);
    const node = secRefs.current[i];
    if (node) scrollRef.current.scrollTo({ top: node.offsetTop, behavior: 'smooth' });
  };

  // Scroll: which section is active, per-section progress (--p) and the duck's scroll motion.
  useEffect(() => {
    const el = scrollRef.current;
    const sc = { p: 0, v: 0 };
    bridge.current.scroll = sc;
    // clicking a part on the duck (or its label) scrolls to that part's section
    bridge.current.onPick = (id) => { if (SECTIONS.some((s) => s.id === id)) goTo(id); };
    let lastTop = el.scrollTop, raf = 0, current = -1;

    const update = () => {
      raf = 0;
      const H = window.innerHeight, mid = H / 2;
      let idx = 0, p = 0;
      secRefs.current.forEach((node, i) => {
        if (!node) return;
        const r = node.getBoundingClientRect();
        const prog = (mid - r.top) / r.height - 0.5;
        node.style.setProperty('--p', clamp(prog, -1, 1).toFixed(3));
        if (r.top <= mid && r.bottom > mid) { idx = i; p = prog; }
        if (r.top < H * 0.8) node.classList.add('in');
      });
      sc.p = clamp(p, -0.5, 0.5);
      sc.v += el.scrollTop - lastTop;   // the stage decays this every frame
      lastTop = el.scrollTop;
      if (idx !== current) { current = idx; setActive(idx); }
    };
    const onScroll = () => { if (!raf) raf = requestAnimationFrame(update); };

    el.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    document.body.classList.add('landing-on');
    el.focus({ preventScroll: true });   // arrow keys / space scroll it straight away
    update();
    return () => {
      cancelAnimationFrame(raf);
      el.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      document.body.classList.remove('landing-on');
      bridge.current.scroll = null;   // the dashboard gets a still duck
      bridge.current.onPick = null;
    };
  }, [bridge]);   // eslint-disable-line react-hooks/exhaustive-deps

  // Active section -> the duck's stage, plus its reaction the first time you arrive.
  useEffect(() => {
    const sec = SECTIONS[active];
    setStage(sec.stage);
    setFocus(sec.focus);
    dress('gentle');   // the landing duck stays plain (no accessories); the dashboard dresses it for the chosen personality
    if (!sec.react || reacted.current.has(sec.id)) return;
    const id = setTimeout(() => {
      reacted.current.add(sec.id);
      sec.react(toneRef.current).forEach((e, i) => setTimeout(() => bridge.current.react(e), i * 120));
    }, sec.delay ?? REACT_AFTER_MS);
    return () => clearTimeout(id);
  }, [active, setStage, setFocus, bridge, dress]);

  useEffect(() => () => { setStage(null); setFocus(null); dress('gentle'); }, [setStage, setFocus, dress]);

  const pickTone = (t) => { setTone(t); bridge.current.react({ type: 'say', value: { text: TONES[t] } }); };
  const blink = (l) => { setLit(l.kind); bridge.current.react({ type: 'sound', label: l.label, value: { kind: l.kind } }); };

  const activeId = SECTIONS[active].id;
  const ref = (i) => (node) => { secRefs.current[i] = node; };
  const sec = (i) => ({ ref: ref(i), 'data-section': SECTIONS[i].id, className: `sec sec-${SECTIONS[i].id}` });
  const cta = loggedIn
    ? <Link className="btn primary btn-lg" href="/">Open your dashboard</Link>
    : <Link className="btn primary btn-lg" href="/register">Adopt your duck</Link>;

  return (
    <>
      <header className="landing-head">
        <div className="landing-brand"><BrandMark size={30} /> Duck Mommy</div>
        <nav className={`part-nav glass ${activeId === 'hero' || activeId === 'end' ? 'hidden' : ''}`} aria-label="The duck's parts">
          {SECTIONS.filter((s) => s.part).map((s) => (
            <button key={s.id} aria-current={s.id === activeId} onClick={() => goTo(s.id)}>{s.part}</button>
          ))}
        </nav>
        <div className="row">
          <ScenePicker />
          {loggedIn ? <Link className="btn glass" href="/">Dashboard</Link> : <Link className="btn glass" href="/login">Log in</Link>}
        </div>
      </header>

      <main className="landing" ref={scrollRef} tabIndex={-1}>
        <section {...sec(0)}>
          <div className="col">
            <h1 className="mega">Sit up straight <span className="yellow">bestie.</span></h1>
            <p className="lede">Programmers talk to rubber ducks. Ours talks back. DuckMommy fixes your posture, reads ASL, remembers for you, tracks deadlines, hears the doorbell, guards your desk, and keeps you focused.</p>
            <div className="row">
              {cta}
              {!loggedIn && <Link className="text-link" href="/login">I already have one · Log in</Link>}
            </div>
          </div>
        </section>

        <section {...sec(1)}>
          <div className="col glass">
            <p className="kicker">Meet the hardware</p>
            <h2>Every part does something.</h2>
            <p>A camera eye, a head you can press, a beak that talks, a mic that hears your doorbell, an NFC tag on its back. Click a label to jump to that part.</p>
          </div>
        </section>

        <section {...sec(2)}>
          <div className="col glass">
            <p className="kicker">Right eye · camera</p>
            <h2>It sees you slouch.</h2>
            <p>OpenCV and MediaPipe on the Pi measure your neck angle. Slouch for a few seconds and it tells you, out loud. Night vision for sentry mode. Video never leaves the duck.</p>
          </div>
        </section>

        <section {...sec(3)}>
          <div className="col glass">
            <p className="kicker">Top of head · pressure pad</p>
            <h2>Boop the snoot.</h2>
            <p>Press its head and it quacks. Every pat lands on your dashboard, live.</p>
            <div className="row">
              <button className="btn primary" onClick={() => bridge.current.react({ type: 'quack' })}><HandIcon /> Pat it</button>
              <span className="hint">or click its head</span>
            </div>
          </div>
        </section>

        <section {...sec(4)}>
          <div className="col glass">
            <p className="kicker">Beak · ElevenLabs voice</p>
            <h2>Pick its personality.</h2>
            <p>It talks in its own voice. You choose what it says, and how mean it’s allowed to be.</p>
            <div className="seg" role="radiogroup" aria-label="Personality">
              {Object.keys(TONES).map((t) => (
                <button key={t} role="radio" aria-checked={tone === t} onClick={() => pickTone(t)}>{t[0].toUpperCase() + t.slice(1)}</button>
              ))}
            </div>
            <p className="quote">“{TONES[tone]}”</p>
          </div>
        </section>

        <section {...sec(5)}>
          <div className="col glass">
            <p className="kicker">Chest · microphone</p>
            <h2>Hears what you can’t.</h2>
            <p>Headphones on? Doorbell, phone, alarm, someone calling your name: its LED blinks a different pattern for each. Tap one.</p>
            <div className="leds">
              {LEDS.map((l) => (
                <button key={l.kind} className={`led-tile ${lit === l.kind ? 'lit' : ''}`} onClick={() => blink(l)}>
                  <span className={`led led-${l.kind}`} aria-hidden />
                  <span className="led-label">{l.label}</span>
                  <span className="hint">{l.pattern}</span>
                </button>
              ))}
            </div>
          </div>
        </section>

        <section {...sec(6)}>
          <div className="col glass">
            <p className="kicker">Back · NFC tag + coach</p>
            <h2>Tap to lock in.</h2>
            <p>Tap your phone on its back to start a focus session that blocks your apps. The coach checks in, counts down to deadlines, and calls you out when you zone out.</p>
            <div className="row">
              <button className="btn primary" onClick={() => { bridge.current.react({ type: 'focus' }); bridge.current.react({ type: 'whistle' }); }}><TargetIcon /> Start focus</button>
            </div>
          </div>
        </section>

        <section {...sec(7)}>
          <div className="col glass">
            <p className="kicker">Camera · Sign to Duck</p>
            <h2>Sign it. It says it.</h2>
            <p>ASL word signs, read on the Pi with no cloud API, spoken in the duck’s voice. Some are commands: START FOCUS starts the timer.</p>
            <AslDemo />
          </div>
        </section>

        <section {...sec(8)}>
          <div className="col glass">
            <p className="kicker">Memory · the Nest</p>
            <h2>“Hey duck, remember…”</h2>
            <p>Tell it anything. Ask later. It answers out loud, from your own notes only.</p>
            <NestChat duck={bridge} />
          </div>
        </section>

        <section {...sec(9)}>
          <div className="col">
            <h2 className="mega">Adopt your <span className="yellow">duck.</span></h2>
            <p className="lede">Register, sit down, slouch. Within seconds it says something, and it shows up on your dashboard.</p>
            <div className="row">
              {cta}
              {!loggedIn && <Link className="text-link" href="/login">Log in</Link>}
            </div>
          </div>
        </section>
      </main>
    </>
  );
}
