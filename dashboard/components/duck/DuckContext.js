'use client';

import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import { DEFAULT_SCENE, SCENES } from './scenes';

// Shared between the persistent 3D stage (in the root layout) and the pages on top of it.
//   mode    'hero' on login/register (big close-up), 'dashboard' on / (whole duck + labels)
//   focus   hotspot id the camera is zoomed into, or null
//   badges  short live text under each label, set by the dashboard
//   bridge  .react(event) animates the duck; .onPet() is called when someone clicks its head
//   scene   background id (scenes.js), remembered per browser
const Ctx = createContext(null);

export function DuckProvider({ children }) {
  const pathname = usePathname();
  const mode = pathname === '/' ? 'dashboard' : 'hero';
  const [focus, setFocus] = useState(null);
  const [badges, setBadges] = useState({});
  const bridge = useRef({ react: () => {}, onPet: () => {} });
  const [scene, setSceneState] = useState(DEFAULT_SCENE);

  useEffect(() => {
    try {
      const saved = localStorage.getItem('duck-scene');
      if (saved && SCENES.some((s) => s.id === saved)) setSceneState(saved);
    } catch {}
  }, []);

  const setScene = (id) => {
    setSceneState(id);
    try { localStorage.setItem('duck-scene', id); } catch {}
  };

  useEffect(() => {
    if (mode !== 'dashboard') setFocus(null);
  }, [mode]);

  const value = useMemo(() => ({ mode, focus, setFocus, badges, setBadges, bridge, scene, setScene }), [mode, focus, badges, scene]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useDuck = () => useContext(Ctx);
