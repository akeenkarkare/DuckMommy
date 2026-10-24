'use client';

import { useEffect, useRef, useState } from 'react';
import { useDuck } from '@/components/duck/DuckContext';
import { SCENES, sceneById } from '@/components/duck/scenes';

// Background switcher: a pill showing the current scene, opening a grid of the four.
export default function ScenePicker() {
  const { scene, setScene } = useDuck();
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const current = sceneById(scene);

  useEffect(() => {
    if (!open) return;
    const close = (e) => { if (!ref.current?.contains(e.target)) setOpen(false); };
    const esc = (e) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('pointerdown', close);
    window.addEventListener('keydown', esc);
    return () => { window.removeEventListener('pointerdown', close); window.removeEventListener('keydown', esc); };
  }, [open]);

  return (
    <div className="scene-picker" ref={ref}>
      <button className="btn glass scene-current" aria-haspopup="true" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <img src={`/scenes/${current.file}.jpg`} alt="" />
        <span className="scene-name">{current.label}</span>
      </button>
      {open && (
        <div className="scene-menu glass" role="menu">
          {SCENES.map((s) => (
            <button key={s.id} role="menuitemradio" aria-checked={s.id === scene} className="scene-option"
              onClick={() => { setScene(s.id); setOpen(false); }}>
              <img src={`/scenes/${s.file}.jpg`} alt="" />
              <span>{s.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
