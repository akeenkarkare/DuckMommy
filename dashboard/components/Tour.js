'use client';

import { useEffect, useRef, useState } from 'react';

// First-visit tour of the dashboard: a spotlight on one thing at a time, with a card beside it.
// Opens 1.8 s after the first login (page.js, localStorage TOUR_KEY); the ? button replays it.
// The spotlight follows its target every frame (the labels sway with the duck).

export const TOUR_KEY = 'duck-tour-v1';
const PAD = 10;          // spotlight padding around the target, px
const CARD_W = 320;

// target: () => DOMRect-like | null (null = no spotlight, card above the dock)
const STEPS = [
  {
    title: 'This is your duck',
    text: 'Drag it to spin it, tilt it up for a top view, tap its head and the real one quacks.',
    target: (bridge) => bridge.duckRect ?? null,
    react: { type: 'quack' },
  },
  {
    title: 'Every label is a real part',
    text: 'Click Camera for posture, signs and the live view. Each part opens its own drawer.',
    target: () => document.querySelector('.duck-label[data-id="camera"]')?.getBoundingClientRect() ?? null,
    react: { type: 'posture', value: { state: 'slouch' }, message: 'Like this. Sit up.' },
  },
  {
    title: 'Or use the dock',
    text: 'Every part is down here too, plus Calendar, Nest (what you told it to remember) and Activity.',
    target: () => document.querySelector('.dock')?.getBoundingClientRect() ?? null,
    react: { type: 'say', value: { text: 'Everything’s down here.' } },
  },
  {
    title: 'Is it with you?',
    text: 'Green means the duck is yours right now. If someone else logs in, it goes to them; reload to take it back.',
    target: () => document.querySelector('.topbar .pill')?.getBoundingClientRect() ?? null,
  },
  {
    title: 'Talk to it',
    text: 'Say “hey duck, remember…”, “what’s on my calendar tomorrow?” or “let’s lock in”. Or sign HELLO at the camera.',
    target: () => null,
    react: { type: 'say', value: { text: 'Hey bestie.' } },
  },
];

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

export default function Tour({ open, onClose, bridge }) {
  const [step, setStep] = useState(0);
  const spotRef = useRef(null);
  const cardRef = useRef(null);
  const nextRef = useRef(null);

  useEffect(() => { if (open) setStep(0); }, [open]);

  // the step's duck reaction, and keyboard focus on Next
  useEffect(() => {
    if (!open) return;
    const r = STEPS[step].react;
    const id = setTimeout(() => r && bridge.current.react(r), 350);
    nextRef.current?.focus({ preventScroll: true });
    return () => clearTimeout(id);
  }, [open, step, bridge]);

  const finish = () => {
    try { localStorage.setItem(TOUR_KEY, 'done'); } catch {}
    onClose();
  };
  const go = (d) => {
    if (step + d >= STEPS.length) return finish();
    setStep((s) => clamp(s + d, 0, STEPS.length - 1));
  };

  useEffect(() => {
    if (!open) return;
    const onKey = (e) => {
      if (e.key === 'ArrowRight' || e.key === 'Enter') { e.preventDefault(); go(1); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); go(-1); }
      else if (e.key === 'Escape') { e.stopPropagation(); finish(); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });

  // follow the target every frame
  useEffect(() => {
    if (!open) return;
    let raf;
    const place = () => {
      raf = requestAnimationFrame(place);
      const spot = spotRef.current, card = cardRef.current;
      if (!spot || !card) return;
      const W = window.innerWidth, H = window.innerHeight;
      const r = STEPS[step].target(bridge.current);
      const ch = card.offsetHeight || 180;
      const cw = Math.min(CARD_W, W - 32);
      let x, y;
      if (r) {
        const sx = r.x - PAD, sy = r.y - PAD, sw = r.width ?? r.w, sh = r.height ?? r.h;
        spot.style.opacity = 1;
        spot.style.transform = `translate(${sx}px, ${sy}px)`;
        spot.style.width = `${sw + PAD * 2}px`;
        spot.style.height = `${sh + PAD * 2}px`;
        const right = sx + sw + PAD * 2 + 16, left = sx - cw - 16;
        if (right + cw <= W - 16) { x = right; y = sy + (sh + PAD * 2) / 2 - ch / 2; }
        else if (left >= 16) { x = left; y = sy + (sh + PAD * 2) / 2 - ch / 2; }
        else { x = sx + (sw + PAD * 2) / 2 - cw / 2; y = sy > H / 2 ? sy - ch - 16 : sy + sh + PAD * 2 + 16; }
      } else {   // nothing to point at: dim everything, card above the dock
        spot.style.opacity = 1;
        spot.style.transform = `translate(${W / 2}px, ${H - 60}px)`;
        spot.style.width = spot.style.height = '0px';
        x = W / 2 - cw / 2; y = H - 110 - ch;
      }
      card.style.width = `${cw}px`;
      card.style.transform = `translate(${clamp(x, 16, W - cw - 16)}px, ${clamp(y, 16, H - ch - 16)}px)`;
    };
    place();
    return () => cancelAnimationFrame(raf);
  }, [open, step, bridge]);

  if (!open) return null;
  const s = STEPS[step];
  return (
    <div className="tour" role="dialog" aria-modal="true" aria-labelledby="tour-title">
      <div className="tour-spot" ref={spotRef} aria-hidden />
      <div className="tour-card glass" ref={cardRef} key={step}>
        <div className="tour-count">{step + 1} / {STEPS.length}</div>
        <h2 id="tour-title">{s.title}</h2>
        <p>{s.text}</p>
        <div className="row tour-actions">
          <button className="btn link" onClick={finish}>Skip</button>
          <span style={{ flex: 1 }} />
          {step > 0 && <button className="btn" onClick={() => go(-1)}>Back</button>}
          <button className="btn primary" ref={nextRef} onClick={() => go(1)}>{step === STEPS.length - 1 ? 'Done' : 'Next'}</button>
        </div>
      </div>
    </div>
  );
}
